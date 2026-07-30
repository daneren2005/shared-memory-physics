import { createTestWorld, type TestWorld } from '../../__tests__/fixtures/world';
import { BODY_CATEGORY_INDEX, BODY_MASK_INDEX, BODY_SHAPE_INDEX, DEFAULT_COLLIDE_CATEGORY, DEFAULT_COLLIDE_MASK, SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '../body-component';

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
			// x/y come back off a save rather than out of an entity template, so on their own they do not
			// describe an entity that has a place in the world.
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
			// A radius is the same size said differently, so it is spread across width and height here and nothing
			// downstream has to know which way the config was written.
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

		it('saves its current position, and only that', () => {
			// Position is the half that changes as the world runs; the size and facing come back from the game's
			// own entity template rather than the save.
			const entity = world.loadEntity({ x: 1, y: 2, width: 3, height: 4 });
			entity.components.transform!.x = 100;

			expect(entity.save()).toMatchObject({ x: 100, y: 2 });
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

		it('holds a full 32 bit mask', () => {
			// The default is every bit set, which does not fit in a signed int - the block is a Uint32Array so it
			// round-trips, and JS bitwise operators work on the same 32 bits when the broadphase ANDs it.
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
			// The one shape a size can imply, so it never has to be spelled out.
			expect(world.loadEntity({ x: 0, y: 0, radius: 5 }).components.body?.shape).toEqual(SHAPE_CIRCLE);
		});

		it('takes a capsule, which no size can imply', () => {
			const entity = world.loadEntity({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });

			expect(entity.components.body?.shape).toEqual(SHAPE_CAPSULE);
			// Still one size in the transform: 40 from end to end and 10 thick.
			expect(entity.components.transform?.width).toEqual(40);
			expect(entity.components.transform?.height).toEqual(10);
		});

		it('lets an explicit shape win over what the size would imply', () => {
			expect(world.loadEntity({ x: 0, y: 0, radius: 5, shape: SHAPE_RECTANGLE }).components.body?.shape).toEqual(SHAPE_RECTANGLE);
		});

		it('throws on a shape it does not know', () => {
			// Defaulting an unrecognised shape to a rectangle would leave the entity colliding with the wrong
			// outline, which is far harder to spot than a config that refuses to load.
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

			expect(block[BODY_SHAPE_INDEX]).toEqual(SHAPE_RECTANGLE);
		});

		it('saves nothing, since what it holds comes back from the game\'s own template', () => {
			const entity = world.loadEntity({ x: 1, y: 2, width: 3, height: 4, collideCategory: 8 });

			expect(entity.save()).not.toHaveProperty('collideCategory');
			expect(entity.save()).not.toHaveProperty('collideMask');
			expect(entity.save()).not.toHaveProperty('shape');
		});
	});
});
