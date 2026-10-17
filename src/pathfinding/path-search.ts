import type NavGrid from './nav-grid';

export interface Point {
	x: number
	y: number
}

// Positions are the mover's centre in world units; its size decides which gaps it fits through.
export interface PathRequest {
	startX: number
	startY: number
	goalX: number
	goalY: number
	agentWidth: number
	agentHeight: number
}

export const PathStatus = {
	// Ends on the goal.
	Found: 1,
	// Ran out of search budget; heads toward the goal and should be searched again from its end.
	Incomplete: 2,
	// No way to the goal. Any points lead to the reachable spot closest to it.
	Unreachable: 3,
} as const;
export type PathStatusValue = typeof PathStatus[keyof typeof PathStatus];

// `points` excludes the start: they are the waypoints to walk, in order.
export interface PathResult {
	status: PathStatusValue
	points: Array<Point>
	iterations: number
}

// The seam for swapping algorithms: anything that can answer a request against a grid.
export interface PathSearch {
	findPath(grid: NavGrid, request: PathRequest): PathResult
}