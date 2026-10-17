import { SHAPE_CIRCLE } from '../../components/body-component-constants';
import { BODY_FLAGS_INDEX } from '../../components/body-component-constants';
import { TRANSFORM_ANGLE_INDEX } from '../../components/transform-component-constants';
import {
	applyPathBlockerChanges,
	applyPathGateChanges,
	blockingRects,
	createNavigationState,
	navigationGridFor,
	setNavigationTerrainSpeed,
} from '../navigation-state';
import { applyRectChanges, blockerRect, pathBlockerQueries, PATH_BLOCKERS_QUERY, PATH_GATES_QUERY } from '../path-blockers';
import NavGrid from '../nav-grid';
import { bodyBlock, createNavigationWorld, transformBlock, type NavigationTestComponents } from './pathfinding-fixtures';

const CELL = 32;
const DOOR = 0b10;
const FENCE = 0b100;

function onTile(entityId: number, tileX: number, tileY: number, category = 0) {
	return { entityId, components: { transform: transformBlock((tileX + 0.5) * CELL, (tileY + 0.5) * CELL), body: bodyBlock({ category }) } };
}

describe('blockerRect', () => {
	it('covers a box turned a quarter turn as the box it now fills', () => {
		const transform = transformBlock(50, 50, 40, 20);
		transform[TRANSFORM_ANGLE_INDEX] = Math.PI / 2 + 1e-7;

		expect(blockerRect(transform, bodyBlock())).toEqual({ minX: 40, minY: 30, maxX: 60, maxY: 70 });
	});

	it('covers a circle by its diameter', () => {
		const body = bodyBlock();
		body[BODY_FLAGS_INDEX] = SHAPE_CIRCLE;

		expect(blockerRect(transformBlock(50, 50, 20, 20), body)).toEqual({ minX: 40, minY: 40, maxX: 60, maxY: 60 });
	});
});

describe('applyRectChanges', () => {
	it('marks a blocker\'s tiles on every grid and clears them when it leaves', () => {
		const grids = [new NavGrid(10, 10, CELL), new NavGrid(10, 10, CELL)];
		const rects = new Map();

		expect(applyRectChanges(rects, grids, { added: [onTile(7, 3, 4)], removed: [] })).toBe(true);
		expect(grids.map(grid => grid.isBlocked(3, 4))).toEqual([true, true]);

		expect(applyRectChanges(rects, grids, { added: [], removed: [7] })).toBe(false);
		expect(grids.map(grid => grid.isBlocked(3, 4))).toEqual([false, false]);
		expect(rects.size).toBe(0);
	});

	it('replaces rather than doubles a blocker that is sent again', () => {
		const grid = new NavGrid(10, 10, CELL);
		const rects = new Map();
		applyRectChanges(rects, [grid], { added: [onTile(7, 3, 4)], removed: [] });
		applyRectChanges(rects, [grid], { added: [onTile(7, 3, 4)], removed: [] });

		expect(grid.blockerCount(3, 4)).toBe(1);
	});

	it('ignores a removal it never saw added', () => {
		const grid = new NavGrid(10, 10, CELL);
		const rects = new Map();
		applyRectChanges(rects, [grid], { added: [onTile(7, 3, 4)], removed: [] });
		applyRectChanges(rects, [grid], { added: [], removed: [99] });

		expect(grid.isBlocked(3, 4)).toBe(true);
	});
});

