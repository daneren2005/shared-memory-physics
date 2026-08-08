// Pure geometry for the shapes a transform plus a body describe, centred on (x, y) and turned `angle` radians
// counter-clockwise. Loose number arguments rather than objects so the collision sweep can call per pair
// without allocating.
//
// The three shapes are one idea: an oriented core grown by a radius.
//   rectangle - a width x height box,       radius 0
//   circle    - a point,                    radius width / 2
//   capsule   - a segment along its facing, radius height / 2
// A circle is a capsule whose segment has no length, so there are only two core kinds - box and segment - and
// three pair tests rather than one per shape combination. See shapesOverlap.

import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '../components/body-component';

export interface Vector {
	x: number
	y: number
}

// Scratch, reused rather than allocated: every user is a single unbroken pass, never re-entered part way through.
const GAP: Vector = { x: 0, y: 0 };
const CANDIDATE: Vector = { x: 0, y: 0 };

// Clamped at 0 so a capsule shorter than it is wide collapses to a circle rather than turning inside out.
export function capsuleHalfLength(width: number, height: number): number {
	return Math.max(0, (width - height) / 2);
}

export function shapeRadius(shape: number, width: number, height: number): number {
	if(shape === SHAPE_CIRCLE) {
		return width / 2;
	} else if(shape === SHAPE_CAPSULE) {
		return height / 2;
	}

	return 0;
}

// A shape with no area never overlaps anything, which keeps a sizeless entity out of collisions. Which size
// matters is per shape: a circle is nothing without its width, a capsule with no thickness is a bare line.
export function shapeIsEmpty(shape: number, width: number, height: number): boolean {
	if(shape === SHAPE_CIRCLE) {
		return width <= 0;
	} else if(shape === SHAPE_CAPSULE) {
		return height <= 0;
	}

	return width <= 0 || height <= 0;
}

// Half the axis-aligned box that fully contains a shape at any rotation - what the broadphase indexes it under,
// so it must hold the whole shape. Asked per shape because a circle is its width alone: one whose height was
// hand-written smaller is taller than the width/height rectangle a capsule or radius-loaded circle fits in.
export function shapeHalfWidth(shape: number, width: number, height: number, angle: number): number {
	if(shape === SHAPE_CIRCLE) {
		return width / 2;
	} else if(shape === SHAPE_CAPSULE) {
		return Math.abs(Math.cos(angle)) * capsuleHalfLength(width, height) + height / 2;
	}

	return boundsHalfWidth(width, height, angle);
}
export function shapeHalfHeight(shape: number, width: number, height: number, angle: number): number {
	if(shape === SHAPE_CIRCLE) {
		return width / 2;
	} else if(shape === SHAPE_CAPSULE) {
		return Math.abs(Math.sin(angle)) * capsuleHalfLength(width, height) + height / 2;
	}

	return boundsHalfHeight(width, height, angle);
}

// Whether two shapes of any kind overlap. Every pair is one of three cases: box+box (separating axis),
// round+round (segment gap under the summed radii), or box+round (segment gap under the one radius). Touching
// exactly counts as not overlapping throughout - the comparisons are strict.
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
		// The mixed case is written once with the box first and reached from the other side by swapping.
		return shapesOverlap(
			bShape, bX, bY, bWidth, bHeight, bAngle,
			aShape, aX, aY, aWidth, aHeight, aAngle,
		);
	}

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

// How far a shape's core reaches from its centre: a capsule's segment, and nothing for a circle or rectangle.
function coreHalfLength(shape: number, width: number, height: number): number {
	return shape === SHAPE_CAPSULE ? capsuleHalfLength(width, height) : 0;
}

