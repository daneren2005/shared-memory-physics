import { EntityWorkerSystem } from '@daneren2005/shared-memory-ecs';
import type { BaseWorld, ComponentDefinitionMap } from '@daneren2005/shared-memory-ecs';
import type { Components } from '../world';
import { pathFollowUpdate } from './path-follow-update';
import type { FollowSettings, PathFollowComponents, PathFollowInitData, PathFollowWorld } from './path-follow-update';
import type { TerrainData } from './terrain';

export interface PathFollowSystemConfig {
	// Held by reference and sent every run, so the speed slider retunes movers already on their way.
	settings: FollowSettings
	terrain: TerrainData
	forceMainThread: boolean
	deltaBetweenRuns: number
}

// Steers navigating movers along the paths PathfindingSystem wrote, by writing their velocity and nothing else.
export default class PathFollowSystem extends EntityWorkerSystem<Components, PathFollowComponents, PathFollowWorld, PathFollowInitData> {
	settings: FollowSettings;

	constructor(world: BaseWorld<ComponentDefinitionMap, Components>, options: PathFollowSystemConfig) {
		const { terrain } = options;
		super(world, {
			name: 'PathFollowSystem',
			deltaBetweenRuns: options.deltaBetweenRuns,
			required: ['navigation', 'transform', 'velocity'],
			updateFunction: pathFollowUpdate,
			getInitData: () => ({ terrain }),
			forceMainThread: options.forceMainThread,
			getWorker: () => new Worker(new URL('./path-follow.worker.ts', import.meta.url), { type: 'module' }),
		});
		this.settings = options.settings;
	}

	addDataToWorld(world: PathFollowWorld): void {
		world.follow = this.settings;
	}
}
