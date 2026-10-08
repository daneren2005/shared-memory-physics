import {
	DYNAMICS_COMMAND_STRIDE,
	DYNAMICS_COMMAND_ENTITY_ID_OFFSET,
	DYNAMICS_COMMAND_FORCE_X_OFFSET,
	DYNAMICS_COMMAND_FORCE_Y_OFFSET,
	DYNAMICS_COMMAND_IMPULSE_X_OFFSET,
	DYNAMICS_COMMAND_IMPULSE_Y_OFFSET,
	DYNAMICS_COMMAND_VELOCITY_MASK_OFFSET,
	DYNAMICS_COMMAND_VELOCITY_X_OFFSET,
	DYNAMICS_COMMAND_VELOCITY_Y_OFFSET,
	DYNAMICS_COMMAND_VELOCITY_X_FLAG,
	DYNAMICS_COMMAND_VELOCITY_Y_FLAG,
	emptyCommand,
} from './dynamics-commands';
import type { DynamicsCommand, DynamicsCommands } from './dynamics-commands';

// Commands raised by the previous physics run happened before main-thread commands attached to this one.
// Forces and impulses accumulate; a newer per-axis velocity assignment replaces an older one.
export function combineDynamicsCommands(
	queued: ReadonlyMap<number, Omit<DynamicsCommand, 'entityId'>>,
	incoming: DynamicsCommands | undefined,
): DynamicsCommands | undefined {
	if(queued.size === 0) {
		return incoming;
	}

	const combined = new Map<number, Omit<DynamicsCommand, 'entityId'>>();
	for(const [entityId, command] of queued) {
		combined.set(entityId, { ...command });
	}
	forEachDynamicsCommand(incoming, (entityId, command) => {
		const current = combined.get(entityId) ?? emptyCommand();
		combined.set(entityId, {
			forceX: current.forceX + command.forceX,
			forceY: current.forceY + command.forceY,
			impulseX: current.impulseX + command.impulseX,
			impulseY: current.impulseY + command.impulseY,
			velocityX: command.velocityX ?? current.velocityX,
			velocityY: command.velocityY ?? current.velocityY,
		});
	});

	return Array.from(combined, ([entityId, command]) => ({ entityId, ...command }))
		.sort((left, right) => left.entityId - right.entityId);
}

function forEachDynamicsCommand(
	commands: DynamicsCommands | undefined,
	handle: (entityId: number, command: Omit<DynamicsCommand, 'entityId'>) => void,
): void {
	if(!commands) {
		return;
	}
	if(!(commands instanceof Float64Array)) {
		for(const { entityId, ...command } of commands) {
			handle(entityId, command);
		}

		return;
	}

	for(let offset = 0; offset < commands.length; offset += DYNAMICS_COMMAND_STRIDE) {
		const velocityMask = commands[offset + DYNAMICS_COMMAND_VELOCITY_MASK_OFFSET];
		handle(commands[offset + DYNAMICS_COMMAND_ENTITY_ID_OFFSET], {
			forceX: commands[offset + DYNAMICS_COMMAND_FORCE_X_OFFSET],
			forceY: commands[offset + DYNAMICS_COMMAND_FORCE_Y_OFFSET],
			impulseX: commands[offset + DYNAMICS_COMMAND_IMPULSE_X_OFFSET],
			impulseY: commands[offset + DYNAMICS_COMMAND_IMPULSE_Y_OFFSET],
			velocityX: velocityMask & DYNAMICS_COMMAND_VELOCITY_X_FLAG
				? commands[offset + DYNAMICS_COMMAND_VELOCITY_X_OFFSET]
				: undefined,
			velocityY: velocityMask & DYNAMICS_COMMAND_VELOCITY_Y_FLAG
				? commands[offset + DYNAMICS_COMMAND_VELOCITY_Y_OFFSET]
				: undefined,
		});
	}
}

