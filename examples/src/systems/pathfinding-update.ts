import { createPathfindingUpdate, GridAStar, setNavigationTerrainSpeed } from '@daneren2005/shared-memory-physics';
import type {
	NavGrid,
	PathfindingInitData,
	PathfindingUpdateComponents,
	PathfindingWorld,
	PathRequest,
	PathResult,
	PathSearch,
} from '@daneren2005/shared-memory-physics';
import type { EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import type { Components } from '../world';
import type { TerrainData } from './terrain';

// Collide categories the pathfinding examples use. A gate only stops movers whose collide mask takes it in, both
// for physics and for pathfinding, so one door can be a wall to some movers and open floor to others.
export const MOVER_CATEGORY = 0b10;
export const GATE_CATEGORY = 0b100;

export interface SearchSettings {
	diagonal: boolean
	smooth: boolean
}

export type ExamplePathfindingComponents = PathfindingUpdateComponents & EntityUpdateComponents<Components>;

export interface ExamplePathfindingWorld extends PathfindingWorld {
	searchSettings?: SearchSettings
	terrain?: TerrainData
	// An object because the init result is re-assigned onto a fresh world each run; a plain number would reset.
	terrainSync?: { version: number }
}

export interface ExamplePathfindingInitData extends PathfindingInitData {
	terrain: TerrainData
}

// GridAStar bakes its options in at construction, so one instance per combination lets the page flip them live.
class SwitchableSearch implements PathSearch {
	settings: SearchSettings = { diagonal: true, smooth: true };
	private readonly searches = new Map<string, GridAStar>();

	findPath(grid: NavGrid, request: PathRequest): PathResult {
		const { diagonal, smooth } = this.settings;
		const key = `${diagonal}:${smooth}`;
		let search = this.searches.get(key);
		if(!search) {
			search = new GridAStar({ diagonal, smooth });
			this.searches.set(key, search);
		}
		return search.findPath(grid, request);
	}
}

const search = new SwitchableSearch();

export const examplePathfindingUpdate = createPathfindingUpdate<Components, ExamplePathfindingComponents, ExamplePathfindingWorld, ExamplePathfindingInitData>({
	search,
	gateCategories: GATE_CATEGORY,
	init: (_navigation, data) => ({ terrain: data?.terrain, terrainSync: { version: -1 } }),
	preRun(world) {
		if(world.searchSettings) {
			search.settings = world.searchSettings;
		}

		const { terrain, terrainSync } = world;
		if(!terrain || !terrainSync) {
			return;
		}
		const version = Atomics.load(terrain.version, 0);
		if(version === terrainSync.version) {
			return;
		}
		terrainSync.version = version;
		for(let y = 0; y < terrain.tilesHigh; y++) {
			for(let x = 0; x < terrain.tilesWide; x++) {
				setNavigationTerrainSpeed(world.navigation, x, y, terrain.speeds[y * terrain.tilesWide + x]);
			}
		}
	},
});

export default examplePathfindingUpdate;
