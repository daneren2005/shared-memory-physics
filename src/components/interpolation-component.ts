import { loadFloat32, storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';
import type { TransformComponent } from './transform-component';
import type { VelocityComponent } from './velocity-component';

// Where an entity should be drawn, which diverges from where it is once physics runs less often than the screen
// refreshes: a 50ms step against a 16ms frame updates the transform one frame in three, so drawing straight off
// it stutters. This block holds a position that changes every frame instead.
//
// Filled by InterpolationSystem by advancing the render position toward its last coherent physics target.
// The renderer consumes published simulation time without extrapolating past that target. Nothing in the
// simulation reads it back - collision, the sweep and the spatial index all use the transform - which also keeps
// it safe under lockstep multiplayer, where different frame rates would otherwise read different numbers.
export interface InterpolationComponent {
	index: number
	// The render position, rewritten every frame by InterpolationSystem. A game reads it, and writes it only
	// through `snapEntity` after a teleport.
	x: number
	y: number
	// Publication timing and consumer-owned render bookkeeping.
	syncedTick: number
	duration: number
	tick: number
	totalDuration: number
	syncedDuration: number
	remainingDuration: number
	targetX: number
	targetY: number
	syncedStepDuration: number
	previousX: number
	previousY: number
}

// `interpolate` gives an entity this component, opt-in rather than automatic because it is 68 bytes and a
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
// The step the interpolation system last reconciled against, to tell an already-started step from a new one.
export const INTERPOLATION_SYNCED_TICK_INDEX = 2;
// How much simulated time the latest segment covers, in ms - the run's `elapsedTime`. Written by physics.
export const INTERPOLATION_DURATION_INDEX = 3;
// The physics step the published transform and timing belong to. Physics atomically writes NaN before changing the segment and
// the tick after finishing it. A reader accepts only equal non-NaN samples around its reads, or it could combine
// endpoints from different steps and draw the entity moving backwards. Also the arrival signal, which is why
// pacing lives here rather than in the physics accumulator: that resets when a run is posted, this changes when
// it lands.
export const INTERPOLATION_TICK_INDEX = 4;
// Cumulative simulated time published by physics. Unlike the latest segment duration, this cannot lose a long
// run when a second publication replaces it before rendering gets a frame.
export const INTERPOLATION_TOTAL_DURATION_INDEX = 5;
// Consumer-owned bookkeeping for how much of the cumulative duration has entered the render timeline.
export const INTERPOLATION_SYNCED_DURATION_INDEX = 6;
export const INTERPOLATION_REMAINING_DURATION_INDEX = 7;
// Consumer-owned snapshot used while physics is publishing its next step.
export const INTERPOLATION_TARGET_X_INDEX = 8;
export const INTERPOLATION_TARGET_Y_INDEX = 9;
export const INTERPOLATION_SYNCED_STEP_DURATION_INDEX = 10;
// The PhysicsSystem that last published this entity (0 = none), whose committed tick gates the current publication.
export const INTERPOLATION_CHANNEL_INDEX = 11;
// The publication the current one replaced, written completely before the current tick is invalidated. A reader
// uses it while the current one is newer than its run's commit, so every entity of a run renders the same step.
export const INTERPOLATION_PREVIOUS_X_INDEX = 12;
export const INTERPOLATION_PREVIOUS_Y_INDEX = 13;
export const INTERPOLATION_PREVIOUS_DURATION_INDEX = 14;
export const INTERPOLATION_PREVIOUS_TOTAL_DURATION_INDEX = 15;
// Stamp for the previous slot, following the same NaN-while-writing protocol as the current tick.
export const INTERPOLATION_PREVIOUS_TICK_INDEX = 16;
export const INTERPOLATION_SIZE = 17;

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
	get targetX() {
		return this.block[INTERPOLATION_TARGET_X_INDEX];
	}
	set targetX(value: number) {
		this.block[INTERPOLATION_TARGET_X_INDEX] = value;
	}
	get targetY() {
		return this.block[INTERPOLATION_TARGET_Y_INDEX];
	}
	set targetY(value: number) {
		this.block[INTERPOLATION_TARGET_Y_INDEX] = value;
	}
	get syncedStepDuration() {
		return this.block[INTERPOLATION_SYNCED_STEP_DURATION_INDEX];
	}
	set syncedStepDuration(value: number) {
		this.block[INTERPOLATION_SYNCED_STEP_DURATION_INDEX] = value;
	}
	get previousX() {
		return this.block[INTERPOLATION_PREVIOUS_X_INDEX];
	}
	set previousX(value: number) {
		this.block[INTERPOLATION_PREVIOUS_X_INDEX] = value;
	}
	get previousY() {
		return this.block[INTERPOLATION_PREVIOUS_Y_INDEX];
	}
	set previousY(value: number) {
		this.block[INTERPOLATION_PREVIOUS_Y_INDEX] = value;
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
		// Seed both the render position and cached target at spawn; duration 0 means no published step yet.
		return [x, y, 0, 0, 0, 0, 0, 0, x, y, 0, 0, x, y, 0, 0, 0];
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

	interpolation.targetX = interpolation.x = transform.x;
	interpolation.targetY = interpolation.y = transform.y;
	// A gated reader may still draw from the previous slot until the in-flight run commits.
	interpolation.previousX = transform.x;
	interpolation.previousY = transform.y;
	interpolation.remainingDuration = 0;
	interpolation.syncedStepDuration = 0;
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
	// render never runs ahead of the simulation. The render opens at the spawn point and moves out.
	transform.x = spawnX + jumpX;
	transform.y = spawnY + jumpY;
	interpolation.x = spawnX;
	interpolation.y = spawnY;
	interpolation.duration = options.stepMs * remaining;
	interpolation.syncedTick = options.tick;
	interpolation.totalDuration += interpolation.duration;
	interpolation.syncedDuration = interpolation.totalDuration;
	interpolation.remainingDuration = interpolation.duration;
	interpolation.targetX = transform.x;
	interpolation.targetY = transform.y;
	interpolation.syncedStepDuration = interpolation.duration;
	// Last, through the release store, so a reader that sees this stamp also sees the target and timing above.
	interpolation.tick = options.tick;
}

export default interpolationDefinition;
