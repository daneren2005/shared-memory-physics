import Flatbush from 'flatbush';
import type { ComponentMap, ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import type { PhysicsUpdateComponents } from '../components/registry';
import { BODY_CATEGORY_INDEX, BODY_MASK_INDEX, BODY_SHAPE_INDEX } from '../components/body-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import { shapeHalfHeight, shapeHalfWidth, shapeIsEmpty, shapesOverlap } from '../math/shapes';

// How close to the moment of contact a sweep has to get before it settles for it, in world units.  Small enough
// that the gap it leaves an entity resting against another is far below anything a game would draw, and large
// enough that the halving below reaches it in a handful of steps.
const CONTACT_TOLERANCE = 1e-4;
// A cap on that halving, so a move over a huge distance cannot turn into an unbounded number of overlap tests.
// Each one narrows the answer by half, so this reaches the tolerance above for any move up to about sixteen
// hundred units - and only an entity that is actually stopping somewhere ever spends a single one of them.
const MAX_REFINEMENTS = 24;

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

// How much of a move an entity is actually allowed to make, and what stopped it there.
//
// `fraction` is how far along the requested move it got: 1 for a clear path, 0 for an entity already pressed up
// against something, and whatever is in between for one that came to rest part way.
//
// `blocking` is what it came to rest *against*, which the overlap test at that resting place will not report -
// the whole point of stopping there is that the two are touching rather than through each other.  More than one
// entry means it wedged between them at the same moment, not that it should have stopped at the first.
export interface SweepResult<T extends PhysicsUpdateComponents> {
	fraction: number
	blocking: Array<CollisionEntity<T>>
}

// What `blocking` is for the sweeps that find nothing in the way, which is most of them: one shared empty array
// rather than one per entity per run.  Read-only to a caller by nature - there is nothing in it to iterate.
const NOTHING_BLOCKING: Array<never> = [];

// Everything about the entity doing the searching, read out of its blocks once so that a sweep testing the same
// pair a dozen times over does not read them a dozen times over.  x/y are where it started the move.
interface Searcher {
	entityId: number
	shape: number
	x: number
	y: number
	width: number
	height: number
	angle: number
	halfWidth: number
	halfHeight: number
	category: number
	mask: number
}

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
	forEachOverlapping(self: MovingEntity<T>, handle: (other: CollisionEntity<T>) => void): void {
		const searcher = toSearcher(self);
		if(!searcher) {
			return;
		}

		const { x, y, halfWidth, halfHeight } = searcher;
		// Searched with where this entity has actually ended up, ungrown: every box in the tree already allows
		// for its own entity's move, so allowing for this one's a second time would only widen the net.
		this.forEachCandidate(searcher, x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight, other => {
			if(overlapsAt(searcher, x, y, other)) {
				handle(other);
			}
		});
	}

	// How much of the move (moveX, moveY) `self` may take before it runs into something, so that an entity comes
	// to rest against what is in its way instead of ending up inside it.
	//
	// Everything the move lands on is collected first and then they are all asked together, which is what keeps
	// an entity from stopping inside the near one because the far one happened to be looked at first: there is
	// one answer for the whole move, and it is the earliest contact of the lot.
	//
	// Contact is halved in on rather than solved: three shapes at any rotation to one another have no single
	// formula for when a pair first touches, while the overlap test the narrowphase already has answers it for
	// any pair anywhere.  The result is always taken from a position that tested clear, so wherever the entity
	// is put down it is genuinely not inside any of them.
	sweep(self: MovingEntity<T>, moveX: number, moveY: number): SweepResult<T> {
		const distance = Math.sqrt(moveX * moveX + moveY * moveY);
		const searcher = toSearcher(self);
		// Nothing to work out for an entity that is not going anywhere, or that does not collide at all.
		if(!searcher || distance === 0) {
			return { fraction: 1, blocking: NOTHING_BLOCKING };
		}

		const { x, y, halfWidth, halfHeight } = searcher;
		const endX = x + moveX;
		const endY = y + moveY;

		// What the move would land on top of, asked where it *ends* rather than anywhere along the way.  That is
		// what keeps a clear move - which is nearly every move - down to a single shape test per candidate and
		// nothing else: an entity only ever walks its own path once something is genuinely in the way of it.
		//
		// The trade is that a move long enough to carry an entity clean past something is not stopped by it: by
		// the time the move is out there is nothing left to land on.  That takes a single run covering more
		// ground than the thing in the way is thick, which a fixed `deltaBetweenRuns` rules out.
		const candidates: Array<CollisionEntity<T>> = [];
		this.forEachCandidate(searcher, endX - halfWidth, endY - halfHeight, endX + halfWidth, endY + halfHeight, other => {
			// Not where the move ends up, so nothing this move has to stop for.
			if(!overlapsAt(searcher, endX, endY, other)) {
				return;
			}

			// Already inside it before the move began - something the game put there, or another system pushed
			// it into.  It cannot be what *this* move ran into, and blocking on it would pin the entity inside
			// it for good with no way back out, so the move is let through and the pair is left to the overlap
			// callback that follows it.
			if(overlapsAt(searcher, x, y, other)) {
				return;
			}

			candidates.push(other);
		});
		if(candidates.length === 0) {
			return { fraction: 1, blocking: NOTHING_BLOCKING };
		}

		// From here the entity is definitely stopping short of where it asked to go, and all that is left is
		// where.  `clear` is a fraction of the move it is known to fit at and `blocked` one it is known not to -
		// the whole move to begin with, since landing there is what put these candidates in the list at all -
		// and halving closes the gap between the two.
		let clear = 0;
		let blocked = 1;
		const tolerance = CONTACT_TOLERANCE / distance;
		for(let i = 0; i < MAX_REFINEMENTS && blocked - clear > tolerance; i++) {
			const middle = (clear + blocked) / 2;
			if(this.blockedAt(searcher, candidates, moveX, moveY, middle)) {
				blocked = middle;
			} else {
				clear = middle;
			}
		}

		// Whatever is in the way at the first position that was not clear: the entity has come to rest a hair
		// short of exactly there, so this is what it is up against.
		const blocking: Array<CollisionEntity<T>> = [];
		const blockedX = x + moveX * blocked;
		const blockedY = y + moveY * blocked;
		for(const other of candidates) {
			if(overlapsAt(searcher, blockedX, blockedY, other)) {
				blocking.push(other);
			}
		}

		// An entity already up against something is left exactly where it is rather than crawling the last
		// fraction of a tolerance forwards every run, which would report a position change for no visible move.
		return { fraction: clear * distance > CONTACT_TOLERANCE ? clear : 0, blocking };
	}

	// Whether `self` would be inside any of `candidates` that far along its move.
	private blockedAt(searcher: Searcher, candidates: Array<CollisionEntity<T>>, moveX: number, moveY: number, fraction: number): boolean {
		const x = searcher.x + moveX * fraction;
		const y = searcher.y + moveY * fraction;
		for(const other of candidates) {
			if(overlapsAt(searcher, x, y, other)) {
				return true;
			}
		}

		return false;
	}

	// Runs `handle` for every collidable entity in the box that `searcher` is allowed to collide with at all -
	// the tree search and the category rules, with no geometry beyond the boxes themselves.
	//
	// The collide masks are applied before any shape test rather than after: a pair that can never collide is
	// settled by two ANDs instead of a full separating-axis test.
	private forEachCandidate(searcher: Searcher, minX: number, minY: number, maxX: number, maxY: number, handle: (other: CollisionEntity<T>) => void): void {
		for(const bucket of this.buckets) {
			// Half of canCollide, settled once for everything in the bucket rather than once per candidate:
			// they all collide as the same category, so either this entity's mask accepts the lot of them or it
			// accepts none of them.
			if((searcher.mask & bucket.category) === 0) {
				continue;
			}

			for(const found of bucket.index.search(minX, minY, maxX, maxY)) {
				const other = bucket.entries[found];
				// Every collidable entity is in some bucket, including this one.
				if(other.entityId === searcher.entityId) {
					continue;
				}

				// The other half of canCollide, which does have to be per candidate: a bucket shares one category
				// but every entity in it carries its own mask.
				if((other.components.body[BODY_MASK_INDEX] & searcher.category) === 0) {
					continue;
				}

				handle(other);
			}
		}
	}
}

