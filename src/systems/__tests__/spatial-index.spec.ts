import SpatialIndex, { type SpatialComponents } from '../spatial-index';
import { BODY_SHAPE_INDEX, BODY_SIZE, SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '../../components/body-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_SIZE, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';

interface Box {
	x: number
	y: number
	width?: number
	height?: number
	angle?: number
	// 'none' for an entity with no body at all, which the index copes with and the collision broadphase does not.
	shape?: number | 'none'
}

// Boxes default to 10x10 rectangles, so most tests only give a position.
function createEntity(box: Box, entityId: number): { entityId: number, components: SpatialComponents } {
	const transform = new Float32Array(TRANSFORM_SIZE);
	transform[TRANSFORM_X_INDEX] = box.x;
	transform[TRANSFORM_Y_INDEX] = box.y;
	transform[TRANSFORM_WIDTH_INDEX] = box.width ?? 10;
	transform[TRANSFORM_HEIGHT_INDEX] = box.height ?? 10;
	transform[TRANSFORM_ANGLE_INDEX] = box.angle ?? 0;

	if(box.shape === 'none') {
		return { entityId, components: { transform } };
	}

	const body = new Uint32Array(BODY_SIZE);
	body[BODY_SHAPE_INDEX] = box.shape ?? SHAPE_RECTANGLE;

	return { entityId, components: { transform, body } };
}

// One entity per box, keyed by its position in the list + 1 as its entity id.
function build(boxes: Array<Box>): SpatialIndex {
	return new SpatialIndex(boxes.map((box, index) => createEntity(box, index + 1)));
}

function ids(entities: Array<{ entityId: number }>): Array<number> {
	return entities.map(entity => entity.entityId).sort((first, second) => first - second);
}

describe('spatial-index', () => {
	describe('search', () => {
		it('finds what the box reaches and nothing else', () => {
			const index = build([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]);

			expect(ids(index.search(-20, -20, 20, 20))).toEqual([1]);
			expect(ids(index.search(-20, -20, 120, 120))).toEqual([1, 2, 3]);
			expect(ids(index.search(200, 200, 300, 300))).toEqual([]);
		});

		it('finds an entity the box only touches', () => {
			// The box ends exactly on the left edge of the entity at x 100.
			expect(ids(build([{ x: 100, y: 0 }]).search(0, -5, 95, 5))).toEqual([1]);
			expect(ids(build([{ x: 100, y: 0 }]).search(0, -5, 94, 5))).toEqual([]);
		});

		it('drops whatever the filter rejects', () => {
			const index = build([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);

			expect(ids(index.search(-50, -50, 50, 50, entity => entity.entityId !== 2))).toEqual([1, 3]);
		});

		it('hands the filter the blocks the entity was indexed with', () => {
			const index = build([{ x: 0, y: 0, width: 4 }, { x: 10, y: 0, width: 40 }]);

			// Picked out by reading its own transform back rather than by its id.
			const wide = index.search(-50, -50, 50, 50, entity => entity.components.transform[TRANSFORM_WIDTH_INDEX] > 20);
			expect(ids(wide)).toEqual([2]);
		});

		it('searches from the middle out', () => {
			const index = build([{ x: 0, y: 0 }, { x: 100, y: 0 }]);

			// The far edge is at 95, so a reach of 50 falls short and 95 arrives on it. The reach is per axis.
			expect(ids(index.searchAround(0, 0, 50, 50))).toEqual([1]);
			expect(ids(index.searchAround(0, 0, 95, 50))).toEqual([1, 2]);
			expect(ids(index.searchAround(0, 0, 95, 1))).toEqual([1, 2]);
			expect(ids(index.searchAround(0, 200, 95, 50))).toEqual([]);
		});
	});

	describe('findNearest', () => {
		it('picks the closest of several', () => {
			const index = build([{ x: 100, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }]);

			expect(index.findNearest(0, 0)?.entityId).toBe(2);
		});

		it('measures to the edge of a shape rather than to its middle', () => {
			// The second's centre is further, but it is wide enough that its edge is nearer.
			const index = build([{ x: 100, y: 0, width: 10 }, { x: 150, y: 0, width: 200 }]);

			expect(index.findNearest(0, 0)?.entityId).toBe(2);
		});

		it('finds nothing past maxDistance', () => {
			// A 10 wide entity at 100 has its near edge at 95.
			const index = build([{ x: 100, y: 0 }]);

			expect(index.findNearest(0, 0, 96)?.entityId).toBe(1);
			expect(index.findNearest(0, 0, 94)).toBeUndefined();
		});

		it('skips what the filter rejects rather than giving up on it', () => {
			const index = build([{ x: 30, y: 0 }, { x: 60, y: 0 }]);

			// The nearest is rejected, so the answer is the one behind it, not nothing.
			expect(index.findNearest(0, 0, Infinity, entity => entity.entityId !== 1)?.entityId).toBe(2);
		});

		it('spends maxResults only on entities the filter accepted', () => {
			const index = build([{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }, { x: 40, y: 0 }]);

			// The two rejected nearest must not use up the two results asked for.
			const found = index.findNearby(0, 0, 2, Infinity, entity => entity.entityId > 2);
			expect(found.map(entity => entity.entityId)).toEqual([3, 4]);
		});

		it('returns the closest first', () => {
			const index = build([{ x: 100, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }]);

			expect(index.findNearby(0, 0, 3).map(entity => entity.entityId)).toEqual([2, 3, 1]);
		});
	});

	describe('what goes into the index', () => {
		it('files a circle under the box it covers whichever way it is turned', () => {
			// A rectangle this size turned 45 degrees would reach ~14 on each axis; a circle does not.
			const index = build([{ x: 0, y: 0, width: 20, height: 20, angle: Math.PI / 4, shape: SHAPE_CIRCLE }]);

			expect(ids(index.search(11, 11, 20, 20))).toEqual([]);
			expect(ids(index.search(9, 0, 20, 0))).toEqual([1]);
		});

		it('files a capsule along the way it is facing', () => {
			// 40 long, 10 thick, along x: 20 out that way, 5 the other.
			const index = build([{ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE }]);

			expect(ids(index.search(19, 0, 25, 0))).toEqual([1]);
			expect(ids(index.search(0, 6, 0, 25))).toEqual([]);
		});

		it('takes an entity with no body as the rectangle its transform describes', () => {
			const index = build([{ x: 0, y: 0, width: 40, height: 10, shape: 'none' }]);

			expect(ids(index.search(19, 0, 25, 0))).toEqual([1]);
			expect(ids(index.search(21, 0, 25, 0))).toEqual([]);
		});

		it('keeps an entity that has no size at all', () => {
			// The collision broadphase drops these, but they still have a position to be found at.
			const index = build([{ x: 50, y: 50, width: 0, height: 0 }]);

			expect(index.size).toBe(1);
			expect(ids(index.search(40, 40, 60, 60))).toEqual([1]);
			expect(index.findNearest(50, 40)?.entityId).toBe(1);
		});

		it('skips an entity with no transform', () => {
			const index = new SpatialIndex([
				{ entityId: 1, components: {} },
				{ entityId: 2, components: createEntity({ x: 0, y: 0 }, 2).components },
			]);

			expect(index.size).toBe(1);
			expect(ids(index.search(-50, -50, 50, 50))).toEqual([2]);
		});

		it('answers an empty index without a search', () => {
			const index = build([]);

			expect(index.size).toBe(0);
			expect(index.search(-50, -50, 50, 50)).toEqual([]);
			expect(index.searchAround(0, 0, 50, 50)).toEqual([]);
			expect(index.findNearest(0, 0)).toBeUndefined();
			expect(index.findNearby(0, 0, 5)).toEqual([]);
		});
	});
});
