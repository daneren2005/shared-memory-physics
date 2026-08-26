import type SharedSpatialMap from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import { DEAD_INDEX } from '@daneren2005/shared-memory-ecs';
import type { ComponentMap, ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import type { PhysicsUpdateComponents } from '../components/registry';
import { BODY_CATEGORY_INDEX, BODY_MASK_INDEX, bodyShape, isContinuous, isDying, isSensor, SHAPE_CAPSULE, SHAPE_RECTANGLE } from '../components/body-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { shapeHalfHeight, shapeHalfWidth, shapeIsEmpty, shapeRadius, shapesOverlap } from '../math/shapes';

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

// The minimal read of the searching side a shape test needs: a body to be measured as, at a transform. Looser
// than MovingEntity - no component map - so the geometry helpers below serve both the sweep and `contactPoint`,
// which death interpolation calls with whichever side of a collision was fatal.
interface ContactSource {
	entityId: number
	components: { transform: Float32Array, body?: Uint32Array }
}
// The other side of a shape test: only ever a body at a transform is looked at, so this is all that is required.
// CollisionEntity satisfies it, as does anything else carrying the two blocks.
interface ContactTarget {
	components: { transform: Float32Array, body: Uint32Array }
}

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
	ccd: boolean
}

// A collision view over the world's live SharedSpatialMap, asked per entity what it might have hit.
//
// Entries update after each move on the same physics worker, so every query uses current map membership.
//
export default class CollisionBroadphase<T extends PhysicsUpdateComponents> {
	private map: SharedSpatialMap;
	private candidateIds: Array<number> = [];
	private entries = new Map<number, CollisionEntity<T>>();
	// Whether anything in this run can bounce. Bounces are resolved for both sides of a contact, so an entity with
	// no bounciness of its own still has to look at what it ran into - but only in a world where that can matter.
	readonly hasBounciness: boolean = false;
	// The pairs already resolved this run. Lives here rather than in the update because this view is what a run is
	// scoped to: preRun builds a new one, so the set is empty again for the next run with nothing to clear.
	private resolved = new Set<number>();

