import { loadFloat32, storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';
import type { TransformComponent } from './transform-component';
import type { VelocityComponent } from './velocity-component';

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
	// The publication protocol, normally written only by the physics update and read only by the interpolation update
	progress: number
	syncedTick: number
	duration: number
	tick: number
	totalDuration: number
	syncedDuration: number
	remainingDuration: number
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
// How far through the latest segment's own duration the renderer is. Position pacing additionally uses the
// cumulative/remaining duration fields below, since the latest segment can replace an older unfinished one.
export const INTERPOLATION_PROGRESS_INDEX = 4;
// The step the interpolation system last reconciled against, to tell an already-started step from a new one.
export const INTERPOLATION_SYNCED_TICK_INDEX = 5;
// How much simulated time the latest segment covers, in ms - the run's `elapsedTime`. Written by physics.
export const INTERPOLATION_DURATION_INDEX = 6;
// The physics step this block's `prev` belongs to. Physics atomically writes NaN before changing the segment and
// the tick after finishing it. A reader accepts only equal non-NaN samples around its reads, or it could combine
// endpoints from different steps and draw the entity moving backwards. Also the arrival signal, which is why
// pacing lives here rather than in the physics accumulator: that resets when a run is posted, this changes when
// it lands.
export const INTERPOLATION_TICK_INDEX = 7;
// Cumulative simulated time published by physics. Unlike the latest segment duration, this cannot lose a long
// run when a second publication replaces it before rendering gets a frame.
export const INTERPOLATION_TOTAL_DURATION_INDEX = 8;
// Consumer-owned bookkeeping for how much of the cumulative duration has entered the render timeline.
export const INTERPOLATION_SYNCED_DURATION_INDEX = 9;
export const INTERPOLATION_REMAINING_DURATION_INDEX = 10;
export const INTERPOLATION_SIZE = 11;

class InterpolationComponentImpl extends Component<Float32Array> implements InterpolationComponent {
	get x() {
		return this.block[INTERPOLATION_X_INDEX];
	}
	set x(value: number) {
		this.block[INTERPOLATION_X_INDEX] = value;
	}
	get y() {
		return this.block[INTERPOLATION_Y_INDEX];
	}
	set y(value: number) {
		this.block[INTERPOLATION_Y_INDEX] = value;
	}
	get prevX() {
		return this.block[INTERPOLATION_PREV_X_INDEX];
	}
	set prevX(value: number) {
		this.block[INTERPOLATION_PREV_X_INDEX] = value;
	}
	get prevY() {
		return this.block[INTERPOLATION_PREV_Y_INDEX];
	}
	set prevY(value: number) {
		this.block[INTERPOLATION_PREV_Y_INDEX] = value;
	}
	get progress() {
		return this.block[INTERPOLATION_PROGRESS_INDEX];
	}
	set progress(value: number) {
		this.block[INTERPOLATION_PROGRESS_INDEX] = value;
	}
	get syncedTick() {
		return this.block[INTERPOLATION_SYNCED_TICK_INDEX];
	}
	set syncedTick(value: number) {
		this.block[INTERPOLATION_SYNCED_TICK_INDEX] = value;
	}
	get duration() {
		return this.block[INTERPOLATION_DURATION_INDEX];
	}
	set duration(value: number) {
		this.block[INTERPOLATION_DURATION_INDEX] = value;
	}
	// The stamp everything else is published under, so it is read and written atomically like the physics update
	// does: a release store paired with the acquire load the interpolation update reads it through.
	get tick() {
		return loadFloat32(this.block, INTERPOLATION_TICK_INDEX);
	}
	set tick(value: number) {
		storeFloat32(this.block, INTERPOLATION_TICK_INDEX, value);
	}
	get totalDuration() {
		return this.block[INTERPOLATION_TOTAL_DURATION_INDEX];
	}
	set totalDuration(value: number) {
		this.block[INTERPOLATION_TOTAL_DURATION_INDEX] = value;
	}
	get syncedDuration() {
		return this.block[INTERPOLATION_SYNCED_DURATION_INDEX];
	}
	set syncedDuration(value: number) {
		this.block[INTERPOLATION_SYNCED_DURATION_INDEX] = value;
	}
	get remainingDuration() {
		return this.block[INTERPOLATION_REMAINING_DURATION_INDEX];
	}
	set remainingDuration(value: number) {
		this.block[INTERPOLATION_REMAINING_DURATION_INDEX] = value;
	}
}

export const interpolationDefinition: ComponentDefinition<InterpolationComponent, Float32Array, InterpolationConfig> = {
	type: Float32Array,
	size: INTERPOLATION_SIZE,
	loadProperties: ['interpolate'],
	toBlock(config) {
		const x = config.x ?? 0;
		const y = config.y ?? 0;
		// Spawn position on both sides of the blend, pacing at rest, so an entity added between steps is drawn
		// standing still. PhysicsSystem's first run stamps tick 1, so the 0 here reads as a new step to reconcile.
		// Duration 0 means "no segment yet", drawing the entity at its transform - as for anything never moved.
		return [x, y, x, y, 0, 0, 0, 0, 0, 0, 0];
	},
	attach(entity, memory, index) {
		return new InterpolationComponentImpl(memory.getBlock(index), index);
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
	interpolation.remainingDuration = 0;
	interpolation.syncedDuration = interpolation.totalDuration;
}

// Anything `startSpawnInterpolation` reads: a transform and velocity to build the segment from, and the
// interpolation block to write it into. Structural so it does not need the game's component map.
export interface SpawnableEntity {
	components: {
		transform?: TransformComponent
		velocity?: VelocityComponent
		interpolation?: InterpolationComponent
	}
}

export interface SpawnInterpolationOptions {
	// The physics step, in ms. The first real run will land a step's worth of one of these after the *last* step,
	// i.e. `(1 - stepFraction)` of one from now - which is how long the seeded segment covers and how far along its
	// velocity the transform is jumped.
	stepMs: number
	// How far into the current step the spawn landed, 0..1 (`accumulator / stepMs`). What is left of the step
	// (`1 - stepFraction`) is the time until the first real run lands, so it sets both the seeded segment's length
	// and the forward jump. Clamped, so a value read a frame stale or on the step boundary still lands in range.
	stepFraction: number
	// The last physics tick, written as the segment's stamp so the first real step - stamped a later tick - reads
	// as a new one and reconciles. Getting it wrong only ever costs a one-frame hold, never a wrong position.
	tick: number
}

// Seeds a just-spawned, already-moving entity so a renderer draws it leaving its spawn point from the next frame,
// instead of standing there until the first physics step reaches it - up to a full step of stillness that reads as
// lag on a bullet fired with velocity. The render opens *at* the spawn point and moves out along the entity's own
// velocity at its true speed; the transform is jumped forward to where that motion reaches by the time the first
// real step lands, so the seeded segment hands straight over to it with no seam and the render is never drawn
// ahead of the simulation. How far that is - the jump distance and the segment's length - is whatever is left of
// the current step (`1 - stepFraction`), since that is when the first run lands.
//
// The jump is a real move of the transform, applied WITHOUT a collision sweep: the entity skips forward up to a
// step, so it can tunnel through anything within that distance of the spawn, and it runs that far ahead of where
// its velocity would otherwise have put it for the rest of its life. This is a deliberate trade for spawned
// projectiles, where leaving the muzzle instantly matters more than the first step's sweep: a shot fired into a
// target still lands inside it and is caught and killed by the next run's overlap test; only something thin enough
// to sit entirely within that jumped span is passed through uncaught. Do not use it for something that must not
// skip a step of collision. A no-op without all of transform, velocity and interpolation.
// `PhysicsSystem#startInterpolation` fills the options in from its own step and accumulator; call this directly
// only when driving physics by hand. See `snapEntity` for the teleport counterpart.
export function startSpawnInterpolation(entity: SpawnableEntity, options: SpawnInterpolationOptions): void {
	const { transform, velocity, interpolation } = entity.components;
	if(!transform || !velocity || !interpolation) {
		return;
	}

	const fraction = options.stepFraction < 0 ? 0 : options.stepFraction > 1 ? 1 : options.stepFraction;
	// What is left of the current step: the time until the first real run lands, so both how long the seeded
	// segment lasts and how far the transform is jumped forward.
	const remaining = 1 - fraction;
	const seconds = options.stepMs / 1000;
	const spawnX = transform.x;
	const spawnY = transform.y;
	const jumpX = velocity.velocityX * seconds * remaining;
	const jumpY = velocity.velocityY * seconds * remaining;

	// The segment runs from where it spawned to the jump target, and the transform is jumped to that target so the
	// render never runs ahead of the simulation. The render opens at the spawn point (progress 0) and moves out.
	interpolation.prevX = spawnX;
	interpolation.prevY = spawnY;
	transform.x = spawnX + jumpX;
	transform.y = spawnY + jumpY;
	interpolation.x = spawnX;
	interpolation.y = spawnY;
	interpolation.duration = options.stepMs * remaining;
	interpolation.progress = 0;
	interpolation.syncedTick = options.tick;
	interpolation.totalDuration += interpolation.duration;
	interpolation.syncedDuration = interpolation.totalDuration;
	interpolation.remainingDuration = interpolation.duration;
	// Last, through the release store, so a reader that sees this stamp also sees the prev and progress above.
	interpolation.tick = options.tick;
}

export default interpolationDefinition;