// Reads out what a searching entity needs to be measured by, or undefined for one that cannot collide at all.
function toSearcher<T extends PhysicsUpdateComponents>(self: MovingEntity<T>): Searcher | undefined {
	// An entity with no body does not collide at all.  It can still be moved by the system - the query that
	// moves entities only asks for the body, it does not require it.
	const body = self.components.body;
	if(!body) {
		return undefined;
	}

	// Willing to run into nothing at all, so there is no bucket worth searching.  Note this only stops it being
	// the entity that *finds* a collision: something whose mask accepts it can still find this one, and that is
	// the asymmetry the symmetric canCollide rule then rules out.
	const mask = body[BODY_MASK_INDEX];
	if(mask === 0) {
		return undefined;
	}

	const transform = self.components.transform;
	const shape = body[BODY_SHAPE_INDEX];
	const width = transform[TRANSFORM_WIDTH_INDEX];
	const height = transform[TRANSFORM_HEIGHT_INDEX];
	if(shapeIsEmpty(shape, width, height)) {
		return undefined;
	}

	const angle = transform[TRANSFORM_ANGLE_INDEX];

	return {
		entityId: self.entityId,
		shape,
		x: transform[TRANSFORM_X_INDEX],
		y: transform[TRANSFORM_Y_INDEX],
		width,
		height,
		angle,
		halfWidth: shapeHalfWidth(shape, width, height, angle),
		halfHeight: shapeHalfHeight(shape, width, height, angle),
		category: body[BODY_CATEGORY_INDEX],
		mask,
	};
}

// Whether the searching entity, put down at (x, y) rather than wherever its own block says it is, overlaps
// `other`.  Taking the position as arguments is what lets a sweep try a whole path without writing any of it.
function overlapsAt<T extends PhysicsUpdateComponents>(searcher: Searcher, x: number, y: number, other: CollisionEntity<T>): boolean {
	const transform = other.components.transform;

	return shapesOverlap(
		searcher.shape, x, y, searcher.width, searcher.height, searcher.angle,
		other.components.body[BODY_SHAPE_INDEX],
		transform[TRANSFORM_X_INDEX], transform[TRANSFORM_Y_INDEX],
		transform[TRANSFORM_WIDTH_INDEX], transform[TRANSFORM_HEIGHT_INDEX], transform[TRANSFORM_ANGLE_INDEX],
	);
}
