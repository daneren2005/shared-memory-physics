import { storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import type { EntityWorkerSystemCallbacks, EntityWorkerSystemWorld } from '@daneren2005/shared-memory-ecs';
import { interpolationUpdate, BACKLOG_CATCHUP_RATE, BACKLOG_TARGET_STEPS } from '../interpolation-update';
import {
	INTERPOLATION_CHANNEL_INDEX,
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_TICK_INDEX,
	INTERPOLATION_PREVIOUS_TOTAL_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_X_INDEX,
	INTERPOLATION_PREVIOUS_Y_INDEX,
	INTERPOLATION_SIZE,
	INTERPOLATION_SYNCED_TICK_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_TOTAL_DURATION_INDEX,
	INTERPOLATION_X_INDEX,
	INTERPOLATION_Y_INDEX,
} from '../../components/interpolation-component';
import { TRANSFORM_SIZE, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';

const callbacks: EntityWorkerSystemCallbacks = {
	entityComponentChanged: () => {},
	emitEntityEvent: () => {},
	emitSystemEvent: () => {},
	entityDied: () => {},
	addComponent: () => {},
	removeComponent: () => {},
	createEntity: () => {},
};

// One published step from the initial render position to the current transform.
function createEntity(prev: [number, number], current: [number, number], duration = 50) {
	const transform = new Float32Array(TRANSFORM_SIZE);
	transform[TRANSFORM_X_INDEX] = current[0];
	transform[TRANSFORM_Y_INDEX] = current[1];

	const interpolation = new Float32Array(INTERPOLATION_SIZE);
	interpolation[INTERPOLATION_X_INDEX] = prev[0];
	interpolation[INTERPOLATION_Y_INDEX] = prev[1];
	interpolation[INTERPOLATION_DURATION_INDEX] = duration;
	interpolation[INTERPOLATION_TOTAL_DURATION_INDEX] = duration;
	interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = 0;
	storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, 1);

	return { transform, interpolation };
}

// Drives the update against raw blocks with no world or system, pinning down the blend itself;
// interpolation-system.spec.ts covers the same end to end.
describe('interpolation-update', () => {
	// Consume the requested fraction of a step.
	function renderAt(components: { transform: Float32Array, interpolation: Float32Array }, alpha: number): [number, number] {
		const elapsedTime = components.interpolation[INTERPOLATION_DURATION_INDEX] * alpha;
		const world: EntityWorkerSystemWorld = { gameTime: 0, elapsedTime, getString: () => '' };
		interpolationUpdate(world, 1, components, {}, callbacks);

		return [
			components.interpolation[INTERPOLATION_X_INDEX],
			components.interpolation[INTERPOLATION_Y_INDEX],
		];
	}

	it('draws the position the step started from at the start of it', () => {
		expect(renderAt(createEntity([0, 0], [10, 20]), 0)).toEqual([0, 0]);
	});

	it('draws the position the step ended at by the end of it', () => {
		expect(renderAt(createEntity([0, 0], [10, 20]), 1)).toEqual([10, 20]);
	});

	it('walks along the segment between them', () => {
		expect(renderAt(createEntity([0, 0], [10, 20]), 0.5)).toEqual([5, 10]);
		expect(renderAt(createEntity([10, 10], [20, -10]), 0.25)).toEqual([12.5, 5]);
	});

	it('blends from wherever the entity was rather than from the origin', () => {
		expect(renderAt(createEntity([100, -50], [110, -50]), 0.5)).toEqual([105, -50]);
	});

	it('holds an entity that did not move exactly where it is', () => {
		// Physics publishes a step even for an entity against a wall, with prev where it still is.
		expect(renderAt(createEntity([7, 9], [7, 9]), 0.5)).toEqual([7, 9]);
	});

	// The whole guarantee of blending: nothing is drawn past where the simulation put the entity.
	it('never draws a position past the end of the step', () => {
		for(const alpha of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
			const [x] = renderAt(createEntity([0, 0], [10, 0]), alpha);
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(10);
		}
	});

	it('draws where the simulation is when physics runs every frame', () => {
		// A step covering exactly its own frame falls out of the same arithmetic: a frame's worth of a frame-long
		// segment is all of it.
		const components = createEntity([0, 0], [10, 20], 16);
		interpolationUpdate({ gameTime: 0, elapsedTime: 16, getString: () => '' }, 1, components, {}, callbacks);

		expect(components.interpolation[INTERPOLATION_X_INDEX]).toEqual(10);
		expect(components.interpolation[INTERPOLATION_Y_INDEX]).toEqual(20);
	});

	it('draws an entity physics has never touched at its transform', () => {
		// A station or wall: no step has been published, so there is no segment.
		const transform = new Float32Array(TRANSFORM_SIZE);
		transform[TRANSFORM_X_INDEX] = 40;
		transform[TRANSFORM_Y_INDEX] = -12;
		const interpolation = new Float32Array(INTERPOLATION_SIZE);

		interpolationUpdate({ gameTime: 0, elapsedTime: 16, getString: () => '' }, 1, { transform, interpolation }, {}, callbacks);

		expect(interpolation[INTERPOLATION_X_INDEX]).toEqual(40);
		expect(interpolation[INTERPOLATION_Y_INDEX]).toEqual(-12);
	});

	// Physics can publish between the reader's timing and transform reads.
	describe('a torn read', () => {
		it('preserves spacing between moving entities when only one overlaps publication', () => {
			const player = createEntity([0, 0], [10, 0]);
			const other = createEntity([100, 0], [110, 0]);
			renderAt(player, 0.4);
			renderAt(other, 0.4);
			storeFloat32(player.interpolation, INTERPOLATION_TICK_INDEX, Number.NaN);
			player.transform[TRANSFORM_X_INDEX] = 20;
			player.interpolation[INTERPOLATION_TOTAL_DURATION_INDEX] = 100;
			other.transform[TRANSFORM_X_INDEX] = 120;
			other.interpolation[INTERPOLATION_TOTAL_DURATION_INDEX] = 100;
			storeFloat32(other.interpolation, INTERPOLATION_TICK_INDEX, 2);
			expect(renderAt(other, 0.2)[0] - renderAt(player, 0.2)[0]).toBe(100);
			storeFloat32(player.interpolation, INTERPOLATION_TICK_INDEX, 2);
			expect(renderAt(other, 0.2)[0] - renderAt(player, 0.2)[0]).toBe(100);
		});

		it('keeps advancing the cached segment while a new publication is in progress', () => {
			const components = createEntity([0, 0], [10, 20]);
			expect(renderAt(components, 0.2)).toEqual([2, 4]);
			storeFloat32(components.interpolation, INTERPOLATION_TICK_INDEX, Number.NaN);
			components.transform[TRANSFORM_X_INDEX] = 20;
			components.transform[TRANSFORM_Y_INDEX] = -500;
			components.interpolation[INTERPOLATION_TOTAL_DURATION_INDEX] = 100;
			expect(renderAt(components, 0.2)).toEqual([4, 8]);
			components.transform[TRANSFORM_Y_INDEX] = 40;
			storeFloat32(components.interpolation, INTERPOLATION_TICK_INDEX, 2);
			expect(renderAt(components, 0.2)).toEqual([6, 12]);
		});

		it('stops at the cached endpoint if publishing lasts longer than the remaining segment', () => {
			const components = createEntity([0, 0], [10, 20]);
			renderAt(components, 0.5);
			storeFloat32(components.interpolation, INTERPOLATION_TICK_INDEX, Number.NaN);
			components.transform[TRANSFORM_X_INDEX] = 100;
			expect(renderAt(components, 1)).toEqual([10, 20]);
			expect(renderAt(components, 1)).toEqual([10, 20]);
		});

		it('holds while physics is publishing a new segment', () => {
			const components = createEntity([0, 0], [10, 20]);
			components.interpolation[INTERPOLATION_X_INDEX] = 3;
			components.interpolation[INTERPOLATION_Y_INDEX] = 6;
			storeFloat32(components.interpolation, INTERPOLATION_TICK_INDEX, Number.NaN);

			expect(renderAt(components, 0.5)).toEqual([3, 6]);
		});

		// Publish during the transform read to invalidate the earlier timing snapshot.
		function createTearing(prev: [number, number], current: [number, number]) {
			const components = createEntity(prev, current);
			const transform = new Proxy(components.transform, {
				get(target, prop, receiver) {
					if(prop === String(TRANSFORM_X_INDEX)) {
						storeFloat32(components.interpolation, INTERPOLATION_TICK_INDEX, 2);
					}

					return Reflect.get(target, prop, receiver);
				},
			});

			return { transform, interpolation: components.interpolation };
		}

		it('is dropped rather than drawn from a mismatched pair', () => {
			const components = createTearing([0, 0], [10, 20]);
			components.interpolation[INTERPOLATION_X_INDEX] = 3;
			components.interpolation[INTERPOLATION_Y_INDEX] = 6;

			// One frame of holding still, rather than a mismatched position.
			expect(renderAt(components, 0.5)).toEqual([3, 6]);
		});
	});
});

type GatedComponents = ReturnType<typeof createEntity>;

function createGated(prev: [number, number], current: [number, number]): GatedComponents {
	const components = createEntity(prev, current);
	components.interpolation[INTERPOLATION_CHANNEL_INDEX] = 1;

	return components;
}

// Mirrors physics-update: the replaced publication goes to the previous slot before the current one is dirtied.
function startPublishing(components: GatedComponents, x: number): void {
	const { interpolation, transform } = components;
	storeFloat32(interpolation, INTERPOLATION_PREVIOUS_TICK_INDEX, Number.NaN);
	interpolation[INTERPOLATION_PREVIOUS_X_INDEX] = transform[TRANSFORM_X_INDEX];
	interpolation[INTERPOLATION_PREVIOUS_Y_INDEX] = transform[TRANSFORM_Y_INDEX];
	interpolation[INTERPOLATION_PREVIOUS_DURATION_INDEX] = interpolation[INTERPOLATION_DURATION_INDEX];
	interpolation[INTERPOLATION_PREVIOUS_TOTAL_DURATION_INDEX] = interpolation[INTERPOLATION_TOTAL_DURATION_INDEX];
	storeFloat32(interpolation, INTERPOLATION_PREVIOUS_TICK_INDEX, interpolation[INTERPOLATION_TICK_INDEX]);
	storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, Number.NaN);
	interpolation[INTERPOLATION_DURATION_INDEX] = 50;
	interpolation[INTERPOLATION_TOTAL_DURATION_INDEX] += 50;
	transform[TRANSFORM_X_INDEX] = x;
}
function publish(components: GatedComponents, tick: number, x: number): void {
	startPublishing(components, x);
	storeFloat32(components.interpolation, INTERPOLATION_TICK_INDEX, tick);
}

