import { MAX_POLYGON_VERTICES, POLYGON_VERTEX_COUNT_INDEX, POLYGON_SIZE } from './polygon-component-constants';
import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

export type PolygonVertex = readonly [x: number, y: number];

export interface PolygonConfig {
	vertices?: ReadonlyArray<PolygonVertex>
	width?: number
	height?: number
}

export interface PolygonComponent {
	index: number
	readonly block: Float32Array
	readonly vertexCount: number
}

export interface PreparedPolygon {
	width: number
	height: number
	vertices: Array<number>
}

class PolygonComponentImpl extends Component<Float32Array> implements PolygonComponent {
	get vertexCount() {
		return this.block[POLYGON_VERTEX_COUNT_INDEX];
	}
}

export const polygonDefinition: ComponentDefinition<PolygonComponent, Float32Array, PolygonConfig> = {
	type: Float32Array,
	size: POLYGON_SIZE,
	loadProperties: ['vertices'],
	toBlock(config) {
		const prepared = preparePolygon(config.vertices, config.width, config.height);

		return [prepared.vertices.length / 2, ...prepared.vertices];
	},
	attach(entity, memory, index) {
		return new PolygonComponentImpl(memory.getBlock(index), index);
	},
};

// With a width and height, the vertices are offsets from the entity's centre that must fit inside that box, so the
// outline can sit tighter than the box a game draws (and sizes) the entity by. Without, the vertices' bounds are the box.
export function preparePolygon(vertices: ReadonlyArray<PolygonVertex> | undefined, boxWidth?: number, boxHeight?: number): PreparedPolygon {
	if(!vertices || vertices.length < 3 || vertices.length > MAX_POLYGON_VERTICES) {
		throw new Error(`A polygon needs between 3 and ${MAX_POLYGON_VERTICES} vertices`);
	}

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for(const [x, y] of vertices) {
		if(!Number.isFinite(x) || !Number.isFinite(y)) {
			throw new Error('Polygon vertices must be finite numbers');
		}
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}

	const width = maxX - minX;
	const height = maxY - minY;
	if(width <= 0 || height <= 0) {
		throw new Error('A polygon must have nonzero width and height');
	}

	let winding = 0;
	for(let i = 0; i < vertices.length; i++) {
		const previous = vertices[(i + vertices.length - 1) % vertices.length];
		const current = vertices[i];
		const next = vertices[(i + 1) % vertices.length];
		const turnCross = (current[0] - previous[0]) * (next[1] - current[1])
			- (current[1] - previous[1]) * (next[0] - current[0]);
		if(turnCross === 0) {
			throw new Error('A polygon cannot contain duplicate or collinear adjacent vertices');
		}
		const direction = Math.sign(turnCross);
		if(winding === 0) {
			winding = direction;
		} else if(direction !== winding) {
			throw new Error('Polygon vertices must describe a convex polygon in boundary order');
		}
	}
	for(let i = 0; i < vertices.length; i++) {
		const aStart = vertices[i];
		const aEnd = vertices[(i + 1) % vertices.length];
		for(let j = i + 1; j < vertices.length; j++) {
			if(j === i || j === i + 1 || i === 0 && j === vertices.length - 1) {
				continue;
			}
			const bStart = vertices[j];
			const bEnd = vertices[(j + 1) % vertices.length];
			if(segmentsIntersect(aStart, aEnd, bStart, bEnd)) {
				throw new Error('Polygon edges cannot cross or share non-adjacent vertices');
			}
		}
	}

	if((boxWidth === undefined) !== (boxHeight === undefined)) {
		throw new Error('A sized polygon needs both a width and a height');
	}
	const sized = boxWidth !== undefined && boxHeight !== undefined;
	if(sized) {
		if(!(boxWidth > 0) || !(boxHeight > 0)) {
			throw new Error('A sized polygon needs a positive width and height');
		} else if(minX < -boxWidth / 2 || maxX > boxWidth / 2 || minY < -boxHeight / 2 || maxY > boxHeight / 2) {
			// The broadphase indexes the entity by its box, so an outline poking out of it would miss contacts.
			throw new Error('Polygon vertices must fit inside the width and height they are given with');
		}
	}

	const outputWidth = sized ? boxWidth : width;
	const outputHeight = sized ? boxHeight : height;
	const centreX = sized ? 0 : (minX + maxX) / 2;
	const centreY = sized ? 0 : (minY + maxY) / 2;
	const normalized: Array<number> = [];
	const ordered = winding > 0 ? vertices : vertices.toReversed();
	for(const [x, y] of ordered) {
		normalized.push((x - centreX) / outputWidth, (y - centreY) / outputHeight);
	}

	return { width: outputWidth, height: outputHeight, vertices: normalized };
}

function segmentsIntersect(aStart: PolygonVertex, aEnd: PolygonVertex, bStart: PolygonVertex, bEnd: PolygonVertex): boolean {
	const aToStart = cross(aStart, aEnd, bStart);
	const aToEnd = cross(aStart, aEnd, bEnd);
	const bToStart = cross(bStart, bEnd, aStart);
	const bToEnd = cross(bStart, bEnd, aEnd);

	return aToStart * aToEnd <= 0 && bToStart * bToEnd <= 0;
}

function cross(start: PolygonVertex, end: PolygonVertex, point: PolygonVertex): number {
	return (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0]);
}

export default polygonDefinition;
