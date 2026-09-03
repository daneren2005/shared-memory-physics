import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// How fast an entity moves, in world units per second per axis. An entity with a transform and a velocity is
// moved by the physics system every run. `damping` bleeds speed off each step so a mover coasts to a stop.
export interface VelocityComponent {
	index: number
	velocityX: number
	velocityY: number
	damping: number
}

// Named per-axis, not `x`/`y`, because configs are flat and `x`/`y` belong to the transform. Either axis alone
// gives an entity a velocity, so both are optional and a missing one starts at 0.
export interface VelocityConfig {
	velocityX?: number
	velocityY?: number
	// Linear damping per second: the fraction of speed shed each second, applied as 1/(1+damping*dt) so it stays
	// stable at any step and never reverses. 0 (default) coasts forever; higher values stop sooner.
	damping?: number
}
// Both spawn config and live state (a game's systems apply forces), so it round-trips through `save`.
export type VelocitySerialization = VelocityConfig;

// Indexes into the backing Float32Array block, exported because the physics update reads the same offsets off
// the raw block.
export const VELOCITY_X_INDEX = 0;
export const VELOCITY_Y_INDEX = 1;
export const VELOCITY_DAMPING_INDEX = 2;
export const VELOCITY_SIZE = 3;

class VelocityComponentImpl extends Component<Float32Array> implements VelocityComponent {
	get velocityX() {
		return this.block[VELOCITY_X_INDEX];
	}
	set velocityX(value: number) {
		this.block[VELOCITY_X_INDEX] = value;
	}
	get velocityY() {
		return this.block[VELOCITY_Y_INDEX];
	}
	set velocityY(value: number) {
		this.block[VELOCITY_Y_INDEX] = value;
	}
	get damping() {
		return this.block[VELOCITY_DAMPING_INDEX];
	}
	set damping(value: number) {
		assertDamping(value);
		this.block[VELOCITY_DAMPING_INDEX] = value;
	}
}

export const velocityDefinition: ComponentDefinition<VelocityComponent, Float32Array, VelocityConfig, VelocitySerialization> = {
	type: Float32Array,
	size: VELOCITY_SIZE,
	loadProperties: ['velocityX', 'velocityY', 'damping'],
	toBlock(config) {
		const damping = config.damping ?? 0;
		assertDamping(damping);

		return [config.velocityX ?? 0, config.velocityY ?? 0, damping];
	},
	attach(entity, memory, index) {
		return new VelocityComponentImpl(memory.getBlock(index), index);
	},
	save(component) {
		return {
			velocityX: component.velocityX,
			velocityY: component.velocityY,
			damping: component.damping,
		};
	},
};

function assertDamping(value: number): void {
	if(!Number.isFinite(value) || value < 0) {
		throw new Error('Damping must be a finite number of at least zero');
	}
}

export default velocityDefinition;
