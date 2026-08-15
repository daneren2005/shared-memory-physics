import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import type { Control } from '../controls';
import type { EntityStyle, Example, ExampleHost, ExampleRuntime, HudText } from '../example';
import {
	BULLET_CATEGORY,
	OBSTACLE_CATEGORY,
	PLAYER_CATEGORY,
	PLAYER_HIT_EVENT,
	TURRET_CATEGORY,
	WALL_CATEGORY,
} from '../physics/bullet-hell-update';
import Random from '../random';
import type { Components, Config } from '../world';

// A turret sits in the middle of the field and sprays bullets off in every direction at random speeds, and you
// drive a square around with the arrow keys trying not to be hit.  It is built entirely out of the library's
// collision filtering, its sensor bodies, and continuous collision detection:
//
//   - the bullets are *sensors*, so nothing is ever stopped against one - you drive straight through them - but a
//     sensor is still found and reported, so the physics-thread callback (see ../physics/bullet-hell-update.ts)
//     still fires and kills the bullet the instant it touches anything;
//   - the bullets are tiny and fast enough to step clean past a target in one run, so they also set
//     `continuousCollisionDetection`, which tests each bullet along the whole path it swept this run rather than
//     only where its step ends - the flag is what keeps a fast shot from flying through you uncounted;
//   - the square obstacles and the four walls are ordinary solids the bullets name in their collide mask, so a
//     bullet dies against them too - which is how an obstacle "blocks" a bullet and how a bullet never piles up
//     off the edge of the world;
//   - the player and the obstacles collide as their own categories so the square is stopped by the obstacles,
//     the walls and the turret while passing freely through the bullets it is dodging.
//
// The hit tally comes back out of the physics thread: the callback raises an event on the player when a bullet
// reaches it, and `create` counts them.  Nothing here tests an overlap on the main thread.

// One world unit is one pixel.  The player is a small square, the turret a circle at the centre, the bullets
// tiny circles - deliberately small and fast, so a shot covers more than its own width in a step and would
// tunnel clean through a target if continuous collision detection were not switched on to catch it.
const PLAYER_SIZE = 30;
const TURRET_RADIUS = 26;
const BULLET_RADIUS = 3;

// How fast the square travels while a key is held, in units per second.  Feel, not something the demonstration
// is about, so it is fixed here rather than put on a slider.
const PLAYER_SPEED = 340;

// Where a bullet is born: just outside the turret's rim, so it appears to leave the barrel rather than the
// turret's centre.
const BULLET_SPAWN_OFFSET = TURRET_RADIUS + BULLET_RADIUS + 2;
// The slowest a bullet is ever fired, as a fraction of the speed slider, so a volley is a spread of speeds
// rather than a single ring expanding in lockstep.
const MIN_SPEED_FRACTION = 0.45;

// A gap kept between anything placed and the turret / player start, so the field never opens with the square
// jammed inside an obstacle or an obstacle sitting on the gun.
const MARGIN = 24;
const PLACEMENT_ATTEMPTS = 200;
// The obstacle layout is drawn from a seeded generator, so nudging the obstacle count rebuilds the same scene
// with one thing changed rather than reshuffling the whole board.
const SEED = 987654321;

// The collide masks each kind of body carries - the bits it is allowed to run into.  A pair only collides when
// each side's mask names the other's category (see the README on filtering), so these are written to line up
// with the categories the entities are loaded as.
//
// The player is stopped by the walls, the obstacles and the turret, and is *detected* meeting a bullet (the
// bullet being a sensor, that detection is all that happens - it is never physically stopped).
const PLAYER_MASK = WALL_CATEGORY | OBSTACLE_CATEGORY | TURRET_CATEGORY | BULLET_CATEGORY;
// An obstacle stops the player and kills bullets, and nothing else - it never has to notice another obstacle or
// a wall, having no velocity to carry it into one.
const OBSTACLE_MASK = PLAYER_CATEGORY | BULLET_CATEGORY;
// A bullet dies on the walls, the obstacles and the player.  It leaves its own category and the turret's out, so
// bullets stream through each other and out of the barrel they were fired from rather than killing each other at
// the muzzle.
const BULLET_MASK = WALL_CATEGORY | OBSTACLE_CATEGORY | PLAYER_CATEGORY;
// The turret is a solid the player bumps into; it takes part in nothing else.
const TURRET_MASK = PLAYER_CATEGORY;