// The unit direction a is pushed off b at their contact, written into `out`; false when the two are on top of
// each other and there is no such direction. Split the same three ways as shapesOverlap and off the same
// geometry, so the normal is the face that was actually hit rather than a guess from the bounding boxes: a pair
// meeting at an angle reflects along the contact, not along whichever world axis happens to be nearest.
export function contactNormal(
	aShape: number, aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	out: Vector,
): boolean {
	const aIsRound = aShape !== SHAPE_RECTANGLE;
	const bIsRound = bShape !== SHAPE_RECTANGLE;

	if(!aIsRound && !bIsRound) {
		return boxesContactNormal(aX, aY, aWidth, aHeight, aAngle, bX, bY, bWidth, bHeight, bAngle, out);
	} else if(aIsRound && bIsRound) {
		return roundsContactNormal(aShape, aX, aY, aWidth, aHeight, aAngle, bShape, bX, bY, bWidth, bHeight, bAngle, out);
	} else if(aIsRound) {
		return boxRoundContactNormal(bX, bY, bWidth, bHeight, bAngle, aShape, aX, aY, aWidth, aHeight, aAngle, out);
	}

	// The mixed case is written once with the box second and reached from the other side by turning it round.
	if(!boxRoundContactNormal(aX, aY, aWidth, aHeight, aAngle, bShape, bX, bY, bWidth, bHeight, bAngle, out)) {
		return false;
	}

	out.x = -out.x;
	out.y = -out.y;

	return true;
}

// Two boxes part along whichever of their four side directions they run into each other least far - the face
// that was hit. The same axes and reaches the separating-axis test uses, kept as depths rather than a verdict.
function boxesContactNormal(
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	out: Vector,
): boolean {
	const aCos = Math.cos(aAngle);
	const aSin = Math.sin(aAngle);
	const bCos = Math.cos(bAngle);
	const bSin = Math.sin(bAngle);
	const aHalfWidth = aWidth / 2;
	const aHalfHeight = aHeight / 2;
	const bHalfWidth = bWidth / 2;
	const bHalfHeight = bHeight / 2;
	const offsetX = aX - bX;
	const offsetY = aY - bY;

	let best = boxOverlapAlong(aCos, aSin, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin);
	out.x = aCos;
	out.y = aSin;

	let depth = boxOverlapAlong(-aSin, aCos, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin);
	if(depth < best) {
		best = depth;
		out.x = -aSin;
		out.y = aCos;
	}

	depth = boxOverlapAlong(bCos, bSin, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin);
	if(depth < best) {
		best = depth;
		out.x = bCos;
		out.y = bSin;
	}

	depth = boxOverlapAlong(-bSin, bCos, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin);
	if(depth < best) {
		out.x = -bSin;
		out.y = bCos;
	}

	pointAwayFrom(offsetX, offsetY, out);

	return true;
}

// Two rounds meet where their cores come closest - the line between those points, grown by nothing since both
// radii lie along it. Two circles reduce to the line between their centres.
function roundsContactNormal(
	aShape: number, aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	out: Vector,
): boolean {
	const aHalf = coreHalfLength(aShape, aWidth, aHeight);
	const aCos = Math.cos(aAngle) * aHalf;
	const aSin = Math.sin(aAngle) * aHalf;
	const bHalf = coreHalfLength(bShape, bWidth, bHeight);
	const bCos = Math.cos(bAngle) * bHalf;
	const bSin = Math.sin(bAngle) * bHalf;

	const distance = Math.sqrt(segmentSegmentDistanceSquared(
		aX - aCos, aY - aSin, aX + aCos, aY + aSin,
		bX - bCos, bY - bSin, bX + bCos, bY + bSin,
		GAP,
	));
	if(distance > 0) {
		out.x = GAP.x / distance;
		out.y = GAP.y / distance;

		return true;
	}

	// The cores cross, so they have no gap to part along; the centre line is the best left.
	return normalize(aX - bX, aY - bY, out);
}

