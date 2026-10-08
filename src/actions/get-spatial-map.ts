import SharedSpatialMap from '@daneren2005/shared-memory-objects/spatial/shared-spatial-map';
import type { PhysicalSystemWorld } from '../world';

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

