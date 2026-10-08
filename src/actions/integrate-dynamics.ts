import {
	DYNAMICS_ACCELERATION_X_INDEX,
	DYNAMICS_ACCELERATION_Y_INDEX,
	DYNAMICS_INVERSE_MASS_INDEX,
} from '../components/dynamics-component-constants';
import { VELOCITY_DAMPING_INDEX, VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component-constants';

import {
	DYNAMICS_COMMAND_FORCE_X_OFFSET,
	DYNAMICS_COMMAND_FORCE_Y_OFFSET,
	DYNAMICS_COMMAND_IMPULSE_X_OFFSET,
	DYNAMICS_COMMAND_IMPULSE_Y_OFFSET,
	DYNAMICS_COMMAND_VELOCITY_MASK_OFFSET,
	DYNAMICS_COMMAND_VELOCITY_X_OFFSET,
	DYNAMICS_COMMAND_VELOCITY_Y_OFFSET,
	DYNAMICS_COMMAND_VELOCITY_X_FLAG,
	DYNAMICS_COMMAND_VELOCITY_Y_FLAG,
} from './dynamics-commands';
import type { DynamicsWorld } from './dynamics-commands';
import { findDynamicsCommand } from './find-dynamics-command';
import { findDynamicsCommandOffset } from './find-dynamics-command-offset';

// Semi-implicit Euler: acceleration changes this step's velocity before that velocity is turned into movement.
export function integrateDynamics(world: DynamicsWorld, entityId: number, velocity: Float32Array, dynamics?: Float32Array): void {
	const commands = world.dynamicsCommands;
	const flatCommands = commands instanceof Float64Array ? commands : undefined;
	const recordCommands = commands && !(commands instanceof Float64Array) ? commands : undefined;
	const command = findDynamicsCommand(recordCommands, entityId);
	const commandOffset = flatCommands ? findDynamicsCommandOffset(flatCommands, entityId) : -1;
	const damping = velocity[VELOCITY_DAMPING_INDEX];
	if(!dynamics && !command && commandOffset < 0 && damping === 0) {
		return;
	}

	const seconds = world.elapsedTime / 1000;
	const inverseMass = dynamics?.[DYNAMICS_INVERSE_MASS_INDEX] ?? 1;
	const forceX = commandOffset < 0 ? command?.forceX ?? 0 : flatCommands![commandOffset + DYNAMICS_COMMAND_FORCE_X_OFFSET];
	const forceY = commandOffset < 0 ? command?.forceY ?? 0 : flatCommands![commandOffset + DYNAMICS_COMMAND_FORCE_Y_OFFSET];
	const impulseX = commandOffset < 0 ? command?.impulseX ?? 0 : flatCommands![commandOffset + DYNAMICS_COMMAND_IMPULSE_X_OFFSET];
	const impulseY = commandOffset < 0 ? command?.impulseY ?? 0 : flatCommands![commandOffset + DYNAMICS_COMMAND_IMPULSE_Y_OFFSET];
	const velocityMask = commandOffset < 0 ? 0 : flatCommands![commandOffset + DYNAMICS_COMMAND_VELOCITY_MASK_OFFSET];
	const assignedVelocityX = commandOffset < 0
		? command?.velocityX
		: velocityMask & DYNAMICS_COMMAND_VELOCITY_X_FLAG
			? flatCommands![commandOffset + DYNAMICS_COMMAND_VELOCITY_X_OFFSET]
			: undefined;
	const assignedVelocityY = commandOffset < 0
		? command?.velocityY
		: velocityMask & DYNAMICS_COMMAND_VELOCITY_Y_FLAG
			? flatCommands![commandOffset + DYNAMICS_COMMAND_VELOCITY_Y_OFFSET]
			: undefined;
	// Implicit damping: 1/(1+damping*dt) shed off the integrated velocity, stable at any step and never reversing.
	// An explicit velocity assignment is authoritative for the step, so it bypasses damping until it coasts again.
	const dampingFactor = damping > 0 ? 1 / (1 + damping * seconds) : 1;
	const integratedVelocityX = (velocity[VELOCITY_X_INDEX]
		+ (dynamics?.[DYNAMICS_ACCELERATION_X_INDEX] ?? 0) * seconds
		+ forceX * inverseMass * seconds
		+ impulseX * inverseMass) * dampingFactor;
	const integratedVelocityY = (velocity[VELOCITY_Y_INDEX]
		+ (dynamics?.[DYNAMICS_ACCELERATION_Y_INDEX] ?? 0) * seconds
		+ forceY * inverseMass * seconds
		+ impulseY * inverseMass) * dampingFactor;
	velocity[VELOCITY_X_INDEX] = assignedVelocityX ?? integratedVelocityX;
	velocity[VELOCITY_Y_INDEX] = assignedVelocityY ?? integratedVelocityY;
}

export default integrateDynamics;
