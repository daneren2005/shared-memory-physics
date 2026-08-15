import Flatbush from 'flatbush';
import { DEAD_INDEX } from '@daneren2005/shared-memory-ecs';
import type { ComponentMap, ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import type { PhysicsUpdateComponents } from '../components/registry';
import { BODY_CATEGORY_INDEX, BODY_MASK_INDEX, BODY_SENSOR_INDEX, BODY_SHAPE_INDEX } from '../components/body-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import { shapeHalfHeight, shapeHalfWidth, shapeIsEmpty, shapesOverlap } from '../math/shapes';

// How close to contact a sweep settles for, in world units: below anything a game would draw, yet reached by
// the halving below in a handful of steps.
const CONTACT_TOLERANCE = 1e-4;
// Cap on the halving so a huge move cannot spawn unbounded overlap tests; reaches the tolerance for any move
// up to ~1600 units.
const MAX_REFINEMENTS = 24;

// Holds everything with a transform and a body, not only the entities the system moves, so a mover can run
// into a wall or station that has no velocity of its own.
export const COLLIDABLE_QUERY = 'collidable';

// Blocks handed to a collision callback for the entity run into. `transform` and `body` are guaranteed by the
// collidable query; `velocity` and anything in `optional` are present only if that entity has them.
export type CollisionComponents<T extends PhysicsUpdateComponents> = Partial<T> & {
	transform: Float32Array
	body: Uint32Array
	entity?: Uint32Array
};

// The entity doing the running into: the one being updated, so everything the system asked for is present.
export interface MovingEntity<T extends PhysicsUpdateComponents> {
	entityId: number
	components: T
}

// The entity on the other side of a collision, which may be something the system never moves.
export interface CollisionEntity<T extends PhysicsUpdateComponents> {
	entityId: number
	components: CollisionComponents<T>
}

// What a game runs when one entity moves into another. Runs on the physics thread, so it is a plain function
// over the raw blocks and reaches the main thread only through `callbacks`. Called once per pair per run, right
// after the mover is put down: `self` is whichever side reached the contact first, `other` is the other. Because
// the other side gets no call of its own, a callback has to decide for both. A velocity-less entity is never
// `self` but is found as `other`.
export type CollisionFunction<C extends ComponentMap, T extends PhysicsUpdateComponents & EntityUpdateComponents<C>, W extends ComponentSystemWorld = ComponentSystemWorld> = (
	world: W,
	self: MovingEntity<T>,
	other: CollisionEntity<T>,
	queries: EntityQueryComponents<C>,
	callbacks: ComponentSystemCallbacks<C>,
) => void;

// How much of a move an entity may make and what stopped it. `fraction` is how far along it got (1 clear, 0
// already pressed against something). `blocking` is what it came to rest against - the overlap test there will
// not report it, since the two are touching; more than one entry means it wedged between them at once.
export interface SweepResult<T extends PhysicsUpdateComponents> {
	fraction: number
	blocking: Array<CollisionEntity<T>>
}

// How a move came out, as the displacement to apply rather than a fraction - a move that dropped an axis is no
// longer a scaling of the original. `blocking` is empty for a move that got where it was going.
export interface MoveResult<T extends PhysicsUpdateComponents> {
	moveX: number
	moveY: number
	blocking: Array<CollisionEntity<T>>
}

// One shared empty array for the sweeps that find nothing, rather than one per entity per run.
const NOTHING_BLOCKING: Array<never> = [];

// Packs a pair of entity ids into one key. Ids must stay under this for the key to be unique, which a pool an
// ECS can address leaves untouchable, and it keeps the product inside the safe integer range.
const MAX_PAIR_ID = 2 ** 26;

// A per-axis sweep that hit nothing: the whole axis, clear. Held once rather than rebuilt per clear axis.
const CLEAR = { fraction: 1, blocking: NOTHING_BLOCKING };

// The searching entity's blocks read out once, so a sweep testing the same pair repeatedly does not re-read
// them. x/y are where it started the move.
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
	// A sensor's move is never swept short: it passes through rather than resting against. Read once here.
	sensor: boolean
}

// One category's broadphase: every entity that collides as that category, plus an R-tree over them. A searcher
// only visits buckets its mask accepts. Bucketed on the whole category value, so an entity that collides as two
// things at once still lives in exactly one bucket and is never found twice by one search.
interface CategoryBucket<T extends PhysicsUpdateComponents> {
	category: number
	entries: Array<CollisionEntity<T>>
	index: Flatbush
}

