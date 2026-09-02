import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

export interface DynamicsComponent {
	index: number
	accelerationX: number
	accelerationY: number
	mass: number
}

export interface DynamicsConfig {
	accelerationX?: number
	accelerationY?: number
	mass?: number
}

export type DynamicsSerialization = DynamicsConfig;

export const DYNAMICS_ACCELERATION_X_INDEX = 0;
export const DYNAMICS_ACCELERATION_Y_INDEX = 1;
export const DYNAMICS_INVERSE_MASS_INDEX = 2;
export const DYNAMICS_SIZE = 3;

class DynamicsComponentImpl extends Component<Float32Array> implements DynamicsComponent {
	get accelerationX() {
		return this.block[DYNAMICS_ACCELERATION_X_INDEX];
	}
	set accelerationX(value: number) {
		assertFinite(value, 'Acceleration');
		this.block[DYNAMICS_ACCELERATION_X_INDEX] = value;
	}
	get accelerationY() {
		return this.block[DYNAMICS_ACCELERATION_Y_INDEX];
	}
	set accelerationY(value: number) {
		assertFinite(value, 'Acceleration');
		this.block[DYNAMICS_ACCELERATION_Y_INDEX] = value;
	}
	get mass() {
		return 1 / this.block[DYNAMICS_INVERSE_MASS_INDEX];
	}
	set mass(value: number) {
		assertMass(value);
		this.block[DYNAMICS_INVERSE_MASS_INDEX] = 1 / value;
	}
}

export const dynamicsDefinition: ComponentDefinition<DynamicsComponent, Float32Array, DynamicsConfig, DynamicsSerialization> = {
	type: Float32Array,
	size: DYNAMICS_SIZE,
	loadProperties: ['accelerationX', 'accelerationY', 'mass'],
	toBlock(config) {
		const accelerationX = config.accelerationX ?? 0;
		const accelerationY = config.accelerationY ?? 0;
		const mass = config.mass ?? 1;
		assertFinite(accelerationX, 'Acceleration');
		assertFinite(accelerationY, 'Acceleration');
		assertMass(mass);

		return [accelerationX, accelerationY, 1 / mass];
	},
	attach(entity, memory, index) {
		return new DynamicsComponentImpl(memory.getBlock(index), index);
	},
	save(component) {
		return {
			accelerationX: component.accelerationX,
			accelerationY: component.accelerationY,
			mass: component.mass,
		};
	},
};

function assertMass(value: number): void {
	if(!Number.isFinite(value) || value <= 0) {
		throw new Error('Mass must be a finite number greater than zero');
	}
}

function assertFinite(value: number, name: string): void {
	if(!Number.isFinite(value)) {
		throw new Error(`${name} must be a finite number`);
	}
}

export default dynamicsDefinition;
