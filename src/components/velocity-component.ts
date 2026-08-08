import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// How fast an entity moves, in world units per second per axis. An entity with a transform and a velocity is
// moved by the physics system every run.
export interface VelocityComponent {
	index: number
	velocityX: number
	velocityY: number
}

// Named per-axis, not `x`/`y`, because configs are flat and `x`/`y` belong to the transform. Either axis alone
// gives an entity a velocity, so both are optional and a missing one starts at 0.
export interface VelocityConfig {
	velocityX?: number
	velocityY?: number
}
// Both spawn config and live state (a game's systems apply forces), so it round-trips through `save`.
export type VelocitySerialization = VelocityConfig;

// Indexes into the backing Float32Array block, exported because the physics update reads the same offsets off
// the raw block.
export const VELOCITY_X_INDEX = 0;
export const VELOCITY_Y_INDEX = 1;
export const VELOCITY_SIZE = 2;

export const velocityDefinition: ComponentDefinition<VelocityComponent, Float32Array, VelocityConfig, VelocitySerialization> = {
	type: Float32Array,
	size: VELOCITY_SIZE,
	loadProperties: ['velocityX', 'velocityY'],
	load(entity, memory, config) {
		const index = memory.create([config.velocityX ?? 0, config.velocityY ?? 0]);
		const block = memory.getBlock(index);

		return {
			index,
			get velocityX() {
				return block[VELOCITY_X_INDEX];
			},
			set velocityX(value: number) {
				block[VELOCITY_X_INDEX] = value;
			},
			get velocityY() {
				return block[VELOCITY_Y_INDEX];
			},
			set velocityY(value: number) {
				block[VELOCITY_Y_INDEX] = value;
			},
		};
	},
	save(component) {
		return {
			velocityX: component.velocityX,
			velocityY: component.velocityY,
		};
	},
};

export default velocityDefinition;
