import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE, shapesOverlap } from '@daneren2005/shared-memory-physics';
import type { EntityStyle, Example } from '../example';
import type { Control } from '../controls';
import Random from '../random';
import { setSpeed } from './speed';

// The layout is drawn from a seeded generator so that moving a slider - which rebuilds the world - gives the
// same scene back with one thing changed rather than a different scene every time.
const SEED = 1357924680;
// A shape that cannot be dropped anywhere clear after this many tries is skipped, so a count far past what the
// level can hold settles at however many fit instead of hanging.
const PLACEMENT_ATTEMPTS = 200;
// A gap left between the sensor zones, so a couple of them read as separate blocks rather than one wide band.
const SENSOR_MARGIN = 40;
// A perfect bounce for the movers: the speed into whatever they hit comes straight back out, so the scene runs
// forever - and it is what makes a sensor obvious, since a mover sails through one where it would ricochet off a
// solid.
const BOUNCINESS = 1;

// Round-robin through the three shapes so even a handful of movers still shows one of each.
const SHAPES = [SHAPE_RECTANGLE, SHAPE_CIRCLE, SHAPE_CAPSULE];

// How a sensor is drawn: a calm, mostly see-through slate zone when nothing is inside it, and a lit red one the
// frame something is - which is the flag the detection system below sets, read straight back out here.
const SENSOR_IDLE: EntityStyle = { color: 0x64748B, alpha: 0.2 };
const SENSOR_ACTIVE: EntityStyle = { color: 0xF87171, alpha: 0.5 };

// The set of sensor entity ids that were overlapping something as of the last `update`.  Rebuilt from scratch
// every frame - a flag that is set while a mover is inside and clears the moment it leaves - and read back per
// sensor by `entityStyle` to pick its colour.  Module-level so the two halves share it without threading it
// through the runtime, and cleared on `create` so a rebuilt world does not open lit from the last one.
const triggered = new Set<number>();

const settings = {
	movers: 20,
	speed: 180,
	sensors: 3,
};

