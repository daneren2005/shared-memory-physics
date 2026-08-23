import { BODY_CATEGORY_INDEX, createPhysicsUpdate } from '@daneren2005/shared-memory-physics';
import type { DeathInterpolationEntity, PhysicsWorld } from '@daneren2005/shared-memory-physics';
import type { Components } from '../world';

// The collide categories the bullet-hell example loads its entities with.  They are tags the collision callback
// reads to tell one kind of entity apart from another, and they double as the bits the masks below are built
// from - a body collides *as* its category and *with* whatever its mask names (see the README on filtering).
//
// WALL_CATEGORY is bit 0, which is the library's own default, so the four level walls - loaded by the page with
// no category of their own - fall into it for free and the bullets can name them in a mask.
export const WALL_CATEGORY = 1 << 0;
export const PLAYER_CATEGORY = 1 << 1;
export const OBSTACLE_CATEGORY = 1 << 2;
export const BULLET_CATEGORY = 1 << 3;
export const TURRET_CATEGORY = 1 << 4;

// The event the callback raises on the player the frame a bullet reaches it, so the main thread can tally the
// hit.  It carries nothing - the fact of it is the whole message - and the game counts one per firing.
export const PLAYER_HIT_EVENT = 'player-hit';

// The bullet-hell backend: the same sweep every example runs, plus one collision callback that kills a bullet
// the moment it touches anything and, if that anything was the player, reports the hit.  Bullets are loaded as
// sensors, so this callback is the *only* thing that acts on a bullet contact - the sweep never stops one and
// nothing bounces off it, which is what lets a bullet pass straight through the player (a sensor blocks no
// movement) while still being caught here and counted.
//
// Like the breakout backend, this runs in the physics thread - the worker, or the in-process fallback - so it is
// baked into an update function both the worker file and the main thread import rather than passed in: a
// function cannot be sent to a worker.  Anything it needs to do back on the main thread (remove a dead bullet,
// raise the hit event) goes through `callbacks`.
export const bulletHellUpdate = createPhysicsUpdate<Components>({
	onCollision(world, self, other, _queries, callbacks) {
		const selfBody = self.components.body;
		const otherBody = other.components.body;
		// A collision callback only ever fires for two bodies, so both are present; the guard is for the type.
		if(!selfBody || !otherBody) {
			return;
		}

		// A bullet is only ever hitting one other thing here (it never collides with another bullet - its mask
		// leaves its own category out), so whichever side carries the bullet category is the one to kill, and the
		// other side is what it ran into.  Either can be `self`: the bullet if it reached the contact on its own
		// move, the player if it moved into the bullet first - the outcome is the same either way.
		if(selfBody[BODY_CATEGORY_INDEX] === BULLET_CATEGORY) {
			killBullet(world, self, other, otherBody[BODY_CATEGORY_INDEX], callbacks);
		} else if(otherBody[BODY_CATEGORY_INDEX] === BULLET_CATEGORY) {
			killBullet(world, other, self, selfBody[BODY_CATEGORY_INDEX], callbacks);
		}
	},
});

// Kills the bullet and, when the thing it hit was the player, raises the hit event on the player.  The kill goes
// through `dieAtImpact` rather than `entityDied` so a fast bullet is drawn reaching what it hit before it vanishes,
// instead of blinking out a stride short: it ends the bullet's last interpolation segment on the impact point and
// removes it a run later, once that segment has had a step to render (see the physics update).  The hit is still
// raised on the spot, so the tally is unaffected by the deferred removal.  `dieAtImpact` is always present here -
// createPhysicsUpdate sets it every run - but the plain `entityDied` fallback keeps this correct if it is not.
function killBullet(
	world: PhysicsWorld,
	bullet: DeathInterpolationEntity,
	target: DeathInterpolationEntity,
	targetCategory: number,
	callbacks: { entityDied(id: number): void, emitEntityEvent(id: number, event: string): void },
): void {
	if(world.dieAtImpact) {
		world.dieAtImpact(bullet, target);
	} else {
		callbacks.entityDied(bullet.entityId);
	}
	if(targetCategory === PLAYER_CATEGORY) {
		callbacks.emitEntityEvent(target.entityId, PLAYER_HIT_EVENT);
	}
}

export default bulletHellUpdate;
