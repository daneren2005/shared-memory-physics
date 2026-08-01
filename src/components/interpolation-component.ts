import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';
import type { TransformComponent } from './transform-component';

// Where an entity should be *drawn*, which stops being the same thing as where it is the moment physics runs
// less often than the screen refreshes.  A 50ms step against a 16ms frame means the transform only changes on
// one frame in three, so an entity drawn straight off it visibly stutters; this block holds a position that
// changes every frame instead.
//
// It is filled by InterpolationSystem by blending between the position the entity had before the last physics
// step and the one it has after it, so **every position in here is one the simulation actually produced** -
// somewhere on the segment between two real positions, never a guess past the end of one.  The cost of that is
// one step of latency: what is drawn is where the entity was a step ago, not where it is now.
//
// Nothing in the simulation ever reads this back.  Collision, the sweep and the spatial index all work off the
// transform, so a render position can never feed back into where an entity is allowed to go - which is also
// what keeps it safe under lockstep multiplayer, where two machines running at different frame rates would
// otherwise read different numbers out of the same tick.
export interface InterpolationComponent {
	index: number
	// The render position.  Rewritten every frame by InterpolationSystem - a game reads it and does not write
	// it, except through `snapEntity` after teleporting something.
	x: number
	y: number
	// Where the entity stood before the physics step now being blended.  Written by the physics update.
	prevX: number
	prevY: number
}

// `interpolate` is what gives an entity this component at all, the way a size is what gives it a transform.  It
// is opt-in per entity rather than automatic on anything with a transform, because it is 20 bytes and a
// per-frame visit for something a game may never draw.
//
// `x`/`y` are read off the same flat config the transform loads from, so a new entity's render position starts
// where it spawned rather than sliding in from the origin on its first frame.
export interface InterpolationConfig {
	interpolate?: boolean
	x?: number
	y?: number
}

// Indexes into the backing Float32Array block.  The physics update and the interpolation update both read
// these offsets off the raw shared block, so they are exported for them (and for any game system that wants
// the render position without going through the accessors).
export const INTERPOLATION_X_INDEX = 0;
export const INTERPOLATION_Y_INDEX = 1;
export const INTERPOLATION_PREV_X_INDEX = 2;
export const INTERPOLATION_PREV_Y_INDEX = 3;
// How far along the current segment has been drawn, as a fraction of it: 0 at `prev`, 1 at the transform.
// Written only by the interpolation system.
//
// Kept as a fraction rather than as milliseconds so that the leftover from one segment carries onto the next
// one without needing to remember how long the old segment was - which matters because they are not all the
// same length (see INTERPOLATION_DURATION_INDEX).  It is allowed to go slightly **negative**, which is what
// stops the drawn speed rippling: the frames that pass between two steps add up to a frame more or less than
// the step covers, and carrying the difference forward instead of clamping it away is what keeps every frame's
// worth of drawn movement identical.
export const INTERPOLATION_PROGRESS_INDEX = 4;
// The step the interpolation system last reconciled against, so it can tell a step it has already started
// drawing from one physics has just published.  Written only by the interpolation system.
export const INTERPOLATION_SYNCED_TICK_INDEX = 5;
// How much simulated time this segment covers, in milliseconds - the `elapsedTime` of the run that produced it.
// Written by the physics update.
//
// Nearly always the physics step, and *not* assumed to be: a run that comes back late leaves more than a step's
// worth of time banked, and the next one covers two steps in one go.  Dividing that segment by the step rather
// than by what it really covers would draw it at double speed, which is a stutter in exactly the case - physics
// falling behind - where this component is supposed to be hiding one.
export const INTERPOLATION_DURATION_INDEX = 6;
// The physics step this block's `prev` belongs to, written **last** by the physics update with a release store.
// It is a publication stamp rather than anything a reader does arithmetic with: physics writes `prev` and then
// the transform, on another thread, while the main thread is reading both - so a reader that sees the same tick
// on either side of its own reads knows the two it got belong together.  Reading them from either side of a
// step would blend towards a position the entity has already left, which is the one mismatch that draws an
// entity moving backwards.
//
// It is also the *arrival* signal, which is the whole reason the pacing lives in this block rather than being
// read off the physics system's accumulator.  That accumulator resets when a run is **posted**; these three
// fields change when it **lands**, and on a worker those are not the same moment.
export const INTERPOLATION_TICK_INDEX = 7;
export const INTERPOLATION_SIZE = 8;

export const interpolationDefinition: ComponentDefinition<InterpolationComponent, Float32Array, InterpolationConfig> = {
	type: Float32Array,
	size: INTERPOLATION_SIZE,
	loadProperties: ['interpolate'],
	load(entity, memory, config) {
		const x = config.x ?? 0;
		const y = config.y ?? 0;

		// Seeded with the spawn position on both sides of the blend, and with the pacing at rest - so an entity
		// added between physics steps is drawn standing still where it was put rather than sliding in from
		// wherever the block happened to be last used.  PhysicsSystem's first run stamps tick 1, so the 0 here is
		// what makes that first step read as a new one to reconcile against.
		//
		// A duration of 0 reads as "no segment yet", which draws the entity at its transform - which is also what
		// something the physics system never moves is left on for its whole life.
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
	// No `save`: everything in here is derived from the transform and rebuilt on the next physics step, and
	// `interpolate` itself is defining config that comes back off the game's own entity template.
};

// Anything with the two components this reads, which is any entity from a world that registered
// `physicsRegistry` - written structurally so it does not need the game's component map to say so.
export interface SnappableEntity {
	components: {
		transform?: TransformComponent
		interpolation?: InterpolationComponent
	}
}

// Throws away the segment an entity is part way along and puts it, drawn and simulated, at the same place.
//
// **Call this after writing a transform directly.**  Interpolation blends from where an entity was towards
// where it is, so a game that teleports something by assigning `transform.x` has not moved it - it has made the
// segment 500 units long, and the entity is drawn sliding the whole way across the map over the next step. This
// is the one thing blending between real positions cannot work out for itself, because a long move and a
// teleport are the same two numbers.
//
// It is not needed for anything physics did: a velocity change, a collision, an entity coming to rest against a
// wall are all steps the simulation took and are all drawn as they happened.
export function snapEntity(entity: SnappableEntity): void {
	const { transform, interpolation } = entity.components;
	if(!transform || !interpolation) {
		return;
	}

	interpolation.prevX = interpolation.x = transform.x;
	interpolation.prevY = interpolation.y = transform.y;
}

export default interpolationDefinition;
