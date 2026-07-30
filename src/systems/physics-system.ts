import { ComponentSystem } from '@daneren2005/shared-memory-ecs';
import type { BaseWorld, ComponentDefinitionMap, ComponentMap, ComponentSystemWorld, EntityUpdateComponents, EntityUpdateFunction, SystemConfig } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../components/registry';
import physicsUpdate, { type PhysicsUpdateMetadata } from './physics-update';
import { COLLIDABLE_QUERY } from './collision';

export interface PhysicsSystemConfig<
	C extends ComponentMap & PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
> extends Partial<SystemConfig> {
	// Worker entry point that runs the update off the main thread.  Bundlers need the `new Worker(new
	// URL(...))` call to be written out in the game's own source, so the game supplies the file:
	//
	//   // physics.worker.ts
	//   import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
	//   import { physicsUpdate } from '@daneren2005/shared-memory-physics';
	//   createComponentWorker(self, physicsUpdate);
	//
	//   getWorker: () => new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' })
	//
	// Left off, the simulation runs in-process on the main thread instead.
	getWorker?: () => Worker
	// Forces the in-process ComponentWebWorker even when a getWorker is supplied.  Defaults to true when no
	// getWorker was given, since there is then nothing to run the update on.
	forceMainThread?: boolean
	// The update to run, defaulting to plain movement.  A game that wants collision callbacks builds one with
	// createPhysicsUpdate and passes the *same* function its worker file hands to createComponentWorker, so
	// both backends behave identically.  createPhysicsUpdate stamps what it needs onto the function, so
	// `optional` and the collidable query below come across with it and do not have to be repeated here.
	updateFunction?: EntityUpdateFunction<C, T, W> & { physics?: PhysicsUpdateMetadata<C> }
	// Extra components to send along with each entity's transform and velocity, for an update function built
	// by hand rather than through createPhysicsUpdate.  Overrides what the update function declared.
	optional?: Array<keyof C & string>
	// Whether to gather the collidable query - every entity with a transform, whether it moves or not - and
	// send it along for the update's collision detection.  Defaults to whatever the update function declared,
	// so it is on exactly when a createPhysicsUpdate was given an onCollision.
	collision?: boolean
}

// Moves every entity that has both a transform and a velocity, and (when the update function detects
// collisions) reports the entities that overlap to the game's callback.  Generic over `C`, the game's full
// component map, so a game's own world passes straight in; over `T`, the blocks its update function touches,
// which is wider than transform + velocity once a game adds `optional` components of its own; and over `W`,
// the per-run data object, for a game that subclasses this to add more through `addDataToWorld`.
export default class PhysicsSystem<
	C extends ComponentMap & PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C> = PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
> extends ComponentSystem<C, T, W> {
	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: PhysicsSystemConfig<C, T, W> = {}) {
		const updateFunction: EntityUpdateFunction<C, T, W> & { physics?: PhysicsUpdateMetadata<C> } = options.updateFunction ?? physicsUpdate;
		const optional = options.optional ?? updateFunction.physics?.optional ?? [];
		const collision = options.collision ?? updateFunction.physics?.collision ?? false;
		// An entity reads its own collide category and mask before it searches, so the body block has to travel
		// with the entities this system moves as well as with the ones they can run into - but only when there is
		// collision detection to read it, since otherwise it is a block per moving entity for nothing.
		const movingOptional = collision && !optional.includes('body') ? ['body' as keyof C & string, ...optional] : optional;

		super(world, {
			name: options.name ?? 'PhysicsSystem',
			deltaBetweenRuns: options.deltaBetweenRuns,
			firstRun: options.firstRun,

			// Movement needs both, so an entity with only one of them is not in the system at all - though it can
			// still be collided with through the query below.
			required: ['transform', 'velocity'],
			optional: movingOptional,
			updateFunction,
			// Collision is between anything with a transform and a body, not only the entities this system moves,
			// so that a ship can hit a station that has no velocity of its own.  It is only gathered when something
			// is actually going to look at it, since it means shipping a block for every entity in the world.
			queries: collision ? {
				[COLLIDABLE_QUERY]: {
					required: ['transform', 'body'],
					optional: ['velocity', ...optional],
				},
			} : undefined,

			forceMainThread: options.forceMainThread ?? !options.getWorker,
			// Only ever reached when a getWorker was supplied: without one forceMainThread defaults to true, so
			// the base class never asks for a worker.
			getWorker: options.getWorker ?? (() => {
				throw new Error('PhysicsSystem cannot start a worker: no getWorker was supplied');
			}),
		});
	}
}
