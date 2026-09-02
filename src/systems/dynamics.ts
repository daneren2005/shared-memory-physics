import {
	DYNAMICS_ACCELERATION_X_INDEX,
	DYNAMICS_ACCELERATION_Y_INDEX,
	DYNAMICS_INVERSE_MASS_INDEX,
} from '../components/dynamics-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';

export interface DynamicsCommand {
	entityId: number
	forceX: number
	forceY: number
	impulseX: number
	impulseY: number
	velocityX?: number
	velocityY?: number
}

export interface VelocityAssignment {
	velocityX?: number
	velocityY?: number
}

export interface DynamicsCommandQueue {
	queueForce(entityId: number, forceX: number, forceY: number): void
	queueImpulse(entityId: number, impulseX: number, impulseY: number): void
	queueVelocity(entityId: number, velocity: VelocityAssignment): void
}

export type PendingDynamicsCommands = Map<number, Omit<DynamicsCommand, 'entityId'>>;

export type DynamicsCommandBuffer = Float64Array;
export type DynamicsCommands = DynamicsCommandBuffer | ReadonlyArray<DynamicsCommand>;

export const DYNAMICS_COMMAND_STRIDE = 8;
export const DYNAMICS_COMMAND_ENTITY_ID_OFFSET = 0;
export const DYNAMICS_COMMAND_FORCE_X_OFFSET = 1;
export const DYNAMICS_COMMAND_FORCE_Y_OFFSET = 2;
export const DYNAMICS_COMMAND_IMPULSE_X_OFFSET = 3;
export const DYNAMICS_COMMAND_IMPULSE_Y_OFFSET = 4;
export const DYNAMICS_COMMAND_VELOCITY_MASK_OFFSET = 5;
export const DYNAMICS_COMMAND_VELOCITY_X_OFFSET = 6;
export const DYNAMICS_COMMAND_VELOCITY_Y_OFFSET = 7;
export const DYNAMICS_COMMAND_VELOCITY_X_FLAG = 1 << 0;
export const DYNAMICS_COMMAND_VELOCITY_Y_FLAG = 1 << 1;

export interface DynamicsWorld {
	elapsedTime: number
	dynamicsCommands?: DynamicsCommands
}

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

// Semi-implicit Euler: acceleration changes this step's velocity before that velocity is turned into movement.
export function integrateDynamics(world: DynamicsWorld, entityId: number, velocity: Float32Array, dynamics?: Float32Array): void {
	const commands = world.dynamicsCommands;
	const flatCommands = commands instanceof Float64Array ? commands : undefined;
	const recordCommands = commands && !(commands instanceof Float64Array) ? commands : undefined;
	const command = findDynamicsCommand(recordCommands, entityId);
	const commandOffset = flatCommands ? findDynamicsCommandOffset(flatCommands, entityId) : -1;
	if(!dynamics && !command && commandOffset < 0) {
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
	const integratedVelocityX = velocity[VELOCITY_X_INDEX]
		+ (dynamics?.[DYNAMICS_ACCELERATION_X_INDEX] ?? 0) * seconds
		+ forceX * inverseMass * seconds
		+ impulseX * inverseMass;
	const integratedVelocityY = velocity[VELOCITY_Y_INDEX]
		+ (dynamics?.[DYNAMICS_ACCELERATION_Y_INDEX] ?? 0) * seconds
		+ forceY * inverseMass * seconds
		+ impulseY * inverseMass;
	velocity[VELOCITY_X_INDEX] = assignedVelocityX ?? integratedVelocityX;
	velocity[VELOCITY_Y_INDEX] = assignedVelocityY ?? integratedVelocityY;
}

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

function emptyCommand(): Omit<DynamicsCommand, 'entityId'> {
	return { forceX: 0, forceY: 0, impulseX: 0, impulseY: 0 };
}

function assertFiniteVector(x: number, y: number, name: string): void {
	if(!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${name} must contain finite numbers`);
	}
}

function assertFiniteAssignment(velocity: VelocityAssignment): void {
	if((velocity.velocityX !== undefined && !Number.isFinite(velocity.velocityX))
		|| (velocity.velocityY !== undefined && !Number.isFinite(velocity.velocityY))) {
		throw new Error('Velocity assignment must contain finite numbers');
	}
}

export default integrateDynamics;
