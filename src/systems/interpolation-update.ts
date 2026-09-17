import { loadFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import type { EntityUpdateFunction } from '@daneren2005/shared-memory-ecs';
import type { InterpolationComponents, InterpolationUpdateComponents } from '../components/registry';
import {
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_PROGRESS_INDEX,
	INTERPOLATION_REMAINING_DURATION_INDEX,
	INTERPOLATION_SYNCED_DURATION_INDEX,
	INTERPOLATION_SYNCED_TICK_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_TOTAL_DURATION_INDEX,
	INTERPOLATION_X_INDEX,
	INTERPOLATION_Y_INDEX,
} from '../components/interpolation-component';
import { TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';

// The render trails the simulation by a bounded backlog. Up to this many steps is the ordinary one-step latency
// plus headroom for a normal multi-step handover, left to drain on its own. Past it, the excess is a persistent
// trail (a one-off slow run that never drains when physics publishes every frame) and is eased off.
export const BACKLOG_TARGET_STEPS = 1.5;
// How much of a frame's budget the ease-off may spend on top of the frame itself, so catching up reads as a
// gentle speed-up rather than a jump across the banked segment.
export const BACKLOG_CATCHUP_RATE = 0.5;

// Walks the render position along the segment between where the entity was before the last physics step and
// where it is after it: `render = prev + (current - prev) * progress`.
//
// Every position it writes is one the simulation actually produced, so an entity is drawn easing into a wall or
// turning a corner because that is what happened - not guessed forward from velocity and snapped back. The cost
// is one fixed step of latency, always, in exchange for never being wrong.
//
// Physics also publishes cumulative simulated time. Rendering turns newly observed time into one continuous
// timeline toward the latest transform, so a fast follow-up publication cannot overwrite an unfinished long
// segment and make the render jump to the follow-up's `prev`.
export const interpolationUpdate: EntityUpdateFunction<InterpolationComponents, InterpolationUpdateComponents> = (world, entityId, components) => {
	const interpolation = components.interpolation;
	const transform = components.transform;

	// The stamp is read on both sides of everything it publishes: physics marks it NaN before writing and replaces
	// that marker afterward. A `prev` from after the move with a transform from before draws it walking backwards.
	const before = loadFloat32(interpolation, INTERPOLATION_TICK_INDEX);
	const duration = interpolation[INTERPOLATION_DURATION_INDEX];
	const totalDuration = interpolation[INTERPOLATION_TOTAL_DURATION_INDEX];
	const x = transform[TRANSFORM_X_INDEX];
	const y = transform[TRANSFORM_Y_INDEX];
	const after = loadFloat32(interpolation, INTERPOLATION_TICK_INDEX);

	// Caught mid-step, so the two ends do not belong together. Leave the render position for this one frame
	// rather than drawing from a mismatched pair - a 16ms hold is invisible, a jump is not.
	if(before !== after) {
		return;
	}

	// No segment to be part way along: an entity physics never moved, or one whose first step has not landed.
	// Progress is left finished, not zero, so the first real step starts from the right place - the rule below
	// takes a whole segment off whatever was banked, and taking it off zero would open with unpayable debt.
	if(duration <= 0) {
		interpolation[INTERPOLATION_PROGRESS_INDEX] = 1;
		interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = after;
		interpolation[INTERPOLATION_SYNCED_DURATION_INDEX] = totalDuration;
		interpolation[INTERPOLATION_REMAINING_DURATION_INDEX] = 0;
		interpolation[INTERPOLATION_X_INDEX] = x;
		interpolation[INTERPOLATION_Y_INDEX] = y;

		return;
	}

	let progress = interpolation[INTERPOLATION_PROGRESS_INDEX];
	let remainingDuration = interpolation[INTERPOLATION_REMAINING_DURATION_INDEX];
	if(after !== interpolation[INTERPOLATION_SYNCED_TICK_INDEX]) {
		const syncedDuration = interpolation[INTERPOLATION_SYNCED_DURATION_INDEX];
		const publishedDuration = totalDuration >= syncedDuration ? totalDuration - syncedDuration : duration;
		remainingDuration += publishedDuration;
		interpolation[INTERPOLATION_SYNCED_DURATION_INDEX] = totalDuration;
		progress = 0;
		interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = after;
	}

	// Capped at the segment end, which absorbs a slow physics run: the entity waits at the newest real position
	// and the wait is dropped, not banked, so a consistently-late worker costs latency and nothing else.
	progress += world.elapsedTime / duration;
	if(progress > 1) {
		progress = 1;
	}
	interpolation[INTERPOLATION_PROGRESS_INDEX] = progress;

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
