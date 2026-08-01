import { ComponentSystem } from '@daneren2005/shared-memory-ecs';
import type { BaseWorld, ComponentDefinitionMap, ComponentMap, EntityUpdateComponents, EntityUpdateFunction, SystemConfig } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../components/registry';
import physicsUpdate, { POSITION_UPDATED_EVENT, type PhysicsUpdateMetadata, type PhysicsWorld } from './physics-update';
import { COLLIDABLE_QUERY } from './collision';

// How long a physics step covers when a game does not say, in the milliseconds `BaseWorld#update` is driven
// with.  20Hz rather than a frame: collision is by a distance the whole of it, and running it three times less
// often is three times less of the frame spent on it, for a simulation that is no less correct - only coarser.
// What it costs is smoothness, and that is what InterpolationSystem is for.
//
// `deltaBetweenRuns: 0` puts it back on every frame, which is what a game with very fast entities and no
// interpolation wants: a move is swept where it *ends*, so a longer step is a longer move, and a move longer
// than the thing in its way is thick goes clean through it.
export const DEFAULT_PHYSICS_STEP_MS = 50;

export interface PhysicsSystemConfig<
	C extends ComponentMap & PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
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
	// The update to run, defaulting to plain movement that walks through anything in its way.  A game that
	// wants its entities stopped by each other builds one with createPhysicsUpdate and passes the *same*
	// function its worker file hands to createComponentWorker, so both backends behave identically.
	// createPhysicsUpdate stamps what it needs onto the function, so `optional` and the collidable query below
	// come across with it and do not have to be repeated here.
	updateFunction?: EntityUpdateFunction<C, T, W> & { physics?: PhysicsUpdateMetadata<C> }
	// Extra components to send along with each entity's transform and velocity, for an update function built
	// by hand rather than through createPhysicsUpdate.  Overrides what the update function declared.
	optional?: Array<keyof C & string>
	// Whether to gather the collidable query - every entity with a transform, whether it moves or not - and
	// send it along for the update's collision detection.  Defaults to whatever the update function declared,
	// so it is on for any update built by createPhysicsUpdate (which always sweeps, callback or not) and off
	// for the bare physicsUpdate, which is movement that notices nothing.
	collision?: boolean
	// Whether each run reports what moved through POSITION_UPDATED_EVENT.  **Defaults to whether anything is
	// listening**, which is nearly always the right answer and is checked per run, so a game that adds or drops
	// a listener needs to do nothing here.
	//
	// It is worth a setting at all because the bill is paid in the worker: an id per moved entity pushed into
	// the run's event array, and that array structured-cloned back across the boundary.  Nearly every entity
	// moves on nearly every run, so at a few thousand entities that is a few thousand ids a step for a listener
	// that may not exist.  Force it `true` only for a listener attached somewhere this system cannot see.
	reportMoves?: boolean
}

// Moves every entity that has both a transform and a velocity, and (when the update function detects
// collisions) reports the entities that overlap to the game's callback.  Generic over `C`, the game's full
// component map, so a game's own world passes straight in; over `T`, the blocks its update function touches,
// which is wider than transform + velocity once a game adds `optional` components of its own; and over `W`,
// the per-run data object, for a game that subclasses this to add more through `addDataToWorld`.
export default class PhysicsSystem<
	C extends ComponentMap & PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C> = PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
> extends ComponentSystem<C, T, W> {
	// Counted up once per run and stamped onto every interpolated entity, so a renderer can tell a position it
	// has already blended from one physics has just replaced.  Nothing does arithmetic with it, so it only has
	// to change - and a Float32 holds integers exactly to 2^24, which at a 50ms step is over nine days of
	// continuous simulation before it stops incrementing in the block.
	tick = 0;

	// Undefined means "whenever something is listening", which is what addDataToWorld works out per run.
	reportMoves: boolean | undefined;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: PhysicsSystemConfig<C, T, W> = {}) {
		const updateFunction: EntityUpdateFunction<C, T, W> & { physics?: PhysicsUpdateMetadata<C> } = options.updateFunction ?? physicsUpdate;
		const optional = options.optional ?? updateFunction.physics?.optional ?? [];
		const collision = options.collision ?? updateFunction.physics?.collision ?? false;
		// An entity reads its own collide category and mask before it searches, so the body block has to travel
		// with the entities this system moves as well as with the ones they can run into - but only when there is
		// collision detection to read it, since otherwise it is a block per moving entity for nothing.
		//
		// Bounciness rides along on the same condition: it is only ever read for a moving entity that has run into
		// something, which is the collision path, and it turns that entity around off what it hit.  It costs
		// nothing for the entities that do not bounce - the ECS only puts a component in the message when the
		// entity actually holds it - so this only widens what *may* be read, not what every entity carries.
		//
		// The interpolation block goes along unconditionally, because the update has to publish into it for any
		// entity that has one and there is no flag that says which entities those are.  It costs nothing for the
		// ones that do not: the ECS only puts a component in the message when the entity actually holds it.
		const extraOptional: Array<keyof C & string> = [];
		if(collision && !optional.includes('body')) {
			extraOptional.push('body');
		}
		if(collision && !optional.includes('bounciness')) {
			extraOptional.push('bounciness');
		}
		if(!optional.includes('interpolation')) {
			extraOptional.push('interpolation');
		}
		const movingOptional = extraOptional.length ? [...extraOptional, ...optional] : optional;

		super(world, {
			name: options.name ?? 'PhysicsSystem',
			// A fixed step by default rather than every frame - see DEFAULT_PHYSICS_STEP_MS.
			deltaBetweenRuns: options.deltaBetweenRuns ?? DEFAULT_PHYSICS_STEP_MS,
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

		this.reportMoves = options.reportMoves;
	}

	// Stamps the run with its step number, which is what the interpolation block is published under, and says
	// whether this run should bother reporting what moved.
	//
	// A game that subclasses this to attach data of its own **must call `super.addDataToWorld(world)`**: this is
	// an ordinary override, so replacing it without the super call leaves `tick` undefined and every interpolated
	// entity looks to a renderer like it has never had a physics step.
	addDataToWorld(world: W): void {
		world.tick = ++this.tick;
		// Asked per run rather than once at construction, so a game is free to attach and drop the listener
		// whenever it likes.  It costs one property read on a thread that is about to sweep every entity in the
		// world, and it saves the worker building and cloning an id per moved entity when nobody wanted them.
		world.reportMoves = this.reportMoves ?? this.listenerCount(POSITION_UPDATED_EVENT) > 0;
	}
}
