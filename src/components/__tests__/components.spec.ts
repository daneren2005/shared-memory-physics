import { createTestWorld, type TestWorld } from '../../__tests__/fixtures/world';
import {
	BODY_CATEGORY_INDEX, BODY_FLAGS_INDEX, BODY_MASK_INDEX, BODY_SHAPE_MASK,
	DEFAULT_COLLIDE_CATEGORY, DEFAULT_COLLIDE_MASK, SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_POLYGON, SHAPE_RECTANGLE,
} from '../body-component';
import { MAX_POLYGON_VERTICES } from '../polygon-component';

describe('components', () => {
	let world: TestWorld;
	beforeEach(() => {
		world = createTestWorld();
	});

	describe('transform', () => {
		it('loads a position, a size and a facing', () => {
			const entity = world.loadEntity({ x: 5, y: -3, width: 8, height: 4, angle: Math.PI });

			expect(entity.components.transform?.x).toEqual(5);
			expect(entity.components.transform?.y).toEqual(-3);
			expect(entity.components.transform?.width).toEqual(8);
			expect(entity.components.transform?.height).toEqual(4);
			expect(entity.components.transform?.angle).toBeCloseTo(Math.PI);
		});

		it('defaults a config with no facing to 0', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 8, height: 4 });

			expect(entity.components.transform?.angle).toEqual(0);
		});

		it('is the size that loads it, since that is what a game template supplies', () => {
			// x/y come off a save, not the template, so on their own they do not describe a world entity.
			expect(world.loadEntity({ width: 4, height: 4 }).components.transform).toBeDefined();
			expect(world.loadEntity({ x: 5, y: -3 }).components.transform).toBeUndefined();
		});

		it('is not loaded for a config with no transform at all', () => {
			const entity = world.loadEntity({ tag: 1 });

			expect(entity.components.transform).toBeUndefined();
		});

		it('writes through to the shared memory block', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1 });
			const transform = entity.components.transform!;
			const block = world.registry.transform.memoryComponent.getBlock(transform.index);

			transform.x = 42;
			expect(block[0]).toEqual(42);

			block[1] = 24;
			expect(transform.y).toEqual(24);

			transform.width = 6;
			transform.height = 7;
			transform.angle = 8;
			expect([block[2], block[3], block[4]]).toEqual([6, 7, 8]);
		});

		it('loads a radius as the size of the circle it describes', () => {
			// A radius is spread across width and height, so nothing downstream cares how the config was written.
			const entity = world.loadEntity({ x: 0, y: 0, radius: 5 });

			expect(entity.components.transform?.width).toEqual(10);
			expect(entity.components.transform?.height).toEqual(10);
		});

		it('is loaded by a radius on its own', () => {
			expect(world.loadEntity({ radius: 5 }).components.transform).toBeDefined();
		});

		it('refuses a config that gives both a radius and a size', () => {
			expect(() => world.loadEntity({ x: 0, y: 0, radius: 5, width: 10, height: 10 }))
				.toThrow('A transform takes either a radius or a width and height, not both');
		});

		it('saves its current position and facing, and only those', () => {
			// Position and angle change as the world runs; size comes back from the template.
			const entity = world.loadEntity({ x: 1, y: 2, width: 3, height: 4, angle: Math.PI });
			entity.components.transform!.x = 100;
			entity.components.transform!.angle = Math.PI / 2;

			expect(entity.save()).toMatchObject({ x: 100, y: 2 });
			expect(entity.save().angle).toBeCloseTo(Math.PI / 2);
			expect(entity.save()).not.toHaveProperty('width');
		});
	});

	describe('velocity', () => {
		it('loads from a velocityX/velocityY config', () => {
			const entity = world.loadEntity({ velocityX: 5, velocityY: -3 });

			expect(entity.components.velocity?.velocityX).toEqual(5);
			expect(entity.components.velocity?.velocityY).toEqual(-3);
		});

		it('loads from a single axis, defaulting the other to 0', () => {
			const entity = world.loadEntity({ velocityY: 5 });

			expect(entity.components.velocity?.velocityX).toEqual(0);
			expect(entity.components.velocity?.velocityY).toEqual(5);
		});

		it('is not loaded for a config with no velocity', () => {
			const entity = world.loadEntity({ x: 1, y: 2, width: 1, height: 1 });

			expect(entity.components.velocity).toBeUndefined();
		});

		it('writes through to the shared memory block', () => {
			const entity = world.loadEntity({ velocityX: 0, velocityY: 0 });
			const velocity = entity.components.velocity!;
			const block = world.registry.velocity.memoryComponent.getBlock(velocity.index);

			velocity.velocityX = 42;
			expect(block[0]).toEqual(42);

			block[1] = 24;
			expect(velocity.velocityY).toEqual(24);
		});

		it('saves its current velocity', () => {
			const entity = world.loadEntity({ velocityX: 1, velocityY: 2 });
			entity.components.velocity!.velocityX = 100;

			expect(entity.save()).toMatchObject({ velocityX: 100, velocityY: 2 });
		});
	});

	describe('body', () => {
		it('loads convex vertices as a polygon with dimensions derived from their bounds', () => {
			const entity = world.loadEntity({ x: 0, y: 0, vertices: [[-4, -2], [4, 0], [-4, 2]] });

			expect(entity.components.body?.shape).toEqual(SHAPE_POLYGON);
			expect(entity.components.transform?.width).toEqual(8);
			expect(entity.components.transform?.height).toEqual(4);
			expect(entity.components.polygon?.vertexCount).toEqual(3);
			expect(Array.from(entity.components.polygon!.block.slice(1, 7))).toEqual([-0.5, -0.5, 0.5, 0, -0.5, 0.5]);
		});

		it('accepts clockwise vertices and stores them counter-clockwise', () => {
			const entity = world.loadEntity({ vertices: [[-4, 2], [4, 0], [-4, -2]] });

			expect(Array.from(entity.components.polygon!.block.slice(1, 7))).toEqual([-0.5, -0.5, 0.5, 0, -0.5, 0.5]);
		});

		it('rejects concave, degenerate and oversized polygons', () => {
			expect(() => world.loadEntity({ vertices: [[0, 0], [2, 0], [1, 0.5], [2, 2], [0, 2]] }))
				.toThrow('Polygon vertices must describe a convex polygon in boundary order');
			expect(() => world.loadEntity({ vertices: [[0, 0], [1, 0], [2, 0]] }))
				.toThrow('A polygon must have nonzero width and height');
			expect(() => world.loadEntity({ vertices: Array.from({ length: MAX_POLYGON_VERTICES + 1 }, (_, i) => [i, i % 2] as const) }))
				.toThrow(`A polygon needs between 3 and ${MAX_POLYGON_VERTICES} vertices`);
			expect(() => world.loadEntity({ vertices: [[0, -5], [3, 4], [-5, -1], [5, -1], [-3, 4]] }))
				.toThrow('Polygon edges cannot cross or share non-adjacent vertices');
		});

		it('does not allow polygon vertices to compete with another size', () => {
			expect(() => world.loadEntity({ width: 10, height: 10, vertices: [[-1, -1], [1, 0], [-1, 1]] }))
				.toThrow('A transform takes polygon vertices, a radius, or a width and height');
		});

		it('is loaded for anything with a size, so everything in the world collides by default', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 8, height: 4 });

			expect(entity.components.body?.shape).toEqual(SHAPE_RECTANGLE);
			expect(entity.components.body?.collideCategory).toEqual(DEFAULT_COLLIDE_CATEGORY);
			expect(entity.components.body?.collideMask).toEqual(DEFAULT_COLLIDE_MASK);
		});

		it('takes an explicit category and mask', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 8, height: 4, collideCategory: 4, collideMask: 5 });

			expect(entity.components.body?.collideCategory).toEqual(4);
			expect(entity.components.body?.collideMask).toEqual(5);
		});

		it('is not continuous by default and takes the flag when asked', () => {
			expect(world.loadEntity({ x: 0, y: 0, width: 8, height: 4 }).components.body?.continuousCollisionDetection).toEqual(false);

			const continuous = world.loadEntity({ x: 0, y: 0, width: 8, height: 4, continuousCollisionDetection: true });
			expect(continuous.components.body?.continuousCollisionDetection).toEqual(true);
		});

		it('holds a full 32 bit mask', () => {
			// Every bit set does not fit a signed int, but the Uint32Array block round-trips it.
			const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, collideMask: 0xFFFFFFFF });

			expect(entity.components.body?.collideMask).toEqual(4294967295);
			expect(entity.components.body!.collideMask & 1).toEqual(1);
		});

		it('is loaded from the collide properties on their own', () => {
			expect(world.loadEntity({ collideCategory: 2 }).components.body).toBeDefined();
			expect(world.loadEntity({ collideMask: 2 }).components.body).toBeDefined();
		});

		it('is not loaded for a config that describes no body at all', () => {
			expect(world.loadEntity({ tag: 1 }).components.body).toBeUndefined();
			expect(world.loadEntity({ velocityX: 1 }).components.body).toBeUndefined();
		});

		it('reads a circle off a config that gave a radius', () => {
			expect(world.loadEntity({ x: 0, y: 0, radius: 5 }).components.body?.shape).toEqual(SHAPE_CIRCLE);
		});

		it('takes a capsule, which no size can imply', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });

			expect(entity.components.body?.shape).toEqual(SHAPE_CAPSULE);
			expect(entity.components.transform?.width).toEqual(40);
			expect(entity.components.transform?.height).toEqual(10);
		});

		it('lets an explicit shape win over what the size would imply', () => {
			expect(world.loadEntity({ x: 0, y: 0, radius: 5, shape: SHAPE_RECTANGLE }).components.body?.shape).toEqual(SHAPE_RECTANGLE);
		});

		it('throws on a shape it does not know', () => {
			// Defaulting to a rectangle would collide with the wrong outline, harder to spot than a failed load.
			expect(() => world.loadEntity({ x: 0, y: 0, width: 1, height: 1, shape: 99 })).toThrow('Unknown body shape: 99');
		});

		it('writes through to the shared memory block', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1 });
			const body = entity.components.body!;
			const block = world.registry.body.memoryComponent.getBlock(body.index);

			body.collideCategory = 42;
			expect(block[BODY_CATEGORY_INDEX]).toEqual(42);

			block[BODY_MASK_INDEX] = 24;
			expect(body.collideMask).toEqual(24);

			expect(block[BODY_FLAGS_INDEX] & BODY_SHAPE_MASK).toEqual(SHAPE_RECTANGLE);
		});

		it('saves nothing, since what it holds comes back from the game\'s own template', () => {
			const entity = world.loadEntity({ x: 1, y: 2, width: 3, height: 4, collideCategory: 8 });

			expect(entity.save()).not.toHaveProperty('collideCategory');
			expect(entity.save()).not.toHaveProperty('collideMask');
			expect(entity.save()).not.toHaveProperty('shape');
		});
	});

	describe('bounciness', () => {
		it('loads from a bounciness config', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, bounciness: 0.5 });

			expect(entity.components.bounciness?.bounciness).toEqual(0.5);
		});

		it('is only loaded for a config that names bounciness, so a non-bouncing entity pays nothing for it', () => {
			// Why it is its own component: a world of walls and terrain never allocates the block.
			expect(world.loadEntity({ x: 0, y: 0, width: 1, height: 1 }).components.bounciness).toBeUndefined();
			expect(world.loadEntity({ x: 0, y: 0, width: 1, height: 1, bounciness: 1 }).components.bounciness).toBeDefined();
		});

		it('writes through to the shared memory block', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, bounciness: 1 });
			const bounciness = entity.components.bounciness!;
			const block = world.registry.bounciness.memoryComponent.getBlock(bounciness.index);

			bounciness.bounciness = 0.25;
			expect(block[0]).toEqual(0.25);

			block[0] = 0.75;
			expect(bounciness.bounciness).toEqual(0.75);
		});

		it('saves nothing, since it is defining config that comes back from the game\'s own template', () => {
			const entity = world.loadEntity({ x: 1, y: 2, width: 3, height: 4, bounciness: 1 });

			expect(entity.save()).not.toHaveProperty('bounciness');
		});
	});
});