const PLAYER_COLOR = 0x4ADE80;
const TURRET_COLOR = 0xF59E0B;
const BULLET_COLOR = 0xF87171;

const settings = {
	// Bullets fired per second.
	fireRate: 50,
	// The fastest a bullet is fired, in units per second; each shot is a random speed between MIN_SPEED_FRACTION
	// of this and this.  Set high on purpose: a shot covers far more than a target is thick in one step, which
	// without continuous collision detection would tunnel clean through it uncounted.  With the flag on the bullet
	// is tested along its whole swept path instead, so it still lands however fast you drag this.
	bulletSpeed: 1200,
	obstacles: 20,
};

// All of the game's state is module-level and rebuilt from scratch in `create`, the same way breakout keeps its
// game state: an example outlives any number of world rebuilds, so the control handlers reach the live state
// through here rather than closing over a world a restart has already thrown away.
let host: ExampleHost | undefined;
let player: BaseEntity<Components, Config> | undefined;
let turret: { x: number, y: number } | undefined;
let hits = 0;
// Time banked toward the next shot, in milliseconds, so a fire rate that does not divide the frame still fires
// on average at the right cadence rather than once a frame.
let fireAccumulator = 0;

// The keys, set by the listeners at the bottom of this file and read every frame by `update`.
const keys = { up: false, down: false, left: false, right: false };

