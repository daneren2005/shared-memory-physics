// Geometry for the shapes a transform plus a body describe, all of them centred on (x, y) and turned `angle`
// radians counter-clockwise.  Everything here is pure number math on loose arguments rather than objects, so
// the collision sweep can call it per pair without allocating.
//
// The three shapes are one idea in three settings: **an oriented core, grown by a radius**.
//
//   rectangle - a width x height box,        radius 0
//   circle    - a point,                     radius width / 2
//   capsule   - a segment along its facing,  radius height / 2
//
// A circle is just a capsule whose segment has no length, so there are only two kinds of core - a box and a
// segment - and therefore only three pair tests rather than one per combination of shapes.  See shapesOverlap.

import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '../components/body-component';

// How far a capsule's core segment reaches from the centre, along the direction it faces.  The caps are part
// of the length, so a 40 x 10 capsule is 40 from end to end: 15 of segment either way plus a 5 radius cap.
//
// Clamped at 0, so a capsule told to be shorter than it is wide collapses to a circle of its own width rather
// than turning itself inside out.
export function capsuleHalfLength(width: number, height: number): number {
	return Math.max(0, (width - height) / 2);
}

// The radius of a shape's cap: half the diameter for a circle, half the thickness for a capsule, and nothing
// at all for a rectangle, whose outline is its core.
//
// A circle takes its diameter from `width` and ignores `height` - loading one from a `radius` config sets both
// to the same thing, so the two only ever disagree if a game writes the block itself.
export function shapeRadius(shape: number, width: number, height: number): number {
	if(shape === SHAPE_CIRCLE) {
		return width / 2;
	} else if(shape === SHAPE_CAPSULE) {
		return height / 2;
	}

	return 0;
}

// Whether a shape encloses no area at all, and so can never overlap anything - not even something sitting
// exactly on top of it.  This is what keeps an entity the game never gave a size out of collisions, and which
// of the two sizes matters depends on the shape: a circle is nothing without its width, while a capsule with
// no thickness is a bare line however long it is.
export function shapeIsEmpty(shape: number, width: number, height: number): boolean {
	if(shape === SHAPE_CIRCLE) {
		return width <= 0;
	} else if(shape === SHAPE_CAPSULE) {
		return height <= 0;
	}

	return width <= 0 || height <= 0;
}

// Half the width of the *axis aligned* box that fully contains a shape, whatever it is turned to - the box the
// broadphase indexes it under, so it has to hold the whole shape or the tree would rule out its own candidates.
//
// A capsule always fits inside the rectangle its width and height describe, being that rectangle with its ends
// rounded off, and so does a circle loaded from a `radius` (whose width and height agree).  A circle is its
// *width* alone though, so one whose height was written smaller by hand is taller than that rectangle - which is
// why this is asked per shape rather than measured off the rectangle and trusted for everything.
export function shapeHalfWidth(shape: number, width: number, height: number, angle: number): number {
	if(shape === SHAPE_CIRCLE) {
		// A circle covers the same ground whichever way it is turned.
		return width / 2;
	} else if(shape === SHAPE_CAPSULE) {
		return Math.abs(Math.cos(angle)) * capsuleHalfLength(width, height) + height / 2;
	}

	return boundsHalfWidth(width, height, angle);
}
// The same for the y axis: the capsule's segment leans the other way, and the circle is still a circle.
export function shapeHalfHeight(shape: number, width: number, height: number, angle: number): number {
	if(shape === SHAPE_CIRCLE) {
		return width / 2;
	} else if(shape === SHAPE_CAPSULE) {
		return Math.abs(Math.sin(angle)) * capsuleHalfLength(width, height) + height / 2;
	}

	return boundsHalfHeight(width, height, angle);
}

