import { DEFAULT_COLLIDE_CATEGORY, DEFAULT_PATH_SEARCH_ITERATION_BUDGET, NavGrid, PathStatus } from '@daneren2005/shared-memory-physics';
import type { Rect } from '@daneren2005/shared-memory-physics';
import type { Control } from '../controls';
import type { EntityStyle, Example, ExampleSystemsConfig } from '../example';
import type { Level } from '../level';
import { drawPath, drawTerrain, GATE_COLOR, MUD_SPEED, obstacleRect, repath, ROAD_SPEED, type Entity } from '../pathfinding-scene';
import Random from '../random';
import PathFollowSystem from '../systems/path-follow-system';
import ExamplePathfindingSystem from '../systems/pathfinding-system';
import { GATE_CATEGORY, MOVER_CATEGORY } from '../systems/pathfinding-update';
import { createTerrain, setTerrainSpeed } from '../systems/terrain';
import type { TerrainData } from '../systems/terrain';
import type { Config, ExampleWorld } from '../world';

const SEED = 0x9A7F;
const STRESS_WORLD: Level = { width: 2400, height: 1600 };
const CELL = 20;
const TILES_WIDE = STRESS_WORLD.width / CELL;
const TILES_HIGH = STRESS_WORLD.height / CELL;
const MOVER_SIZE = 8;
const ROAD_SPACING_TILES = 20;
const MUD_PONDS = 8;
const PLACEMENT_ATTEMPTS = 60;
// Gives up on a goal it has not reached in this long - e.g. wedged by an obstacle dropped on top of it.
const TRIP_TIMEOUT_MS = 30_000;
const PATHS_DRAWN = 40;

const settings = {
	movers: 3000,
	obstacles: 300,
	churn: 2,
	// Three times the library default, so the worker spends most of each step searching instead of a fifth of it.
	budget: DEFAULT_PATH_SEARCH_ITERATION_BUDGET * 3,
	showPaths: true,
	search: { diagonal: true, smooth: true },
	follow: { speed: 120 },
};

interface Obstacle {
	entity: Entity
	rect: Rect
}

interface Scene {
	pathfinding: ExamplePathfindingSystem
	terrain: TerrainData
	// Every obstacle including doors, for spacing obstacles apart and picking open spots for movers.
	occupied: NavGrid
	obstacles: Array<Obstacle>
	gates: Set<Entity>
	movers: Array<Entity>
	tripStarted: Float64Array
	random: Random
	time: number
	churnTime: number
	arrivals: number
	unreachable: number
	timeouts: number
	pending: number
	statsTime: number
	statsArrivals: number
}
let scene: Scene | undefined;

const openerStyle: EntityStyle = { color: 0x86EFAC, alpha: 0.9 };
const walkerStyle: EntityStyle = { color: 0x7DD3FC, alpha: 0.9 };
const waitingStyle: EntityStyle = { color: 0x64748B, alpha: 0.9 };
const gateStyle: EntityStyle = { color: GATE_COLOR, alpha: 0.6 };

