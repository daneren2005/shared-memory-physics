import {
	boundsHalfHeight, boundsHalfWidth, orientedBoxesOverlap,
	capsuleHalfLength, shapeHalfHeight, shapeHalfWidth, shapeIsEmpty, shapeRadius, shapesOverlap,
	pointSegmentDistanceSquared, segmentBoxDistanceSquared, segmentSegmentDistanceSquared,
} from '../shapes';
import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '../../components/body-component';

const QUARTER_TURN = Math.PI / 2;
const EIGHTH_TURN = Math.PI / 4;

// Checks each pair from both sides: overlap is symmetric, so swapping the arguments must agree.
function overlaps(
	aShape: number, aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
): boolean {
	const forwards = shapesOverlap(aShape, aX, aY, aWidth, aHeight, aAngle, bShape, bX, bY, bWidth, bHeight, bAngle);
	const backwards = shapesOverlap(bShape, bX, bY, bWidth, bHeight, bAngle, aShape, aX, aY, aWidth, aHeight, aAngle);
	expect(forwards).toEqual(backwards);

	return forwards;
}

describe('oriented-box', () => {
	describe('bounds', () => {
		it('is half the size itself when the box is not turned', () => {
			expect(boundsHalfWidth(10, 4, 0)).toBeCloseTo(5);
			expect(boundsHalfHeight(10, 4, 0)).toBeCloseTo(2);
		});

		it('swaps the two axes on a quarter turn', () => {
			expect(boundsHalfWidth(10, 4, QUARTER_TURN)).toBeCloseTo(2);
			expect(boundsHalfHeight(10, 4, QUARTER_TURN)).toBeCloseTo(5);
		});

		it('grows to hold the corners of a box turned between the axes', () => {
			// A square on its corner is as wide as its own diagonal.
			expect(boundsHalfWidth(10, 10, EIGHTH_TURN)).toBeCloseTo(Math.sqrt(200) / 2);
			expect(boundsHalfHeight(10, 10, EIGHTH_TURN)).toBeCloseTo(Math.sqrt(200) / 2);
		});

		it('is unchanged by turning the box all the way round', () => {
			expect(boundsHalfWidth(10, 4, Math.PI)).toBeCloseTo(5);
			expect(boundsHalfWidth(10, 4, -QUARTER_TURN)).toBeCloseTo(2);
		});
	});

	describe('overlaps', () => {
		it('finds two unturned boxes sharing a spot', () => {
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 0, 0, 10, 10, 0)).toEqual(true);
		});

		it('misses two unturned boxes side by side', () => {
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 20, 0, 10, 10, 0)).toEqual(false);
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 0, 20, 10, 10, 0)).toEqual(false);
		});

		it('treats boxes that only just touch as not overlapping', () => {
			// Edges meet exactly at x = 5; a hair closer and they overlap.
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 10, 0, 10, 10, 0)).toEqual(false);
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 9.99, 0, 10, 10, 0)).toEqual(true);
		});

		it('never overlaps a box with no size, even sitting inside another one', () => {
			expect(orientedBoxesOverlap(0, 0, 0, 0, 0, 0, 0, 10, 10, 0)).toEqual(false);
			expect(orientedBoxesOverlap(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)).toEqual(false);
			expect(orientedBoxesOverlap(0, 0, 10, 0, 0, 0, 0, 10, 10, 0)).toEqual(false);
		});

		it('measures from the centre of each box, not a corner', () => {
			// 8 apart overlaps by 2 centre to centre; from a corner they would miss.
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 8, 0, 10, 10, 0)).toEqual(true);
		});

		it('reaches further once a box is turned', () => {
			expect(orientedBoxesOverlap(0, 0, 2, 10, 0, 5, 0, 2, 10, 0)).toEqual(false);
			expect(orientedBoxesOverlap(0, 0, 2, 10, 0, 5, 0, 2, 10, QUARTER_TURN)).toEqual(true);
		});

		it('finds a corner-on overlap neither box\'s own axes would show', () => {
			expect(orientedBoxesOverlap(0, 0, 10, 10, EIGHTH_TURN, 7, 0, 10, 10, EIGHTH_TURN)).toEqual(true);
			expect(orientedBoxesOverlap(0, 0, 10, 10, EIGHTH_TURN, 15, 0, 10, 10, EIGHTH_TURN)).toEqual(false);
		});

		it('rules out a turned box whose containing bounds still overlap', () => {
			// On its corner the square's bounds reach the second box, but the nearest corner does not.
			expect(orientedBoxesOverlap(0, 0, 10, 10, EIGHTH_TURN, 6.5, 6.5, 2, 2, 0)).toEqual(false);
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 5.5, 5.5, 2, 2, 0)).toEqual(true);
		});

		it('does not care which box is given first', () => {
			expect(orientedBoxesOverlap(0, 0, 10, 2, EIGHTH_TURN, 4, 4, 6, 3, -EIGHTH_TURN))
				.toEqual(orientedBoxesOverlap(4, 4, 6, 3, -EIGHTH_TURN, 0, 0, 10, 2, EIGHTH_TURN));
		});
	});
});

