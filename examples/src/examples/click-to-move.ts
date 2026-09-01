import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_POLYGON, SHAPE_RECTANGLE } from '@daneren2005/shared-memory-physics';
import type { PolygonVertex } from '@daneren2005/shared-memory-physics';
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
// A perfect bounce, so the ricochet off an obstacle is unmistakable when the toggle is on.
const BOUNCINESS = 1;

// Polygons recur more often than the primitive shapes so the default target count has room to show several
// different outlines, while still putting every primitive in the scene.
const SHAPES = [
	SHAPE_RECTANGLE,
	SHAPE_CIRCLE,
	SHAPE_CAPSULE,
	SHAPE_POLYGON,
	SHAPE_RECTANGLE,
	SHAPE_POLYGON,
	SHAPE_CIRCLE,
	SHAPE_POLYGON,
	SHAPE_CAPSULE,
	SHAPE_POLYGON,
];

const settings = {
	targets: 9,
	speed: 260,
	// Off by default: the square slides around obstacles.  Turned on it bounces off them instead - and physics
	// turns the sliding off for anything that can bounce, so the two are never fighting over the same contact.
	bouncy: false,
};

// The one entity a click steers, and where it is currently headed.  Both are rebuilt with the world and read
// back through the runtime, so nothing here holds on to a world a restart has already thrown away - the
// destination is simply cleared when there is no square to move.
let player: BaseEntity<Components, Config> | undefined;
let destination: { x: number, y: number } | undefined;

export const clickToMove: Example = {
	id: 'click-to-move',
	title: 'Click to move',
	description: 'Click anywhere and the square drives itself there. A click writes a destination and the square '
		+ 'points its velocity straight at it - so this is steering, not a path: it heads at the spot in a straight '
		+ 'line rather than finding a way round. What it does when a target is in the way is the interesting part, '
		+ 'and it depends on the bounciness toggle. Off, the square slides: physics lets a blocked diagonal keep '
		+ 'going along whichever single axis is still clear, so the square runs along the face of an obstacle and '
		+ 'off its corner instead of sticking to it. On, the square bounces off instead - and because a bouncing '
		+ 'entity is going to turn around off the face anyway, physics turns the sliding off for it, so the two are '
		+ 'never fighting over the same contact. The rectangles, circles, capsules and convex polygons scattered about have a size '
		+ 'but no velocity, so physics never moves them - they are just there to run into.',
	backend: 'sweep',

	controls(host): Array<Control> {
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
					host.restart();
				},
			},
			{
				kind: 'toggle',
				label: 'Bounciness',
				value: settings.bouncy,
				note: 'Gives the square a perfect bounce, so it ricochets off obstacles instead of sliding along them '
					+ '- and because it can then bounce, physics stops sliding it. Aim it past a target with this on '
					+ 'and it deflects rather than steering back on, since it is set loose on a click rather than '
					+ 'steered every frame while it is bouncing. Rebuilds the square, since bounciness is set when it '
					+ 'is created.',
				change(value) {
					settings.bouncy = value;
					host.restart();
				},
			},
		];
	},

	create(runtime): void {
		const { world, level } = runtime;
		const random = new Random(SEED);
		const placed: Array<Placed> = [];
		let polygonVariant = 0;

		const startX = level.width / 2;
		const startY = level.height / 2;

		// The square starts in the middle and stays still until the first click.  It carries a velocity component
		// from the off - a click writes into it - but starts at rest.  Bounciness is set here rather than toggled
		// live because it is loaded when the entity is created, which is why the toggle rebuilds the world.
		destination = undefined;
		const config: Config = {
			x: startX,
			y: startY,
			width: PLAYER_SIZE,
			height: PLAYER_SIZE,
			velocityX: 0,
			velocityY: 0,
			interpolate: true,
		};
		if(settings.bouncy) {
			config.bounciness = BOUNCINESS;
		}
		player = world.loadEntity(config);

		// Keep the targets clear of where the square sits, so it never opens the scene already jammed inside one.
		placed.push({ x: startX, y: startY, reach: PLAYER_SIZE / 2 });

		for(let i = 0; i < settings.targets; i++) {
			// Follow the mixed sequence above, then vary sizes so no two of a kind are quite alike.
			const shape = SHAPES[i % SHAPES.length];
			const target = makeTarget(shape, random, polygonVariant);
			if(shape === SHAPE_POLYGON) {
				polygonVariant++;
			}

			const spot = findSpot(runtime, random, target.reach, placed);
			if(!spot) {
				continue;
			}

			placed.push({ x: spot.x, y: spot.y, reach: target.reach });
			const targetConfig: Config = {
				x: spot.x,
				y: spot.y,
				shape: target.shape,
				angle: target.angle,
				interpolate: true,
			};
			if(target.vertices) {
				targetConfig.vertices = target.vertices;
			} else if(target.radius !== undefined) {
				targetConfig.radius = target.radius;
			} else {
				targetConfig.width = target.width;
				targetConfig.height = target.height;
			}
			world.loadEntity(targetConfig);
		}
	},

	pointerDown(runtime, x, y): void {
		const transform = player?.components.transform;
		const velocity = player?.components.velocity;
		if(!transform || !velocity) {
			return;
		}

		const target = {
			x: clamp(x, 0, runtime.level.width),
			y: clamp(y, 0, runtime.level.height),
		};
		destination = target;

		// Aim the square at the click straight away.  A sliding square is re-aimed every frame by `update` so this
		// only saves it a frame, but a bouncing one is set loose here and left alone - `update` never re-steers it -
		// so this launch is the only push it gets, and everything after is the bounce carrying it.
		const dx = target.x - transform.x;
		const dy = target.y - transform.y;
		const distance = Math.hypot(dx, dy);
		if(distance > 0) {
			velocity.velocityX = (dx / distance) * settings.speed;
			velocity.velocityY = (dy / distance) * settings.speed;
		}
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

		// A bouncing square is set loose on the click and left to the bounce from there: re-aiming it every frame
		// would overwrite the velocity the bounce just flipped before physics could act on it, so there would be no
		// bounce to see.  It still stops when it happens to arrive - the check above - it is just not steered on the
		// way, so it deflects off obstacles and walls rather than boring back toward the spot.
		if(settings.bouncy) {
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
	vertices?: ReadonlyArray<PolygonVertex>
	angle?: number
	reach: number
}

interface Placed {
	x: number
	y: number
	reach: number
}

function makeTarget(shape: number, random: Random, polygonVariant: number): Target {
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

	if(shape === SHAPE_POLYGON) {
		// Deliberately cycle triangle through octagon instead of leaving the count to chance. An affine shear keeps
		// each one convex while making them read as more than regular polygons stretched into ellipses.
		const count = 3 + polygonVariant % 6;
		const radiusX = random.between(24, 40);
		const radiusY = random.between(20, 36);
		const shear = random.between(-0.4, 0.4);
		const vertices: Array<PolygonVertex> = [];
		for(let i = 0; i < count; i++) {
			const vertexAngle = (Math.PI * 2 * i) / count;
			const y = Math.sin(vertexAngle) * radiusY;
			vertices.push([Math.cos(vertexAngle) * radiusX + y * shear, y]);
		}

		return {
			shape,
			vertices,
			angle: random.between(0, Math.PI),
			reach: Math.max(...vertices.map(([x, y]) => Math.hypot(x, y))),
		};
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
