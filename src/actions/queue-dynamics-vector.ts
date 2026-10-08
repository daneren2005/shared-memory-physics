import { emptyCommand } from './dynamics-commands';
import type { PendingDynamicsCommands } from './dynamics-commands';

export function queueDynamicsVector(
	commands: PendingDynamicsCommands,
	entityId: number,
	forceX: number,
	forceY: number,
	impulseX: number,
	impulseY: number,
): void {
	assertFiniteVector(forceX, forceY, 'Force');
	assertFiniteVector(impulseX, impulseY, 'Impulse');
	if(forceX === 0 && forceY === 0 && impulseX === 0 && impulseY === 0) {
		return;
	}

	const current = commands.get(entityId) ?? emptyCommand();
	const next = {
		...current,
		forceX: current.forceX + forceX,
		forceY: current.forceY + forceY,
		impulseX: current.impulseX + impulseX,
		impulseY: current.impulseY + impulseY,
	};
	assertFiniteVector(next.forceX, next.forceY, 'Accumulated force');
	assertFiniteVector(next.impulseX, next.impulseY, 'Accumulated impulse');
	commands.set(entityId, next);
}

function assertFiniteVector(x: number, y: number, name: string): void {
	if(!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${name} must contain finite numbers`);
	}
}

