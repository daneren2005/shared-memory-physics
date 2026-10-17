import { loadFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import {
	NAVIGATION_GOAL_X_INDEX,
	NAVIGATION_GOAL_Y_INDEX,
	NAVIGATION_OUTCOME_INDEX,
	NAVIGATION_WAYPOINT_COUNT_INDEX,
	NAVIGATION_WAYPOINT_INDEX,
} from '../components/navigation-component-constants';
import { isPathPending, requestPath, waypointX, waypointY } from '../components/navigation-component';
import { PathStatus, type Point } from './path-search';

export const FollowStep = {
	// No path to follow yet, including just after asking again from the end of an incomplete one.
	Waiting: 0,
	// `target` is the next waypoint.
	Waypoint: 1,
	// Past the last waypoint of a found path; `target` is the goal.
	Goal: 2,
	// At the closest reachable spot to an unreachable goal; whoever set it decides what to do next.
	Stuck: 3,
} as const;
export type FollowStepValue = typeof FollowStep[keyof typeof FollowStep];

// Advances past waypoints within `arriveDistance` of (x, y) and says where to head next. Writes into `target` rather
// than returning a point so a follower running every step does not allocate.
export function followPath(navigation: Int32Array, x: number, y: number, arriveDistance: number, target: Point): FollowStepValue {
	if(isPathPending(navigation)) {
		return FollowStep.Waiting;
	}

	const count = navigation[NAVIGATION_WAYPOINT_COUNT_INDEX];
	let index = navigation[NAVIGATION_WAYPOINT_INDEX];
	while(index < count && Math.hypot(waypointX(navigation, index) - x, waypointY(navigation, index) - y) <= arriveDistance) {
		index++;
	}
	navigation[NAVIGATION_WAYPOINT_INDEX] = index;

	if(index < count) {
		target.x = waypointX(navigation, index);
		target.y = waypointY(navigation, index);
		return FollowStep.Waypoint;
	}
	const outcome = navigation[NAVIGATION_OUTCOME_INDEX];
	if(outcome === PathStatus.Incomplete) {
		requestPath(navigation);
		return FollowStep.Waiting;
	}
	if(outcome === PathStatus.Found) {
		target.x = loadFloat32(navigation, NAVIGATION_GOAL_X_INDEX);
		target.y = loadFloat32(navigation, NAVIGATION_GOAL_Y_INDEX);
		return FollowStep.Goal;
	}
	return FollowStep.Stuck;
}
