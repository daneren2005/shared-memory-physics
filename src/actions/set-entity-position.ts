import type { EntityUpdateComponents } from '@daneren2005/shared-memory-ecs/worker';
import { storeFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import { TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import type { Vector } from '../math/shapes';
import type { PhysicalSystemWorld } from '../world';
import { updateSpatialMap } from '../systems/physics-update';

export function setEntityPosition(
	world: PhysicalSystemWorld, entity: { entityId: number, components: EntityUpdateComponents }, position: Vector,
): void {
	const transform = entity.components.transform;
	if(!(transform instanceof Float32Array)) {
		return;
	}
	storeFloat32(transform, TRANSFORM_X_INDEX, position.x);
	storeFloat32(transform, TRANSFORM_Y_INDEX, position.y);
	const body = entity.components.body;
	updateSpatialMap(world, entity.entityId, { transform, ...(body instanceof Uint32Array ? { body } : {}) });
}
