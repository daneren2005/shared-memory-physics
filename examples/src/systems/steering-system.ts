import { ComponentSystem } from '@daneren2005/shared-memory-ecs';
import type { BaseWorld, ComponentDefinitionMap, EntityUpdateComponents, SystemConfig } from '@daneren2005/shared-memory-ecs';
import { DEFAULT_PHYSICS_STEP_MS } from '@daneren2005/shared-memory-physics';
import type { Components } from '../world';
import steeringUpdate from './steering-update';
import type { SteeringBounds, SteeringParams, SteeringUpdateComponents, SteeringWorld } from './steering-update';

export interface SteeringSystemConfig extends Partial<SystemConfig> {
	// The rule weights and speed limits the flock is steered by, held as a live reference rather than copied: a
	// slider beside the canvas writes into this object, and each run sends whatever is in it at that moment across
	// to the worker.  That is what lets the three weights be retuned mid-flight with no rebuild.
	params: SteeringParams
	// The field the flock is turned back from at the edges, which is the level the example laid it out in.
	bounds: SteeringBounds
	// Runs the steering in-process instead of on its own thread, for the page's worker toggle - and for a browser
	// that will not hand out a SharedArrayBuffer, where there is nothing for a worker to share anyway.
	forceMainThread?: boolean
	// Overrides the worker this system starts, which is otherwise ./steering.worker.ts next door.
	getWorker?: () => Worker
}

// Steers every entity that has a transform and a velocity, by writing its velocity and nothing else.
//
// This is the half of the boids example that is *not* physics.  It is an ordinary ComponentSystem - no different
// in kind from the game systems a real project writes - running on its own worker thread, and it stops at the
// velocity: turning that velocity into a position, and publishing the pair a renderer interpolates between, is
// left to a plain PhysicsSystem running the library's own `physicsUpdate`.  The two never talk.  They share the
// component blocks, this one writing velocities and that one reading them, and that is the whole interface
// between them - see ./steering-update.ts for what the split costs and why it is worth it.
export default class SteeringSystem extends ComponentSystem<Components, SteeringUpdateComponents & EntityUpdateComponents<Components>, SteeringWorld> {
	params: SteeringParams;
	bounds: SteeringBounds;

	constructor(world: BaseWorld<ComponentDefinitionMap, Components>, options: SteeringSystemConfig) {
		super(world, {
			name: options.name ?? 'SteeringSystem',
			// The same step physics runs on by default, so the whole simulation moves in one rhythm and a boid gets
			// exactly one steering decision per move.  The page's step slider retunes this alongside physics.
			deltaBetweenRuns: options.deltaBetweenRuns ?? DEFAULT_PHYSICS_STEP_MS,
			firstRun: options.firstRun,

			// Steering reads where a boid is and writes where it is going, so an entity without both is not in the
			// system at all - which is what keeps the level's walls out of it.
			required: ['transform', 'velocity'],
			updateFunction: steeringUpdate,

			forceMainThread: options.forceMainThread ?? false,
			// Written out as a literal here, in the app's own source, because that form is what a bundler needs in
			// order to find the worker entry and build it.
			getWorker: options.getWorker ?? (() => new Worker(new URL('./steering.worker.ts', import.meta.url), { type: 'module' })),
		});

		this.params = options.params;
		this.bounds = options.bounds;
	}

	// Hangs the two things the update cannot work out for itself on the per-run world object, which is the one
	// thing that crosses to the worker every run.  Read back off `world.steering` and `world.bounds` there.
	addDataToWorld(world: SteeringWorld): void {
		world.steering = this.params;
		world.bounds = this.bounds;
	}
}
