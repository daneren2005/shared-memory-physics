import { loadFloat32 } from '@daneren2005/shared-memory-objects/utils/float32-atomics';
import type { EntityUpdateFunction } from '@daneren2005/shared-memory-ecs';
import type { InterpolationComponents, InterpolationUpdateComponents } from '../components/registry';
import {
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_PREV_X_INDEX,
	INTERPOLATION_PREV_Y_INDEX,
	INTERPOLATION_PROGRESS_INDEX,
	INTERPOLATION_SYNCED_TICK_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_X_INDEX,
	INTERPOLATION_Y_INDEX,
} from '../components/interpolation-component';
import { TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';

// Walks the render position along the segment between where the entity was before the last physics step and
// where it is after it: `render = prev + (current - prev) * progress`.
//
// Every position it writes is one the simulation actually produced, so an entity is drawn easing into a wall or
// turning a corner because that is what happened - not guessed forward from velocity and snapped back. The cost
// is one fixed step of latency, always, in exchange for never being wrong.
//
// Two rules cover the pacing: advance by `elapsedTime / duration` of the segment each frame, and restart on the
// next step when it lands, dropping whatever was left of the old segment. None of it is read off the physics
// system's accumulator, which resets when a run is posted, not when it lands - different moments on a worker
// thread, and the source of a stutter whenever a run takes longer than a frame. Instead the segment's `duration`
// is published with it, so a late run just banks more time and the next segment covers it; a slow run costs
// latency and nothing else.
export const interpolationUpdate: EntityUpdateFunction<InterpolationComponents, InterpolationUpdateComponents> = (world, entityId, components) => {
	const interpolation = components.interpolation;
	const transform = components.transform;

	// The stamp is read on both sides of everything it publishes: physics may be moving this entity on another
	// thread, and a `prev` from after the move with a transform from before draws it walking backwards.
	const before = loadFloat32(interpolation, INTERPOLATION_TICK_INDEX);
	const prevX = interpolation[INTERPOLATION_PREV_X_INDEX];
	const prevY = interpolation[INTERPOLATION_PREV_Y_INDEX];
	const duration = interpolation[INTERPOLATION_DURATION_INDEX];
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
		interpolation[INTERPOLATION_X_INDEX] = x;
		interpolation[INTERPOLATION_Y_INDEX] = y;

		return;
	}

	let progress = interpolation[INTERPOLATION_PROGRESS_INDEX];
	if(after !== interpolation[INTERPOLATION_SYNCED_TICK_INDEX]) {
		// A step landed: restart at its beginning, which is where the entity was just drawn anyway (the new
		// segment's `prev` is the old one's end). Whatever was left undrawn is dropped rather than carried -
		// carrying it could only be a deficit, which pins the entity at `prev` and never gets paid off.
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

	interpolation[INTERPOLATION_X_INDEX] = prevX + (x - prevX) * progress;
	interpolation[INTERPOLATION_Y_INDEX] = prevY + (y - prevY) * progress;
};

export default interpolationUpdate;
