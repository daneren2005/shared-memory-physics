import {
	INTERPOLATION_X_INDEX,
	INTERPOLATION_Y_INDEX,
	INTERPOLATION_SYNCED_TICK_INDEX,
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_TOTAL_DURATION_INDEX,
	INTERPOLATION_SYNCED_DURATION_INDEX,
	INTERPOLATION_REMAINING_DURATION_INDEX,
	INTERPOLATION_TARGET_X_INDEX,
	INTERPOLATION_TARGET_Y_INDEX,
	INTERPOLATION_SYNCED_STEP_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_X_INDEX,
	INTERPOLATION_PREVIOUS_Y_INDEX,
	INTERPOLATION_SIZE,
} from './interpolation-component-constants';
import { loadFloat32, storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

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

export default interpolationDefinition;
