import SharedSpatialMap from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import type { SharedSpatialMapConfig, SharedSpatialMapMemory } from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import { BaseWorld } from '@daneren2005/shared-memory-ecs';
import type {
	BaseEntity,
	ComponentDefinitionMap,
	ComponentsOf,
	ComponentSystemWorld,
	EntityConfigOf,
	WorldOptions,
} from '@daneren2005/shared-memory-ecs';
import { boundsOverlap, querySize, spatialBounds } from './systems/spatial-bounds';

export interface PhysicalWorldData {
	spatialMapMemory?: SharedSpatialMapMemory
}

export interface PhysicalSystemWorld extends ComponentSystemWorld, PhysicalWorldData {
	spatialMap?: SharedSpatialMap
}

export interface PhysicalWorldSource {
	spatialMap: SharedSpatialMap
}

export type PhysicalWorldOptions<R extends ComponentDefinitionMap> = WorldOptions<ComponentsOf<R>, EntityConfigOf<R>> & {
	spatial?: SharedSpatialMapConfig
};

export type PhysicalWorldEntity<R extends ComponentDefinitionMap> = BaseEntity<ComponentsOf<R>, EntityConfigOf<R>>;
export type PhysicalWorldFilter<R extends ComponentDefinitionMap> = (entity: PhysicalWorldEntity<R>) => boolean;

interface SpatialAccessorComponents {
	transform?: { block?: Float32Array }
	body?: { block?: Uint32Array }
}

export function addPhysicalWorldData(source: PhysicalWorldSource, target: PhysicalWorldData): void {
	target.spatialMapMemory = source.spatialMap.getSharedMemory();
}

export function getSpatialMap(world: PhysicalSystemWorld): SharedSpatialMap {
	if(world.spatialMap) {
		return world.spatialMap;
	}
	if(!world.heap || !world.spatialMapMemory) {
		throw new Error('Spatial system world is missing its shared MemoryHeap or spatial map');
	}

	world.spatialMap = new SharedSpatialMap(world.heap, world.spatialMapMemory);

	return world.spatialMap;
}

export default class PhysicalWorld<R extends ComponentDefinitionMap> extends BaseWorld<R> implements PhysicalWorldSource {
	readonly spatialMap: SharedSpatialMap;
	private spatialIds = new Set<number>();

	constructor(registry: R, options: PhysicalWorldOptions<R> = {}) {
		const { spatial, ...worldOptions } = options;
		super(registry, worldOptions);

		this.spatialMap = new SharedSpatialMap(this.heap, spatial);
		this.on('entity-added', (entity: PhysicalWorldEntity<R>) => {
			this.updateSpatialEntity(entity);
			entity.on('component-added', (name: string) => {
				if(name === 'transform' || name === 'body') {
					this.updateSpatialEntity(entity);
				}
			});
			entity.on('component-removed', (name: string) => {
				if(name === 'transform' || name === 'body') {
					this.updateSpatialEntity(entity);
				}
			});
		});
		this.on('entity-removed', (entity: PhysicalWorldEntity<R>) => {
			this.spatialIds.delete(entity.eid);
			this.spatialMap.remove(entity.eid);
		});
	}

	updateSpatialEntity(entityOrId: PhysicalWorldEntity<R> | number): void {
		const entity = typeof entityOrId === 'number' ? this.getEntityByEid(entityOrId) : entityOrId;
		if(!entity) {
			return;
		}

		const components = entity.components as typeof entity.components & SpatialAccessorComponents;
		const transform = components.transform?.block;
		if(!transform) {
			this.spatialIds.delete(entity.eid);
			this.spatialMap.remove(entity.eid);
			return;
		}

		const bounds = spatialBounds({ transform, body: components.body?.block });
		this.spatialIds.add(entity.eid);
		this.spatialMap.update(entity.eid, bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
	}

	searchSpatial(minX: number, minY: number, maxX: number, maxY: number, filter?: PhysicalWorldFilter<R>): Array<PhysicalWorldEntity<R>> {
		if(maxX < minX || maxY < minY) {
			return [];
		}

		const found: Array<PhysicalWorldEntity<R>> = [];
		const ids = Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)
			? this.spatialMap.search(minX, minY, querySize(minX, maxX), querySize(minY, maxY))
			: this.spatialIds;
		for(const id of ids) {
			const entity = this.getEntityByEid(id);
			if(!entity || filter && !filter(entity)) {
				continue;
			}

			const components = entity.components as typeof entity.components & SpatialAccessorComponents;
			const transform = components.transform?.block;
			if(transform && boundsOverlap(spatialBounds({ transform, body: components.body?.block }), minX, minY, maxX, maxY)) {
				found.push(entity);
			}
		}

		return found;
	}

	searchSpatialAround(x: number, y: number, reachX: number, reachY: number, filter?: PhysicalWorldFilter<R>): Array<PhysicalWorldEntity<R>> {
		return this.searchSpatial(x - reachX, y - reachY, x + reachX, y + reachY, filter);
	}

	findNearestSpatial(x: number, y: number, maxDistance = Infinity, filter?: PhysicalWorldFilter<R>): PhysicalWorldEntity<R> | undefined {
		return this.findNearbySpatial(x, y, 1, maxDistance, filter)[0];
	}

	findNearbySpatial(x: number, y: number, maxResults: number, maxDistance = Infinity, filter?: PhysicalWorldFilter<R>): Array<PhysicalWorldEntity<R>> {
		const ids = this.spatialMap.neighbors(x, y, maxResults, maxDistance, id => {
			const entity = this.getEntityByEid(id);
			return !!entity && (!filter || filter(entity));
		});

		return ids.flatMap(id => {
			const entity = this.getEntityByEid(id);
			return entity ? [entity] : [];
		});
	}
}
