import { BODY_CATEGORY_INDEX } from '../components/body-component-constants';
import NavGrid, { type Rect } from './nav-grid';
import { applyRectChanges, blockerRect, type PathBlockerDelta } from './path-blockers';

interface Gate {
	rect: Rect
	category: number
}

// Worker-local grids the pathfinding update searches, rebuilt from the blocker and gate queries on every load.
export interface NavigationState {
	// Blockers only: what a mover whose mask takes in none of the gate categories walks through.
	grid: NavGrid
	blockers: Map<number, Rect>
	gateCategories: number
	gates: Map<number, Gate>
	// Keyed by the gate categories a mover's mask takes in. Cloned from `grid` on first use, so a game with gates no
	// mover collides with never pays for a second grid.
	gatedGrids: Map<number, NavGrid>
}

export function createNavigationState(tilesWide: number, tilesHigh: number, cellSize: number, gateCategories = 0): NavigationState {
	return {
		grid: new NavGrid(tilesWide, tilesHigh, cellSize),
		blockers: new Map(),
		gateCategories,
		gates: new Map(),
		gatedGrids: new Map(),
	};
}

export function navigationGridFor(state: NavigationState, collideMask: number): NavGrid {
	const key = collideMask & state.gateCategories;
	if(!key) {
		return state.grid;
	}
	let grid = state.gatedGrids.get(key);
	if(!grid) {
		grid = state.grid.clone();
		for(const gate of state.gates.values()) {
			if(gate.category & key) {
				grid.addBlocker(gate.rect);
			}
		}
		state.gatedGrids.set(key, grid);
	}
	return grid;
}

// Everything blocking a mover with this mask: the blockers plus the gates it collides with.
export function blockingRects(state: NavigationState, collideMask: number): Array<Rect> {
	const key = collideMask & state.gateCategories;
	const rects = [...state.blockers.values()];
	if(key) {
		for(const gate of state.gates.values()) {
			if(gate.category & key) {
				rects.push(gate.rect);
			}
		}
	}
	return rects;
}

// A multiplier on walking speed (1.5 for a road, 0.5 for mud), applied to every grid.
export function setNavigationTerrainSpeed(state: NavigationState, tileX: number, tileY: number, speed: number): void {
	state.grid.setTerrainSpeed(tileX, tileY, speed);
	for(const grid of state.gatedGrids.values()) {
		grid.setTerrainSpeed(tileX, tileY, speed);
	}
}

// Returns whether any blockers were added, so paths already handed out can be rechecked.
export function applyPathBlockerChanges(state: NavigationState, delta: PathBlockerDelta): boolean {
	return applyRectChanges(state.blockers, [state.grid, ...state.gatedGrids.values()], delta);
}

export function applyPathGateChanges(state: NavigationState, delta: PathBlockerDelta): boolean {
	for(const entityId of delta.removed) {
		const gate = state.gates.get(entityId);
		if(gate) {
			forGatedGrids(state, gate.category, grid => grid.removeBlocker(gate.rect));
			state.gates.delete(entityId);
		}
	}
	for(const { entityId, components } of delta.added) {
		const previous = state.gates.get(entityId);
		if(previous) {
			forGatedGrids(state, previous.category, grid => grid.removeBlocker(previous.rect));
		}
		const { transform, body } = components;
		if(!(transform instanceof Float32Array) || !(body instanceof Uint32Array)) {
			state.gates.delete(entityId);
			continue;
		}
		const gate = { rect: blockerRect(transform, body), category: body[BODY_CATEGORY_INDEX] & state.gateCategories };
		forGatedGrids(state, gate.category, grid => grid.addBlocker(gate.rect));
		state.gates.set(entityId, gate);
	}
	return delta.added.length > 0;
}

function forGatedGrids(state: NavigationState, category: number, apply: (grid: NavGrid) => void): void {
	for(const [key, grid] of state.gatedGrids) {
		if(key & category) {
			apply(grid);
		}
	}
}