// Whether two shapes of any kind overlap.
//
// Because a circle is a capsule with no length, every pair falls into one of three cases, picked by a switch
// over the two shape constants with no indirection in the way:
//
//   rectangle + rectangle - two boxes with no radius between them, which is the separating axis test below
//   round     + round     - the gap between the two core segments has to be under the two radii added together
//   rectangle + round     - the gap between the core segment and the box has to be under the one radius
//
// Touching exactly counts as *not* overlapping in all three, matching orientedBoxesOverlap: the comparisons
// are strict, so a capsule whose cap grazes a wall has not hit it.
export function shapesOverlap(
	aShape: number, aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
): boolean {
	if(shapeIsEmpty(aShape, aWidth, aHeight) || shapeIsEmpty(bShape, bWidth, bHeight)) {
		return false;
	}

	const aIsRound = aShape !== SHAPE_RECTANGLE;
	const bIsRound = bShape !== SHAPE_RECTANGLE;

	if(!aIsRound && !bIsRound) {
		return orientedBoxesOverlap(aX, aY, aWidth, aHeight, aAngle, bX, bY, bWidth, bHeight, bAngle);
	} else if(aIsRound && !bIsRound) {
		// Overlapping is the same relation whichever way round it is asked, so the one mixed case is written once
		// with the box first and reached from the other side by swapping.
		return shapesOverlap(
			bShape, bX, bY, bWidth, bHeight, bAngle,
			aShape, aX, aY, aWidth, aHeight, aAngle,
		);
	}

	// b is round either way from here, so take its core segment now.
	const bHalf = coreHalfLength(bShape, bWidth, bHeight);
	const bCos = Math.cos(bAngle) * bHalf;
	const bSin = Math.sin(bAngle) * bHalf;
	const bRadius = shapeRadius(bShape, bWidth, bHeight);

	if(!aIsRound) {
		return segmentBoxDistanceSquared(
			bX - bCos, bY - bSin, bX + bCos, bY + bSin,
			aX, aY, aWidth, aHeight, aAngle,
		) < bRadius * bRadius;
	}

	const aHalf = coreHalfLength(aShape, aWidth, aHeight);
	const aCos = Math.cos(aAngle) * aHalf;
	const aSin = Math.sin(aAngle) * aHalf;
	const reach = shapeRadius(aShape, aWidth, aHeight) + bRadius;

	return segmentSegmentDistanceSquared(
		aX - aCos, aY - aSin, aX + aCos, aY + aSin,
		bX - bCos, bY - bSin, bX + bCos, bY + bSin,
	) < reach * reach;
}

// How far a shape's core reaches from its centre along the direction it faces: a capsule's segment, and nothing
// for a circle (a point) or a rectangle (whose core is the whole box, handled separately).
function coreHalfLength(shape: number, width: number, height: number): number {
	return shape === SHAPE_CAPSULE ? capsuleHalfLength(width, height) : 0;
}

// Half the width of the *axis aligned* box that fully contains a rotated one.  Turning a rectangle widens the
// footprint it needs: each of its two sides contributes however much of itself now points along the x axis.
// At angle 0 this is just width / 2, and at a quarter turn it is height / 2.
export function boundsHalfWidth(width: number, height: number, angle: number): number {
	return (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height) / 2;
}
// The same for the y axis, with the two sides' contributions swapped.
export function boundsHalfHeight(width: number, height: number, angle: number): number {
	return (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height) / 2;
}

// Whether two rotated boxes overlap, by the separating axis theorem: two convex shapes miss each other if and
// only if some axis exists that their projections do not both cover.  For a pair of boxes only four axes can
// ever be that axis - the two each box's own sides face along - so testing those four settles it.
//
// Touching exactly counts as *not* overlapping: the projections meet but do not cross.  A box with no area
// never overlaps anything either, even sitting inside another one - it collapses to a point or a line, and
// the theorem has nothing to separate.  Together those are what keeps an entity the game never gave a size
// out of collisions entirely.
export function orientedBoxesOverlap(
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
): boolean {
	if(aWidth <= 0 || aHeight <= 0 || bWidth <= 0 || bHeight <= 0) {
		return false;
	}

	const aCos = Math.cos(aAngle);
	const aSin = Math.sin(aAngle);
	const bCos = Math.cos(bAngle);
	const bSin = Math.sin(bAngle);

	const aHalfWidth = aWidth / 2;
	const aHalfHeight = aHeight / 2;
	const bHalfWidth = bWidth / 2;
	const bHalfHeight = bHeight / 2;

	// Everything is measured relative to a's centre, so only the offset between the two centres matters.
	const offsetX = bX - aX;
	const offsetY = bY - aY;

	// a's own two axes, then b's.  Each box's sides face along (cos, sin) and (-sin, cos) of its angle.
	return !separatedAlong(aCos, aSin, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin)
		&& !separatedAlong(-aSin, aCos, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin)
		&& !separatedAlong(bCos, bSin, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin)
		&& !separatedAlong(-bSin, bCos, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin);
}

