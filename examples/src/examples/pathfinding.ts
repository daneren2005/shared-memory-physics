import { DEFAULT_COLLIDE_CATEGORY, NavGrid, SHAPE_CAPSULE } from '@daneren2005/shared-memory-physics';
import type { PolygonVertex, Rect } from '@daneren2005/shared-memory-physics';
import type { Control } from '../controls';
import type { EntityStyle, Example, ExampleSystemsConfig } from '../example';
import {
	containsPoint,
	drawGrid,
	drawPath,
	drawTerrain,
	GATE_COLOR,
	MUD_SPEED,
	obstacleRect,
	OPEN_GATE_COLOR,
	pathStatus,
	repath,
	ROAD_SPEED,
	type Entity,
} from '../pathfinding-scene';
import PathFollowSystem from '../systems/path-follow-system';
import ExamplePathfindingSystem from '../systems/pathfinding-system';
import { GATE_CATEGORY, MOVER_CATEGORY } from '../systems/pathfinding-update';
import { createTerrain, setTerrainSpeed, terrainSpeedAt } from '../systems/terrain';
import type { TerrainData } from '../systems/terrain';
import type { Config, ExampleWorld } from '../world';

const CELL = 20;
const TILES_WIDE = 60;
const TILES_HIGH = 40;
const START = { x: 120, y: 400 };
// Placed walls are 2x2 tiles so a drag lays a wall a mover cannot slip through diagonally.
const WALL_TILES = 2;
const BRUSH_TILES = 2;

type Tool = 'goal' | 'wall' | 'erase-wall' | 'mud' | 'road' | 'erase-terrain';
const TOOLS: ReadonlyArray<{ value: Tool, label: string }> = [
	{ value: 'goal', label: 'Set goal' },
	{ value: 'wall', label: 'Add wall' },
	{ value: 'erase-wall', label: 'Remove wall or door' },
	{ value: 'mud', label: 'Paint mud (slow)' },
	{ value: 'road', label: 'Paint road (fast)' },
	{ value: 'erase-terrain', label: 'Erase terrain' },
];

const settings = {
	tool: 'goal' as Tool,
	search: { diagonal: true, smooth: true },
	follow: { speed: 160 },
	size: 24,
	canOpenDoors: false,
	showGrid: true,
};

const triangle: Array<PolygonVertex> = [[0, -40], [42, 30], [-42, 30]];
const hexagon: Array<PolygonVertex> = Array.from({ length: 6 }, (_, i): PolygonVertex => [Math.cos(i * Math.PI / 3) * 32, Math.sin(i * Math.PI / 3) * 28]);

interface Obstacle {
	entity: Entity
	rect: Rect
	gate: boolean
}

// Rebuilt with every world: `systems` makes it (the systems need the terrain) and `create` fills it.
interface Scene {
	terrain: TerrainData
	// Blockers only, mirrored here to draw what the pathfinding worker rasterised and to stop walls stacking.
	grid: NavGrid
	obstacles: Array<Obstacle>
	mover?: Entity
}
let scene: Scene | undefined;

const gateStyle: EntityStyle = { color: GATE_COLOR, alpha: 0.6 };

