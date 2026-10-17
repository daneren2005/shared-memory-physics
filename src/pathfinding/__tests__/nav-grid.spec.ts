import NavGrid from '../nav-grid';
import { CELL, gridFrom, tileRect } from './grid-fixtures';

describe('NavGrid', () => {
	it('rejects a grid with no tiles or no cell size', () => {
		expect(() => new NavGrid(0, 4, CELL)).toThrow('positive whole number of tiles');
		expect(() => new NavGrid(4, 2.5, CELL)).toThrow('positive whole number of tiles');
		expect(() => new NavGrid(4, 4, 0)).toThrow('positive cell size');
	});

	it('starts fully open at normal speed', () => {
		const grid = new NavGrid(3, 2, CELL);
		for(let y = 0; y < 2; y++) {
			for(let x = 0; x < 3; x++) {
				expect(grid.isBlocked(x, y)).toBe(false);
				expect(grid.terrainSpeed(x, y)).toBe(1);
				expect(grid.cost(x, y)).toBe(CELL);
			}
		}
	});

	it('treats off-map tiles as blocked', () => {
		const grid = new NavGrid(2, 2, CELL);
		expect(grid.isBlocked(-1, 0)).toBe(true);
		expect(grid.isBlocked(0, -1)).toBe(true);
		expect(grid.isBlocked(2, 0)).toBe(true);
		expect(grid.isBlocked(0, 2)).toBe(true);
	});

	it('maps world positions to tiles and back to tile centres', () => {
		const grid = new NavGrid(4, 4, CELL);
		expect(grid.tileOf(0)).toBe(0);
		expect(grid.tileOf(31.9)).toBe(0);
		expect(grid.tileOf(32)).toBe(1);
		expect(grid.tileCenter(1)).toBe(48);
	});

	it('clones blockers and terrain into a grid that then changes independently', () => {
		const grid = new NavGrid(4, 4, CELL);
		grid.addBlocker(tileRect(1, 1));
		grid.setTerrainSpeed(2, 2, 1.5);

		const copy = grid.clone();
		copy.addBlocker(tileRect(3, 3));

		expect(copy.isBlocked(1, 1)).toBe(true);
		expect(copy.terrainSpeed(2, 2)).toBe(1.5);
		expect(copy.maxSpeed).toBe(1.5);
		expect(copy.region(0, 0)).not.toBe(0);
		expect(grid.isBlocked(3, 3)).toBe(false);
	});

	describe('blockers', () => {
		it('blocks every tile a rect has area in', () => {
			const grid = new NavGrid(4, 4, CELL);
			grid.addBlocker({ minX: 10, minY: 40, maxX: 70, maxY: 50 });

			expect(blockedTiles(grid)).toEqual(['0,1', '1,1', '2,1']);
		});

		it('does not block a tile the rect only touches along an edge', () => {
			const grid = new NavGrid(4, 4, CELL);
			grid.addBlocker(tileRect(1, 1));

			expect(blockedTiles(grid)).toEqual(['1,1']);
		});

		it('ignores a rect with no area', () => {
			const grid = new NavGrid(4, 4, CELL);
			grid.addBlocker({ minX: 32, minY: 32, maxX: 32, maxY: 96 });

			expect(blockedTiles(grid)).toEqual([]);
		});

		it('clamps a rect that hangs off the map', () => {
			const grid = new NavGrid(2, 2, CELL);
			grid.addBlocker({ minX: -100, minY: -100, maxX: 20, maxY: 20 });
			grid.addBlocker({ minX: 50, minY: 50, maxX: 500, maxY: 500 });

			expect(blockedTiles(grid)).toEqual(['0,0', '1,1']);
		});

		it('ignores a rect entirely off the map', () => {
			const grid = new NavGrid(2, 2, CELL);
			grid.addBlocker({ minX: 100, minY: 100, maxX: 200, maxY: 200 });

			expect(blockedTiles(grid)).toEqual([]);
		});

		it('keeps a tile blocked until every overlapping blocker is removed', () => {
			const grid = new NavGrid(4, 4, CELL);
			const wide = tileRect(0, 0, 2, 1);
			const single = tileRect(1, 0);
			grid.addBlocker(wide);
			grid.addBlocker(single);
			expect(grid.blockerCount(1, 0)).toBe(2);

			grid.removeBlocker(wide);
			expect(blockedTiles(grid)).toEqual(['1,0']);

			grid.removeBlocker(single);
			expect(blockedTiles(grid)).toEqual([]);
		});

		it('never counts below zero when a blocker is removed twice', () => {
			const grid = new NavGrid(2, 2, CELL);
			grid.removeBlocker(tileRect(0, 0));
			grid.addBlocker(tileRect(0, 0));

			expect(grid.isBlocked(0, 0)).toBe(true);
		});

		it('checks a whole footprint at once', () => {
			const grid = gridFrom([
				'...',
				'..#',
				'...',
			]);

			expect(grid.isAreaClear(0, 0, 2, 2)).toBe(true);
			expect(grid.isAreaClear(1, 0, 2, 2)).toBe(false);
			// Off the map is never clear.
			expect(grid.isAreaClear(2, 2, 2, 2)).toBe(false);
			expect(grid.isAreaClear(-1, 0, 2, 2)).toBe(false);
		});
	});

	describe('terrain', () => {
		it('makes fast tiles cheaper and slow ones dearer', () => {
			const grid = gridFrom(['.~=']);

			expect(grid.cost(0, 0)).toBe(CELL);
			expect(grid.cost(1, 0)).toBe(CELL * 2);
			expect(grid.cost(2, 0)).toBeCloseTo(CELL / 1.5);
		});

		it('rejects a speed that is not a positive finite number', () => {
			const grid = new NavGrid(2, 2, CELL);
			expect(() => grid.setTerrainSpeed(0, 0, 0)).toThrow('positive finite');
			expect(() => grid.setTerrainSpeed(0, 0, -1)).toThrow('positive finite');
			expect(() => grid.setTerrainSpeed(0, 0, Infinity)).toThrow('positive finite');
			expect(() => grid.setTerrainSpeed(0, 0, Number.NaN)).toThrow('positive finite');
		});

		it('ignores terrain set off the map', () => {
			const grid = new NavGrid(2, 2, CELL);
			grid.setTerrainSpeed(5, 5, 3);

			expect(grid.terrainSpeed(5, 5)).toBe(1);
			expect(grid.maxSpeed).toBe(1);
		});

		it('remembers the fastest speed ever set, even after it is paved over', () => {
			const grid = new NavGrid(2, 2, CELL);
			grid.setTerrainSpeed(0, 0, 2);
			grid.setTerrainSpeed(0, 0, 0.5);

			expect(grid.maxSpeed).toBe(2);
		});
	});

	describe('regions', () => {
		it('puts connected open tiles in one region and blocked tiles in none', () => {
			const grid = gridFrom([
				'..#..',
				'..#..',
			]);

			expect(grid.region(0, 0)).toBe(grid.region(1, 1));
			expect(grid.region(3, 0)).toBe(grid.region(4, 1));
			expect(grid.region(0, 0)).not.toBe(grid.region(3, 0));
			expect(grid.region(2, 0)).toBe(0);
			expect(grid.region(-1, 0)).toBe(0);
		});

		it('does not join tiles that only meet at a corner', () => {
			const grid = gridFrom([
				'.#',
				'#.',
			]);

			expect(grid.region(0, 0)).not.toBe(grid.region(1, 1));
		});

		it('splits and rejoins as blockers come and go', () => {
			const grid = gridFrom(['...']);
			expect(grid.region(0, 0)).toBe(grid.region(2, 0));

			grid.addBlocker(tileRect(1, 0));
			expect(grid.region(0, 0)).not.toBe(grid.region(2, 0));

			grid.removeBlocker(tileRect(1, 0));
			expect(grid.region(0, 0)).toBe(grid.region(2, 0));
		});

		it('ignores terrain, which slows but never separates', () => {
			const grid = gridFrom(['.~~~.']);

			expect(grid.region(0, 0)).toBe(grid.region(4, 0));
		});
	});
});

function blockedTiles(grid: NavGrid): Array<string> {
	const tiles: Array<string> = [];
	for(let y = 0; y < grid.tilesHigh; y++) {
		for(let x = 0; x < grid.tilesWide; x++) {
			if(grid.isBlocked(x, y)) {
				tiles.push(`${x},${y}`);
			}
		}
	}
	return tiles;
}