import CollisionBroadphase, { type MoveResult, type MovingEntity, type SweepResult } from '../collision';
import type { PhysicsUpdateComponents } from '../../components/registry';
import {
	BODY_CATEGORY_INDEX, BODY_MASK_INDEX, BODY_SENSOR_INDEX, BODY_SHAPE_INDEX, BODY_SIZE,
	DEFAULT_COLLIDE_CATEGORY, DEFAULT_COLLIDE_MASK,
	SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE,
} from '../../components/body-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_SIZE, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';
import { VELOCITY_SIZE, VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../../components/velocity-component';

const ONE_SECOND = 1;

// The kind of categories a game defines for itself - the library only ever reads them as bits, so these live
// here in the tests rather than in the library.
const GROUND = 1 << 0;
const AIR = 1 << 1;
const PROJECTILE = 1 << 2;

interface Box {
	x: number
	y: number
	width?: number
	height?: number
	angle?: number
	velocityX?: number
	velocityY?: number
	shape?: number
	collideCategory?: number
	collideMask?: number
	sensor?: boolean
}

// The blocks one entity would arrive at the worker with.  Boxes are 10x10, still, and collide with everything
// unless the test says otherwise, so most of them only have to say where they are.
function createEntity(box: Box, entityId: number): MovingEntity<PhysicsUpdateComponents> {
	const transform = new Float32Array(TRANSFORM_SIZE);
	transform[TRANSFORM_X_INDEX] = box.x;
	transform[TRANSFORM_Y_INDEX] = box.y;
	transform[TRANSFORM_WIDTH_INDEX] = box.width ?? 10;
	transform[TRANSFORM_HEIGHT_INDEX] = box.height ?? 10;
	transform[TRANSFORM_ANGLE_INDEX] = box.angle ?? 0;

	const velocity = new Float32Array(VELOCITY_SIZE);
	velocity[VELOCITY_X_INDEX] = box.velocityX ?? 0;
	velocity[VELOCITY_Y_INDEX] = box.velocityY ?? 0;

	const body = new Uint32Array(BODY_SIZE);
	body[BODY_SHAPE_INDEX] = box.shape ?? SHAPE_RECTANGLE;
	body[BODY_CATEGORY_INDEX] = box.collideCategory ?? DEFAULT_COLLIDE_CATEGORY;
	body[BODY_MASK_INDEX] = box.collideMask ?? DEFAULT_COLLIDE_MASK;
	body[BODY_SENSOR_INDEX] = box.sensor ? 1 : 0;

	return { entityId, components: { transform, velocity, body } };
}

// The collidable query a PhysicsSystem would send, one entry per box, keyed by its position in the list + 1
// as its entity id.
function createEntities(boxes: Array<Box>): Array<MovingEntity<PhysicsUpdateComponents>> {
	return boxes.map((box, index) => createEntity(box, index + 1));
}

function build(entities: Array<MovingEntity<PhysicsUpdateComponents>>, seconds = 0): CollisionBroadphase<PhysicsUpdateComponents> {
	return new CollisionBroadphase<PhysicsUpdateComponents>(entities, seconds);
}

function overlapping(broadphase: CollisionBroadphase<PhysicsUpdateComponents>, self: MovingEntity<PhysicsUpdateComponents>): Array<number> {
	const found: Array<number> = [];
	broadphase.forEachOverlapping(self, other => found.push(other.entityId));

	return found.sort((first, second) => first - second);
}

// The entities a sweep came to rest against, which the overlap check at that resting place never reports: the
// whole point of stopping there is that the two are touching rather than through each other.
function blocking(result: SweepResult<PhysicsUpdateComponents> | MoveResult<PhysicsUpdateComponents>): Array<number> {
	return result.blocking.map(other => other.entityId).sort((first, second) => first - second);
}

// Everything the entity at `entityId` is on top of, over a broadphase built from those same boxes - the case
// where nothing has moved since the tree was built.
function hits(boxes: Array<Box>, entityId: number): Array<number> {
	const entities = createEntities(boxes);

	return overlapping(build(entities), entities[entityId - 1]);
}

describe('collision-broadphase', () => {
	it('finds an entity sitting on top of it', () => {
		expect(hits([{ x: 0, y: 0 }, { x: 5, y: 0 }], 1)).toEqual([2]);
	});

	it('finds nothing when they are apart', () => {
		expect(hits([{ x: 0, y: 0 }, { x: 50, y: 0 }], 1)).toEqual([]);
		expect(hits([{ x: 0, y: 0 }, { x: 0, y: 50 }], 1)).toEqual([]);
	});

	it('never finds the entity itself', () => {
		expect(hits([{ x: 0, y: 0 }], 1)).toEqual([]);
	});

	it('is asked from each side separately', () => {
		// The pair is one call for the entity that moved into the other, and another when the other moves - not
		// a single call for the two of them.
		const boxes: Array<Box> = [{ x: 0, y: 0 }, { x: 5, y: 0 }];
		expect(hits(boxes, 1)).toEqual([2]);
		expect(hits(boxes, 2)).toEqual([1]);
	});

	it('finds everything in a pile', () => {
		expect(hits([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }], 1)).toEqual([2, 3]);
		// 2 reaches both of the others; 1 and 3 are 8 apart and only reach 2.
		expect(hits([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }], 2)).toEqual([1, 3]);
	});

	it('ignores an entity the game never gave a size', () => {
		expect(hits([{ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 0 }], 1)).toEqual([]);
		expect(hits([{ x: 0, y: 0 }, { x: 0, y: 0, width: 10, height: 0 }], 1)).toEqual([]);
	});

	it('finds nothing for an entity that has no size of its own', () => {
		expect(hits([{ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0 }], 1)).toEqual([]);
	});

	it('does not count entities that only just touch', () => {
		expect(hits([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1)).toEqual([]);
		expect(hits([{ x: 0, y: 0 }, { x: 9.99, y: 0 }], 1)).toEqual([2]);
	});

	it('measures each box out from its centre', () => {
		// 8 apart with 10 of width each: they overlap by 2 from their centres, and would not touch at all if x/y
		// were a corner.
		expect(hits([{ x: 0, y: 0 }, { x: 8, y: 0 }], 1)).toEqual([2]);
	});

	it('follows a box that has been turned', () => {
		const bar = { width: 2, height: 10 };
		// Two upright bars 5 apart miss each other...
		expect(hits([{ x: 0, y: 0, ...bar }, { x: 5, y: 0, ...bar }], 1)).toEqual([]);
		// ...until one is laid on its side and its long edge crosses the gap.
		expect(hits([{ x: 0, y: 0, ...bar }, { x: 5, y: 0, ...bar, angle: Math.PI / 2 }], 1)).toEqual([2]);
	});

	it('does not report a turned box the tree alone would', () => {
		// The tree only ever narrows the field: the square on its corner reaches about 7.07 along each axis, so
		// the search finds the small box, and then the full test throws it out.
		expect(hits([{ x: 0, y: 0, angle: Math.PI / 4 }, { x: 6.5, y: 6.5, width: 2, height: 2 }], 1)).toEqual([]);
		expect(hits([{ x: 0, y: 0 }, { x: 5.5, y: 5.5, width: 2, height: 2 }], 1)).toEqual([2]);
	});

	it('finds nothing when there is nothing collidable', () => {
		const alone = createEntity({ x: 0, y: 0 }, 1);

		// Flatbush will not build an index over no items at all, so this is the case that has to not blow up.
		expect(overlapping(build([]), alone)).toEqual([]);
	});

	it('hands over the blocks to write back through', () => {
		const entities = createEntities([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
		const broadphase = build(entities);

		broadphase.forEachOverlapping(entities[0], other => {
			other.components.velocity![VELOCITY_X_INDEX] = -1;
		});

		expect(entities[1].components.velocity[VELOCITY_X_INDEX]).toEqual(-1);
	});

	// The broadphase has to index and test each entity as the shape its body says it is, not as the rectangle its
	// width and height would otherwise describe.
	describe('body shapes', () => {
		it('rounds off the corner a rectangle of the same size would keep', () => {
			// Both are 10 wide and offset along the diagonal, so the boxes are still through each other while the
			// circles have come apart - which only holds if the narrowphase ran the circle test.
			const circles = { shape: SHAPE_CIRCLE, width: 10, height: 10 };
			expect(hits([{ x: 0, y: 0, ...circles }, { x: 8, y: 8, ...circles }], 1)).toEqual([]);
			expect(hits([{ x: 0, y: 0, width: 10, height: 10 }, { x: 8, y: 8, width: 10, height: 10 }], 1)).toEqual([2]);
		});

		it('reaches along the length of a capsule', () => {
			// 40 from end to end, so its cap reaches x = 20 - just onto a small box at 20.5, and nowhere near one
			// pushed out to 30.
			const capsule = { shape: SHAPE_CAPSULE, width: 40, height: 10 };
			const target = { width: 2, height: 2 };
			expect(hits([{ x: 0, y: 0, ...capsule }, { x: 20.5, y: 0, ...target }], 1)).toEqual([2]);
			expect(hits([{ x: 0, y: 0, ...capsule }, { x: 30, y: 0, ...target }], 1)).toEqual([]);
		});

		it('turns a capsule with the entity', () => {
			const capsule = { shape: SHAPE_CAPSULE, width: 40, height: 10 };
			const target = { x: 0, y: 18, width: 2, height: 2 };
			// Lying along x it does not come close to something 18 above it...
			expect(hits([{ x: 0, y: 0, ...capsule }, target], 1)).toEqual([]);
			// ...but stood upright it reaches straight up to it, which needs the tree to have indexed it upright too.
			expect(hits([{ x: 0, y: 0, ...capsule, angle: Math.PI / 2 }, target], 1)).toEqual([2]);
		});

		it('indexes a circle by its own width rather than its height', () => {
			// A circle is its width and takes no notice of its height, so this one is 40 across however short its
			// height says it is.  Indexing it as the 40x10 rectangle would leave it 5 tall in the tree and cut off
			// the entity above it before the narrowphase ever saw the pair.
			const circle = { shape: SHAPE_CIRCLE, width: 40, height: 10 };
			expect(hits([{ x: 0, y: 0, ...circle }, { x: 0, y: 18, width: 2, height: 2 }], 1)).toEqual([2]);
		});

		it('still collides a circle whose height was never set', () => {
			// Which of the two sizes makes a shape empty depends on the shape: a circle with no height is a perfectly
			// good circle, while a rectangle with no height is nothing at all.
			expect(hits([{ x: 0, y: 0, shape: SHAPE_CIRCLE, width: 10, height: 0 }, { x: 5, y: 0 }], 1)).toEqual([2]);
			expect(hits([{ x: 0, y: 0, width: 10, height: 0 }, { x: 5, y: 0 }], 1)).toEqual([]);
		});

		it('drops a capsule with no thickness', () => {
			expect(hits([{ x: 0, y: 0, shape: SHAPE_CAPSULE, width: 40, height: 0 }, { x: 5, y: 0 }], 1)).toEqual([]);
		});
	});

	// Which entities are allowed to collide at all, on top of whether their boxes happen to overlap.  Every box
	// in here is sitting right on top of every other, so anything that is not reported was ruled out by the
	// categories rather than by the geometry.
	describe('collide categories', () => {
		it('collides everything with everything by default', () => {
			expect(hits([{ x: 0, y: 0 }, { x: 5, y: 0 }], 1)).toEqual([2]);
		});

		// The case the whole feature exists for: ground units pass straight through air units, while a ranged
		// attack from one of those ground units can hit either.
		const groundUnit = { collideCategory: GROUND, collideMask: GROUND | PROJECTILE };
		const airUnit = { collideCategory: AIR, collideMask: AIR | PROJECTILE };
		const rangedAttack = { collideCategory: PROJECTILE, collideMask: GROUND | AIR };

		it('does not collide a ground unit with an air unit', () => {
			const boxes = [{ x: 0, y: 0, ...groundUnit }, { x: 5, y: 0, ...airUnit }];

			expect(hits(boxes, 1)).toEqual([]);
			expect(hits(boxes, 2)).toEqual([]);
		});

		it('still collides a ground unit with another ground unit', () => {
			expect(hits([{ x: 0, y: 0, ...groundUnit }, { x: 5, y: 0, ...groundUnit }], 1)).toEqual([2]);
		});

		it('collides a ranged attack with either a ground or an air unit', () => {
			const boxes = [{ x: 0, y: 0, ...rangedAttack }, { x: 5, y: 0, ...groundUnit }, { x: 5, y: 5, ...airUnit }];

			expect(hits(boxes, 1)).toEqual([2, 3]);
			// And from the units' side, since the rule is symmetric: whichever one moves reports the pair.
			expect(hits(boxes, 2)).toEqual([1]);
			expect(hits(boxes, 3)).toEqual([1]);
		});

		it('does not collide two ranged attacks with each other', () => {
			// Neither one's mask names PROJECTILE, so they pass through one another on the way to their targets.
			expect(hits([{ x: 0, y: 0, ...rangedAttack }, { x: 5, y: 0, ...rangedAttack }], 1)).toEqual([]);
		});

		// The rule is symmetric, so both sides have to agree: one entity being willing is not enough.  It is the
		// thing to remember when setting masks up - a unit that should be hit by projectiles has to name
		// projectiles in its own mask, not just rely on the projectile naming it.
		it('needs both sides to accept each other', () => {
			const willing = { collideCategory: GROUND, collideMask: GROUND | AIR };
			const unwilling = { collideCategory: AIR, collideMask: AIR };
			const boxes = [{ x: 0, y: 0, ...willing }, { x: 5, y: 0, ...unwilling }];

			expect(hits(boxes, 1)).toEqual([]);
			expect(hits(boxes, 2)).toEqual([]);
		});

		it('collides nothing with a category of 0', () => {
			// No mask can name category 0, so this is how a game opts an entity out of collisions entirely.
			const boxes = [{ x: 0, y: 0 }, { x: 5, y: 0, collideCategory: 0 }];

			expect(hits(boxes, 1)).toEqual([]);
			expect(hits(boxes, 2)).toEqual([]);
		});

		it('collides nothing with a mask of 0', () => {
			// The other way to opt out, and symmetric in the same way: it neither finds anything nor is found.
			const boxes = [{ x: 0, y: 0 }, { x: 5, y: 0, collideMask: 0 }];

			expect(hits(boxes, 1)).toEqual([]);
			expect(hits(boxes, 2)).toEqual([]);
		});

		it('reports an entity that collides as several things at once only once', () => {
			// The tree is bucketed by category, so an entity whose category has more than one bit set has to end
			// up in exactly one bucket - or a searcher accepting both bits would find it twice for one overlap.
			const amphibious = { collideCategory: GROUND | AIR, collideMask: DEFAULT_COLLIDE_MASK };

			expect(hits([{ x: 0, y: 0, ...rangedAttack }, { x: 5, y: 0, ...amphibious }], 1)).toEqual([2]);
		});

		it('collides across separate categories in one search', () => {
			// Three different categories means three buckets, and a mask that accepts them all has to search
			// every one of them rather than stopping at the first.
			const boxes = [
				{ x: 0, y: 0, ...rangedAttack, collideMask: GROUND | AIR | PROJECTILE },
				{ x: 2, y: 0, ...groundUnit },
				{ x: 4, y: 0, ...airUnit },
				{ x: 6, y: 0, ...rangedAttack, collideMask: PROJECTILE },
			];

			expect(hits(boxes, 1)).toEqual([2, 3, 4]);
		});

		it('ignores an entity that has no body at all', () => {
			const entities = createEntities([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
			// A body is what makes an entity collidable, so without one it drops out of the tree entirely.
			delete entities[1].components.body;

			expect(overlapping(build(entities), entities[0])).toEqual([]);
		});

		it('finds nothing for an entity that has no body of its own', () => {
			const entities = createEntities([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
			delete entities[0].components.body;

			expect(overlapping(build(entities), entities[0])).toEqual([]);
		});
	});

	// The tree is built before anything moves, so the boxes in it have to allow for the ground every entity is
	// about to cover - otherwise a pair that only meets part way through the run is never even looked at.
	describe('allowing for movement', () => {
		// Two entities closing head on at 40 a second from 80 apart, which puts them both at x = 40 when the run
		// is out.  Moves the blocks the way the update would, then asks what the first one landed on.
		function closeIn(seconds: number): Array<number> {
			const entities = createEntities([
				{ x: 0, y: 0, velocityX: 40 },
				{ x: 80, y: 0, velocityX: -40 },
			]);
			const broadphase = build(entities, seconds);

			entities[0].components.transform[TRANSFORM_X_INDEX] = 40;
			entities[1].components.transform[TRANSFORM_X_INDEX] = 40;

			return overlapping(broadphase, entities[0]);
		}

		it('still finds an entity that has moved out from under its own box', () => {
			expect(closeIn(ONE_SECOND)).toEqual([2]);
		});

		it('would lose that pair without the room the velocity buys', () => {
			// The same two entities in the same places, indexed as though the run covered no time at all: the
			// second one's box is left back at x = 80 and the search never reaches it.
			expect(closeIn(0)).toEqual([]);
		});

		it('allows for an entity being turned around before it moves', () => {
			// Room is left on both sides of an entity rather than just ahead of it, because a collision callback
			// can flip its velocity before it has had its own move - as this one is about to be.
			const entities = createEntities([{ x: 0, y: 0 }, { x: 40, y: 0, velocityX: 40 }]);
			const broadphase = build(entities, ONE_SECOND);

			entities[1].components.transform[TRANSFORM_X_INDEX] = 0;

			expect(overlapping(broadphase, entities[0])).toEqual([2]);
		});

		it('leaves an entity with no velocity where it is', () => {
			// A station has no velocity to allow for, so its box is only ever as big as the station.
			expect(hits([{ x: 0, y: 0 }, { x: 20, y: 0 }], 1)).toEqual([]);
		});
	});

	// How much of a move an entity is let have, so that it comes to rest against what is in its way rather than
	// ending up inside it.  Everything here is 10x10 unless the box says otherwise, so two of them meet when
	// their centres are 10 apart.
	describe('sweeping a move', () => {
		// The move `entityId` asked for, put through a broadphase built from those same boxes.
		function sweep(boxes: Array<Box>, entityId: number, moveX: number, moveY: number, seconds = 0): SweepResult<PhysicsUpdateComponents> {
			const entities = createEntities(boxes);

			return build(entities, seconds).sweep(entities[entityId - 1], moveX, moveY);
		}

		it('takes the whole move when nothing is in the way', () => {
			const result = sweep([{ x: 0, y: 0 }, { x: 100, y: 0 }], 1, 10, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('takes the whole move when there is nothing collidable at all', () => {
			expect(sweep([{ x: 0, y: 0 }], 1, 10, 0).fraction).toEqual(1);
		});

		it('has nothing to work out for an entity that is not going anywhere', () => {
			// Sitting right on top of the other one, so it is only the lack of a move that leaves this clear.
			const result = sweep([{ x: 0, y: 0 }, { x: 5, y: 0 }], 1, 0, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('stops on the edge of what is in its way', () => {
			// 30 apart, so their edges meet 20 along - four fifths of the 25 it wanted.
			const result = sweep([{ x: 0, y: 0 }, { x: 30, y: 0 }], 1, 25, 0);

			expect(result.fraction).toBeCloseTo(0.8, 4);
			expect(blocking(result)).toEqual([2]);
		});

		it('stops on the edge going the other way, and along y', () => {
			expect(sweep([{ x: 0, y: 0 }, { x: -30, y: 0 }], 1, -25, 0).fraction).toBeCloseTo(0.8, 4);
			expect(sweep([{ x: 0, y: 0 }, { x: 0, y: 30 }], 1, 0, 25).fraction).toBeCloseTo(0.8, 4);
			expect(sweep([{ x: 0, y: 0 }, { x: 0, y: -30 }], 1, 0, -25).fraction).toBeCloseTo(0.8, 4);
		});

		// The case that makes the answer one decision over the whole move rather than one per candidate: stopping
		// at whichever entity came up first would leave this one sitting inside the near one.
		it('stops at the nearest of two it lands on, whichever came up first', () => {
			// A huddle 8 apart, both of which the move ends up on top of: the near one's edge is 10 along and the
			// far one's is 18, which is 8 deep inside the near one.
			const near = { x: 20, y: 0 };
			const far = { x: 28, y: 0 };

			const nearFirst = sweep([{ x: 0, y: 0 }, near, far], 1, 25, 0);
			expect(nearFirst.fraction).toBeCloseTo(0.4, 4);
			// Only the near one: the far one is never reached, so it is not what this move came to rest against.
			expect(blocking(nearFirst)).toEqual([2]);

			// The same two the other way round in the list, where taking the first answer found would stop it 18
			// along - well inside the near one.
			const farFirst = sweep([{ x: 0, y: 0 }, far, near], 1, 25, 0);
			expect(farFirst.fraction).toBeCloseTo(0.4, 4);
			expect(blocking(farFirst)).toEqual([3]);
		});

		it('never comes to rest inside what stopped it', () => {
			const entities = createEntities([{ x: 0, y: 0 }, { x: 28, y: 0 }, { x: 20, y: 0 }]);
			const broadphase = build(entities);
			const result = broadphase.sweep(entities[0], 25, 0);

			// Where the sweep said it may go, which is what the update writes back into the block.
			entities[0].components.transform[TRANSFORM_X_INDEX] = 25 * result.fraction;

			// Touching both of nothing and reported as blocked by the near one: the two lists never overlap, which
			// is what lets the update run its callback for each without checking for repeats.
			expect(overlapping(broadphase, entities[0])).toEqual([]);
			expect(blocking(result)).toEqual([3]);
		});

		it('stays put when it is already up against something', () => {
			// Exactly touching, which is not overlapping - so it is a real blocker rather than something it has
			// already ended up inside.
			const result = sweep([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1, 5, 0);

			// Reported as 0 rather than as the sliver it could creep forward, so an entity held against a wall
			// stays exactly where it is run after run instead of drifting into it.
			expect(result.fraction).toEqual(0);
			expect(blocking(result)).toEqual([2]);
		});

		it('lets an entity that started inside another one move on out', () => {
			// Something the game spawned on top of it, or another system pushed it into: blocking on it would pin
			// it there for good, so the move is let through and left to the overlap callback instead.  The move
			// is short enough to still be inside it at the end, so it is only the head start letting this through.
			const result = sweep([{ x: 0, y: 0 }, { x: 5, y: 0 }], 1, 2, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('is not stopped by an entity its categories keep apart', () => {
			// The same 25 that stops on a plain box above, so it is the categories letting this one through.
			const boxes = [
				{ x: 0, y: 0, collideCategory: GROUND, collideMask: GROUND | PROJECTILE },
				{ x: 30, y: 0, collideCategory: AIR, collideMask: AIR | PROJECTILE },
			];

			expect(sweep(boxes, 1, 25, 0).fraction).toEqual(1);
		});

		// The accepted limit of asking where the move ends rather than walking the whole path: a run long enough
		// to carry an entity clean past something leaves nothing there to land on, so nothing stops it.  A move
		// has to cover more ground than what is in the way is thick for this to be reachable at all, which a
		// fixed `deltaBetweenRuns` rules out.
		it('is not stopped by something it goes clean past in one move', () => {
			// A 1 thick wall and a 2 wide entity moving 60 in one run, ending well out the far side of it.
			expect(sweep([{ x: 0, y: 0, width: 2, height: 2 }, { x: 50, y: 0, width: 1, height: 40 }], 1, 60, 0).fraction).toEqual(1);
			// The same wall and the same entity, moving only as far as the wall: stopped on its edge.
			expect(sweep([{ x: 0, y: 0, width: 2, height: 2 }, { x: 50, y: 0, width: 1, height: 40 }], 1, 50, 0).fraction).toBeCloseTo(48.5 / 50, 4);
		});

		it('reports both of two it wedged between at the same moment', () => {
			// One above and one below the line it is travelling along, their near edges level with each other, so
			// there is no order in which one of them comes first.
			const result = sweep([{ x: 0, y: 0 }, { x: 30, y: -5 }, { x: 30, y: 5 }], 1, 25, 0);

			expect(result.fraction).toBeCloseTo(0.8, 4);
			expect(blocking(result)).toEqual([2, 3]);
		});

		it('stops where the shape does rather than where its box would', () => {
			// Passing a circle at an offset: two 10 wide circles meet when their centres are 10 apart, which with
			// 6 of that already spent on y leaves 8 of x - two further along than the boxes would allow.
			const circles = { shape: SHAPE_CIRCLE, width: 10, height: 10 };
			expect(sweep([{ x: 0, y: 0, ...circles }, { x: 30, y: 6, ...circles }], 1, 25, 0).fraction).toBeCloseTo(0.88, 4);
			expect(sweep([{ x: 0, y: 0 }, { x: 30, y: 6 }], 1, 25, 0).fraction).toBeCloseTo(0.8, 4);
		});

		it('stops on the length of a capsule it is running along the side of', () => {
			// The capsule lies along x reaching 20 either way and 5 thick, so a small box coming down onto its
			// middle is stopped 6 above the centre line rather than at the 10 the box around it would suggest.
			const capsule = { x: 0, y: 0, shape: SHAPE_CAPSULE, width: 40, height: 10 };
			const result = sweep([{ x: 0, y: 20, width: 2, height: 2 }, capsule], 1, 0, -20);

			expect(20 - 20 * result.fraction).toBeCloseTo(6, 3);
			expect(blocking(result)).toEqual([2]);
		});

		it('is not stopped by an entity that cannot collide', () => {
			const entities = createEntities([{ x: 0, y: 0 }, { x: 30, y: 0 }]);
			delete entities[1].components.body;

			expect(build(entities).sweep(entities[0], 25, 0).fraction).toEqual(1);
		});

		it('has nothing to work out for an entity that cannot collide itself', () => {
			const entities = createEntities([{ x: 0, y: 0 }, { x: 30, y: 0 }]);
			delete entities[0].components.body;

			expect(build(entities).sweep(entities[0], 25, 0).fraction).toEqual(1);
		});

		it('stops on an entity that has moved out from under its own box', () => {
			// Both closing at 40 a second from 80 apart.  The second one has already had its move by the time this
			// one goes, so it is 40 further in than the tree has it - which the room left for its velocity covers.
			const entities = createEntities([
				{ x: 0, y: 0, velocityX: 40 },
				{ x: 80, y: 0, velocityX: -40 },
			]);
			const broadphase = build(entities, ONE_SECOND);
			entities[1].components.transform[TRANSFORM_X_INDEX] = 40;

			const result = broadphase.sweep(entities[0], 40, 0);

			// Meeting it at 30 rather than running to the 40 it asked for.
			expect(result.fraction).toBeCloseTo(0.75, 4);
			expect(blocking(result)).toEqual([2]);
		});
	});

	// Resolving a move the way physics applies it, with the single-axis slide that keeps an entity clipping a
	// corner running along the wall rather than sticking to it.  Everything here is 10x10 unless the box says
	// otherwise, so two of them meet when their centres are 10 apart.
	describe('resolving a move with sliding', () => {
		// The move `entityId` asked for, resolved with sliding on unless the test turns it off.
		function resolve(boxes: Array<Box>, entityId: number, moveX: number, moveY: number, slide = true): MoveResult<PhysicsUpdateComponents> {
			const entities = createEntities(boxes);

			return build(entities).resolveMove(entities[entityId - 1], moveX, moveY, slide);
		}

		it('takes the whole move when nothing is in the way', () => {
			const result = resolve([{ x: 0, y: 0 }, { x: 100, y: 0 }], 1, 10, 10);

			expect(result.moveX).toEqual(10);
			expect(result.moveY).toEqual(10);
			expect(blocking(result)).toEqual([]);
		});

		it('slides along x when a wall below blocks the diagonal but leaves x clear', () => {
			// A long low wall the diagonal ends up inside of, while the same move along x alone stays above it - so
			// the square runs along the top of the wall instead of stopping on its corner.  It is already sitting on
			// the wall's edge, so the y half of the move gets nowhere and the wall is what it is up against.
			const result = resolve([{ x: 0, y: 0 }, { x: 0, y: 10, width: 100, height: 10 }], 1, 10, 10);

			expect(result.moveX).toEqual(10);
			expect(result.moveY).toEqual(0);
			expect(blocking(result)).toEqual([2]);
		});

		it('slides along y when the nearer axis is blocked too', () => {
			// A tall wall to the right: the diagonal and the x-only move both run into it, so x gets nowhere and the
			// slide carries on down the y axis, which is clear.
			const result = resolve([{ x: 0, y: 0 }, { x: 10, y: 0, width: 10, height: 100 }], 1, 10, 10);

			expect(result.moveX).toEqual(0);
			expect(result.moveY).toEqual(10);
			expect(blocking(result)).toEqual([2]);
		});

		it('presses the blocked axis right up to the edge while sliding the other its whole length', () => {
			// The wall is off to the right with room in front of it, so the x half of the move is not spent before
			// it starts: the square has to travel to reach the wall.  Sliding down y its full length must not cost
			// it that x travel - it should still end hard against the wall's face, not hovering a step short of it.
			// The wall's left face is at 15 and the square is 10 wide, so its centre stops at 10, an x move of 10.
			const result = resolve([{ x: 0, y: 0 }, { x: 20, y: 0, width: 10, height: 100 }], 1, 20, 20);

			expect(result.moveX).toEqual(10);
			expect(result.moveY).toEqual(20);
			expect(blocking(result)).toEqual([2]);
		});

		it('presses up to a wall below while sliding its whole length along x', () => {
			// The same, turned a quarter: a wall below with room above it, so sliding x its full length must still
			// carry the square down onto the wall's top face rather than leaving a gap under it.  The face is at 15,
			// so the square's centre stops at 10, a y move of 10.
			const result = resolve([{ x: 0, y: 0 }, { x: 0, y: 20, width: 100, height: 10 }], 1, 20, 20);

			expect(result.moveX).toEqual(20);
			expect(result.moveY).toEqual(10);
			expect(blocking(result)).toEqual([2]);
		});

		it('slides along the larger axis when a clipped corner leaves both clear', () => {
			// A single box the diagonal just catches the corner of, which neither single-axis move reaches - so the
			// tie is broken towards whichever axis the move was mostly along, keeping most of its heading.
			const mostlyX = resolve([{ x: 0, y: 0 }, { x: 10, y: 10 }], 1, 12, 6);
			expect(mostlyX.moveX).toEqual(12);
			expect(mostlyX.moveY).toEqual(0);

			const mostlyY = resolve([{ x: 0, y: 0 }, { x: 10, y: 10 }], 1, 6, 12);
			expect(mostlyY.moveX).toEqual(0);
			expect(mostlyY.moveY).toEqual(12);
		});

		it('comes to rest in the corner when both axes are blocked', () => {
			// An inside corner - a wall on the right and a wall below - so there is no axis to slide onto and it
			// stops against the pair of them, exactly as a move with nowhere to go would.
			const result = resolve([
				{ x: 0, y: 0 },
				{ x: 10, y: 0, width: 10, height: 100 },
				{ x: 0, y: 10, width: 100, height: 10 },
			], 1, 10, 10);

			expect(result.moveX).toEqual(0);
			expect(result.moveY).toEqual(0);
			expect(blocking(result)).toEqual([2, 3]);
		});

		it('does not invent an axis to slide onto for a straight move', () => {
			// Nothing to fall back to when only one axis was moving in the first place: it just stops on the edge,
			// four fifths of the 25 it wanted, the same as the plain sweep.
			const result = resolve([{ x: 0, y: 0 }, { x: 30, y: 0 }], 1, 25, 0);

			expect(result.moveX).toBeCloseTo(20, 3);
			expect(result.moveY).toEqual(0);
			expect(blocking(result)).toEqual([2]);
		});

		it('does not slide when sliding is turned off, coming to rest instead', () => {
			// The same wall-below the x slide clears above, but with sliding off - the way the bounce path resolves.
			// The square is already sitting on the wall's edge, so the downward half of the diagonal has nowhere to
			// go: with no axis to fall back on it stops dead rather than running along the top of the wall.
			const result = resolve([{ x: 0, y: 0 }, { x: 0, y: 10, width: 100, height: 10 }], 1, 10, 10, false);

			expect(result.moveX).toEqual(0);
			expect(result.moveY).toEqual(0);
			expect(blocking(result)).toEqual([2]);
		});
	});

	// A sensor takes part in detection but never in the response: it is found and reported like any other body,
	// so a mover overlapping it still gets its callback, but nothing is ever swept short against it and it is
	// swept short against nothing - so a solid entity passes straight through where it would otherwise stop.
	describe('sensors', () => {
		function sweep(boxes: Array<Box>, entityId: number, moveX: number, moveY: number): SweepResult<PhysicsUpdateComponents> {
			const entities = createEntities(boxes);

			return build(entities).sweep(entities[entityId - 1], moveX, moveY);
		}

		function resolve(boxes: Array<Box>, entityId: number, moveX: number, moveY: number, slide = true): MoveResult<PhysicsUpdateComponents> {
			const entities = createEntities(boxes);

			return build(entities).resolveMove(entities[entityId - 1], moveX, moveY, slide);
		}

		it('still reports a sensor a mover is sitting on top of', () => {
			// Detection is exactly what a sensor is for: the overlap is found and handed back the same as any other,
			// which is what carries the onCollision the game hangs off it.
			expect(hits([{ x: 0, y: 0 }, { x: 5, y: 0, sensor: true }], 1)).toEqual([2]);
		});

		it('reports the overlap from the sensor\'s own side too', () => {
			// The report is symmetric like every other pair: a sensor that moves finds the solids it overlaps, not
			// only the other way round - so a sensor can be the entity whose update fires the callback.
			expect(hits([{ x: 0, y: 0, sensor: true }, { x: 5, y: 0 }], 1)).toEqual([2]);
		});

		it('does not stop a move against a sensor', () => {
			// The same 25 into a body 30 away that a plain box stops four fifths along: as a sensor it blocks nothing,
			// so the whole move is taken and there is nothing to report as blocking.
			const result = sweep([{ x: 0, y: 0 }, { x: 30, y: 0, sensor: true }], 1, 25, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('does not stop a sensor moving into a solid', () => {
			// The block is on the searcher this time: a sensor passes through whatever it moves into, so it is not
			// swept short even against an ordinary body.
			const result = sweep([{ x: 0, y: 0, sensor: true }, { x: 30, y: 0 }], 1, 25, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('passes a resolved move straight through a sensor', () => {
			// resolveMove is what physics actually applies, sliding and all: a sensor in the way changes none of it,
			// so the whole diagonal is taken rather than being clipped to a wall's face.
			const result = resolve([{ x: 0, y: 0 }, { x: 10, y: 0, width: 10, height: 100, sensor: true }], 1, 10, 10);

			expect(result.moveX).toEqual(10);
			expect(result.moveY).toEqual(10);
			expect(blocking(result)).toEqual([]);
		});

		it('still stops on a solid body sitting behind a sensor', () => {
			// The sensor is passed through and the solid past it is what the move comes to rest against, so a sensor
			// laid over a wall does not stop things short of the wall.
			const result = sweep([{ x: 0, y: 0 }, { x: 15, y: 0, sensor: true }, { x: 30, y: 0 }], 1, 25, 0);

			expect(result.fraction).toBeCloseTo(0.8, 4);
			expect(blocking(result)).toEqual([3]);
		});

		it('still obeys the collide categories a sensor is filtered by', () => {
			// Sensor is only about the response - which pairs are looked at is still the category rule, so a sensor
			// whose categories keep it apart from the mover is not even detected.
			const boxes = [
				{ x: 0, y: 0, collideCategory: GROUND, collideMask: GROUND | PROJECTILE },
				{ x: 5, y: 0, collideCategory: AIR, collideMask: AIR | PROJECTILE, sensor: true },
			];

			expect(hits(boxes, 1)).toEqual([]);
		});
	});
});
