import { PATH_BLOCKERS_QUERY, PATH_GATES_QUERY } from '../path-blockers';
import { PathStatus } from '../path-search';
import PathfindingSystem from '../pathfinding-system';
import { createPathfindingUpdate } from '../pathfinding-update';
import { createNavigationWorld } from './pathfinding-fixtures';

const CELL = 10;
const DOOR = 0b10;

describe('PathfindingSystem', () => {
	it('runs in-process without a worker and finds a way around a wall it was loaded with', async () => {
		const world = createNavigationWorld();
		const system = new PathfindingSystem(world, { getInitData: () => ({ tilesWide: 10, tilesHigh: 10, cellSize: CELL }) });
		world.addSystem(system);
		// A wall down column 5, open at the bottom row.
		for(let tileY = 0; tileY < 9; tileY++) {
			world.loadEntity({ x: 5.5 * CELL, y: (tileY + 0.5) * CELL, width: CELL, height: CELL, blocksPath: true });
		}
		const mover = world.loadEntity({ x: 1.5 * CELL, y: 1.5 * CELL, width: 8, height: 8, navigate: true, collideMask: 0 });
		mover.components.navigation?.navigateTo(8.5 * CELL, 1.5 * CELL);
		await system.finishLoading();

		system.run(50);

		const navigation = mover.components.navigation;
		expect(system.isWorkerThread).toBe(false);
		expect(navigation?.pending).toBe(false);
		expect(navigation?.outcome).toBe(PathStatus.Found);
		expect(navigation?.waypoints.some(point => point.y > 9 * CELL)).toBe(true);
		system.destroy();
	});

	it('builds its grids for a world that is init()ed without ever being loaded', async () => {
		const world = createNavigationWorld();
		const system = new PathfindingSystem(world, { getInitData: () => ({ tilesWide: 10, tilesHigh: 10, cellSize: CELL }) });
		world.addSystem(system);
		for(let tileY = 0; tileY < 9; tileY++) {
			world.loadEntity({ x: 5.5 * CELL, y: (tileY + 0.5) * CELL, width: CELL, height: CELL, blocksPath: true });
		}
		const mover = world.loadEntity({ x: 1.5 * CELL, y: 1.5 * CELL, width: 8, height: 8, navigate: true, collideMask: 0 });
		mover.components.navigation?.navigateTo(8.5 * CELL, 1.5 * CELL);
		await world.init();

		system.run(50);

		const navigation = mover.components.navigation;
		expect(navigation?.outcome).toBe(PathStatus.Found);
		expect(navigation?.waypoints.some(point => point.y > 9 * CELL)).toBe(true);
		system.destroy();
	});

	it('sends its iteration budget with every run, so it can be changed live', async () => {
		const world = createNavigationWorld();
		const search = { findPath: () => ({ status: PathStatus.Found, points: [], iterations: 10 }) };
		const updateFunction = createPathfindingUpdate({ search, iterationBudget: 1000 });
		const system = new PathfindingSystem(world, { getInitData: () => ({ tilesWide: 10, tilesHigh: 10, cellSize: CELL }), updateFunction, iterationBudget: 15 });
		world.addSystem(system);
		const movers = Array.from({ length: 4 }, () => world.loadEntity({ x: 5, y: 5, width: 8, height: 8, navigate: true }));
		movers.forEach(mover => mover.components.navigation?.navigateTo(85, 85));
		await world.init();
		const pending = () => movers.filter(mover => mover.components.navigation?.pending).length;

		system.run(50);
		expect(pending()).toBe(2);

		system.iterationBudget = undefined;
		system.run(50);
		expect(pending()).toBe(0);
		system.destroy();
	});

	it('gathers only movers with a navigation component', () => {
		const world = createNavigationWorld();
		const system = new PathfindingSystem(world, { getInitData: () => ({ tilesWide: 10, tilesHigh: 10, cellSize: CELL }) });
		world.addSystem(system);
		const mover = world.loadEntity({ x: 0, y: 0, width: 8, height: 8, navigate: true });
		const crate = world.loadEntity({ x: 0, y: 0, width: 8, height: 8 });

		expect(system.isEntityInSystem(mover)).toBe(true);
		expect(system.isEntityInSystem(crate)).toBe(false);
		system.destroy();
	});

	it('builds its gate query from the update\'s gate categories and follows gates added after loading', async () => {
		const world = createNavigationWorld();
		const updateFunction = createPathfindingUpdate({ gateCategories: DOOR });
		const system = new PathfindingSystem(world, { getInitData: () => ({ tilesWide: 10, tilesHigh: 10, cellSize: CELL }), updateFunction });
		world.addSystem(system);
		await system.finishLoading();
		world.loadEntity({ x: 5, y: 5, width: CELL, height: CELL, collideCategory: DOOR });
		const mover = world.loadEntity({ x: 25, y: 5, width: 8, height: 8, navigate: true, collideMask: DOOR });
		const navigation = mover.components.navigation;
		navigation?.navigateTo(5, 5);

		system.run(50);

		expect(navigation?.pending).toBe(false);
		expect(navigation?.outcome).toBe(PathStatus.Unreachable);
		system.destroy();
	});

	it('leaves gates out when the update has none', () => {
		const world = createNavigationWorld();
		const system = new PathfindingSystem(world, { getInitData: () => ({ tilesWide: 10, tilesHigh: 10, cellSize: CELL }) });

		expect(Object.keys(system.options.queries ?? {})).toEqual([PATH_BLOCKERS_QUERY]);
		expect(Object.keys(system.options.queries ?? {})).not.toContain(PATH_GATES_QUERY);
		system.destroy();
	});
});
