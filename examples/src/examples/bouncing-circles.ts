import type { Control } from '../controls';
import type { Example, ExampleRuntime } from '../example';
import Random from '../random';
import { setSpeed } from './speed';

// The layout is drawn from a seeded generator so that moving a slider - which rebuilds the world - gives the
// same scene back with one thing changed, rather than a different scene every time.
const SEED = 20250731;
// A circle that cannot be dropped anywhere clear after this many tries is skipped, so a count far past what
// the level can hold settles at however many fit instead of hanging.
const PLACEMENT_ATTEMPTS = 200;

const settings = {
	count: 60,
	speed: 160,
	radius: 12,
};

export const bouncingCircles: Example = {
	id: 'circles',
	title: 'Bouncing circles',
	description: 'Circles with a random starting position and heading. Every bounce - off another circle or off '
		+ 'the walls around the level - is native: each one carries a bounciness of 1, so physics reflects its '
		+ 'velocity about the contact normal on contact, with no collision callback in the example at all.',
	backend: 'sweep',

	controls(host): Array<Control> {
		return [
			{
				kind: 'slider',
				label: 'Circles',
				min: 1,
				max: 500,
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
				// Retuned live rather than rebuilt: the direction each one is already travelling in is kept and
				// only how fast it is going changes, so the scene carries on from where it was.
				change(value) {
					settings.speed = value;
					setSpeed(host.runtime, value);
				},
			},
			{
				kind: 'slider',
				label: 'Radius',
				min: 4,
				max: 40,
				value: settings.radius,
				change(value) {
					settings.radius = value;
					host.restart();
				},
			},
		];
	},

	create(runtime): void {
		const random = new Random(SEED);
		const placed: Array<Circle> = [];

		for(let i = 0; i < settings.count; i++) {
			// A spread of sizes around the slider, so the collisions are between unequal shapes rather than a
			// single size that only ever meets itself.
			const radius = settings.radius * random.between(0.6, 1.4);
			const spot = findSpot(runtime, random, radius, placed);
			if(!spot) {
				continue;
			}

			placed.push(spot);

			// A random heading at the current speed.  `radius` on the config is the whole of what makes this a
			// circle: the transform turns it into a width and a height of the diameter, and the body reads the
			// same config and defaults its shape to a circle because of it.
			const heading = random.between(0, Math.PI * 2);
			runtime.world.loadEntity({
				x: spot.x,
				y: spot.y,
				radius,
				velocityX: Math.cos(heading) * settings.speed,
				velocityY: Math.sin(heading) * settings.speed,
				// A perfect bounce: the speed into whatever it hits comes straight back out, so the scene runs
				// forever without winding down.  This one property is the whole of what makes it bounce - physics
				// turns it around off other circles and off the walls with no callback in the example.
				bounciness: 1,
				// Gives it a render position for the canvas to draw, blended between the two positions physics
				// published either side of its last step.
				interpolate: true,
			});
		}
	},
};

interface Circle {
	x: number
	y: number
	radius: number
}

// Somewhere inside the level that no circle placed so far is already sitting.  Entities are allowed to spawn
// on top of each other - the library lets an overlap that was there before the move began through rather than
// pinning the two together - but they would then start by shoving each other apart, which is a worse first
// second than it needs to be.
function findSpot(runtime: ExampleRuntime, random: Random, radius: number, placed: Array<Circle>): Circle | undefined {
	const { width, height } = runtime.level;

	for(let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
		const x = random.between(radius, width - radius);
		const y = random.between(radius, height - radius);

		if(placed.every(other => !overlaps(x, y, radius, other))) {
			return { x, y, radius };
		}
	}

	return undefined;
}

function overlaps(x: number, y: number, radius: number, other: Circle): boolean {
	const dx = x - other.x;
	const dy = y - other.y;
	const reach = radius + other.radius;

	return dx * dx + dy * dy < reach * reach;
}

export default bouncingCircles;
