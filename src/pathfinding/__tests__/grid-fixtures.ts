import NavGrid from '../nav-grid';
import { sweepCost } from '../line-of-sight';
import type { PathRequest, Point } from '../path-search';

export const CELL = 32;
export const AGENT = CELL;

// '#' blocked, '.' open, '~' mud (x0.5), '=' road (x1.5), '_' fast road (x2). Rows must be the same length.
export function gridFrom(rows: ReadonlyArray<string>): NavGrid {
	const grid = new NavGrid(rows[0].length, rows.length, CELL);
	rows.forEach((row, y) => {
		if(row.length !== grid.tilesWide) {
			throw new Error(`Row ${y} is ${row.length} wide, expected ${grid.tilesWide}`);
		}
		[...row].forEach((tile, x) => {
			if(tile === '#') {
				grid.addBlocker(tileRect(x, y));
			} else if(tile === '~') {
				grid.setTerrainSpeed(x, y, 0.5);
			} else if(tile === '=') {
				grid.setTerrainSpeed(x, y, 1.5);
			} else if(tile === '_') {
				grid.setTerrainSpeed(x, y, 2);
			}
		});
	});
	return grid;
}

export function tileRect(x: number, y: number, tilesWide = 1, tilesHigh = 1) {
	return { minX: x * CELL, minY: y * CELL, maxX: (x + tilesWide) * CELL, maxY: (y + tilesHigh) * CELL };
}

export function center(x: number, y: number): Point {
	return { x: (x + 0.5) * CELL, y: (y + 0.5) * CELL };
}

export function request(from: Point, to: Point, size = AGENT): PathRequest {
	return { startX: from.x, startY: from.y, goalX: to.x, goalY: to.y, agentWidth: size, agentHeight: size };
}

export function tileOf(point: Point): Point {
	return { x: Math.floor(point.x / CELL), y: Math.floor(point.y / CELL) };
}

// Every leg a mover of `size` would walk, starting from `from`, stays off blocked tiles.
export function legsAreClear(grid: NavGrid, from: Point, points: ReadonlyArray<Point>, size = AGENT): boolean {
	let previous = from;
	for(const point of points) {
		if(!Number.isFinite(sweepCost(grid, previous.x, previous.y, point.x, point.y, size / 2, size / 2))) {
			return false;
		}
		previous = point;
	}
	return true;
}

// Every tile a mover of `size` crosses walking the path.
export function tilesTouched(grid: NavGrid, from: Point, points: ReadonlyArray<Point>, size = AGENT): Set<string> {
	const touched = new Set<string>();
	let previous = from;
	for(const point of points) {
		for(let y = 0; y < grid.tilesHigh; y++) {
			for(let x = 0; x < grid.tilesWide; x++) {
				const probe = new NavGrid(grid.tilesWide, grid.tilesHigh, CELL);
				probe.addBlocker(tileRect(x, y));
				if(!Number.isFinite(sweepCost(probe, previous.x, previous.y, point.x, point.y, size / 2, size / 2))) {
					touched.add(`${x},${y}`);
				}
			}
		}
		previous = point;
	}
	return touched;
}

export function pathLength(from: Point, points: ReadonlyArray<Point>): number {
	let total = 0;
	let previous = from;
	for(const point of points) {
		total += Math.hypot(point.x - previous.x, point.y - previous.y);
		previous = point;
	}
	return total;
}

// Reference answer: cheapest 4-way cost between two open 1x1 tiles, entering a tile costing grid.cost. Infinity if none.
export function dijkstraCost(grid: NavGrid, from: Point, to: Point): number {
	const best = new Float64Array(grid.tileCount).fill(Infinity);
	const done = new Uint8Array(grid.tileCount);
	const start = grid.index(from.x, from.y);
	best[start] = 0;
	for(;;) {
		let current = -1;
		for(let i = 0; i < best.length; i++) {
			if(!done[i] && best[i] < Infinity && (current === -1 || best[i] < best[current])) {
				current = i;
			}
		}
		if(current === -1) {
			return Infinity;
		}
		if(current === grid.index(to.x, to.y)) {
			return best[current];
		}
		done[current] = 1;
		const x = current % grid.tilesWide;
		const y = Math.floor(current / grid.tilesWide);
		for(const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
			const nx = x + dx;
			const ny = y + dy;
			if(grid.isBlocked(nx, ny)) {
				continue;
			}
			const next = best[current] + grid.cost(nx, ny);
			const index = grid.index(nx, ny);
			if(next < best[index]) {
				best[index] = next;
			}
		}
	}
}

// Deterministic PRNG so randomised cases are repeatable.
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function randomRows(random: () => number, tilesWide: number, tilesHigh: number, wallChance: number, terrain = false): Array<string> {
	return Array.from({ length: tilesHigh }, () => Array.from({ length: tilesWide }, () => {
		const roll = random();
		if(roll < wallChance) {
			return '#';
		}
		if(!terrain) {
			return '.';
		}
		return ['.', '.', '~', '=', '_'][Math.floor(random() * 5)];
	}).join(''));
}