// A round shape leaves a box along the gap between its core and the box - the box's face for a flat hit, its
// corner for one off the end - which is the direction the round side is pushed. Not the box: the caller turns
// it round for that.
function boxRoundContactNormal(
	boxX: number, boxY: number, boxWidth: number, boxHeight: number, boxAngle: number,
	roundShape: number, roundX: number, roundY: number, roundWidth: number, roundHeight: number, roundAngle: number,
	out: Vector,
): boolean {
	const half = coreHalfLength(roundShape, roundWidth, roundHeight);
	const halfX = Math.cos(roundAngle) * half;
	const halfY = Math.sin(roundAngle) * half;

	const distance = Math.sqrt(segmentBoxDistanceSquared(
		roundX - halfX, roundY - halfY, roundX + halfX, roundY + halfY,
		boxX, boxY, boxWidth, boxHeight, boxAngle,
		GAP,
	));
	if(distance > 0) {
		out.x = GAP.x / distance;
		out.y = GAP.y / distance;

		return true;
	}

	// The core runs through the box, leaving no gap to point along. Fall back to the shallowest way out, in the
	// box's frame where it is axis aligned: its own two sides, or square across the core.
	const cos = Math.cos(boxAngle);
	const sin = Math.sin(boxAngle);
	const offsetX = roundX - boxX;
	const offsetY = roundY - boxY;
	const localX = offsetX * cos + offsetY * sin;
	const localY = -offsetX * sin + offsetY * cos;
	const localHalfX = halfX * cos + halfY * sin;
	const localHalfY = -halfX * sin + halfY * cos;
	const radius = shapeRadius(roundShape, roundWidth, roundHeight);
	const halfWidth = boxWidth / 2;
	const halfHeight = boxHeight / 2;

	let best = roundOverlapAlong(1, 0, localX, localY, localHalfX, localHalfY, radius, halfWidth, halfHeight);
	out.x = 1;
	out.y = 0;

	let depth = roundOverlapAlong(0, 1, localX, localY, localHalfX, localHalfY, radius, halfWidth, halfHeight);
	if(depth < best) {
		best = depth;
		out.x = 0;
		out.y = 1;
	}

	if(normalize(-localHalfY, localHalfX, CANDIDATE)) {
		depth = roundOverlapAlong(CANDIDATE.x, CANDIDATE.y, localX, localY, localHalfX, localHalfY, radius, halfWidth, halfHeight);
		if(depth < best) {
			out.x = CANDIDATE.x;
			out.y = CANDIDATE.y;
		}
	}

	pointAwayFrom(localX, localY, out);

	// Back out of the box's frame.
	const axisX = out.x;
	const axisY = out.y;
	out.x = axisX * cos - axisY * sin;
	out.y = axisX * sin + axisY * cos;

	return true;
}

// How far an axis-aligned box at the origin and a segment grown by `radius` run into each other along a unit
// axis. The round side reaches its core's shadow plus the radius, which is the same in every direction.
function roundOverlapAlong(
	axisX: number, axisY: number,
	centreX: number, centreY: number,
	halfX: number, halfY: number, radius: number,
	halfWidth: number, halfHeight: number,
): number {
	const boxReach = halfWidth * Math.abs(axisX) + halfHeight * Math.abs(axisY);
	const roundReach = Math.abs(halfX * axisX + halfY * axisY) + radius;

	return boxReach + roundReach - Math.abs(centreX * axisX + centreY * axisY);
}

// Turns an axis the way that leads away from the other shape. A tie means the centres sit on the axis' line, and
// either side is as good.
function pointAwayFrom(offsetX: number, offsetY: number, out: Vector): void {
	if(offsetX * out.x + offsetY * out.y < 0) {
		out.x = -out.x;
		out.y = -out.y;
	}
}

function normalize(x: number, y: number, out: Vector): boolean {
	const length = Math.sqrt(x * x + y * y);
	if(length === 0) {
		return false;
	}

	out.x = x / length;
	out.y = y / length;

	return true;
}

// Half the axis-aligned box containing a rotated rectangle: each side contributes however much now points along
// the axis. width / 2 at angle 0, height / 2 at a quarter turn.
export function boundsHalfWidth(width: number, height: number, angle: number): number {
	return (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height) / 2;
}
export function boundsHalfHeight(width: number, height: number, angle: number): number {
	return (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height) / 2;
}

// Whether two rotated boxes overlap, by the separating axis theorem: for two boxes only four axes can separate
// them - the two each box's sides face along. Touching exactly and a zero-area box both count as not
// overlapping, which keeps a sizeless entity out of collisions.
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

	const offsetX = bX - aX;
	const offsetY = bY - aY;

	// a's two axes, then b's; each box's sides face along (cos, sin) and (-sin, cos) of its angle.
	return boxOverlapAlong(aCos, aSin, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin) > 0
		&& boxOverlapAlong(-aSin, aCos, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin) > 0
		&& boxOverlapAlong(bCos, bSin, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin) > 0
		&& boxOverlapAlong(-bSin, bCos, offsetX, offsetY, aHalfWidth, aHalfHeight, aCos, aSin, bHalfWidth, bHalfHeight, bCos, bSin) > 0;
}