// A worker publishes entity by entity while the main thread renders, so one frame can find part of a run published.
describe('interpolation-update gated on a committed run', () => {
	function render(components: GatedComponents, elapsedTime: number, committedTick: number): number {
		const world = { gameTime: 0, elapsedTime, committedTicks: [Number.NaN, committedTick], getString: () => '' };
		interpolationUpdate(world, 1, components, {}, callbacks);

		return components.interpolation[INTERPOLATION_X_INDEX];
	}

	// The CI failure this guards: one ship took the new step while the other ran out of segment and stalled,
	// leaving them permanently apart on screen.
	it('keeps entities of one run in step when only some are published by the time they are drawn', () => {
		const player = createGated([0, 0], [10, 0]);
		const companion = createGated([100, 0], [110, 0]);
		render(player, 40, 1);
		render(companion, 40, 1);

		publish(player, 2, 20);
		expect(render(companion, 20, 1) - render(player, 20, 1)).toBeCloseTo(100, 4);

		publish(companion, 2, 120);
		for(let frame = 0; frame < 4; frame++) {
			expect(render(companion, 20, 2) - render(player, 20, 2)).toBeCloseTo(100, 4);
		}
	});

	it('draws a committed step it has not seen yet while the next one is being written', () => {
		const components = createGated([0, 0], [10, 0]);
		startPublishing(components, 999);

		expect(render(components, 25, 1)).toBeCloseTo(5, 4);
	});

	it('uses the current publication once its run commits', () => {
		const components = createGated([0, 0], [10, 0]);
		render(components, 50, 1);
		publish(components, 2, 20);

		expect(render(components, 25, 1)).toBeCloseTo(10, 4);
		expect(render(components, 25, 2)).toBeCloseTo(15, 4);
	});

	it('is ungated for an entity no registered system published', () => {
		const components = createEntity([0, 0], [10, 0]);
		render(components, 50, 1);
		publish(components, 2, 20);

		expect(render(components, 25, 1)).toBeCloseTo(15, 4);
	});
});

