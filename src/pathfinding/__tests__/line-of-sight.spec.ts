import { sweepCost } from '../line-of-sight';
import NavGrid from '../nav-grid';
import { CELL, center, gridFrom } from './grid-fixtures';

const HALF = CELL / 2;

describe('sweepCost', () => {
	it('is the cost per unit of open ground across a clear field', () => {
		const grid = gridFrom([
			'.....',
			'.....',
			'.....',
		]);
		const from = center(0, 0);
		const to = center(4, 2);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, HALF, HALF)).toBe(1);
	});

	it('is Infinity when a blocker is anywhere along the way', () => {
		const grid = gridFrom(['..#..']);
		const from = center(0, 0);
		const to = center(4, 0);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, HALF, HALF)).toBe(Infinity);
	});

	it('lets a mover slide along a wall it is touching', () => {
		const grid = gridFrom([
			'#####',
			'.....',
			'#####',
		]);
		const from = center(0, 1);
		const to = center(4, 1);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, HALF, HALF)).toBe(1);
	});

	it('does not let a mover wider than a gap through it', () => {
		const grid = gridFrom([
			'#####',
			'.....',
			'#####',
		]);
		const from = center(0, 1);
		const to = center(4, 1);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, HALF + 1, HALF + 1)).toBe(Infinity);
	});

	it('catches a diagonal clipping a blocker it passes the corner of', () => {
		const grid = gridFrom([
			'...',
			'.#.',
			'...',
		]);
		const from = center(0, 0);
		const to = center(2, 2);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, HALF, HALF)).toBe(Infinity);
	});

	it('misses a blocker the whole box stays clear of', () => {
		const grid = gridFrom([
			'....#',
			'.....',
			'#....',
		]);
		const from = center(0, 0);
		const to = center(2, 2);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, HALF, HALF)).toBe(1);
	});

	it('only looks where the box goes, not the whole bounding box', () => {
		const grid = gridFrom([
			'.....#',
			'......',
			'#.....',
		]);
		const from = center(0, 0);
		const to = center(5, 2);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, 1, 1)).toBe(1);
	});

	it('reports the slowest terrain it crosses', () => {
		const grid = gridFrom(['.=~=.']);
		const from = center(0, 0);
		const to = center(4, 0);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, HALF, HALF)).toBe(2);
	});

	it('reports a road it stays on entirely', () => {
		const grid = gridFrom([
			'.....',
			'_____',
			'.....',
		]);
		const from = center(0, 1);
		const to = center(4, 1);

		expect(sweepCost(grid, from.x, from.y, to.x, to.y, HALF, HALF)).toBe(0.5);
	});

	it('is Infinity when the box leaves the map', () => {
		const grid = new NavGrid(3, 3, CELL);
		const from = center(0, 0);

		expect(sweepCost(grid, from.x, from.y, from.x - CELL, from.y, HALF, HALF)).toBe(Infinity);
		// Touching the map edge from inside is fine.
		expect(sweepCost(grid, from.x, from.y, from.x, from.y + CELL, HALF, HALF)).toBe(1);
	});

	it('checks where a box stands when it does not move', () => {
		const grid = gridFrom(['.#']);
		const open = center(0, 0);
		const blocked = center(1, 0);

		expect(sweepCost(grid, open.x, open.y, open.x, open.y, HALF, HALF)).toBe(1);
		expect(sweepCost(grid, blocked.x, blocked.y, blocked.x, blocked.y, HALF, HALF)).toBe(Infinity);
	});

	it('is symmetric in direction', () => {
		const grid = gridFrom([
			'.....',
			'..#..',
			'.....',
		]);
		const a = center(0, 0);
		const b = center(4, 2);

		expect(sweepCost(grid, a.x, a.y, b.x, b.y, HALF, HALF)).toBe(sweepCost(grid, b.x, b.y, a.x, a.y, HALF, HALF));
	});
});