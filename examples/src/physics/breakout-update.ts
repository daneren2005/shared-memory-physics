import { BODY_CATEGORY_INDEX, createPhysicsUpdate } from '@daneren2005/shared-memory-physics';
import type { Components } from '../world';

// The collide category the breakout example loads its bricks with.  It is a tag, not a filter: every body still
// collides with every other (the ball bounces off bricks, walls and the paddle all the same), and this only
// gives the collision callback below a way to tell a brick apart from everything else the ball runs into.  Bit 1
// rather than the default bit 0, so a plain body - the ball, the paddle, the walls - is never mistaken for one.
export const BRICK_CATEGORY = 1 << 1;

// The breakout backend: the same sweep-and-bounce every example runs, plus one collision callback that kills a
// brick when the ball hits it.  Unlike the main-thread overlap tests the sensors example does, this runs *in the
// physics thread* - the worker, or the in-process fallback - which is why it is baked into an update function
// both the worker file and the main thread import, rather than passed in: a function cannot be sent to a worker.
//
// By the time the callback runs the ball has already been turned around off the brick natively (the bounce runs
// first, in the same pass over what the ball overlaps), so killing the brick here takes it away a beat after the
// bounce it caused - never out from in front of a ball that has not bounced yet.  `entityDied` does not free
// anything on the spot; it flags the entity and reports it, and the main thread removes it, which is what the
// game listens for to score it.
export const breakoutUpdate = createPhysicsUpdate<Components>({
	onCollision(_world, _self, other, _queries, callbacks) {
		// `other` is whatever the moving entity ran into.  Only the ball and the paddle ever move, and only the
		// ball ever reaches the bricks, so a brick found here is one the ball just bounced off - identified by the
		// category it was loaded with, read straight off its shared body block.
		if(other.components.body[BODY_CATEGORY_INDEX] === BRICK_CATEGORY) {
			callbacks.entityDied(other.entityId);
		}
	},
});

export default breakoutUpdate;
