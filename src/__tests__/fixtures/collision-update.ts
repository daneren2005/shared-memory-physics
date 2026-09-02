import { createPhysicsUpdate } from '../../systems/physics-update';
import type { PhysicsUpdateComponents } from '../../components/registry';
import { BODY_CATEGORY_INDEX } from '../../components/body-component';
import { type Components, HEALTH_INDEX } from './world';

// The blocks this update touches: the two physics needs, plus the game's health.
export type CollisionUpdateComponents = PhysicsUpdateComponents & {
	health?: Float32Array
};

// Different values so a test can tell the two sides of a collision apart.
export const SELF_DAMAGE = 2;
export const OTHER_DAMAGE = 1;
export const COMMAND_VELOCITY_CATEGORY = 1 << 12;

// Mirrors the module a game writes for a collision physics system: both backends import the update from here, so
// they can never drift. The callback is baked in because a function cannot be sent to a worker.
export const collisionUpdate = createPhysicsUpdate<Components, CollisionUpdateComponents>({
	optional: ['health'],
	onCollision(world, self, other, queries, callbacks) {
		damage(self.entityId, self.components.health, SELF_DAMAGE, callbacks);
		damage(other.entityId, other.components.health, OTHER_DAMAGE, callbacks);
		if(self.components.body?.[BODY_CATEGORY_INDEX] === COMMAND_VELOCITY_CATEGORY) {
			world.queueVelocity(self.entityId, { velocityX: -12 });
		}
		if(other.components.body?.[BODY_CATEGORY_INDEX] === COMMAND_VELOCITY_CATEGORY) {
			world.queueVelocity(other.entityId, { velocityX: -12 });
		}
	},
});

function damage(entityId: number, health: Float32Array | undefined, amount: number, callbacks: { entityDied(entityId: number): void }): void {
	if(!health) {
		return;
	}

	health[HEALTH_INDEX] -= amount;
	if(health[HEALTH_INDEX] <= 0) {
		// Reported to the main thread: the worker has the blocks, not the entities.
		callbacks.entityDied(entityId);
	}
}

export default collisionUpdate;
