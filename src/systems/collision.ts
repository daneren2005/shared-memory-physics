import Flatbush from 'flatbush';
import type { ComponentMap, ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import type { PhysicsUpdateComponents } from '../components/registry';
import { BODY_CATEGORY_INDEX, BODY_MASK_INDEX, BODY_SHAPE_INDEX } from '../components/body-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import { shapeHalfHeight, shapeHalfWidth, shapeIsEmpty, shapesOverlap } from '../math/shapes';

// The name PhysicsSystem registers its extra query under, and the key the broadphase reads it back out of.
// It holds everything with a transform and a body rather than only the entities the system moves, so a moving
// entity can still run into a station, a wall or anything else that has no velocity of its own.
export const COLLIDABLE_QUERY = 'collidable';

// The blocks a collision callback is handed for the entity that was run into.  `transform` and `body` are the
// guarantees - they are what the collidable query requires - while `velocity` and everything the game listed
// in `optional` are there only if that entity has them.
export type CollisionComponents<T extends PhysicsUpdateComponents> = Partial<T> & {
	transform: Float32Array
	body: Uint32Array
};

// The entity that did the running into: the one being updated, so everything the system asked for is there.
export interface MovingEntity<T extends PhysicsUpdateComponents> {
	entityId: number
	components: T
}

// The entity on the other side of a collision, which may be something the system never moves at all.
export interface CollisionEntity<T extends PhysicsUpdateComponents> {
	entityId: number
	components: CollisionComponents<T>
}

// What a game runs when one entity moves into another.  It is called on the same thread the physics update
// runs on, so it must be a plain function over the raw blocks - no entities, no world - and it reaches the
// main thread only through `callbacks` (which report a changed property, a death, or an entity to spawn).
//
// It is called *per entity*, right after that entity has moved: `self` is the one that just moved and `other`
// is what it has ended up on top of.  Two moving entities that run into each other therefore get one call
// each, with the roles swapped, which is what lets a callback act on itself - bouncing, taking damage - and
// leave the other side to its own call.  An entity with no velocity is never `self`, since the system never
// moves it, but it is still found as `other`.
//
// `queries` is passed straight through so a callback that needs more than the two entities in front of it can
// still walk the full collidable list, e.g. to credit a third entity for the kill.
export type CollisionFunction<C extends ComponentMap, T extends PhysicsUpdateComponents & EntityUpdateComponents<C>, W extends ComponentSystemWorld = ComponentSystemWorld> = (
	world: W,
	self: MovingEntity<T>,
	other: CollisionEntity<T>,
	queries: EntityQueryComponents<C>,
	callbacks: ComponentSystemCallbacks<C>,
) => void;

// One category's worth of the broadphase: every collidable entity that collides *as* that category, and an
// R-tree over just those.  A searching entity only looks in the buckets its own mask accepts, so a projectile
// that can only hit units never walks the tree the terrain is in.
//
// Bucketed on the whole category *value* rather than a bit at a time, so an entity that collides as two things
// at once still lives in exactly one bucket and can never be found twice by one search.
interface CategoryBucket<T extends PhysicsUpdateComponents> {
	category: number
	entries: Array<CollisionEntity<T>>
	index: Flatbush
}

// An R-tree over every collidable entity, built once at the top of a run and then asked, entity by entity as
// each one moves, what it might have hit.
//
// Everything is indexed where it stood at the *start* of the run, because that is the only moment all of the
// entities agree on - by the time the third entity moves, the first two have already gone somewhere else.  To
// stay a true superset of what can actually collide, each box is grown by however far that entity could
// travel before the run is out.  The growth goes both ways rather than along the heading: a collision
// callback is free to turn an entity around before it has had its own move, and a box grown only forwards
// would then be pointing the wrong way.
//
// The tree is split by collide category rather than being one index over everything, so most of what an entity
// cannot hit is ruled out a whole subtree at a time instead of one candidate at a time.  Nothing is left empty:
// a category with no collidable entities has no bucket at all, which also means Flatbush is never asked to
// build an index over zero items.
export default class CollisionBroadphase<T extends PhysicsUpdateComponents> {
	private buckets: Array<CategoryBucket<T>> = [];

	constructor(entities: Array<{ entityId: number, components: EntityUpdateComponents }>, seconds: number) {
		// Boxes are collected per category first because Flatbush has to be told how many items it will hold up
		// front, and how many that is only becomes clear once everything that cannot collide has been dropped.
		const pending = new Map<number, { entries: Array<CollisionEntity<T>>, bounds: Array<number> }>();

		for(const entity of entities) {
			// The ECS types query blocks generically as ComponentTypedArray since it cannot know what any given
			// game registered; narrow them to the concrete arrays the definitions allocate here, once, so neither
			// the search below nor the game's callback needs a cast of its own.
			const components = entity.components as CollisionComponents<T>;
			const transform = components.transform;
			const body = components.body;
			if(!transform || !body) {
				continue;
			}

			// No mask can ever name category 0, so an entity that collides as nothing can never be the other half
			// of a collision either - dropping it here is exact rather than an approximation, and it is what makes
			// `collideCategory: 0` a way to opt an entity out of collisions entirely.
			const category = body[BODY_CATEGORY_INDEX];
			if(category === 0) {
				continue;
			}

			const shape = body[BODY_SHAPE_INDEX];
			const width = transform[TRANSFORM_WIDTH_INDEX];
			const height = transform[TRANSFORM_HEIGHT_INDEX];
			// A shape with no area can never overlap anything, so dropping it here is exact rather than an
			// approximation - and it keeps an entity the game never gave a size out of the tree entirely.
			if(shapeIsEmpty(shape, width, height)) {
				continue;
			}

			const angle = transform[TRANSFORM_ANGLE_INDEX];
			const halfWidth = shapeHalfWidth(shape, width, height, angle);
			const halfHeight = shapeHalfHeight(shape, width, height, angle);

			const velocity = components.velocity;
			const travelX = velocity ? Math.abs(velocity[VELOCITY_X_INDEX]) * seconds : 0;
			const travelY = velocity ? Math.abs(velocity[VELOCITY_Y_INDEX]) * seconds : 0;

			const x = transform[TRANSFORM_X_INDEX];
			const y = transform[TRANSFORM_Y_INDEX];

			let bucket = pending.get(category);
			if(!bucket) {
				bucket = { entries: [], bounds: [] };
				pending.set(category, bucket);
			}

			bucket.entries.push({ entityId: entity.entityId, components });
			bucket.bounds.push(
				x - halfWidth - travelX,
				y - halfHeight - travelY,
				x + halfWidth + travelX,
				y + halfHeight + travelY,
			);
		}

		for(const [category, { entries, bounds }] of pending) {
			const index = new Flatbush(entries.length);
			for(let i = 0; i < entries.length; i++) {
				index.add(bounds[i * 4], bounds[i * 4 + 1], bounds[i * 4 + 2], bounds[i * 4 + 3]);
			}
			index.finish();

			this.buckets.push({ category, entries, index });
		}
	}

	// Runs `handle` for everything `self` is really overlapping, having just moved.
	//
	// The tree narrows the field to whatever is anywhere near, then each of those is put through the full
	// rotated box test against where the two entities are *now* - which for an entity that has not had its own
	// move yet is still where it started.  That is the price of collisions happening as each entity moves
	// rather than all at the end, and it evens out: the pair is looked at again from the other side once that
	// entity moves too.
	//
	// The collide masks are applied before the box test rather than after: a pair that can never collide is
	// settled by two ANDs instead of a full separating-axis test.
	forEachOverlapping(self: MovingEntity<T>, handle: (other: CollisionEntity<T>) => void): void {
		// An entity with no body does not collide at all.  It can still be moved by the system - the query that
		// moves entities only asks for the body, it does not require it.
		const body = self.components.body;
		if(!body) {
			return;
		}

		const selfCategory = body[BODY_CATEGORY_INDEX];
		const selfMask = body[BODY_MASK_INDEX];
		// Willing to run into nothing at all, so there is no bucket worth searching.  Note this only stops it
		// being the entity that *finds* a collision: something whose mask accepts it can still find this one, and
		// that is the asymmetry the symmetric canCollide rule then rules out.
		if(selfMask === 0) {
			return;
		}

		const transform = self.components.transform;
		const shape = body[BODY_SHAPE_INDEX];
		const width = transform[TRANSFORM_WIDTH_INDEX];
		const height = transform[TRANSFORM_HEIGHT_INDEX];
		if(shapeIsEmpty(shape, width, height)) {
			return;
		}

		const x = transform[TRANSFORM_X_INDEX];
		const y = transform[TRANSFORM_Y_INDEX];
		const angle = transform[TRANSFORM_ANGLE_INDEX];
		const halfWidth = shapeHalfWidth(shape, width, height, angle);
		const halfHeight = shapeHalfHeight(shape, width, height, angle);

		for(const bucket of this.buckets) {
			// Half of canCollide, settled once for everything in the bucket rather than once per candidate:
			// they all collide as the same category, so either this entity's mask accepts the lot of them or it
			// accepts none of them.
			if((selfMask & bucket.category) === 0) {
				continue;
			}

			// Searched with where this entity has actually ended up, ungrown: every box in the tree already allows
			// for its own entity's move, so allowing for this one's a second time would only widen the net.
			for(const found of bucket.index.search(x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight)) {
				const other = bucket.entries[found];
				// Every collidable entity is in some bucket, including this one.
				if(other.entityId === self.entityId) {
					continue;
				}

				// The other half of canCollide, which does have to be per candidate: a bucket shares one category
				// but every entity in it carries its own mask.
				if((other.components.body[BODY_MASK_INDEX] & selfCategory) === 0) {
					continue;
				}

				const otherTransform = other.components.transform;
				const overlapping = shapesOverlap(
					shape, x, y, width, height, angle,
					other.components.body[BODY_SHAPE_INDEX],
					otherTransform[TRANSFORM_X_INDEX], otherTransform[TRANSFORM_Y_INDEX],
					otherTransform[TRANSFORM_WIDTH_INDEX], otherTransform[TRANSFORM_HEIGHT_INDEX], otherTransform[TRANSFORM_ANGLE_INDEX],
				);
				if(overlapping) {
					handle(other);
				}
			}
		}
	}
}