// How long a physics run takes to come back must not be visible. A whole page of frames is simulated, since the
// failure guarded against is a sequence - one frame of drawn movement the wrong size next to its neighbours -
// that no single call can show. The model is the real thing: physics banks frame time, runs at a step's worth,
// and its results land some ms later. `lag` is that delay: 0 is main-thread, 30 is a slow worker.
const STEP = 50;
// Five frames to a step, which lets these ask for exact uniformity. A step not a whole number of frames leaves a
// small bounded ripple, tested separately below.
const FRAME = 10;
const SPEED = 100;
// What one frame of drawn movement has to be, every frame, whatever physics is doing.
const PER_FRAME = SPEED * FRAME / 1000;

interface Simulation {
	// The drawn x each frame, oldest first.
	drawn: Array<number>
	// Where the simulation had got to each frame, for checking nothing is drawn ahead of it.
	simulated: Array<number>
}

function simulate(lag: number, frames = 60, frameLength = FRAME, lagFor: (tick: number) => number = () => lag): Simulation {
	const transform = new Float32Array(TRANSFORM_SIZE);
	const interpolation = new Float32Array(INTERPOLATION_SIZE);
	const components = { transform, interpolation };

	// The physics system's side: banked frame time, and the runs it has posted that have not landed yet.
	let currentDelta = 0;
	let tick = 0;
	let now = 0;
	const inFlight: Array<{ landsAt: number, distance: number, covers: number }> = [];

	const drawn: Array<number> = [];
	const simulated: Array<number> = [];

	for(let frame = 0; frame < frames; frame++) {
		now += frameLength;

		// Publish timing and position, then release the completed tick.
		while(inFlight.length > 0 && inFlight[0].landsAt <= now) {
			const run = inFlight.shift()!;
			interpolation[INTERPOLATION_DURATION_INDEX] = run.covers;
			interpolation[INTERPOLATION_TOTAL_DURATION_INDEX] += run.covers;
			transform[TRANSFORM_X_INDEX] += run.distance;
			storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, ++tick);
		}

		// Then physics: bank the frame, post a run at a step's worth. A run in flight blocks the next, as
		// EntityWorkerSystem's `isRunning` guard does.
		currentDelta += frameLength;
		if(currentDelta >= STEP && inFlight.length === 0) {
			const runElapsed = currentDelta - currentDelta % STEP;
			currentDelta -= runElapsed;
			inFlight.push({ landsAt: now + lagFor(tick), distance: SPEED * runElapsed / 1000, covers: runElapsed });
		}

		// And finally the interpolation system.
		const world: EntityWorkerSystemWorld = { gameTime: now, elapsedTime: frameLength, getString: () => '' };
		interpolationUpdate(world, 1, components, {}, callbacks);

		drawn.push(interpolation[INTERPOLATION_X_INDEX]);
		simulated.push(transform[TRANSFORM_X_INDEX]);
	}

	return { drawn, simulated };
}