describe('distances', () => {
	// Squared distances throughout, so the expectations are too.
	describe('point to segment', () => {
		it('measures straight out from the middle of a segment', () => {
			expect(pointSegmentDistanceSquared(0, 3, -5, 0, 5, 0)).toBeCloseTo(9);
		});

		it('measures from an end once the point is past it', () => {
			// 3 past the end and 4 to the side: 5 from the end, not 4 from the line.
			expect(pointSegmentDistanceSquared(8, 4, -5, 0, 5, 0)).toBeCloseTo(25);
		});

		it('is 0 for a point on the segment', () => {
			expect(pointSegmentDistanceSquared(2, 0, -5, 0, 5, 0)).toBeCloseTo(0);
		});

		it('treats a segment with no length as its own point', () => {
			expect(pointSegmentDistanceSquared(3, 4, 0, 0, 0, 0)).toBeCloseTo(25);
		});
	});

	describe('segment to segment', () => {
		it('measures two points, which is two circles', () => {
			expect(segmentSegmentDistanceSquared(0, 0, 0, 0, 3, 4, 3, 4)).toBeCloseTo(25);
		});

		it('measures parallel segments across the gap between them', () => {
			expect(segmentSegmentDistanceSquared(-5, 0, 5, 0, -5, 2, 5, 2)).toBeCloseTo(4);
		});

		it('measures parallel segments end to end when they do not overlap', () => {
			// Along the same line, 4 apart.
			expect(segmentSegmentDistanceSquared(0, 0, 10, 0, 14, 0, 24, 0)).toBeCloseTo(16);
		});

		it('is 0 for segments that cross', () => {
			expect(segmentSegmentDistanceSquared(-5, 0, 5, 0, 0, -5, 0, 5)).toBeCloseTo(0);
		});

		it('measures end to end for two segments that stop short of crossing', () => {
			// A T whose upright stops 2 short of the crossbar.
			expect(segmentSegmentDistanceSquared(-5, 0, 5, 0, 0, 2, 0, 10)).toBeCloseTo(4);
		});

		it('does not care which segment is given first', () => {
			expect(segmentSegmentDistanceSquared(0, 0, 4, 3, 7, -2, 9, 6))
				.toBeCloseTo(segmentSegmentDistanceSquared(7, -2, 9, 6, 0, 0, 4, 3));
		});
	});

	describe('segment to box', () => {
		// A 10x10 box on the origin, unturned, unless a test says otherwise.
		it('measures straight out from a face', () => {
			expect(segmentBoxDistanceSquared(-20, 7, 20, 7, 0, 0, 10, 10, 0)).toBeCloseTo(4);
		});

		it('is 0 for a segment run straight through the box', () => {
			// The case a nearest-corner search alone gets wrong: it needs the crossing test in front of it.
			expect(segmentBoxDistanceSquared(-50, 0, 50, 0, 0, 0, 10, 10, 0)).toBeCloseTo(0);
		});

		it('is 0 for a segment with an end inside the box', () => {
			expect(segmentBoxDistanceSquared(0, 0, 50, 0, 0, 0, 10, 10, 0)).toBeCloseTo(0);
		});

		it('is 0 for a segment that only grazes a face', () => {
			// On the edge counts as reaching: callers add a radius on top, so a grazing core is through the surface.
			expect(segmentBoxDistanceSquared(-20, 5, 20, 5, 0, 0, 10, 10, 0)).toBeCloseTo(0);
		});

		it('measures from a corner for a segment running past one', () => {
			expect(segmentBoxDistanceSquared(8, 8, 20, 20, 0, 0, 10, 10, 0)).toBeCloseTo(18);
		});

		it('measures a corner against the middle of a segment', () => {
			// The nearest point is the corner, mid-segment, not either end: 4 out from the face at x = 5.
			const distance = segmentBoxDistanceSquared(9, -20, 9, 20, 0, 0, 10, 10, 0);
			expect(distance).toBeCloseTo(16);
		});

		it('follows the box round as it turns', () => {
			// On its corner the square reaches ~7.07 up y, so a segment at y = 6 that missed it now hits.
			expect(segmentBoxDistanceSquared(-20, 6, 20, 6, 0, 0, 10, 10, 0)).toBeCloseTo(1);
			expect(segmentBoxDistanceSquared(-20, 6, 20, 6, 0, 0, 10, 10, EIGHTH_TURN)).toBeCloseTo(0);
		});

		it('measures a point against the box', () => {
			expect(segmentBoxDistanceSquared(8, 9, 8, 9, 0, 0, 10, 10, 0)).toBeCloseTo(25);
			expect(segmentBoxDistanceSquared(1, 2, 1, 2, 0, 0, 10, 10, 0)).toBeCloseTo(0);
		});
	});
});

