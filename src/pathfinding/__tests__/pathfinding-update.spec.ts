import {
	NAVIGATION_OUTCOME_INDEX,
	NAVIGATION_REQUEST_INDEX,
	NAVIGATION_RESULT_INDEX,
	NAVIGATION_WAYPOINT_COUNT_INDEX,
} from '../../components/navigation-component-constants';
import { isPathPending, navigateTo, requestPath, stopNavigating, waypoint, writePath } from '../../components/navigation-component';
import GridAStar from '../grid-a-star';
import type NavGrid from '../nav-grid';
import { createNavigationState, navigationGridFor } from '../navigation-state';
import { PATH_BLOCKERS_QUERY, PATH_GATES_QUERY } from '../path-blockers';
import { PathStatus, type PathRequest, type PathResult, type PathSearch } from '../path-search';
import {
	DEFAULT_PATH_SEARCH_ITERATION_BUDGET,
	createPathfindingUpdate,
	pathfindingUpdate,
	type PathfindingUpdateComponents,
	type PathfindingWorld,
} from '../pathfinding-update';
import { bodyBlock, initWorld, navigationBlock, stubCallbacks, transformBlock } from './pathfinding-fixtures';

const CELL = 32;
const DOOR = 0b10;

class StubSearch implements PathSearch {
	requests: Array<PathRequest> = [];
	result: PathResult = { status: PathStatus.Found, points: [], iterations: 0 };

	findPath(grid: NavGrid, request: PathRequest): PathResult {
		this.requests.push(request);
		return this.result;
	}
}

function createWorld(tilesWide = 20, tilesHigh = 20, gateCategories = 0): PathfindingWorld {
	return { gameTime: 0, elapsedTime: 50, getString: () => '', navigation: createNavigationState(tilesWide, tilesHigh, CELL, gateCategories) };
}

function mover(x: number, y: number, goalX: number, goalY: number, body?: Uint32Array): PathfindingUpdateComponents {
	const navigation = navigationBlock();
	navigateTo(navigation, goalX, goalY);
	return { navigation, transform: transformBlock(x, y), body };
}

function onTile(entityId: number, tileX: number, tileY: number, category = 0) {
	return { entityId, components: { transform: transformBlock((tileX + 0.5) * CELL, (tileY + 0.5) * CELL), body: bodyBlock({ category }) } };
}

function settle(navigation: Int32Array, points: Array<{ x: number, y: number }>) {
	writePath(navigation, PathStatus.Found, points);
	navigation[NAVIGATION_RESULT_INDEX] = navigation[NAVIGATION_REQUEST_INDEX];
}

// A wall across column 5 with a door at row 2.
function gatedWorld(): PathfindingWorld {
	const world = createWorld(10, 10, DOOR);
	const wall = Array.from({ length: 10 }, (_, tileY) => tileY).filter(tileY => tileY !== 2).map(tileY => onTile(10 + tileY, 5, tileY));
	const update = createPathfindingUpdate({ gateCategories: DOOR });
	update.queryChanged?.(world, PATH_BLOCKERS_QUERY, { added: wall, removed: [] }, stubCallbacks());
	update.queryChanged?.(world, PATH_GATES_QUERY, { added: [onTile(1, 5, 2, DOOR)], removed: [] }, stubCallbacks());
	return world;
}

