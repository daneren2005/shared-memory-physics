import { storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import type { EntityWorkerSystemCallbacks, EntityWorkerSystemWorld } from '@daneren2005/shared-memory-ecs';
import interpolationUpdate from '../interpolation-update';
import {
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_PREV_X_INDEX,
	INTERPOLATION_PREV_Y_INDEX,
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

// One entity's blocks, as physics would leave them after a step from `prev` to `current`. Already reconciled
// (same tick on both fields), so these single-frame tests ask only where a given progress lands.
function createEntity(prev: [number, number], current: [number, number], duration = 50) {
	const transform = new Float32Array(TRANSFORM_SIZE);
	transform[TRANSFORM_X_INDEX] = current[0];
	transform[TRANSFORM_Y_INDEX] = current[1];

	const interpolation = new Float32Array(INTERPOLATION_SIZE);
	interpolation[INTERPOLATION_X_INDEX] = prev[0];
	interpolation[INTERPOLATION_Y_INDEX] = prev[1];
	interpolation[INTERPOLATION_PREV_X_INDEX] = prev[0];
	interpolation[INTERPOLATION_PREV_Y_INDEX] = prev[1];
	interpolation[INTERPOLATION_DURATION_INDEX] = duration;
	interpolation[INTERPOLATION_TOTAL_DURATION_INDEX] = duration;
	interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = 0;
	storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, 1);

	return { transform, interpolation };
}

// Drives the update against raw blocks with no world or system, pinning down the blend itself;
// interpolation-system.spec.ts covers the same end to end.
describe('interpolation-update', () => {
	// Sets a known progress and runs a zero-elapsed frame, so the result is the blend at exactly that alpha.
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

	// Physics writes `prev` and the transform on another thread while this reads both, so a read can catch one
	// end from the new step and the other from the old.
	describe('a torn read', () => {
		it('holds while physics is publishing a new segment', () => {
			const components = createEntity([0, 0], [10, 20]);
			components.interpolation[INTERPOLATION_X_INDEX] = 3;
			components.interpolation[INTERPOLATION_Y_INDEX] = 6;
			storeFloat32(components.interpolation, INTERPOLATION_TICK_INDEX, Number.NaN);
			components.interpolation[INTERPOLATION_PREV_X_INDEX] = 10;

			expect(renderAt(components, 0.5)).toEqual([3, 6]);
		});

		// The next step lands between the `prev` this update has taken and the transform it is about to, hooked off
		// the transform read - the race the stamp on either side of these reads exists to catch.
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

		// A landed run writes its results as the worker would: prev, then transform, then tick with a release store.
		while(inFlight.length > 0 && inFlight[0].landsAt <= now) {
			const run = inFlight.shift()!;
			interpolation[INTERPOLATION_PREV_X_INDEX] = transform[TRANSFORM_X_INDEX];
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

	it('keeps unfinished duration when a follow-up step replaces a late segment', () => {
		const { drawn } = simulate(0, 180, FRAME, tick => tick === 3 ? 500 : 0);
		const moves = perFrameMovement(drawn);

		// The renderer may wait at the last known transform while the worker is late, but it must resume at the
		// simulated speed instead of jumping across the late segment when the following publication replaces it.
		for(const move of moves) {
			expect(move).toBeGreaterThanOrEqual(0);
			expect(move).toBeLessThanOrEqual(PER_FRAME + 1e-4);
		}
	});
});
