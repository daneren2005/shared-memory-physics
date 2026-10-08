import type { PhysicalWorldSource, PhysicalWorldData } from '../world';

export function addPhysicalWorldData(source: PhysicalWorldSource, target: PhysicalWorldData): void {
	target.spatialMapMemory = source.spatialMap.getSharedMemory();
}

