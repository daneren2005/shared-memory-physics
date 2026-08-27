import { SHAPE_CIRCLE } from '../components/body-component';
import { createTestWorld, type TestWorld } from './fixtures/world';

describe('spatial-world', () => {
	let world: TestWorld;

	beforeEach(() => {
		world = createTestWorld();
	});

	afterEach(() => {
		world.destroy();
	});

	it('indexes entities by their shape bounds as they are added', () => {
		const circle = world.loadEntity({ x: 20, y: 30, radius: 5 });
		world.loadEntity({ x: 100, y: 100, width: 10, height: 10 });

		expect(world.searchSpatial(14, 24, 26, 36)).toEqual([circle]);
		expect(world.searchSpatial(0, 0, 10, 10)).toEqual([]);
		expect(circle.components.body?.shape).toEqual(SHAPE_CIRCLE);
	});

	it('updates and removes entries through the world lifecycle', () => {
		const entity = world.loadEntity({ x: 0, y: 0, width: 4, height: 4 });
		entity.components.transform!.x = 100;
		world.updateSpatialEntity(entity);

		expect(world.searchSpatial(-5, -5, 5, 5)).toEqual([]);
		expect(world.searchSpatial(95, -5, 105, 5)).toEqual([entity]);

		world.removeEntity(entity);
		expect(world.searchSpatial(95, -5, 105, 5)).toEqual([]);
	});

	it('finds nearest entities by distance to their bounds and applies filters', () => {
		const near = world.loadEntity({ x: 20, y: 0, width: 10, height: 10, tag: 1 });
		const far = world.loadEntity({ x: 50, y: 0, width: 10, height: 10, tag: 2 });

		expect(world.findNearestSpatial(0, 0)).toEqual(near);
		expect(world.findNearestSpatial(0, 0, Infinity, entity => entity.components.tag?.tag === 2)).toEqual(far);
		expect(world.findNearbySpatial(0, 0, 2)).toEqual([near, far]);
	});
});
