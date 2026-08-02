import { storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import type { ComponentSystemCallbacks, ComponentSystemWorld } from '@daneren2005/shared-memory-ecs';
import interpolationUpdate from '../interpolation-update';
import {
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_PROGRESS_INDEX,
	INTERPOLATION_PREV_X_INDEX,
	INTERPOLATION_PREV_Y_INDEX,
	INTERPOLATION_SIZE,
	INTERPOLATION_SYNCED_TICK_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_X_INDEX,
	INTERPOLATION_Y_INDEX,
} from '../../components/interpolation-component';
import { TRANSFORM_SIZE, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';

const callbacks: ComponentSystemCallbacks = {
	entityComponentChanged: () => {},
	emitEntityEvent: () => {},
	emitSystemEvent: () => {},
	entityDied: () => {},
	createEntity: () => {},
};

// One entity's blocks, as physics would have left them after a step that carried it from `prev` to `current`.
// Built at the full block sizes and written through the exported offsets, so a component that grows more fields
// does not quietly change what this is testing.
//
// The step is already reconciled against - same tick on both fields - so these single-frame tests are asking
// "given this much of this segment has been drawn, where does it go", with no arrival in the way.
function createEntity(prev: [number, number], current: [number, number], duration = 50) {
	const transform = new Float32Array(TRANSFORM_SIZE);
	transform[TRANSFORM_X_INDEX] = current[0];
	transform[TRANSFORM_Y_INDEX] = current[1];

	const interpolation = new Float32Array(INTERPOLATION_SIZE);
	interpolation[INTERPOLATION_PREV_X_INDEX] = prev[0];
	interpolation[INTERPOLATION_PREV_Y_INDEX] = prev[1];
	interpolation[INTERPOLATION_DURATION_INDEX] = duration;
	interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = 1;
	storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, 1);

	return { transform, interpolation };
}

// Drives the update function directly against raw blocks, without a world or a system in the way - so these
// pin down the blend itself.  interpolation-system.spec.ts covers the same logic end to end.
describe('interpolation-update', () => {
	// Puts the block at a known fraction of the way through its segment and runs one frame of no elapsed time,
	// so the position that comes back is the blend at exactly that alpha.
	function renderAt(components: { transform: Float32Array, interpolation: Float32Array }, alpha: number): [number, number] {
		components.interpolation[INTERPOLATION_PROGRESS_INDEX] = alpha;
		const world: ComponentSystemWorld = { gameTime: 0, elapsedTime: 0 };
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
		// Physics publishes a step for an entity pressed against a wall too, with prev equal to where it still
		// is - which is what keeps it still instead of leaving it blending against a stale segment.
		expect(renderAt(createEntity([7, 9], [7, 9]), 0.5)).toEqual([7, 9]);
	});

	// The whole guarantee of blending rather than guessing forward: nothing is ever drawn past the position the
	// simulation put the entity at.
	it('never draws a position past the end of the step', () => {
		const components = createEntity([0, 0], [10, 0]);
		for(const alpha of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
			const [x] = renderAt(components, alpha);
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(10);
		}
	});

	it('draws where the simulation is when physics runs every frame', () => {
		// A step that covers exactly the frame it was run on has nothing between it and the next one to be part
		// way along, and falls out of the same arithmetic rather than needing a case of its own: a frame's worth
		// of a segment a frame long is the whole of it.
		const components = createEntity([0, 0], [10, 20], 16);
		interpolationUpdate({ gameTime: 0, elapsedTime: 16 }, 1, components, {}, callbacks);

		expect(components.interpolation[INTERPOLATION_X_INDEX]).toEqual(10);
		expect(components.interpolation[INTERPOLATION_Y_INDEX]).toEqual(20);
	});

	it('draws an entity physics has never touched at its transform', () => {
		// A station, a wall: nothing has ever published a step for it, so there is no segment at all.
		const transform = new Float32Array(TRANSFORM_SIZE);
		transform[TRANSFORM_X_INDEX] = 40;
		transform[TRANSFORM_Y_INDEX] = -12;
		const interpolation = new Float32Array(INTERPOLATION_SIZE);

		interpolationUpdate({ gameTime: 0, elapsedTime: 16 }, 1, { transform, interpolation }, {}, callbacks);

		expect(interpolation[INTERPOLATION_X_INDEX]).toEqual(40);
		expect(interpolation[INTERPOLATION_Y_INDEX]).toEqual(-12);
	});

	// Physics is writing `prev` and the transform on another thread while this reads both, so a reader can catch
	// the pair with one end from the new step and the other from the old one.
	describe('a torn read', () => {
		// The next physics step lands while the update is part way through reading this entity - between the
		// `prev` it has already taken and the transform it is about to.  Hooked off the transform read because
		// that is genuinely the moment in between: a worker republishing here is exactly the race the stamp on
		// either side of these reads exists to catch.
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

			// One frame of holding still, rather than a position neither end of the segment agrees with.
			expect(renderAt(components, 0.5)).toEqual([3, 6]);
		});
	});
});

