import { emptyCommand } from './dynamics-commands';
import type { PendingDynamicsCommands, VelocityAssignment } from './dynamics-commands';

export function queueVelocityAssignment(
	commands: PendingDynamicsCommands,
	entityId: number,
	velocity: VelocityAssignment,
): void {
	assertFiniteAssignment(velocity);
	if(velocity.velocityX === undefined && velocity.velocityY === undefined) {
		return;
	}

	commands.set(entityId, { ...(commands.get(entityId) ?? emptyCommand()), ...velocity });
}

function assertFiniteAssignment(velocity: VelocityAssignment): void {
	if((velocity.velocityX !== undefined && !Number.isFinite(velocity.velocityX))
		|| (velocity.velocityY !== undefined && !Number.isFinite(velocity.velocityY))) {
		throw new Error('Velocity assignment must contain finite numbers');
	}
}

