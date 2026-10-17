import type { BaseEntity, ComponentMap, EntityWorkerSystemQuery } from '@daneren2005/shared-memory-ecs';
import { BODY_FLAGS_INDEX, BODY_SHAPE_MASK } from '../components/body-component-constants';
import type { BodyComponent } from '../components/body-component';
import {
	TRANSFORM_ANGLE_INDEX,
	TRANSFORM_HEIGHT_INDEX,
	TRANSFORM_WIDTH_INDEX,
	TRANSFORM_X_INDEX,
	TRANSFORM_Y_INDEX,
} from '../components/transform-component-constants';
import type { TransformComponent } from '../components/transform-component';
import { shapeHalfHeight, shapeHalfWidth } from '../math/shapes';
import type NavGrid from './nav-grid';
import type { Rect } from './nav-grid';

export const PATH_BLOCKERS_QUERY = 'pathBlockers';
// Bodies in a gate category, which only stop movers whose collide mask takes that category in.
export const PATH_GATES_QUERY = 'pathGates';

export type PathBlockerComponents = {
	transform: TransformComponent
	body: BodyComponent
};

// Structural so a delta from any game's component map fits.
export interface PathBlockerDelta {
	added: ReadonlyArray<{ entityId: number, components: { transform?: unknown, body?: unknown } }>
	removed: ReadonlyArray<number>
}

export interface PathBlockerQueryOptions<C extends ComponentMap> {
	gateCategories?: number
	// Narrows both queries, e.g. `not: ['construction']` so a building site blocks nothing until it is finished.
	not?: Array<keyof C>
	filter?: (entity: BaseEntity<C>) => boolean
}

// The blocker and gate queries PathfindingSystem builds its grids from, for another system wanting the same view.
export function pathBlockerQueries<C extends ComponentMap & PathBlockerComponents>(options: PathBlockerQueryOptions<C> = {}): Record<string, EntityWorkerSystemQuery<C>> {
	const { gateCategories = 0, not, filter } = options;
	const blockers: EntityWorkerSystemQuery<C> = {
		required: ['transform', 'body'],
		not,
		filter: entity => {
			const body = entity.components.body;
			return !!body && body.blocksPath && !body.sensor && (!filter || filter(entity));
		},
	};
	if(!gateCategories) {
		return { [PATH_BLOCKERS_QUERY]: blockers };
	}
	const gates: EntityWorkerSystemQuery<C> = {
		required: ['transform', 'body'],
		not,
		filter: entity => {
			const body = entity.components.body;
			return !!body && !body.blocksPath && !body.sensor && (body.collideCategory & gateCategories) !== 0 && (!filter || filter(entity));
		},
	};
	return { [PATH_BLOCKERS_QUERY]: blockers, [PATH_GATES_QUERY]: gates };
}

// The axis-aligned box a body covers. A body turned by a right angle is snapped to it so float noise in the angle does
// not grow the box into the next tile.
export function blockerRect(transform: Float32Array, body: Uint32Array): Rect {
	const shape = body[BODY_FLAGS_INDEX] & BODY_SHAPE_MASK;
	const width = transform[TRANSFORM_WIDTH_INDEX];
	const height = transform[TRANSFORM_HEIGHT_INDEX];
	const angle = snappedRightAngle(transform[TRANSFORM_ANGLE_INDEX]);
	const halfWidth = shapeHalfWidth(shape, width, height, angle);
	const halfHeight = shapeHalfHeight(shape, width, height, angle);
	const x = transform[TRANSFORM_X_INDEX];
	const y = transform[TRANSFORM_Y_INDEX];
	return { minX: x - halfWidth, minY: y - halfHeight, maxX: x + halfWidth, maxY: y + halfHeight };
}

// Blockers are assumed never to move, so each is rasterised once when it joins and cleared by the same rect when it
// leaves. Returns whether any were added.
export function applyRectChanges(rects: Map<number, Rect>, grids: Iterable<NavGrid>, delta: PathBlockerDelta): boolean {
	const targets = [...grids];
	for(const entityId of delta.removed) {
		const rect = rects.get(entityId);
		if(rect) {
			targets.forEach(grid => grid.removeBlocker(rect));
			rects.delete(entityId);
		}
	}
	for(const { entityId, components } of delta.added) {
		// `added` also re-sends an existing member whose components changed.
		const previous = rects.get(entityId);
		if(previous) {
			targets.forEach(grid => grid.removeBlocker(previous));
		}
		const { transform, body } = components;
		if(!(transform instanceof Float32Array) || !(body instanceof Uint32Array)) {
			rects.delete(entityId);
			continue;
		}
		const rect = blockerRect(transform, body);
		targets.forEach(grid => grid.addBlocker(rect));
		rects.set(entityId, rect);
	}
	return delta.added.length > 0;
}

function snappedRightAngle(angle: number): number {
	const snapped = Math.round(angle / (Math.PI / 2)) * Math.PI / 2;
	return Math.abs(angle - snapped) < 1e-5 ? snapped : angle;
}