// An R-tree over every collidable entity, built once at the top of a run and then asked, per entity as it
// moves, what it might have hit.
//
// Everything is indexed where it stood at the start of the run - the only moment all entities agree on. To stay
// a superset of what can collide, each box is grown by how far that entity could travel this run, both ways: a
// callback may turn an entity around before its own move, so a box grown only forwards would point wrong.
//
// Split by collide category so most of what an entity cannot hit is ruled out a subtree at a time. An empty
// category has no bucket, so Flatbush is never asked to index zero items.
export default class CollisionBroadphase<T extends PhysicsUpdateComponents> {
	private buckets: Array<CategoryBucket<T>> = [];
	// Whether anything in this run can bounce. Bounces are resolved for both sides of a contact, so an entity with
	// no bounciness of its own still has to look at what it ran into - but only in a world where that can matter.
	readonly hasBounciness: boolean = false;
	// The pairs already resolved this run. Lives here rather than in the update because the tree is what a run is
	// scoped to: preRun builds a new one, so the set is empty again for the next run with nothing to clear.
	private resolved = new Set<number>();

	constructor(entities: Array<{ entityId: number, components: EntityUpdateComponents }>, seconds: number) {
		// Collected per category first because Flatbush needs its item count up front, which is only known once
		// everything that cannot collide has been dropped.
		const pending = new Map<number, { entries: Array<CollisionEntity<T>>, bounds: Array<number> }>();

		for(const entity of entities) {
			// The ECS types blocks generically as ComponentTypedArray; narrow to the concrete arrays once here so
			// neither the search nor the game's callback needs a cast.
			const components = entity.components as CollisionComponents<T>;
			const transform = components.transform;
			const body = components.body;
			if(!transform || !body) {
				continue;
			}

			// No mask can name category 0, so a category-0 entity can never be the other half of a collision;
			// dropping it here is exact and is what makes `collideCategory: 0` opt out entirely.
			const category = body[BODY_CATEGORY_INDEX];
			if(category === 0) {
				continue;
			}

			const shape = body[BODY_SHAPE_INDEX];
			const width = transform[TRANSFORM_WIDTH_INDEX];
			const height = transform[TRANSFORM_HEIGHT_INDEX];
			// A shape with no area can never overlap anything; dropping it keeps a sizeless entity out of the tree.
			if(shapeIsEmpty(shape, width, height)) {
				continue;
			}

			const angle = transform[TRANSFORM_ANGLE_INDEX];
			const halfWidth = shapeHalfWidth(shape, width, height, angle);
			const halfHeight = shapeHalfHeight(shape, width, height, angle);

			if(components.bounciness) {
				this.hasBounciness = true;
			}

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

	// Claims a contact for the caller: true the first time this run sees the pair, false every time after. Both
	// sides find the same contact - one sweeping into it, the other overlapping it on its own turn - and it is
	// resolved once, by whichever got there first, so nothing is bounced or reported twice.
	claimContact(a: number, b: number): boolean {
		const key = a < b ? a * MAX_PAIR_ID + b : b * MAX_PAIR_ID + a;
		if(this.resolved.has(key)) {
			return false;
		}

		this.resolved.add(key);

		return true;
	}

	// Runs `handle` for everything `self` really overlaps, having just moved. The tree narrows the field, then
	// each candidate gets the full rotated box test against where both entities are now - which for one that has
	// not moved yet is still its start. That evens out: the pair is seen again from the other side once it moves.
	forEachOverlapping(self: MovingEntity<T>, handle: (other: CollisionEntity<T>) => void): void {
		const searcher = toSearcher(self);
		if(!searcher) {
			return;
		}

		const { x, y, halfWidth, halfHeight } = searcher;
		// Searched ungrown at where this entity ended up: every tree box already allows for its own entity's move.
		this.forEachCandidate(searcher, x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight, other => {
			if(overlapsAt(searcher, x, y, other)) {
				handle(other);
			}
		});
	}

	// How much of the move `self` may take before it runs into something. The whole move is checked in one pass
	// for what it lands on, and only then is the resting place refined - so the answer is the earliest contact
	// of the lot, not whichever candidate came up first.
	sweep(self: MovingEntity<T>, moveX: number, moveY: number): SweepResult<T> {
		const distance = Math.sqrt(moveX * moveX + moveY * moveY);
		const searcher = toSearcher(self);
		if(!searcher || distance === 0) {
			return { fraction: 1, blocking: NOTHING_BLOCKING };
		}

		const candidates = this.gatherCandidates(searcher, moveX, moveY);
		if(candidates.length === 0) {
			return { fraction: 1, blocking: NOTHING_BLOCKING };
		}

		return this.refine(searcher, candidates, moveX, moveY, distance);
	}

	// Resolves a move as the displacement to write. With `slide` off it is `sweep` in other clothes: the whole
	// move, or the swept-short part. With `slide` on, a blocked diagonal is resolved one axis at a time so an
	// entity clipping a corner keeps running along the wall instead of sticking to it. Sliding is the caller's to
	// ask for: it is wrong for a bouncing entity, which turns around rather than skating along, so bounces pass
	// `slide` off.
	resolveMove(self: MovingEntity<T>, moveX: number, moveY: number, slide: boolean): MoveResult<T> {
		const distance = Math.sqrt(moveX * moveX + moveY * moveY);
		const searcher = toSearcher(self);
		if(!searcher || distance === 0) {
			return { moveX, moveY, blocking: NOTHING_BLOCKING };
		}

		const candidates = this.gatherCandidates(searcher, moveX, moveY);
		if(candidates.length === 0) {
			return { moveX, moveY, blocking: NOTHING_BLOCKING };
		}

		// Blocked diagonal, asked to slide: resolve each axis on its own to find which one was actually blocked.
		if(slide && moveX !== 0 && moveY !== 0) {
			const xCandidates = this.gatherCandidates(searcher, moveX, 0);
			const yCandidates = this.gatherCandidates(searcher, 0, moveY);

			// Corner clip: each axis alone is clear, so only the diagonal was caught. Slide the full length of the
			// dominant axis and leave the other - advancing it would walk back into the corner.
			if(xCandidates.length === 0 && yCandidates.length === 0) {
				return Math.abs(moveX) >= Math.abs(moveY)
					? { moveX, moveY: 0, blocking: NOTHING_BLOCKING }
					: { moveX: 0, moveY, blocking: NOTHING_BLOCKING };
			}

			// At least one axis is blocked. Take each as far as it goes - a blocked one refined up to its edge, not
			// dropped to nothing - so the entity ends hard against the obstacle.
			const x = xCandidates.length === 0 ? CLEAR : this.refine(searcher, xCandidates, moveX, 0, Math.abs(moveX));
			const y = yCandidates.length === 0 ? CLEAR : this.refine(searcher, yCandidates, 0, moveY, Math.abs(moveY));

			const slidX = moveX * x.fraction;
			const slidY = moveY * y.fraction;

			// The axes were swept apart; their combination can still poke into a convex (round) obstacle neither axis
			// alone reached - sliding the full length of one axis carries the entity into the curve the other axis
			// stopped short of. Left overlapping, next run's start-overlap escape hatch would let it pass straight
			// through, so the combined slide is checked against where it actually lands and refined to contact if it
			// overlaps. A box slide ends touching an axis-aligned face and finds nothing here.
			if(slidX !== 0 && slidY !== 0) {
				const slidCandidates = this.gatherCandidates(searcher, slidX, slidY);
				if(slidCandidates.length > 0) {
					const rest = this.refine(searcher, slidCandidates, slidX, slidY, Math.sqrt(slidX * slidX + slidY * slidY));

					return { moveX: slidX * rest.fraction, moveY: slidY * rest.fraction, blocking: rest.blocking };
				}
			}

			return { moveX: slidX, moveY: slidY, blocking: mergeBlocking(x.blocking, y.blocking) };
		}

		// Not sliding, or a straight move: come to rest where it stops.
		const rest = this.refine(searcher, candidates, moveX, moveY, distance);

		return { moveX: moveX * rest.fraction, moveY: moveY * rest.fraction, blocking: rest.blocking };
	}

	// The cheap half of a sweep: everything the move would land on, tested only where it ends. That keeps a clear
	// move - nearly every move - to one shape test per candidate. The trade is that a move long enough to carry
	// an entity clean past something is not stopped by it, which a fixed `deltaBetweenRuns` rules out.
	private gatherCandidates(searcher: Searcher, moveX: number, moveY: number): Array<CollisionEntity<T>> {
		const { x, y, halfWidth, halfHeight } = searcher;

		// A sensor's move is blocked by nothing; it is still reported by forEachOverlapping, but never gathered.
		if(searcher.sensor) {
			return [];
		}

		const endX = x + moveX;
		const endY = y + moveY;

		const candidates: Array<CollisionEntity<T>> = [];
		this.forEachCandidate(searcher, endX - halfWidth, endY - halfHeight, endX + halfWidth, endY + halfHeight, other => {
			if(!overlapsAt(searcher, endX, endY, other)) {
				return;
			}

			// A sensor blocks nothing: a solid mover passes through it, left to the overlap callback.
			if(other.components.body[BODY_SENSOR_INDEX] !== 0) {
				return;
			}

			// Already inside it before the move began: it is not what this move ran into, and blocking on it would
			// pin the entity inside with no way out. Let the move through and leave the pair to the overlap callback.
			if(overlapsAt(searcher, x, y, other)) {
				return;
			}

			candidates.push(other);
		});

		return candidates;
	}

	// The expensive half: the move is known to stop short, and this finds where by halving between a `clear`
	// fraction and a `blocked` one. Contact is halved in on rather than solved - three shapes at any rotation
	// have no single first-touch formula - and the result is always taken from a position that tested clear.
	private refine(searcher: Searcher, candidates: Array<CollisionEntity<T>>, moveX: number, moveY: number, distance: number): SweepResult<T> {
		const { x, y } = searcher;
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

		// Whatever is in the way at the first blocked position: the entity rests a hair short of it.
		const blocking: Array<CollisionEntity<T>> = [];
		const blockedX = x + moveX * blocked;
		const blockedY = y + moveY * blocked;
		for(const other of candidates) {
			if(overlapsAt(searcher, blockedX, blockedY, other)) {
				blocking.push(other);
			}
		}

		// An entity already against something is left exactly where it is, rather than crawling a sub-tolerance
		// step forward every run and reporting a position change for no visible move.
		return { fraction: clear * distance > CONTACT_TOLERANCE ? clear : 0, blocking };
	}

	// Whether `self` would be inside any of `candidates` that far along its move. The position is rounded to
	// float32 - what `move` actually stores into the shared transform - so the resting place this settles on is
	// still clear once stored, not a hair inside. Otherwise a float32 nudge into overlap would trip the
	// start-overlap escape hatch next run and let the entity pass straight through what it came to rest against.
	private blockedAt(searcher: Searcher, candidates: Array<CollisionEntity<T>>, moveX: number, moveY: number, fraction: number): boolean {
		const x = Math.fround(searcher.x + moveX * fraction);
		const y = Math.fround(searcher.y + moveY * fraction);
		for(const other of candidates) {
			if(overlapsAt(searcher, x, y, other)) {
				return true;
			}
		}

		return false;
	}

	// Runs `handle` for every collidable entity in the box that `searcher` may collide with: the tree search and
	// the category masks, applied before any shape test so an impossible pair is settled by two ANDs.
	private forEachCandidate(searcher: Searcher, minX: number, minY: number, maxX: number, maxY: number, handle: (other: CollisionEntity<T>) => void): void {
		for(const bucket of this.buckets) {
			// Half of canCollide, settled once per bucket: all entries share this category.
			if((searcher.mask & bucket.category) === 0) {
				continue;
			}

			for(const found of bucket.index.search(minX, minY, maxX, maxY)) {
				const other = bucket.entries[found];
				if(other.entityId === searcher.entityId) {
					continue;
				}

				// The other half of canCollide, per candidate: each entity carries its own mask.
				if((other.components.body[BODY_MASK_INDEX] & searcher.category) === 0) {
					continue;
				}

				// Already killed this run, or by another worker sharing this block.
				if(other.components.entity?.[DEAD_INDEX] === 1) {
					continue;
				}

				handle(other);
			}
		}
	}
}

// Merges what stopped each axis of a slide, without repeating an entity that stopped both. Either side empty is
// the common case, so it is handed straight back rather than copied.
function mergeBlocking<T extends PhysicsUpdateComponents>(a: Array<CollisionEntity<T>>, b: Array<CollisionEntity<T>>): Array<CollisionEntity<T>> {
	if(a.length === 0) {
		return b;
	}
	if(b.length === 0) {
		return a;
	}

	const merged = [...a];
	for(const other of b) {
		if(!merged.some(entry => entry.entityId === other.entityId)) {
			merged.push(other);
		}
	}

	return merged;
}

// Reads what a searching entity is measured by, or undefined for one that cannot collide.
function toSearcher<T extends PhysicsUpdateComponents>(self: MovingEntity<T>): Searcher | undefined {
	// No body means no collisions, though the system can still move it - the move query does not require a body.
	const body = self.components.body;
	if(!body) {
		return undefined;
	}

	// Mask 0 runs into nothing, so no bucket is worth searching. This only stops it finding a collision; something
	// whose mask accepts it can still find this one, an asymmetry the symmetric canCollide rule then rules out.
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
		sensor: body[BODY_SENSOR_INDEX] !== 0,
	};
}

// Whether the searcher, put down at (x, y) rather than its own block's position, overlaps `other`. Taking the
// position as arguments lets a sweep try a whole path without writing any of it.
function overlapsAt<T extends PhysicsUpdateComponents>(searcher: Searcher, x: number, y: number, other: CollisionEntity<T>): boolean {
	const transform = other.components.transform;

	return shapesOverlap(
		searcher.shape, x, y, searcher.width, searcher.height, searcher.angle,
		other.components.body[BODY_SHAPE_INDEX],
		transform[TRANSFORM_X_INDEX], transform[TRANSFORM_Y_INDEX],
		transform[TRANSFORM_WIDTH_INDEX], transform[TRANSFORM_HEIGHT_INDEX], transform[TRANSFORM_ANGLE_INDEX],
	);
}
