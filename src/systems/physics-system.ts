import { ComponentSystem } from '@daneren2005/shared-memory-ecs';
import type { BaseEntity, BaseWorld, ComponentDefinitionMap, ComponentMap, ComponentSystemQuery, EntityUpdateComponents, EntityUpdateFunction, SystemConfig } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../components/registry';
import physicsUpdate, { POSITION_UPDATED_EVENT, type PhysicsUpdateMetadata, type PhysicsWorld } from './physics-update';
import { COLLIDABLE_QUERY } from './collision';

// Default physics step, in ms. 20Hz rather than every frame: cheaper for no loss of correctness, only
// smoothness, which InterpolationSystem restores. `deltaBetweenRuns: 0` runs it every frame, which a game with
// very fast entities and no interpolation wants - a longer step is a longer move, and a move longer than an
// obstacle is thick sweeps clean through it.
export const DEFAULT_PHYSICS_STEP_MS = 50;

export interface PhysicsSystemConfig<
	C extends ComponentMap & PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
> extends Partial<SystemConfig> {
	// Worker entry point that runs the update off the main thread. Bundlers need the `new Worker(new URL(...))`
	// call written out in the game's own source, so the game supplies the file:
	//
	//   getWorker: () => new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' })
	//
	// Left off, the simulation runs in-process on the main thread instead.
	getWorker?: () => Worker
	// Forces the in-process worker even with a getWorker. Defaults to true when no getWorker was given.
	forceMainThread?: boolean
	// The update to run, defaulting to plain movement that walks through anything in its way. Build one with
	// createPhysicsUpdate for collisions and pass the same function the worker file hands to createComponentWorker
	// so both backends match; it stamps `optional` and the collidable query on, so they need not be repeated here.
	updateFunction?: EntityUpdateFunction<C, T, W> & { physics?: PhysicsUpdateMetadata<C> }
	// Extra components to send with each moving entity, for an update built by hand. Overrides what the update
	// function declared.
	optional?: Array<keyof C & string>
	// Whether to gather the collidable query for the update's collision detection. Defaults to what the update
	// declared: on for createPhysicsUpdate, off for the bare physicsUpdate.
	collision?: boolean
	// Whether each run reports what moved through POSITION_UPDATED_EVENT. Defaults to whether anything is
	// listening, checked per run. Worth a setting because the worker pays for it - an id per moved entity, cloned
	// back across the boundary - so force it `true` only for a listener this system cannot see.
	reportMoves?: boolean
	// Narrows which entities this system moves to a subset, for spreading one simulation across several workers:
	// give each the same update but a shard filter (`entity => entity.eid % workers === n`). The collidable query
	// and any extra `queries` are gathered whole regardless, so every shard sweeps against the whole world.
	filter?: (entity: BaseEntity<C>) => boolean
	// Extra queries sent to the worker alongside the collidable one, for an update that reads more of the world
	// than the entity it moves (e.g. flocking). Read by name off `queries`, gathered whole regardless of `filter`,
	// and merged with the collidable query rather than replacing it.
	queries?: { [key: string]: ComponentSystemQuery<C> }
}

// Moves every entity with a transform and a velocity, and (when the update detects collisions) reports overlaps
// to the game's callback. Generic over `C` the game's component map, `T` the blocks its update touches, and `W`
// the per-run data object.
export default class PhysicsSystem<
	C extends ComponentMap & PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C> = PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
> extends ComponentSystem<C, T, W> {
	// Bumped per run and stamped onto every interpolated entity so a renderer can tell a blended position from one
	// physics just replaced. Only has to change; a Float32 holds integers to 2^24, over nine days at a 50ms step.
	tick = 0;

	// Undefined means "whenever something is listening", worked out per run by addDataToWorld.
	reportMoves: boolean | undefined;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: PhysicsSystemConfig<C, T, W> = {}) {
		const updateFunction: EntityUpdateFunction<C, T, W> & { physics?: PhysicsUpdateMetadata<C> } = options.updateFunction ?? physicsUpdate;
		const optional = options.optional ?? updateFunction.physics?.optional ?? [];
		const collision = options.collision ?? updateFunction.physics?.collision ?? false;
		// A moving entity reads its own body (collide category/mask) and bounciness before it searches, so both
		// travel with movers too - but only on the collision path, or they are blocks per mover for nothing.
		// Interpolation goes along unconditionally, since the update must publish into it and nothing flags which
		// entities have one. All are free for entities that lack them: the ECS only sends a block it actually holds.
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
		if(collision) {
			extraOptional.push('entity');
		}
		const movingOptional = extraOptional.length ? [...extraOptional, ...optional] : optional;

		// Collision is between anything with a transform and a body, not only movers, so a ship can hit a station.
		// Gathered only when something will read it, since it ships a block per entity in the world. Merged with
		// the game's own `queries`, and neither is narrowed by the shard `filter`.
		// `bounciness` has to be on this side too, not just the movers: a contact is resolved once and turns both
		// sides around by their own bounciness, and the broadphase decides from these blocks whether anything in the
		// run can bounce at all. Left off, hasBounciness is never true and nothing ever bounces.
		const collidableOptional = optional.includes('bounciness') ? optional : ['bounciness', ...optional];
		const collidableQuery = collision ? {
			[COLLIDABLE_QUERY]: {
				required: ['transform', 'body'] as Array<keyof C>,
				optional: ['velocity', 'entity', ...collidableOptional] as Array<keyof C>,
			},
		} : undefined;
		const queries = collidableQuery || options.queries ? { ...collidableQuery, ...options.queries } : undefined;

		super(world, {
			name: options.name ?? 'PhysicsSystem',
			deltaBetweenRuns: options.deltaBetweenRuns ?? DEFAULT_PHYSICS_STEP_MS,
			firstRun: options.firstRun,

			// Movement needs both; an entity with only one is not moved, though it can still be collided with.
			required: ['transform', 'velocity'],
			optional: movingOptional,
			filter: options.filter,
			updateFunction,
			queries,

			forceMainThread: options.forceMainThread ?? !options.getWorker,
			// Only reached when a getWorker was supplied: without one forceMainThread defaults to true.
			getWorker: options.getWorker ?? (() => {
				throw new Error('PhysicsSystem cannot start a worker: no getWorker was supplied');
			}),
		});

		this.reportMoves = options.reportMoves;
	}

	// Stamps the run with its step number and whether to report what moved. A subclass overriding this to attach
	// its own data must call `super.addDataToWorld(world)`, or `tick` stays undefined and every interpolated
	// entity looks to a renderer like it has never had a physics step.
	addDataToWorld(world: W): void {
		world.tick = ++this.tick;
		// Asked per run so a game can attach and drop the listener freely.
		world.reportMoves = this.reportMoves ?? this.listenerCount(POSITION_UPDATED_EVENT) > 0;
	}
}