export const pathfindingStress: Example = {
	id: 'pathfinding-stress',
	title: 'Pathfinding stress',
	description: 'Thousands of movers wandering between random goals across a field of walls, boxes, pillars and '
		+ 'doors, with roads that are quick to walk and mud that is slow. Each arrival picks a new goal, so the '
		+ 'pathfinding worker is never idle: it answers as many requests per run as its A* iteration budget allows and '
		+ 'leaves the rest pending (grey) for the next. Drag the search budget to trade worker time for how long '
		+ 'movers wait. Green movers can open doors (amber); blue ones path around them. Obstacle churn swaps obstacles out while everyone walks - each new one re-paths only the movers whose '
		+ 'remaining path it crosses, and any it lands on walk out of it. The stats panel shows each worker\'s cost.',
	backend: 'sweep',
	world: STRESS_WORLD,
	swarm: true,
	timing: true,

	systems({ world, forceMainThread, deltaBetweenRuns }: ExampleSystemsConfig) {
		const terrain = createTerrain(TILES_WIDE, TILES_HIGH, CELL);
		const pathfinding = new ExamplePathfindingSystem(world, {
			settings: settings.search,
			terrain,
			forceMainThread,
			deltaBetweenRuns,
			iterationBudget: settings.budget,
		});
		scene = {
			pathfinding,
			terrain,
			occupied: new NavGrid(TILES_WIDE, TILES_HIGH, CELL),
			obstacles: [],
			gates: new Set(),
			movers: [],
			tripStarted: new Float64Array(settings.movers),
			random: new Random(SEED),
			time: 0,
			churnTime: 0,
			arrivals: 0,
			unreachable: 0,
			timeouts: 0,
			pending: 0,
			statsTime: 0,
			statsArrivals: 0,
		};
		return [
			pathfinding,
			new PathFollowSystem(world, { settings: settings.follow, terrain, forceMainThread, deltaBetweenRuns }),
		];
	},

	controls(host): Array<Control> {
		return [
			{
				kind: 'slider',
				label: 'Movers',
				min: 500,
				max: 20000,
				step: 500,
				value: settings.movers,
				format: value => value.toLocaleString(),
				change(value) {
					settings.movers = value;
					host.restart();
				},
			},
			{
				kind: 'slider',
				label: 'Obstacles',
				min: 0,
				max: 800,
				step: 50,
				value: settings.obstacles,
				change(value) {
					settings.obstacles = value;
					host.restart();
				},
			},
			{
				kind: 'slider',
				label: 'Obstacle churn',
				min: 0,
				max: 20,
				value: settings.churn,
				format: value => `${value} / s`,
				change(value) {
					settings.churn = value;
				},
			},
			{
				kind: 'slider',
				label: 'Search budget',
				min: 4000,
				max: 200000,
				step: 4000,
				value: settings.budget,
				format: value => `${value.toLocaleString()} tiles / run`,
				change(value) {
					settings.budget = value;
					if(scene) {
						scene.pathfinding.iterationBudget = value;
					}
				},
			},
			{
				kind: 'slider',
				label: 'Speed',
				min: 40,
				max: 300,
				step: 10,
				value: settings.follow.speed,
				format: value => `${value} u/s`,
				change(value) {
					settings.follow.speed = value;
				},
			},
			{
				kind: 'toggle',
				label: 'Diagonal movement',
				value: settings.search.diagonal,
				note: 'Applies to each mover\'s next search; re-path everyone to see it at once.',
				change(value) {
					settings.search.diagonal = value;
				},
			},
			{
				kind: 'toggle',
				label: 'Smooth paths',
				value: settings.search.smooth,
				change(value) {
					settings.search.smooth = value;
				},
			},
			{
				kind: 'toggle',
				label: 'Show paths',
				value: settings.showPaths,
				note: `Draws the remaining path of the first ${PATHS_DRAWN} movers.`,
				change(value) {
					settings.showPaths = value;
				},
			},
			{
				kind: 'button',
				label: 'Re-path everyone',
				press() {
					scene?.movers.forEach(repath);
				},
			},
		];
	},

	create(runtime): void {
		const current = scene;
		if(!current) {
			return;
		}
		const { world } = runtime;
		const { random, terrain } = current;

		for(let tile = ROAD_SPACING_TILES; tile < TILES_HIGH; tile += ROAD_SPACING_TILES) {
			paintRect(terrain, 0, tile - 1, TILES_WIDE - 1, tile, ROAD_SPEED);
		}
		for(let tile = ROAD_SPACING_TILES; tile < TILES_WIDE; tile += ROAD_SPACING_TILES) {
			paintRect(terrain, tile - 1, 0, tile, TILES_HIGH - 1, ROAD_SPEED);
		}
		for(let i = 0; i < MUD_PONDS; i++) {
			const width = Math.floor(random.between(6, 16));
			const height = Math.floor(random.between(5, 12));
			const x = Math.floor(random.between(0, TILES_WIDE - width));
			const y = Math.floor(random.between(0, TILES_HIGH - height));
			paintRect(terrain, x, y, x + width - 1, y + height - 1, MUD_SPEED);
		}

		for(let i = 0; i < settings.obstacles; i++) {
			placeObstacle(world, current);
		}

		for(let i = 0; i < settings.movers; i++) {
			const spot = openSpot(current);
			const opener = i % 2 === 0;
			const mover = world.loadEntity({
				x: spot.x,
				y: spot.y,
				width: MOVER_SIZE,
				height: MOVER_SIZE,
				velocityX: 0,
				velocityY: 0,
				collideCategory: MOVER_CATEGORY,
				// Movers leave each other out of their mask so they stream past one another instead of jamming.
				collideMask: DEFAULT_COLLIDE_CATEGORY | (opener ? 0 : GATE_CATEGORY),
				navigate: true,
				interpolate: true,
			});
			current.movers.push(mover);
			newGoal(current, i);
		}
	},

	update(runtime, elapsedTime): void {
		const current = scene;
		if(!current) {
			return;
		}
		current.time += elapsedTime;

		let pending = 0;
		for(let i = 0; i < current.movers.length; i++) {
			const navigation = current.movers[i].components.navigation;
			if(!navigation) {
				continue;
			}
			if(!navigation.active) {
				current.arrivals++;
				newGoal(current, i);
			} else if(navigation.pending) {
				pending++;
			} else if(navigation.outcome === PathStatus.Unreachable) {
				current.unreachable++;
				newGoal(current, i);
			} else if(current.time - current.tripStarted[i] > TRIP_TIMEOUT_MS) {
				current.timeouts++;
				newGoal(current, i);
			}
		}
		current.pending = pending;

		if(settings.churn > 0) {
			current.churnTime += elapsedTime;
			const interval = 1000 / settings.churn;
			while(current.churnTime >= interval) {
				current.churnTime -= interval;
				churnObstacle(runtime.world, current);
			}
		}
	},

	entityStyle(_runtime, entity): EntityStyle | undefined {
		const body = entity.components.body;
		if(!entity.components.velocity) {
			return scene?.gates.has(entity) ? gateStyle : undefined;
		}
		if(entity.components.navigation?.pending) {
			return waitingStyle;
		}
		return body && (body.collideMask & GATE_CATEGORY) === 0 ? openerStyle : walkerStyle;
	},

	drawUnder(_runtime, graphics): void {
		if(scene) {
			drawTerrain(graphics, scene.terrain);
		}
	},

	drawOver(_runtime, graphics): void {
		if(!scene || !settings.showPaths) {
			return;
		}
		for(let i = 0; i < PATHS_DRAWN && i < scene.movers.length; i++) {
			drawPath(graphics, scene.movers[i], false);
		}
	},

	stats(): Record<string, string> {
		const current = scene;
		if(!current) {
			return {};
		}
		const elapsed = current.time - current.statsTime;
		const rate = elapsed > 0 ? (current.arrivals - current.statsArrivals) * 1000 / elapsed : 0;
		current.statsTime = current.time;
		current.statsArrivals = current.arrivals;
		return {
			movers: current.movers.length.toLocaleString(),
			obstacles: current.obstacles.length.toLocaleString(),
			'paths pending': current.pending.toLocaleString(),
			'arrivals / s': Math.round(rate).toLocaleString(),
			'unreachable goals': current.unreachable.toLocaleString(),
			'timed out trips': current.timeouts.toLocaleString(),
		};
	},
};

