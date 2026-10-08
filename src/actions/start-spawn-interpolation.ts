import type { TransformComponent } from '../components/transform-component';
import type { VelocityComponent } from '../components/velocity-component';
import type { InterpolationComponent } from '../components/interpolation-component';

export interface SpawnableEntity {
	components: {
		transform?: TransformComponent
		velocity?: VelocityComponent
		interpolation?: InterpolationComponent
	}
}

export interface SpawnInterpolationOptions {
	stepMs: number
	// Elapsed fraction of the current step, clamped to 0..1.
	stepFraction: number
	// Last physics tick so the first real step is recognized as a new publication.
	tick: number
}

// Jump the transform ahead without a sweep; the render starts at spawn and catches up by the next step.
export function startSpawnInterpolation(entity: SpawnableEntity, options: SpawnInterpolationOptions): void {
	const { transform, velocity, interpolation } = entity.components;
	if(!transform || !velocity || !interpolation) {
		return;
	}

	const fraction = options.stepFraction < 0 ? 0 : options.stepFraction > 1 ? 1 : options.stepFraction;
	const remaining = 1 - fraction;
	const seconds = options.stepMs / 1000;
	const spawnX = transform.x;
	const spawnY = transform.y;
	const jumpX = velocity.velocityX * seconds * remaining;
	const jumpY = velocity.velocityY * seconds * remaining;

	transform.x = spawnX + jumpX;
	transform.y = spawnY + jumpY;
	interpolation.x = spawnX;
	interpolation.y = spawnY;
	interpolation.duration = options.stepMs * remaining;
	interpolation.syncedTick = options.tick;
	interpolation.totalDuration += interpolation.duration;
	interpolation.syncedDuration = interpolation.totalDuration;
	interpolation.remainingDuration = interpolation.duration;
	interpolation.targetX = transform.x;
	interpolation.targetY = transform.y;
	interpolation.syncedStepDuration = interpolation.duration;
	// Publish the stamp last so readers see the completed target and timing.
	interpolation.tick = options.tick;
}

