import { PathfindingSystem } from '@daneren2005/shared-memory-physics';
import type { BaseWorld, ComponentDefinitionMap } from '@daneren2005/shared-memory-ecs';
import type { Components } from '../world';
import { examplePathfindingUpdate } from './pathfinding-update';
import type { ExamplePathfindingComponents, ExamplePathfindingInitData, ExamplePathfindingWorld, SearchSettings } from './pathfinding-update';
import type { TerrainData } from './terrain';

export interface ExamplePathfindingSystemConfig {
	// Held by reference and sent every run, so the page's toggles take effect on the next search.
	settings: SearchSettings
	terrain: TerrainData
	forceMainThread: boolean
	deltaBetweenRuns: number
	iterationBudget?: number
}

export default class ExamplePathfindingSystem extends PathfindingSystem<Components, ExamplePathfindingComponents, ExamplePathfindingWorld, ExamplePathfindingInitData> {
	settings: SearchSettings;

	constructor(world: BaseWorld<ComponentDefinitionMap, Components>, options: ExamplePathfindingSystemConfig) {
		const { terrain } = options;
		super(world, {
			updateFunction: examplePathfindingUpdate,
			getInitData: () => ({ tilesWide: terrain.tilesWide, tilesHigh: terrain.tilesHigh, cellSize: terrain.cellSize, terrain }),
			getWorker: () => new Worker(new URL('./pathfinding.worker.ts', import.meta.url), { type: 'module' }),
			forceMainThread: options.forceMainThread,
			deltaBetweenRuns: options.deltaBetweenRuns,
			iterationBudget: options.iterationBudget,
		});
		this.settings = options.settings;
	}

	addDataToWorld(world: ExamplePathfindingWorld): void {
		super.addDataToWorld(world);
		world.searchSettings = this.settings;
	}
}
