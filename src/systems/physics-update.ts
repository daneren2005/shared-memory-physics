import { addAtomicFloat32 } from '@daneren2005/shared-memory-objects';
import type { ComponentMap, ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents, EntityUpdateFunction } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../components/registry';
import { TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import CollisionBroadphase, { COLLIDABLE_QUERY, type CollisionEntity, type CollisionFunction, type MovingEntity } from './collision';

// The event a move is reported through, emitted on the entity itself on the main thread once the run that
// moved it completes:
//
//   entity.on(POSITION_UPDATED_EVENT, (x: number, y: number) => { ... });
//
// It is deliberately not the ECS's own `component-property-updated`: that one is a property at a time, so a
// diagonal move costs two events across the worker boundary - and every listener keyed off position pays for
// every other property change on the way past.
export const POSITION_UPDATED_EVENT = 'position-updated';

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
	// Constrained to a map that has the physics components in it rather than to any map at all, because the
	// blocks the update works on - `T` below - are the game's own components narrowed to the transform and
	// velocity it moves, so the map has to be able to see those two in there.  Every game already spreads
	// physicsRegistry into its own, which is the same requirement PhysicsSystem makes.
	C extends ComponentMap & PhysicsComponents = PhysicsComponents,
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
			const self: MovingEntity<T> = { entityId, components };
			const seconds = world.elapsedTime / 1000;
			let moveX = components.velocity[VELOCITY_X_INDEX] * seconds;
			let moveY = components.velocity[VELOCITY_Y_INDEX] * seconds;

			// Where the entity may actually get to is worked out here, off the blocks rather than in them: the
			// position is only written once the answer is known, so an entity is never inside another one - not
			// even for the moment it would take to push it back out.
			let blocking: Array<CollisionEntity<T>> | undefined;
			if(broadphase) {
				const sweep = broadphase.sweep(self, moveX, moveY);
				moveX *= sweep.fraction;
				moveY *= sweep.fraction;
				blocking = sweep.blocking;
			}

			move(entityId, components.transform, moveX, moveY, callbacks);

			if(!onCollision || !broadphase) {
				return;
			}

			// Collisions are reported here, straight after the entity has been put down, so a callback acts on
			// where it has actually ended up rather than where it was - and a bounce that flips its velocity is
			// applied by the next run's move.  Only the entity that moved gets the call; whatever it hit gets its
			// own when its turn comes, or never, if it is something the system does not move.
			broadphase.forEachOverlapping(self, other => {
				onCollision(world, self, other, queries, callbacks);
			});

			// Then whatever the move was stopped *against*, which the overlap check above cannot find by design:
			// the entity was put down touching it rather than through it.  The two lists never share an entry, so
			// nothing here has already had its callback.
			if(blocking) {
				for(const other of blocking) {
					onCollision(world, self, other, queries, callbacks);
				}
			}
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
export const physicsUpdate: EntityUpdateFunction<PhysicsComponents, PhysicsUpdateComponents> = (world, entityId, components, queries, callbacks) => {
	// elapsedTime is in milliseconds (what BaseWorld#update is driven with), while velocity is in world units
	// per second - so convert before integrating.
	const seconds = world.elapsedTime / 1000;

	move(
		entityId,
		components.transform,
		components.velocity[VELOCITY_X_INDEX] * seconds,
		components.velocity[VELOCITY_Y_INDEX] * seconds,
		callbacks,
	);
};

// Applies a move that has already been decided on - by the integration above, or by what a sweep allowed of it -
// and reports where the entity ended up.  Because the blocks live in a SharedArrayBuffer, writing them here is
// immediately visible through `entity.components.transform` on the main thread.
//
// This is the one place the position is written, and it is only reached once the final position is known: the
// distance is worked out on plain numbers first so that nothing ever reads a transform mid-decision.
//
// The move is applied with addAtomicFloat32 rather than `+=`: the position is shared memory that another
// thread (a game's own system, or a later physics system) may be adding to at the same moment, and a plain
// read-modify-write would silently drop one of the two moves.  Its `max` cap is not wanted here - physics
// does not bound how far something may travel - so it is passed Infinity, leaving a plain atomic add.  It is
// also why the value reported back is read out of the block afterwards rather than being worked out here: with
// another thread adding to the same position, the block is the only thing that knows the total.
//
// A move that did not go anywhere is not reported, which is what keeps a world of still entities quiet - and an
// entity pressed up against something it cannot move past reports nothing at all rather than a change per run.
// An entity that did move reports both axes in the one event, even when only one of them changed: a listener
// keyed off position - a spatial index, a minimap, a sprite - wants the place rather than the axis, and a
// second event to tell it the other half of a diagonal move is one it would only have to put back together.
function move(entityId: number, transform: Float32Array, moveX: number, moveY: number, callbacks: PositionCallbacks): void {
	if(moveX === 0 && moveY === 0) {
		return;
	}

	if(moveX !== 0) {
		addAtomicFloat32(transform, TRANSFORM_X_INDEX, moveX, Infinity);
	}
	if(moveY !== 0) {
		addAtomicFloat32(transform, TRANSFORM_Y_INDEX, moveY, Infinity);
	}

	// Both read back out of the block after every write, so the axis that did not move this run still arrives as
	// where the entity actually is - which is not necessarily where it was, since another thread may have moved
	// it along that axis in the meantime.
	callbacks.emitEntityEvent(entityId, POSITION_UPDATED_EVENT, transform[TRANSFORM_X_INDEX], transform[TRANSFORM_Y_INDEX]);
}

// The one callback move reaches for, narrowed to the event physics emits and the two numbers it carries.
// ComponentSystemCallbacks takes any event with any args, which says nothing about what to listen for or what
// arrives with it - so the positions coming out of the block are handed over through this instead.
interface PositionCallbacks {
	emitEntityEvent(entityId: number, event: typeof POSITION_UPDATED_EVENT, x: number, y: number): void
}

export default physicsUpdate;
