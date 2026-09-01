import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_POLYGON, SHAPE_RECTANGLE } from '../components/body-component';
import { POLYGON_VERTEX_COUNT_INDEX, POLYGON_VERTICES_INDEX } from '../components/polygon-component';
import { capsuleHalfLength } from './shapes';
import type { Vector } from './shapes';

interface Projection {
	min: number
	max: number
}

interface AxisResult {
	overlap: boolean
	depth: number
	x: number
	y: number
}

const PROJECTION_A: Projection = { min: 0, max: 0 };
const PROJECTION_B: Projection = { min: 0, max: 0 };
const AXIS: AxisResult = { overlap: true, depth: Infinity, x: 0, y: 0 };

export function polygonShapesOverlap(
	aShape: number, aPolygon: Float32Array | undefined,
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bPolygon: Float32Array | undefined,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
): boolean {
	return testPolygonAxes(
		aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
		bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
		false,
	);
}

export function polygonContactNormal(
	aShape: number, aPolygon: Float32Array | undefined,
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bPolygon: Float32Array | undefined,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	out: Vector,
): boolean {
	AXIS.depth = Infinity;
	if(!testPolygonAxes(
		aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
		bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
		true,
	) || AXIS.depth === Infinity) {
		return false;
	}

	out.x = AXIS.x;
	out.y = AXIS.y;

	return true;
}

function testPolygonAxes(
	aShape: number, aPolygon: Float32Array | undefined,
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bPolygon: Float32Array | undefined,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	keepBest: boolean,
): boolean {
	if(aShape === SHAPE_POLYGON) {
		if(!aPolygon || !testEdges(
			aPolygon, aX, aY, aWidth, aHeight, aAngle,
			aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
			bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
			keepBest,
		)) {
			return false;
		}
	}
	if(bShape === SHAPE_POLYGON) {
		if(!bPolygon || !testEdges(
			bPolygon, bX, bY, bWidth, bHeight, bAngle,
			aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
			bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
			keepBest,
		)) {
			return false;
		}
	}

	if(aShape === SHAPE_RECTANGLE && !testRectangleAxes(
		aAngle,
		aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
		bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
		keepBest,
	)) {
		return false;
	}
	if(bShape === SHAPE_RECTANGLE && !testRectangleAxes(
		bAngle,
		aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
		bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
		keepBest,
	)) {
		return false;
	}

	if(isRound(aShape) && bPolygon && !testRoundVertexAxes(
		aShape, aX, aY, aWidth, aHeight, aAngle,
		bPolygon, bX, bY, bWidth, bHeight, bAngle,
		aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
		bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
		keepBest,
	)) {
		return false;
	}
	if(isRound(bShape) && aPolygon && !testRoundVertexAxes(
		bShape, bX, bY, bWidth, bHeight, bAngle,
		aPolygon, aX, aY, aWidth, aHeight, aAngle,
		aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
		bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
		keepBest,
	)) {
		return false;
	}

	return true;
}

function testEdges(
	polygon: Float32Array, x: number, y: number, width: number, height: number, angle: number,
	aShape: number, aPolygon: Float32Array | undefined,
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bPolygon: Float32Array | undefined,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	keepBest: boolean,
): boolean {
	const count = polygon[POLYGON_VERTEX_COUNT_INDEX];
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	for(let i = 0; i < count; i++) {
		const next = (i + 1) % count;
		const currentX = worldVertexX(polygon, i, x, width, height, cos, sin);
		const currentY = worldVertexY(polygon, i, y, width, height, cos, sin);
		const nextX = worldVertexX(polygon, next, x, width, height, cos, sin);
		const nextY = worldVertexY(polygon, next, y, width, height, cos, sin);
		if(!testAxis(
			currentY - nextY, nextX - currentX,
			aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
			bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
			keepBest,
		)) {
			return false;
		}
	}

	return true;
}

function testRectangleAxes(
	angle: number,
	aShape: number, aPolygon: Float32Array | undefined,
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bPolygon: Float32Array | undefined,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	keepBest: boolean,
): boolean {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);

	return testAxis(
		cos, sin,
		aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
		bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
		keepBest,
	) && testAxis(
		-sin, cos,
		aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
		bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
		keepBest,
	);
}

function testRoundVertexAxes(
	roundShape: number, roundX: number, roundY: number, roundWidth: number, roundHeight: number, roundAngle: number,
	polygon: Float32Array, polygonX: number, polygonY: number, polygonWidth: number, polygonHeight: number, polygonAngle: number,
	aShape: number, aPolygon: Float32Array | undefined,
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bPolygon: Float32Array | undefined,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	keepBest: boolean,
): boolean {
	const half = roundShape === SHAPE_CAPSULE ? capsuleHalfLength(roundWidth, roundHeight) : 0;
	const alongX = Math.cos(roundAngle) * half;
	const alongY = Math.sin(roundAngle) * half;
	const startX = roundX - alongX;
	const startY = roundY - alongY;
	const endX = roundX + alongX;
	const endY = roundY + alongY;
	const count = polygon[POLYGON_VERTEX_COUNT_INDEX];
	const cos = Math.cos(polygonAngle);
	const sin = Math.sin(polygonAngle);
	for(let i = 0; i < count; i++) {
		const vertexX = worldVertexX(polygon, i, polygonX, polygonWidth, polygonHeight, cos, sin);
		const vertexY = worldVertexY(polygon, i, polygonY, polygonWidth, polygonHeight, cos, sin);
		const fraction = closestFraction(startX, startY, endX, endY, vertexX, vertexY);
		const coreX = startX + (endX - startX) * fraction;
		const coreY = startY + (endY - startY) * fraction;
		if(!testAxis(
			vertexX - coreX, vertexY - coreY,
			aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle,
			bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle,
			keepBest,
		)) {
			return false;
		}
	}

	return true;
}

