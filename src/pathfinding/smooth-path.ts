import { sweepCost } from './line-of-sight';
import type NavGrid from './nav-grid';
import type { Point } from './path-search';

// Turns checked ahead of each kept point; bounds smoothing to O(turns x LOOKAHEAD) sweeps on a long staircase.
const LOOKAHEAD = 24;

// Terrain-aware string pulling over a walkable polyline (start first). A corner is only cut when the straight line is
// clear with `clearance` to spare and, costing it at the slowest terrain it touches, is no dearer than the stretch it
// replaces, so a path that detoured around mud is not pulled back through it.
export function smoothPath(grid: NavGrid, points: ReadonlyArray<Point>, halfWidth: number, halfHeight: number, clearance: number): Array<Point> {
	const polyline = dropDuplicates(points);
	if(polyline.length <= 2) {
		return polyline;
	}

	// Costed without the clearance: the unsmoothed path legitimately brushes walls.
	const travelled = new Float64Array(polyline.length);
	for(let i = 1; i < polyline.length; i++) {
		travelled[i] = travelled[i - 1] + segmentCost(grid, polyline[i - 1], polyline[i], halfWidth, halfHeight);
	}

	const turns = [0];
	for(let i = 1; i < polyline.length - 1; i++) {
		if(!isCollinear(polyline[i - 1], polyline[i], polyline[i + 1])) {
			turns.push(i);
		}
	}
	turns.push(polyline.length - 1);

	const result = [polyline[0]];
	let from = 0;
	while(from < turns.length - 1) {
		let to = from + 1;
		// Visibility is not monotonic (a shortcut can fail while a longer one succeeds), so look the whole window over.
		const last = Math.min(turns.length - 1, from + LOOKAHEAD);
		for(let candidate = from + 2; candidate <= last; candidate++) {
			const a = polyline[turns[from]];
			const b = polyline[turns[candidate]];
			const perUnit = sweepCost(grid, a.x, a.y, b.x, b.y, halfWidth + clearance, halfHeight + clearance);
			const straight = Math.hypot(b.x - a.x, b.y - a.y) * perUnit;
			// Tolerance for float noise; any real saving or loss is whole world units.
			if(Number.isFinite(straight) && straight <= travelled[turns[candidate]] - travelled[turns[from]] + 1e-6) {
				to = candidate;
			}
		}
		result.push(polyline[turns[to]]);
		from = to;
	}
	return result;
}

function segmentCost(grid: NavGrid, a: Point, b: Point, halfWidth: number, halfHeight: number): number {
	const length = Math.hypot(b.x - a.x, b.y - a.y);
	const perUnit = sweepCost(grid, a.x, a.y, b.x, b.y, halfWidth, halfHeight);
	// Legs off a blocked start still need a price; the tile walked into is the best guess.
	return length * (Number.isFinite(perUnit) ? perUnit : 1 / grid.terrainSpeed(grid.tileOf(b.x), grid.tileOf(b.y)));
}

function isCollinear(a: Point, b: Point, c: Point): boolean {
	return Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) < 1e-9 &&
		(b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0;
}

function dropDuplicates(points: ReadonlyArray<Point>): Array<Point> {
	const result: Array<Point> = [];
	for(const point of points) {
		const last = result[result.length - 1];
		if(!last || last.x !== point.x || last.y !== point.y) {
			result.push(point);
		}
	}
	return result;
}