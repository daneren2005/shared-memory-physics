import { EntityWorkerSystem } from '@daneren2005/shared-memory-ecs';
import type { BaseEntity, BaseWorld, ComponentDefinitionMap, ComponentMap, EntityUpdateComponents, EntityWorkerSystemQuery, SystemConfig } from '@daneren2005/shared-memory-ecs';
import { DEFAULT_PHYSICS_STEP_MS } from '../constants';
import type { NavigationComponents } from '../components/registry';
import { pathBlockerQueries } from './path-blockers';
import {
	createPathfindingUpdate,
	type PathfindingInitData,
	type PathfindingUpdateComponents,
	type PathfindingUpdateFunction,
	type PathfindingWorld,
} from './pathfinding-update';

export interface PathfindingSystemConfig<
	C extends ComponentMap & NavigationComponents,
	T extends PathfindingUpdateComponents & EntityUpdateComponents<C>,
	W extends PathfindingWorld,
	D extends PathfindingInitData,
> extends Partial<SystemConfig> {
	// The grid's size, read when the system loads (so after a save's bounds are applied).
	getInitData: () => D
	// Worker entry point, written out in the game's own source so bundlers see it:
	//
	//   getWorker: () => new Worker(new URL('./pathfinding.worker.ts', import.meta.url), { type: 'module' })
	//
	// Left off, searches run in-process on the main thread instead.
	getWorker?: () => Worker
	forceMainThread?: boolean
	// Built with createPathfindingUpdate; the worker file must hand createEntitySystemWorker the same function.
	updateFunction?: PathfindingUpdateFunction<C, T, W, D>
	// Narrows what counts as a blocker or gate, e.g. `not: ['construction']`. Other systems reading the same view can
	// build these queries with pathBlockerQueries.
	blockers?: {
		not?: Array<keyof C>
		filter?: (entity: BaseEntity<C>) => boolean
	}
	// Extra queries for the update's hooks, such as terrain to feed setNavigationTerrainSpeed.
	queries?: { [key: string]: EntityWorkerSystemQuery<C> }
	// Extra components sent with each mover.
	optional?: Array<keyof C & string>
	// A* tiles expanded per run, overriding the update's own budget. Also a live field on the system.
	iterationBudget?: number
}

// Finds paths for movers whose navigation request is pending, against grids its update keeps from the blocker queries.
export default class PathfindingSystem<
	C extends ComponentMap & NavigationComponents,
	T extends PathfindingUpdateComponents & EntityUpdateComponents<C> = PathfindingUpdateComponents & EntityUpdateComponents<C>,
	W extends PathfindingWorld = PathfindingWorld,
	D extends PathfindingInitData = PathfindingInitData,
> extends EntityWorkerSystem<C, T, W, D> {
	// Sent with every run, so a change takes effect on the next one. Undefined leaves the update's own budget.
	iterationBudget: number | undefined;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: PathfindingSystemConfig<C, T, W, D>) {
		const updateFunction: PathfindingUpdateFunction<C, T, W, D> = options.updateFunction ?? createPathfindingUpdate<C, T, W, D>();
		const optional = options.optional ?? [];
		super(world, {
			name: options.name ?? 'PathfindingSystem',
			deltaBetweenRuns: options.deltaBetweenRuns ?? DEFAULT_PHYSICS_STEP_MS,
			firstRun: options.firstRun,
			required: ['navigation', 'transform'],
			optional: optional.includes('body') ? optional : ['body', ...optional],
			queries: {
				...pathBlockerQueries<C>({ ...options.blockers, gateCategories: updateFunction.pathfinding.gateCategories }),
				...options.queries,
			},
			updateFunction,
			getInitData: options.getInitData,
			forceMainThread: options.forceMainThread ?? !options.getWorker,
			getWorker: options.getWorker ?? (() => {
				throw new Error('PathfindingSystem cannot start a worker: no getWorker was supplied');
			}),
		});
		this.iterationBudget = options.iterationBudget;
	}

	// A subclass overriding this must call super.addDataToWorld(world), or the budget stops reaching the update.
	addDataToWorld(world: W): void {
		world.iterationBudget = this.iterationBudget;
	}

	private loaded = false;

	// The update builds its grids in its `init` hook, which the ECS only calls from `world.load`. A world filled with
	// loadEntity and then init()ed never loads, so load here; it consumes the pending deltas, so nothing is added twice.
	async init(): Promise<void> {
		await super.init();
		if(!this.loaded) {
			await this.finishLoading();
		}
	}

	finishLoading(): Promise<void> {
		this.loaded = true;
		return super.finishLoading();
	}
}
