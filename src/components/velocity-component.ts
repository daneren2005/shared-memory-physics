import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// How fast an entity is moving, in world units per second, along each axis.  An entity with both a
// transform and a velocity is moved by the physics system every run.
export interface VelocityComponent {
	index: number
	velocityX: number
	velocityY: number
}

// Velocity is named per-axis rather than plain `x`/`y` because entity configs are flat and shared across
// every component - `x`/`y` already belong to the transform.  Either axis on its own is enough to give an
// entity a velocity, so both are optional and a missing one starts at 0.
export interface VelocityConfig {
	velocityX?: number
	velocityY?: number
}
// Velocity is both the config an entity spawns with and live runtime state (a game's own systems apply
// forces to it), so the whole thing round-trips back out through `save`.
export type VelocitySerialization = VelocityConfig;

// Indexes into the backing Float32Array block.  The physics update reads the same offsets off the raw shared
// block, so they are exported for it (and for any game system that touches the block directly).
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