// ---------------------------------------------------------------------------------------------------------
// How long a physics run takes to come back must not be visible.
//
// A whole page of frames is simulated here rather than single calls, because that is the only way the question
// can be asked at all: the failure it is guarding against is a *sequence* - one frame of drawn movement that is
// the wrong size next to the frames either side of it - and no single call can show that.
//
// The model is deliberately the real thing rather than a convenient one.  A physics system banks frame time,
// runs when it has a step's worth, and its results appear in shared memory some number of milliseconds later -
// on a worker, not necessarily inside the frame that posted it.  `lag` is that delay, and it is the whole
// variable: 0 is a main-thread run, 30 is a worker that takes most of a step to come back.
// ---------------------------------------------------------------------------------------------------------
const STEP = 50;
// Five frames to a step, which is what lets these ask for *exact* uniformity.  A step and a frame that do not
// divide into each other leave a fraction of a segment undrawn when the next one lands, and that fraction is a
// real (small, bounded) ripple in the drawn speed - it has a test of its own further down rather than being
// smuggled into a tolerance here.
const FRAME = 10;
const SPEED = 100;
// What one frame of drawn movement has to be, every single frame, whatever physics is doing.
const PER_FRAME = SPEED * FRAME / 1000;

interface Simulation {
	// The drawn x on each frame, oldest first.
	drawn: Array<number>
	// Where the simulation had actually got to on each frame, for checking nothing is drawn ahead of it.
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

		// Anything whose run has come back writes its results into the blocks, exactly as the worker would:
		// prev first, then the transform, then the tick with a release store.
		while(inFlight.length > 0 && inFlight[0].landsAt <= now) {
			const run = inFlight.shift()!;
			interpolation[INTERPOLATION_PREV_X_INDEX] = transform[TRANSFORM_X_INDEX];
			interpolation[INTERPOLATION_DURATION_INDEX] = run.covers;
			transform[TRANSFORM_X_INDEX] += run.distance;
			storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, ++tick);
		}

		// Then the physics system's own update: bank the frame, and post a run once there is a step's worth.  A
		// run already in flight blocks the next one, which is what ComponentSystem's `isRunning` guard does.
		currentDelta += frameLength;
		if(currentDelta >= STEP && inFlight.length === 0) {
			const runElapsed = currentDelta - currentDelta % STEP;
			currentDelta -= runElapsed;
			inFlight.push({ landsAt: now + lagFor(tick), distance: SPEED * runElapsed / 1000, covers: runElapsed });
		}

		// And finally the interpolation system, which is where it sits in the world's system list.
		const world: ComponentSystemWorld = { gameTime: now, elapsedTime: frameLength };
		interpolationUpdate(world, 1, components, {}, callbacks);

		drawn.push(interpolation[INTERPOLATION_X_INDEX]);
		simulated.push(transform[TRANSFORM_X_INDEX]);
	}

	return { drawn, simulated };
}

