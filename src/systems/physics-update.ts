import { addAtomicFloat32 } from '@daneren2005/shared-memory-objects/utils/atomic-math';
import { storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import { DEAD_INDEX } from '@daneren2005/shared-memory-ecs';
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
import CollisionBroadphase, { COLLIDABLE_QUERY, type CollisionEntity, type CollisionFunction, type MovingEntity } from './collision';
import { bouncePair } from './bounce';

// The per-run data object every physics update is handed: the base one plus the step counter the interpolation
// component is stamped with. PhysicsSystem fills `tick` from addDataToWorld, so a subclass adding data must
// call `super.addDataToWorld(world)` or nothing gets a tick and interpolation stops noticing new steps.
export interface PhysicsWorld extends ComponentSystemWorld {
	// Which physics step this is, bumped per run. Only compared for equality - a publication stamp, not a clock.
	tick: number
	// Whether to report this run's moves. Set by PhysicsSystem from whether anything is listening, since the cost
	// is paid in the worker (an id per moved entity, cloned across the boundary). Undefined means report.
	reportMoves?: boolean
}

// The event a move is reported through, emitted on the system on the main thread once the run completes,
// carrying the ids of everything that moved:
//
//   physicsSystem.on(POSITION_UPDATED_EVENT, (entityIds: Array<number>) => { ... });
//
// Reported as one id array per run rather than per entity, since nearly everything moves nearly every run. No
// position travels with the id: the transform is a SharedArrayBuffer block already on the main thread, so a
// listener reads it off `entity.components.transform`.
export const POSITION_UPDATED_EVENT = 'position-updated';

// What a game asks createPhysicsUpdate for on top of plain movement.
export interface PhysicsUpdateOptions<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
> {
	// Run for each entity that moved into another, straight after its own move. Optional: an update with no
	// callback still sweeps and comes to rest against what is in the way, it just decides nothing about it.
	onCollision?: CollisionFunction<C, T, W>
	// Extra components to hand the update, and so the callback, beyond transform and velocity. List a health
	// component here to take damage on collision. Optional per entity: one without it is still moved and collided.
	optional?: Array<keyof C & string>
}

// What PhysicsSystem needs to know about an update to set up its components and queries. Stamped on by
// createPhysicsUpdate so a game declares its collision setup once, in the module both backends import.
export interface PhysicsUpdateMetadata<C extends ComponentMap> {
	// Whether the update needs the collidable query. Always true for createPhysicsUpdate, which always sweeps;
	// the bare physicsUpdate carries no metadata and never asks for it.
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

// Builds the update a game runs physics through when it wants its entities to notice each other. The result is
// a plain EntityUpdateFunction that goes to both backends: createComponentWorker in the worker file, and
// PhysicsSystem's `updateFunction` for the in-process fallback.
//
//   export const gamePhysicsUpdate = createPhysicsUpdate<Components, GameUpdateComponents>({
//     optional: ['health'],
//     onCollision(world, a, b, queries, callbacks) { ... },
//   });
//
// Every update built here sweeps, so an entity comes to rest against what is in its way. The callback is on top
// and optional; movement that walks through everything is the bare physicsUpdate below. The callback is baked
// in rather than passed to PhysicsSystem because functions do not survive postMessage to the worker.
export function createPhysicsUpdate<
	// Constrained to a map holding the physics components because `T` is the game's components narrowed to
	// transform and velocity; every game already spreads physicsRegistry into its own, as PhysicsSystem requires.
	C extends ComponentMap & PhysicsComponents = PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C> = PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
>(options: PhysicsUpdateOptions<C, T, W> = {}): PhysicsUpdateFunction<C, T, W> {
	const { onCollision, optional = [] } = options;

	// Built by preRun, read by each entity update after it. Safe as a closure variable because a run is one
	// unbroken pass - preRun, then every entity - never re-entered part way through.
	let broadphase: CollisionBroadphase<T> | undefined;

	const update: PhysicsUpdateFunction<C, T, W> = Object.assign(
		(world: W, entityId: number, components: T, queries: EntityQueryComponents<C>, callbacks: ComponentSystemCallbacks<C>) => {
			// Killed earlier this run
			if(components.entity?.[DEAD_INDEX] === 1) {
				return;
			}

			const self: MovingEntity<T> = { entityId, components };
			const interpolation = components.interpolation;
			const seconds = world.elapsedTime / 1000;
			const moveX = components.velocity[VELOCITY_X_INDEX] * seconds;
			const moveY = components.velocity[VELOCITY_Y_INDEX] * seconds;

			// Taken before anything is written, so the segment a renderer blends along runs from this step's start
			// to its end.
			startInterpolationStep(interpolation, components.transform, world.elapsedTime);

			// No tree means this update was called by hand without preRun: nothing to sweep against, plain move.
			// Bound locally so it stays narrowed inside the overlap callback below.
			const tree = broadphase;
			if(!tree) {
				move(entityId, components.transform, moveX, moveY, callbacks, world.reportMoves);
				finishInterpolationStep(interpolation, world.tick);

				return;
			}

			// Native bounce turns an entity around on contact without a game callback; the bounciness component
			// decides whether and how much. Read before the move because it also decides how the move resolves.
			const bouncing = components.bounciness !== undefined;

			// Resolved off the blocks and only written once known, so an entity is never inside another. The move
			// resolves with or without a callback - coming to rest is what physics does about a collision,
			// onCollision is what the game does. A non-bouncing entity slides along a single axis off a corner; a
			// bouncing one does not, since it is about to turn around off the face it hit.
			const moved = tree.resolveMove(self, moveX, moveY, !bouncing);
			move(entityId, components.transform, moved.moveX, moved.moveY, callbacks, world.reportMoves);
			// Before any callback, so the stamp covers exactly the pair physics produced. A callback that writes
			// the transform is a game move, blended towards next frame like a teleport.
			finishInterpolationStep(interpolation, world.tick);

			// A non-bouncing entity still has to look, since what it ran into may bounce off it.
			if(!tree.hasBounciness && !onCollision) {
				return;
			}

			// Handled after the entity is put down, so both bounce and callback act on where it ended up; the
			// flipped velocity is applied by the next run. A contact is resolved once per run, by whichever side
			// reached it first - claimContact is what makes the second side's turn a no-op.
			tree.forEachOverlapping(self, other => {
				if(tree.claimContact(entityId, other.entityId)) {
					resolveContact(world, self, other, queries, callbacks, onCollision);
				}
			}, moved.moveX, moved.moveY);

			// Then what the move was stopped against, which the overlap check cannot find: the entity rests
			// touching it, not through it. The two lists never share an entry.
			for(const other of moved.blocking) {
				if(tree.claimContact(entityId, other.entityId)) {
					resolveContact(world, self, other, queries, callbacks, onCollision);
				}
			}
		},
		{
			physics: {
				// The sweep needs the collidable query even with no callback, so this is not `onCollision !== undefined`.
				collision: true,
				optional,
			},
		},
	);

	// preRun sees every entity at once, so it is the only place the tree can be built from one consistent moment,
	// before any of this run's movement.
	update.preRun = (world, entities, queries) => {
		broadphase = new CollisionBroadphase<T>(queries[COLLIDABLE_QUERY] ?? [], world.elapsedTime / 1000);
	};

	return update;
}

// Everything a contact means, applied once for the pair: both sides turned around by their own bounciness, then
// the one callback. `self` is whichever side reached the contact first, so a game acting on only one of the two
// would leave the other untouched half the time - the callback has to decide for both.
function resolveContact<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld,
>(
	world: W,
	self: MovingEntity<T>,
	other: CollisionEntity<T>,
	queries: EntityQueryComponents<C>,
	callbacks: ComponentSystemCallbacks<C>,
	onCollision?: CollisionFunction<C, T, W>,
): void {
	bouncePair(self, other);
	if(onCollision) {
		onCollision(world, self, other, queries, callbacks);
	}
}

// Movement only, and the only way to get movement with no collision detection: walks an entity straight through
// anything in its way, for something that has no business noticing the world (a particle, a camera). For
// entities stopped by each other, build the update with createPhysicsUpdate above, which sweeps around this move.
export function physicsUpdate<
	C extends ComponentMap & PhysicsComponents = PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C> = PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
>(world: W, entityId: number, components: T, queries: EntityQueryComponents<C>, callbacks: ComponentSystemCallbacks<C>): void {
	// elapsedTime is ms, velocity is units per second.
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
}

// The half of publishing a step that happens before the move: where the entity stands now becomes the `prev`
// the next frame blends out of, plus how much simulated time the segment covers. The duration is published
// because a run does not always cover one step - a late run takes two at once - and a renderer dividing by the
// fixed step would draw that at double speed. Nothing is written without the component, keeping it opt-in.
function startInterpolationStep(interpolation: Float32Array | undefined, transform: Float32Array, elapsedTime: number): void {
	if(!interpolation) {
		return;
	}

	interpolation[INTERPOLATION_PREV_X_INDEX] = transform[TRANSFORM_X_INDEX];
	interpolation[INTERPOLATION_PREV_Y_INDEX] = transform[TRANSFORM_Y_INDEX];
	interpolation[INTERPOLATION_DURATION_INDEX] = elapsedTime;
}

// The half after the move. Written unconditionally, so an entity pressed against a wall still publishes a step
// (with `prev` where it is) rather than going quiet and leaving a renderer blending against stale data. The
// tick goes last through storeFloat32 - a release store, so a reader that sees it also sees the matching `prev`
// and transform. That is the whole publication protocol; see INTERPOLATION_TICK_INDEX.
function finishInterpolationStep(interpolation: Float32Array | undefined, tick: number): void {
	if(!interpolation) {
		return;
	}

	storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, tick);
}

// Applies an already-decided move and reports where the entity ended up. The one place the position is written,
// reached only once the final position is known. Applied with addAtomicFloat32 rather than `+=` because another
// thread may be adding to the same shared position at once and a plain read-modify-write would drop one; the
// `max` cap is unwanted, so Infinity leaves a plain atomic add. A move that went nowhere is not reported, which
// keeps a world of still entities quiet. See PhysicsSystem for `reportMoves`.
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

	// Just the id: the main thread reads the position off the shared block, so no copy is worth sending.
	callbacks.emitSystemEvent(POSITION_UPDATED_EVENT, entityId);
}

// The one callback move reaches for, narrowed to the event physics reports.
interface PositionCallbacks {
	emitSystemEvent(event: typeof POSITION_UPDATED_EVENT, entityId: number): void
}

export default physicsUpdate;