function paintRect(terrain: TerrainData, fromX: number, fromY: number, toX: number, toY: number, speed: number): void {
	for(let y = fromY; y <= toY; y++) {
		for(let x = fromX; x <= toX; x++) {
			setTerrainSpeed(terrain, x, y, speed);
		}
	}
}

// Wall segments, boxes, pillars and doors, kept a tile apart so there is always a corridor between them.
function placeObstacle(world: ExampleWorld, current: Scene): void {
	const { random } = current;
	for(let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
		const kind = random.next();
		let config: Config;
		let gate = false;
		if(kind < 0.45) {
			const length = Math.floor(random.between(4, 16)) * CELL;
			config = random.next() < 0.5 ? { width: length, height: CELL } : { width: CELL, height: length };
		} else if(kind < 0.7) {
			config = { width: Math.floor(random.between(2, 6)) * CELL, height: Math.floor(random.between(2, 6)) * CELL };
		} else if(kind < 0.9) {
			config = { radius: Math.floor(random.between(1, 3)) * CELL - 2 };
		} else {
			gate = true;
			config = random.next() < 0.5 ? { width: 3 * CELL, height: CELL } : { width: CELL, height: 3 * CELL };
		}

		const width = config.radius !== undefined ? config.radius * 2 : config.width ?? CELL;
		const height = config.radius !== undefined ? config.radius * 2 : config.height ?? CELL;
		const x = Math.floor(random.between(0, TILES_WIDE)) * CELL + width / 2;
		const y = Math.floor(random.between(0, TILES_HIGH)) * CELL + height / 2;
		const area = current.occupied.tilesIn({ minX: x - width / 2 - CELL, minY: y - height / 2 - CELL, maxX: x + width / 2 + CELL, maxY: y + height / 2 + CELL });
		if(!current.occupied.isAreaClear(area.fromX, area.fromY, area.toX - area.fromX + 1, area.toY - area.fromY + 1)) {
			continue;
		}

		const entity = world.loadEntity(gate ? { ...config, x, y, collideCategory: GATE_CATEGORY } : { ...config, x, y, blocksPath: true });
		const rect = obstacleRect(entity);
		current.occupied.addBlocker(rect);
		current.obstacles.push({ entity, rect });
		if(gate) {
			current.gates.add(entity);
		}
		return;
	}
}

function churnObstacle(world: ExampleWorld, current: Scene): void {
	if(current.obstacles.length > 0) {
		const index = Math.floor(current.random.next() * current.obstacles.length);
		const [removed] = current.obstacles.splice(index, 1);
		current.occupied.removeBlocker(removed.rect);
		current.gates.delete(removed.entity);
		world.removeEntity(removed.entity);
	}
	placeObstacle(world, current);
}

function openSpot(current: Scene): { x: number, y: number } {
	const { random, occupied } = current;
	for(let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
		const tileX = Math.floor(random.next() * TILES_WIDE);
		const tileY = Math.floor(random.next() * TILES_HIGH);
		if(!occupied.isBlocked(tileX, tileY)) {
			return { x: occupied.tileCenter(tileX), y: occupied.tileCenter(tileY) };
		}
	}
	return { x: random.between(0, STRESS_WORLD.width), y: random.between(0, STRESS_WORLD.height) };
}

function newGoal(current: Scene, index: number): void {
	const goal = openSpot(current);
	current.movers[index].components.navigation?.navigateTo(goal.x, goal.y);
	current.tripStarted[index] = current.time;
}

export default pathfindingStress;