export const bulletHell: Example = {
	id: 'bullet-hell',
	title: 'Bullet hell',
	description: 'A turret in the middle sprays bullets off in every direction at random speeds, and you drive the '
		+ 'green square around with the arrow keys (or WASD) trying not to get hit. The bullets are sensor bodies: '
		+ 'nothing is ever stopped against a sensor, so you pass straight through the ones you fail to dodge - but a '
		+ 'sensor is still found and reported, so a collision callback running in the physics thread kills each '
		+ 'bullet the instant it touches anything, and raises a hit on the player when the thing it touched was you. '
		+ 'The square obstacles and the walls are ordinary solids the bullets name in their collide mask, so a '
		+ 'bullet dies against them too - which is what lets an obstacle block the stream and gives you cover. This '
		+ 'example is tuned to show off continuous collision detection: the bullets are tiny and fast and the '
		+ 'obstacles come in thin slabs as well as blocks, so a shot steps much further than a target is thick '
		+ 'in one run. Tested only where its step ends it would fly clean through you uncounted; the bullets set '
		+ 'continuousCollisionDetection instead, which tests each shot along the whole path it swept this run '
		+ 'rather than only where it landed, so it still lands however fast it is going. Arrow keys or '
		+ 'WASD to move.',
	backend: 'bulletHell',
	physicsStep: 50,

	controls(hostArg): Array<Control> {
		host = hostArg;

		return [
			{
				kind: 'slider',
				label: 'Fire rate',
				min: 2,
				max: 60,
				value: settings.fireRate,
				format: value => `${value}/s`,
				// Live: the next frame reads the new rate straight off `settings`, so dragging this thickens or
				// thins the stream without a rebuild.
				change(value) {
					settings.fireRate = value;
				},
			},
			{
				kind: 'slider',
				label: 'Bullet speed',
				min: 500,
				max: 3000,
				step: 20,
				value: settings.bulletSpeed,
				format: value => `${value} u/s`,
				// Live: only shots fired after this take the new speed, so bullets already in flight keep theirs.
				change(value) {
					settings.bulletSpeed = value;
				},
			},
			{
				kind: 'slider',
				label: 'Obstacles',
				min: 0,
				max: 40,
				value: settings.obstacles,
				// The obstacles are laid out once when the world is built, so changing the count rebuilds it.
				change(value) {
					settings.obstacles = value;
					host?.restart();
				},
			},
			{
				kind: 'button',
				label: 'Reset',
				press: () => host?.restart(),
			},
		];
	},

	create(runtime): void {
		const { world, level } = runtime;
		const random = new Random(SEED);

		// A fresh game: drop everything the last world left behind so nothing here points at an entity a rebuild
		// has already freed.
		hits = 0;
		fireAccumulator = 0;
		player = undefined;

		const centreX = level.width / 2;
		const centreY = level.height / 2;
		turret = { x: centreX, y: centreY };
		// The player starts down in the lower third, clear of the turret it is dodging.
		const startX = centreX;
		const startY = level.height * 0.78;

		// The turret: a static circle at the centre.  It is a solid the player bumps into, and the bullets ignore
		// it, so a shot leaves the barrel rather than dying at the muzzle.
		world.loadEntity({
			x: centreX,
			y: centreY,
			radius: TURRET_RADIUS,
			collideCategory: TURRET_CATEGORY,
			collideMask: TURRET_MASK,
		});

		// The obstacles: static squares scattered about, kept clear of the turret and the player's start.  They
		// block the player and kill bullets, giving the player cover.  A size but no velocity, so physics never
		// moves them.  The sizes run from thin slabs to solid blocks: the small ones are the other half of the
		// tunnelling on show, since a bullet stepping further than one is wide passes through it uncounted while a
		// big block still stops the whole stream.
		const placed: Array<Placed> = [
			{ x: centreX, y: centreY, reach: TURRET_RADIUS },
			{ x: startX, y: startY, reach: PLAYER_SIZE / 2 },
		];
		for(let i = 0; i < settings.obstacles; i++) {
			// Round-robin small and large, so a scene always has both to aim past rather than a random run of one.
			const size = i % 2 === 0 ? random.between(10, 22) : random.between(48, 92);
			const reach = Math.hypot(size, size) / 2;
			const spot = findSpot(level, random, reach, placed);
			if(!spot) {
				continue;
			}

			placed.push({ x: spot.x, y: spot.y, reach });
			world.loadEntity({
				x: spot.x,
				y: spot.y,
				width: size,
				height: size,
				collideCategory: OBSTACLE_CATEGORY,
				collideMask: OBSTACLE_MASK,
			});
		}

		// The player: a square steered by the arrow keys writing into its velocity, which physics then integrates
		// and clamps against the walls, obstacles and turret for free.
		player = world.loadEntity({
			x: startX,
			y: startY,
			width: PLAYER_SIZE,
			height: PLAYER_SIZE,
			velocityX: 0,
			velocityY: 0,
			collideCategory: PLAYER_CATEGORY,
			collideMask: PLAYER_MASK,
			interpolate: true,
		});

		// The hit tally comes off the physics thread: the collision callback raises this event on the player the
		// frame a bullet reaches it (see ../physics/bullet-hell-update.ts), so counting them is all that is left to
		// do here.  Watched on the entity rather than polled, since a hit lands whenever a physics run reports back.
		player.on(PLAYER_HIT_EVENT, () => {
			hits++;
		});
	},

	update(runtime, elapsedTime): void {
		const velocity = player?.components.velocity;
		if(!velocity || !turret) {
			return;
		}

		// Steer the square: a direction off the keys, normalised so a diagonal is no faster than a straight line,
		// then scaled to the fixed speed.  Physics does the moving and the stopping.
		let directionX = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
		let directionY = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
		const magnitude = Math.hypot(directionX, directionY);
		if(magnitude > 0) {
			directionX /= magnitude;
			directionY /= magnitude;
		}
		velocity.velocityX = directionX * PLAYER_SPEED;
		velocity.velocityY = directionY * PLAYER_SPEED;

		// Fire on a banked timer so a rate that does not divide the frame still averages out, rather than being
		// pinned to one shot a frame.
		fireAccumulator += elapsedTime;
		const interval = 1000 / settings.fireRate;
		while(fireAccumulator >= interval) {
			fireAccumulator -= interval;
			fireBullet(runtime, turret);
		}
	},

	// The player is green, the turret amber, and every bullet the same hot red so the stream reads as one danger
	// rather than a confetti of ids.  Everything else - the obstacles, off which the renderer's own grey says
	// "scenery" - is left to the default.
	entityStyle(_runtime, entity): EntityStyle | undefined {
		const category = entity.components.body?.collideCategory;
		if(category === BULLET_CATEGORY) {
			return { color: BULLET_COLOR, alpha: 1 };
		}
		if(category === PLAYER_CATEGORY) {
			return { color: PLAYER_COLOR, alpha: 1 };
		}
		if(category === TURRET_CATEGORY) {
			return { color: TURRET_COLOR, alpha: 1 };
		}

		return undefined;
	},

	// The hit tally and how many bullets are in the air, pinned to the corner.  The count is a walk of the world's
	// entities once a frame, which at these numbers is nothing; a game with far more would keep a running total.
	hud(runtime): HudText | undefined {
		let inFlight = 0;
		for(const entity of runtime.world.entities.values()) {
			if(entity.components.body?.collideCategory === BULLET_CATEGORY) {
				inFlight++;
			}
		}

		return { status: [`Hits    ${hits}`, `Bullets ${inFlight}`, 'Arrows / WASD to move'] };
	},
};