// How far the boxes' shadows on the axis run into each other; zero or less means the axis separates them, so
// touching exactly does not overlap. The axes are always a box's own unit-vector sides, so the dot products are
// true distances and nothing needs normalising. The depth is what picks the contact face in contactNormal.
function boxOverlapAlong(
	axisX: number, axisY: number,
	offsetX: number, offsetY: number,
	aHalfWidth: number, aHalfHeight: number, aCos: number, aSin: number,
	bHalfWidth: number, bHalfHeight: number, bCos: number, bSin: number,
): number {
	const aReach = aHalfWidth * Math.abs(aCos * axisX + aSin * axisY) + aHalfHeight * Math.abs(-aSin * axisX + aCos * axisY);
	const bReach = bHalfWidth * Math.abs(bCos * axisX + bSin * axisY) + bHalfHeight * Math.abs(-bSin * axisX + bCos * axisY);

	return aReach + bReach - Math.abs(offsetX * axisX + offsetY * axisY);
}

// Squared distance between two segments - squared so callers can compare against a squared radius without a
// sqrt. Settles every round pair (a circle is a segment whose ends coincide). Solves the closest points on the
// two infinite lines then clamps back into the segments; the parallel case pins one end and clamps the rest.
// `out`, if given, is filled with the vector from b's closest point to a's - the direction a is pushed off b.
export function segmentSegmentDistanceSquared(
	aX1: number, aY1: number, aX2: number, aY2: number,
	bX1: number, bY1: number, bX2: number, bY2: number,
	out?: Vector,
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
		if(out) {
			out.x = offsetX;
			out.y = offsetY;
		}

		return offsetX * offsetX + offsetY * offsetY;
	} else if(aLength <= 0) {
		bParam = clamp(bOffset / bLength);
	} else {
		const aOffset = aDeltaX * offsetX + aDeltaY * offsetY;
		if(bLength <= 0) {
			aParam = clamp(-aOffset / aLength);
		} else {
			const along = aDeltaX * bDeltaX + aDeltaY * bDeltaY;
			// Zero when the segments are parallel; pinning aParam at 0 then picks any point, all equally close.
			const denominator = aLength * bLength - along * along;
			if(denominator !== 0) {
				aParam = clamp((along * bOffset - aOffset * bLength) / denominator);
			}

			bParam = (along * aParam + bOffset) / bLength;
			// Clamping bParam moves b's closest point, so aParam has to be solved again.
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
	if(out) {
		out.x = gapX;
		out.y = gapY;
	}

	return gapX * gapX + gapY * gapY;
}

// Squared distance between a segment and a rotated box, measured in the box's frame where it is axis aligned.
// Two disjoint convex shapes have their closest pair at a corner, so once the crossing case is ruled out the
// answer is the nearest of each segment end to the box and each box corner to the segment.
// `out`, if given, is filled with the world vector from the box's closest point to the segment's - the direction
// the segment is pushed off the box. It is (0, 0) when the segment runs through the box, which has no such
// direction; contactNormal falls back to a penetration axis there.
export function segmentBoxDistanceSquared(
	x1: number, y1: number, x2: number, y2: number,
	boxX: number, boxY: number, boxWidth: number, boxHeight: number, boxAngle: number,
	out?: Vector,
): number {
	const cos = Math.cos(boxAngle);
	const sin = Math.sin(boxAngle);
	const halfWidth = boxWidth / 2;
	const halfHeight = boxHeight / 2;

	const firstOffsetX = x1 - boxX;
	const firstOffsetY = y1 - boxY;
	const secondOffsetX = x2 - boxX;
	const secondOffsetY = y2 - boxY;
	const localX1 = firstOffsetX * cos + firstOffsetY * sin;
	const localY1 = -firstOffsetX * sin + firstOffsetY * cos;
	const localX2 = secondOffsetX * cos + secondOffsetY * sin;
	const localY2 = -secondOffsetX * sin + secondOffsetY * cos;

	// A segment through the box has both ends outside and every corner off, so the nearest-pair search below
	// would report a real distance for two shapes already through each other; catch it first.
	if(!segmentMissesBox(localX1, localY1, localX2, localY2, halfWidth, halfHeight)) {
		if(out) {
			out.x = 0;
			out.y = 0;
		}

		return 0;
	}

	if(!out) {
		return Math.min(
			pointBoxDistanceSquared(localX1, localY1, halfWidth, halfHeight),
			pointBoxDistanceSquared(localX2, localY2, halfWidth, halfHeight),
			pointSegmentDistanceSquared(-halfWidth, -halfHeight, localX1, localY1, localX2, localY2),
			pointSegmentDistanceSquared(halfWidth, -halfHeight, localX1, localY1, localX2, localY2),
			pointSegmentDistanceSquared(halfWidth, halfHeight, localX1, localY1, localX2, localY2),
			pointSegmentDistanceSquared(-halfWidth, halfHeight, localX1, localY1, localX2, localY2),
		);
	}

	// The same six candidates, keeping the gap of the winner. The corner ones measure box-to-segment, the other
	// way round from the endpoint ones, so they are negated to leave every gap pointing off the box.
	let best = pointBoxDistanceSquared(localX1, localY1, halfWidth, halfHeight, out);
	best = keepCloser(best, pointBoxDistanceSquared(localX2, localY2, halfWidth, halfHeight, CANDIDATE), CANDIDATE, out, false);
	best = keepCloser(best, pointSegmentDistanceSquared(-halfWidth, -halfHeight, localX1, localY1, localX2, localY2, CANDIDATE), CANDIDATE, out, true);
	best = keepCloser(best, pointSegmentDistanceSquared(halfWidth, -halfHeight, localX1, localY1, localX2, localY2, CANDIDATE), CANDIDATE, out, true);
	best = keepCloser(best, pointSegmentDistanceSquared(halfWidth, halfHeight, localX1, localY1, localX2, localY2, CANDIDATE), CANDIDATE, out, true);
	best = keepCloser(best, pointSegmentDistanceSquared(-halfWidth, halfHeight, localX1, localY1, localX2, localY2, CANDIDATE), CANDIDATE, out, true);

	// Back out of the box's frame, the gap having been measured inside it.
	const localGapX = out.x;
	const localGapY = out.y;
	out.x = localGapX * cos - localGapY * sin;
	out.y = localGapX * sin + localGapY * cos;

	return best;
}

// Takes the candidate over what `out` holds when it is closer, flipping it when it was measured box-to-segment.
function keepCloser(best: number, candidate: number, gap: Vector, out: Vector, flip: boolean): number {
	if(candidate >= best) {
		return best;
	}

	out.x = flip ? -gap.x : gap.x;
	out.y = flip ? -gap.y : gap.y;

	return candidate;
}

// `out`, if given, is filled with the vector from the segment's closest point to (x, y).
export function pointSegmentDistanceSquared(x: number, y: number, x1: number, y1: number, x2: number, y2: number, out?: Vector): number {
	const deltaX = x2 - x1;
	const deltaY = y2 - y1;
	const length = deltaX * deltaX + deltaY * deltaY;

	const along = length > 0 ? clamp(((x - x1) * deltaX + (y - y1) * deltaY) / length) : 0;
	const gapX = x - (x1 + deltaX * along);
	const gapY = y - (y1 + deltaY * along);
	if(out) {
		out.x = gapX;
		out.y = gapY;
	}

	return gapX * gapX + gapY * gapY;
}

// Whether an origin-centred axis-aligned box and a segment fail to reach, by separating axis. Touching counts
// as reaching. For a zero-length segment the normal is (0, 0), which never separates and leaves the two box
// axes to decide whether the point is inside.
function segmentMissesBox(x1: number, y1: number, x2: number, y2: number, halfWidth: number, halfHeight: number): boolean {
	if(Math.max(x1, x2) < -halfWidth || Math.min(x1, x2) > halfWidth) {
		return true;
	} else if(Math.max(y1, y2) < -halfHeight || Math.min(y1, y2) > halfHeight) {
		return true;
	}

	const normalX = -(y2 - y1);
	const normalY = x2 - x1;

	return Math.abs(normalX * x1 + normalY * y1) > halfWidth * Math.abs(normalX) + halfHeight * Math.abs(normalY);
}

// Squared distance from a point to an origin-centred axis-aligned box; 0 inside it. `out`, if given, is filled
// with the vector from the box's closest point to (x, y).
function pointBoxDistanceSquared(x: number, y: number, halfWidth: number, halfHeight: number, out?: Vector): number {
	const gapX = Math.abs(x) - halfWidth;
	const gapY = Math.abs(y) - halfHeight;
	const outsideX = gapX > 0 ? gapX : 0;
	const outsideY = gapY > 0 ? gapY : 0;
	if(out) {
		out.x = x < 0 ? -outsideX : outsideX;
		out.y = y < 0 ? -outsideY : outsideY;
	}

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
