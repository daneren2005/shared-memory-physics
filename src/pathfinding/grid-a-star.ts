import MinHeap from './min-heap';
import type NavGrid from './nav-grid';
import { PathStatus, type PathRequest, type PathResult, type PathSearch, type PathStatusValue, type Point } from './path-search';
import { smoothPath } from './smooth-path';
import { sweepCost } from './line-of-sight';

export interface GridAStarOptions {
	// 8-way movement. Diagonals never squeeze between two blocked tiles. Defaults to 4-way.
	diagonal?: boolean
	// Tiles expanded before giving up with an Incomplete path.
	maxIterations?: number
	smooth?: boolean
	// Extra room a smoothed shortcut must leave around blockers and the map edge. Defaults to 0: physics slides a mover
	// off a corner it grazes.
	clearance?: number
	// How far (in tiles) a blocked start or goal is moved to find open ground.
	relocateRadius?: number
}

const DEFAULT_MAX_ITERATIONS = 50_000;
const DEFAULT_CLEARANCE = 0;
const DEFAULT_RELOCATE_RADIUS = 16;
const ORTHOGONAL = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
const DIAGONAL = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;

interface Anchor {
	x: number
	y: number
}

// A* over tiles. A mover is placed by the top-left tile of its footprint (its "anchor"), so a mover bigger than a tile
// only visits anchors where its whole footprint is open. Scratch arrays are reused across searches and stamped rather
// than cleared, so a search only pays for the tiles it touches.
export default class GridAStar implements PathSearch {
	private readonly diagonal: boolean;
	private readonly maxIterations: number;
	private readonly smooth: boolean;
	private readonly clearance: number;
	private readonly relocateRadius: number;
	private readonly heap = new MinHeap(256);
	private cost = new Float64Array(0);
	private parent = new Int32Array(0);
	private seen = new Uint32Array(0);
	private closed = new Uint32Array(0);
	private stamp = 0;

	constructor(options: GridAStarOptions = {}) {
		this.diagonal = options.diagonal ?? false;
		this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		this.smooth = options.smooth ?? true;
		this.clearance = options.clearance ?? DEFAULT_CLEARANCE;
		this.relocateRadius = options.relocateRadius ?? DEFAULT_RELOCATE_RADIUS;
	}

	findPath(grid: NavGrid, request: PathRequest): PathResult {
		const cell = grid.cellSize;
		const tilesWide = Math.max(1, Math.ceil(request.agentWidth / cell - 1e-9));
		const tilesHigh = Math.max(1, Math.ceil(request.agentHeight / cell - 1e-9));
		if(tilesWide > grid.tilesWide || tilesHigh > grid.tilesHigh) {
			return { status: PathStatus.Unreachable, points: [], iterations: 0 };
		}
		const anchorOf = (x: number, y: number): Anchor => ({
			x: Math.round((x - tilesWide * cell / 2) / cell),
			y: Math.round((y - tilesHigh * cell / 2) / cell),
		});
		const onMap = (anchor: Anchor): Anchor => ({
			x: clamp(anchor.x, 0, grid.tilesWide - tilesWide),
			y: clamp(anchor.y, 0, grid.tilesHigh - tilesHigh),
		});
		const centerOf = (anchor: Anchor): Point => ({ x: (anchor.x + tilesWide / 2) * cell, y: (anchor.y + tilesHigh / 2) * cell });

		const start = this.relocate(grid, onMap(anchorOf(request.startX, request.startY)), tilesWide, tilesHigh, request.startX, request.startY, request.goalX, request.goalY);
		// Off the map counts as moved, so an off-map goal is never walked to.
		const requestedGoal = anchorOf(request.goalX, request.goalY);
		const goal = this.relocate(grid, onMap(requestedGoal), tilesWide, tilesHigh, request.goalX, request.goalY, request.startX, request.startY);
		if(!start || !goal || grid.region(start.x, start.y) !== grid.region(goal.x, goal.y)) {
			return { status: PathStatus.Unreachable, points: [], iterations: 0 };
		}
		const goalMoved = goal.x !== requestedGoal.x || goal.y !== requestedGoal.y;

		const search = this.search(grid, start, goal, tilesWide, tilesHigh);
		const polyline: Array<Point> = [{ x: request.startX, y: request.startY }];
		for(const index of search.tiles) {
			polyline.push(centerOf({ x: index % grid.tilesWide, y: Math.floor(index / grid.tilesWide) }));
		}

		let status: PathStatusValue = search.status;
		if(status === PathStatus.Found) {
			const destination = centerOf(goal);
			if(goalMoved || !Number.isFinite(sweepCost(grid, destination.x, destination.y, request.goalX, request.goalY,
				request.agentWidth / 2, request.agentHeight / 2))) {
				status = PathStatus.Unreachable;
			} else {
				polyline.push({ x: request.goalX, y: request.goalY });
			}
		}

		const halfWidth = request.agentWidth / 2;
		const halfHeight = request.agentHeight / 2;
		const points = this.smooth ? smoothPath(grid, polyline, halfWidth, halfHeight, this.clearance) : withoutRepeats(polyline);
		return { status, points: points.slice(1), iterations: search.iterations };
	}