// Whether the two boxes' shadows on the axis (axisX, axisY) fail to reach each other.  A box's shadow reaches
// out from its centre by however far its own two half-sides project onto the axis, so the pair is separated
// when the gap between the centres along that axis is at least the two reaches added together.
//
// The axes passed in are always a box's own sides, which are unit vectors, so the dot products below are
// already true distances and nothing needs normalising.
function separatedAlong(
	axisX: number, axisY: number,
	offsetX: number, offsetY: number,
	aHalfWidth: number, aHalfHeight: number, aCos: number, aSin: number,
	bHalfWidth: number, bHalfHeight: number, bCos: number, bSin: number,
): boolean {
	const aReach = aHalfWidth * Math.abs(aCos * axisX + aSin * axisY) + aHalfHeight * Math.abs(-aSin * axisX + aCos * axisY);
	const bReach = bHalfWidth * Math.abs(bCos * axisX + bSin * axisY) + bHalfHeight * Math.abs(-bSin * axisX + bCos * axisY);

	return Math.abs(offsetX * axisX + offsetY * axisY) >= aReach + bReach;
}

// The squared distance between two line segments, each given as its two end points.  Squared because that is
// all the callers need - comparing it against a squared radius avoids a square root per pair.
//
// This is what settles every pair of round shapes: two capsules are their two segments grown by a radius each,
// so they meet exactly when the segments come within the two radii of one another.  A circle is a segment whose
// ends are the same point, which this handles as the degenerate case rather than as a shape of its own.
//
// Walks the usual closest-point-between-segments argument: solve for the closest points on the two infinite
// lines, then clamp back into the segments, re-solving the other parameter each time a clamp moves one.  The
// parallel case has no single solution, so it pins one end and lets the clamping find the rest.
export function segmentSegmentDistanceSquared(
	aX1: number, aY1: number, aX2: number, aY2: number,
	bX1: number, bY1: number, bX2: number, bY2: number,
): number {
	const aDeltaX = aX2 - aX1;
	const aDeltaY = aY2 - aY1;
	const bDeltaX = bX2 - bX1;
	const bDeltaY = bY2 - bY1;
	const offsetX = aX1 - bX1;
	const offsetY = aY1 - bY1;

	const aLength = aDeltaX * aDeltaX + aDeltaY * aDeltaY;
	const bLength = bDeltaX * bDeltaX + bDeltaY * bDeltaY;
	const bOffset = bDeltaX * offsetX + bDeltaY * offsetY;

	let aParam = 0;
	let bParam = 0;
	if(aLength <= 0 && bLength <= 0) {
		// Two points - which is two circles, the most common pair of all.
		return offsetX * offsetX + offsetY * offsetY;
	} else if(aLength <= 0) {
		// A circle against a capsule: only where it lands along the capsule's segment matters.
		bParam = clamp(bOffset / bLength);
	} else {
		const aOffset = aDeltaX * offsetX + aDeltaY * offsetY;
		if(bLength <= 0) {
			aParam = clamp(-aOffset / aLength);
		} else {
			const along = aDeltaX * bDeltaX + aDeltaY * bDeltaY;
			// Zero exactly when the two segments are parallel, which is where pinning aParam at 0 comes in: every
			// point along one is the same distance from the other, so any of them is as good an answer.
			const denominator = aLength * bLength - along * along;
			if(denominator !== 0) {
				aParam = clamp((along * bOffset - aOffset * bLength) / denominator);
			}

			bParam = (along * aParam + bOffset) / bLength;
			// Clamping bParam moves the closest point on b, so where it sits along a has to be solved again.
			if(bParam < 0) {
				bParam = 0;
				aParam = clamp(-aOffset / aLength);
			} else if(bParam > 1) {
				bParam = 1;
				aParam = clamp((along - aOffset) / aLength);
			}
		}
	}

	const gapX = (aX1 + aDeltaX * aParam) - (bX1 + bDeltaX * bParam);
	const gapY = (aY1 + aDeltaY * aParam) - (bY1 + bDeltaY * bParam);

	return gapX * gapX + gapY * gapY;
}

