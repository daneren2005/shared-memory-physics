import {
	boundsHalfHeight, boundsHalfWidth, orientedBoxesOverlap,
	capsuleHalfLength, shapeHalfHeight, shapeHalfWidth, shapeIsEmpty, shapeRadius, shapesOverlap,
	pointSegmentDistanceSquared, segmentBoxDistanceSquared, segmentSegmentDistanceSquared,
} from '../shapes';
import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '../../components/body-component';

const QUARTER_TURN = Math.PI / 2;
const EIGHTH_TURN = Math.PI / 4;

// Every pair of shapes is checked from both sides: overlapping is one relation, and the mixed cases reach the
// same test by swapping their arguments, so the two directions have to agree.
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
			// A 10x10 square on its corner is as wide as its own diagonal.
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
			// Edges meet exactly at x = 5.
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 10, 0, 10, 10, 0)).toEqual(false);
			// A hair closer and they do.
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 9.99, 0, 10, 10, 0)).toEqual(true);
		});

		it('never overlaps a box with no size, even sitting inside another one', () => {
			expect(orientedBoxesOverlap(0, 0, 0, 0, 0, 0, 0, 10, 10, 0)).toEqual(false);
			expect(orientedBoxesOverlap(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)).toEqual(false);
			// A box with only one of its two sides is just as degenerate.
			expect(orientedBoxesOverlap(0, 0, 10, 0, 0, 0, 0, 10, 10, 0)).toEqual(false);
		});

		it('measures from the centre of each box, not a corner', () => {
			// Two 10 wide boxes 8 apart overlap by 2 measured centre to centre; from a top left corner they would
			// not touch at all.
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 8, 0, 10, 10, 0)).toEqual(true);
		});

		it('reaches further once a box is turned', () => {
			// A 10x2 bar and a 2x10 bar, 5 apart on x: unturned they miss...
			expect(orientedBoxesOverlap(0, 0, 2, 10, 0, 5, 0, 2, 10, 0)).toEqual(false);
			// ...but turning the second onto its side puts its long edge across the gap.
			expect(orientedBoxesOverlap(0, 0, 2, 10, 0, 5, 0, 2, 10, QUARTER_TURN)).toEqual(true);
		});

		it('finds a corner-on overlap neither box\'s own axes would show', () => {
			// Two squares on their corners, offset diagonally so only their points meet.  A test that just
			// compared the boxes' containing bounds would say they overlap well before this.
			expect(orientedBoxesOverlap(0, 0, 10, 10, EIGHTH_TURN, 7, 0, 10, 10, EIGHTH_TURN)).toEqual(true);
			expect(orientedBoxesOverlap(0, 0, 10, 10, EIGHTH_TURN, 15, 0, 10, 10, EIGHTH_TURN)).toEqual(false);
		});

		it('rules out a turned box whose containing bounds still overlap', () => {
			// The 10x10 square on its corner spans about 7.07 either way, so its bounds reach the second box - but
			// the corner nearest it does not.
			expect(orientedBoxesOverlap(0, 0, 10, 10, EIGHTH_TURN, 6.5, 6.5, 2, 2, 0)).toEqual(false);
			// Straighten the same square out and its flat side does reach.
			expect(orientedBoxesOverlap(0, 0, 10, 10, 0, 5.5, 5.5, 2, 2, 0)).toEqual(true);
		});

		it('does not care which box is given first', () => {
			expect(orientedBoxesOverlap(0, 0, 10, 2, EIGHTH_TURN, 4, 4, 6, 3, -EIGHTH_TURN))
				.toEqual(orientedBoxesOverlap(4, 4, 6, 3, -EIGHTH_TURN, 0, 0, 10, 2, EIGHTH_TURN));
		});
	});
});

