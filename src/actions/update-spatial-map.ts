import type SharedSpatialMap from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import { spatialBounds, type SpatialBlockComponents } from '../systems/spatial-bounds';
import type { PhysicalSystemWorld } from '../world';
import { getSpatialMap } from './get-spatial-map';

export function updateSpatialMap(world: PhysicalSystemWorld, entityId: number, components: SpatialBlockComponents): void {
	if(!world.spatialMap && (!world.heap || !world.spatialMapMemory)) {
		return;
	}

	const spatialMap: SharedSpatialMap = getSpatialMap(world);
	const bounds = spatialBounds(components);
	spatialMap.update(entityId, bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
}

