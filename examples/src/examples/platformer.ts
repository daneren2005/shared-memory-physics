import { snapEntity } from '@daneren2005/shared-memory-physics';
import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import type { Control } from '../controls';
import type { EntityStyle, Example, ExampleHost, ExampleRuntime, HudText } from '../example';
import {
	COIN_CATEGORY,
	ENEMY_CATEGORY,
	PLATFORMER_PLAYER_CATEGORY,
	PLAYER_HIT_EVENT,
	PLAYER_LANDED_EVENT,
	TERRAIN_CATEGORY,
} from '../physics/platformer-update';
import type { Components, Config } from '../world';

const PLAYER_WIDTH = 34;
const PLAYER_HEIGHT = 68;
const PLAYER_SPEED = 320;
const JUMP_SPEED = 980;
const RISE_GRAVITY = 3_200;
const RELEASE_GRAVITY = 6_400;
const FALL_GRAVITY = 4_800;
const COYOTE_TIME_MS = 100;
const JUMP_BUFFER_MS = 100;
const ENEMY_SPEED = 105;
const HIT_INVULNERABILITY_MS = 1_000;
const HIT_CONTROL_LOCK_MS = 250;
const HIT_FLASH_INTERVAL_MS = 100;

const PLAYER_COLOR = 0xE2E8F0;
const PLAYER_HIT_COLOR = 0xEF4444;
const ENEMY_COLOR = 0xFB7185;
const COIN_COLOR = 0xFACC15;

interface Patrol {
	entity: BaseEntity<Components, Config>
	minX: number
	maxX: number
	direction: -1 | 1
}

const keys = { left: false, right: false, jump: false };
const patrols: Array<Patrol> = [];
const coins = new Set<number>();
let host: ExampleHost | undefined;
let player: BaseEntity<Components, Config> | undefined;
let spawnX = 0;
let spawnY = 0;
let jumpLatched = false;
let coyoteTime = 0;
let jumpBuffer = 0;
let jumpAwaitingPhysics = false;
let collected = 0;
let hits = 0;
let invulnerability = 0;
let hitControlLock = 0;

export const platformer: Example = {
	id: 'platformer',
	title: 'Platformer',
	description: 'Run and jump through a small platform course as a stick figure. Enemies patrol their ledges, '
		+ 'knock the player away and trigger a brief damage flash, coins are sensor bodies collected by the collision '
		+ 'callback, and variable jump gravity is integrated on the physics backend. Use A/D or the arrow keys to move '
		+ 'and W, up, or space to jump. Collect every coin.',
	backend: 'platformer',
	physicsStep: 50,

	controls(hostArg): Array<Control> {
		host = hostArg;

		return [{ kind: 'button', label: 'Restart course', press: () => host?.restart() }];
	},

	create(runtime): void {
		const { world } = runtime;
		patrols.length = 0;
		coins.clear();
		collected = 0;
		hits = 0;
		invulnerability = 0;
		hitControlLock = 0;
		jumpLatched = keys.jump;
		coyoteTime = 0;
		jumpBuffer = 0;
		jumpAwaitingPhysics = false;

		loadPlatform(runtime, 600, 775, 1_200, 60);
		loadPlatform(runtime, 300, 620, 260, 28);
		loadPlatform(runtime, 620, 465, 280, 28);
		loadPlatform(runtime, 940, 600, 260, 28);
		loadPlatform(runtime, 955, 315, 270, 28);

		spawnX = 95;
		spawnY = 710;
		player = world.loadEntity({
			x: spawnX,
			y: spawnY,
			width: PLAYER_WIDTH,
			height: PLAYER_HEIGHT,
			velocityX: 0,
			velocityY: 0,
			accelerationY: FALL_GRAVITY,
			collideCategory: PLATFORMER_PLAYER_CATEGORY,
			collideMask: TERRAIN_CATEGORY | ENEMY_CATEGORY | COIN_CATEGORY,
			interpolate: true,
		});
		player.on(PLAYER_LANDED_EVENT, () => {
			coyoteTime = COYOTE_TIME_MS;
		});
		player.on(PLAYER_HIT_EVENT, () => {
			if(invulnerability <= 0) {
				hits++;
				invulnerability = HIT_INVULNERABILITY_MS;
				hitControlLock = HIT_CONTROL_LOCK_MS;
				jumpBuffer = 0;
				coyoteTime = 0;
				jumpAwaitingPhysics = false;
				setEnemyCollision(false);
			}
		});

		loadEnemy(runtime, 300, 570, 210, 390);
		loadEnemy(runtime, 620, 415, 520, 720);
		loadEnemy(runtime, 940, 550, 850, 1_030);
		loadEnemy(runtime, 955, 265, 850, 1_060);

		loadCoin(runtime, 300, 555);
		loadCoin(runtime, 520, 400);
		loadCoin(runtime, 720, 400);
		loadCoin(runtime, 860, 535);
		loadCoin(runtime, 1_035, 535);
		loadCoin(runtime, 860, 250);
		loadCoin(runtime, 1_050, 250);

		world.on('entity-removed', (entity: BaseEntity<Components, Config>) => {
			if(coins.delete(entity.eid)) {
				collected++;
			}
		});
	},

	update(runtime, elapsedTime): void {
		const currentPlayer = player;
		const playerVelocity = currentPlayer?.components.velocity;
		const playerTransform = currentPlayer?.components.transform;
		const playerDynamics = currentPlayer?.components.dynamics;
		if(!currentPlayer || !playerVelocity || !playerTransform || !playerDynamics) {
			return;
		}

		const wasInvulnerable = invulnerability > 0;
		invulnerability = Math.max(0, invulnerability - elapsedTime);
		hitControlLock = Math.max(0, hitControlLock - elapsedTime);
		if(wasInvulnerable && invulnerability === 0) {
			setEnemyCollision(true);
		}
		coyoteTime = Math.max(0, coyoteTime - elapsedTime);
		jumpBuffer = Math.max(0, jumpBuffer - elapsedTime);
		const jumpPressed = keys.jump && !jumpLatched;
		jumpLatched = keys.jump;
		if(jumpPressed) {
			jumpBuffer = JUMP_BUFFER_MS;
		}
		if(hitControlLock === 0) {
			playerVelocity.velocityX = ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * PLAYER_SPEED;
		}
		if(hitControlLock === 0 && jumpBuffer > 0 && coyoteTime > 0) {
			runtime.physics.queueVelocity(currentPlayer, { velocityY: -JUMP_SPEED });
			jumpBuffer = 0;
			coyoteTime = 0;
			jumpAwaitingPhysics = true;
		}
		if(jumpAwaitingPhysics && playerVelocity.velocityY < 0) {
			jumpAwaitingPhysics = false;
		}
		playerDynamics.accelerationY = jumpAwaitingPhysics
			|| (playerVelocity.velocityY < 0 && keys.jump)
			? RISE_GRAVITY
			: playerVelocity.velocityY < 0 ? RELEASE_GRAVITY : FALL_GRAVITY;
		for(const patrol of patrols) {
			const transform = patrol.entity.components.transform;
			const velocity = patrol.entity.components.velocity;
			if(!transform || !velocity) {
				continue;
			}
			if(transform.x <= patrol.minX) {
				patrol.direction = 1;
			} else if(transform.x >= patrol.maxX) {
				patrol.direction = -1;
			}
			velocity.velocityX = patrol.direction * ENEMY_SPEED;
		}

		if(playerTransform.y > runtime.level.height + PLAYER_HEIGHT) {
			hits++;
			respawn(runtime);
		}
	},

	entityStyle(_runtime, entity): EntityStyle | undefined {
		if(entity === player) {
			const flashing = invulnerability > 0
				&& Math.floor(invulnerability / HIT_FLASH_INTERVAL_MS) % 2 === 0;
			return { color: flashing ? PLAYER_HIT_COLOR : PLAYER_COLOR, alpha: 1, appearance: 'stick-figure' };
		}
		if(coins.has(entity.eid)) {
			return { color: COIN_COLOR, alpha: 1, appearance: 'coin' };
		}
		if(patrols.some(patrol => patrol.entity === entity)) {
			return { color: ENEMY_COLOR, alpha: 1, appearance: 'enemy' };
		}

		return undefined;
	},

	hud(): HudText {
		return {
			status: [`Coins  ${collected}/7`, `Hits   ${hits}`],
			banner: coins.size === 0 ? 'Course clear!\nPress Restart course to play again' : undefined,
		};
	},
};

