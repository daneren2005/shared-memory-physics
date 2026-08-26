import SharedSpatialMap from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import type { SharedSpatialMapConfig, SharedSpatialMapMemory } from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import { BaseWorld } from '@daneren2005/shared-memory-ecs';
import type {
	BaseEntity,
	ComponentSystemWorld,
	ComponentDefinitionMap,
	ComponentsOf,
	EntityConfigOf,
	WorldOptions,
} from '@daneren2005/shared-memory-ecs';
import { boundsOverlap, distanceToBoundsSquared, querySize, spatialBounds } from './systems/spatial-bounds';

export interface SpatialMapWorldData {
	spatialMapMemory: SharedSpatialMapMemory
}

export interface SpatialMapSystemWorld extends ComponentSystemWorld, SpatialMapWorldData {
	spatialMap?: SharedSpatialMap
}

export interface SpatialMapWorldSource {
	spatialMap: SharedSpatialMap
}

export type SpatialWorldOptions<R extends ComponentDefinitionMap> = WorldOptions<ComponentsOf<R>, EntityConfigOf<R>> & {
	spatial?: SharedSpatialMapConfig
};

export type SpatialWorldEntity<R extends ComponentDefinitionMap> = BaseEntity<ComponentsOf<R>, EntityConfigOf<R>>;
export type SpatialWorldFilter<R extends ComponentDefinitionMap> = (entity: SpatialWorldEntity<R>) => boolean;

interface SpatialAccessorComponents {
	transform?: { block?: Float32Array }
	body?: { block?: Uint32Array }
}

export function addSpatialMapData(source: SpatialMapWorldSource, target: SpatialMapWorldData): void {
	target.spatialMapMemory = source.spatialMap.getSharedMemory();
}

export function getSpatialMap(world: SpatialMapSystemWorld): SharedSpatialMap {
	if(world.spatialMap) {
		return world.spatialMap;
	}
	if(!world.heap) {
		throw new Error('Spatial system world is missing its shared MemoryHeap');
	}

	world.spatialMap = new SharedSpatialMap(world.heap, world.spatialMapMemory);

	return world.spatialMap;
}

export default class SpatialWorld<R extends ComponentDefinitionMap> extends BaseWorld<R> implements SpatialMapWorldSource {
	readonly spatialMap: SharedSpatialMap;
	private spatialIds = new Set<number>();

	constructor(registry: R, options: SpatialWorldOptions<R>) {
		const { spatial, ...worldOptions } = options;
		super(registry, worldOptions);

		this.spatialMap = new SharedSpatialMap(this.heap, spatial);
		this.on('entity-added', (entity: SpatialWorldEntity<R>) => {
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
		this.on('entity-removed', (entity: SpatialWorldEntity<R>) => {
			this.spatialIds.delete(entity.eid);
			this.spatialMap.remove(entity.eid);
		});
	}

	updateSpatialEntity(entityOrId: SpatialWorldEntity<R> | number): void {
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

	searchSpatial(minX: number, minY: number, maxX: number, maxY: number, filter?: SpatialWorldFilter<R>): Array<SpatialWorldEntity<R>> {
		if(maxX < minX || maxY < minY) {
			return [];
		}

		const found: Array<SpatialWorldEntity<R>> = [];
		const ids = Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)
			? this.spatialMap.retrieve(minX, minY, querySize(minX, maxX), querySize(minY, maxY))
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

	searchSpatialAround(x: number, y: number, reachX: number, reachY: number, filter?: SpatialWorldFilter<R>): Array<SpatialWorldEntity<R>> {
		return this.searchSpatial(x - reachX, y - reachY, x + reachX, y + reachY, filter);
	}

	findNearestSpatial(x: number, y: number, maxDistance = Infinity, filter?: SpatialWorldFilter<R>): SpatialWorldEntity<R> | undefined {
		return this.findNearbySpatial(x, y, 1, maxDistance, filter)[0];
	}

	findNearbySpatial(x: number, y: number, maxResults: number, maxDistance = Infinity, filter?: SpatialWorldFilter<R>): Array<SpatialWorldEntity<R>> {
		if(maxResults <= 0 || maxDistance < 0) {
			return [];
		}

		const minX = x - maxDistance;
		const minY = y - maxDistance;
		const maxX = x + maxDistance;
		const maxY = y + maxDistance;
		const maxDistanceSquared = maxDistance * maxDistance;
		const candidates = this.searchSpatial(minX, minY, maxX, maxY, filter);
		const measured = candidates.flatMap(entity => {
			const components = entity.components as typeof entity.components & SpatialAccessorComponents;
			const transform = components.transform?.block;
			if(!transform) {
				return [];
			}

			const distance = distanceToBoundsSquared(x, y, spatialBounds({ transform, body: components.body?.block }));
			return distance <= maxDistanceSquared ? [{ entity, distance }] : [];
		});
		measured.sort((a, b) => a.distance - b.distance);

		return measured.slice(0, maxResults).map(entry => entry.entity);
	}
}

export const addSpatialTreeData = addSpatialMapData;
export const getSpatialTree = getSpatialMap;
export type SpatialTreeWorldData = SpatialMapWorldData;
export type SpatialTreeSystemWorld = SpatialMapSystemWorld;
export type SpatialTreeWorldSource = SpatialMapWorldSource;
