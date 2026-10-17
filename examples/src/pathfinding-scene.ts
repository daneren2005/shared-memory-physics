import { PathStatus, shapeHalfHeight, shapeHalfWidth, SHAPE_RECTANGLE } from '@daneren2005/shared-memory-physics';
import type { NavGrid, NavigationComponent, Rect } from '@daneren2005/shared-memory-physics';
import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import type { GameObjects } from 'phaser';
import type { TerrainData } from './systems/terrain';
import type { Components, Config } from './world';

export type Entity = BaseEntity<Components, Config>;

export const MUD_SPEED = 0.3;
export const ROAD_SPEED = 2;
export const GATE_COLOR = 0xF59E0B;
export const OPEN_GATE_COLOR = 0x22C55E;

const MUD_COLOR = 0x78350F;
const ROAD_COLOR = 0xA8A29E;
const GRID_COLOR = 0x1E293B;
const BLOCKED_COLOR = 0xEF4444;
const PATH_COLOR = 0x7DD3FC;
const UNREACHABLE_COLOR = 0xF87171;

// The box pathfinding rasterises a body as, mirrored on the main thread for drawing and for picking open spots.
export function obstacleRect(entity: Entity): Rect {
	const transform = entity.components.transform;
	if(!transform) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	}
	const shape = entity.components.body?.shape ?? SHAPE_RECTANGLE;
	const { x, y, width, height, angle } = transform;
	const halfWidth = shapeHalfWidth(shape, width, height, angle);
	const halfHeight = shapeHalfHeight(shape, width, height, angle);
	return { minX: x - halfWidth, minY: y - halfHeight, maxX: x + halfWidth, maxY: y + halfHeight };
}

export function containsPoint(rect: Rect, x: number, y: number): boolean {
	return x >= rect.minX && x < rect.maxX && y >= rect.minY && y < rect.maxY;
}

export function drawTerrain(graphics: GameObjects.Graphics, terrain: TerrainData): void {
	const cell = terrain.cellSize;
	for(let y = 0; y < terrain.tilesHigh; y++) {
		for(let x = 0; x < terrain.tilesWide; x++) {
			const speed = terrain.speeds[y * terrain.tilesWide + x];
			if(speed === 1) {
				continue;
			}
			graphics.fillStyle(speed < 1 ? MUD_COLOR : ROAD_COLOR, speed < 1 ? 0.55 : 0.25);
			graphics.fillRect(x * cell, y * cell, cell, cell);
		}
	}
}

export function drawGrid(graphics: GameObjects.Graphics, grid: NavGrid): void {
	const cell = grid.cellSize;
	const width = grid.tilesWide * cell;
	const height = grid.tilesHigh * cell;
	graphics.lineStyle(1, GRID_COLOR, 1);
	for(let x = 0; x <= grid.tilesWide; x++) {
		graphics.lineBetween(x * cell, 0, x * cell, height);
	}
	for(let y = 0; y <= grid.tilesHigh; y++) {
		graphics.lineBetween(0, y * cell, width, y * cell);
	}

	graphics.fillStyle(BLOCKED_COLOR, 0.18);
	for(let y = 0; y < grid.tilesHigh; y++) {
		for(let x = 0; x < grid.tilesWide; x++) {
			if(grid.blockerCount(x, y) > 0) {
				graphics.fillRect(x * cell, y * cell, cell, cell);
			}
		}
	}
}

// The rest of the mover's path from where it is drawn, ending on the goal (or a red leg to it when unreachable).
export function drawPath(graphics: GameObjects.Graphics, entity: Entity, showGoal: boolean): void {
	const navigation = entity.components.navigation;
	const transform = entity.components.transform;
	if(!navigation || !transform || !navigation.active) {
		return;
	}
	const position = entity.components.interpolation ?? transform;
	const waypoints = navigation.waypoints;
	const found = !navigation.pending && navigation.outcome === PathStatus.Found;

	graphics.lineStyle(showGoal ? 2 : 1, PATH_COLOR, showGoal ? 0.9 : 0.5);
	graphics.beginPath();
	graphics.moveTo(position.x, position.y);
	let lastX = position.x;
	let lastY = position.y;
	for(let i = navigation.waypointIndex; i < waypoints.length; i++) {
		graphics.lineTo(waypoints[i].x, waypoints[i].y);
		lastX = waypoints[i].x;
		lastY = waypoints[i].y;
	}
	if(found) {
		graphics.lineTo(navigation.goalX, navigation.goalY);
	}
	graphics.strokePath();

	if(!showGoal) {
		return;
	}
	for(let i = navigation.waypointIndex; i < waypoints.length; i++) {
		graphics.fillStyle(PATH_COLOR, 1);
		graphics.fillCircle(waypoints[i].x, waypoints[i].y, 3);
	}
	const reachable = navigation.pending || found || navigation.outcome === PathStatus.Incomplete;
	const color = reachable ? PATH_COLOR : UNREACHABLE_COLOR;
	if(!reachable) {
		graphics.lineStyle(1, UNREACHABLE_COLOR, 0.8);
		graphics.lineBetween(lastX, lastY, navigation.goalX, navigation.goalY);
	}
	graphics.lineStyle(3, color, 1);
	graphics.lineBetween(navigation.goalX - 8, navigation.goalY - 8, navigation.goalX + 8, navigation.goalY + 8);
	graphics.lineBetween(navigation.goalX - 8, navigation.goalY + 8, navigation.goalX + 8, navigation.goalY - 8);
}

export function pathStatus(navigation: NavigationComponent): string {
	if(!navigation.active) {
		return navigation.outcome === PathStatus.Found ? 'arrived' : 'idle';
	}
	if(navigation.pending) {
		return 'searching';
	}
	if(navigation.outcome === PathStatus.Found) {
		return 'found';
	}
	return navigation.outcome === PathStatus.Incomplete ? 'incomplete (asks again at its end)' : 'unreachable';
}

// Searches again for the goal the mover already has, after something it was costed against changed.
export function repath(entity: Entity | undefined): void {
	const navigation = entity?.components.navigation;
	if(navigation?.active) {
		navigation.navigateTo(navigation.goalX, navigation.goalY);
	}
}