// The squared distance between a line segment and a rotated box.  This is what settles a rectangle against a
// circle or a capsule: the round shape is its segment grown by a radius, so it reaches the box exactly when the
// segment comes within that radius of it.
//
// Measured in the box's own frame, where it is axis aligned and the whole thing reduces to a segment against a
// rectangle sitting at the origin.  Two disjoint convex shapes always have their closest pair at a corner of
// one against the other, so once the crossing case is out of the way the answer is the nearest of: each end of
// the segment to the box, and each corner of the box to the segment.
export function segmentBoxDistanceSquared(
	x1: number, y1: number, x2: number, y2: number,
	boxX: number, boxY: number, boxWidth: number, boxHeight: number, boxAngle: number,
): number {
	const cos = Math.cos(boxAngle);
	const sin = Math.sin(boxAngle);
	const halfWidth = boxWidth / 2;
	const halfHeight = boxHeight / 2;

	// Both ends into the box's frame, so the box becomes the rectangle from (-halfWidth, -halfHeight) to
	// (halfWidth, halfHeight).
	const firstOffsetX = x1 - boxX;
	const firstOffsetY = y1 - boxY;
	const secondOffsetX = x2 - boxX;
	const secondOffsetY = y2 - boxY;
	const localX1 = firstOffsetX * cos + firstOffsetY * sin;
	const localY1 = -firstOffsetX * sin + firstOffsetY * cos;
	const localX2 = secondOffsetX * cos + secondOffsetY * sin;
	const localY2 = -secondOffsetX * sin + secondOffsetY * cos;

	// The crossing case has to be caught on its own: a segment straight through the middle of the box has both
	// its ends outside it and every corner some way off, so the nearest-pair search below would report a real
	// distance for two shapes that are already through each other.
	if(!segmentMissesBox(localX1, localY1, localX2, localY2, halfWidth, halfHeight)) {
		return 0;
	}

	return Math.min(
		// Each end of the segment against the box...
		pointBoxDistanceSquared(localX1, localY1, halfWidth, halfHeight),
		pointBoxDistanceSquared(localX2, localY2, halfWidth, halfHeight),
		// ...and each corner of the box against the segment, which is where a segment running past a box at an
		// angle comes closest to it.
		pointSegmentDistanceSquared(-halfWidth, -halfHeight, localX1, localY1, localX2, localY2),
		pointSegmentDistanceSquared(halfWidth, -halfHeight, localX1, localY1, localX2, localY2),
		pointSegmentDistanceSquared(halfWidth, halfHeight, localX1, localY1, localX2, localY2),
		pointSegmentDistanceSquared(-halfWidth, halfHeight, localX1, localY1, localX2, localY2),
	);
}

// The squared distance from a point to a line segment: how far along the segment the point falls, clamped to
// its ends, and then the gap from there.
export function pointSegmentDistanceSquared(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
	const deltaX = x2 - x1;
	const deltaY = y2 - y1;
	const length = deltaX * deltaX + deltaY * deltaY;

	// A segment with no length is just its own start point.
	const along = length > 0 ? clamp(((x - x1) * deltaX + (y - y1) * deltaY) / length) : 0;
	const gapX = x - (x1 + deltaX * along);
	const gapY = y - (y1 + deltaY * along);

	return gapX * gapX + gapY * gapY;
}

// Whether an axis aligned box at the origin and a segment fail to reach each other, by the same separating axis
// argument as orientedBoxesOverlap: the box's own two axes, plus the one the segment faces along.  Touching
// exactly counts as reaching, so a grazing segment is measured as 0 away rather than as a near miss.
function segmentMissesBox(x1: number, y1: number, x2: number, y2: number, halfWidth: number, halfHeight: number): boolean {
	if(Math.max(x1, x2) < -halfWidth || Math.min(x1, x2) > halfWidth) {
		return true;
	} else if(Math.max(y1, y2) < -halfHeight || Math.min(y1, y2) > halfHeight) {
		return true;
	}

	// The segment's own axis.  Both of its ends project to the same place on the normal, so one is enough - and
	// for a segment with no length the normal is (0, 0), which never separates and correctly leaves the two box
	// axes above to decide whether the point is inside.
	const normalX = -(y2 - y1);
	const normalY = x2 - x1;

	return Math.abs(normalX * x1 + normalY * y1) > halfWidth * Math.abs(normalX) + halfHeight * Math.abs(normalY);
}

// The squared distance from a point to an axis aligned box at the origin: clamp the point onto the box and
// measure what is left over.  0 for a point inside it.
function pointBoxDistanceSquared(x: number, y: number, halfWidth: number, halfHeight: number): number {
	const gapX = Math.abs(x) - halfWidth;
	const gapY = Math.abs(y) - halfHeight;
	const outsideX = gapX > 0 ? gapX : 0;
	const outsideY = gapY > 0 ? gapY : 0;

	return outsideX * outsideX + outsideY * outsideY;
}

function clamp(value: number): number {
	if(value < 0) {
		return 0;
	} else if(value > 1) {
		return 1;
	}

	return value;
}
