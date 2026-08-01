import { addAtomicFloat32, storeFloat32 } from '@daneren2005/shared-memory-objects';
import type { ComponentMap, ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents, EntityUpdateFunction } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../components/registry';
import {
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_PREV_X_INDEX,
	INTERPOLATION_PREV_Y_INDEX,
	INTERPOLATION_TICK_INDEX,
} from '../components/interpolation-component';
import { TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import CollisionBroadphase, { COLLIDABLE_QUERY, type CollisionFunction, type MovingEntity } from './collision';

// The per-run data object every physics update is handed, which is the base one plus the step counter the
// interpolation component is stamped with.  PhysicsSystem fills `tick` in from `addDataToWorld`, so a game that
// subclasses the system to add data of its own widens this rather than replacing it - and **must call
// `super.addDataToWorld(world)`**, or nothing gets a tick and interpolation stops noticing new steps.
export interface PhysicsWorld extends ComponentSystemWorld {
	// Which physics step this is, counted up once per run.  Only ever compared for equality: it is the
	// publication stamp the interpolation block is read through, not a clock.
	tick: number
	// Whether to report this run's moves through POSITION_UPDATED_EVENT.  Set by PhysicsSystem from whether
	// anything is actually listening, because the cost of the event is paid in the **worker** - an id per moved
	// entity pushed into an array, and that array structured-cloned back across the boundary - long before a
	// listener would have got the chance not to exist.  Undefined means report, so an update driven by hand
	// behaves as it always did.
	reportMoves?: boolean
}

// The event a move is reported through, emitted on the **system** on the main thread once the run that moved
// them completes, carrying the ids of everything that moved in that run:
//
//   physicsSystem.on(POSITION_UPDATED_EVENT, (entityIds: Array<number>) => {
//     for(const eid of entityIds) { ... }
//   });
//
// Nearly every entity a physics system owns moves on nearly every run, which rules out reporting the moves
// one entity at a time: an event object apiece in the worker, cloned across the boundary, then an eid lookup
// and an emit apiece on the main thread costs more, at a few thousand entities, than moving them did.  So a
// run's moves are reported as one array of ids on the system instead - see emitSystemEvent in the ECS.
//
// No position travels with the id.  The transform is a SharedArrayBuffer block, so where the entity ended up
// is already on the main thread the moment the worker writes it; a listener reads it off
// `entity.components.transform` (or straight off the block) rather than being handed a copy of what it has.
export const POSITION_UPDATED_EVENT = 'position-updated';

// What a game asks createPhysicsUpdate for on top of plain movement.
export interface PhysicsUpdateOptions<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
> {
	// Run for each entity that has moved into another one, straight after its own move.  Optional: an update
	// with no callback still sweeps, so leaving it off asks for movement that comes to rest against whatever is
	// in the way and decides nothing about it.
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
	// Whether the update needs the collidable query - everything with a transform and a body, whether it moves
	// or not.  Always true for an update built by createPhysicsUpdate, which always sweeps; the bare
	// physicsUpdate carries no metadata at all and so never asks for it.
	collision: boolean
	optional: Array<keyof C & string>
}

export type PhysicsUpdateFunction<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
> = EntityUpdateFunction<C, T, W> & {
	physics: PhysicsUpdateMetadata<C>
};

// Builds the update function a game runs physics through when it wants its entities to notice each other.
// The result is a plain EntityUpdateFunction, so it goes to both backends the same way the bare physicsUpdate
// does - handed to createComponentWorker in the game's worker file, and to PhysicsSystem as its
// `updateFunction` for the in-process fallback:
//
//   // game-physics-update.ts - imported by both the worker file and the main thread system
//   export const gamePhysicsUpdate = createPhysicsUpdate<Components, GameUpdateComponents>({
//     optional: ['health'],
//     onCollision(world, a, b, queries, callbacks) { ... },
//   });
//
// **Every update built here sweeps**, so an entity always comes to rest against what is in its way rather than
// ending up inside it.  The callback is on top of that and is optional - `createPhysicsUpdate()` with nothing
// at all is movement that stops against things and says nothing about them, which is what a game wants for
// terrain and walls.  Movement that walks straight through everything is the bare physicsUpdate below.
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
	W extends PhysicsWorld = PhysicsWorld,
>(options: PhysicsUpdateOptions<C, T, W> = {}): PhysicsUpdateFunction<C, T, W> {
	const { onCollision, optional = [] } = options;

	// Built by preRun and read back by each entity update that follows it, which is the whole reason it can be
	// a plain closure variable: a run is one unbroken pass - preRun, then every entity, then done - so there is
	// never a second run part way through this one to overwrite it.
	let broadphase: CollisionBroadphase<T> | undefined;

	const update: PhysicsUpdateFunction<C, T, W> = Object.assign(
		(world: W, entityId: number, components: T, queries: EntityQueryComponents<C>, callbacks: ComponentSystemCallbacks<C>) => {
			const self: MovingEntity<T> = { entityId, components };
			const interpolation = components.interpolation;
			const seconds = world.elapsedTime / 1000;
			const moveX = components.velocity[VELOCITY_X_INDEX] * seconds;
			const moveY = components.velocity[VELOCITY_Y_INDEX] * seconds;

			// Taken before anything is written, so the two ends of the segment a renderer blends along are this
			// step's start and this step's end rather than positions from either side of it.
			startInterpolationStep(interpolation, components.transform, world.elapsedTime);

			// preRun builds the tree before any entity is updated, so there is only nothing here for an update
			// that was called by hand without one.  Nothing to sweep against then, and the move is the plain
			// integration.
			if(!broadphase) {
				move(entityId, components.transform, moveX, moveY, callbacks, world.reportMoves);
				finishInterpolationStep(interpolation, world.tick);

				return;
			}

			// Where the entity may actually get to is worked out here, off the blocks rather than in them: the
			// position is only written once the answer is known, so an entity is never inside another one - not
			// even for the moment it would take to push it back out.
			//
			// The sweep happens whether or not the game gave a callback.  Coming to rest against what is in the
			// way is what physics *does* about a collision; `onCollision` is what the game does about it, and
			// plenty of games want the first without the second.  Movement that ignores everything around it is
			// the bare physicsUpdate below rather than an option here.
			const sweep = broadphase.sweep(self, moveX, moveY);
			move(entityId, components.transform, moveX * sweep.fraction, moveY * sweep.fraction, callbacks, world.reportMoves);
			// Straight after the move and before any callback, so the stamp covers exactly the pair physics itself
			// produced.  A callback that goes on to write the transform is a move the game made rather than one
			// this step did, and it is blended towards on the next frame the same way a teleport is.
			finishInterpolationStep(interpolation, world.tick);

			if(!onCollision) {
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
			for(const other of sweep.blocking) {
				onCollision(world, self, other, queries, callbacks);
			}
		},
		{
			physics: {
				// The sweep needs the collidable query whether or not anything is going to be told about what it
				// found, so this is not `onCollision !== undefined`.
				collision: true,
				optional,
			},
		},
	);

	// preRun is the one hook that sees every entity at once, which makes it the only place the tree can be
	// built from a single consistent moment - before any of this run's movement has happened.
	update.preRun = (world, entities, queries) => {
		broadphase = new CollisionBroadphase<T>(queries[COLLIDABLE_QUERY] ?? [], world.elapsedTime / 1000);
	};

	return update;
}

// Shared update logic used by both ComponentSystem backends: the main-thread ComponentWebWorker runs it
// directly (PhysicsSystem passes it as `updateFunction`), while a game's worker file imports it and hands it
// to createComponentWorker.  Keeping it in one place means both paths run identical logic.
//
// This is movement only, and the *only* way to get movement with no collision detection at all: it walks an
// entity straight through anything in its way, which is what a game wants for something that has no business
// noticing the world - a drifting particle, a camera, a projectile that only its own system cares about.  A
// game that wants entities stopped by each other, with or without a callback about it, builds its update with
// createPhysicsUpdate above instead, which sweeps around this same move.
export const physicsUpdate: EntityUpdateFunction<PhysicsComponents, PhysicsUpdateComponents, PhysicsWorld> = (world, entityId, components, queries, callbacks) => {
	// elapsedTime is in milliseconds (what BaseWorld#update is driven with), while velocity is in world units
	// per second - so convert before integrating.
	const seconds = world.elapsedTime / 1000;
	const interpolation = components.interpolation;

	startInterpolationStep(interpolation, components.transform, world.elapsedTime);
	move(
		entityId,
		components.transform,
		components.velocity[VELOCITY_X_INDEX] * seconds,
		components.velocity[VELOCITY_Y_INDEX] * seconds,
		callbacks,
		world.reportMoves,
	);
	finishInterpolationStep(interpolation, world.tick);
};

// The half of publishing a step that has to happen *before* the move: where the entity is standing now becomes
// the `prev` the next frame's render position is blended out of, along with how much simulated time the segment
// between the two is going to cover.
//
// The duration is published rather than left to be assumed, because a run does not always cover one step: one
// that comes back late leaves more than a step's worth of time banked and the next one takes two at once.  A
// renderer dividing that segment by the step instead of by what it really covers draws it at double speed.
//
// Nothing is written for an entity without the component, which is what makes interpolation opt-in per entity
// rather than a cost every world pays.
function startInterpolationStep(interpolation: Float32Array | undefined, transform: Float32Array, elapsedTime: number): void {
	if(!interpolation) {
		return;
	}

	interpolation[INTERPOLATION_PREV_X_INDEX] = transform[TRANSFORM_X_INDEX];
	interpolation[INTERPOLATION_PREV_Y_INDEX] = transform[TRANSFORM_Y_INDEX];
	interpolation[INTERPOLATION_DURATION_INDEX] = elapsedTime;
}

// And the half that has to happen after it.  Written unconditionally - outside `move`'s "did not go anywhere"
// early return - so an entity pressed against a wall publishes a step where `prev` equals where it still is,
// rather than going quiet and leaving a renderer blending against whatever it was doing before it stopped.
//
// The tick goes last and through storeFloat32, which is an `Atomics.store` through an Int32Array view of the
// same memory: a release store, so a reader that sees this tick is guaranteed to also see the `prev` and the
// transform that belong with it.  That is the whole publication protocol - see INTERPOLATION_TICK_INDEX.
function finishInterpolationStep(interpolation: Float32Array | undefined, tick: number): void {
	if(!interpolation) {
		return;
	}

	storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, tick);
}

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
// does not bound how far something may travel - so it is passed Infinity, leaving a plain atomic add.
//
// A move that did not go anywhere is not reported, which is what keeps a world of still entities quiet - and an
// entity pressed up against something it cannot move past reports nothing at all rather than a change per run.
// An entity that did move is reported once however many axes it moved along: a listener keyed off position - a
// spatial index, a minimap, a sprite - wants the place rather than the axis, and it reads the whole transform
// out of shared memory anyway.
//
// `reportMoves` is what makes even that skippable.  It is not a saving on this line - it is a saving on the id
// that would have been pushed into the run's event array, and on that whole array being cloned back across the
// worker boundary once a step.  A game reading positions through the interpolation component wants nothing to
// do with it: the event fires at the physics rate, which is the rate it is drawing *around*.  See
// PhysicsSystem, which sets this from whether anything is actually listening.
function move(entityId: number, transform: Float32Array, moveX: number, moveY: number, callbacks: PositionCallbacks, reportMoves?: boolean): void {
	if(moveX === 0 && moveY === 0) {
		return;
	}

	if(moveX !== 0) {
		addAtomicFloat32(transform, TRANSFORM_X_INDEX, moveX, Infinity);
	}
	if(moveY !== 0) {
		addAtomicFloat32(transform, TRANSFORM_Y_INDEX, moveY, Infinity);
	}

	if(reportMoves === false) {
		return;
	}

	// The id on its own: the block above is what the main thread reads the position out of, and it is the same
	// memory, so there is nothing here worth sending it a copy of.
	callbacks.emitSystemEvent(POSITION_UPDATED_EVENT, entityId);
}

// The one callback move reaches for, narrowed to the event physics reports.  ComponentSystemCallbacks takes
// any event name, which says nothing about what to listen for - so the moves are handed over through this
// instead.
interface PositionCallbacks {
	emitSystemEvent(event: typeof POSITION_UPDATED_EVENT, entityId: number): void
}

export default physicsUpdate;
