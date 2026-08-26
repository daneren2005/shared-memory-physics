import type SharedSpatialMap from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import type { EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import { boundsOverlap, distanceToBoundsSquared, querySize, spatialBounds } from './spatial-bounds';

export type SpatialComponents = {
	transform: Float32Array
	body?: Uint32Array
};

export interface SpatialEntity<T extends SpatialComponents = SpatialComponents> {
	entityId: number
	components: T
}

export type SpatialFilter<T extends SpatialComponents = SpatialComponents> = (entity: SpatialEntity<T>) => boolean;

// A query view over the world's live SharedSpatialMap. Membership is captured from the system query, while every
// position read comes from the shared transform block, so workers reuse the world map without rebuilding it.
export default class SpatialIndex<T extends SpatialComponents = SpatialComponents> {
	private map: SharedSpatialMap;
	private entries = new Map<number, SpatialEntity<T>>();
	private candidateIds: Array<number> = [];

	constructor(map: SharedSpatialMap, entities: Iterable<{ entityId: number, components: EntityUpdateComponents }>) {
		this.map = map;
		for(const entity of entities) {
			const components = entity.components as T;
			if(components.transform) {
				this.entries.set(entity.entityId, { entityId: entity.entityId, components });
			}
		}
	}

	get size(): number {
		return this.entries.size;
	}

	search(minX: number, minY: number, maxX: number, maxY: number, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		if(maxX < minX || maxY < minY) {
			return [];
		}

		const found: Array<SpatialEntity<T>> = [];
		const ids = this.candidateIds;
		ids.length = 0;
		this.map.retrieveInto(ids, minX, minY, querySize(minX, maxX), querySize(minY, maxY));
		for(const id of ids) {
			const entity = this.entries.get(id);
			if(!entity || filter && !filter(entity)) {
				continue;
			}

			if(boundsOverlap(spatialBounds(entity.components), minX, minY, maxX, maxY)) {
				found.push(entity);
			}
		}

		return found;
	}

	searchAround(x: number, y: number, reachX: number, reachY: number, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		return this.search(x - reachX, y - reachY, x + reachX, y + reachY, filter);
	}

	findNearest(x: number, y: number, maxDistance = Infinity, filter?: SpatialFilter<T>): SpatialEntity<T> | undefined {
		return this.findNearby(x, y, 1, maxDistance, filter)[0];
	}

	findNearby(x: number, y: number, maxResults: number, maxDistance = Infinity, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		if(maxResults <= 0 || maxDistance < 0) {
			return [];
		}

		const minX = x - maxDistance;
		const minY = y - maxDistance;
		const maxX = x + maxDistance;
		const maxY = y + maxDistance;
		const maxDistanceSquared = maxDistance * maxDistance;
		const candidates = Number.isFinite(maxDistance)
			? this.search(minX, minY, maxX, maxY, filter)
			: [...this.entries.values()].filter(entity => !filter || filter(entity));
		const measured = candidates.flatMap(entity => {
			const distance = distanceToBoundsSquared(x, y, spatialBounds(entity.components));
			return distance <= maxDistanceSquared ? [{ entity, distance }] : [];
		});
		measured.sort((a, b) => a.distance - b.distance);

		return measured.slice(0, maxResults).map(entry => entry.entity);
	}
}
