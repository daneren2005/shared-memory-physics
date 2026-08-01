import type { Control } from '../controls';
import type { Example, ExampleRuntime } from '../example';
import Random from '../random';
import { setSpeed } from './speed';

const SEED = 987654321;
const PLACEMENT_ATTEMPTS = 200;

const settings = {
	count: 40,
	speed: 140,
	size: 36,
};

export const bouncingRectangles: Example = {
	id: 'rectangles',
	title: 'Bouncing rectangles',
	description: 'The same bounce, on boxes with a random width and height as well as a random position and '
		+ 'heading. A box has no single contact point the way two circles do, so physics bounces it off the face '
		+ 'it actually hit - the axis the two are least through each other on - all from the bounciness of 1 each '
		+ 'one carries.',
	backend: 'sweep',

	controls(host): Array<Control> {
		return [
			{
				kind: 'slider',
				label: 'Rectangles',
				min: 1,
				max: 400,
				value: settings.count,
				change(value) {
					settings.count = value;
					host.restart();
				},
			},
			{
				kind: 'slider',
				label: 'Speed',
				min: 20,
				max: 800,
				step: 10,
				value: settings.speed,
				format: value => `${value} u/s`,
				change(value) {
					settings.speed = value;
					setSpeed(host.runtime, value);
				},
			},
			{
				kind: 'slider',
				label: 'Size',
				min: 8,
				max: 90,
				value: settings.size,
				change(value) {
					settings.size = value;
					host.restart();
				},
			},
		];
	},

	create(runtime): void {
		const random = new Random(SEED);
		const placed: Array<Box> = [];

		for(let i = 0; i < settings.count; i++) {
			// Width and height are drawn separately, so these are anything from a near-square to a long thin
			// slab - which is what makes the face the bounce picks worth watching.
			const width = settings.size * random.between(0.5, 1.5);
			const height = settings.size * random.between(0.5, 1.5);

			const spot = findSpot(runtime, random, width, height, placed);
			if(!spot) {
				continue;
			}

			placed.push(spot);

			const heading = random.between(0, Math.PI * 2);
			// A config with a width and a height and no radius is a rectangle, which is the body's default shape,
			// so there is nothing else to say.  Angle is left at 0: the library collides a turned box perfectly
			// well, but nothing here spins one, and a bounce off a face is only a *face* while the box is square
			// to the world.
			runtime.world.loadEntity({
				x: spot.x,
				y: spot.y,
				width,
				height,
				velocityX: Math.cos(heading) * settings.speed,
				velocityY: Math.sin(heading) * settings.speed,
				// A perfect bounce, the same as the circles: the one property that turns a box around off the face
				// it hit, with no collision callback in the example.
				bounciness: 1,
				// Gives it a render position for the canvas to draw, blended between the two positions physics
				// published either side of its last step.
				interpolate: true,
			});
		}
	},
};

interface Box {
	x: number
	y: number
	width: number
	height: number
}

// The same "do not spawn on top of anything" pass the circles do, on boxes.
function findSpot(runtime: ExampleRuntime, random: Random, width: number, height: number, placed: Array<Box>): Box | undefined {
	const level = runtime.level;
	const halfWidth = width / 2;
	const halfHeight = height / 2;

	for(let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
		const x = random.between(halfWidth, level.width - halfWidth);
		const y = random.between(halfHeight, level.height - halfHeight);

		if(placed.every(other => !overlaps(x, y, width, height, other))) {
			return { x, y, width, height };
		}
	}

	return undefined;
}

function overlaps(x: number, y: number, width: number, height: number, other: Box): boolean {
	return Math.abs(x - other.x) < (width + other.width) / 2
		&& Math.abs(y - other.y) < (height + other.height) / 2;
}

export default bouncingRectangles;
