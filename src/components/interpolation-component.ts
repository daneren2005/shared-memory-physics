import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';
import type { TransformComponent } from './transform-component';

// Where an entity should be drawn, which diverges from where it is once physics runs less often than the screen
// refreshes: a 50ms step against a 16ms frame updates the transform one frame in three, so drawing straight off
// it stutters. This block holds a position that changes every frame instead.
//
// Filled by InterpolationSystem by blending between the positions before and after the last physics step, so
// every position here is one the simulation produced, at the cost of one step of latency. Nothing in the
// simulation reads it back - collision, the sweep and the spatial index all use the transform - which also keeps
// it safe under lockstep multiplayer, where different frame rates would otherwise read different numbers.
export interface InterpolationComponent {
	index: number
	// The render position, rewritten every frame by InterpolationSystem. A game reads it, and writes it only
	// through `snapEntity` after a teleport.
	x: number
	y: number
	// Where the entity stood before the step being blended. Written by the physics update.
	prevX: number
	prevY: number
}

// `interpolate` gives an entity this component, opt-in rather than automatic because it is 20 bytes and a
// per-frame visit for something a game may never draw. `x`/`y` come off the same config the transform loads
// from, so a render position starts where the entity spawned.
export interface InterpolationConfig {
	interpolate?: boolean
	x?: number
	y?: number
}

// Indexes into the backing Float32Array block, exported because the physics and interpolation updates read
// these offsets off the raw shared block.
export const INTERPOLATION_X_INDEX = 0;
export const INTERPOLATION_Y_INDEX = 1;
export const INTERPOLATION_PREV_X_INDEX = 2;
export const INTERPOLATION_PREV_Y_INDEX = 3;
// How far along the current segment has been drawn: 0 at `prev`, 1 at the transform. A fraction, not
// milliseconds, so leftover carries onto the next segment without remembering the old segment's length (segments
// vary - see INTERPOLATION_DURATION_INDEX). Written only by the interpolation system.
export const INTERPOLATION_PROGRESS_INDEX = 4;
// The step the interpolation system last reconciled against, to tell an already-started step from a new one.
export const INTERPOLATION_SYNCED_TICK_INDEX = 5;
// How much simulated time this segment covers, in ms - the run's `elapsedTime`. Nearly always the step, but not
// assumed to be: a late run banks more than a step and the next covers two, and dividing by the fixed step
// would draw that at double speed. Written by the physics update.
export const INTERPOLATION_DURATION_INDEX = 6;
// The physics step this block's `prev` belongs to, written last with a release store. A publication stamp: a
// reader seeing the same tick on both sides of its own reads knows the `prev` and transform belong together,
// and would otherwise draw the entity moving backwards. Also the arrival signal, which is why pacing lives here
// rather than in the physics accumulator: that resets when a run is posted, this changes when it lands.
export const INTERPOLATION_TICK_INDEX = 7;
export const INTERPOLATION_SIZE = 8;

export const interpolationDefinition: ComponentDefinition<InterpolationComponent, Float32Array, InterpolationConfig> = {
	type: Float32Array,
	size: INTERPOLATION_SIZE,
	loadProperties: ['interpolate'],
	load(entity, memory, config) {
		const x = config.x ?? 0;
		const y = config.y ?? 0;

		// Spawn position on both sides of the blend, pacing at rest, so an entity added between steps is drawn
		// standing still. PhysicsSystem's first run stamps tick 1, so the 0 here reads as a new step to reconcile.
		// Duration 0 means "no segment yet", drawing the entity at its transform - as for anything never moved.
		const index = memory.create([x, y, x, y, 0, 0, 0, 0]);
		const block = memory.getBlock(index);

		return {
			index,
			get x() {
				return block[INTERPOLATION_X_INDEX];
			},
			set x(value: number) {
				block[INTERPOLATION_X_INDEX] = value;
			},
			get y() {
				return block[INTERPOLATION_Y_INDEX];
			},
			set y(value: number) {
				block[INTERPOLATION_Y_INDEX] = value;
			},
			get prevX() {
				return block[INTERPOLATION_PREV_X_INDEX];
			},
			set prevX(value: number) {
				block[INTERPOLATION_PREV_X_INDEX] = value;
			},
			get prevY() {
				return block[INTERPOLATION_PREV_Y_INDEX];
			},
			set prevY(value: number) {
				block[INTERPOLATION_PREV_Y_INDEX] = value;
			},
		};
	},
	// No `save`: everything here is derived from the transform and rebuilt on the next step, and `interpolate`
	// is defining config from the entity template.
};

// Anything with the two components this reads, written structurally so it does not need the game's component map.
export interface SnappableEntity {
	components: {
		transform?: TransformComponent
		interpolation?: InterpolationComponent
	}
}

// Drops the segment an entity is part way along and puts drawn and simulated position at the same place. Call
// after writing a transform directly: a teleport by assigning `transform.x` otherwise reads as a long move and
// is drawn sliding the whole way, since a long move and a teleport are the same two numbers. Not needed for
// anything physics did - those are steps the simulation took and are drawn as they happened.
export function snapEntity(entity: SnappableEntity): void {
	const { transform, interpolation } = entity.components;
	if(!transform || !interpolation) {
		return;
	}

	interpolation.prevX = interpolation.x = transform.x;
	interpolation.prevY = interpolation.y = transform.y;
}

export default interpolationDefinition;