	constructor(map: SharedSpatialMap, entities: Array<{ entityId: number, components: EntityUpdateComponents }>) {
		this.map = map;
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

			const shape = bodyShape(body);
			const width = transform[TRANSFORM_WIDTH_INDEX];
			const height = transform[TRANSFORM_HEIGHT_INDEX];
			// A shape with no area can never overlap anything; dropping it keeps it out of this run's collision view.
			if(shapeIsEmpty(shape, width, height)) {
				continue;
			}

			if(components.bounciness) {
				this.hasBounciness = true;
			}

			this.entries.set(entity.entityId, { entityId: entity.entityId, components });
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
	//
	// `moveX`/`moveY` is the move this entity just took, so a continuous-collision body can be tested along the way
	forEachOverlapping(self: MovingEntity<T>, handle: (other: CollisionEntity<T>) => void, moveX = 0, moveY = 0): void {
		const searcher = toSearcher(self);
		if(!searcher) {
			return;
		}

		const { x, y, halfWidth, halfHeight } = searcher;

		if(searcher.ccd && (moveX !== 0 || moveY !== 0)) {
			const startX = x - moveX;
			const startY = y - moveY;
			const minX = Math.min(startX, x) - halfWidth;
			const minY = Math.min(startY, y) - halfHeight;
			const maxX = Math.max(startX, x) + halfWidth;
			const maxY = Math.max(startY, y) + halfHeight;
			this.forEachCandidate(searcher, minX, minY, maxX, maxY, other => {
				if(sweptOverlaps(searcher, startX, startY, moveX, moveY, other)) {
					handle(other);
				}
			});

			return;
		}

		// Searched ungrown at where this entity ended up: every tree box already allows for its own entity's move.
		this.forEachCandidate(searcher, x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight, other => {
			if(overlapsAt(searcher, x, y, other)) {
				handle(other);
			}
		});
	}

	// Where `self`'s centre sits the moment it first touches `other`, along the move it just took (moveX, moveY).
	// Used by death interpolation to end a dying entity's last segment exactly on the thing it hit, rather than
	// wherever its step happened to land - which for a fast continuous body is a stride past the target. `self`'s
	// transform is read after the move, so the start it sweeps from is reconstructed as (end - move). Falls back to
	// the current position for an entity that cannot collide or did not move.
	contactPoint(self: ContactSource, other: ContactTarget, moveX: number, moveY: number): { x: number, y: number } {
		const transform = self.components.transform;
		const endX = transform[TRANSFORM_X_INDEX];
		const endY = transform[TRANSFORM_Y_INDEX];
		const distance = Math.sqrt(moveX * moveX + moveY * moveY);
		const searcher = toSearcher(self);
		if(!searcher || distance === 0) {
			return { x: endX, y: endY };
		}

		searcher.x = endX - moveX;
		searcher.y = endY - moveY;
		const fraction = this.entryFraction(searcher, other, moveX, moveY, distance);

		return { x: searcher.x + moveX * fraction, y: searcher.y + moveY * fraction };
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

		if(searcher.ccd) {
			return this.sweepContinuous(searcher, moveX, moveY, distance);
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

		// A continuous body comes straight to rest at its first contact, never sliding: sliding is for a steered
		// character clipping a corner at walking pace, not the fast thing ccd is switched on for, and the swept
		// path is a single decision over the whole move rather than one refined per axis.
		if(searcher.ccd) {
			const rest = this.sweepContinuous(searcher, moveX, moveY, distance);

			return { moveX: moveX * rest.fraction, moveY: moveY * rest.fraction, blocking: rest.blocking };
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
			if(isSensor(other.components.body)) {
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

	// The continuous counterpart to gatherCandidates: everything the move sweeps *across*, not only what it ends
	// on, so a step long enough to fly clean past something still gathers it. Costs the swept-shape test per
	// candidate, which is why it is a body's own opt-in rather than the default.
	private gatherContinuousCandidates(searcher: Searcher, moveX: number, moveY: number): Array<CollisionEntity<T>> {
		// A sensor is stopped by nothing; its overlaps are still reported by forEachOverlapping, never gathered here.
		if(searcher.sensor) {
			return [];
		}

		const { x, y, halfWidth, halfHeight } = searcher;
		const endX = x + moveX;
		const endY = y + moveY;

		const candidates: Array<CollisionEntity<T>> = [];
		this.forEachCandidate(searcher, Math.min(x, endX) - halfWidth, Math.min(y, endY) - halfHeight, Math.max(x, endX) + halfWidth, Math.max(y, endY) + halfHeight, other => {
			// A sensor blocks nothing: a solid mover passes through it, left to the overlap callback.
			if(isSensor(other.components.body)) {
				return;
			}

			// Already inside it before the move began: not what this move ran into, and blocking on it would pin the
			// entity there. Let the move through and leave the pair to the overlap callback.
			if(overlapsAt(searcher, x, y, other)) {
				return;
			}

			if(sweptOverlaps(searcher, x, y, moveX, moveY, other)) {
				candidates.push(other);
			}
		});

		return candidates;
	}

	// A continuous move's resting place: the earliest contact of everything it swept across. Each candidate's own
	// entry fraction is found and the whole move stops at the smallest of them - the near obstacle, not whichever
	// the tree happened to turn up first.
	private sweepContinuous(searcher: Searcher, moveX: number, moveY: number, distance: number): SweepResult<T> {
		const candidates = this.gatherContinuousCandidates(searcher, moveX, moveY);
		if(candidates.length === 0) {
			return { fraction: 1, blocking: NOTHING_BLOCKING };
		}

		let earliest = 1;
		let blocking: Array<CollisionEntity<T>> = [];
		const tolerance = CONTACT_TOLERANCE / distance;
		for(const other of candidates) {
			const fraction = this.entryFraction(searcher, other, moveX, moveY, distance);
			if(fraction < earliest - tolerance) {
				earliest = fraction;
				blocking = [other];
			} else if(fraction <= earliest + tolerance) {
				blocking.push(other);
			}
		}

		// An entity already against something is left exactly where it is rather than creeping a sub-tolerance step
		// forward every run, same as refine.
		return { fraction: earliest * distance > CONTACT_TOLERANCE ? earliest : 0, blocking };
	}

	// The fraction of its move at which `searcher` first touches `other`, halved in the way refine does. What refine
	// cannot assume here is that the far end is blocked: a continuous move may pass clean through, clear at both
	// ends, so the blocked bracket is seeded from where the two centres pass closest - which for convex shapes that
	// really cross lies inside the overlap - rather than from the end of the move.
	private entryFraction(searcher: Searcher, other: ContactTarget, moveX: number, moveY: number, distance: number): number {
		let blocked: number;
		if(this.blockedAtOne(searcher, other, moveX, moveY, 1)) {
			blocked = 1;
		} else {
			const transform = other.components.transform;
			const toX = transform[TRANSFORM_X_INDEX] - searcher.x;
			const toY = transform[TRANSFORM_Y_INDEX] - searcher.y;
			const closest = clamp01((toX * moveX + toY * moveY) / (distance * distance));
			// The swept shape crossed the candidate but the centres' closest pass is not itself an overlap (a
			// glancing hit off the centre line): stop there rather than search on. It rests a hair early at worst,
			// which never tunnels.
			if(!this.blockedAtOne(searcher, other, moveX, moveY, closest)) {
				return closest;
			}

			blocked = closest;
		}

		let clear = 0;
		const tolerance = CONTACT_TOLERANCE / distance;
		for(let i = 0; i < MAX_REFINEMENTS && blocked - clear > tolerance; i++) {
			const middle = (clear + blocked) / 2;
			if(this.blockedAtOne(searcher, other, moveX, moveY, middle)) {
				blocked = middle;
			} else {
				clear = middle;
			}
		}

		return clear;
	}

	// blockedAt for a single candidate, so the continuous refinement halves without allocating a one-item array per
	// step. The position is rounded to float32 for the same reason blockedAt is - the resting place must stay clear
	// once stored to the shared transform.
	private blockedAtOne(searcher: Searcher, other: ContactTarget, moveX: number, moveY: number, fraction: number): boolean {
		return overlapsAt(searcher, Math.fround(searcher.x + moveX * fraction), Math.fround(searcher.y + moveY * fraction), other);
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
		const ids = this.candidateIds;
		ids.length = 0;
		this.map.retrieveInto(ids, minX, minY, maxX - minX, maxY - minY);
		for(const id of ids) {
			const other = this.entries.get(id);
			if(!other || other.entityId === searcher.entityId) {
				continue;
			}

			const body = other.components.body;
			if((searcher.mask & body[BODY_CATEGORY_INDEX]) === 0 || (body[BODY_MASK_INDEX] & searcher.category) === 0) {
				continue;
			}

			if(other.components.entity?.[DEAD_INDEX] === 1 || isDying(body)) {
				continue;
			}

			handle(other);
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
function toSearcher(self: ContactSource): Searcher | undefined {
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
	const shape = bodyShape(body);
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
		sensor: isSensor(body),
		ccd: isContinuous(body),
	};
}

// Whether `searcher`, swept from (startX, startY) along (moveX, moveY), crosses `other` anywhere along the way -
// the single extra test a continuous-collision body pays per candidate. Each shape sweeps to one covering shape:
//   rectangle - an oriented box holding its start, its end, and everything between, since a box that does not turn
//               as it moves just slides in its own frame and the region it covers is itself grown by that slide.
//   circle    - a capsule down the centre path, which is exactly a moving circle's swept region.
//   capsule   - that same path capsule, plus its own destination shape for the far end of the pill the straight
//               path capsule falls short of.
// Every shape's region is a superset of the true swept area, so a contact is only ever reported early, never
// missed - which is the whole point of turning ccd on.
function sweptOverlaps(searcher: Searcher, startX: number, startY: number, moveX: number, moveY: number, other: ContactTarget): boolean {
	const endX = startX + moveX;
	const endY = startY + moveY;
	const transform = other.components.transform;
	const otherShape = bodyShape(other.components.body);
	const otherX = transform[TRANSFORM_X_INDEX];
	const otherY = transform[TRANSFORM_Y_INDEX];
	const otherWidth = transform[TRANSFORM_WIDTH_INDEX];
	const otherHeight = transform[TRANSFORM_HEIGHT_INDEX];
	const otherAngle = transform[TRANSFORM_ANGLE_INDEX];

	if(searcher.shape === SHAPE_RECTANGLE) {
		// The move measured in the box's own frame, where the box is axis aligned and merely slides by it. Growing
		// each side by that slide over-covers the two corners the slid hexagon leaves open, which reports early, not
		// short.
		const cos = Math.cos(searcher.angle);
		const sin = Math.sin(searcher.angle);
		const localX = moveX * cos + moveY * sin;
		const localY = -moveX * sin + moveY * cos;

		return shapesOverlap(
			SHAPE_RECTANGLE, (startX + endX) / 2, (startY + endY) / 2,
			searcher.width + Math.abs(localX), searcher.height + Math.abs(localY), searcher.angle,
			otherShape, otherX, otherY, otherWidth, otherHeight, otherAngle,
		);
	}

	// A capsule of the mover's own radius laid down the centre path: width is the path length plus a cap at each
	// end, height the full thickness. For a circle that is the exact swept region; for a capsule the destination
	// test below adds back the length of the pill it does not cover.
	const radius = shapeRadius(searcher.shape, searcher.width, searcher.height);
	const distance = Math.sqrt(moveX * moveX + moveY * moveY);
	const pathAngle = distance > 0 ? Math.atan2(moveY, moveX) : searcher.angle;
	const alongPath = shapesOverlap(
		SHAPE_CAPSULE, (startX + endX) / 2, (startY + endY) / 2, distance + radius * 2, radius * 2, pathAngle,
		otherShape, otherX, otherY, otherWidth, otherHeight, otherAngle,
	);
	if(alongPath) {
		return true;
	}

	return shapesOverlap(
		searcher.shape, endX, endY, searcher.width, searcher.height, searcher.angle,
		otherShape, otherX, otherY, otherWidth, otherHeight, otherAngle,
	);
}

// [0, 1] clamp for the closest-approach fraction; the shapes helper keeps its own copy unexported.
function clamp01(value: number): number {
	if(value < 0) {
		return 0;
	} else if(value > 1) {
		return 1;
	}

	return value;
}

// Whether the searcher, put down at (x, y) rather than its own block's position, overlaps `other`. Taking the
// position as arguments lets a sweep try a whole path without writing any of it.
function overlapsAt(searcher: Searcher, x: number, y: number, other: ContactTarget): boolean {
	const transform = other.components.transform;

	return shapesOverlap(
		searcher.shape, x, y, searcher.width, searcher.height, searcher.angle,
		bodyShape(other.components.body),
		transform[TRANSFORM_X_INDEX], transform[TRANSFORM_Y_INDEX],
		transform[TRANSFORM_WIDTH_INDEX], transform[TRANSFORM_HEIGHT_INDEX], transform[TRANSFORM_ANGLE_INDEX],
	);
}