	// The open anchor nearest `toward` within relocateRadius rings of `anchor`, ties going to the one nearer `prefer`.
	private relocate(grid: NavGrid, anchor: Anchor, tilesWide: number, tilesHigh: number, towardX: number, towardY: number, preferX: number, preferY: number): Anchor | undefined {
		if(grid.isAreaClear(anchor.x, anchor.y, tilesWide, tilesHigh)) {
			return anchor;
		}
		const cell = grid.cellSize;
		for(let radius = 1; radius <= this.relocateRadius; radius++) {
			let best: Anchor | undefined;
			let bestDistance = Infinity;
			let bestPreference = Infinity;
			for(let y = anchor.y - radius; y <= anchor.y + radius; y++) {
				const edge = y === anchor.y - radius || y === anchor.y + radius;
				for(let x = anchor.x - radius; x <= anchor.x + radius; x += edge ? 1 : radius * 2) {
					if(!grid.isAreaClear(x, y, tilesWide, tilesHigh)) {
						continue;
					}
					const centerX = (x + tilesWide / 2) * cell;
					const centerY = (y + tilesHigh / 2) * cell;
					const distance = Math.hypot(centerX - towardX, centerY - towardY);
					const preference = Math.hypot(centerX - preferX, centerY - preferY);
					if(distance < bestDistance || (distance === bestDistance && preference < bestPreference)) {
						best = { x, y };
						bestDistance = distance;
						bestPreference = preference;
					}
				}
			}
			if(best) {
				return best;
			}
		}
		return undefined;
	}

