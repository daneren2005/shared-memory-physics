import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '@daneren2005/shared-memory-physics';
import type { Control } from '../controls';
import type { Example, ExampleRuntime } from '../example';
import Random from '../random';
import type { Components, Config } from '../world';

const SEED = 246813579;
const PLACEMENT_ATTEMPTS = 200;

// The square is 28 across, so half of it is 14: the clearance every placement below is kept away from the
// player's start by, on top of the target's own reach.
const PLAYER_SIZE = 28;
// How close the square has to get before it is treated as arrived and stopped.  The steering below never asks
// physics to close the last few units, so a click lands the square *near* the spot rather than dead on it -
// which is what "naturally stop" means here.
const STOP_DISTANCE = 5;
// A gap left between anything placed, so the targets read as separate shapes rather than a pile.
const MARGIN = 12;

// Cycled through as targets are placed so even a handful still shows one of each of the three shapes.
const SHAPES = [SHAPE_RECTANGLE, SHAPE_CIRCLE, SHAPE_CAPSULE];

const settings = {
	targets: 9,
	speed: 260,
};

// The one entity a click steers, and where it is currently headed.  Both are rebuilt with the world and read
// back through the runtime, so nothing here holds on to a world a restart has already thrown away - the
// destination is simply cleared when there is no square to move.
let player: BaseEntity<Components, Config> | undefined;
let destination: { x: number, y: number } | undefined;

export const clickToMove: Example = {
	id: 'click-to-move',
	title: 'Click to move',
	description: 'Click anywhere and the square drives itself there. A click writes a destination, and each frame '
		+ 'the square points its velocity straight at it - so this is steering, not a path: a target in the way is '
		+ 'something the square presses into and stops on, not something it goes around. The velocity is dropped to '
		+ 'zero once the square is within five units of where you clicked, which is what stops it cleanly instead of '
		+ 'jittering back and forth across the spot. The rectangles, circles and capsules scattered about have a '
		+ 'size but no velocity, so physics never moves them - they are just there to bump into.',
	backend: 'sweep',

	controls(): Array<Control> {
		return [
			{
				kind: 'slider',
				label: 'Speed',
				min: 40,
				max: 600,
				step: 10,
				value: settings.speed,
				format: value => `${value} u/s`,
				// Applied live: the next frame's steering picks the new speed up, so dragging this retunes a square
				// that is already on its way without having to click again.
				change(value) {
					settings.speed = value;
				},
			},
			{
				kind: 'slider',
				label: 'Targets',
				min: 0,
				max: 30,
				value: settings.targets,
				change(value) {
					settings.targets = value;
				},
			},
		];
	},

	create(runtime): void {
		const { world, level } = runtime;
		const random = new Random(SEED);
		const placed: Array<Placed> = [];

		const startX = level.width / 2;
		const startY = level.height / 2;

		// The square starts in the middle and stays still until the first click.  It carries a velocity component
		// from the off - the steering writes into it every frame - but starts at rest, and no bounciness, so a
		// collision stops it against a face rather than turning it around.
		destination = undefined;
		player = world.loadEntity({
			x: startX,
			y: startY,
			width: PLAYER_SIZE,
			height: PLAYER_SIZE,
			velocityX: 0,
			velocityY: 0,
			interpolate: true,
		});

		// Keep the targets clear of where the square sits, so it never opens the scene already jammed inside one.
		placed.push({ x: startX, y: startY, reach: PLAYER_SIZE / 2 });

		for(let i = 0; i < settings.targets; i++) {
			// Round-robin through the three shapes so even a low count still shows one of each, then random sizes
			// on top so no two of a kind are quite alike.
			const shape = SHAPES[i % SHAPES.length];
			const target = makeTarget(shape, random);

			const spot = findSpot(runtime, random, target.reach, placed);
			if(!spot) {
				continue;
			}

			placed.push({ x: spot.x, y: spot.y, reach: target.reach });
			world.loadEntity({
				x: spot.x,
				y: spot.y,
				width: target.width,
				height: target.height,
				radius: target.radius,
				shape: target.shape,
				angle: target.angle,
				interpolate: true,
			});
		}
	},

	pointerDown(runtime, x, y): void {
		if(!player) {
			return;
		}

		// A click is a destination, nothing more - the steering in `update` is what turns it into motion, so
		// clicking mid-journey simply hands the square a new place to aim at on the very next frame.
		destination = {
			x: clamp(x, 0, runtime.level.width),
			y: clamp(y, 0, runtime.level.height),
		};
	},

	update(runtime, elapsedTime): void {
		const transform = player?.components.transform;
		const velocity = player?.components.velocity;
		if(!transform || !velocity) {
			return;
		}

		if(!destination) {
			return;
		}

		const dx = destination.x - transform.x;
		const dy = destination.y - transform.y;
		const distance = Math.hypot(dx, dy);

		// Within the stop radius it is close enough: zero the velocity and forget the destination, so the square
		// settles instead of hunting back and forth across the exact point.
		if(distance <= STOP_DISTANCE) {
			velocity.velocityX = 0;
			velocity.velocityY = 0;
			destination = undefined;

			return;
		}

		// The oscillation was overshoot: physics moves the square `velocity * step` in one go and sweeps to where
		// that *ends*, so at full speed a step covers more ground than the stop radius and the square leaps from
		// just outside the spot to well past it and back, forever.  The fix is to never ask for more speed than
		// closes the remaining gap in a single step - so the last step lands the square on the spot instead of
		// sailing through it.  It runs at the slider's speed the whole way in and only eases down over that final
		// step, which is what a click-to-move feels like anyway.
		//
		// The step is the physics system's own: `deltaBetweenRuns` is the fixed one it banks time up to, and 0
		// means it runs every frame, so the frame's own elapsed time is the step then.  `distance / stepSeconds`
		// is the speed that exactly covers the gap in that step; capped by the slider it is a no-op until the
		// square is within one step of arriving.
		const stepSeconds = (runtime.physics.deltaBetweenRuns || elapsedTime) / 1000;
		const speed = Math.min(settings.speed, distance / stepSeconds);

		// Rewritten every frame rather than set once on the click, so a square knocked off line by a target it
		// clipped turns back toward the destination on its own - and a change to the speed slider takes hold
		// immediately.
		velocity.velocityX = (dx / distance) * speed;
		velocity.velocityY = (dy / distance) * speed;
	},
};

