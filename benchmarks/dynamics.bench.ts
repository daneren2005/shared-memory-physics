import { bench, describe } from 'vitest';
import {
	DYNAMICS_ACCELERATION_X_INDEX,
	DYNAMICS_ACCELERATION_Y_INDEX,
	DYNAMICS_INVERSE_MASS_INDEX,
	DYNAMICS_SIZE,
} from '../src/components/dynamics-component';
import { VELOCITY_SIZE } from '../src/components/velocity-component';
import { integrateDynamics, type DynamicsCommand, type DynamicsWorld } from '../src/systems/dynamics';

const ENTITY_COUNT = 10_000;
const STEP_MS = 16;
const noCommands: DynamicsWorld = { elapsedTime: STEP_MS };
const dynamicsWorld: DynamicsWorld = { elapsedTime: STEP_MS };
const noDynamicsVelocity = new Float32Array(VELOCITY_SIZE);
const dynamicsVelocity = new Float32Array(VELOCITY_SIZE);
const recordCommandVelocity = new Float32Array(VELOCITY_SIZE);
const flatCommandVelocity = new Float32Array(VELOCITY_SIZE);
const dynamics = new Float32Array(DYNAMICS_SIZE);
dynamics[DYNAMICS_ACCELERATION_X_INDEX] = 10;
dynamics[DYNAMICS_ACCELERATION_Y_INDEX] = 20;
dynamics[DYNAMICS_INVERSE_MASS_INDEX] = 0.5;

const commands: Array<DynamicsCommand> = Array.from({ length: ENTITY_COUNT }, (_, entityId) => ({
	entityId,
	forceX: 10,
	forceY: 20,
	impulseX: 1,
	impulseY: 2,
}));
const commandWorld: DynamicsWorld = { elapsedTime: STEP_MS, dynamicsCommands: commands };
const flatCommands = new Float64Array(ENTITY_COUNT * 5);
for(let entityId = 0; entityId < ENTITY_COUNT; entityId++) {
	const offset = entityId * 5;
	flatCommands[offset] = entityId;
	flatCommands[offset + 1] = 10;
	flatCommands[offset + 2] = 20;
	flatCommands[offset + 3] = 1;
	flatCommands[offset + 4] = 2;
}
const flatCommandWorld: DynamicsWorld = { elapsedTime: STEP_MS, dynamicsCommands: flatCommands };

describe('dynamics integration', () => {
	bench('10k movers without dynamics or commands', () => {
		for(let entityId = 0; entityId < ENTITY_COUNT; entityId++) {
			integrateDynamics(noCommands, entityId, noDynamicsVelocity);
		}

		void noDynamicsVelocity[0];
	});

	bench('10k movers with persistent dynamics', () => {
		for(let entityId = 0; entityId < ENTITY_COUNT; entityId++) {
			integrateDynamics(dynamicsWorld, entityId, dynamicsVelocity, dynamics);
		}

		void dynamicsVelocity[0];
	});

	bench('10k movers with record commands', () => {
		for(let entityId = 0; entityId < ENTITY_COUNT; entityId++) {
			integrateDynamics(commandWorld, entityId, recordCommandVelocity);
		}

		void recordCommandVelocity[0];
	});

	bench('10k movers with flat commands', () => {
		for(let entityId = 0; entityId < ENTITY_COUNT; entityId++) {
			integrateDynamics(flatCommandWorld, entityId, flatCommandVelocity);
		}

		void flatCommandVelocity[0];
	});
});

describe('command transport', () => {
	bench('structured-clone 10k records', () => {
		void structuredClone(commands);
	});
	bench('structured-clone 10k flat values', () => {
		void structuredClone(flatCommands);
	});
});
