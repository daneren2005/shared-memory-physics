// World-space axis-aligned box. Edges are exclusive, so a blocker ending exactly on a tile edge stays out of the next tile.
export interface Rect {
	minX: number
	minY: number
	maxX: number
	maxY: number
}

export interface TileRange {
	fromX: number
	fromY: number
	toX: number
	toY: number
}

const NO_REGION = 0;

// Walkability and terrain cost per square tile, with (0, 0) the map's top-left corner. Blockers are counted rather
// than flagged so overlapping blockers can be removed in any order.
export default class NavGrid {
	readonly tilesWide: number;
	readonly tilesHigh: number;
	readonly cellSize: number;
	private blockers: Uint16Array;
	private speeds: Float32Array;
	// Only ever raised, so the search heuristic stays admissible after a fast road is repaved as mud.
	private fastestSpeed = 1;
	// 4-connected open areas, rebuilt lazily after blockers change. A diagonal step needs both orthogonal tiles open,
	// so it never joins two regions.
	private regions: Int32Array;
	private regionsDirty = true;

	constructor(tilesWide: number, tilesHigh: number, cellSize: number) {
		if(!Number.isInteger(tilesWide) || !Number.isInteger(tilesHigh) || tilesWide <= 0 || tilesHigh <= 0) {
			throw new Error(`NavGrid needs a positive whole number of tiles, got ${tilesWide}x${tilesHigh}`);
		}
		if(!(cellSize > 0)) {
			throw new Error(`NavGrid needs a positive cell size, got ${cellSize}`);
		}
		this.tilesWide = tilesWide;
		this.tilesHigh = tilesHigh;
		this.cellSize = cellSize;
		this.blockers = new Uint16Array(tilesWide * tilesHigh);
		this.speeds = new Float32Array(tilesWide * tilesHigh).fill(1);
		this.regions = new Int32Array(tilesWide * tilesHigh);
	}

	clone(): NavGrid {
		const copy = new NavGrid(this.tilesWide, this.tilesHigh, this.cellSize);
		copy.blockers.set(this.blockers);
		copy.speeds.set(this.speeds);
		copy.fastestSpeed = this.fastestSpeed;
		return copy;
	}

	get tileCount(): number {
		return this.tilesWide * this.tilesHigh;
	}

	get maxSpeed(): number {
		return this.fastestSpeed;
	}

	inBounds(tileX: number, tileY: number): boolean {
		return tileX >= 0 && tileY >= 0 && tileX < this.tilesWide && tileY < this.tilesHigh;
	}

	index(tileX: number, tileY: number): number {
		return tileY * this.tilesWide + tileX;
	}

	tileOf(world: number): number {
		return Math.floor(world / this.cellSize);
	}

	tileCenter(tile: number): number {
		return (tile + 0.5) * this.cellSize;
	}

	// Off the map counts as blocked.
	isBlocked(tileX: number, tileY: number): boolean {
		return !this.inBounds(tileX, tileY) || this.blockers[this.index(tileX, tileY)] > 0;
	}

	isAreaClear(tileX: number, tileY: number, tilesWide: number, tilesHigh: number): boolean {
		if(!this.inBounds(tileX, tileY) || !this.inBounds(tileX + tilesWide - 1, tileY + tilesHigh - 1)) {
			return false;
		}
		for(let y = tileY; y < tileY + tilesHigh; y++) {
			for(let x = tileX; x < tileX + tilesWide; x++) {
				if(this.blockers[this.index(x, y)] > 0) {
					return false;
				}
			}
		}
		return true;
	}

	blockerCount(tileX: number, tileY: number): number {
		return this.inBounds(tileX, tileY) ? this.blockers[this.index(tileX, tileY)] : 0;
	}

