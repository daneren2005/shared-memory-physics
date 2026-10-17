// Walking-speed multipliers per tile, shared by the main thread (which paints them), the pathfinding worker (which
// costs paths by them) and the path follower (which slows movers by them). Plain object of shared arrays so it
// survives being cloned into a worker's init data without losing the sharing.
export interface TerrainData {
	tilesWide: number
	tilesHigh: number
	cellSize: number
	speeds: Float32Array
	// Bumped on every change so the pathfinding worker only re-copies speeds into its grids when something changed.
	version: Int32Array
}

export function createTerrain(tilesWide: number, tilesHigh: number, cellSize: number): TerrainData {
	// Without cross-origin isolation everything runs in-process, so a plain buffer is shared by reference anyway.
	const Buffer = crossOriginIsolated ? SharedArrayBuffer : ArrayBuffer;
	return {
		tilesWide,
		tilesHigh,
		cellSize,
		speeds: new Float32Array(new Buffer(tilesWide * tilesHigh * Float32Array.BYTES_PER_ELEMENT)).fill(1),
		version: new Int32Array(new Buffer(Int32Array.BYTES_PER_ELEMENT)),
	};
}

export function setTerrainSpeed(terrain: TerrainData, tileX: number, tileY: number, speed: number): boolean {
	if(tileX < 0 || tileY < 0 || tileX >= terrain.tilesWide || tileY >= terrain.tilesHigh) {
		return false;
	}
	const index = tileY * terrain.tilesWide + tileX;
	if(terrain.speeds[index] === speed) {
		return false;
	}
	terrain.speeds[index] = speed;
	Atomics.add(terrain.version, 0, 1);
	return true;
}

export function terrainSpeedAt(terrain: TerrainData, x: number, y: number): number {
	const tileX = Math.floor(x / terrain.cellSize);
	const tileY = Math.floor(y / terrain.cellSize);
	if(tileX < 0 || tileY < 0 || tileX >= terrain.tilesWide || tileY >= terrain.tilesHigh) {
		return 1;
	}
	return terrain.speeds[tileY * terrain.tilesWide + tileX];
}