describe('navigation state', () => {
	it('gives movers that collide with no gate the blockers-only grid', () => {
		const state = createNavigationState(10, 10, CELL, DOOR);

		expect(navigationGridFor(state, 0)).toBe(state.grid);
		expect(navigationGridFor(state, FENCE)).toBe(state.grid);
		expect(state.gatedGrids.size).toBe(0);
	});

	it('builds a grid per set of gates a mask takes in, from the blockers and gates already there', () => {
		const state = createNavigationState(10, 10, CELL, DOOR | FENCE);
		applyPathBlockerChanges(state, { added: [onTile(1, 0, 0)], removed: [] });
		applyPathGateChanges(state, { added: [onTile(2, 1, 0, DOOR), onTile(3, 2, 0, FENCE)], removed: [] });

		const doors = navigationGridFor(state, DOOR);
		const both = navigationGridFor(state, DOOR | FENCE);

		expect([0, 1, 2].map(x => state.grid.isBlocked(x, 0))).toEqual([true, false, false]);
		expect([0, 1, 2].map(x => doors.isBlocked(x, 0))).toEqual([true, true, false]);
		expect([0, 1, 2].map(x => both.isBlocked(x, 0))).toEqual([true, true, true]);
		expect(navigationGridFor(state, DOOR | 1)).toBe(doors);
	});

	it('keeps built grids up to date as blockers, gates and terrain change', () => {
		const state = createNavigationState(10, 10, CELL, DOOR);
		const doors = navigationGridFor(state, DOOR);

		applyPathBlockerChanges(state, { added: [onTile(1, 0, 0)], removed: [] });
		applyPathGateChanges(state, { added: [onTile(2, 1, 0, DOOR)], removed: [] });
		setNavigationTerrainSpeed(state, 4, 4, 2);

		expect([doors.isBlocked(0, 0), doors.isBlocked(1, 0), doors.terrainSpeed(4, 4)]).toEqual([true, true, 2]);
		expect(state.grid.terrainSpeed(4, 4)).toBe(2);

		applyPathGateChanges(state, { added: [], removed: [2] });
		expect(doors.isBlocked(1, 0)).toBe(false);
	});

	it('moves a gate that is sent again with a new category', () => {
		const state = createNavigationState(10, 10, CELL, DOOR | FENCE);
		const doors = navigationGridFor(state, DOOR);
		const fences = navigationGridFor(state, FENCE);
		applyPathGateChanges(state, { added: [onTile(2, 1, 0, DOOR)], removed: [] });

		applyPathGateChanges(state, { added: [onTile(2, 1, 0, FENCE)], removed: [] });

		expect([doors.isBlocked(1, 0), fences.isBlocked(1, 0)]).toEqual([false, true]);
	});

	it('lists what blocks a mover: blockers plus the gates its mask takes in', () => {
		const state = createNavigationState(10, 10, CELL, DOOR);
		applyPathBlockerChanges(state, { added: [onTile(1, 0, 0)], removed: [] });
		applyPathGateChanges(state, { added: [onTile(2, 1, 0, DOOR)], removed: [] });

		expect(blockingRects(state, 0)).toHaveLength(1);
		expect(blockingRects(state, DOOR)).toHaveLength(2);
	});
});

describe('pathBlockerQueries', () => {
	it('takes solid bodies flagged blocksPath as blockers and solid gate-category bodies as gates', () => {
		const world = createNavigationWorld();
		const wall = world.loadEntity({ x: 0, y: 0, width: 8, height: 8, blocksPath: true });
		const sensorWall = world.loadEntity({ x: 0, y: 0, width: 8, height: 8, blocksPath: true, sensor: true });
		const door = world.loadEntity({ x: 0, y: 0, width: 8, height: 8, collideCategory: DOOR });
		const crate = world.loadEntity({ x: 0, y: 0, width: 8, height: 8 });
		const queries = pathBlockerQueries<NavigationTestComponents>({ gateCategories: DOOR });
		const blockers = queries[PATH_BLOCKERS_QUERY].filter;
		const gates = queries[PATH_GATES_QUERY].filter;

		expect([wall, sensorWall, door, crate].map(entity => blockers?.(entity))).toEqual([true, false, false, false]);
		expect([wall, sensorWall, door, crate].map(entity => gates?.(entity))).toEqual([false, false, true, false]);
	});

	it('narrows both queries by the game\'s own rules and leaves out gates when there are none', () => {
		const world = createNavigationWorld();
		const wall = world.loadEntity({ x: 0, y: 0, width: 8, height: 8, blocksPath: true });
		const queries = pathBlockerQueries<NavigationTestComponents>({ not: ['velocity'], filter: () => false });

		expect(queries[PATH_GATES_QUERY]).toBeUndefined();
		expect(queries[PATH_BLOCKERS_QUERY].not).toEqual(['velocity']);
		expect(queries[PATH_BLOCKERS_QUERY].filter?.(wall)).toBe(false);
	});
});