	private search(grid: NavGrid, start: Anchor, goal: Anchor, tilesWide: number, tilesHigh: number): { status: PathStatusValue, tiles: Array<number>, iterations: number } {
		this.prepare(grid.tileCount);
		const stamp = this.stamp;
		const { cost, parent, seen, closed, heap } = this;
		const width = grid.tilesWide;
		const startIndex = grid.index(start.x, start.y);
		const goalIndex = grid.index(goal.x, goal.y);
		// The cheapest a tile can ever be crossed, so the estimate never overshoots once roads exist.
		const cheapestTile = grid.cellSize / grid.maxSpeed;
		const estimate = (x: number, y: number) => {
			const dx = Math.abs(x - goal.x);
			const dy = Math.abs(y - goal.y);
			const tiles = this.diagonal ? Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
			return tiles * cheapestTile;
		};

		heap.clear();
		seen[startIndex] = stamp;
		cost[startIndex] = 0;
		parent[startIndex] = -1;
		heap.push(startIndex, estimate(start.x, start.y), estimate(start.x, start.y));
		let closest = startIndex;
		let closestEstimate = estimate(start.x, start.y);
		let iterations = 0;

		while(heap.size > 0) {
			const current = heap.pop();
			if(closed[current] === stamp) {
				continue;
			}
			if(current === goalIndex) {
				return { status: PathStatus.Found, tiles: this.trace(current), iterations };
			}
			if(iterations >= this.maxIterations) {
				return { status: PathStatus.Incomplete, tiles: this.trace(closest), iterations };
			}
			closed[current] = stamp;
			iterations++;

			const x = current % width;
			const y = (current - x) / width;
			const remaining = estimate(x, y);
			if(remaining < closestEstimate || (remaining === closestEstimate && cost[current] < cost[closest])) {
				closest = current;
				closestEstimate = remaining;
			}

			for(const [dx, dy] of ORTHOGONAL) {
				this.relax(grid, current, x + dx, y + dy, 1, tilesWide, tilesHigh, estimate);
			}
			if(this.diagonal) {
				for(const [dx, dy] of DIAGONAL) {
					if(grid.isAreaClear(x + dx, y, tilesWide, tilesHigh) && grid.isAreaClear(x, y + dy, tilesWide, tilesHigh)) {
						this.relax(grid, current, x + dx, y + dy, Math.SQRT2, tilesWide, tilesHigh, estimate);
					}
				}
			}
		}

		return { status: PathStatus.Unreachable, tiles: this.trace(closest), iterations };
	}

	private relax(grid: NavGrid, from: number, x: number, y: number, distance: number, tilesWide: number, tilesHigh: number, estimate: (x: number, y: number) => number): void {
		if(!grid.isAreaClear(x, y, tilesWide, tilesHigh)) {
			return;
		}
		const index = grid.index(x, y);
		if(this.closed[index] === this.stamp) {
			return;
		}
		const next = this.cost[from] + distance * footprintCost(grid, x, y, tilesWide, tilesHigh);
		if(this.seen[index] === this.stamp && next >= this.cost[index]) {
			return;
		}
		this.seen[index] = this.stamp;
		this.cost[index] = next;
		this.parent[index] = from;
		const remaining = estimate(x, y);
		// Ties go to the node nearer the goal, which keeps equal-cost searches narrow.
		this.heap.push(index, next + remaining, remaining);
	}

	private trace(index: number): Array<number> {
		let length = 0;
		for(let i = index; i !== -1; i = this.parent[i]) {
			length++;
		}
		const tiles = Array.from({ length }, () => 0);
		for(let i = index, at = length - 1; i !== -1; i = this.parent[i], at--) {
			tiles[at] = i;
		}
		return tiles;
	}

	private prepare(tileCount: number): void {
		if(this.cost.length !== tileCount) {
			this.cost = new Float64Array(tileCount);
			this.parent = new Int32Array(tileCount);
			this.seen = new Uint32Array(tileCount);
			this.closed = new Uint32Array(tileCount);
			this.stamp = 0;
		}
		this.stamp++;
		// Wrapped after ~4 billion searches: stale stamps could then collide, so start clean.
		if(this.stamp === 0xFFFFFFFF) {
			this.seen.fill(0);
			this.closed.fill(0);
			this.stamp = 1;
		}
	}
}

// Mean cost of the tiles a footprint covers, so a big mover half on a road is half as quick as one fully on it.
function footprintCost(grid: NavGrid, x: number, y: number, tilesWide: number, tilesHigh: number): number {
	if(tilesWide === 1 && tilesHigh === 1) {
		return grid.cost(x, y);
	}
	let total = 0;
	for(let ty = y; ty < y + tilesHigh; ty++) {
		for(let tx = x; tx < x + tilesWide; tx++) {
			total += grid.cost(tx, ty);
		}
	}
	return total / (tilesWide * tilesHigh);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function withoutRepeats(points: Array<Point>): Array<Point> {
	return points.filter((point, i) => i === 0 || point.x !== points[i - 1].x || point.y !== points[i - 1].y);
}