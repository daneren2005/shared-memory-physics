import { smoothPath } from '../smooth-path';
import { CELL, center, gridFrom, legsAreClear, tilesTouched } from './grid-fixtures';

const HALF = CELL / 2;

describe('smoothPath', () => {
	it('leaves a path of one or two points alone', () => {
		const grid = gridFrom(['...']);

		expect(smoothPath(grid, [center(0, 0)], HALF, HALF, 0)).toEqual([center(0, 0)]);
		expect(smoothPath(grid, [center(0, 0), center(2, 0)], HALF, HALF, 0)).toEqual([center(0, 0), center(2, 0)]);
	});

	it('drops repeated points', () => {
		const grid = gridFrom(['...']);

		expect(smoothPath(grid, [center(0, 0), center(0, 0), center(2, 0), center(2, 0)], HALF, HALF, 0)).toEqual([center(0, 0), center(2, 0)]);
	});

	it('merges a straight run into its two ends', () => {
		const grid = gridFrom([
			'#####',
			'.....',
			'#####',
		]);
		const points = [0, 1, 2, 3, 4].map(x => center(x, 1));

		expect(smoothPath(grid, points, HALF, HALF, 0)).toEqual([center(0, 1), center(4, 1)]);
	});

	it('cuts a corner across open ground', () => {
		const grid = gridFrom([
			'...',
			'...',
			'...',
		]);
		const points = [center(0, 0), center(1, 0), center(2, 0), center(2, 1), center(2, 2)];

		expect(smoothPath(grid, points, HALF, HALF, 0)).toEqual([center(0, 0), center(2, 2)]);
	});

	it('keeps the corner a wall sits in', () => {
		const grid = gridFrom([
			'...',
			'.#.',
			'...',
		]);
		const points = [center(0, 0), center(1, 0), center(2, 0), center(2, 1), center(2, 2)];
		const smoothed = smoothPath(grid, points, HALF, HALF, 0);

		expect(smoothed).toEqual([center(0, 0), center(2, 0), center(2, 2)]);
		expect(legsAreClear(grid, smoothed[0], smoothed.slice(1))).toBe(true);
	});

	it('cuts a corner that only grazes a wall, unless asked for clearance', () => {
		// The straight line from corner to corner touches both walls' corners exactly.
		const grid = gridFrom([
			'..#',
			'...',
			'#..',
		]);
		const points = [center(0, 0), center(1, 0), center(1, 1), center(2, 1), center(2, 2)];

		expect(smoothPath(grid, points, HALF, HALF, 0)).toEqual([center(0, 0), center(2, 2)]);
		expect(smoothPath(grid, points, HALF, HALF, 1)).toEqual(points);
	});

	it('does not pull a detour back through mud', () => {
		const grid = gridFrom([
			'.....',
			'.~~~.',
			'.~~~.',
			'.....',
		]);
		const points = [center(0, 0), center(1, 0), center(2, 0), center(3, 0), center(4, 0), center(4, 1), center(4, 2), center(4, 3)];
		const smoothed = smoothPath(grid, points, HALF, HALF, 0);
		const mud = ['1,1', '2,1', '3,1', '1,2', '2,2', '3,2'];

		expect([...tilesTouched(grid, smoothed[0], smoothed.slice(1))].filter(tile => mud.includes(tile))).toEqual([]);
	});

	it('crosses mud when the shortcut is still the cheaper way', () => {
		// Going around the single mud tile costs more than wading straight through it.
		const grid = gridFrom([
			'.~.',
			'...',
			'...',
		]);
		const points = [center(0, 0), center(0, 1), center(0, 2), center(1, 2), center(2, 2), center(2, 1), center(2, 0)];

		expect(smoothPath(grid, points, HALF, HALF, 0)).toEqual([center(0, 0), center(2, 0)]);
	});

	it('looks past a failed shortcut for a longer one that works', () => {
		// The shortcut to the bottom-right corner clips the mud, but the one on to the end is straight across it.
		const grid = gridFrom([
			'.~.',
			'...',
			'...',
		]);
		const points = [center(0, 0), center(0, 2), center(2, 2), center(2, 0)];

		expect(smoothPath(grid, points, HALF, HALF, 0)).toEqual([center(0, 0), center(2, 0)]);
	});

	it('always keeps the first and last point', () => {
		const grid = gridFrom([
			'.#.',
			'...',
		]);
		const points = [center(0, 0), center(0, 1), center(1, 1), center(2, 1), center(2, 0)];
		const smoothed = smoothPath(grid, points, HALF, HALF, 0);

		expect(smoothed[0]).toEqual(center(0, 0));
		expect(smoothed[smoothed.length - 1]).toEqual(center(2, 0));
		expect(legsAreClear(grid, smoothed[0], smoothed.slice(1))).toBe(true);
	});

	it('smooths from an off-centre start', () => {
		const grid = gridFrom([
			'...',
			'...',
		]);
		const start = { x: 20, y: 22 };
		const points = [start, center(0, 0), center(1, 0), center(2, 0), center(2, 1)];

		expect(smoothPath(grid, points, HALF, HALF, 0)).toEqual([start, center(2, 1)]);
	});
});