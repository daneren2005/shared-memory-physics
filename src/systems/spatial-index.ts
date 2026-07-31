import Flatbush from 'flatbush';
import type { EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import { BODY_SHAPE_INDEX, SHAPE_RECTANGLE } from '../components/body-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { shapeHalfHeight, shapeHalfWidth } from '../math/shapes';

// The blocks the index reads off each entity.  Only the transform is needed - that is what says where something
// is and how big it is - while the body refines the box it is filed under to the shape it actually is.  Anything
// else a game queried travels along untouched, so a filter can read it back out.
export type SpatialComponents = {
	transform: Float32Array
	body?: Uint32Array
};

// One entity as the index hands it back: the id it was given plus whatever blocks came with it.
export interface SpatialEntity<T extends SpatialComponents = SpatialComponents> {
	entityId: number
	components: T
}

// Which of the entities a query found are wanted.  Run per candidate the tree turns up, so it is the place to
// put whatever the index itself cannot know - the searcher's own id, which team something is on, whether it is
// already dead - and everything it rejects is as if it were never in the box at all.
export type SpatialFilter<T extends SpatialComponents = SpatialComponents> = (entity: SpatialEntity<T>) => boolean;

// An R-tree over a set of entities, for the questions a game asks about *where things are* rather than about
// what is running into what: who is in this area, and what is the closest thing to this point.
//
// This is the same machinery the collision broadphase is built on, minus everything collision specific - there
// are no collide categories, no room left for a move, and no shape tests.  Every answer is in terms of the
// axis aligned box each entity occupies, so an entity is "found" as soon as that box is reached, and picking
// out the ones that really matter is the caller's to do with a `filter` (see SpatialFilter).
//
// Nothing here reads the blocks after the constructor, so the index is a snapshot: it describes where everything
// was at the moment it was built.  Build one per run - the entities it holds are moving, and a tree built last
// run is a tree of where they all used to be.
//
//   const index = new SpatialIndex(queries.collidable);
//   const nearest = index.findNearest(x, y, 150, other => other.entityId !== entityId);
export default class SpatialIndex<T extends SpatialComponents = SpatialComponents> {
	private entries: Array<SpatialEntity<T>> = [];
	// Left off for an index over nothing at all: Flatbush cannot be built to hold zero items, and there is no
	// answer to give from an empty index anyway.
	private index: Flatbush | undefined;

	// `entities` is anything shaped like a query result - `{ entityId, components }` - so a system's own
	// `queries.whatever` goes straight in.  Entities without a transform are skipped rather than rejected: a
	// query that only *optionally* asks for one is a perfectly reasonable thing to hand over, and something with
	// no place in the world cannot be found by a search of the world.
	constructor(entities: Iterable<{ entityId: number, components: EntityUpdateComponents }>) {
		// Boxes are collected up front because Flatbush has to be told how many items it will hold before any of
		// them are added, and how many that is only becomes clear once everything without a transform is dropped.
		const bounds: Array<number> = [];

		for(const entity of entities) {
			// The ECS types query blocks generically as ComponentTypedArray since it cannot know what any given
			// game registered; narrow them to the concrete arrays the definitions allocate here, once, so neither
			// the searches below nor the game's filter needs a cast of its own.
			const components = entity.components as T;
			const transform = components.transform;
			if(!transform) {
				continue;
			}

			// A body only says which outline the transform's width and height describe, so an entity without one is
			// taken as the plain rectangle they already are.  That keeps the index usable for anything with a place
			// in the world rather than only for things that collide.
			const body = components.body;
			const shape = body ? body[BODY_SHAPE_INDEX] : SHAPE_RECTANGLE;
			const width = transform[TRANSFORM_WIDTH_INDEX];
			const height = transform[TRANSFORM_HEIGHT_INDEX];
			const angle = transform[TRANSFORM_ANGLE_INDEX];
			const x = transform[TRANSFORM_X_INDEX];
			const y = transform[TRANSFORM_Y_INDEX];

			// Unlike the collision broadphase, an entity with no area is kept: a search is a question about where
			// something is, and a thing with a position but no size still has an answer to it.
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

	// How many entities are actually in the index, which is not how many were handed to it: anything without a
	// transform never made it in.
	get size(): number {
		return this.entries.length;
	}

	// Everything whose box reaches into the one given, in no particular order.  Touching counts - two boxes that
	// share nothing but an edge are still found - so an exact question about where the edges fall is one for the
	// caller to settle on the results.
	search(minX: number, minY: number, maxX: number, maxY: number, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		const index = this.index;
		if(!index) {
			return [];
		}

		const entries = this.entries;
		// Filtering inside the search rather than over its results is what keeps a rejected candidate from ever
		// reaching the results array in the first place.
		const found = filter ? index.search(minX, minY, maxX, maxY, i => filter(entries[i]))
			: index.search(minX, minY, maxX, maxY);

		return found.map(i => entries[i]);
	}

	// The same search written from the middle out: everything within `reachX` / `reachY` of (x, y) on each axis.
	// This is the form most game searches are actually in - something looking a certain distance around itself -
	// and it saves every caller writing the same four sums.
	searchAround(x: number, y: number, reachX: number, reachY: number, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		return this.search(x - reachX, y - reachY, x + reachX, y + reachY, filter);
	}

	// The closest entity to (x, y) that `filter` accepts, or undefined when there is none within `maxDistance`.
	//
	// This is a walk of the tree in distance order rather than a search followed by a sort: it settles on an
	// answer as soon as the nearest box is reached, and never measures the far side of the world at all.  So a
	// game asking "who is nearest" should ask it this way rather than searching a box and sorting what comes
	// back - and `maxDistance` is what keeps it from walking the whole tree when the answer is that nobody is.
	//
	// Distance is to the entity's **box**, not to its centre, so a big thing is as near as its nearest edge -
	// which is what a ship closing on a station wants, and it makes `maxDistance` a range past the hull rather
	// than a range that a large enough target could sit outside of while overlapping the searcher.
	findNearest(x: number, y: number, maxDistance = Infinity, filter?: SpatialFilter<T>): SpatialEntity<T> | undefined {
		return this.findNearby(x, y, 1, maxDistance, filter)[0];
	}

	// The `maxResults` closest entities to (x, y), nearest first, on the same terms as findNearest - for a game
	// that wants a few to choose between rather than only the one.
	findNearby(x: number, y: number, maxResults: number, maxDistance = Infinity, filter?: SpatialFilter<T>): Array<SpatialEntity<T>> {
		const index = this.index;
		if(!index) {
			return [];
		}

		const entries = this.entries;
		// Handed to Flatbush rather than applied afterwards so that `maxResults` counts entities the game actually
		// wants: filtering after the fact would let a handful of rejects use up the whole allowance and return
		// nothing while a valid target sat just behind them.
		const found = filter ? index.neighbors(x, y, maxResults, maxDistance, i => filter(entries[i]))
			: index.neighbors(x, y, maxResults, maxDistance);

		return found.map(i => entries[i]);
	}
}