// One of the three stationary shapes, resolved to the exact config an entity load wants plus the `reach` used
// to space it: the distance from its centre to its furthest point, which is all the placement below needs to
// keep shapes off each other whatever they are.
interface Target {
	shape: number
	width?: number
	height?: number
	radius?: number
	angle?: number
	reach: number
}

interface Placed {
	x: number
	y: number
	reach: number
}

function makeTarget(shape: number, random: Random): Target {
	if(shape === SHAPE_CIRCLE) {
		const radius = random.between(14, 30);

		return { shape, radius, reach: radius };
	}

	if(shape === SHAPE_CAPSULE) {
		// A capsule is `width` end to end and `height` thick; keeping the width the longer of the two is what
		// makes it read as a capsule rather than a fat circle.  It is laid at a random angle, and its reach is
		// half its length whichever way it points.
		const height = random.between(18, 30);
		const width = height + random.between(24, 60);

		return { shape, width, height, angle: random.between(0, Math.PI), reach: width / 2 };
	}

	// A rectangle, drawn square to the world - the reach is the half-diagonal, the corner being its furthest
	// point from the centre.
	const width = random.between(30, 70);
	const height = random.between(30, 70);

	return { shape, width, height, reach: Math.hypot(width, height) / 2 };
}

// Finds a spot whose `reach` clears every shape already down - and the level's edges - by the margin, or gives
// up after enough tries so a crowded level simply places fewer than asked rather than looping forever.
function findSpot(runtime: ExampleRuntime, random: Random, reach: number, placed: Array<Placed>): { x: number, y: number } | undefined {
	const level = runtime.level;

	for(let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
		const x = random.between(reach, level.width - reach);
		const y = random.between(reach, level.height - reach);

		if(placed.every(other => Math.hypot(x - other.x, y - other.y) >= reach + other.reach + MARGIN)) {
			return { x, y };
		}
	}

	return undefined;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export default clickToMove;
