import {
	DYNAMICS_COMMAND_STRIDE,
	DYNAMICS_COMMAND_ENTITY_ID_OFFSET,
} from './dynamics-commands';
import type { DynamicsCommandBuffer } from './dynamics-commands';

export function findDynamicsCommandOffset(commands: DynamicsCommandBuffer, entityId: number): number {
	let low = 0;
	let high = commands.length / DYNAMICS_COMMAND_STRIDE - 1;
	while(low <= high) {
		const middle = (low + high) >>> 1;
		const offset = middle * DYNAMICS_COMMAND_STRIDE;
		const commandEntityId = commands[offset + DYNAMICS_COMMAND_ENTITY_ID_OFFSET];
		if(commandEntityId === entityId) {
			return offset;
		} else if(commandEntityId < entityId) {
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return -1;
}

