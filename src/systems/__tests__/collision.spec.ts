import CollisionBroadphase, { type MovingEntity } from '../collision';
import type { PhysicsUpdateComponents } from '../../components/registry';
import {
	BODY_CATEGORY_INDEX, BODY_MASK_INDEX, BODY_SHAPE_INDEX, BODY_SIZE,
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
});