export const pathfinding: Example = {
	id: 'pathfinding',
	title: 'Pathfinding',
	description: 'Click to send the square somewhere and it finds its way there: PathfindingSystem runs A* over a '
		+ 'tile grid on its own worker, a small follower system steers velocity along the path it wrote, and physics '
		+ 'does the moving. The scene has a U-shaped trap that straight-line steering would walk into, a two-tile gap '
		+ 'only a small square fits (drag the size up and it goes round), a mud pond that is slow to cross and a road '
		+ 'that is quick, round and angled shapes that each block the tiles of their bounding box, and a room shut by '
		+ 'a door (amber) the square cannot open until you let it - until then a goal inside is unreachable. Use the '
		+ 'tool picker to add or remove walls and paint terrain while it walks: a wall dropped across its path makes '
		+ 'it search again on its own, a wall dropped on top of it lets it walk out, and a goal clicked inside a wall '
		+ 'is moved to the nearest open ground. Show grid shades the blocked tiles.',
	backend: 'sweep',

	systems({ world, forceMainThread, deltaBetweenRuns }: ExampleSystemsConfig) {
		const terrain = createTerrain(TILES_WIDE, TILES_HIGH, CELL);
		scene = { terrain, grid: new NavGrid(TILES_WIDE, TILES_HIGH, CELL), obstacles: [] };
		return [
			new ExamplePathfindingSystem(world, { settings: settings.search, terrain, forceMainThread, deltaBetweenRuns }),
			new PathFollowSystem(world, { settings: settings.follow, terrain, forceMainThread, deltaBetweenRuns }),
		];
	},

	controls(): Array<Control> {
		return [
			{
				kind: 'select',
				label: 'Click to',
				options: TOOLS,
				value: settings.tool,
				change(value) {
					settings.tool = TOOLS.find(tool => tool.value === value)?.value ?? 'goal';
				},
			},
			{
				kind: 'toggle',
				label: 'Diagonal movement',
				value: settings.search.diagonal,
				note: 'Off, A* only steps between edge-sharing tiles. Diagonals never squeeze between two blocked tiles.',
				change(value) {
					settings.search.diagonal = value;
					repath(scene?.mover);
				},
			},
			{
				kind: 'toggle',
				label: 'Smooth paths',
				value: settings.search.smooth,
				note: 'String-pulls the tile path into straight legs wherever the line is clear and no slower.',
				change(value) {
					settings.search.smooth = value;
					repath(scene?.mover);
				},
			},
			{
				kind: 'toggle',
				label: 'Can open doors',
				value: settings.canOpenDoors,
				note: 'Drops the door category from the square\'s collide mask, so physics lets it through and '
					+ 'pathfinding searches the grid without doors.',
				change(value) {
					settings.canOpenDoors = value;
					const body = scene?.mover?.components.body;
					if(body) {
						body.collideMask = moverMask();
					}
					repath(scene?.mover);
				},
			},
			{
				kind: 'slider',
				label: 'Size',
				min: 10,
				max: 64,
				step: 2,
				value: settings.size,
				format: value => `${value} u (${Math.ceil(value / CELL)}x${Math.ceil(value / CELL)} tiles)`,
				change(value) {
					settings.size = value;
					const transform = scene?.mover?.components.transform;
					if(transform) {
						transform.width = value;
						transform.height = value;
					}
					repath(scene?.mover);
				},
			},
			{
				kind: 'slider',
				label: 'Speed',
				min: 40,
				max: 400,
				step: 10,
				value: settings.follow.speed,
				format: value => `${value} u/s`,
				change(value) {
					settings.follow.speed = value;
				},
			},
			{
				kind: 'toggle',
				label: 'Show grid',
				value: settings.showGrid,
				change(value) {
					settings.showGrid = value;
				},
			},
		];
	},

	create(runtime): void {
		if(!scene) {
			return;
		}
		const { world } = runtime;
		const current = scene;
		const wall = (x: number, y: number, width: number, height: number) => addObstacle(current, world.loadEntity({ x, y, width, height, blocksPath: true }), false);

		// A room shut by a door on its left side.
		wall(1000, 70, 280, 20);
		wall(1000, 310, 280, 20);
		wall(1130, 190, 20, 260);
		wall(870, 110, 20, 100);
		wall(870, 260, 20, 120);
		addObstacle(current, world.loadEntity({ x: 870, y: 180, width: 20, height: 40, collideCategory: GATE_CATEGORY }), true);

		// A U opening toward the start, the classic trap for steering straight at the goal.
		wall(450, 270, 180, 20);
		wall(450, 530, 180, 20);
		wall(530, 400, 20, 240);

		// A wall with a two-tile gap; anything over 40 across goes round its ends.
		wall(670, 230, 20, 260);
		wall(670, 530, 20, 260);

		// Round and angled blockers, each rasterised as its bounding box.
		const shape = (config: Config) => addObstacle(current, world.loadEntity({ ...config, blocksPath: true }), false);
		shape({ x: 140, y: 680, radius: 30 });
		shape({ x: 260, y: 610, radius: 20 });
		shape({ x: 390, y: 690, width: 130, height: 30, shape: SHAPE_CAPSULE, angle: 0.6 });
		shape({ x: 540, y: 640, vertices: triangle });
		shape({ x: 250, y: 740, vertices: hexagon });
		shape({ x: 220, y: 150, width: 40, height: 40 });
		shape({ x: 360, y: 110, width: 70, height: 26, angle: Math.PI / 4 });
		shape({ x: 500, y: 160, radius: 26 });

		paintRect(current.terrain, 38, 22, 52, 33, MUD_SPEED);
		paintRect(current.terrain, 35, 35, 59, 37, ROAD_SPEED);
		paintRect(current.terrain, 57, 17, 59, 37, ROAD_SPEED);

		current.mover = world.loadEntity({
			x: START.x,
			y: START.y,
			width: settings.size,
			height: settings.size,
			velocityX: 0,
			velocityY: 0,
			collideCategory: MOVER_CATEGORY,
			collideMask: moverMask(),
			navigate: true,
			interpolate: true,
		});
	},

	pointerDown(runtime, x, y): void {
		applyTool(runtime.world, x, y);
	},

	pointerDrag(runtime, x, y): void {
		applyTool(runtime.world, x, y);
	},

	entityStyle(_runtime, entity): EntityStyle | undefined {
		if(!scene?.obstacles.some(obstacle => obstacle.gate && obstacle.entity === entity)) {
			return undefined;
		}
		gateStyle.color = settings.canOpenDoors ? OPEN_GATE_COLOR : GATE_COLOR;
		return gateStyle;
	},

	drawUnder(_runtime, graphics): void {
		if(!scene) {
			return;
		}
		drawTerrain(graphics, scene.terrain);
		if(settings.showGrid) {
			drawGrid(graphics, scene.grid);
		}
	},

	drawOver(_runtime, graphics): void {
		if(scene?.mover) {
			drawPath(graphics, scene.mover, true);
		}
	},

	stats(): Record<string, string> {
		const mover = scene?.mover;
		const navigation = mover?.components.navigation;
		const transform = mover?.components.transform;
		if(!scene || !navigation || !transform) {
			return {};
		}
		return {
			path: pathStatus(navigation),
			waypoints: navigation.active ? `${navigation.waypointIndex} of ${navigation.waypoints.length}` : '-',
			underfoot: `${terrainSpeedAt(scene.terrain, transform.x, transform.y)}x speed`,
		};
	},
};

