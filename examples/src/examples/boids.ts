import type { Control } from '../controls';
import type { EntityStyle, Example, ExampleSystemsConfig } from '../example';
import type { Level } from '../level';
import SteeringSystem from '../systems/steering-system';
import type { SteeringParams } from '../systems/steering-update';
import Random from '../random';

// A classic boids flock, split down the middle between the two things it is made of.
//
// The steering - each boid turning by the three Reynolds rules over the neighbours around it - is a system of
// this example's own, on its own worker thread (see ../systems/steering-update.ts), and it writes nothing but
// velocities.  Turning those velocities into positions is the ordinary PhysicsSystem every other example on this
// page runs, on the standard 50ms step, publishing the pair of positions the interpolation system blends between
// so ten thousand boids stepped twenty times a second still draw as smooth motion at sixty frames.
//
// That split is what the example is here to show.  The two systems never talk: one worker writes velocity blocks
// and the other reads them, straight out of the same SharedArrayBuffer, so the flocking and the movement genuinely
// run on two cores at once - and the stats panel shows what each of them costs on its own.  It also means the
// flocking is doing flocking and nothing else, and the movement is the library's plain `physicsUpdate` with no
// example code anywhere near it.
//
// What this file does on top is set the scene and hang the sliders on it - the count, the three rule weights, the
// speed and how far a boid looks - and colour each boid by the way it is heading, so a flock that has fallen into
// step reads as a single sweep of colour.

// Reproducible layout: the same seed lays the flock out the same way every rebuild, so a slider that rebuilds -
// the count - changes the one thing rather than reshuffling the whole scene.
const SEED = 0xB01D5;

// The world the flock flies in - bigger than the shared canvas LEVEL so the flock has room to spread, with the
// scene zooming out to fit it (see the renderer's camera).  Kept to the canvas' 3:2 aspect so the zoom that fits
// it is uniform.  The steering system is handed this as its bounds, so the flock banks away from these edges.
const BOIDS_WORLD: Level = { width: 2400, height: 1600 };

// Small dots.  A flock reads as a texture of hundreds or thousands of little marks, not a scatter of shapes, so
// each boid is drawn tiny - and a small circle is about the cheapest thing the renderer draws, which matters when
// there are ten thousand of them.
const BOID_RADIUS = 4;

// Held together in one object so a control changing one of them is a one-line write.  `count` rebuilds the flock;
// `params` is handed to the steering system as a live reference and sent across to its worker on every run, so the
// rest of the sliders retune the flock mid-flight with nothing rebuilt.
const settings = {
	count: 10000,
	params: {
		minSpeed: 60,
		maxSpeed: 130,
		perception: 45,
		separationRange: 20,
		separation: 1.6,
		alignment: 1.0,
		cohesion: 0.8,
	} satisfies SteeringParams,
};

// One style object, mutated and handed back for every boid rather than allocated per boid per frame: the renderer
// reads the colour off it and draws immediately, keeping nothing, so the same object is safe to reuse - and at
// ten thousand boids a fresh object apiece would be ten thousand allocations a frame for the garbage collector to
// chase.  See entityStyle.
const boidStyle: EntityStyle = { color: 0, alpha: 0.9 };