describe('distances', () => {
	// The building blocks the round shapes are measured with.  Squared throughout, so the expectations are too.
	describe('point to segment', () => {
		it('measures straight out from the middle of a segment', () => {
			expect(pointSegmentDistanceSquared(0, 3, -5, 0, 5, 0)).toBeCloseTo(9);
		});

		it('measures from an end once the point is past it', () => {
			// 3 beyond the end and 4 to the side, so 5 away from the end itself rather than 4 from the line.
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
			// Along the same line, 4 apart: nothing about being parallel should stop the ends being found.
			expect(segmentSegmentDistanceSquared(0, 0, 10, 0, 14, 0, 24, 0)).toBeCloseTo(16);
		});

		it('is 0 for segments that cross', () => {
			expect(segmentSegmentDistanceSquared(-5, 0, 5, 0, 0, -5, 0, 5)).toBeCloseTo(0);
		});

		it('measures end to end for two segments that stop short of crossing', () => {
			// A T that does not quite meet: the upright stops 2 short of the crossbar.
			expect(segmentSegmentDistanceSquared(-5, 0, 5, 0, 0, 2, 0, 10)).toBeCloseTo(4);
		});

		it('does not care which segment is given first', () => {
			expect(segmentSegmentDistanceSquared(0, 0, 4, 3, 7, -2, 9, 6))
				.toBeCloseTo(segmentSegmentDistanceSquared(7, -2, 9, 6, 0, 0, 4, 3));
		});
	});

	describe('segment to box', () => {
		// A 10x10 box on the origin, unturned, for everything that does not say otherwise.
		it('measures straight out from a face', () => {
			expect(segmentBoxDistanceSquared(-20, 7, 20, 7, 0, 0, 10, 10, 0)).toBeCloseTo(4);
		});

		it('is 0 for a segment run straight through the box', () => {
			// Both ends are well outside and every corner is 5 off the segment, so this is the case the nearest
			// corner search alone would get wrong - it needs the crossing test in front of it.
			expect(segmentBoxDistanceSquared(-50, 0, 50, 0, 0, 0, 10, 10, 0)).toBeCloseTo(0);
		});

		it('is 0 for a segment with an end inside the box', () => {
			expect(segmentBoxDistanceSquared(0, 0, 50, 0, 0, 0, 10, 10, 0)).toBeCloseTo(0);
		});

		it('is 0 for a segment that only grazes a face', () => {
			// Exactly on the edge counts as reaching it: the shapes that use this add a radius on top, so a
			// grazing core is already through the surface.
			expect(segmentBoxDistanceSquared(-20, 5, 20, 5, 0, 0, 10, 10, 0)).toBeCloseTo(0);
		});

		it('measures from a corner for a segment running past one', () => {
			// A segment ending short of the box's top right corner, out along the diagonal.
			expect(segmentBoxDistanceSquared(8, 8, 20, 20, 0, 0, 10, 10, 0)).toBeCloseTo(18);
		});

		it('measures a corner against the middle of a segment', () => {
			// A steep segment sweeping past the corner, so the closest point is somewhere along it rather than at
			// either end - and it is the corner, not the segment's ends, that is nearest.
			const distance = segmentBoxDistanceSquared(9, -20, 9, 20, 0, 0, 10, 10, 0);

			// 4 out from the face at x = 5, level with it.
			expect(distance).toBeCloseTo(16);
		});

		it('follows the box round as it turns', () => {
			// The same square on its corner reaches about 7.07 up the y axis rather than 5, so a segment at y = 6
			// that missed it unturned is through it once it is turned.
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
	// A capsule is `width` from end to end and `height` thick, so its core segment is what is left of its length
	// once both caps are taken off.
	describe('capsule half length', () => {
		it('takes the two caps off the length', () => {
			expect(capsuleHalfLength(40, 10)).toEqual(15);
		});

		it('collapses to nothing once it is no longer than it is wide', () => {
			expect(capsuleHalfLength(10, 10)).toEqual(0);
			// Shorter than it is wide is a config that cannot be honoured; it becomes a circle rather than turning
			// itself inside out.
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
			// A circle takes no notice of its height, so a missing one does not make it empty.
			expect(shapeIsEmpty(SHAPE_CIRCLE, 10, 0)).toEqual(false);
		});

		it('needs the thickness of a capsule, however long it is', () => {
			expect(shapeIsEmpty(SHAPE_CAPSULE, 40, 0)).toEqual(true);
			// No length just leaves a circle of its own thickness.
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
			// 40 from end to end and 10 thick, so 20 out along the way it faces and 5 across it.
			expect(shapeHalfWidth(SHAPE_CAPSULE, 40, 10, 0)).toBeCloseTo(20);
			expect(shapeHalfHeight(SHAPE_CAPSULE, 40, 10, 0)).toBeCloseTo(5);
		});

		it('swaps a capsule\'s two axes on a quarter turn', () => {
			expect(shapeHalfWidth(SHAPE_CAPSULE, 40, 10, QUARTER_TURN)).toBeCloseTo(5);
			expect(shapeHalfHeight(SHAPE_CAPSULE, 40, 10, QUARTER_TURN)).toBeCloseTo(20);
		});

		it('fits inside the rectangle of the same size, for the shapes a config can actually describe', () => {
			// A capsule is the rectangle it is written as with its ends rounded off, and a circle - which a config
			// only ever gives as a radius, so its width and height agree - is the square it is written as with all
			// four rounded off.  Neither needs more room than that rectangle, whatever it is turned to.
			for(const angle of [0, EIGHTH_TURN, QUARTER_TURN, -EIGHTH_TURN]) {
				expect(shapeHalfWidth(SHAPE_CAPSULE, 40, 10, angle)).toBeLessThanOrEqual(boundsHalfWidth(40, 10, angle) + 1e-9);
				expect(shapeHalfHeight(SHAPE_CAPSULE, 40, 10, angle)).toBeLessThanOrEqual(boundsHalfHeight(40, 10, angle) + 1e-9);
				expect(shapeHalfWidth(SHAPE_CIRCLE, 10, 10, angle)).toBeLessThanOrEqual(boundsHalfWidth(10, 10, angle) + 1e-9);
				expect(shapeHalfHeight(SHAPE_CIRCLE, 10, 10, angle)).toBeLessThanOrEqual(boundsHalfHeight(10, 10, angle) + 1e-9);
			}
		});

		it('holds a circle whose width and height disagree, rather than trusting the height', () => {
			// A circle is its width and nothing else, so one whose height was left smaller is still as tall as it is
			// wide - and the box it is indexed under has to be too, or the tree would cut off its own candidates.
			expect(shapeHalfHeight(SHAPE_CIRCLE, 40, 10, 0)).toBeCloseTo(20);
			expect(shapeHalfHeight(SHAPE_CIRCLE, 40, 10, 0)).toBeGreaterThan(boundsHalfHeight(40, 10, 0));
		});
	});

	// Every combination of the three shapes, each checked from both sides through the `overlaps` helper above.
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
				// Diagonally offset far enough that the corners of two 10x10 boxes would still be through each
				// other, while two circles of the same width have already come apart.
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 8, 8, 10, 10, 0)).toEqual(false);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_RECTANGLE, 8, 8, 10, 10, 0)).toEqual(true);
			});

			it('takes no notice of the angle', () => {
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 10, 10, EIGHTH_TURN, SHAPE_CIRCLE, 9.99, 0, 10, 10, QUARTER_TURN)).toEqual(true);
			});
		});

		describe('capsule to capsule', () => {
			it('meets end to end once the two caps touch', () => {
				// 40 long and 10 thick, so each core segment runs 15 either way and the caps reach 5 past that.
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
				// Turned upright, the same capsule no longer reaches along x...
				expect(overlaps(SHAPE_CAPSULE, 0, 0, 40, 10, 0, SHAPE_CAPSULE, 30, 0, 40, 10, QUARTER_TURN)).toEqual(false);
				// ...but it does reach up y instead.
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
				// Out past the corner far enough that a 2x2 box would still be through it, while a circle of the
				// same width has come apart - the corner is the case a face-only test would get wrong.
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 5.9, 5.9, 2, 2, 0)).toEqual(false);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_RECTANGLE, 5.9, 5.9, 2, 2, 0)).toEqual(true);
			});

			it('swallows a circle sitting inside it', () => {
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 1, 1, 2, 2, 0)).toEqual(true);
			});

			it('follows the box round as it turns', () => {
				// On its corner the square reaches about 7.07 up y rather than 5, so a circle that missed it now
				// meets it.
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CIRCLE, 0, 6.5, 2, 2, 0)).toEqual(false);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, EIGHTH_TURN, SHAPE_CIRCLE, 0, 6.5, 2, 2, 0)).toEqual(true);
			});
		});

		describe('rectangle to capsule', () => {
			it('meets straight out from a face', () => {
				// The capsule is 2 thick, so its side reaches 1 below its centre and the box's top face is at y = 5.
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 0, 5.99, 40, 2, 0)).toEqual(true);
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 0, 6, 40, 2, 0)).toEqual(false);
			});

			it('meets a capsule run straight through it', () => {
				// Both of the capsule's ends are far outside the box and every corner is 5 off its core, so this is
				// the case that needs the crossing test rather than the nearest corner.
				expect(overlaps(SHAPE_RECTANGLE, 0, 0, 10, 10, 0, SHAPE_CAPSULE, 0, 0, 100, 2, 0)).toEqual(true);
			});

			it('meets a capsule whose cap reaches in past a corner', () => {
				// Lying out along the diagonal, 20 long and 4 thick: its core stops 8 short of its centre, so the near
				// end sits at (centre - 5.66, centre - 5.66) and its 2 radius has to cover what is left to the box's
				// corner at (5, 5).
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
				// A circle is its width, so a height of 0 says nothing about it - a shape-blind check on both sides
				// would drop this one.
				expect(overlaps(SHAPE_CIRCLE, 0, 0, 10, 0, 0, SHAPE_RECTANGLE, 0, 0, 10, 10, 0)).toEqual(true);
			});
		});
	});
});