	// The tiles a rect has area in, clamped to the map; empty (toX < fromX) for a rect with no area or off the map.
	tilesIn(rect: Rect): TileRange {
		if(!(rect.maxX > rect.minX) || !(rect.maxY > rect.minY)) {
			return { fromX: 0, fromY: 0, toX: -1, toY: -1 };
		}
		return {
			fromX: Math.max(0, Math.floor(rect.minX / this.cellSize)),
			fromY: Math.max(0, Math.floor(rect.minY / this.cellSize)),
			toX: Math.min(this.tilesWide - 1, Math.ceil(rect.maxX / this.cellSize) - 1),
			toY: Math.min(this.tilesHigh - 1, Math.ceil(rect.maxY / this.cellSize) - 1),
		};
	}

	addBlocker(rect: Rect): void {
		const range = this.tilesIn(rect);
		for(let y = range.fromY; y <= range.toY; y++) {
			for(let x = range.fromX; x <= range.toX; x++) {
				const i = this.index(x, y);
				if(this.blockers[i] < 0xFFFF) {
					this.blockers[i]++;
				}
			}
		}
		this.regionsDirty = true;
	}

	// Must be given the same rect that was added.
	removeBlocker(rect: Rect): void {
		const range = this.tilesIn(rect);
		for(let y = range.fromY; y <= range.toY; y++) {
			for(let x = range.fromX; x <= range.toX; x++) {
				const i = this.index(x, y);
				if(this.blockers[i] > 0) {
					this.blockers[i]--;
				}
			}
		}
		this.regionsDirty = true;
	}

	// A multiplier on walking speed: 1.5 for a road, 0.5 for mud.
	setTerrainSpeed(tileX: number, tileY: number, speed: number): void {
		if(!(speed > 0) || !Number.isFinite(speed)) {
			throw new Error(`Terrain speed must be a positive finite number, got ${speed}`);
		}
		if(!this.inBounds(tileX, tileY)) {
			return;
		}
		this.speeds[this.index(tileX, tileY)] = speed;
		this.fastestSpeed = Math.max(this.fastestSpeed, speed);
	}

	terrainSpeed(tileX: number, tileY: number): number {
		return this.inBounds(tileX, tileY) ? this.speeds[this.index(tileX, tileY)] : 1;
	}

	// Time-weighted cost of crossing a tile edge to edge.
	cost(tileX: number, tileY: number): number {
		return this.cellSize / this.speeds[this.index(tileX, tileY)];
	}

	// 0 for a blocked or off-map tile.
	region(tileX: number, tileY: number): number {
		if(!this.inBounds(tileX, tileY)) {
			return NO_REGION;
		}
		if(this.regionsDirty) {
			this.rebuildRegions();
		}
		return this.regions[this.index(tileX, tileY)];
	}

	private rebuildRegions(): void {
		const regions = this.regions;
		regions.fill(NO_REGION);
		const queue = new Int32Array(this.tileCount);
		let next = NO_REGION;
		for(let start = 0; start < regions.length; start++) {
			if(regions[start] !== NO_REGION || this.blockers[start] > 0) {
				continue;
			}
			next++;
			regions[start] = next;
			let head = 0;
			let tail = 0;
			queue[tail++] = start;
			while(head < tail) {
				const i = queue[head++];
				const x = i % this.tilesWide;
				const y = (i - x) / this.tilesWide;
				tail = this.flood(x - 1, y, next, queue, tail);
				tail = this.flood(x + 1, y, next, queue, tail);
				tail = this.flood(x, y - 1, next, queue, tail);
				tail = this.flood(x, y + 1, next, queue, tail);
			}
		}
		this.regionsDirty = false;
	}

	private flood(x: number, y: number, region: number, queue: Int32Array, tail: number): number {
		if(!this.inBounds(x, y)) {
			return tail;
		}
		const i = this.index(x, y);
		if(this.regions[i] !== NO_REGION || this.blockers[i] > 0) {
			return tail;
		}
		this.regions[i] = region;
		queue[tail] = i;
		return tail + 1;
	}
}