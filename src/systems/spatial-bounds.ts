import { bodyShape, SHAPE_RECTANGLE } from '../components/body-component';
import {
	TRANSFORM_ANGLE_INDEX,
	TRANSFORM_HEIGHT_INDEX,
	TRANSFORM_WIDTH_INDEX,
	TRANSFORM_X_INDEX,
	TRANSFORM_Y_INDEX,
} from '../components/transform-component';
import { shapeHalfHeight, shapeHalfWidth } from '../math/shapes';

export interface SpatialBounds {
	minX: number
	minY: number
	maxX: number
	maxY: number
}

export interface SpatialBlockComponents {
	transform: Float32Array
	body?: Uint32Array
}

export function spatialBounds(components: SpatialBlockComponents): SpatialBounds {
	const transform = components.transform;
	const shape = components.body ? bodyShape(components.body) : SHAPE_RECTANGLE;
	const width = transform[TRANSFORM_WIDTH_INDEX];
	const height = transform[TRANSFORM_HEIGHT_INDEX];
	const angle = transform[TRANSFORM_ANGLE_INDEX];
	const halfWidth = shapeHalfWidth(shape, width, height, angle);
	const halfHeight = shapeHalfHeight(shape, width, height, angle);
	const x = transform[TRANSFORM_X_INDEX];
	const y = transform[TRANSFORM_Y_INDEX];

	return {
		minX: x - halfWidth,
		minY: y - halfHeight,
		maxX: x + halfWidth,
		maxY: y + halfHeight,
	};
}

export function boundsOverlap(a: SpatialBounds, minX: number, minY: number, maxX: number, maxY: number): boolean {
	return a.minX <= maxX && a.maxX >= minX && a.minY <= maxY && a.maxY >= minY;
}

export function querySize(min: number, max: number): number {
	return max > min ? max - min : Math.max(1, Math.abs(min)) * Number.EPSILON;
}
