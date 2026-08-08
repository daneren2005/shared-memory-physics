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

// Game-defined categories; the library reads them only as bits.
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

// Boxes default to 10x10, still, colliding with everything, so most tests only give a position.
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

// One entry per box, keyed by its list position + 1 as its entity id.
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

function blocking(result: SweepResult<PhysicsUpdateComponents> | MoveResult<PhysicsUpdateComponents>): Array<number> {
	return result.blocking.map(other => other.entityId).sort((first, second) => first - second);
}

// Everything `entityId` overlaps, with nothing moved since the tree was built.
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
		// One call per entity as it moves, not a single call for the pair.
		const boxes: Array<Box> = [{ x: 0, y: 0 }, { x: 5, y: 0 }];
		expect(hits(boxes, 1)).toEqual([2]);
		expect(hits(boxes, 2)).toEqual([1]);
	});

	it('finds everything in a pile', () => {
		expect(hits([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }], 1)).toEqual([2, 3]);
		// 1 and 3 are 8 apart and only reach 2.
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
		// 8 apart, 10 wide each: overlap by 2 from their centres, miss entirely if x/y were a corner.
		expect(hits([{ x: 0, y: 0 }, { x: 8, y: 0 }], 1)).toEqual([2]);
	});

	it('follows a box that has been turned', () => {
		const bar = { width: 2, height: 10 };
		expect(hits([{ x: 0, y: 0, ...bar }, { x: 5, y: 0, ...bar }], 1)).toEqual([]);
		expect(hits([{ x: 0, y: 0, ...bar }, { x: 5, y: 0, ...bar, angle: Math.PI / 2 }], 1)).toEqual([2]);
	});

	it('does not report a turned box the tree alone would', () => {
		// The tree only narrows: it finds the small box, then the full test throws it out.
		expect(hits([{ x: 0, y: 0, angle: Math.PI / 4 }, { x: 6.5, y: 6.5, width: 2, height: 2 }], 1)).toEqual([]);
		expect(hits([{ x: 0, y: 0 }, { x: 5.5, y: 5.5, width: 2, height: 2 }], 1)).toEqual([2]);
	});

	it('finds nothing when there is nothing collidable', () => {
		const alone = createEntity({ x: 0, y: 0 }, 1);

		// Flatbush cannot index zero items, so this must not blow up.
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

	// Each entity is indexed and tested as the shape its body says, not the rectangle its width and height imply.
	describe('body shapes', () => {
		it('rounds off the corner a rectangle of the same size would keep', () => {
			// Offset along the diagonal: boxes still overlap while circles have parted - only true if the circle
			// test ran.
			const circles = { shape: SHAPE_CIRCLE, width: 10, height: 10 };
			expect(hits([{ x: 0, y: 0, ...circles }, { x: 8, y: 8, ...circles }], 1)).toEqual([]);
			expect(hits([{ x: 0, y: 0, width: 10, height: 10 }, { x: 8, y: 8, width: 10, height: 10 }], 1)).toEqual([2]);
		});

		it('reaches along the length of a capsule', () => {
			// 40 long, so its cap reaches x = 20 - onto a box at 20.5, nowhere near one at 30.
			const capsule = { shape: SHAPE_CAPSULE, width: 40, height: 10 };
			const target = { width: 2, height: 2 };
			expect(hits([{ x: 0, y: 0, ...capsule }, { x: 20.5, y: 0, ...target }], 1)).toEqual([2]);
			expect(hits([{ x: 0, y: 0, ...capsule }, { x: 30, y: 0, ...target }], 1)).toEqual([]);
		});

		it('turns a capsule with the entity', () => {
			const capsule = { shape: SHAPE_CAPSULE, width: 40, height: 10 };
			const target = { x: 0, y: 18, width: 2, height: 2 };
			expect(hits([{ x: 0, y: 0, ...capsule }, target], 1)).toEqual([]);
			// Upright it reaches up to the target, which needs the tree to have indexed it upright too.
			expect(hits([{ x: 0, y: 0, ...capsule, angle: Math.PI / 2 }, target], 1)).toEqual([2]);
		});

		it('indexes a circle by its own width rather than its height', () => {
			// A circle is 40 across however short its height; indexing it as a 40x10 rectangle would leave it 5 tall
			// and cut off the entity above it.
			const circle = { shape: SHAPE_CIRCLE, width: 40, height: 10 };
			expect(hits([{ x: 0, y: 0, ...circle }, { x: 0, y: 18, width: 2, height: 2 }], 1)).toEqual([2]);
		});

		it('still collides a circle whose height was never set', () => {
			// A circle with no height is a good circle; a rectangle with no height is nothing.
			expect(hits([{ x: 0, y: 0, shape: SHAPE_CIRCLE, width: 10, height: 0 }, { x: 5, y: 0 }], 1)).toEqual([2]);
			expect(hits([{ x: 0, y: 0, width: 10, height: 0 }, { x: 5, y: 0 }], 1)).toEqual([]);
		});

		it('drops a capsule with no thickness', () => {
			expect(hits([{ x: 0, y: 0, shape: SHAPE_CAPSULE, width: 40, height: 0 }, { x: 5, y: 0 }], 1)).toEqual([]);
		});
	});

	// Boxes here all overlap, so anything not reported was ruled out by categories rather than geometry.
	describe('collide categories', () => {
		it('collides everything with everything by default', () => {
			expect(hits([{ x: 0, y: 0 }, { x: 5, y: 0 }], 1)).toEqual([2]);
		});

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
			// Symmetric, so the units find it back.
			expect(hits(boxes, 2)).toEqual([1]);
			expect(hits(boxes, 3)).toEqual([1]);
		});

		it('does not collide two ranged attacks with each other', () => {
			// Neither mask names PROJECTILE.
			expect(hits([{ x: 0, y: 0, ...rangedAttack }, { x: 5, y: 0, ...rangedAttack }], 1)).toEqual([]);
		});

		// Symmetric, so both sides must agree: a unit hit by projectiles must name projectiles in its own mask.
		it('needs both sides to accept each other', () => {
			const willing = { collideCategory: GROUND, collideMask: GROUND | AIR };
			const unwilling = { collideCategory: AIR, collideMask: AIR };
			const boxes = [{ x: 0, y: 0, ...willing }, { x: 5, y: 0, ...unwilling }];

			expect(hits(boxes, 1)).toEqual([]);
			expect(hits(boxes, 2)).toEqual([]);
		});

		it('collides nothing with a category of 0', () => {
			// No mask can name category 0, so this opts an entity out entirely.
			const boxes = [{ x: 0, y: 0 }, { x: 5, y: 0, collideCategory: 0 }];

			expect(hits(boxes, 1)).toEqual([]);
			expect(hits(boxes, 2)).toEqual([]);
		});

		it('collides nothing with a mask of 0', () => {
			const boxes = [{ x: 0, y: 0 }, { x: 5, y: 0, collideMask: 0 }];

			expect(hits(boxes, 1)).toEqual([]);
			expect(hits(boxes, 2)).toEqual([]);
		});

		it('reports an entity that collides as several things at once only once', () => {
			// A multi-bit category must land in exactly one bucket, or a searcher accepting both bits finds it twice.
			const amphibious = { collideCategory: GROUND | AIR, collideMask: DEFAULT_COLLIDE_MASK };

			expect(hits([{ x: 0, y: 0, ...rangedAttack }, { x: 5, y: 0, ...amphibious }], 1)).toEqual([2]);
		});

		it('collides across separate categories in one search', () => {
			// Three categories, three buckets: a mask accepting all must search every one.
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
			// No body, so it drops out of the tree.
			delete entities[1].components.body;

			expect(overlapping(build(entities), entities[0])).toEqual([]);
		});

		it('finds nothing for an entity that has no body of its own', () => {
			const entities = createEntities([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
			delete entities[0].components.body;

			expect(overlapping(build(entities), entities[0])).toEqual([]);
		});
	});

	// The tree is built before anything moves, so its boxes must allow for the ground each entity will cover, or a
	// pair that only meets mid-run is never looked at.
	describe('allowing for movement', () => {
		// Two entities closing at 40/s from 80 apart, both at x = 40 when the run ends.
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
			// Indexed as though the run covered no time: the second box stays at x = 80 and is never reached.
			expect(closeIn(0)).toEqual([]);
		});

		it('allows for an entity being turned around before it moves', () => {
			// Room is left on both sides, since a callback can flip velocity before the entity's own move.
			const entities = createEntities([{ x: 0, y: 0 }, { x: 40, y: 0, velocityX: 40 }]);
			const broadphase = build(entities, ONE_SECOND);

			entities[1].components.transform[TRANSFORM_X_INDEX] = 0;

			expect(overlapping(broadphase, entities[0])).toEqual([2]);
		});

		it('leaves an entity with no velocity where it is', () => {
			// A station has no velocity to allow for, so its box is only as big as the station.
			expect(hits([{ x: 0, y: 0 }, { x: 20, y: 0 }], 1)).toEqual([]);
		});
	});

	// 10x10 boxes unless said otherwise, so two meet when their centres are 10 apart.
	describe('sweeping a move', () => {
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
			// Right on top of the other, so only the lack of a move leaves this clear.
			const result = sweep([{ x: 0, y: 0 }, { x: 5, y: 0 }], 1, 0, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('stops on the edge of what is in its way', () => {
			// 30 apart, so edges meet 20 along - four fifths of the 25 it wanted.
			const result = sweep([{ x: 0, y: 0 }, { x: 30, y: 0 }], 1, 25, 0);

			expect(result.fraction).toBeCloseTo(0.8, 4);
			expect(blocking(result)).toEqual([2]);
		});

		it('stops on the edge going the other way, and along y', () => {
			expect(sweep([{ x: 0, y: 0 }, { x: -30, y: 0 }], 1, -25, 0).fraction).toBeCloseTo(0.8, 4);
			expect(sweep([{ x: 0, y: 0 }, { x: 0, y: 30 }], 1, 0, 25).fraction).toBeCloseTo(0.8, 4);
			expect(sweep([{ x: 0, y: 0 }, { x: 0, y: -30 }], 1, 0, -25).fraction).toBeCloseTo(0.8, 4);
		});

		// One decision over the whole move: stopping at whichever came up first would end inside the near one.
		it('stops at the nearest of two it lands on, whichever came up first', () => {
			// Two 8 apart, both under the move's end: the near edge is 10 along, the far 18 (8 inside the near).
			const near = { x: 20, y: 0 };
			const far = { x: 28, y: 0 };

			const nearFirst = sweep([{ x: 0, y: 0 }, near, far], 1, 25, 0);
			expect(nearFirst.fraction).toBeCloseTo(0.4, 4);
			expect(blocking(nearFirst)).toEqual([2]);

			// Same two reversed in the list, where taking the first found would stop 18 along, inside the near one.
			const farFirst = sweep([{ x: 0, y: 0 }, far, near], 1, 25, 0);
			expect(farFirst.fraction).toBeCloseTo(0.4, 4);
			expect(blocking(farFirst)).toEqual([3]);
		});

		it('never comes to rest inside what stopped it', () => {
			const entities = createEntities([{ x: 0, y: 0 }, { x: 28, y: 0 }, { x: 20, y: 0 }]);
			const broadphase = build(entities);
			const result = broadphase.sweep(entities[0], 25, 0);

			entities[0].components.transform[TRANSFORM_X_INDEX] = 25 * result.fraction;

			// Overlapping nothing but blocked by the near one: the two lists never share an entry.
			expect(overlapping(broadphase, entities[0])).toEqual([]);
			expect(blocking(result)).toEqual([3]);
		});

		it('stays put when it is already up against something', () => {
			// Exactly touching (not overlapping), so a real blocker.
			const result = sweep([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1, 5, 0);

			// 0, not the sliver it could creep, so an entity held against a wall does not drift into it.
			expect(result.fraction).toEqual(0);
			expect(blocking(result)).toEqual([2]);
		});

		it('lets an entity that started inside another one move on out', () => {
			// Blocking on something it already sits inside would pin it forever; let it through to the overlap
			// callback. The move is short enough to still be inside at the end.
			const result = sweep([{ x: 0, y: 0 }, { x: 5, y: 0 }], 1, 2, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('is not stopped by an entity its categories keep apart', () => {
			// The same 25 that stops on a plain box above, so the categories let this one through.
			const boxes = [
				{ x: 0, y: 0, collideCategory: GROUND, collideMask: GROUND | PROJECTILE },
				{ x: 30, y: 0, collideCategory: AIR, collideMask: AIR | PROJECTILE },
			];

			expect(sweep(boxes, 1, 25, 0).fraction).toEqual(1);
		});

		// The accepted limit of testing only where the move ends: a move long enough to clear something leaves
		// nothing to land on. It has to cover more ground than the obstacle is thick, which a fixed step rules out.
		it('is not stopped by something it goes clean past in one move', () => {
			// A 1-thick wall and a 2-wide entity moving 60, ending past it; the same move of 50 stops on the edge.
			expect(sweep([{ x: 0, y: 0, width: 2, height: 2 }, { x: 50, y: 0, width: 1, height: 40 }], 1, 60, 0).fraction).toEqual(1);
			expect(sweep([{ x: 0, y: 0, width: 2, height: 2 }, { x: 50, y: 0, width: 1, height: 40 }], 1, 50, 0).fraction).toBeCloseTo(48.5 / 50, 4);
		});

		it('reports both of two it wedged between at the same moment', () => {
			// One above and one below the path, near edges level, so neither comes first.
			const result = sweep([{ x: 0, y: 0 }, { x: 30, y: -5 }, { x: 30, y: 5 }], 1, 25, 0);

			expect(result.fraction).toBeCloseTo(0.8, 4);
			expect(blocking(result)).toEqual([2, 3]);
		});

		it('stops where the shape does rather than where its box would', () => {
			// Two circles meet 10 apart centre to centre; 6 spent on y leaves 8 of x, two past what boxes allow.
			const circles = { shape: SHAPE_CIRCLE, width: 10, height: 10 };
			expect(sweep([{ x: 0, y: 0, ...circles }, { x: 30, y: 6, ...circles }], 1, 25, 0).fraction).toBeCloseTo(0.88, 4);
			expect(sweep([{ x: 0, y: 0 }, { x: 30, y: 6 }], 1, 25, 0).fraction).toBeCloseTo(0.8, 4);
		});

		it('stops on the length of a capsule it is running along the side of', () => {
			// The capsule is 5 thick, so a box dropping onto its middle stops 6 above the centre line, not at 10.
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
			// Both closing at 40/s from 80 apart. The second has already moved 40 in, which its velocity room covers.
			const entities = createEntities([
				{ x: 0, y: 0, velocityX: 40 },
				{ x: 80, y: 0, velocityX: -40 },
			]);
			const broadphase = build(entities, ONE_SECOND);
			entities[1].components.transform[TRANSFORM_X_INDEX] = 40;

			const result = broadphase.sweep(entities[0], 40, 0);

			// Meeting it at 30, not the 40 it asked for.
			expect(result.fraction).toBeCloseTo(0.75, 4);
			expect(blocking(result)).toEqual([2]);
		});
	});

	// Resolving a move as physics applies it, with the single-axis slide that keeps a corner-clipping entity
	// running along the wall. 10x10 boxes unless said otherwise.
	describe('resolving a move with sliding', () => {
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
			// A low wall the diagonal enters while x alone stays above it. Already on the wall's edge, so y gets
			// nowhere and the wall is the blocker.
			const result = resolve([{ x: 0, y: 0 }, { x: 0, y: 10, width: 100, height: 10 }], 1, 10, 10);

			expect(result.moveX).toEqual(10);
			expect(result.moveY).toEqual(0);
			expect(blocking(result)).toEqual([2]);
		});

		it('slides along y when the nearer axis is blocked too', () => {
			// A wall to the right: diagonal and x-only both hit it, so x gets nowhere and the slide goes down y.
			const result = resolve([{ x: 0, y: 0 }, { x: 10, y: 0, width: 10, height: 100 }], 1, 10, 10);

			expect(result.moveX).toEqual(0);
			expect(result.moveY).toEqual(10);
			expect(blocking(result)).toEqual([2]);
		});

		it('presses the blocked axis right up to the edge while sliding the other its whole length', () => {
			// Wall to the right with room in front, so sliding down y must not cost the x travel: it ends hard
			// against the face at 15, centre at 10, an x move of 10.
			const result = resolve([{ x: 0, y: 0 }, { x: 20, y: 0, width: 10, height: 100 }], 1, 20, 20);

			expect(result.moveX).toEqual(10);
			expect(result.moveY).toEqual(20);
			expect(blocking(result)).toEqual([2]);
		});

		it('presses up to a wall below while sliding its whole length along x', () => {
			// The same turned a quarter: sliding x full length still drops onto the wall's top face at 15, y move 10.
			const result = resolve([{ x: 0, y: 0 }, { x: 0, y: 20, width: 100, height: 10 }], 1, 20, 20);

			expect(result.moveX).toEqual(20);
			expect(result.moveY).toEqual(10);
			expect(blocking(result)).toEqual([2]);
		});

		it('slides along the larger axis when a clipped corner leaves both clear', () => {
			// A box the diagonal only clips at the corner, which neither axis alone reaches: break towards the
			// dominant axis.
			const mostlyX = resolve([{ x: 0, y: 0 }, { x: 10, y: 10 }], 1, 12, 6);
			expect(mostlyX.moveX).toEqual(12);
			expect(mostlyX.moveY).toEqual(0);

			const mostlyY = resolve([{ x: 0, y: 0 }, { x: 10, y: 10 }], 1, 6, 12);
			expect(mostlyY.moveX).toEqual(0);
			expect(mostlyY.moveY).toEqual(12);
		});

		it('comes to rest in the corner when both axes are blocked', () => {
			// An inside corner: no axis to slide onto, so it stops against both walls.
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
			// Only one axis was moving, so it just stops on the edge, same as the plain sweep.
			const result = resolve([{ x: 0, y: 0 }, { x: 30, y: 0 }], 1, 25, 0);

			expect(result.moveX).toBeCloseTo(20, 3);
			expect(result.moveY).toEqual(0);
			expect(blocking(result)).toEqual([2]);
		});

		it('does not slide when sliding is turned off, coming to rest instead', () => {
			// The same wall-below, sliding off (the bounce path): with no axis to fall back on it stops dead.
			const result = resolve([{ x: 0, y: 0 }, { x: 0, y: 10, width: 100, height: 10 }], 1, 10, 10, false);

			expect(result.moveX).toEqual(0);
			expect(result.moveY).toEqual(0);
			expect(blocking(result)).toEqual([2]);
		});
	});

	// A sensor takes part in detection but not the response: found and reported like any body, but never swept
	// short against, and it sweeps short against nothing - so a solid passes straight through it.
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
			expect(hits([{ x: 0, y: 0 }, { x: 5, y: 0, sensor: true }], 1)).toEqual([2]);
		});

		it('reports the overlap from the sensor\'s own side too', () => {
			// Symmetric, so a moving sensor can be the entity whose update fires the callback.
			expect(hits([{ x: 0, y: 0, sensor: true }, { x: 5, y: 0 }], 1)).toEqual([2]);
		});

		it('does not stop a move against a sensor', () => {
			// The same 25 that a plain box stops four fifths along: a sensor blocks nothing.
			const result = sweep([{ x: 0, y: 0 }, { x: 30, y: 0, sensor: true }], 1, 25, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('does not stop a sensor moving into a solid', () => {
			// A sensor passes through whatever it moves into.
			const result = sweep([{ x: 0, y: 0, sensor: true }, { x: 30, y: 0 }], 1, 25, 0);

			expect(result.fraction).toEqual(1);
			expect(blocking(result)).toEqual([]);
		});

		it('passes a resolved move straight through a sensor', () => {
			const result = resolve([{ x: 0, y: 0 }, { x: 10, y: 0, width: 10, height: 100, sensor: true }], 1, 10, 10);

			expect(result.moveX).toEqual(10);
			expect(result.moveY).toEqual(10);
			expect(blocking(result)).toEqual([]);
		});

		it('still stops on a solid body sitting behind a sensor', () => {
			// The sensor is passed through and the solid behind it is the blocker.
			const result = sweep([{ x: 0, y: 0 }, { x: 15, y: 0, sensor: true }, { x: 30, y: 0 }], 1, 25, 0);

			expect(result.fraction).toBeCloseTo(0.8, 4);
			expect(blocking(result)).toEqual([3]);
		});

		it('still obeys the collide categories a sensor is filtered by', () => {
			// Which pairs are looked at is still the category rule, so a filtered-out sensor is not even detected.
			const boxes = [
				{ x: 0, y: 0, collideCategory: GROUND, collideMask: GROUND | PROJECTILE },
				{ x: 5, y: 0, collideCategory: AIR, collideMask: AIR | PROJECTILE, sensor: true },
			];

			expect(hits(boxes, 1)).toEqual([]);
		});
	});
});
