import { addAtomicFloat32 } from '@daneren2005/shared-memory-objects';
import type { ComponentMap, ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents, EntityUpdateFunction } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../components/registry';
import { TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import CollisionBroadphase, { COLLIDABLE_QUERY, type CollisionFunction } from './collision';

// What a game asks createPhysicsUpdate for on top of plain movement.
export interface PhysicsUpdateOptions<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
> {
	// Run for each entity that has moved into another one, straight after its own move.
	onCollision?: CollisionFunction<C, T, W>
	// Extra components to hand the update - and so the collision callback - beyond the transform and velocity
	// physics itself needs.  A game that wants to take damage on collision lists its health component here so
	// that block travels to the worker alongside the transform.  They are optional per entity: an entity that
	// does not have one is still moved, and still collides, it just arrives without that block.
	optional?: Array<keyof C & string>
}

// What PhysicsSystem needs to know about an update function to set up the same components and queries the
// function expects.  Stamped on by createPhysicsUpdate so a game declares its collision setup in the one
// module both its worker file and its main thread system import, with no chance of the two drifting apart.
export interface PhysicsUpdateMetadata<C extends ComponentMap> {
	collision: boolean
	optional: Array<keyof C & string>
}

export type PhysicsUpdateFunction<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
> = EntityUpdateFunction<C, T, W> & {
	physics: PhysicsUpdateMetadata<C>
};

// Builds the update function a game runs physics through when it wants collision callbacks as well as
// movement.  The result is a plain EntityUpdateFunction, so it goes to both backends the same way the bare
// physicsUpdate does - handed to createComponentWorker in the game's worker file, and to PhysicsSystem as its
// `updateFunction` for the in-process fallback:
//
//   // game-physics-update.ts - imported by both the worker file and the main thread system
//   export const gamePhysicsUpdate = createPhysicsUpdate<Components, GameUpdateComponents>({
//     optional: ['health'],
//     onCollision(world, a, b, queries, callbacks) { ... },
//   });
//
// A callback cannot be sent to a worker (functions do not survive postMessage), which is why it is baked in
// here rather than passed to PhysicsSystem: the worker file imports this module and gets the callback with it.
export function createPhysicsUpdate<
	C extends ComponentMap = PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C> = PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
>(options: PhysicsUpdateOptions<C, T, W> = {}): PhysicsUpdateFunction<C, T, W> {
	const { onCollision, optional = [] } = options;

	// Built by preRun and read back by each entity update that follows it, which is the whole reason it can be
	// a plain closure variable: a run is one unbroken pass - preRun, then every entity, then done - so there is
	// never a second run part way through this one to overwrite it.
	let broadphase: CollisionBroadphase<T> | undefined;

	const update: PhysicsUpdateFunction<C, T, W> = Object.assign(
		(world: W, entityId: number, components: T, queries: EntityQueryComponents<C>, callbacks: ComponentSystemCallbacks<C>) => {
			move(world.elapsedTime, components.transform, components.velocity);

			if(!onCollision || !broadphase) {
				return;
			}

			// Collisions are checked here, straight after the entity has moved, so a callback acts on where it has
			// actually ended up rather than where it was - and a bounce that flips its velocity is applied by the
			// next run's move.  Only the entity that moved gets the call; whatever it hit gets its own when its
			// turn comes, or never, if it is something the system does not move.
			const self = { entityId, components };
			broadphase.forEachOverlapping(self, other => {
				onCollision(world, self, other, queries, callbacks);
			});
		},
		{
			physics: {
				collision: onCollision !== undefined,
				optional,
			},
		},
	);

	if(onCollision) {
		// preRun is the one hook that sees every entity at once, which makes it the only place the tree can be
		// built from a single consistent moment - before any of this run's movement has happened.
		update.preRun = (world, entities, queries) => {
			broadphase = new CollisionBroadphase<T>(queries[COLLIDABLE_QUERY] ?? [], world.elapsedTime / 1000);
		};
	}

	return update;
}

// Shared update logic used by both ComponentSystem backends: the main-thread ComponentWebWorker runs it
// directly (PhysicsSystem passes it as `updateFunction`), while a game's worker file imports it and hands it
// to createComponentWorker.  Keeping it in one place means both paths run identical logic.
//
// This is movement only.  A game that also wants collision callbacks builds its update with
// createPhysicsUpdate instead, which adds them around this same move.
export const physicsUpdate: EntityUpdateFunction<PhysicsComponents, PhysicsUpdateComponents> = (world, entityId, components) => {
	move(world.elapsedTime, components.transform, components.velocity);
};

// Integrates velocity into position: each run moves the entity by its per-second velocity scaled by how much
// time the run covers.  Because the blocks live in a SharedArrayBuffer, writing them here is immediately
// visible through `entity.components.transform` on the main thread.
//
// The move is applied with addAtomicFloat32 rather than `+=`: the position is shared memory that another
// thread (a game's own system, or a later physics system) may be adding to at the same moment, and a plain
// read-modify-write would silently drop one of the two moves.  Its `max` cap is not wanted here - physics
// does not bound how far something may travel - so it is passed Infinity, leaving a plain atomic add.
//
// No `entityComponentChanged` callback is reported for the move: position changes every run for every moving
// entity, so emitting an event per entity per frame would cost far more than it is worth.  A game that needs
// to react to movement should read the transform rather than listen for it.
function move(elapsedTime: number, transform: Float32Array, velocity: Float32Array): void {
	// elapsedTime is in milliseconds (what BaseWorld#update is driven with), while velocity is in world units
	// per second - so convert before integrating.
	const seconds = elapsedTime / 1000;

	addAtomicFloat32(transform, TRANSFORM_X_INDEX, velocity[VELOCITY_X_INDEX] * seconds, Infinity);
	addAtomicFloat32(transform, TRANSFORM_Y_INDEX, velocity[VELOCITY_Y_INDEX] * seconds, Infinity);
}

export default physicsUpdate;