describe('pathfinding update', () => {
	it('builds its grids from the map size, blockers and gates it is loaded with', () => {
		const update = createPathfindingUpdate({ gateCategories: DOOR });
		const extension = update.init?.(initWorld(), { tilesWide: 7, tilesHigh: 5, cellSize: CELL }, [], {
			[PATH_BLOCKERS_QUERY]: [onTile(1, 2, 3)],
			[PATH_GATES_QUERY]: [onTile(2, 5, 0, DOOR)],
		});
		const navigation = extension?.navigation;

		expect(navigation?.grid).toMatchObject({ tilesWide: 7, tilesHigh: 5, cellSize: CELL });
		expect(navigation?.grid.isBlocked(2, 3)).toBe(true);
		expect(navigation?.grid.isBlocked(5, 0)).toBe(false);
		expect(navigation && navigationGridFor(navigation, DOOR).isBlocked(5, 0)).toBe(true);
		expect(extension?.blockersAdded).toBeUndefined();
	});

	it('hands its init hook the built grids and keeps what the hook adds', () => {
		const init = vi.fn<() => Partial<PathfindingWorld>>(() => ({ searchIterations: 7 }));
		const update = createPathfindingUpdate({ init });
		const data = { tilesWide: 3, tilesHigh: 3, cellSize: CELL };

		const extension = update.init?.(initWorld(), data, [], {});

		expect(init).toHaveBeenCalledWith(extension?.navigation, data, {});
		expect(extension?.searchIterations).toBe(7);
	});

	it('records its gate categories for the system to build queries from', () => {
		expect(createPathfindingUpdate({ gateCategories: DOOR }).pathfinding).toEqual({ gateCategories: DOOR });
		expect(pathfindingUpdate.pathfinding).toEqual({ gateCategories: 0 });
	});

	it('searches with the algorithm it was built with, toward the navigation goal', () => {
		const search = new StubSearch();
		const blocks = mover(16, 48, 300.5, 48);

		createPathfindingUpdate({ search })(createWorld(), 1, blocks, {}, stubCallbacks());

		expect(search.requests).toEqual([{ startX: 16, startY: 48, goalX: 300.5, goalY: 48, agentWidth: 32, agentHeight: 32 }]);
	});

	it('cuts diagonally across open ground by default', () => {
		const world = createWorld();
		pathfindingUpdate.queryChanged?.(world, PATH_BLOCKERS_QUERY, { added: [onTile(1, 8, 8)], removed: [] }, stubCallbacks());
		const start = { x: 15.5 * CELL, y: 15.5 * CELL };
		const goal = { x: 2.5 * CELL, y: 2.5 * CELL };
		const blocks = mover(start.x, start.y, goal.x, goal.y);

		pathfindingUpdate(world, 1, blocks, {}, stubCallbacks());

		expect(blocks.navigation[NAVIGATION_OUTCOME_INDEX]).toBe(PathStatus.Found);
		const points = [start, ...Array.from({ length: blocks.navigation[NAVIGATION_WAYPOINT_COUNT_INDEX] }, (_, i) => waypoint(blocks.navigation, i)), goal];
		const length = points.slice(1).reduce((total, point, i) => total + Math.hypot(point.x - points[i].x, point.y - points[i].y), 0);
		// A 4-way path walks the full 26 tiles of an L; a diagonal one is close to the 18.4-tile straight line.
		expect(length).toBeLessThan(20 * CELL);
	});

	it('settles the request with the waypoints before the goal', () => {
		const search = new StubSearch();
		search.result = { status: PathStatus.Found, points: [{ x: 48, y: 80 }, { x: 300.5, y: 48 }], iterations: 3 };
		const blocks = mover(16, 48, 300.5, 48);
		requestPath(blocks.navigation);

		createPathfindingUpdate({ search })(createWorld(), 1, blocks, {}, stubCallbacks());

		expect(isPathPending(blocks.navigation)).toBe(false);
		expect(blocks.navigation[NAVIGATION_RESULT_INDEX]).toBe(2);
		expect(blocks.navigation[NAVIGATION_OUTCOME_INDEX]).toBe(PathStatus.Found);
		expect(blocks.navigation[NAVIGATION_WAYPOINT_COUNT_INDEX]).toBe(1);
		expect(waypoint(blocks.navigation, 0)).toEqual({ x: 48, y: 80 });
	});

	it('keeps every point of a path that does not reach the goal', () => {
		const search = new StubSearch();
		search.result = { status: PathStatus.Unreachable, points: [{ x: 48, y: 80 }, { x: 80, y: 80 }], iterations: 3 };
		const blocks = mover(16, 48, 300, 48);

		createPathfindingUpdate({ search })(createWorld(), 1, blocks, {}, stubCallbacks());

		expect(blocks.navigation[NAVIGATION_WAYPOINT_COUNT_INDEX]).toBe(2);
		expect(blocks.navigation[NAVIGATION_OUTCOME_INDEX]).toBe(PathStatus.Unreachable);
	});

	it('treats an incomplete search that went nowhere as unreachable', () => {
		const search = new StubSearch();
		search.result = { status: PathStatus.Incomplete, points: [], iterations: 50 };
		const blocks = mover(16, 48, 300, 48);

		createPathfindingUpdate({ search })(createWorld(), 1, blocks, {}, stubCallbacks());

		expect(blocks.navigation[NAVIGATION_OUTCOME_INDEX]).toBe(PathStatus.Unreachable);
	});

	it('leaves settled and stopped movers alone', () => {
		const search = new StubSearch();
		const update = createPathfindingUpdate({ search });
		const done = mover(16, 48, 300, 48);
		settle(done.navigation, []);
		const stopped = mover(16, 48, 300, 48);
		stopNavigating(stopped.navigation);

		update(createWorld(), 1, done, {}, stubCallbacks());
		update(createWorld(), 2, stopped, {}, stubCallbacks());

		expect(search.requests).toEqual([]);
		expect(isPathPending(stopped.navigation)).toBe(true);
	});

	describe('search budget', () => {
		it('leaves requests pending once spent, after searching at least once', () => {
			const search = new StubSearch();
			search.result = { ...search.result, iterations: DEFAULT_PATH_SEARCH_ITERATION_BUDGET * 2 };
			const update = createPathfindingUpdate({ search });
			const world = createWorld();
			const first = mover(16, 48, 300, 48);
			const second = mover(16, 48, 300, 48);

			update(world, 1, first, {}, stubCallbacks());
			update(world, 2, second, {}, stubCallbacks());

			expect(search.requests).toHaveLength(1);
			expect(isPathPending(first.navigation)).toBe(false);
			expect(isPathPending(second.navigation)).toBe(true);
		});

		it('keeps searching while under budget, and can be set', () => {
			const search = new StubSearch();
			search.result = { ...search.result, iterations: 10 };
			const update = createPathfindingUpdate({ search, iterationBudget: 25 });
			const world = createWorld();

			[1, 2, 3, 4].forEach(entityId => update(world, entityId, mover(16, 48, 300, 48), {}, stubCallbacks()));

			expect(search.requests).toHaveLength(3);
		});

		it('can be overridden per run from the world', () => {
			const search = new StubSearch();
			search.result = { ...search.result, iterations: 10 };
			const update = createPathfindingUpdate({ search, iterationBudget: 25 });
			const world = { ...createWorld(), iterationBudget: 45 };

			[1, 2, 3, 4, 5, 6].forEach(entityId => update(world, entityId, mover(16, 48, 300, 48), {}, stubCallbacks()));

			expect(search.requests).toHaveLength(5);
		});

		it('is refreshed every run before the game\'s own preRun', () => {
			const preRun = vi.fn<(world: PathfindingWorld) => void>(world => expect(world.searchIterations).toBe(0));
			const update = createPathfindingUpdate({ preRun });
			const world = createWorld();
			world.searchIterations = DEFAULT_PATH_SEARCH_ITERATION_BUDGET;

			update.preRun?.(world, [], {}, stubCallbacks());

			expect(world.searchIterations).toBe(0);
			expect(preRun).toHaveBeenCalledOnce();
		});
	});

	describe('blockers', () => {
		it('marks a blocker\'s tiles when it joins and clears them when it leaves', () => {
			const world = createWorld();
			pathfindingUpdate.queryChanged?.(world, PATH_BLOCKERS_QUERY, { added: [onTile(7, 3, 4)], removed: [] }, stubCallbacks());

			expect(world.navigation.grid.isBlocked(3, 4)).toBe(true);
			expect(world.blockersAdded).toBe(true);

			const next = { ...createWorld(), navigation: world.navigation };
			pathfindingUpdate.queryChanged?.(next, PATH_BLOCKERS_QUERY, { added: [], removed: [7] }, stubCallbacks());

			expect(world.navigation.grid.isBlocked(3, 4)).toBe(false);
			expect(next.blockersAdded).toBe(false);
		});

		it('passes every query change on to the game\'s hook', () => {
			const queryChanged = vi.fn<() => void>();
			const update = createPathfindingUpdate({ queryChanged });
			const world = createWorld();
			const delta = { added: [onTile(7, 3, 4)], removed: [] };

			update.queryChanged?.(world, 'terrain', delta, stubCallbacks());

			expect(world.navigation.grid.isBlocked(3, 4)).toBe(false);
			expect(queryChanged).toHaveBeenCalledWith(world, 'terrain', delta, expect.anything());
		});

		it('searches again for a mover whose path a new blocker now crosses', () => {
			const search = new StubSearch();
			const update = createPathfindingUpdate({ search });
			const blocks = mover(16, 48, 400, 48);
			settle(blocks.navigation, [{ x: 200, y: 48 }]);
			const world = createWorld();
			update.queryChanged?.(world, PATH_BLOCKERS_QUERY, { added: [onTile(7, 3, 1)], removed: [] }, stubCallbacks());

			update(world, 1, blocks, {}, stubCallbacks());

			expect(search.requests).toHaveLength(1);
			expect(isPathPending(blocks.navigation)).toBe(false);
		});

		it('keeps a path a new blocker does not touch', () => {
			const search = new StubSearch();
			const update = createPathfindingUpdate({ search });
			const blocks = mover(16, 48, 400, 48);
			settle(blocks.navigation, [{ x: 200, y: 48 }]);
			const world = createWorld();
			update.queryChanged?.(world, PATH_BLOCKERS_QUERY, { added: [onTile(7, 3, 10)], removed: [] }, stubCallbacks());

			update(world, 1, blocks, {}, stubCallbacks());

			expect(search.requests).toEqual([]);
		});

		it('walks a mover out through a blocker it stands inside rather than relocating it past a wall', () => {
			// A wall along row 2 (open at column 9) with beds filling rows 3-4 below it; the mover stands on a bed,
			// touching the wall, nearer open ground beyond the wall than below the beds.
			const world = createWorld(10, 10);
			const wall = Array.from({ length: 9 }, (_, tileX) => onTile(10 + tileX, tileX, 2));
			const beds = [3, 4, 5].map(tileX => ({ entityId: 20 + tileX, components: { transform: transformBlock((tileX + 0.5) * CELL, 4 * CELL, CELL, 2 * CELL), body: bodyBlock() } }));
			pathfindingUpdate.queryChanged?.(world, PATH_BLOCKERS_QUERY, { added: [...wall, ...beds], removed: [] }, stubCallbacks());
			const navigation = navigationBlock();
			navigateTo(navigation, 4.5 * CELL, 8.5 * CELL);
			const blocks = { navigation, transform: transformBlock(4.5 * CELL, 3 * CELL + 14, 28, 28) };

			createPathfindingUpdate({ search: new GridAStar() })(world, 1, blocks, {}, stubCallbacks());

			expect(navigation[NAVIGATION_OUTCOME_INDEX]).toBe(PathStatus.Found);
			expect(Array.from({ length: navigation[NAVIGATION_WAYPOINT_COUNT_INDEX] }, (_, i) => waypoint(navigation, i).y > 3 * CELL)).not.toContain(false);
			expect(world.navigation.grid.isBlocked(4, 3)).toBe(true);
		});
	});

	describe('gates', () => {
		it('stop only movers whose mask takes them in', () => {
			const update = createPathfindingUpdate({ search: new GridAStar(), gateCategories: DOOR });
			const world = gatedWorld();
			const outcomes = [undefined, bodyBlock({ mask: 1 }), bodyBlock({ mask: DOOR | 1 })].map(body => {
				const blocks = mover(48, 80, 8.5 * CELL, 80, body);
				update(world, 1, blocks, {}, stubCallbacks());
				return blocks.navigation[NAVIGATION_OUTCOME_INDEX];
			});

			expect(outcomes).toEqual([PathStatus.Found, PathStatus.Found, PathStatus.Unreachable]);
		});

		it('stop blocking once taken away', () => {
			const update = createPathfindingUpdate({ search: new GridAStar(), gateCategories: DOOR });
			const world = gatedWorld();
			update.queryChanged?.(world, PATH_GATES_QUERY, { added: [], removed: [1] }, stubCallbacks());
			const blocks = mover(48, 80, 8.5 * CELL, 80, bodyBlock({ mask: DOOR }));

			update(world, 1, blocks, {}, stubCallbacks());

			expect(blocks.navigation[NAVIGATION_OUTCOME_INDEX]).toBe(PathStatus.Found);
		});

		it('send a mover whose path a new gate crosses searching again', () => {
			const search = new StubSearch();
			const update = createPathfindingUpdate({ search, gateCategories: DOOR });
			const world = createWorld(20, 20, DOOR);
			const blocks = mover(16, 48, 400, 48, bodyBlock({ mask: DOOR }));
			settle(blocks.navigation, [{ x: 200, y: 48 }]);
			update.queryChanged?.(world, PATH_GATES_QUERY, { added: [onTile(1, 3, 1, DOOR)], removed: [] }, stubCallbacks());

			update(world, 1, blocks, {}, stubCallbacks());

			expect(search.requests).toHaveLength(1);
		});
	});
});
