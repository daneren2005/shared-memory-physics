import Flatbush from 'flatbush';
import type { EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import { BODY_SHAPE_INDEX, SHAPE_RECTANGLE } from '../components/body-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { shapeHalfHeight, shapeHalfWidth } from '../math/shapes';

// The blocks the index reads off each entity. Only the transform is needed; the body refines the box to the
// entity's actual shape. Anything else a game queried travels along untouched for a filter to read.
export type SpatialComponents = {
	transform: Float32Array
	body?: Uint32Array
};

// One entity as the index hands it back: its id plus whatever blocks came with it.
export interface SpatialEntity<T extends SpatialComponents = SpatialComponents> {
	entityId: number
	components: T
}

// Which found entities are wanted. Run per candidate, so it is the place for what the index cannot know - the
// searcher's own id, which team, whether it is dead - and a reject is as if it were never in the box.
export type SpatialFilter<T extends SpatialComponents = SpatialComponents> = (entity: SpatialEntity<T>) => boolean;

// An R-tree over a set of entities, for questions about where things are rather than what is hitting what: who
// is in this area, and what is nearest a point. The same machinery as the collision broadphase minus everything
// collision specific, so answers are in terms of each entity's axis-aligned box and a `filter` picks the ones
// that matter. It is a snapshot - nothing reads the blocks after the constructor - so build one per run.
//
//   const index = new SpatialIndex(queries.collidable);
//   const nearest = index.findNearest(x, y, 150, other => other.entityId !== entityId);
export default class SpatialIndex<T extends SpatialComponents = SpatialComponents> {
	private entries: Array<SpatialEntity<T>> = [];
	// Left off for an empty index: Flatbush cannot hold zero items, and there is no answer to give anyway.
	private index: Flatbush | undefined;

	// `entities` is anything shaped like a query result, so a system's own `queries.whatever` goes straight in.
	// Entities without a transform are skipped - something with no place in the world cannot be found by a search
	// of it.
	constructor(entities: Iterable<{ entityId: number, components: EntityUpdateComponents }>) {
		// Collected up front because Flatbush needs its item count before any are added, only known once everything
		// without a transform is dropped.
		const bounds: Array<number> = [];

		for(const entity of entities) {
			// The ECS types blocks generically as ComponentTypedArray; narrow to the concrete arrays once here.
			const components = entity.components as T;
			const transform = components.transform;
			if(!transform) {
				continue;
			}

			// No body means the transform's width and height are a plain rectangle, keeping the index usable for
			// anything with a place in the world, not only things that collide.
			const body = components.body;
			const shape = body ? body[BODY_SHAPE_INDEX] : SHAPE_RECTANGLE;
			const width = transform[TRANSFORM_WIDTH_INDEX];
			const height = transform[TRANSFORM_HEIGHT_INDEX];
			const angle = transform[TRANSFORM_ANGLE_INDEX];
			const x = transform[TRANSFORM_X_INDEX];
			const y = transform[TRANSFORM_Y_INDEX];

			// Unlike the collision broadphase, a zero-area entity is kept: it still has a position to be found at.
			const halfWidth = shapeHalfWidth(shape, width, height, angle);
			const halfHeight = shapeHalfHeight(shape, width, height, angle);

			this.entries.push({ entityId: entity.entityId, components });
			bounds.push(x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight);
		}

		if(this.entries.length === 0) {
			return;
		}

		const index = new Flatbush(this.entries.length);
		for(let i = 0; i < this.entries.length; i++) {
			index.add(bounds[i * 4], bounds[i * 4 + 1], bounds[i * 4 + 2], bounds[i * 4 + 3]);
		}
		index.finish();

		this.index = index;
	}

	// How many entities are in the index, which is not how many were handed to it: transform-less ones are out.
	get size(): number {
		return this.entries.length;
	}

	// Everything whose box reaches into the one given, in no particular order. Touching counts, so an exact
	// edge question is the caller's to settle on the results.
	search(minX: number, minY: number, maxX: number, maxY: number, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		const index = this.index;
		if(!index) {
			return [];
		}

		const entries = this.entries;
		// Filtering inside the search keeps a reject from ever reaching the results array.
		const found = filter ? index.search(minX, minY, maxX, maxY, i => filter(entries[i]))
			: index.search(minX, minY, maxX, maxY);

		return found.map(i => entries[i]);
	}

	// `search` from the middle out: everything within `reachX` / `reachY` of (x, y), the form most searches take.
	searchAround(x: number, y: number, reachX: number, reachY: number, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		return this.search(x - reachX, y - reachY, x + reachX, y + reachY, filter);
	}

	// The closest entity to (x, y) that `filter` accepts, or undefined when none is within `maxDistance`. A walk
	// of the tree in distance order rather than a search-then-sort, so it never measures the far side of the
	// world. Distance is to the entity's box, not its centre, so a big thing is as near as its nearest edge.
	findNearest(x: number, y: number, maxDistance = Infinity, filter?: SpatialFilter<T>): SpatialEntity<T> | undefined {
		return this.findNearby(x, y, 1, maxDistance, filter)[0];
	}

	// The `maxResults` closest entities to (x, y), nearest first, on the same terms as findNearest.
	findNearby(x: number, y: number, maxResults: number, maxDistance = Infinity, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		const index = this.index;
		if(!index) {
			return [];
		}

		const entries = this.entries;
		// Handed to Flatbush rather than applied afterwards, so `maxResults` counts wanted entities: filtering after
		// would let a few rejects use up the allowance and hide a valid target behind them.
		const found = filter ? index.neighbors(x, y, maxResults, maxDistance, i => filter(entries[i]))
			: index.neighbors(x, y, maxResults, maxDistance);

		return found.map(i => entries[i]);
	}
}
