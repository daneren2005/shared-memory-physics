import { loadFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import { BACKLOG_CATCHUP_RATE, BACKLOG_TARGET_STEPS } from '../constants';
import type { EntityUpdateFunction, EntityWorkerSystemWorld } from '@daneren2005/shared-memory-ecs';
import type { InterpolationComponents, InterpolationUpdateComponents } from '../components/registry';
import {
	INTERPOLATION_CHANNEL_INDEX,
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_TICK_INDEX,
	INTERPOLATION_PREVIOUS_TOTAL_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_X_INDEX,
	INTERPOLATION_PREVIOUS_Y_INDEX,
	INTERPOLATION_TARGET_X_INDEX,
	INTERPOLATION_TARGET_Y_INDEX,
	INTERPOLATION_SYNCED_STEP_DURATION_INDEX,
	INTERPOLATION_REMAINING_DURATION_INDEX,
	INTERPOLATION_SYNCED_DURATION_INDEX,
	INTERPOLATION_SYNCED_TICK_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_TOTAL_DURATION_INDEX,
	INTERPOLATION_X_INDEX,
	INTERPOLATION_Y_INDEX,
} from '../components/interpolation-component-constants';
import { TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component-constants';

export interface InterpolationWorld extends EntityWorkerSystemWorld {
	// Committed physics tick per interpolation channel, snapshotted once per run by InterpolationSystem.
	committedTicks?: Array<number>
}

// Consume published simulation time while advancing toward the last coherent target.
export const interpolationUpdate: EntityUpdateFunction<InterpolationComponents, InterpolationUpdateComponents, InterpolationWorld> = (world, entityId, components) => {
	const interpolation = components.interpolation;
	const transform = components.transform;

	// Accept the transform and timing only if physics completed one consistent publication.
	const before = loadFloat32(interpolation, INTERPOLATION_TICK_INDEX);
	let duration = interpolation[INTERPOLATION_DURATION_INDEX];
	let totalDuration = interpolation[INTERPOLATION_TOTAL_DURATION_INDEX];
	let x = transform[TRANSFORM_X_INDEX];
	let y = transform[TRANSFORM_Y_INDEX];
	let after = loadFloat32(interpolation, INTERPOLATION_TICK_INDEX);
	let coherent = before === after;

	// A torn or not-yet-committed publication falls back to the one it replaced, so every entity of a physics run
	// renders the same step even while the worker is part way through publishing it.
	const committedTick = world.committedTicks?.[interpolation[INTERPOLATION_CHANNEL_INDEX]];
	if(committedTick !== undefined && !Number.isNaN(committedTick) && !(coherent && after <= committedTick)) {
		const previousBefore = loadFloat32(interpolation, INTERPOLATION_PREVIOUS_TICK_INDEX);
		duration = interpolation[INTERPOLATION_PREVIOUS_DURATION_INDEX];
		totalDuration = interpolation[INTERPOLATION_PREVIOUS_TOTAL_DURATION_INDEX];
		x = interpolation[INTERPOLATION_PREVIOUS_X_INDEX];
		y = interpolation[INTERPOLATION_PREVIOUS_Y_INDEX];
		after = loadFloat32(interpolation, INTERPOLATION_PREVIOUS_TICK_INDEX);
		coherent = previousBefore === after;
	}

	if(!coherent) {
		// Keep consuming the last coherent segment; dropping this frame makes moving ships stutter relative to a camera.
		duration = interpolation[INTERPOLATION_SYNCED_STEP_DURATION_INDEX];
		if(duration <= 0 || interpolation[INTERPOLATION_REMAINING_DURATION_INDEX] <= 0) {
			return;
		}
		x = interpolation[INTERPOLATION_TARGET_X_INDEX];
		y = interpolation[INTERPOLATION_TARGET_Y_INDEX];
		totalDuration = interpolation[INTERPOLATION_SYNCED_DURATION_INDEX];
		after = interpolation[INTERPOLATION_SYNCED_TICK_INDEX];
	} else {
		interpolation[INTERPOLATION_TARGET_X_INDEX] = x;
		interpolation[INTERPOLATION_TARGET_Y_INDEX] = y;
		interpolation[INTERPOLATION_SYNCED_STEP_DURATION_INDEX] = duration;
	}

	// No physics segment has been published yet.
	if(duration <= 0) {
		interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = after;
		interpolation[INTERPOLATION_SYNCED_DURATION_INDEX] = totalDuration;
		interpolation[INTERPOLATION_REMAINING_DURATION_INDEX] = 0;
		interpolation[INTERPOLATION_X_INDEX] = x;
		interpolation[INTERPOLATION_Y_INDEX] = y;

		return;
	}

	let remainingDuration = interpolation[INTERPOLATION_REMAINING_DURATION_INDEX];
	if(after !== interpolation[INTERPOLATION_SYNCED_TICK_INDEX]) {
		const syncedDuration = interpolation[INTERPOLATION_SYNCED_DURATION_INDEX];
		const publishedDuration = totalDuration >= syncedDuration ? totalDuration - syncedDuration : duration;
		remainingDuration += publishedDuration;
		interpolation[INTERPOLATION_SYNCED_DURATION_INDEX] = totalDuration;
		interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = after;
	}

	if(remainingDuration <= 0) {
		interpolation[INTERPOLATION_REMAINING_DURATION_INDEX] = 0;
		interpolation[INTERPOLATION_X_INDEX] = x;
		interpolation[INTERPOLATION_Y_INDEX] = y;
		return;
	}

	let frameDuration = Math.min(Math.max(world.elapsedTime, 0), remainingDuration);
	// Ease off a persistent backlog. Once physics publishes every frame (high timeScale, a step lands per frame)
	// the budget added per frame matches the budget spent, so a backlog banked by a one-off slow run would never
	// drain on its own - the render would trail the simulation by it forever. Spend a little extra on the part of
	// the backlog beyond one step of latency, bounded so the render eases back rather than jumping across it. Below
	// the target this never fires, leaving normal one-step-latency pacing exactly as it was.
	const targetBacklog = duration * BACKLOG_TARGET_STEPS;
	const backlogAfterFrame = remainingDuration - frameDuration;
	if(backlogAfterFrame > targetBacklog) {
		frameDuration += Math.min(backlogAfterFrame - targetBacklog, frameDuration * BACKLOG_CATCHUP_RATE);
	}
	const frameProgress = frameDuration / remainingDuration;
	const renderX = interpolation[INTERPOLATION_X_INDEX];
	const renderY = interpolation[INTERPOLATION_Y_INDEX];
	interpolation[INTERPOLATION_X_INDEX] = renderX + (x - renderX) * frameProgress;
	interpolation[INTERPOLATION_Y_INDEX] = renderY + (y - renderY) * frameProgress;
	interpolation[INTERPOLATION_REMAINING_DURATION_INDEX] = remainingDuration - frameDuration;
};

export default interpolationUpdate;
