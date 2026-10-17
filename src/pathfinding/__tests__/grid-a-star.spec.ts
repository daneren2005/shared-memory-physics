import GridAStar from '../grid-a-star';
import NavGrid from '../nav-grid';
import { PathStatus, type Point } from '../path-search';
import {
	AGENT, CELL, center, dijkstraCost, gridFrom, legsAreClear, pathLength, randomRows, request, seededRandom, tileOf, tileRect, tilesTouched,
} from './grid-fixtures';

const raw = () => new GridAStar({ smooth: false });

// Cost of an unsmoothed 4-way path from a tile centre: every tile it steps into.
function rawCost(grid: NavGrid, points: ReadonlyArray<Point>): number {
	return points.reduce((total, point) => {
		const tile = tileOf(point);
		return total + grid.cost(tile.x, tile.y);
	}, 0);
}

describe('GridAStar', () => {
	it('rejects an exact destination overlapping a blocker even when its tile anchor is open', () => {
		const grid = gridFrom(['.....', '..#..', '.....']);
		const goal = { x: 2 * CELL - 1, y: 1.5 * CELL };
		const result = new GridAStar().findPath(grid, request(center(0, 1), goal));
		expect(result.status).toBe(PathStatus.Unreachable);
		expect(result.points).not.toContainEqual(goal);
		expect(legsAreClear(grid, center(0, 1), result.points)).toBe(true);
	});

	describe('open ground', () => {
		it('walks straight to the goal', () => {
			const grid = gridFrom([
				'.....',
				'.....',
				'.....',
			]);

			const result = new GridAStar().findPath(grid, request(center(0, 0), center(4, 2)));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points).toEqual([center(4, 2)]);
		});

		it('returns no waypoints when already standing on the goal', () => {
			const grid = gridFrom(['...']);

			const result = new GridAStar().findPath(grid, request(center(1, 0), center(1, 0)));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points).toEqual([]);
		});

		it('walks to a goal elsewhere in the same tile', () => {
			const grid = gridFrom(['...', '...']);
			const goal = { x: 40, y: 20 };

			const result = new GridAStar().findPath(grid, request(center(1, 0), goal));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points).toEqual([goal]);
		});

		it('ends exactly on a goal that is not a tile centre', () => {
			const grid = gridFrom([
				'......',
				'..#...',
				'......',
			]);
			const goal = { x: 150.25, y: 70.5 };

			const result = new GridAStar().findPath(grid, request(center(0, 1), goal));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points[result.points.length - 1]).toEqual(goal);
		});

		it('starts from an off-centre position', () => {
			const grid = gridFrom([
				'....',
				'....',
			]);
			const start = { x: 21, y: 25 };

			const result = new GridAStar().findPath(grid, request(start, center(3, 1)));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points).toEqual([center(3, 1)]);
		});

		it('takes a shortest 4-way route when unsmoothed', () => {
			const grid = gridFrom([
				'......',
				'......',
				'......',
			]);

			const result = raw().findPath(grid, request(center(0, 0), center(5, 2)));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points.length).toBe(7);
			expect(rawCost(grid, result.points)).toBe(7 * CELL);
		});
	});

	describe('walls', () => {
		it('goes through the gap in a wall', () => {
			const grid = gridFrom([
				'..#..',
				'..#..',
				'.....',
				'..#..',
				'..#..',
			]);
			const from = center(0, 0);

			const result = new GridAStar().findPath(grid, request(from, center(4, 0)));

			expect(result.status).toBe(PathStatus.Found);
			expect(legsAreClear(grid, from, result.points)).toBe(true);
			expect(tilesTouched(grid, from, result.points)).toContain('2,2');
		});

		it('walks out of a U-shaped trap that opens away from the goal', () => {
			const grid = gridFrom([
				'.......',
				'.#####.',
				'.#...#.',
				'.#...#.',
				'.......',
				'.......',
			]);
			const from = center(3, 2);
			const to = center(3, 0);

			const result = new GridAStar().findPath(grid, request(from, to));

			expect(result.status).toBe(PathStatus.Found);
			expect(legsAreClear(grid, from, result.points)).toBe(true);
			expect(result.points[result.points.length - 1]).toEqual(to);
		});

		it('solves a maze along the only way through', () => {
			const grid = gridFrom([
				'.#.....',
				'.#.###.',
				'.#.#...',
				'.#.#.##',
				'...#...',
			]);
			const from = center(0, 0);
			const to = center(6, 4);

			const smoothed = new GridAStar().findPath(grid, request(from, to));
			const unsmoothed = raw().findPath(grid, request(from, to));

			expect(smoothed.status).toBe(PathStatus.Found);
			expect(legsAreClear(grid, from, smoothed.points)).toBe(true);
			expect(rawCost(grid, unsmoothed.points)).toBe(dijkstraCost(grid, tileOf(from), tileOf(to)));
		});

		it('never cuts the corner of a wall', () => {
			const grid = gridFrom([
				'.....',
				'.###.',
				'.###.',
				'.....',
			]);
			const from = center(0, 0);

			const result = new GridAStar().findPath(grid, request(from, center(4, 3)));

			expect(legsAreClear(grid, from, result.points)).toBe(true);
			expect(result.points.length).toBe(2);
		});
	});

	describe('unreachable goals', () => {
		it('reports a walled-in goal as unreachable without searching', () => {
			const grid = gridFrom([
				'.....',
				'.###.',
				'.#.#.',
				'.###.',
				'.....',
			]);

			const result = new GridAStar().findPath(grid, request(center(0, 0), center(2, 2)));

			expect(result).toEqual({ status: PathStatus.Unreachable, points: [], iterations: 0 });
		});

		it('reports a start that is walled in as unreachable', () => {
			const grid = gridFrom([
				'###..',
				'#.#..',
				'###..',
			]);

			const result = new GridAStar().findPath(grid, request(center(1, 1), center(4, 1)));

			expect(result.status).toBe(PathStatus.Unreachable);
			expect(result.points).toEqual([]);
		});

		it('leads to the nearest open spot beside a goal inside a blocker', () => {
			const grid = gridFrom([
				'.....',
				'...#.',
				'.....',
			]);
			const from = center(0, 1);

			const result = new GridAStar().findPath(grid, request(from, center(3, 1)));

			expect(result.status).toBe(PathStatus.Unreachable);
			expect(result.points[result.points.length - 1]).toEqual(center(2, 1));
			expect(legsAreClear(grid, from, result.points)).toBe(true);
		});

		it('breaks a tie between spots beside a blocked goal toward the start', () => {
			const grid = gridFrom([
				'.....',
				'..#..',
				'.....',
			]);

			const fromLeft = new GridAStar().findPath(grid, request(center(0, 1), center(2, 1)));
			const fromRight = new GridAStar().findPath(grid, request(center(4, 1), center(2, 1)));

			expect(fromLeft.points[fromLeft.points.length - 1]).toEqual(center(1, 1));
			expect(fromRight.points[fromRight.points.length - 1]).toEqual(center(3, 1));
		});

		it('gives up on a blocked goal with no open ground within reach', () => {
			const grid = new NavGrid(30, 30, CELL);
			grid.addBlocker(tileRect(10, 10, 10, 10));

			const result = new GridAStar({ relocateRadius: 3 }).findPath(grid, request(center(0, 0), center(15, 15)));

			expect(result).toEqual({ status: PathStatus.Unreachable, points: [], iterations: 0 });
		});

		it('treats a goal off the map as unreachable and leads to the map edge', () => {
			const grid = gridFrom([
				'....',
				'....',
			]);

			const result = new GridAStar().findPath(grid, request(center(0, 0), { x: 500, y: 16 }));

			expect(result.status).toBe(PathStatus.Unreachable);
			expect(result.points[result.points.length - 1]).toEqual(center(3, 0));
		});
	});

	describe('blocked start', () => {
		it('steps out of a blocker it is standing in', () => {
			const grid = gridFrom([
				'.....',
				'.#...',
				'.....',
			]);

			const result = new GridAStar().findPath(grid, request(center(1, 1), center(4, 1)));
			const unsmoothed = raw().findPath(grid, request(center(1, 1), center(4, 1)));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points).toEqual([center(4, 1)]);
			// Out toward the goal first rather than doubling back.
			expect(unsmoothed.points[0]).toEqual(center(2, 1));
		});
	});

	describe('agent size', () => {
		const gap = [
			'...#...',
			'.......',
			'...#...',
			'...#...',
		];

		it('fits a one-tile mover through a one-tile gap', () => {
			const grid = gridFrom(gap);
			const from = center(0, 2);

			const result = new GridAStar().findPath(grid, request(from, center(6, 2)));

			expect(result.status).toBe(PathStatus.Found);
			expect(legsAreClear(grid, from, result.points)).toBe(true);
		});

		it('keeps a two-tile mover out of a one-tile gap', () => {
			const grid = gridFrom(gap);
			const size = AGENT * 2;

			const result = new GridAStar().findPath(grid, request({ x: 32, y: 96 }, { x: 192, y: 96 }, size));

			expect(result.status).toBe(PathStatus.Unreachable);
			expect(legsAreClear(grid, { x: 32, y: 96 }, result.points, size)).toBe(true);
		});

		it('fits a two-tile mover through a two-tile gap', () => {
			const grid = gridFrom([
				'...#...',
				'.......',
				'.......',
				'...#...',
			]);
			const size = AGENT * 2;
			const from = { x: 32, y: 64 };

			const result = new GridAStar().findPath(grid, request(from, { x: 192, y: 64 }, size));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points[result.points.length - 1]).toEqual({ x: 192, y: 64 });
			expect(legsAreClear(grid, from, result.points, size)).toBe(true);
		});

		it('rounds a slightly-too-big mover up to the next whole tile', () => {
			const grid = gridFrom(gap);

			const result = new GridAStar().findPath(grid, request(center(0, 2), center(6, 2), AGENT + 1));

			expect(result.status).toBe(PathStatus.Unreachable);
		});

		it('treats a mover bigger than the map as never reaching anything', () => {
			const grid = gridFrom(['..']);

			const result = new GridAStar().findPath(grid, request(center(0, 0), center(1, 0), AGENT * 3));

			expect(result.status).toBe(PathStatus.Unreachable);
		});
	});

	describe('diagonal movement', () => {
		it('takes diagonal steps across open ground', () => {
			const grid = gridFrom([
				'....',
				'....',
				'....',
				'....',
			]);

			const result = new GridAStar({ diagonal: true, smooth: false }).findPath(grid, request(center(0, 0), center(3, 3)));

			expect(result.points).toEqual([center(1, 1), center(2, 2), center(3, 3)]);
		});

		it('never squeezes between two blockers that meet at a corner', () => {
			const grid = gridFrom([
				'.#.',
				'#..',
				'...',
			]);

			const result = new GridAStar({ diagonal: true }).findPath(grid, request(center(0, 0), center(2, 2)));

			expect(result.status).toBe(PathStatus.Unreachable);
		});

		it('does not cut a corner beside a single blocker', () => {
			const grid = gridFrom([
				'.#.',
				'...',
			]);
			const from = center(0, 0);

			const result = new GridAStar({ diagonal: true, smooth: false }).findPath(grid, request(from, center(2, 0)));

			expect(result.status).toBe(PathStatus.Found);
			expect(result.points).toEqual([center(0, 1), center(1, 1), center(2, 1), center(2, 0)]);
		});
	});

	describe('terrain', () => {
		it('takes a road detour that is quicker than the straight way', () => {
			const grid = gridFrom([
				'.......',
				'_______',
			]);
			const from = center(0, 0);
			const to = center(6, 0);

			const result = raw().findPath(grid, request(from, to));

			expect(tilesTouched(grid, from, result.points)).toContain('3,1');
			expect(rawCost(grid, result.points)).toBe(dijkstraCost(grid, tileOf(from), tileOf(to)));
		});

		it('walks round mud when going round is cheaper', () => {
			const grid = gridFrom([
				'.....',
				'.~~~.',
				'.~~~.',
				'.....',
			]);
			const from = center(0, 1);

			const result = new GridAStar().findPath(grid, request(from, center(4, 2)));
			const mud = ['1,1', '2,1', '3,1', '1,2', '2,2', '3,2'];

			expect(result.status).toBe(PathStatus.Found);
			expect([...tilesTouched(grid, from, result.points)].filter(tile => mud.includes(tile))).toEqual([]);
		});

		it('wades through mud when going round costs more', () => {
			const grid = gridFrom([
				'#####',
				'..~..',
				'.###.',
				'.###.',
				'.###.',
				'.....',
			]);
			const from = center(0, 1);

			const result = new GridAStar().findPath(grid, request(from, center(4, 1)));

			expect(result.points).toEqual([center(4, 1)]);
		});

		it('stays optimal when roads make tiles cheaper than normal ground', () => {
			const grid = gridFrom([
				'.____.',
				'.#..#.',
				'......',
			]);
			const from = center(0, 2);
			const to = center(5, 2);

			const result = raw().findPath(grid, request(from, to));

			expect(rawCost(grid, result.points)).toBeCloseTo(dijkstraCost(grid, tileOf(from), tileOf(to)));
		});
	});

	describe('search budget', () => {
		it('stops with an incomplete path that heads toward the goal', () => {
			const grid = new NavGrid(60, 60, CELL);
			grid.addBlocker(tileRect(30, 0, 1, 59));
			const from = center(0, 0);
			const to = center(59, 0);

			const result = new GridAStar({ maxIterations: 50 }).findPath(grid, request(from, to));

			expect(result.status).toBe(PathStatus.Incomplete);
			expect(result.iterations).toBe(50);
			const end = result.points[result.points.length - 1];
			expect(Math.hypot(end.x - to.x, end.y - to.y)).toBeLessThan(Math.hypot(from.x - to.x, from.y - to.y));
			expect(legsAreClear(grid, from, result.points)).toBe(true);
		});

		it('reaches the goal by searching again from the end of each incomplete path', () => {
			const grid = new NavGrid(200, 5, CELL);
			grid.addBlocker(tileRect(50, 0, 1, 4));
			grid.addBlocker(tileRect(120, 1, 1, 4));
			const search = new GridAStar({ maxIterations: 60 });
			const to = center(199, 2);
			let position = center(0, 0);

			for(let attempt = 0; attempt < 20; attempt++) {
				const result = search.findPath(grid, request(position, to));
				position = result.points[result.points.length - 1] ?? position;
				if(result.status === PathStatus.Found) {
					break;
				}
			}

			expect(position).toEqual(to);
		});

		it('can dead-end against a wall too long for its budget, making no further progress', () => {
			const grid = new NavGrid(40, 40, CELL);
			grid.addBlocker(tileRect(20, 0, 1, 39));
			const search = new GridAStar({ maxIterations: 200 });
			const to = center(39, 0);

			const first = search.findPath(grid, request(center(0, 0), to));
			const end = first.points[first.points.length - 1];
			const second = search.findPath(grid, request(end, to));

			expect(first.status).toBe(PathStatus.Incomplete);
			expect(tileOf(end)).toEqual({ x: 19, y: 0 });
			expect(second.status).toBe(PathStatus.Incomplete);
			expect(second.points).toEqual([]);
		});
	});

	describe('consistency', () => {
		it('gives the same answer every time', () => {
			const grid = gridFrom(randomRows(seededRandom(7), 20, 20, 0.25));
			grid.addBlocker(tileRect(0, 0));
			grid.removeBlocker(tileRect(0, 0));
			const search = new GridAStar();
			const from = center(0, 0);
			const to = center(19, 19);

			expect(search.findPath(grid, request(from, to))).toEqual(search.findPath(grid, request(from, to)));
			expect(new GridAStar().findPath(grid, request(from, to))).toEqual(search.findPath(grid, request(from, to)));
		});

		it('reuses one search across grids of different sizes', () => {
			const search = new GridAStar();
			const small = gridFrom(['...']);
			const large = gridFrom(['.....', '.....']);

			expect(search.findPath(small, request(center(0, 0), center(2, 0))).status).toBe(PathStatus.Found);
			expect(search.findPath(large, request(center(0, 0), center(4, 1))).status).toBe(PathStatus.Found);
			expect(search.findPath(small, request(center(0, 0), center(2, 0))).status).toBe(PathStatus.Found);
		});

		it('sees blockers added after an earlier search', () => {
			const grid = gridFrom(['.....']);
			const search = new GridAStar();
			expect(search.findPath(grid, request(center(0, 0), center(4, 0))).status).toBe(PathStatus.Found);

			grid.addBlocker(tileRect(2, 0));

			expect(search.findPath(grid, request(center(0, 0), center(4, 0))).status).toBe(PathStatus.Unreachable);
		});
	});

	describe('random maps', () => {
		it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('matches the cheapest route on uniform map %i', seed => {
			const random = seededRandom(seed);
			const grid = gridFrom(randomRows(random, 16, 12, 0.3));
			const from = center(0, 0);
			const to = center(15, 11);
			grid.removeBlocker(tileRect(0, 0));
			grid.removeBlocker(tileRect(15, 11));

			const cheapest = dijkstraCost(grid, tileOf(from), tileOf(to));
			const unsmoothed = raw().findPath(grid, request(from, to));
			const smoothed = new GridAStar().findPath(grid, request(from, to));

			if(cheapest === Infinity) {
				expect(unsmoothed.status).toBe(PathStatus.Unreachable);
				expect(smoothed.status).toBe(PathStatus.Unreachable);
				return;
			}
			expect(unsmoothed.status).toBe(PathStatus.Found);
			expect(rawCost(grid, unsmoothed.points)).toBe(cheapest);
			expect(smoothed.status).toBe(PathStatus.Found);
			expect(legsAreClear(grid, from, smoothed.points)).toBe(true);
			expect(pathLength(from, smoothed.points)).toBeLessThanOrEqual(pathLength(from, unsmoothed.points) + 1e-6);
		});

		it.each([11, 12, 13, 14, 15, 16, 17, 18])('matches the cheapest route with mixed terrain on map %i', seed => {
			const random = seededRandom(seed);
			const grid = gridFrom(randomRows(random, 14, 10, 0.2, true));
			const from = center(0, 0);
			const to = center(13, 9);
			grid.removeBlocker(tileRect(0, 0));
			grid.removeBlocker(tileRect(13, 9));

			const cheapest = dijkstraCost(grid, tileOf(from), tileOf(to));
			const unsmoothed = raw().findPath(grid, request(from, to));

			if(cheapest === Infinity) {
				expect(unsmoothed.status).toBe(PathStatus.Unreachable);
				return;
			}
			expect(rawCost(grid, unsmoothed.points)).toBeCloseTo(cheapest);
			expect(legsAreClear(grid, from, new GridAStar().findPath(grid, request(from, to)).points)).toBe(true);
		});
	});

	it('crosses a full-size map of scattered walls within the default budget', () => {
		const grid = gridFrom(randomRows(seededRandom(99), 512, 512, 0.15));
		for(let y = 0; y < 512; y++) {
			for(let x = 0; x < 512; x++) {
				if((x < 3 && y < 3) || (x > 508 && y > 508)) {
					while(grid.isBlocked(x, y)) {
						grid.removeBlocker(tileRect(x, y));
					}
				}
			}
		}
		const from = center(0, 0);

		const result = new GridAStar().findPath(grid, request(from, center(511, 511)));

		expect(result.status).toBe(PathStatus.Found);
		expect(legsAreClear(grid, from, result.points)).toBe(true);
	});

	it('floods a full-size serpentine map within its iteration cap', () => {
		const grid = new NavGrid(512, 512, CELL);
		for(let x = 20; x < 500; x += 40) {
			grid.addBlocker(tileRect(x, x % 80 === 20 ? 0 : 12, 1, 500));
		}

		const result = new GridAStar({ maxIterations: grid.tileCount }).findPath(grid, request(center(0, 0), center(511, 511)));

		expect(result.status).toBe(PathStatus.Found);
		expect(result.iterations).toBeLessThanOrEqual(grid.tileCount);
	});
});