// Fires one bullet: a sensor circle born at the turret's rim, sent off at a random heading and a random speed.
// The heading is a fresh random every shot - this is the one place the example is deliberately not seeded, so
// the spray never repeats - while the obstacle layout above is seeded so a rebuild reproduces it.
function fireBullet(runtime: ExampleRuntime, origin: { x: number, y: number }): void {
	const heading = Math.random() * Math.PI * 2;
	const speed = settings.bulletSpeed * (MIN_SPEED_FRACTION + Math.random() * (1 - MIN_SPEED_FRACTION));
	const dirX = Math.cos(heading);
	const dirY = Math.sin(heading);

	runtime.world.loadEntity({
		x: origin.x + dirX * BULLET_SPAWN_OFFSET,
		y: origin.y + dirY * BULLET_SPAWN_OFFSET,
		radius: BULLET_RADIUS,
		velocityX: dirX * speed,
		velocityY: dirY * speed,
		collideCategory: BULLET_CATEGORY,
		collideMask: BULLET_MASK,
		// The whole trick: a sensor is found and reported but stops nothing, so it flies through the player it hits
		// while the physics-thread callback still catches the contact and kills it.
		sensor: true,
		// Continuous collision detection: a bullet is tiny and fast enough to step clean past a target in one run,
		// so without this the callback only fires when a step happens to end on top of something. With it, the
		// bullet is tested along the whole path it swept this run, which is what stops it tunnelling.
		continuousCollisionDetection: true,
		interpolate: true,
	});
}

// A spot placed so far, kept only so far as the reach used to space the next one off it.
interface Placed {
	x: number
	y: number
	reach: number
}

// Finds a spot whose `reach` clears every shape already down - and the level's edges - by the margin, or gives
// up after enough tries so a crowded level places fewer than asked rather than looping forever.
function findSpot(level: { width: number, height: number }, random: Random, reach: number, placed: Array<Placed>): { x: number, y: number } | undefined {
	for(let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
		const x = random.between(reach, level.width - reach);
		const y = random.between(reach, level.height - reach);

		if(placed.every(other => Math.hypot(x - other.x, y - other.y) >= reach + other.reach + MARGIN)) {
			return { x, y };
		}
	}

	return undefined;
}

// The keyboard, wired once when this module loads rather than per world, the same way breakout does it: the
// handlers only set the flags above, and `update` - which runs only while this example is on screen - is the
// only thing that reads them, so the listeners sitting idle while another example is up cost nothing.  Either the
// arrow keys or WASD drive the square; the key's default (scrolling the page) is suppressed only while this
// example is the current route.
function setKey(event: KeyboardEvent, down: boolean): void {
	let handled = true;
	switch(event.key) {
		case 'ArrowUp': case 'w': case 'W':
			keys.up = down;
			break;
		case 'ArrowDown': case 's': case 'S':
			keys.down = down;
			break;
		case 'ArrowLeft': case 'a': case 'A':
			keys.left = down;
			break;
		case 'ArrowRight': case 'd': case 'D':
			keys.right = down;
			break;
		default:
			handled = false;
	}

	if(handled && location.hash.slice(1) === bulletHell.id) {
		event.preventDefault();
	}
}

if(typeof window !== 'undefined') {
	window.addEventListener('keydown', event => setKey(event, true));
	window.addEventListener('keyup', event => setKey(event, false));
}

export default bulletHell;