// The movement between consecutive drawn frames, which is what an eye sees.
function perFrameMovement(drawn: Array<number>): Array<number> {
	const moves: Array<number> = [];
	for(let i = 1; i < drawn.length; i++) {
		moves.push(Math.round((drawn[i] - drawn[i - 1]) * 1e6) / 1e6);
	}

	return moves;
}

// Enough frames for the first step to have landed and the pacing to have settled.
const WARMUP = 8;

describe('interpolation-update pacing', () => {
	// The lag a run comes back with, in ms, from instant up to later than the next step was due.
	const LAGS = [0, 5, 16, 20, 30, 45];

	it.each(LAGS)('advances by exactly one frame of movement when a run takes %ims', (lag) => {
		const { drawn } = simulate(lag);
		const moves = perFrameMovement(drawn).slice(WARMUP);

		// The assertion the whole feature exists for: a run longer than a frame costs latency and nothing an eye
		// can see. The tolerance is Float32 arithmetic, not the pacing.
		for(const move of moves) {
			expect(move).toBeCloseTo(PER_FRAME, 4);
		}
	});

	it('draws the same motion whether a run takes 16ms or 30ms', () => {
		// Two run speeds must produce the same animation, differing only in when it starts (the latency).
		const fast = perFrameMovement(simulate(16).drawn).slice(WARMUP);
		const slow = perFrameMovement(simulate(30).drawn).slice(WARMUP);

		expect(slow).toHaveLength(fast.length);
		for(let i = 0; i < slow.length; i++) {
			expect(slow[i]).toBeCloseTo(fast[i], 4);
		}
	});

	// The one case where the frame/step alignment is visible: with 16ms frames against a 50ms step, a step lands
	// with 2ms undrawn (dropped), rippling by less than a frame either way. It vanishes when the step is a whole
	// number of frames.
	it('ripples by less than a frame when the step is not a whole number of frames', () => {
		const moves = perFrameMovement(simulate(0, 60, 16).drawn).slice(WARMUP);
		const nominal = SPEED * 16 / 1000;

		for(const move of moves) {
			expect(move).toBeGreaterThanOrEqual(0);
			expect(move).toBeLessThanOrEqual(nominal * 2);
		}

		// Only the distribution ripples - the total distance is still what the velocity asked for.
		const total = moves.reduce((sum, move) => sum + move, 0);
		expect(total).toBeCloseTo(nominal * moves.length, 1);
	});

	it('never draws an entity backwards, whatever the run took', () => {
		// The failure this replaced: pacing off the accumulator reset the blend when a run was posted, before its
		// results landed, drawing a frame backwards.
		for(const lag of LAGS) {
			const { drawn } = simulate(lag);
			for(let i = 1; i < drawn.length; i++) {
				expect(drawn[i]).toBeGreaterThanOrEqual(drawn[i - 1]);
			}
		}
	});

	it('never draws ahead of the simulation, whatever the run took', () => {
		for(const lag of LAGS) {
			const { drawn, simulated } = simulate(lag);
			for(let i = 0; i < drawn.length; i++) {
				expect(drawn[i]).toBeLessThanOrEqual(simulated[i]);
			}
		}
	});

	it('costs latency, and only latency, as a run gets slower', () => {
		// A slower run is drawn further behind, bounded by one step plus the lag, not growing without limit.
		const behind = (lag: number) => {
			const { drawn, simulated } = simulate(lag);
			let total = 0;
			for(let i = WARMUP; i < drawn.length; i++) {
				total += simulated[i] - drawn[i];
			}

			return total / (drawn.length - WARMUP);
		};

		const instant = behind(0);
		const slow = behind(30);
		expect(slow).toBeGreaterThan(instant);
		// Anything past step + lag would mean the debt was banked rather than dropped.
		expect(slow).toBeLessThanOrEqual(SPEED * (STEP + 30 + FRAME) / 1000);
	});

	it('gets back to a steady speed after a single run comes back late', () => {
		// A one-off hitch: while the late run is out the entity holds, then catches up over two steps when it
		// lands. What matters is that it is over - one disturbance, then the steady speed as before.
		const { drawn, simulated } = simulate(0, 60, FRAME, tick => tick === 3 ? 40 : 0);
		const moves = perFrameMovement(drawn);

		// Nothing goes backwards, the failure the old pacing had.
		for(const move of moves) {
			expect(move).toBeGreaterThanOrEqual(0);
		}

		// The disturbance is bounded to one segment's worth in a frame - two steps handed over at once.
		const worst = Math.max(...moves);
		expect(worst).toBeLessThanOrEqual(SPEED * STEP / 1000 + 1e-4);

		// The last third is back to one frame of movement each, so the hitch left the pacing where it found it.
		for(const move of moves.slice(Math.floor(moves.length * 2 / 3))) {
			expect(move).toBeCloseTo(PER_FRAME, 4);
		}

		// Nor did it lose ground for good: the gap is back inside its normal range, not permanent extra latency.
		const last = drawn.length - 1;
		expect(simulated[last] - drawn[last]).toBeGreaterThanOrEqual(0);
		expect(simulated[last] - drawn[last]).toBeLessThanOrEqual(SPEED * STEP / 1000 + 1e-4);
	});

	it('drains a backlog instead of trailing forever when physics publishes every frame', () => {
		// High timeScale: a step lands every frame (frame 60ms > step 50ms). A one-off slow run banks a backlog that
		// the matched produce/consume rate would otherwise pin the render behind by for the rest of the run. It must
		// ease back to the promised near-one-step latency instead.
		const { drawn, simulated } = simulate(0, 200, 60, tick => tick === 4 ? 300 : 0);
		const last = drawn.length - 1;
		const settledLag = simulated[last] - drawn[last];
		// Back within ~two steps, not the ~three steps the banked spike would have trailed by forever.
		expect(settledLag).toBeLessThanOrEqual(SPEED * STEP * 2 / 1000 + 1e-4);
		// It got there by easing off, never running backwards.
		for(let i = 1; i < drawn.length; i++) {
			expect(drawn[i]).toBeGreaterThanOrEqual(drawn[i - 1]);
			expect(drawn[i]).toBeLessThanOrEqual(simulated[i]);
		}
	});

	it('eases across a late segment and recovers instead of jumping or trailing forever', () => {
		const { drawn, simulated } = simulate(0, 180, FRAME, tick => tick === 3 ? 500 : 0);
		const moves = perFrameMovement(drawn);

		// The renderer waits at the last known transform while the worker is late, then eases back across the banked
		// segment: it may run a little faster than the simulation to catch up, but never jumps across the segment (a
		// whole step in a frame) and never runs backwards.
		for(const move of moves) {
			expect(move).toBeGreaterThanOrEqual(0);
			expect(move).toBeLessThanOrEqual(PER_FRAME * (1 + BACKLOG_CATCHUP_RATE) + 1e-4);
		}

		// And it does catch back up, rather than trailing the simulation by the banked segment forever.
		const last = drawn.length - 1;
		expect(simulated[last] - drawn[last]).toBeLessThanOrEqual(SPEED * STEP * BACKLOG_TARGET_STEPS / 1000 + 1e-4);
	});
});