// The movement between consecutive drawn frames, which is the thing an eye actually sees.
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
	// The lag a run comes back with, in milliseconds: instant, a third of a step, most of a step, and one that
	// does not come back until after the next step was already due.
	const LAGS = [0, 5, 16, 20, 30, 45];

	it.each(LAGS)('advances by exactly one frame of movement when a run takes %ims', (lag) => {
		const { drawn } = simulate(lag);
		const moves = perFrameMovement(drawn).slice(WARMUP);

		// This is the assertion the whole feature exists for.  A physics run that takes longer than a frame is
		// meant to be invisible: it costs latency, and latency alone is not something an eye can see - a step
		// drawn late but at the right speed looks identical to one drawn on time.
		//
		// The blocks are Float32, so the tolerance is what that arithmetic is worth rather than what the pacing
		// is: the values being differenced are exact to about one part in ten million.
		for(const move of moves) {
			expect(move).toBeCloseTo(PER_FRAME, 4);
		}
	});

	it('draws the same motion whether a run takes 16ms or 30ms', () => {
		// The question stated directly: two physics systems of very different speeds, one of them slower than a
		// frame, have to produce the same animation.  They differ only in *when* it starts, which is the latency
		// each one costs - so the movement between frames, which is what is actually looked at, must match.
		const fast = perFrameMovement(simulate(16).drawn).slice(WARMUP);
		const slow = perFrameMovement(simulate(30).drawn).slice(WARMUP);

		expect(slow).toHaveLength(fast.length);
		for(let i = 0; i < slow.length; i++) {
			expect(slow[i]).toBeCloseTo(fast[i], 4);
		}
	});

	// The one case where how the frames and the step line up *is* visible, stated honestly rather than tuned
	// around.  Three 16ms frames cover 48ms of a 50ms step, so a step lands with 2ms of the last one still
	// undrawn - dropped, so that frame moves a little further - and every eighth step the leftover has drained
	// far enough that a fourth frame goes by with nothing new to draw, so that one moves a little less.
	//
	// It is bounded by a single frame either way, which is what makes it a ripple rather than a stutter, and it
	// disappears entirely when the step is a whole number of frames - which at a 50ms step and 60fps it is.
	it('ripples by less than a frame when the step is not a whole number of frames', () => {
		const moves = perFrameMovement(simulate(0, 60, 16).drawn).slice(WARMUP);
		const nominal = SPEED * 16 / 1000;

		for(const move of moves) {
			expect(move).toBeGreaterThanOrEqual(0);
			expect(move).toBeLessThanOrEqual(nominal * 2);
		}

		// And it is only the *distribution* that ripples - the total distance is still what the velocity asked
		// for, so nothing is lost or gained over time.
		const total = moves.reduce((sum, move) => sum + move, 0);
		expect(total).toBeCloseTo(nominal * moves.length, 1);
	});

	it('never draws an entity backwards, whatever the run took', () => {
		// The specific failure this replaced: pacing off the physics accumulator reset the blend the moment a run
		// was *posted*, while the block still held the step before it - so a frame could be drawn a third of the
		// way along a segment it had been drawn nearly all of the way along the frame before.
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
		// A slower run is drawn further behind the simulation - that is the whole price of it - and the gap is
		// bounded by one step plus however late the run was, rather than growing without limit.
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
		// One step is 5 units at this speed; a 30ms lag is 3 more.  Anything past that would mean the debt was
		// being banked rather than dropped, which is what makes a late run visible instead of merely late.
		expect(slow).toBeLessThanOrEqual(SPEED * (STEP + 30 + FRAME) / 1000);
	});

	it('gets back to a steady speed after a single run comes back late', () => {
		// A one-off hitch is a different thing from a slow physics system, and it is worth being clear about what
		// it can and cannot do.  While the late run is out there is nothing new to draw, so the entity holds; when
		// it lands, physics has banked more than a step and catches up by covering two of them.  That catch-up is
		// the simulation genuinely moving faster than real time, and no renderer can show it at normal speed
		// without falling permanently further behind - so it is drawn as a catch-up.
		//
		// What has to be true is that it is *over*: one disturbance, and then the same steady speed as before,
		// rather than a hitch that leaves the pacing broken for good.
		const { drawn, simulated } = simulate(0, 60, FRAME, tick => tick === 3 ? 40 : 0);
		const moves = perFrameMovement(drawn);

		// Nothing ever goes backwards, hitch or no hitch - which is the failure the old pacing had.
		for(const move of moves) {
			expect(move).toBeGreaterThanOrEqual(0);
		}

		// The disturbance is bounded: at worst one segment's worth in a frame, which is physics handing over two
		// steps in quick succession rather than the renderer inventing anything.
		const worst = Math.max(...moves);
		expect(worst).toBeLessThanOrEqual(SPEED * STEP / 1000 + 1e-4);

		// And the last third - well clear of it - is back to exactly one frame of movement each, so the hitch left
		// the pacing where it found it.
		for(const move of moves.slice(Math.floor(moves.length * 2 / 3))) {
			expect(move).toBeCloseTo(PER_FRAME, 4);
		}

		// Nor did any of it lose ground for good.  The gap to the simulation is back inside its normal range - it
		// closes to nothing as a segment finishes and opens to a step's worth as the next one lands - rather than
		// having taken on the hitch as permanent extra latency.
		const last = drawn.length - 1;
		expect(simulated[last] - drawn[last]).toBeGreaterThanOrEqual(0);
		expect(simulated[last] - drawn[last]).toBeLessThanOrEqual(SPEED * STEP / 1000 + 1e-4);
	});
});