function loadPlatform(runtime: ExampleRuntime, x: number, y: number, width: number, height: number): void {
	runtime.world.loadEntity({ x, y, width, height, collideCategory: TERRAIN_CATEGORY });
}

function loadEnemy(runtime: ExampleRuntime, x: number, y: number, minX: number, maxX: number): void {
	const entity = runtime.world.loadEntity({
		x,
		y,
		width: 42,
		height: 42,
		velocityX: ENEMY_SPEED,
		velocityY: 0,
		accelerationY: FALL_GRAVITY,
		collideCategory: ENEMY_CATEGORY,
		collideMask: TERRAIN_CATEGORY | PLATFORMER_PLAYER_CATEGORY,
		interpolate: true,
	});
	patrols.push({ entity, minX, maxX, direction: 1 });
}

function loadCoin(runtime: ExampleRuntime, x: number, y: number): void {
	const entity = runtime.world.loadEntity({
		x,
		y,
		radius: 13,
		collideCategory: COIN_CATEGORY,
		collideMask: PLATFORMER_PLAYER_CATEGORY,
		sensor: true,
	});
	coins.add(entity.eid);
}

function respawn(runtime: ExampleRuntime): void {
	const transform = player?.components.transform;
	const velocity = player?.components.velocity;
	if(!player || !transform || !velocity) {
		return;
	}
	transform.x = spawnX;
	transform.y = spawnY;
	velocity.velocityX = 0;
	velocity.velocityY = 0;
	coyoteTime = 0;
	jumpBuffer = 0;
	jumpAwaitingPhysics = false;
	invulnerability = 0;
	hitControlLock = 0;
	setEnemyCollision(true);
	runtime.world.updateSpatialEntity(player);
	snapEntity(player);
}

function setEnemyCollision(enabled: boolean): void {
	const body = player?.components.body;
	if(body) {
		body.collideMask = TERRAIN_CATEGORY | COIN_CATEGORY | (enabled ? ENEMY_CATEGORY : 0);
	}
}

function setKey(event: KeyboardEvent, down: boolean): void {
	let handled = true;
	switch(event.key) {
		case 'ArrowLeft':
		case 'a':
		case 'A':
			keys.left = down;
			break;
		case 'ArrowRight':
		case 'd':
		case 'D':
			keys.right = down;
			break;
		case 'ArrowUp':
		case 'w':
		case 'W':
		case ' ':
			keys.jump = down;
			break;
		default:
			handled = false;
	}

	if(handled && location.hash.slice(1) === platformer.id) {
		event.preventDefault();
	}
}

if(typeof window !== 'undefined') {
	window.addEventListener('keydown', event => setKey(event, true));
	window.addEventListener('keyup', event => setKey(event, false));
}

export default platformer;