export const sensors: Example = {
	id: 'sensors',
	title: 'Sensors',
	description: 'Circles, rectangles and capsules bounce around the level, and a couple of sensor blocks sit still '
		+ 'in their way. A sensor is a body that takes part in detection but not in the response: a mover overlapping '
		+ 'one is still found and reported, so a game can react to it, but nothing is swept short against it and '
		+ 'nothing bounces off it - so the shapes pass straight through where they would ricochet off a solid. A '
		+ 'system runs every frame that checks each sensor against the movers and sets a flag when one is inside it, '
		+ 'and the sensor is drawn red while that flag is set and slate while it is clear. Watch a shape cross a zone: '
		+ 'it lights up as the shape enters and goes calm again the instant it leaves, all without the shape ever '
		+ 'slowing down.',
	backend: 'sweep',

	controls(host): Array<Control> {
		return [
			{
				kind: 'slider',
				label: 'Movers',
				min: 1,
				max: 200,
				value: settings.movers,
				change(value) {
					settings.movers = value;
					host.restart();
				},
			},
			{
				kind: 'slider',
				label: 'Speed',
				min: 20,
				max: 600,
				step: 10,
				value: settings.speed,
				format: value => `${value} u/s`,
				// Retuned live rather than rebuilt: the heading each mover is already on is kept and only how fast it
				// is going changes, so the scene carries on from where it was.
				change(value) {
					settings.speed = value;
					setSpeed(host.runtime, value);
				},
			},
			{
				kind: 'slider',
				label: 'Sensors',
				min: 0,
				max: 6,
				value: settings.sensors,
				change(value) {
					settings.sensors = value;
					host.restart();
				},
			},
		];
	},

	create(runtime): void {
		const { world, level } = runtime;
		const random = new Random(SEED);

		// A fresh world starts with nothing lit, so a rebuilt scene does not flash a colour left over from the last
		// one before the first `update` has had a chance to work out what is really overlapping.
		triggered.clear();

		// The sensor zones go down first and their spots are remembered, so the movers can be kept from spawning
		// right on top of one - a mover is allowed through a sensor, but starting already buried in one is a worse
		// opening than it needs to be.
		const placedSensors: Array<Placed> = [];
		for(let i = 0; i < settings.sensors; i++) {
			// A wide, flat block, big enough that a mover spends a moment inside it rather than clipping a corner.
			const width = random.between(80, 130);
			const height = random.between(60, 100);
			const reach = Math.hypot(width, height) / 2;

			const spot = findSpot(level, random, reach, placedSensors, SENSOR_MARGIN);
			if(!spot) {
				continue;
			}

			placedSensors.push({ x: spot.x, y: spot.y, reach });
			world.loadEntity({
				x: spot.x,
				y: spot.y,
				width,
				height,
				// The whole of what makes this a sensor: it is found and reported like any other body, but the sweep
				// never stops anything against it and the bounce never turns anything around off it, so movers pass
				// straight through.  No velocity, so the physics system never moves it - it just sits and watches.
				sensor: true,
			});
		}

		const placedMovers: Array<Placed> = [];
		for(let i = 0; i < settings.movers; i++) {
			// Round-robin the shape, random size on top, so no two of a kind are quite alike and every scene has all
			// three.
			const shape = SHAPES[i % SHAPES.length];
			const mover = makeMover(shape, random);

			const spot = findSpot(level, random, mover.reach, placedMovers, 0);
			if(!spot) {
				continue;
			}

			placedMovers.push({ x: spot.x, y: spot.y, reach: mover.reach });

			// A random heading at the current speed.
			const heading = random.between(0, Math.PI * 2);
			world.loadEntity({
				x: spot.x,
				y: spot.y,
				width: mover.width,
				height: mover.height,
				radius: mover.radius,
				shape: mover.shape,
				angle: mover.angle,
				velocityX: Math.cos(heading) * settings.speed,
				velocityY: Math.sin(heading) * settings.speed,
				// A perfect bounce off the walls and each other, which is also what makes passing clean through a
				// sensor read as deliberate rather than as a shape that simply failed to notice it.
				bounciness: BOUNCINESS,
				// A render position for the canvas to draw, blended between the two positions physics published
				// either side of its last step.
				interpolate: true,
			});
		}
	},

	// The detection system: once a frame, work out which sensors have a mover inside them and record it.  It runs
	// on the main thread - so it reads the rich component getters the renderer draws from rather than the raw
	// worker blocks - and it is a plain overlap test per sensor per mover, which at these counts is nothing.  A
	// game with far more of either would narrow the field with a SpatialIndex first (the same one the library's
	// own broadphase is built on); the point being shown here is the sensor, not the search.
	update(runtime): void {
		// Rebuilt from empty every frame: a sensor is lit only while something is genuinely inside it this frame,
		// so last frame's answer is thrown away rather than added to.
		triggered.clear();

		const entities = [...runtime.world.entities.values()];
		// The movers are everything the physics system actually moves, which is everything with a velocity - so
		// this leaves out both the sensors themselves and the level's four walls, none of which have one.
		const movers = entities.filter(entity => entity.components.velocity);

		for(const entity of entities) {
			const body = entity.components.body;
			const transform = entity.components.transform;
			if(!body?.sensor || !transform) {
				continue;
			}

			for(const mover of movers) {
				const moverBody = mover.components.body;
				const moverTransform = mover.components.transform;
				if(!moverBody || !moverTransform) {
					continue;
				}

				// The same shape-accurate test the library collides with, so a circle clips the corner of a
				// rectangular zone exactly the way it looks like it should rather than as the box around it would.
				if(shapesOverlap(
					body.shape, transform.x, transform.y, transform.width, transform.height, transform.angle,
					moverBody.shape, moverTransform.x, moverTransform.y, moverTransform.width, moverTransform.height, moverTransform.angle,
				)) {
					triggered.add(entity.eid);

					// One mover inside is enough to light the sensor; there is nothing more to learn from the rest.
					break;
				}
			}
		}
	},

	// Asked per entity per frame.  A sensor is coloured by the flag the system above set - red while something is
	// inside it, slate while it is clear - and everything else is left to the renderer's own palette.
	entityStyle(runtime, entity): EntityStyle | undefined {
		if(!entity.components.body?.sensor) {
			return undefined;
		}

		return triggered.has(entity.eid) ? SENSOR_ACTIVE : SENSOR_IDLE;
	},
};

// A spot the movers and sensors are placed at, kept only so far as the reach needed to space the next one off it.
interface Placed {
	x: number
	y: number
	reach: number
}

// One of the three moving shapes, resolved to the exact config a load wants plus the `reach` used to space it:
// the distance from its centre to its furthest point, which is all the placement below needs whatever it is.
interface Mover {
	shape: number
	width?: number
	height?: number
	radius?: number
	angle?: number
	reach: number
}

function makeMover(shape: number, random: Random): Mover {
	if(shape === SHAPE_CIRCLE) {
		const radius = random.between(8, 16);

		return { shape, radius, reach: radius };
	}

	if(shape === SHAPE_CAPSULE) {
		// A capsule is `width` end to end and `height` thick; keeping the width the longer of the two is what makes
		// it read as a capsule rather than a fat circle.  Laid at a random angle, its reach is half its length.
		const height = random.between(10, 16);
		const width = height + random.between(12, 28);

		return { shape, width, height, angle: random.between(0, Math.PI), reach: width / 2 };
	}

	// A rectangle, square to the world - the reach is the half-diagonal, the corner being its furthest point.
	const width = random.between(16, 34);
	const height = random.between(16, 34);

	return { shape, width, height, reach: Math.hypot(width, height) / 2 };
}

// Finds a spot whose `reach` clears every shape already down in `placed` - and the level's edges - by `margin`,
// or gives up after enough tries so a crowded level places fewer than asked rather than looping forever.
function findSpot(level: { width: number, height: number }, random: Random, reach: number, placed: Array<Placed>, margin: number): { x: number, y: number } | undefined {
	for(let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
		const x = random.between(reach, level.width - reach);
		const y = random.between(reach, level.height - reach);

		if(placed.every(other => Math.hypot(x - other.x, y - other.y) >= reach + other.reach + margin)) {
			return { x, y };
		}
	}

	return undefined;
}

export default sensors;
