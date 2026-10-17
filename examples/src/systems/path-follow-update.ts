import {
	FollowStep,
	TRANSFORM_X_INDEX,
	TRANSFORM_Y_INDEX,
	VELOCITY_X_INDEX,
	VELOCITY_Y_INDEX,
	followPath,
	isNavigating,
	stopNavigating,
} from '@daneren2005/shared-memory-physics';
import type { Point } from '@daneren2005/shared-memory-physics';
import type { EntityUpdateComponents, EntityUpdateFunction, EntityWorkerSystemWorld } from '@daneren2005/shared-memory-ecs';
import type { Components } from '../world';
import { terrainSpeedAt } from './terrain';
import type { TerrainData } from './terrain';

// Close enough to the goal to call it arrived.
const GOAL_DISTANCE = 1;

export interface FollowSettings {
	// World units per second on plain ground, scaled by the terrain underfoot.
	speed: number
}

export type PathFollowComponents = {
	navigation: Int32Array
	transform: Float32Array
	velocity: Float32Array
} & EntityUpdateComponents<Components>;

export interface PathFollowInitData {
	terrain: TerrainData
}

export interface PathFollowWorld extends EntityWorkerSystemWorld {
	follow?: FollowSettings
	terrain?: TerrainData
}

// Reused across entities so following a path every step does not allocate.
const target: Point = { x: 0, y: 0 };

// Points velocity at the next waypoint; physics does the moving and slides the mover off any corner it clips.
export const pathFollowUpdate: EntityUpdateFunction<Components, PathFollowComponents, PathFollowWorld, PathFollowInitData> = (world, _entityId, components) => {
	const { navigation, transform, velocity } = components;
	if(!isNavigating(navigation)) {
		halt(velocity);
		return;
	}

	const x = transform[TRANSFORM_X_INDEX];
	const y = transform[TRANSFORM_Y_INDEX];
	const terrainSpeed = world.terrain ? terrainSpeedAt(world.terrain, x, y) : 1;
	const maxSpeed = (world.follow?.speed ?? 0) * terrainSpeed;
	// Moving on from a waypoint within one step of it keeps the mover at full speed through every corner.
	const stepDistance = maxSpeed * world.elapsedTime / 1000;

	const step = followPath(navigation, x, y, Math.max(GOAL_DISTANCE, stepDistance), target);
	if(step === FollowStep.Waiting || step === FollowStep.Stuck) {
		halt(velocity);
		return;
	}

	const dx = target.x - x;
	const dy = target.y - y;
	const distance = Math.hypot(dx, dy);
	if(step === FollowStep.Goal && distance <= GOAL_DISTANCE) {
		stopNavigating(navigation);
		halt(velocity);
		return;
	}

	// Never ask for more than closes the gap this step, or the mover overshoots the goal and hunts back and forth.
	const speed = stepDistance > distance ? distance * 1000 / world.elapsedTime : maxSpeed;
	velocity[VELOCITY_X_INDEX] = dx / distance * speed;
	velocity[VELOCITY_Y_INDEX] = dy / distance * speed;
};

pathFollowUpdate.init = (_world, data) => ({ terrain: data?.terrain });

function halt(velocity: Float32Array): void {
	if(velocity[VELOCITY_X_INDEX] !== 0 || velocity[VELOCITY_Y_INDEX] !== 0) {
		velocity[VELOCITY_X_INDEX] = 0;
		velocity[VELOCITY_Y_INDEX] = 0;
	}
}

export default pathFollowUpdate;
