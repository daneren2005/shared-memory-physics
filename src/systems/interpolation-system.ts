import { EntityWorkerSystem } from '@daneren2005/shared-memory-ecs';
import type { BaseWorld, ComponentDefinitionMap, ComponentMap, EntityUpdateComponents, SystemConfig } from '@daneren2005/shared-memory-ecs';
import type { InterpolationComponents, InterpolationUpdateComponents } from '../components/registry';
import { interpolationUpdate, type InterpolationWorld } from './interpolation-update';
import { snapshotCommittedTicks } from './interpolation-channels';

export interface InterpolationSystemConfig extends Partial<SystemConfig> {
	// Defaulted the opposite way to PhysicsSystem - main thread unless asked otherwise - since a render position
	// read a frame after it was computed is a frame stale, the latency this system exists to cut.
	forceMainThread?: boolean
	getWorker?: () => Worker
}

// Fills in a render position for every entity with an `interpolation` component, once per frame, by blending
// between the two positions physics published either side of its last step.
//
// Its only link to PhysicsSystem is a per-run snapshot of each system's committed tick (interpolation-channels.ts);
// everything else it needs is in the block, published by whichever run wrote it. Pacing off the physics system would pace off when a run was posted, which on a worker
// is not when its results arrive; see interpolation-update.ts. So it takes no configuration and follows a step
// the game retunes mid-flight. Ordering after the physics system is a preference worth one frame of latency;
// pause and `timeScale` need no code, since BaseWorld#runUpdate already skips and scales for free.
export default class InterpolationSystem<
	C extends ComponentMap & InterpolationComponents,
> extends EntityWorkerSystem<C, InterpolationUpdateComponents & EntityUpdateComponents<C>, InterpolationWorld> {
	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: InterpolationSystemConfig = {}) {
		super(world, {
			name: options.name ?? 'InterpolationSystem',
			// Every frame, which is the whole point.
			deltaBetweenRuns: 0,
			firstRun: options.firstRun,

			// No velocity is read - the blend is between two positions the simulation produced - so a velocity-less
			// entity is in this system on the same terms as a ship.
			required: ['transform', 'interpolation'],
			updateFunction: interpolationUpdate,

			forceMainThread: options.forceMainThread ?? !options.getWorker,
			getWorker: options.getWorker ?? (() => {
				throw new Error('InterpolationSystem cannot start a worker: no getWorker was supplied');
			}),
		});
	}

	// One snapshot per run, so a physics run that commits mid-pass cannot split entities across two steps.
	addDataToWorld(world: InterpolationWorld): void {
		world.committedTicks = snapshotCommittedTicks(this.world);
	}
}
