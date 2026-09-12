import { addAtomicFloat32 } from '@daneren2005/shared-memory-objects/utils/atomic-math';
import { storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import type SharedSpatialMap from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import { DEAD_INDEX } from '@daneren2005/shared-memory-ecs';
import type { ComponentMap, EntityWorkerSystemCallbacks, EntityWorkerSystemWorld, EntityQueryComponents, EntityUpdateComponents, EntityUpdateFunction } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../components/registry';
import {
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_PREV_X_INDEX,
	INTERPOLATION_PREV_Y_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_TOTAL_DURATION_INDEX,
} from '../components/interpolation-component';
import { isDying, markDying } from '../components/body-component';
import { TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import CollisionBroadphase, { COLLIDABLE_QUERY, type CollisionContact, type CollisionEntity, type CollisionFunction, type MovingEntity } from './collision';
import type { Vector } from '../math/shapes';
import { bouncePair } from './bounce';
import {
	combineDynamicsCommands,
	integrateDynamics,
	queueDynamicsVector,
	queueVelocityAssignment,
} from './dynamics';
import type { DynamicsCommandQueue, DynamicsWorld, PendingDynamicsCommands } from './dynamics';
import { spatialBounds, type SpatialBlockComponents } from './spatial-bounds';
import { getSpatialMap, type PhysicalSystemWorld } from '../world';

// The per-run data object every physics update is handed: the base one plus the step counter the interpolation
// component is stamped with. PhysicsSystem fills `tick` from addDataToWorld, so a subclass adding data must
// call `super.addDataToWorld(world)` or nothing gets a tick and interpolation stops noticing new steps.
export interface PhysicsWorld extends EntityWorkerSystemWorld, PhysicalSystemWorld, DynamicsWorld {
	// Which physics step this is, bumped per run. Only compared for equality - a publication stamp, not a clock.
	tick: number
	// Whether to report this run's moves. Set by PhysicsSystem from whether anything is listening, since the cost
	// is paid in the worker (an id per moved entity, cloned across the boundary). Undefined means report.
	reportMoves?: boolean
	// For a grouped update (see `group` on createPhysicsUpdate)
	skipGroup?: number
	// Identifies one PhysicsSystem to a shared update function, keeping its callback commands isolated.
	commandQueueId?: number
	dieAtImpact?(dying: DeathInterpolationEntity, other: DeathInterpolationEntity): void
}

// The world seen inside createPhysicsUpdate callbacks. Commands raised here are retained by the active backend
// and integrated at the start of its next run, so callback behavior does not depend on entity update order.
export interface PhysicsCallbackWorld extends PhysicsWorld, DynamicsCommandQueue {}

export function updateSpatialMap(world: PhysicalSystemWorld, entityId: number, components: SpatialBlockComponents): void {
	if(!world.spatialMap && (!world.heap || !world.spatialMapMemory)) {
		return;
	}

	const spatialMap: SharedSpatialMap = getSpatialMap(world);
	const bounds = spatialBounds(components);
	spatialMap.update(entityId, bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
}

// What `dieAtImpact` reads off each side. Everything is optional and guarded at runtime so both a MovingEntity
// (the mover, whose body is only optional in the type) and a CollisionEntity (the thing hit, whose velocity is)
// can be handed to it either way round - which side carries the fatal category is the game's to sort out.
export interface DeathInterpolationEntity {
	entityId: number
	components: {
		transform?: Float32Array
		velocity?: Float32Array
		body?: Uint32Array
	}
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

const CONTACT_NORMAL: Vector = { x: 0, y: 0 };

// What a game asks createPhysicsUpdate for on top of plain movement.
export interface PhysicsUpdateOptions<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
> {
	// Run for each entity that moved into another, straight after its own move. Optional: an update with no
	// callback still sweeps and comes to rest against what is in the way, it just decides nothing about it.
	onCollision?: CollisionFunction<C, T, W & PhysicsCallbackWorld>
	// Extra components to hand the update, and so the callback, beyond transform and velocity. List a health
	// component here to take damage on collision. Optional per entity: one without it is still moved and collided.
	optional?: Array<keyof C & string>
	// Splits the run into isolated groups by a numeric id read off a component block, so one system can simulate many independent worlds at once
	group?: PhysicsGroupConfig<C>
	// For solid contacts, remove the velocity component pointing into the surface from entities without a
	// bounciness component. Off by default to preserve the existing sweep-only response.
	stopVelocityOnContact?: boolean
}

// Which component block carries an entity's group id, and where in it. The block travels with both movers and
// collidables (PhysicsSystem adds it to their optionals), so grouping holds on both sides of a collision.
export interface PhysicsGroupConfig<C extends ComponentMap> {
	component: keyof C & string
	index: number
}

// What PhysicsSystem needs to know about an update to set up its components and queries. Stamped on by
// createPhysicsUpdate so a game declares its collision setup once, in the module both backends import.
export interface PhysicsUpdateMetadata<C extends ComponentMap> {
	// Whether the update needs the collidable query. Always true for createPhysicsUpdate, which always sweeps;
	// the bare physicsUpdate carries no metadata and never asks for it.
	collision: boolean
	// The update integrates the optional dynamics block before movement.
	dynamics: boolean
	optional: Array<keyof C & string>
	// Set when the update groups its run; PhysicsSystem reads it to send the group block with movers and collidables.
	group?: PhysicsGroupConfig<C>
}

export type PhysicsUpdateFunction<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
> = EntityUpdateFunction<C, T, W> & {
	physics: PhysicsUpdateMetadata<C>
};

// Builds the update a game runs physics through when it wants its entities to notice each other. The result is
// a plain EntityUpdateFunction that goes to both backends: createEntitySystemWorker in the worker file, and
// PhysicsSystem's `updateFunction` for the in-process fallback.
//
//   export const gamePhysicsUpdate = createPhysicsUpdate<Components, GameUpdateComponents>({
//     optional: ['health'],
//     onCollision(world, a, b, queries, callbacks, contact) { ... },
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
	const { onCollision, optional = [], group, stopVelocityOnContact = false } = options;

	// Built by preRun, read by each entity update after it. Safe as closure variables because a run is one
	// unbroken pass - preRun, then every entity - never re-entered part way through. Ungrouped runs use the single
	// `broadphase`; a grouped run keeps one per group and each entity sweeps against its own.
	let broadphase: CollisionBroadphase<T> | undefined;
	let broadphaseByGroup: Map<number, CollisionBroadphase<T>> | undefined;
	const callbackCommandsBySystem = new Map<number, PendingDynamicsCommands>();

	const update: PhysicsUpdateFunction<C, T, W> = Object.assign(
		(world: W, entityId: number, components: T, queries: EntityQueryComponents<C>, callbacks: EntityWorkerSystemCallbacks<C>) => {
			// Killed earlier this run
			if(components.entity?.[DEAD_INDEX] === 1) {
				return;
			}

			// Struck something fatal on an earlier run and marked to die a step later, once its final segment onto the
			// impact point had a step to render (see dieAtImpact). That step is now, so this is where it actually dies -
			// before it moves or sweeps again, so it neither drifts on nor resolves a second contact.
			if(components.body !== undefined && isDying(components.body)) {
				callbacks.entityDied(entityId);

				return;
			}

			// A grouped entity in the skipped group is left entirely alone - another system owns it this run.
			const groupId = group ? readGroup<C>(components, group) : 0;
			if(group && world.skipGroup === groupId) {
				return;
			}

			const self: MovingEntity<T> = { entityId, components };
			const interpolation = components.interpolation;
			const seconds = world.elapsedTime / 1000;
			integrateDynamics(world, entityId, components.velocity, components.dynamics);
			const moveX = components.velocity[VELOCITY_X_INDEX] * seconds;
			const moveY = components.velocity[VELOCITY_Y_INDEX] * seconds;

			// Taken before anything is written, so the segment a renderer blends along runs from this step's start
			// to its end.
			startInterpolationStep(interpolation, components.transform, world.elapsedTime);

			// No tree means either this update was called by hand without preRun, or a grouped entity whose group
			// holds nothing collidable: nothing to sweep against, plain move. Bound locally so it stays narrowed
			// inside the overlap callback below.
			const tree = group ? broadphaseByGroup?.get(groupId) : broadphase;
			if(!tree) {
				move(entityId, components.transform, moveX, moveY, callbacks, world.reportMoves);
				updateSpatialMap(world, entityId, components);
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
			updateSpatialMap(world, entityId, components);
			// Before any callback, so the stamp covers exactly the pair physics produced. A callback that writes
			// the transform is a game move, blended towards next frame like a teleport.
			finishInterpolationStep(interpolation, world.tick);

			// A non-bouncing entity still has to look, since what it ran into may bounce off it.
			if(!tree.hasBounciness && !stopVelocityOnContact && !onCollision) {
				return;
			}

			// Handled after the entity is put down, so both bounce and callback act on where it ended up; the
			// flipped velocity is applied by the next run. A contact is resolved once per run, by whichever side
			// reached it first - claimContact is what makes the second side's turn a no-op.
			tree.forEachOverlapping(self, other => {
				if(tree.claimContact(entityId, other.entityId)) {
					resolveContact(world as W & PhysicsCallbackWorld, tree, self, other, queries, callbacks, moved.moveX, moved.moveY, stopVelocityOnContact, onCollision);
				}
			}, moved.moveX, moved.moveY);

			// Then what the move was stopped against, which the overlap check cannot find: the entity rests
			// touching it, not through it. The two lists never share an entry.
			for(const other of moved.blocking) {
				if(tree.claimContact(entityId, other.entityId)) {
					resolveContact(world as W & PhysicsCallbackWorld, tree, self, other, queries, callbacks, moved.moveX, moved.moveY, stopVelocityOnContact, onCollision);
				}
			}
		},
		{
			physics: {
				// The sweep needs the collidable query even with no callback, so this is not `onCollision !== undefined`.
				collision: true,
				dynamics: true,
				optional,
				group,
			},
		},
	);

	// preRun sees every entity at once, so it is the only place the tree can be built from one consistent moment,
	// before any of this run's movement. Ungrouped builds one tree over everything; grouped buckets the collidables
	// by group id and builds a tree per group, so an entity only ever sweeps against its own group - the skipped
	// group gets none, since nothing in it will be stepped.
	update.preRun = (world, entities, queries) => {
		prepareCallbackCommands(world, callbackCommandsBySystem);
		// Bound to the tree it strikes against and hung on the world so a collision callback can reach it. The tree
		// is picked when it is called, not now, since the callback fires after the trees below are built; a dying
		// entity and the thing it hit are always in the same group, so the dying side's group picks the right one.
		world.dieAtImpact = (dying, other) => {
			const tree = group ? broadphaseByGroup?.get(readGroup<C>(dying.components, group)) : broadphase;
			applyDeathInterpolation<T>(world, tree, dying, other);
		};

		const seconds = world.elapsedTime / 1000;
		const collidables = queries[COLLIDABLE_QUERY] ?? [];
		if(!group) {
			broadphase = new CollisionBroadphase<T>(collidables, seconds, world.dynamicsCommands);
			return;
		}

		const byGroup = new Map<number, typeof collidables>();
		for(const entity of collidables) {
			const groupId = readGroup<C>(entity.components, group);
			if(world.skipGroup === groupId) {
				continue;
			}

			let list = byGroup.get(groupId);
			if(!list) {
				list = [];
				byGroup.set(groupId, list);
			}
			list.push(entity);
		}

		broadphaseByGroup = new Map();
		for(const [groupId, list] of byGroup) {
			broadphaseByGroup.set(groupId, new CollisionBroadphase<T>(list, seconds, world.dynamicsCommands));
		}
	};

	return update;
}

function prepareCallbackCommands(
	world: PhysicsWorld,
	commandsBySystem: Map<number, PendingDynamicsCommands>,
): void {
	const commandWorld = world as PhysicsWorld & Partial<DynamicsCommandQueue>;
	const commandQueueId = world.commandQueueId ?? 0;
	const deferred = commandsBySystem.get(commandQueueId);
	if(deferred) {
		world.dynamicsCommands = combineDynamicsCommands(deferred, world.dynamicsCommands);
		commandsBySystem.delete(commandQueueId);
	}
	const commands = (): PendingDynamicsCommands => {
		let pending = commandsBySystem.get(commandQueueId);
		if(!pending) {
			pending = new Map();
			commandsBySystem.set(commandQueueId, pending);
		}

		return pending;
	};
	commandWorld.queueForce = (entityId, forceX, forceY) => {
		queueDynamicsVector(commands(), entityId, forceX, forceY, 0, 0);
	};
	commandWorld.queueImpulse = (entityId, impulseX, impulseY) => {
		queueDynamicsVector(commands(), entityId, 0, 0, impulseX, impulseY);
	};
	commandWorld.queueVelocity = (entityId, velocity) => {
		queueVelocityAssignment(commands(), entityId, velocity);
	};
}

// Reads an entity's group id off the configured block, defaulting to group 0 when the entity lacks it.
function readGroup<C extends ComponentMap>(components: EntityUpdateComponents<C>, group: PhysicsGroupConfig<C>): number {
	const block = components[group.component];

	return block ? block[group.index] : 0;
}

// Everything a contact means, applied once for the pair: both sides turned around by their own bounciness, then
// the one callback. `self` is whichever side reached the contact first, so a game acting on only one of the two
// would leave the other untouched half the time - the callback has to decide for both.
function resolveContact<
	C extends ComponentMap,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsCallbackWorld,
>(
	world: W,
	tree: CollisionBroadphase<T>,
	self: MovingEntity<T>,
	other: CollisionEntity<T>,
	queries: EntityQueryComponents<C>,
	callbacks: EntityWorkerSystemCallbacks<C>,
	moveX: number,
	moveY: number,
	stopVelocityOnContact: boolean,
	onCollision?: CollisionFunction<C, T, W>,
): void {
	bouncePair(self, other, stopVelocityOnContact);
	if(!onCollision) {
		return;
	}

	const selfBounds = spatialBounds(self.components);
	const otherBounds = spatialBounds(other.components);
	CONTACT_NORMAL.x = 0;
	CONTACT_NORMAL.y = 0;
	tree.contactNormal(self, other, moveX, moveY, CONTACT_NORMAL);
	const contact: CollisionContact = { normalX: CONTACT_NORMAL.x, normalY: CONTACT_NORMAL.y };
	onCollision(world, self, other, queries, callbacks, contact);
	updateSpatialMapIfBoundsChanged(world, self.entityId, self.components, selfBounds);
	updateSpatialMapIfBoundsChanged(world, other.entityId, other.components, otherBounds);
}

function updateSpatialMapIfBoundsChanged(
	world: PhysicalSystemWorld,
	entityId: number,
	components: SpatialBlockComponents,
	before: ReturnType<typeof spatialBounds>,
): void {
	const after = spatialBounds(components);
	if(after.minX !== before.minX || after.minY !== before.minY || after.maxX !== before.maxX || after.maxY !== before.maxY) {
		updateSpatialMap(world, entityId, components);
	}
}

// Backs `dieAtImpact`. Rather than remove `dying` on the spot - where a fast continuous mover has already stepped
// a stride past what it hit, and its render, a step behind, has it short of the target - this ends its current
// interpolation segment on the exact point it struck `other` and marks it to die one run later. That extra run is
// the step the render needs to play the segment out, so the entity is drawn reaching the impact and only then
// vanishes. Position only: the game still raises whatever hit/score event it wants, on the spot. A no-op tail for
// an entity missing the blocks or that did not move leaves it marked dying, so it is still cleaned up next run.
function applyDeathInterpolation<T extends PhysicsUpdateComponents>(
	world: PhysicsWorld,
	tree: CollisionBroadphase<T> | undefined,
	dying: DeathInterpolationEntity,
	other: DeathInterpolationEntity,
): void {
	const body = dying.components.body;
	// Needs a body to carry the flag; already dying means a second contact this run, which is nothing to redo.
	if(!body || isDying(body)) {
		return;
	}
	markDying(body);

	const transform = dying.components.transform;
	const velocity = dying.components.velocity;
	const otherTransform = other.components.transform;
	const otherBody = other.components.body;
	if(!tree || !transform || !velocity || !otherTransform || !otherBody) {
		return;
	}

	const seconds = world.elapsedTime / 1000;
	const moveX = velocity[VELOCITY_X_INDEX] * seconds;
	const moveY = velocity[VELOCITY_Y_INDEX] * seconds;
	if(moveX === 0 && moveY === 0) {
		return;
	}

	const contact = tree.contactPoint(
		{ entityId: dying.entityId, components: { transform, body } },
		{ components: { transform: otherTransform, body: otherBody } },
		moveX,
		moveY,
	);
	// Retarget this run's segment: `prev` is still the step's start, so moving the transform back to the impact
	// point makes the render play start -> impact instead of start -> overshoot. The tick was already stamped for
	// this run and the interpolation reads the transform live, so the shortened end is picked up with no reseeding.
	transform[TRANSFORM_X_INDEX] = contact.x;
	transform[TRANSFORM_Y_INDEX] = contact.y;
}

// Movement only, and the only way to get movement with no collision detection: walks an entity straight through
// anything in its way, for something that has no business noticing the world (a particle, a camera). For
// entities stopped by each other, build the update with createPhysicsUpdate above, which sweeps around this move.
export function physicsUpdate<
	C extends ComponentMap & PhysicsComponents = PhysicsComponents,
	T extends PhysicsUpdateComponents & EntityUpdateComponents<C> = PhysicsUpdateComponents & EntityUpdateComponents<C>,
	W extends PhysicsWorld = PhysicsWorld,
>(world: W, entityId: number, components: T, queries: EntityQueryComponents<C>, callbacks: EntityWorkerSystemCallbacks<C>): void {
	// elapsedTime is ms, velocity is units per second.
	const seconds = world.elapsedTime / 1000;
	const interpolation = components.interpolation;
	integrateDynamics(world, entityId, components.velocity, components.dynamics);

	startInterpolationStep(interpolation, components.transform, world.elapsedTime);
	move(
		entityId,
		components.transform,
		components.velocity[VELOCITY_X_INDEX] * seconds,
		components.velocity[VELOCITY_Y_INDEX] * seconds,
		callbacks,
		world.reportMoves,
	);
	updateSpatialMap(world, entityId, components);
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

	// Mark the publication dirty before changing either endpoint. Without this, a reader can take both tick
	// samples before the final store while still observing some of the new step's ordinary/atomic writes.
	storeFloat32(interpolation, INTERPOLATION_TICK_INDEX, Number.NaN);
	interpolation[INTERPOLATION_PREV_X_INDEX] = transform[TRANSFORM_X_INDEX];
	interpolation[INTERPOLATION_PREV_Y_INDEX] = transform[TRANSFORM_Y_INDEX];
	interpolation[INTERPOLATION_DURATION_INDEX] = elapsedTime;
	interpolation[INTERPOLATION_TOTAL_DURATION_INDEX] += elapsedTime;
}

// The half after the move. Written unconditionally, so an entity pressed against a wall still publishes a step
// (with `prev` where it is) rather than going quiet and leaving a renderer blending against stale data. The tick
// replaces the dirty marker last, so a reader can only accept the matching `prev` and transform.
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