export const boids: Example = {
	id: 'boids',
	title: 'Boids',
	description: 'Craig Reynolds\' flocking, split into the two systems it is really made of. Each boid steers '
		+ 'itself by three rules over the neighbours around it - turn away from the ones it is crowding, fall in with '
		+ 'their heading, drift toward their middle - and a flock nobody designed falls out of the three. That '
		+ 'steering is a system of this example\'s own on its own worker thread, and it writes nothing but velocities; '
		+ 'moving the flock is the same standard physics system, on the same 50ms step, that every other example on '
		+ 'this page runs, with interpolation drawing the frames in between. The two never talk to each other - one '
		+ 'worker writes velocities and the other reads them straight out of the same shared buffer - so the flocking '
		+ 'and the movement run on two cores at once, and the stats panel shows what each of them costs. Each boid is '
		+ 'coloured by the way it is heading, so a stretch of the flock that has fallen into step shows as one sweep '
		+ 'of colour. Drag the rule weights to change the flock\'s character.',
	// Movement and nothing else - the library's own `physicsUpdate`.  Boids carry no body, so there is nothing for
	// them to collide with and nothing to sweep against; what keeps them in the field is the steering system's
	// push away from the edges.
	backend: 'movement',
	// A world twice the canvas across each way, so the flock has room to spread rather than being packed into the
	// shared 1200x800.  The canvas does not grow to match - the scene zooms out to fit this in the same space (see
	// the renderer's camera) - so the boids simply fly in a larger field seen a little further back.
	world: BOIDS_WORLD,
	// Drawn the cheap way - one flat dart per boid, pointed the way it is going - so the renderer keeps up with
	// ten thousand of them.  See the swarm path in the renderer.
	swarm: true,
	// Show the timing breakdown: this is the stress test the stats panel's per-system numbers are for, and the one
	// example with two systems' worth of them to compare.
	timing: true,

	// The other half of the example: the flocking itself, as an ordinary system on its own thread.  It is handed
	// `settings.params` by reference rather than by value, which is what lets the sliders below retune the flock
	// without a rebuild - each run sends whatever is in that object at that moment across to the worker.
	systems({ world, level, forceMainThread, deltaBetweenRuns }: ExampleSystemsConfig) {
		return [
			new SteeringSystem(world, {
				params: settings.params,
				bounds: level,
				forceMainThread,
				deltaBetweenRuns,
			}),
		];
	},

	controls(host): Array<Control> {
		return [
			{
				kind: 'slider',
				label: 'Boids',
				min: 1000,
				max: 50000,
				step: 1000,
				value: settings.count,
				format: value => value.toLocaleString(),
				// The flock is laid out when the world is built, so a new count is a rebuild.
				change(value) {
					settings.count = value;
					host.restart();
				},
			},
			{
				kind: 'slider',
				label: 'Separation',
				min: 0,
				max: 3,
				step: 0.1,
				value: settings.params.separation,
				format: value => value.toFixed(1),
				// Retuned live: the worker reads the weights off the world object every run, so dragging this
				// changes how hard the flock holds its spacing without a rebuild.  More of it and the flock spreads
				// into a loose haze; less and it tightens into knots.
				change(value) {
					settings.params.separation = value;
				},
			},
			{
				kind: 'slider',
				label: 'Alignment',
				min: 0,
				max: 3,
				step: 0.1,
				value: settings.params.alignment,
				format: value => value.toFixed(1),
				// More of it and the flock streams in long parallel lanes; less and headings scatter.
				change(value) {
					settings.params.alignment = value;
				},
			},
			{
				kind: 'slider',
				label: 'Cohesion',
				min: 0,
				max: 3,
				step: 0.1,
				value: settings.params.cohesion,
				format: value => value.toFixed(1),
				// More of it and the flock balls up tight; less and it frays apart into wandering strands.
				change(value) {
					settings.params.cohesion = value;
				},
			},
			{
				kind: 'slider',
				label: 'Vision',
				min: 20,
				max: 90,
				step: 5,
				value: settings.params.perception,
				format: value => `${value} u`,
				// How far each boid looks for flockmates.  Retuned live; a wider vision folds more of the flock into
				// every boid's steering, so it moves as one big body rather than many small ones.
				change(value) {
					settings.params.perception = value;
				},
			},
			{
				kind: 'slider',
				label: 'Speed',
				min: 60,
				max: 260,
				step: 10,
				value: settings.params.maxSpeed,
				format: value => `${value} u/s`,
				// The top speed the flock is held to.  The floor rides along under it so a fast flock never stalls:
				// kept a shade below the cap, out of the way unless the cap is dragged down onto it.
				change(value) {
					settings.params.maxSpeed = value;
					settings.params.minSpeed = Math.min(settings.params.minSpeed, value - 10);
				},
			},
		];
	},

	create(runtime): void {
		const { world, level } = runtime;
		const random = new Random(SEED);
		const { minSpeed, maxSpeed } = settings.params;

		// Scatter the flock across the whole level, each boid already moving at a random heading and speed - the
		// rules take it from there.  A boid is a small circle carrying a velocity and a render position; it has no
		// body at all, so nothing collides it and all that turns it is the steering system.
		for(let i = 0; i < settings.count; i++) {
			const heading = random.between(0, Math.PI * 2);
			const speed = random.between(minSpeed, maxSpeed);
			world.loadEntity({
				x: random.between(0, level.width),
				y: random.between(0, level.height),
				radius: BOID_RADIUS,
				velocityX: Math.cos(heading) * speed,
				velocityY: Math.sin(heading) * speed,
				// A render position for the canvas to draw, blended between the two positions physics published
				// either side of its last step - so even at a long step the flock stays smooth.
				interpolate: true,
			});
		}
	},

	// Colour each boid by the way it is heading, so alignment is legible: neighbours that have fallen into step
	// point the same way and so share a colour, and a flock in formation shows as one band of it.  The velocity is
	// read straight off the boid's block, and the shared style object is mutated rather than a new one made - see
	// boidStyle.
	entityStyle(_runtime, entity): EntityStyle | undefined {
		const velocity = entity.components.velocity;
		if(!velocity) {
			return undefined;
		}

		boidStyle.color = headingColor(Math.atan2(velocity.velocityY, velocity.velocityX));

		return boidStyle;
	},
};

// A heading, in radians, turned into a colour that runs the whole way round the wheel as the heading does - so
// the colour is the direction, and two boids going the same way are the same colour whatever corner of the level
// they are in.
function headingColor(angle: number): number {
	// atan2 gives -PI..PI; slide it to 0..1 round the hue wheel.
	const hue = (angle + Math.PI) / (2 * Math.PI);

	return hslToHex(hue, 0.65, 0.6);
}

// Hue, saturation and lightness (each 0..1) to a packed 0xRRGGBB int, the form the renderer wants.  The plain
// textbook conversion - no allocation, so it is cheap enough to run per boid per frame.
function hslToHex(h: number, s: number, l: number): number {
	const hue = h * 360;
	const chroma = (1 - Math.abs(2 * l - 1)) * s;
	const second = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
	const match = l - chroma / 2;

	let red = 0;
	let green = 0;
	let blue = 0;
	if(hue < 60) {
		red = chroma;
		green = second;
	} else if(hue < 120) {
		red = second;
		green = chroma;
	} else if(hue < 180) {
		green = chroma;
		blue = second;
	} else if(hue < 240) {
		green = second;
		blue = chroma;
	} else if(hue < 300) {
		red = second;
		blue = chroma;
	} else {
		red = chroma;
		blue = second;
	}

	return (Math.round((red + match) * 255) << 16) | (Math.round((green + match) * 255) << 8) | Math.round((blue + match) * 255);
}

export default boids;