function testAxis(
	axisX: number, axisY: number,
	aShape: number, aPolygon: Float32Array | undefined,
	aX: number, aY: number, aWidth: number, aHeight: number, aAngle: number,
	bShape: number, bPolygon: Float32Array | undefined,
	bX: number, bY: number, bWidth: number, bHeight: number, bAngle: number,
	keepBest: boolean,
): boolean {
	const length = Math.hypot(axisX, axisY);
	if(length === 0) {
		return true;
	}
	axisX /= length;
	axisY /= length;

	projectShape(aShape, aPolygon, aX, aY, aWidth, aHeight, aAngle, axisX, axisY, PROJECTION_A);
	projectShape(bShape, bPolygon, bX, bY, bWidth, bHeight, bAngle, axisX, axisY, PROJECTION_B);
	const negativeDepth = PROJECTION_A.max - PROJECTION_B.min;
	const positiveDepth = PROJECTION_B.max - PROJECTION_A.min;
	if(!keepBest && (negativeDepth <= 0 || positiveDepth <= 0)) {
		return false;
	}

	if(keepBest) {
		let depth: number;
		let direction: number;
		if(negativeDepth <= 0) {
			depth = -negativeDepth;
			direction = -1;
		} else if(positiveDepth <= 0) {
			depth = -positiveDepth;
			direction = 1;
		} else if(negativeDepth < positiveDepth) {
			depth = negativeDepth;
			direction = -1;
		} else {
			depth = positiveDepth;
			direction = 1;
		}
		if(depth < AXIS.depth) {
			AXIS.depth = depth;
			AXIS.x = axisX * direction;
			AXIS.y = axisY * direction;
		}
	}

	return true;
}

function projectShape(
	shape: number, polygon: Float32Array | undefined,
	x: number, y: number, width: number, height: number, angle: number,
	axisX: number, axisY: number, out: Projection,
): void {
	const centre = x * axisX + y * axisY;
	if(shape === SHAPE_CIRCLE) {
		const radius = width / 2;
		out.min = centre - radius;
		out.max = centre + radius;
		return;
	}

	if(shape === SHAPE_CAPSULE) {
		const half = capsuleHalfLength(width, height);
		const reach = Math.abs(axisX * Math.cos(angle) + axisY * Math.sin(angle)) * half + height / 2;
		out.min = centre - reach;
		out.max = centre + reach;
		return;
	}

	if(shape === SHAPE_RECTANGLE) {
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const reach = Math.abs(axisX * cos + axisY * sin) * width / 2
			+ Math.abs(axisX * -sin + axisY * cos) * height / 2;
		out.min = centre - reach;
		out.max = centre + reach;
		return;
	}

	if(!polygon) {
		out.min = Infinity;
		out.max = -Infinity;
		return;
	}

	const count = polygon[POLYGON_VERTEX_COUNT_INDEX];
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	out.min = Infinity;
	out.max = -Infinity;
	for(let i = 0; i < count; i++) {
		const vertexX = worldVertexX(polygon, i, x, width, height, cos, sin);
		const vertexY = worldVertexY(polygon, i, y, width, height, cos, sin);
		const projection = vertexX * axisX + vertexY * axisY;
		out.min = Math.min(out.min, projection);
		out.max = Math.max(out.max, projection);
	}
}

function worldVertexX(polygon: Float32Array, index: number, x: number, width: number, height: number, cos: number, sin: number): number {
	const offset = POLYGON_VERTICES_INDEX + index * 2;
	return x + polygon[offset] * width * cos - polygon[offset + 1] * height * sin;
}

function worldVertexY(polygon: Float32Array, index: number, y: number, width: number, height: number, cos: number, sin: number): number {
	const offset = POLYGON_VERTICES_INDEX + index * 2;
	return y + polygon[offset] * width * sin + polygon[offset + 1] * height * cos;
}

function closestFraction(startX: number, startY: number, endX: number, endY: number, x: number, y: number): number {
	const segmentX = endX - startX;
	const segmentY = endY - startY;
	const lengthSquared = segmentX * segmentX + segmentY * segmentY;
	if(lengthSquared === 0) {
		return 0;
	}

	return Math.min(1, Math.max(0, ((x - startX) * segmentX + (y - startY) * segmentY) / lengthSquared));
}

function isRound(shape: number): boolean {
	return shape === SHAPE_CIRCLE || shape === SHAPE_CAPSULE;
}
