import { NAVIGATION_RESULT_INDEX, NAVIGATION_REQUEST_INDEX, NAVIGATION_WAYPOINT_INDEX } from '../../components/navigation-component-constants';
import { isPathPending, navigateTo, writePath } from '../../components/navigation-component';
import { FollowStep, followPath } from '../follow-path';
import { PathStatus, type Point, type PathStatusValue } from '../path-search';
import { navigationBlock } from './pathfinding-fixtures';

function settled(status: PathStatusValue, points: Array<Point>, goal: Point = { x: 500, y: 0 }): Int32Array {
	const navigation = navigationBlock();
	navigateTo(navigation, goal.x, goal.y);
	writePath(navigation, status, points);
	navigation[NAVIGATION_RESULT_INDEX] = navigation[NAVIGATION_REQUEST_INDEX];
	return navigation;
}

describe('followPath', () => {
	it('waits while a path is pending', () => {
		const navigation = navigationBlock();
		navigateTo(navigation, 100, 0);

		expect(followPath(navigation, 0, 0, 4, { x: 0, y: 0 })).toBe(FollowStep.Waiting);
	});

	it('heads for the next waypoint, skipping any already reached', () => {
		const navigation = settled(PathStatus.Found, [{ x: 10, y: 0 }, { x: 50, y: 0 }]);
		const target = { x: 0, y: 0 };

		expect(followPath(navigation, 8, 0, 4, target)).toBe(FollowStep.Waypoint);
		expect(target).toEqual({ x: 50, y: 0 });
		expect(navigation[NAVIGATION_WAYPOINT_INDEX]).toBe(1);
	});

	it('heads for the goal past the last waypoint of a found path', () => {
		const navigation = settled(PathStatus.Found, [{ x: 10, y: 0 }], { x: 99.5, y: 3 });
		const target = { x: 0, y: 0 };

		expect(followPath(navigation, 10, 0, 4, target)).toBe(FollowStep.Goal);
		expect(target).toEqual({ x: 99.5, y: 3 });
	});

	it('asks again from the end of an incomplete path', () => {
		const navigation = settled(PathStatus.Incomplete, [{ x: 10, y: 0 }]);

		expect(followPath(navigation, 10, 0, 4, { x: 0, y: 0 })).toBe(FollowStep.Waiting);
		expect(isPathPending(navigation)).toBe(true);
	});

	it('is stuck at the end of a path that cannot reach its goal', () => {
		const navigation = settled(PathStatus.Unreachable, [{ x: 10, y: 0 }]);

		expect(followPath(navigation, 10, 0, 4, { x: 0, y: 0 })).toBe(FollowStep.Stuck);
		expect(isPathPending(navigation)).toBe(false);
	});
});
