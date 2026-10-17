import type NavGrid from './nav-grid';

// Slowest terrain (cost per world unit, i.e. 1 / speed) any tile touched by a box of half-size (halfWidth,
// halfHeight) sliding from (x0, y0) to (x1, y1), or Infinity if it touches a blocked or off-map tile. Touching a
// tile's edge does not count, matching physics, where touching is not overlapping.
export function sweepCost(grid: NavGrid, x0: number, y0: number, x1: number, y1: number, halfWidth: number, halfHeight: number): number {
	const cell = grid.cellSize;
	const dx = x1 - x0;
	const dy = y1 - y0;
	const reachY = halfHeight + cell / 2;
	const fromRow = Math.floor((Math.min(y0, y1) - halfHeight) / cell);
	const toRow = Math.ceil((Math.max(y0, y1) + halfHeight) / cell) - 1;
	let worst = 0;
	for(let row = fromRow; row <= toRow; row++) {
		// When during the slide the box overlaps this row: an open interval of t.
		const centerY = (row + 0.5) * cell;
		let tLow: number;
		let tHigh: number;
		if(dy === 0) {
			if(Math.abs(y0 - centerY) >= reachY) {
				continue;
			}
			tLow = -Infinity;
			tHigh = Infinity;
		} else {
			const a = (centerY - reachY - y0) / dy;
			const b = (centerY + reachY - y0) / dy;
			tLow = Math.min(a, b);
			tHigh = Math.max(a, b);
		}
		const tFrom = Math.max(tLow, 0);
		const tTo = Math.min(tHigh, 1);
		if(tFrom > tTo || (tFrom === tTo && !(tLow < tFrom && tTo < tHigh))) {
			continue;
		}

		const xa = x0 + dx * tFrom;
		const xb = x0 + dx * tTo;
		const fromColumn = Math.floor((Math.min(xa, xb) - halfWidth) / cell);
		const toColumn = Math.ceil((Math.max(xa, xb) + halfWidth) / cell) - 1;
		for(let column = fromColumn; column <= toColumn; column++) {
			if(grid.isBlocked(column, row)) {
				return Infinity;
			}
			worst = Math.max(worst, 1 / grid.terrainSpeed(column, row));
		}
	}
	return worst;
}