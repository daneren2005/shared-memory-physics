import { loadFloat32, storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';
import {
	NAVIGATION_ACTIVE_INDEX,
	NAVIGATION_GOAL_X_INDEX,
	NAVIGATION_GOAL_Y_INDEX,
	NAVIGATION_MAX_WAYPOINTS,
	NAVIGATION_OUTCOME_INDEX,
	NAVIGATION_REQUEST_INDEX,
	NAVIGATION_RESULT_INDEX,
	NAVIGATION_SIZE,
	NAVIGATION_WAYPOINT_COUNT_INDEX,
	NAVIGATION_WAYPOINT_INDEX,
	NAVIGATION_WAYPOINTS_INDEX,
} from './navigation-component-constants';
import { PathStatus, type Point } from '../pathfinding/path-search';

// A goal to walk to and the path PathfindingSystem found there. Who follows the path (sets velocity along it) is up to
// the game; followPath does the bookkeeping.
export interface NavigationComponent {
	index: number
	readonly active: boolean
	readonly goalX: number
	readonly goalY: number
	readonly pending: boolean
	readonly outcome: number
	readonly waypointIndex: number
	readonly waypoints: Array<Point>
	navigateTo(x: number, y: number): void
	stop(): void
}

// A capability tag. Goals and paths are transient: whoever set a goal re-issues it after a load.
export interface NavigationConfig {
	navigate: boolean
}

class NavigationComponentImpl extends Component<Int32Array> implements NavigationComponent {
	get active() {
		return this.block[NAVIGATION_ACTIVE_INDEX] !== 0;
	}
	get goalX() {
		return loadFloat32(this.block, NAVIGATION_GOAL_X_INDEX);
	}
	get goalY() {
		return loadFloat32(this.block, NAVIGATION_GOAL_Y_INDEX);
	}
	get pending() {
		return isPathPending(this.block);
	}
	get outcome() {
		return this.block[NAVIGATION_OUTCOME_INDEX];
	}
	get waypointIndex() {
		return this.block[NAVIGATION_WAYPOINT_INDEX];
	}
	get waypoints() {
		return Array.from({ length: this.block[NAVIGATION_WAYPOINT_COUNT_INDEX] }, (_, i) => waypoint(this.block, i));
	}
	navigateTo(x: number, y: number) {
		navigateTo(this.block, x, y);
	}
	stop() {
		stopNavigating(this.block);
	}
}

export const navigationDefinition: ComponentDefinition<NavigationComponent, Int32Array, NavigationConfig> = {
	type: Int32Array,
	size: NAVIGATION_SIZE,
	loadProperties: ['navigate'],
	toBlock: () => Array.from({ length: NAVIGATION_SIZE }, () => 0),
	attach(entity, memory, index) {
		return new NavigationComponentImpl(memory.getBlock(index), index);
	},
};

// Sets a new goal and asks for a path to it.
export function navigateTo(navigation: Int32Array, x: number, y: number): void {
	setNavigationGoal(navigation, x, y);
	navigation[NAVIGATION_ACTIVE_INDEX] = 1;
	requestPath(navigation);
}

// Nudges the goal without searching again: the path already found still leads near it, and its last leg heads here.
export function setNavigationGoal(navigation: Int32Array, x: number, y: number): void {
	storeFloat32(navigation, NAVIGATION_GOAL_X_INDEX, x);
	storeFloat32(navigation, NAVIGATION_GOAL_Y_INDEX, y);
}

export function stopNavigating(navigation: Int32Array): void {
	navigation[NAVIGATION_ACTIVE_INDEX] = 0;
}

export function isNavigating(navigation: Int32Array): boolean {
	return navigation[NAVIGATION_ACTIVE_INDEX] !== 0;
}

// Searches again for the current goal.
export function requestPath(navigation: Int32Array): void {
	Atomics.add(navigation, NAVIGATION_REQUEST_INDEX, 1);
}

export function isPathPending(navigation: Int32Array): boolean {
	return Atomics.load(navigation, NAVIGATION_REQUEST_INDEX) !== Atomics.load(navigation, NAVIGATION_RESULT_INDEX);
}

export function isUnreachable(navigation: Int32Array): boolean {
	return !isPathPending(navigation) && navigation[NAVIGATION_OUTCOME_INDEX] === PathStatus.Unreachable;
}

export function navigationGoal(navigation: Int32Array): Point {
	return { x: loadFloat32(navigation, NAVIGATION_GOAL_X_INDEX), y: loadFloat32(navigation, NAVIGATION_GOAL_Y_INDEX) };
}

export function waypoint(navigation: Int32Array, i: number): Point {
	return { x: waypointX(navigation, i), y: waypointY(navigation, i) };
}

export function waypointX(navigation: Int32Array, i: number): number {
	return loadFloat32(navigation, NAVIGATION_WAYPOINTS_INDEX + i * 2);
}

export function waypointY(navigation: Int32Array, i: number): number {
	return loadFloat32(navigation, NAVIGATION_WAYPOINTS_INDEX + i * 2 + 1);
}

// Leaves the result id alone: the writer stores it last, once the path is in place.
export function writePath(navigation: Int32Array, status: number, points: ReadonlyArray<Point>): void {
	const truncated = points.length > NAVIGATION_MAX_WAYPOINTS;
	const count = truncated ? NAVIGATION_MAX_WAYPOINTS : points.length;
	for(let i = 0; i < count; i++) {
		storeFloat32(navigation, NAVIGATION_WAYPOINTS_INDEX + i * 2, points[i].x);
		storeFloat32(navigation, NAVIGATION_WAYPOINTS_INDEX + i * 2 + 1, points[i].y);
	}
	navigation[NAVIGATION_WAYPOINT_COUNT_INDEX] = count;
	navigation[NAVIGATION_WAYPOINT_INDEX] = 0;
	navigation[NAVIGATION_OUTCOME_INDEX] = truncated ? PathStatus.Incomplete : status;
}

export default navigationDefinition;
