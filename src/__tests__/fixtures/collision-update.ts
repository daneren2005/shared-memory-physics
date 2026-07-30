import { createPhysicsUpdate } from '../../systems/physics-update';
import type { PhysicsUpdateComponents } from '../../components/registry';
import { type Components, HEALTH_INDEX } from './world';

// The blocks this update touches: the two physics needs, plus the game's own health, which either side of a
// collision may or may not have.
export type CollisionUpdateComponents = PhysicsUpdateComponents & {
	health?: Float32Array
};

// What the entity that moved takes, and what it does to whatever it landed on.  Deliberately different so a
// test can tell the two sides of a collision apart: `self` is called once for the entity that moved, and the
// entity it hit only gets its own call if it moves too.
export const SELF_DAMAGE = 2;
export const OTHER_DAMAGE = 1;

// Mirrors the module a game writes for a physics system with collisions: one place builds the update, and
// both the worker entry file and the main thread system import it from here, so the two backends can never
// drift apart.  The callback is baked in rather than passed to PhysicsSystem because a function cannot be
// sent to a worker - it has to arrive there through this import.
export const collisionUpdate = createPhysicsUpdate<Components, CollisionUpdateComponents>({
	optional: ['health'],
	onCollision(world, self, other, queries, callbacks) {
		damage(self.entityId, self.components.health, SELF_DAMAGE, callbacks);
		damage(other.entityId, other.components.health, OTHER_DAMAGE, callbacks);
	},
});

function damage(entityId: number, health: Float32Array | undefined, amount: number, callbacks: { entityDied(entityId: number): void }): void {
	if(!health) {
		return;
	}

	health[HEALTH_INDEX] -= amount;
	if(health[HEALTH_INDEX] <= 0) {
		// Reported back to the main thread rather than done here: the worker has the blocks, not the entities.
		callbacks.entityDied(entityId);
	}
}

export default collisionUpdate;
