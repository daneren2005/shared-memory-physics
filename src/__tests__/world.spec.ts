import { createTestWorld, type TestWorld } from './fixtures/world';

describe('SpatialWorld', () => {
	let world: TestWorld;

	beforeEach(() => {
		world = createTestWorld();
	});

	it('queries live entities from the main thread', () => {
		const first = world.loadEntity({ x: 10, y: 10, width: 20, height: 20 });
		const second = world.loadEntity({ x: 100, y: 10, width: 20, height: 20 });

		expect(world.searchSpatial(10, 10, 10, 10)).toEqual([first]);
		expect(world.searchSpatialAround(55, 10, 60, 20)).toEqual(expect.arrayContaining([first, second]));
		expect(world.findNearestSpatial(80, 10)).toBe(second);
	});

	it('moves and removes entities in the shared map', () => {
		const entity = world.loadEntity({ x: 10, y: 10, width: 10, height: 10 });
		const transform = entity.components.transform;
		expect(transform).toBeDefined();

		transform!.x = 500;
		world.updateSpatialEntity(entity);

		expect(world.searchSpatial(0, 0, 20, 20)).toEqual([]);
		expect(world.searchSpatial(490, 0, 510, 20)).toEqual([entity]);

		world.removeEntity(entity);
		expect(world.searchSpatial(490, 0, 510, 20)).toEqual([]);
	});

	it('filters before returning nearby entities', () => {
		const first = world.loadEntity({ x: 10, y: 0, width: 2, height: 2, tag: 1 });
		const second = world.loadEntity({ x: 20, y: 0, width: 2, height: 2, tag: 2 });

		expect(world.findNearestSpatial(0, 0, Infinity, entity => entity.components.tag?.tag === 2)).toBe(second);
		expect(world.findNearbySpatial(0, 0, 2)).toEqual([first, second]);
	});
});
