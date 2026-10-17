import { loadFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import type {
	ComponentMap,
	EntityQueryChangedFunction,
	EntityQueryComponents,
	EntityUpdateComponents,
	EntityUpdateFunction,
	EntityUpdatePreRunFunction,
	EntityWorkerSystemWorld,
} from '@daneren2005/shared-memory-ecs';
import { BODY_MASK_INDEX } from '../components/body-component-constants';
import {
	NAVIGATION_ACTIVE_INDEX,
	NAVIGATION_GOAL_X_INDEX,
	NAVIGATION_GOAL_Y_INDEX,
	NAVIGATION_OUTCOME_INDEX,
	NAVIGATION_REQUEST_INDEX,
	NAVIGATION_RESULT_INDEX,
	NAVIGATION_WAYPOINT_COUNT_INDEX,
	NAVIGATION_WAYPOINT_INDEX,
} from '../components/navigation-component-constants';
import { waypointX, waypointY, writePath } from '../components/navigation-component';
import {
	TRANSFORM_HEIGHT_INDEX,
	TRANSFORM_WIDTH_INDEX,
	TRANSFORM_X_INDEX,
	TRANSFORM_Y_INDEX,
} from '../components/transform-component-constants';
import GridAStar from './grid-a-star';
import { sweepCost } from './line-of-sight';
import type NavGrid from './nav-grid';
import type { Rect } from './nav-grid';
import {
	applyPathBlockerChanges,
	applyPathGateChanges,
	blockingRects,
	createNavigationState,
	navigationGridFor,
	type NavigationState,
} from './navigation-state';
import { PATH_BLOCKERS_QUERY, PATH_GATES_QUERY } from './path-blockers';
import { PathStatus, type PathRequest, type PathSearch } from './path-search';

// A* tiles expanded per run before the rest stay pending for the next. Counted in work rather than wall-clock time so
// a simulation plays out the same however loaded the machine is. The first search of a run always goes ahead.
export const DEFAULT_PATH_SEARCH_ITERATION_BUDGET = 16_000;

export type PathfindingUpdateComponents = {
	navigation: Int32Array
	transform: Float32Array
	// Movers whose mask takes in a gate category path around those gates.
	body?: Uint32Array
};

export interface PathfindingInitData {
	tilesWide: number
	tilesHigh: number
	cellSize: number
}

export interface PathfindingWorld extends EntityWorkerSystemWorld {
	navigation: NavigationState
	// Per run: set when a blocker was added, so paths already handed out are rechecked.
	blockersAdded?: boolean
	searchIterations?: number
	// Overrides the update's iterationBudget for this run; PathfindingSystem sets it from its own `iterationBudget`.
	iterationBudget?: number
}

export interface PathfindingUpdateOptions<
	C extends ComponentMap,
	T extends PathfindingUpdateComponents & EntityUpdateComponents<C>,
	W extends PathfindingWorld,
	D extends PathfindingInitData,
> {
	// Defaults to 8-way GridAStar.
	search?: PathSearch
	iterationBudget?: number
	// Collide categories that stop only movers whose mask takes them in, such as a door animals cannot open.
	gateCategories?: number
	// Runs once the grids are built from what was loaded; what it returns joins the world. Feed terrain speeds in here
	// with setNavigationTerrainSpeed.
	init?: (navigation: NavigationState, data: D | undefined, queries: EntityQueryComponents<C>) => Partial<W> | void
	// Handed every query change after the update's own, for the game's extra queries.
	queryChanged?: EntityQueryChangedFunction<C, W>
	preRun?: EntityUpdatePreRunFunction<C, T, W>
}

// Read by PathfindingSystem on the main thread to build matching gate queries.
export interface PathfindingUpdateMetadata {
	gateCategories: number
}

export type PathfindingUpdateFunction<
	C extends ComponentMap,
	T extends PathfindingUpdateComponents & EntityUpdateComponents<C>,
	W extends PathfindingWorld,
	D extends PathfindingInitData,
> = EntityUpdateFunction<C, T, W, D> & { pathfinding: PathfindingUpdateMetadata };

// Builds the update both backends run: the worker file hands it to createEntitySystemWorker and PathfindingSystem takes
// the same function as its `updateFunction`. Hooks are baked in because functions do not survive postMessage.
export function createPathfindingUpdate<
	C extends ComponentMap = ComponentMap,
	T extends PathfindingUpdateComponents & EntityUpdateComponents<C> = PathfindingUpdateComponents & EntityUpdateComponents<C>,
	W extends PathfindingWorld = PathfindingWorld,
	D extends PathfindingInitData = PathfindingInitData,
>(options: PathfindingUpdateOptions<C, T, W, D> = {}): PathfindingUpdateFunction<C, T, W, D> {
	const search = options.search ?? new GridAStar({ diagonal: true });
	const budget = options.iterationBudget ?? DEFAULT_PATH_SEARCH_ITERATION_BUDGET;
	const gateCategories = options.gateCategories ?? 0;

	const update: EntityUpdateFunction<C, T, W, D> = (world, entityId, components) => {
		const { navigation, transform, body } = components;
		if(!navigation[NAVIGATION_ACTIVE_INDEX]) {
			return;
		}
		const mask = body ? body[BODY_MASK_INDEX] : 0;
		const grid = navigationGridFor(world.navigation, mask);

		let requestId = Atomics.load(navigation, NAVIGATION_REQUEST_INDEX);
		if(requestId === Atomics.load(navigation, NAVIGATION_RESULT_INDEX)) {
			if(!world.blockersAdded || isPathClear(grid, navigation, transform)) {
				return;
			}
			requestId = Atomics.add(navigation, NAVIGATION_REQUEST_INDEX, 1) + 1;
		}
		if((world.searchIterations ?? 0) >= (world.iterationBudget ?? budget)) {
			return;
		}

		const request: PathRequest = {
			startX: transform[TRANSFORM_X_INDEX],
			startY: transform[TRANSFORM_Y_INDEX],
			goalX: loadFloat32(navigation, NAVIGATION_GOAL_X_INDEX),
			goalY: loadFloat32(navigation, NAVIGATION_GOAL_Y_INDEX),
			agentWidth: transform[TRANSFORM_WIDTH_INDEX],
			agentHeight: transform[TRANSFORM_HEIGHT_INDEX],
		};
		// Physics lets a mover walk out of a body it is already inside (a bed finished around a sleeper), so that body
		// mustn't count here. Left in, the search would relocate the start to open ground, maybe through a wall.
		const embedded = embeddedRects(world.navigation, grid, mask, request);
		embedded.forEach(rect => grid.removeBlocker(rect));
		const result = search.findPath(grid, request);
		embedded.forEach(rect => grid.addBlocker(rect));
		world.searchIterations = (world.searchIterations ?? 0) + result.iterations;
		// A found path's last point is the goal, which the follower reads off the navigation block instead.
		const points = result.status === PathStatus.Found ? result.points.slice(0, -1) : result.points;
		// Stuck against the same dead end it was already at: searching again would only land here once more.
		const status = result.status === PathStatus.Incomplete && points.length === 0 ? PathStatus.Unreachable : result.status;
		writePath(navigation, status, points);
		Atomics.store(navigation, NAVIGATION_RESULT_INDEX, requestId);
	};

	update.init = (_world, data, _entities, queries) => {
		const navigation = createNavigationState(data?.tilesWide ?? 1, data?.tilesHigh ?? 1, data?.cellSize ?? 1, gateCategories);
		applyPathBlockerChanges(navigation, { added: queries[PATH_BLOCKERS_QUERY] ?? [], removed: [] });
		applyPathGateChanges(navigation, { added: queries[PATH_GATES_QUERY] ?? [], removed: [] });
		const extension = options.init?.(navigation, data, queries);
		// Cast because a W could in theory narrow `navigation`; the update always builds the base NavigationState.
		return { ...extension, navigation } as Partial<W>;
	};

	update.queryChanged = (world, queryName, delta, callbacks) => {
		if(queryName === PATH_BLOCKERS_QUERY) {
			world.blockersAdded = applyPathBlockerChanges(world.navigation, delta) || !!world.blockersAdded;
		} else if(queryName === PATH_GATES_QUERY) {
			world.blockersAdded = applyPathGateChanges(world.navigation, delta) || !!world.blockersAdded;
		}
		options.queryChanged?.(world, queryName, delta, callbacks);
	};

	update.preRun = (world, entities, queries, callbacks) => {
		world.searchIterations = 0;
		options.preRun?.(world, entities, queries, callbacks);
	};

	return Object.assign(update, { pathfinding: { gateCategories } });
}

export const pathfindingUpdate = createPathfindingUpdate();

function embeddedRects(state: NavigationState, grid: NavGrid, mask: number, request: PathRequest): Array<Rect> {
	const halfWidth = request.agentWidth / 2;
	const halfHeight = request.agentHeight / 2;
	const footprint = {
		minX: request.startX - halfWidth, minY: request.startY - halfHeight, maxX: request.startX + halfWidth, maxY: request.startY + halfHeight,
	};
	const tiles = grid.tilesIn(footprint);
	let clear = true;
	for(let y = tiles.fromY; y <= tiles.toY && clear; y++) {
		for(let x = tiles.fromX; x <= tiles.toX && clear; x++) {
			clear = grid.blockerCount(x, y) === 0;
		}
	}
	if(clear) {
		return [];
	}
	return blockingRects(state, mask)
		.filter(rect => rect.minX < footprint.maxX && rect.maxX > footprint.minX && rect.minY < footprint.maxY && rect.maxY > footprint.minY);
}

// Whether the rest of a settled path is still walkable, from where the mover stands.
function isPathClear(grid: NavGrid, navigation: Int32Array, transform: Float32Array): boolean {
	const halfWidth = transform[TRANSFORM_WIDTH_INDEX] / 2;
	const halfHeight = transform[TRANSFORM_HEIGHT_INDEX] / 2;
	let x = transform[TRANSFORM_X_INDEX];
	let y = transform[TRANSFORM_Y_INDEX];
	const count = navigation[NAVIGATION_WAYPOINT_COUNT_INDEX];
	for(let i = navigation[NAVIGATION_WAYPOINT_INDEX]; i <= count; i++) {
		let nextX: number;
		let nextY: number;
		if(i < count) {
			nextX = waypointX(navigation, i);
			nextY = waypointY(navigation, i);
		} else if(navigation[NAVIGATION_OUTCOME_INDEX] === PathStatus.Found) {
			nextX = loadFloat32(navigation, NAVIGATION_GOAL_X_INDEX);
			nextY = loadFloat32(navigation, NAVIGATION_GOAL_Y_INDEX);
		} else {
			break;
		}
		if(!Number.isFinite(sweepCost(grid, x, y, nextX, nextY, halfWidth, halfHeight))) {
			return false;
		}
		x = nextX;
		y = nextY;
	}
	return true;
}
