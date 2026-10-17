import {
	NAVIGATION_MAX_WAYPOINTS,
	NAVIGATION_OUTCOME_INDEX,
	NAVIGATION_RESULT_INDEX,
	NAVIGATION_WAYPOINT_COUNT_INDEX,
	NAVIGATION_WAYPOINT_INDEX,
} from '../navigation-component-constants';
import {
	isNavigating,
	isPathPending,
	isUnreachable,
	navigateTo,
	navigationGoal,
	requestPath,
	setNavigationGoal,
	stopNavigating,
	waypoint,
	writePath,
} from '../navigation-component';
import { PathStatus } from '../../pathfinding/path-search';
import { createNavigationWorld, navigationBlock } from '../../pathfinding/__tests__/pathfinding-fixtures';

describe('navigation component', () => {
	it('starts idle and settled with nothing to follow', () => {
		const navigation = navigationBlock();

		expect(isNavigating(navigation)).toBe(false);
		expect(isPathPending(navigation)).toBe(false);
		expect(isUnreachable(navigation)).toBe(false);
		expect(navigation[NAVIGATION_WAYPOINT_COUNT_INDEX]).toBe(0);
	});

	it('sets the goal, activates and asks for a path when told where to go', () => {
		const navigation = navigationBlock();

		navigateTo(navigation, 12.25, -40.5);

		expect(navigationGoal(navigation)).toEqual({ x: 12.25, y: -40.5 });
		expect(isNavigating(navigation)).toBe(true);
		expect(isPathPending(navigation)).toBe(true);
	});

	it('moves the goal without searching again', () => {
		const navigation = navigationBlock();

		setNavigationGoal(navigation, 3, 4);

		expect(navigationGoal(navigation)).toEqual({ x: 3, y: 4 });
		expect(isPathPending(navigation)).toBe(false);
	});

	it('stops without touching the goal', () => {
		const navigation = navigationBlock();
		navigateTo(navigation, 3, 4);

		stopNavigating(navigation);

		expect(isNavigating(navigation)).toBe(false);
		expect(navigationGoal(navigation)).toEqual({ x: 3, y: 4 });
	});

	it('is pending from a request until the result id catches up', () => {
		const navigation = navigationBlock();
		requestPath(navigation);
		expect(isPathPending(navigation)).toBe(true);

		requestPath(navigation);
		navigation[NAVIGATION_RESULT_INDEX] = 1;
		expect(isPathPending(navigation)).toBe(true);

		navigation[NAVIGATION_RESULT_INDEX] = 2;
		expect(isPathPending(navigation)).toBe(false);
	});

	it('only reports unreachable once the answer is settled', () => {
		const navigation = navigationBlock();
		navigation[NAVIGATION_OUTCOME_INDEX] = PathStatus.Unreachable;
		expect(isUnreachable(navigation)).toBe(true);

		requestPath(navigation);
		expect(isUnreachable(navigation)).toBe(false);
	});

	it('keeps fractional waypoints and starts following from the first', () => {
		const navigation = navigationBlock();
		navigation[NAVIGATION_WAYPOINT_INDEX] = 3;

		writePath(navigation, PathStatus.Found, [{ x: 0.5, y: 16 }, { x: 80.25, y: -111.5 }]);

		expect(navigation[NAVIGATION_WAYPOINT_COUNT_INDEX]).toBe(2);
		expect(navigation[NAVIGATION_WAYPOINT_INDEX]).toBe(0);
		expect(navigation[NAVIGATION_OUTCOME_INDEX]).toBe(PathStatus.Found);
		expect([waypoint(navigation, 0), waypoint(navigation, 1)]).toEqual([{ x: 0.5, y: 16 }, { x: 80.25, y: -111.5 }]);
	});

	it('cuts a path too long to hold and marks it incomplete', () => {
		const navigation = navigationBlock();
		const points = Array.from({ length: NAVIGATION_MAX_WAYPOINTS + 5 }, (_, i) => ({ x: i * 32, y: 0 }));

		writePath(navigation, PathStatus.Found, points);

		expect(navigation[NAVIGATION_WAYPOINT_COUNT_INDEX]).toBe(NAVIGATION_MAX_WAYPOINTS);
		expect(navigation[NAVIGATION_OUTCOME_INDEX]).toBe(PathStatus.Incomplete);
		expect(waypoint(navigation, NAVIGATION_MAX_WAYPOINTS - 1)).toEqual(points[NAVIGATION_MAX_WAYPOINTS - 1]);
	});

	it('loads from a navigate tag and reads the block through the component', () => {
		const world = createNavigationWorld();
		const entity = world.loadEntity({ x: 0, y: 0, width: 8, height: 8, navigate: true });
		const navigation = entity.components.navigation;

		navigation?.navigateTo(10, 20);
		expect(navigation).toMatchObject({ active: true, goalX: 10, goalY: 20, pending: true, waypoints: [] });

		navigation?.stop();
		expect(navigation?.active).toBe(false);
	});
});
