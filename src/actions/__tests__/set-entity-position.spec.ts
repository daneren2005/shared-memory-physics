import { setEntityPosition } from '../../index';
import { createTestWorld, type TestWorld } from '../../__tests__/fixtures/world';
import { SHAPE_CAPSULE } from '../../components/body-component';
import { TRANSFORM_SIZE, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';
import { addPhysicalWorldData, type PhysicalSystemWorld } from '../../world';

describe('setEntityPosition', () => {
	let world: TestWorld;

	beforeEach(() => {
		world = createTestWorld();
	});

	afterEach(() => {
		world.destroy();
	});

	it.each([false, true])('moves shared bounds through a reconstructed map handle: %s', reconstructed => {
		const entity = world.loadEntity({ x: 20, y: 30, width: 40, height: 10, angle: Math.PI / 2, shape: SHAPE_CAPSULE });
		const transform = entity.components.transform!.block;
		const body = entity.components.body!.block;
		if(!(transform instanceof Float32Array) || !(body instanceof Uint32Array)) {
			throw new Error('Missing physics blocks');
		}
		const geometry = Array.from(transform.slice(2));
		const flags = Array.from(body);
		const workerWorld: PhysicalSystemWorld = { gameTime: 0, elapsedTime: 50, getString: () => '', heap: world.heap };
		if(reconstructed) {
			addPhysicalWorldData(world, workerWorld);
		} else {
			workerWorld.spatialMap = world.spatialMap;
		}

		for(const position of [{ x: 300, y: 400 }, { x: -200, y: -300 }]) {
			const previous = { x: transform[TRANSFORM_X_INDEX], y: transform[TRANSFORM_Y_INDEX] };
			setEntityPosition(workerWorld, { entityId: entity.eid, components: { transform, body } }, position);

			expect(entity.components.transform).toMatchObject(position);
			expect(world.spatialMap.search(previous.x - 5, previous.y - 5, 10, 10)).not.toContain(entity.eid);
			expect(world.searchSpatial(position.x - 1, position.y + 18, position.x + 1, position.y + 19)).toEqual([entity]);
			expect(world.searchSpatial(position.x + 10, position.y - 1, position.x + 11, position.y + 1)).toEqual([]);
			expect(world.findNearestSpatial(position.x, position.y)).toBe(entity);
			expect(Array.from(transform.slice(2))).toEqual(geometry);
			expect(Array.from(body)).toEqual(flags);
		}
	});

	it('indexes an entity with a transform and no body', () => {
		const entity = world.loadEntity({ x: 20, y: 30, width: 40, height: 10 });
		const transform = entity.components.transform!.block;
		const workerWorld: PhysicalSystemWorld = { gameTime: 0, elapsedTime: 50, getString: () => '', spatialMap: world.spatialMap };

		setEntityPosition(workerWorld, { entityId: entity.eid, components: { transform } }, { x: 300, y: 400 });

		expect(world.searchSpatial(318, 399, 319, 401)).toEqual([entity]);
		expect(world.spatialMap.search(19, 29, 2, 2)).not.toContain(entity.eid);
	});

	it('sets a position without a spatial map', () => {
		const transform = new Float32Array(TRANSFORM_SIZE);
		setEntityPosition({ gameTime: 0, elapsedTime: 50, getString: () => '' }, { entityId: 1, components: { transform } }, { x: 12.5, y: -7.25 });

		expect(transform[TRANSFORM_X_INDEX]).toBe(12.5);
		expect(transform[TRANSFORM_Y_INDEX]).toBe(-7.25);
	});

	it('ignores an entity without a transform', () => {
		const workerWorld: PhysicalSystemWorld = { gameTime: 0, elapsedTime: 50, getString: () => '', spatialMap: world.spatialMap };
		setEntityPosition(workerWorld, { entityId: 1, components: {} }, { x: 300, y: 400 });

		expect(world.spatialMap.search(299, 399, 2, 2)).toEqual([]);
	});
});
