import { loadFloat32 } from '@daneren2005/shared-memory-objects';
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
// where it is after it.
//
//   render = prev + (current - prev) * alpha
//
// **Every position this writes is one the simulation actually produced** - somewhere on a segment between two
// real positions - which is what it buys over guessing forward from the current position and a velocity.  An
// entity that stopped against a wall is drawn easing into the wall and stopping, because that is what happened;
// one that turned a corner is drawn turning the corner, rather than continuing into the old heading for a frame
// and then being snapped back.  There is nothing to tune and no case where it draws something the entity did
// not do.
//
// The cost is one step of latency, always: what is on screen is where the world was a step ago, not where it is
// now.  At a 50ms step that is 50ms behind on every entity, in exchange for never being wrong.
//
// ## How far along the segment to draw
//
// Two rules, and between them they are the whole of it:
//
//  1. **Advance by a frame's worth of the segment, every frame.**  A segment covers `duration` milliseconds of
//     simulated time and the frame just drawn covered `elapsedTime` of it, so the render position moves
//     `elapsedTime / duration` of the way along.  That is the same size every frame however the frames and the
//     steps happen to line up, which is what smooth means.
//  2. **Start the next segment when it lands, and drop whatever was left of the old one.**  It is only ever a
//     small remainder - the cap below means a segment is never overshot - and it cannot be carried: see the
//     note at the reset for why a deficit is the one thing this arithmetic cannot draw.
//
// ## Why none of this is read off the physics system
//
// The tempting clock is the physics system's own accumulator: `currentDelta / deltaBetweenRuns` sweeps 0 -> 1
// once per step with nothing to keep in sync.  It is also **wrong**, and wrong in exactly the way that makes a
// 60fps page stutter whenever a physics run takes longer than a frame.
//
// That accumulator resets when a run is *posted*.  This block changes when that run *lands*, and on a worker
// thread those are different moments.  A run posted with 14ms of leftover and taking 30ms to come back leaves
// one whole frame where the accumulator says "0.3 of the way into the new step" while the block still holds the
// step before it - so the entity is drawn 0.3 along a segment it was drawn 0.96 along last frame.  Backwards,
// then a lurch forward when the step finally lands, on every single step.
//
// So the pacing is driven by what has actually arrived, and the segment's length is published with it rather
// than assumed to be the step: a run that comes back late leaves more than a step's worth of time banked, and
// the next one covers two steps at once.  A slow physics run then costs latency and nothing else, which is the
// entire point - a step drawn late but at the right speed looks identical to one drawn on time.
export const interpolationUpdate: EntityUpdateFunction<InterpolationComponents, InterpolationUpdateComponents> = (world, entityId, components) => {
	const interpolation = components.interpolation;
	const transform = components.transform;

	// The stamp is read on both sides of everything it publishes.  Physics may be moving this very entity on
	// another thread right now, and a `prev` from after the move paired with a transform from before it draws
	// the entity walking backwards along a segment it has already finished.
	const before = loadFloat32(interpolation, INTERPOLATION_TICK_INDEX);
	const prevX = interpolation[INTERPOLATION_PREV_X_INDEX];
	const prevY = interpolation[INTERPOLATION_PREV_Y_INDEX];
	const duration = interpolation[INTERPOLATION_DURATION_INDEX];
	const x = transform[TRANSFORM_X_INDEX];
	const y = transform[TRANSFORM_Y_INDEX];
	const after = loadFloat32(interpolation, INTERPOLATION_TICK_INDEX);

	// Caught mid-step, so the two ends do not belong together.  The render position is left exactly as it was
	// for this one frame rather than being drawn from a mismatched pair: an entity that holds still for 16ms is
	// invisible, and one that jumps to a position neither end of the segment agrees with is not.
	if(before !== after) {
		return;
	}

	// No segment to be part way along: an entity physics has never moved - a station, a wall - or one whose
	// first step has not landed yet.  Where it is is where to draw it.
	//
	// Progress is left *finished* rather than at zero, because that is what it means: there is nothing left to
	// draw of the nothing that has happened.  It is also what makes the first real step start from the right
	// place - the rule below takes one whole segment off whatever was banked, and taking it off zero would open
	// with a full segment of debt the entity could never work off.
	if(duration <= 0) {
		interpolation[INTERPOLATION_PROGRESS_INDEX] = 1;
		interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = after;
		interpolation[INTERPOLATION_X_INDEX] = x;
		interpolation[INTERPOLATION_Y_INDEX] = y;

		return;
	}

	let progress = interpolation[INTERPOLATION_PROGRESS_INDEX];
	if(after !== interpolation[INTERPOLATION_SYNCED_TICK_INDEX]) {
		// A step landed, so start again at the beginning of it - which is where the entity has just been drawn
		// anyway, because the new segment's `prev` is the old one's end.
		//
		// Whatever was left undrawn of the old segment is **dropped** rather than carried, and that is the whole
		// decision here.  Carrying it is only possible as a *deficit* - the cap below means progress can never
		// arrive above 1 - and a deficit cannot be drawn: there is no third position to blend back into, so a
		// negative progress just pins the entity at `prev`, which is further forward than where it was.  The debt
		// then never gets paid, grows by the same amount every step, and the entity lurches a whole segment each
		// time.  Dropping it costs a fraction of a frame on the step that lands early, and costs nothing at all
		// when the step and the frame divide into each other - which at a 50ms step and 60fps they do.
		progress = 0;
		interpolation[INTERPOLATION_SYNCED_TICK_INDEX] = after;
	}

	// Capped at the end of the segment, which is what absorbs a slow physics run.  While waiting for the next
	// step the entity sits at the newest position the simulation actually produced, and the time spent waiting
	// is **dropped** rather than banked - so when the step does land there is no debt to spend all at once and
	// the next frame carries on at the same speed as every other.  A worker that is consistently 30ms late costs
	// 30ms of latency and nothing else; only *variance* in how late it is can be seen at all.
	progress += world.elapsedTime / duration;
	if(progress > 1) {
		progress = 1;
	}
	interpolation[INTERPOLATION_PROGRESS_INDEX] = progress;

	interpolation[INTERPOLATION_X_INDEX] = prevX + (x - prevX) * progress;
	interpolation[INTERPOLATION_Y_INDEX] = prevY + (y - prevY) * progress;
};

export default interpolationUpdate;
