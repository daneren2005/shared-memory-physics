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

export function emptyCommand(): Omit<DynamicsCommand, 'entityId'> {
	return { forceX: 0, forceY: 0, impulseX: 0, impulseY: 0 };
}

