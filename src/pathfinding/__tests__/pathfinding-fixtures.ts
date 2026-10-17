import type { ComponentsOf, EntityWorkerSystemCallbacks, EntityWorkerSystemInitWorld } from '@daneren2005/shared-memory-ecs';
import { BODY_CATEGORY_INDEX, BODY_FLAGS_INDEX, BODY_MASK_INDEX, BODY_SIZE, SHAPE_RECTANGLE } from '../../components/body-component-constants';
import { NAVIGATION_SIZE } from '../../components/navigation-component-constants';
import { navigationRegistry, physicsRegistry } from '../../components/registry';
import PhysicalWorld from '../../world';
import { TRANSFORM_HEIGHT_INDEX, TRANSFORM_SIZE, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component-constants';

// Blocks and callbacks for driving the pathfinding update directly, without a world.
function ignore() {}

export function stubCallbacks(): EntityWorkerSystemCallbacks {
	return {
		entityComponentChanged: ignore,
		emitEntityEvent: ignore,
		emitSystemEvent: ignore,
		entityDied: ignore,
		createEntity: ignore,
		addComponent: ignore,
		removeComponent: ignore,
	};
}

export function initWorld(): EntityWorkerSystemInitWorld {
	return { gameTime: 0, getString: () => '' };
}

export function transformBlock(x: number, y: number, width = 32, height = 32): Float32Array {
	const transform = new Float32Array(TRANSFORM_SIZE);
	transform[TRANSFORM_X_INDEX] = x;
	transform[TRANSFORM_Y_INDEX] = y;
	transform[TRANSFORM_WIDTH_INDEX] = width;
	transform[TRANSFORM_HEIGHT_INDEX] = height;
	return transform;
}

export function bodyBlock({ category = 0, mask = 0 }: { category?: number, mask?: number } = {}): Uint32Array {
	const body = new Uint32Array(BODY_SIZE);
	body[BODY_FLAGS_INDEX] = SHAPE_RECTANGLE;
	body[BODY_CATEGORY_INDEX] = category;
	body[BODY_MASK_INDEX] = mask;
	return body;
}

export function navigationBlock(): Int32Array {
	return new Int32Array(NAVIGATION_SIZE);
}

export const navigationTestRegistry = { ...physicsRegistry, ...navigationRegistry };
export type NavigationTestComponents = ComponentsOf<typeof navigationTestRegistry>;

export function createNavigationWorld(): PhysicalWorld<typeof navigationTestRegistry> {
	return new PhysicalWorld(navigationTestRegistry, { spatial: { gridSize: 50, maxEntities: 100, maxSlots: 1_000 } });
}
