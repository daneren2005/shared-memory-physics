import { BaseEntity, EntityFactory } from '@daneren2005/shared-memory-ecs';
import { SHAPE_CIRCLE } from '../components/body-component-constants';
import PhysicalWorld from '../world';
import { createTestWorld, registry, type Components, type Config, type TestWorld } from './fixtures/world';

class WrappedEntity extends BaseEntity<Components, Config> {
	get tag(): number | undefined {
		return this.components.tag?.tag;
	}
}

class WrappedFactory extends EntityFactory<Components, Config, WrappedEntity> {
	protected createEntity(config: Config): WrappedEntity {
		return new WrappedEntity(this.world, config);
	}
}

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

	it('fills the spatial map from a load before onEntitiesReady runs', async () => {
		const ids: Array<Array<number>> = [];
		await world.load({ entities: [{ x: 0, y: 0, width: 4, height: 4 }, { x: 100, y: 100, radius: 5 }] }, {
			onEntitiesReady: () => {
				ids.push(world.spatialMap.search(-10, -10, 200, 200).sort((a, b) => a - b));
			},
		});

		const eids = Array.from(world.entities.keys()).sort((a, b) => a - b);
		expect(ids).toEqual([eids]);
		expect(world.searchSpatial(95, 95, 105, 105).map(entity => entity.eid)).toEqual([eids[1]]);
	});

	it('finds the entities added so far when searched mid-load', async () => {
		const seen: Array<number> = [];
		world.on('entity-added', () => {
			seen.push(world.searchSpatial(-10, -10, 200, 200).length);
		});
		await world.load({ entities: [{ x: 0, y: 0, width: 4, height: 4 }, { x: 100, y: 100, width: 4, height: 4 }] }, { sliceMs: 0 });

		expect(seen).toEqual([1, 2]);
		expect(world.searchSpatial(-10, -10, 200, 200)).toHaveLength(2);
	});

	it('leaves out an entity removed during the load', async () => {
		world.on('entity-added', entity => {
			if(entity.components.tag?.tag === 1) {
				world.removeEntity(entity);
			}
		});
		await world.load({ entities: [{ x: 0, y: 0, width: 4, height: 4, tag: 1 }, { x: 100, y: 100, width: 4, height: 4 }] });

		expect(world.spatialMap.search(-10, -10, 200, 200)).toHaveLength(1);
		expect(world.searchSpatial(-10, -10, 10, 10)).toEqual([]);
	});

	it('preserves a configured entity wrapper in spatial results', () => {
		const wrappedWorld = new PhysicalWorld<typeof registry, WrappedEntity>(registry, {
			factory: new WrappedFactory(),
			spatial: { gridSize: 50, maxEntities: 100, maxSlots: 1_000 },
		});
		wrappedWorld.loadEntity({ x: 0, y: 0, width: 4, height: 4, tag: 7 });

		expect(wrappedWorld.findNearestSpatial(0, 0)?.tag).toBe(7);
		wrappedWorld.destroy();
	});
});
