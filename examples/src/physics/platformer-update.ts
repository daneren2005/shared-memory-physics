import {
	BODY_CATEGORY_INDEX,
	TRANSFORM_X_INDEX,
	VELOCITY_Y_INDEX,
	createPhysicsUpdate,
} from '@daneren2005/shared-memory-physics';
import type { Components } from '../world';

export const TERRAIN_CATEGORY = 1 << 0;
export const PLATFORMER_PLAYER_CATEGORY = 1 << 1;
export const ENEMY_CATEGORY = 1 << 2;
export const COIN_CATEGORY = 1 << 3;

export const PLAYER_LANDED_EVENT = 'platformer-player-landed';
export const PLAYER_HIT_EVENT = 'platformer-player-hit';

const PLAYER_KNOCKBACK_X = 480;
const PLAYER_KNOCKBACK_Y = -720;

export const platformerUpdate = createPhysicsUpdate<Components>({
	stopVelocityOnContact: true,
	onCollision(world, self, other, _queries, callbacks, contact) {
		const selfBody = self.components.body;
		const otherBody = other.components.body;
		if(!selfBody || !otherBody) {
			return;
		}

		const selfCategory = selfBody[BODY_CATEGORY_INDEX];
		const otherCategory = otherBody[BODY_CATEGORY_INDEX];
		if(selfCategory === COIN_CATEGORY && otherCategory === PLATFORMER_PLAYER_CATEGORY) {
			callbacks.entityDied(self.entityId);
		} else if(otherCategory === COIN_CATEGORY && selfCategory === PLATFORMER_PLAYER_CATEGORY) {
			callbacks.entityDied(other.entityId);
		}

		if(isPair(selfCategory, otherCategory, PLATFORMER_PLAYER_CATEGORY, ENEMY_CATEGORY)) {
			const player = selfCategory === PLATFORMER_PLAYER_CATEGORY ? self : other;
			const enemy = selfCategory === ENEMY_CATEGORY ? self : other;
			const playerTransform = player.components.transform;
			const enemyTransform = enemy.components.transform;
			if(playerTransform && enemyTransform) {
				const playerNormalX = selfCategory === PLATFORMER_PLAYER_CATEGORY ? contact.normalX : -contact.normalX;
				const direction = Math.sign(playerNormalX)
					|| Math.sign(playerTransform[TRANSFORM_X_INDEX] - enemyTransform[TRANSFORM_X_INDEX])
					|| 1;
				world.queueVelocity(player.entityId, {
					velocityX: direction * PLAYER_KNOCKBACK_X,
					velocityY: PLAYER_KNOCKBACK_Y,
				});
			}
			callbacks.emitEntityEvent(player.entityId, PLAYER_HIT_EVENT);
		}

		reportLanding(self, selfCategory, otherCategory, contact.normalY, callbacks);
		reportLanding(other, otherCategory, selfCategory, -contact.normalY, callbacks);
	},
});

function reportLanding(
	actor: { entityId: number, components: { velocity?: Float32Array } },
	actorCategory: number,
	terrainCategory: number,
	normalY: number,
	callbacks: { emitEntityEvent(id: number, event: string): void },
): void {
	if(terrainCategory !== TERRAIN_CATEGORY
		|| (actorCategory !== PLATFORMER_PLAYER_CATEGORY && actorCategory !== ENEMY_CATEGORY)) {
		return;
	}

	const actorVelocity = actor.components.velocity;
	if(!actorVelocity || actorVelocity[VELOCITY_Y_INDEX] < 0 || normalY >= -0.5) {
		return;
	}

	if(actorCategory === PLATFORMER_PLAYER_CATEGORY) {
		callbacks.emitEntityEvent(actor.entityId, PLAYER_LANDED_EVENT);
	}
}

function isPair(left: number, right: number, first: number, second: number): boolean {
	return (left === first && right === second) || (left === second && right === first);
}

export default platformerUpdate;