describe('shapes', () => {
	describe('capsule half length', () => {
		it('takes the two caps off the length', () => {
			expect(capsuleHalfLength(40, 10)).toEqual(15);
		});

		it('collapses to nothing once it is no longer than it is wide', () => {
			expect(capsuleHalfLength(10, 10)).toEqual(0);
			expect(capsuleHalfLength(5, 10)).toEqual(0);
		});
	});

	describe('radius', () => {
		it('is half the width of a circle and half the height of a capsule', () => {
			expect(shapeRadius(SHAPE_CIRCLE, 10, 10)).toEqual(5);
			expect(shapeRadius(SHAPE_CAPSULE, 40, 10)).toEqual(5);
		});

		it('is nothing for a rectangle, whose outline is its own box', () => {
			expect(shapeRadius(SHAPE_RECTANGLE, 40, 10)).toEqual(0);
		});
	});

	describe('empty', () => {
		it('needs both sides of a rectangle', () => {
			expect(shapeIsEmpty(SHAPE_RECTANGLE, 10, 0)).toEqual(true);
			expect(shapeIsEmpty(SHAPE_RECTANGLE, 0, 10)).toEqual(true);
			expect(shapeIsEmpty(SHAPE_RECTANGLE, 10, 10)).toEqual(false);
		});

		it('needs only the width of a circle, which is all a circle has', () => {
			expect(shapeIsEmpty(SHAPE_CIRCLE, 0, 10)).toEqual(true);
			expect(shapeIsEmpty(SHAPE_CIRCLE, 10, 0)).toEqual(false);
		});

		it('needs the thickness of a capsule, however long it is', () => {
			expect(shapeIsEmpty(SHAPE_CAPSULE, 40, 0)).toEqual(true);
			expect(shapeIsEmpty(SHAPE_CAPSULE, 0, 10)).toEqual(false);
		});
	});

	describe('bounds', () => {
		it('falls back to the plain box bounds for a rectangle', () => {
			expect(shapeHalfWidth(SHAPE_RECTANGLE, 10, 4, EIGHTH_TURN)).toBeCloseTo(boundsHalfWidth(10, 4, EIGHTH_TURN));
			expect(shapeHalfHeight(SHAPE_RECTANGLE, 10, 4, EIGHTH_TURN)).toBeCloseTo(boundsHalfHeight(10, 4, EIGHTH_TURN));
		});

		it('is the radius either way for a circle, whichever way it is turned', () => {
			for(const angle of [0, EIGHTH_TURN, QUARTER_TURN, -EIGHTH_TURN]) {
				expect(shapeHalfWidth(SHAPE_CIRCLE, 10, 10, angle)).toBeCloseTo(5);
				expect(shapeHalfHeight(SHAPE_CIRCLE, 10, 10, angle)).toBeCloseTo(5);
			}
		});

		it('holds the whole length of an unturned capsule', () => {
			// 40 long, 10 thick: 20 out along its facing, 5 across.
			expect(shapeHalfWidth(SHAPE_CAPSULE, 40, 10, 0)).toBeCloseTo(20);
			expect(shapeHalfHeight(SHAPE_CAPSULE, 40, 10, 0)).toBeCloseTo(5);
		});

		it('swaps a capsule\'s two axes on a quarter turn', () => {
			expect(shapeHalfWidth(SHAPE_CAPSULE, 40, 10, QUARTER_TURN)).toBeCloseTo(5);
			expect(shapeHalfHeight(SHAPE_CAPSULE, 40, 10, QUARTER_TURN)).toBeCloseTo(20);
		});

		it('fits inside the rectangle of the same size, for the shapes a config can actually describe', () => {
			// A capsule or radius-loaded circle is that rectangle with its ends rounded off, so it needs no more room.
			for(const angle of [0, EIGHTH_TURN, QUARTER_TURN, -EIGHTH_TURN]) {
				expect(shapeHalfWidth(SHAPE_CAPSULE, 40, 10, angle)).toBeLessThanOrEqual(boundsHalfWidth(40, 10, angle) + 1e-9);
				expect(shapeHalfHeight(SHAPE_CAPSULE, 40, 10, angle)).toBeLessThanOrEqual(boundsHalfHeight(40, 10, angle) + 1e-9);
				expect(shapeHalfWidth(SHAPE_CIRCLE, 10, 10, angle)).toBeLessThanOrEqual(boundsHalfWidth(10, 10, angle) + 1e-9);
				expect(shapeHalfHeight(SHAPE_CIRCLE, 10, 10, angle)).toBeLessThanOrEqual(boundsHalfHeight(10, 10, angle) + 1e-9);
			}
		});

		it('holds a circle whose width and height disagree, rather than trusting the height', () => {
			// A circle is its width, so one with a smaller height is still as tall as it is wide.
			expect(shapeHalfHeight(SHAPE_CIRCLE, 40, 10, 0)).toBeCloseTo(20);
			expect(shapeHalfHeight(SHAPE_CIRCLE, 40, 10, 0)).toBeGreaterThan(boundsHalfHeight(40, 10, 0));
		});
	});

	describe('overlaps', () => {
		it('still tests two rectangles the way it always did', () => {
			expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_RECTANGLE, 9.99, 0, 10, 10, 0)).toEqual(true);
			expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_RECTANGLE, 10, 0, 10, 10, 0)).toEqual(false);
		});

		describe('circle to circle', () => {
			it('meets when the centres are closer than the two radii', () => {
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 9.99, 0, 10, 10, 0)).toEqual(true);
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 10, 0, 10, 10, 0)).toEqual(false);
			});

			it('rounds off the corner a rectangle of the same size would have', () => {
				// Offset far enough that two boxes would still overlap at the corner, while two circles have parted.
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 8, 8, 10, 10, 0)).toEqual(false);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_RECTANGLE, 8, 8, 10, 10, 0)).toEqual(true);
			});

			it('takes no notice of the angle', () => {
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 10, 10, EIGHTH_TURN, SHAPE_CIRCLE, 9.99, 0, 10, 10, QUARTER_TURN)).toEqual(true);
			});
		});

		describe('capsule to capsule', () => {
			it('meets end to end once the two caps touch', () => {
				// 40 long, 10 thick: each core runs 15 either way, the caps reach 5 past that.
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CAPSULE, 39.99, 0, 40, 10, 0)).toEqual(true);
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CAPSULE, 40, 0, 40, 10, 0)).toEqual(false);
			});

			it('meets side by side across their thickness', () => {
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CAPSULE, 0, 9.99, 40, 10, 0)).toEqual(true);
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CAPSULE, 0, 10, 40, 10, 0)).toEqual(false);
			});

			it('crosses one laid over the other', () => {
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CAPSULE, 0, 0, 40, 10, QUARTER_TURN)).toEqual(true);
			});

			it('reaches along the way it is turned', () => {
				// Upright it no longer reaches along x, but it does up y.
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CAPSULE, 30, 0, 40, 10, QUARTER_TURN)).toEqual(false);
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, QUARTER_TURN, SHAPE_CAPSULE, 0, 30, 40, 10, QUARTER_TURN)).toEqual(true);
			});

			it('behaves as a circle once it is no longer than it is wide', () => {
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 9.99, 0, 10, 10, 0)).toEqual(true);
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 10, 0, 10, 10, 0)).toEqual(false);
			});
		});

		describe('circle to capsule', () => {
			it('meets across the capsule\'s side', () => {
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CIRCLE, 0, 5.99, 2, 2, 0)).toEqual(true);
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CIRCLE, 0, 6, 2, 2, 0)).toEqual(false);
			});

			it('meets past the capsule\'s cap', () => {
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CIRCLE, 20.99, 0, 2, 2, 0)).toEqual(true);
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CIRCLE, 21, 0, 2, 2, 0)).toEqual(false);
			});

			it('follows the capsule as it turns', () => {
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, QUARTER_TURN, SHAPE_CIRCLE, 5.99, 0, 2, 2, 0)).toEqual(true);
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, QUARTER_TURN, SHAPE_CIRCLE, 0, 20.99, 2, 2, 0)).toEqual(true);
			});
		});

		describe('rectangle to circle', () => {
			it('meets straight out from a face', () => {
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 5.99, 0, 2, 2, 0)).toEqual(true);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 6, 0, 2, 2, 0)).toEqual(false);
			});

			it('rounds off the box\'s corner', () => {
				// Past the corner: a 2x2 box would still overlap, a circle has parted - the case a face-only test misses.
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 5.9, 5.9, 2, 2, 0)).toEqual(false);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_RECTANGLE, 5.9, 5.9, 2, 2, 0)).toEqual(true);
			});

			it('swallows a circle sitting inside it', () => {
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 1, 1, 2, 2, 0)).toEqual(true);
			});

			it('follows the box round as it turns', () => {
				// On its corner the square reaches ~7.07 up y, so a circle that missed it now hits.
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 0, 6.5, 2, 2, 0)).toEqual(false);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, EIGHTH_TURN, SHAPE_CIRCLE, 0, 6.5, 2, 2, 0)).toEqual(true);
			});
		});

		describe('rectangle to capsule', () => {
			it('meets straight out from a face', () => {
				// The capsule is 2 thick, so its side reaches 1 below centre; the box's top face is at y = 5.
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 0, 5.99, 40, 2, 0)).toEqual(true);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 0, 6, 40, 2, 0)).toEqual(false);
			});

			it('meets a capsule run straight through it', () => {
				// The crossing case: both ends far outside, every corner off the core.
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 0, 0, 100, 2, 0)).toEqual(true);
			});

			it('meets a capsule whose cap reaches in past a corner', () => {
				// Along the diagonal: the near end's 2 radius has to cover the gap to the box's corner at (5, 5).
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 12, 12, 20, 4, EIGHTH_TURN)).toEqual(true);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 14, 14, 20, 4, EIGHTH_TURN)).toEqual(false);
			});

			it('reaches only as far as the way it is turned', () => {
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 24, 0, 40, 2, 0)).toEqual(true);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 24, 0, 40, 2, QUARTER_TURN)).toEqual(false);
			});
		});

		describe('shapes with no area', () => {
			it('never overlaps a circle with no width', () => {
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 0, 0, 0, SHAPE_RECTANGLE, 0, 0, 10, 10, 0)).toEqual(false);
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 0, 0, 0, SHAPE_CIRCLE, 0, 0, 10, 10, 0)).toEqual(false);
			});

			it('never overlaps a capsule with no thickness', () => {
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 0, 0, SHAPE_RECTANGLE, 0, 0, 10, 10, 0)).toEqual(false);
			});

			it('still overlaps a circle whose height was never set', () => {
				// A circle is its width, so a height of 0 says nothing; a shape-blind check would drop this one.
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 10, 0, 0, SHAPE_RECTANGLE, 0, 0, 10, 10, 0)).toEqual(true);
			});
		});
	});
});