function moverMask(): number {
	return DEFAULT_COLLIDE_CATEGORY | (settings.canOpenDoors ? 0 : GATE_CATEGORY);
}

function addObstacle(current: Scene, entity: Entity, gate: boolean): void {
	const rect = obstacleRect(entity);
	current.obstacles.push({ entity, rect, gate });
	if(!gate) {
		current.grid.addBlocker(rect);
	}
}

function paintRect(terrain: TerrainData, fromX: number, fromY: number, toX: number, toY: number, speed: number): boolean {
	let changed = false;
	for(let y = fromY; y <= toY; y++) {
		for(let x = fromX; x <= toX; x++) {
			changed = setTerrainSpeed(terrain, x, y, speed) || changed;
		}
	}
	return changed;
}

function applyTool(world: ExampleWorld, x: number, y: number): void {
	const current = scene;
	const mover = current?.mover;
	if(!current || !mover) {
		return;
	}
	const tileX = Math.floor(x / CELL);
	const tileY = Math.floor(y / CELL);

	switch(settings.tool) {
		case 'goal': {
			mover.components.navigation?.navigateTo(clamp(x, 0, TILES_WIDE * CELL), clamp(y, 0, TILES_HIGH * CELL));
			break;
		}
		case 'wall': {
			const fromX = clamp(tileX, 0, TILES_WIDE - WALL_TILES);
			const fromY = clamp(tileY, 0, TILES_HIGH - WALL_TILES);
			if(!current.grid.isAreaClear(fromX, fromY, WALL_TILES, WALL_TILES)) {
				return;
			}
			const size = WALL_TILES * CELL;
			const entity = world.loadEntity({ x: fromX * CELL + size / 2, y: fromY * CELL + size / 2, width: size, height: size, blocksPath: true });
			// A new blocker re-paths only movers whose remaining path it crosses - no request needed here.
			addObstacle(current, entity, false);
			break;
		}
		case 'erase-wall': {
			const index = current.obstacles.findIndex(obstacle => containsPoint(obstacle.rect, x, y));
			if(index === -1) {
				return;
			}
			const [removed] = current.obstacles.splice(index, 1);
			if(!removed.gate) {
				current.grid.removeBlocker(removed.rect);
			}
			world.removeEntity(removed.entity);
			// Removals never invalidate a path, so the library leaves it alone; ask again to take any new shortcut.
			repath(mover);
			break;
		}
		default: {
			const speed = settings.tool === 'mud' ? MUD_SPEED : settings.tool === 'road' ? ROAD_SPEED : 1;
			// Terrain changes never invalidate a path either, so ask again for one costed against the new ground.
			if(paintRect(current.terrain, tileX, tileY, tileX + BRUSH_TILES - 1, tileY + BRUSH_TILES - 1, speed)) {
				repath(mover);
			}
		}
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export default pathfinding;
