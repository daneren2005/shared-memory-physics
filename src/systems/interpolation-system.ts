import { ComponentSystem } from '@daneren2005/shared-memory-ecs';
import type { BaseWorld, ComponentDefinitionMap, ComponentMap, EntityUpdateComponents, SystemConfig } from '@daneren2005/shared-memory-ecs';
import type { InterpolationComponents, InterpolationUpdateComponents } from '../components/registry';
import interpolationUpdate from './interpolation-update';

export interface InterpolationSystemConfig extends Partial<SystemConfig> {
	// As on PhysicsSystem, and defaulted the other way round: this runs on the main thread unless a game asks
	// otherwise, since a render position read one frame after it was computed is a render position one frame
	// stale, which is the latency this system exists to keep down.
	forceMainThread?: boolean
	getWorker?: () => Worker
}

// Fills in a render position for every entity with an `interpolation` component, once per frame, by blending
// between the two positions physics published either side of its last step.
//
// **It is not wired to the physics system at all**, and that is deliberate rather than convenient. Everything it
// needs - the two positions, how much simulated time lies between them, and whether that pair is new - is in the
// block, published by whichever run wrote it. Pacing off the physics system instead would mean pacing off when a
// run was *posted*, and on a worker thread that is not when its results arrive; see interpolation-update.ts for
// what that costs.
//
// So it takes no configuration, and it follows a step the game retunes mid-flight with nothing told to it:
//
//   world.addSystem(new PhysicsSystem(world, { getWorker }));
//   world.addSystem(new InterpolationSystem(world));
//
// Ordering against the physics system is a preference rather than a requirement - going after it means a step
// is picked up on the frame it happened rather than the one after, which is one frame of latency and nothing
// else. Pause and `timeScale` need no code either: `BaseWorld#runUpdate` skips every system while paused and
// scales the elapsed time it hands them, so the pacing stops and slows with the simulation for free.
export default class InterpolationSystem<
	C extends ComponentMap & InterpolationComponents,
> extends ComponentSystem<C, InterpolationUpdateComponents & EntityUpdateComponents<C>> {
	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: InterpolationSystemConfig = {}) {
		super(world, {
			name: options.name ?? 'InterpolationSystem',
			// Every frame, which is the entire point of it.
			deltaBetweenRuns: 0,
			firstRun: options.firstRun,

			// A velocity is never read - the blend is between two positions the simulation already produced - so
			// something with no velocity of its own is in this system on exactly the same terms as a ship, and gets
			// a render position that tracks its transform.
			required: ['transform', 'interpolation'],
			updateFunction: interpolationUpdate,

			forceMainThread: options.forceMainThread ?? !options.getWorker,
			getWorker: options.getWorker ?? (() => {
				throw new Error('InterpolationSystem cannot start a worker: no getWorker was supplied');
			}),
		});
	}
}
