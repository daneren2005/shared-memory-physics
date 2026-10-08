import type { TransformComponent } from '../components/transform-component';
import type { InterpolationComponent } from '../components/interpolation-component';

export interface SnappableEntity {
	components: {
		transform?: TransformComponent
		interpolation?: InterpolationComponent
	}
}

// Reset interpolation after a teleport so it does not render as a long move.
export function snapEntity(entity: SnappableEntity): void {
	const { transform, interpolation } = entity.components;
	if(!transform || !interpolation) {
		return;
	}

	interpolation.targetX = interpolation.x = transform.x;
	interpolation.targetY = interpolation.y = transform.y;
	// A gated reader may still draw from the previous slot until the in-flight run commits.
	interpolation.previousX = transform.x;
	interpolation.previousY = transform.y;
	interpolation.remainingDuration = 0;
	interpolation.syncedStepDuration = 0;
	interpolation.syncedDuration = interpolation.totalDuration;
}

