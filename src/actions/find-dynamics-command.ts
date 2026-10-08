import type { DynamicsCommand } from './dynamics-commands';

export function findDynamicsCommand(commands: ReadonlyArray<DynamicsCommand> | undefined, entityId: number): DynamicsCommand | undefined {
	if(!commands) {
		return undefined;
	}

	let low = 0;
	let high = commands.length - 1;
	while(low <= high) {
		const middle = (low + high) >>> 1;
		const command = commands[middle];
		if(command.entityId === entityId) {
			return command;
		} else if(command.entityId < entityId) {
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return undefined;
}

