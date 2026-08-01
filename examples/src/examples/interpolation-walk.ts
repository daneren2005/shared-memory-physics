import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import type { Control } from '../controls';
import type { Example } from '../example';
import type { Components, Config } from '../world';

const UNIT_RADIUS = 16;
// Wide enough that the fastest walk cannot cross it in one step of the slowest physics rate: a sweep looks at
// where a move *ends*, so a step covering more ground than the box is deep would find nothing left to land on
// and go clean through it.  400 u/s against a 200ms step is 80 units, which this has to stay ahead of.
const BOX_WIDTH = 100;
const BOX_HEIGHT = 240;

const settings = {
	speed: 300,
	turnEvery: 1500,
	gap: 240,
};

// The one entity this example steers, kept so the timer below does not have to look it up.  Rebuilt with the
// world on every restart, and read back through the runtime rather than through a stale world - which is why
// it is cleared as well as set.
let unit: BaseEntity<Components, Config> | undefined;
let direction = 1;
let sinceTurn = 0;

export const interpolationWalk: Example = {
	id: 'walk',
	title: 'Walking into a wall',
	description: 'One unit between two boxes, turned around every couple of seconds so it walks into the box on '
		+ 'the other side and presses against it until its turn comes round again. Nothing bounces here: physics '
		+ 'stops it on the face of the box and leaves it there. This one starts on a deliberately long 100ms '
		+ 'physics step - ten steps a second against sixty frames - so turning "interpolate rendering" off shows '
		+ 'exactly what the interpolation is doing: the same simulation, drawn six frames at a time instead of '
		+ 'one. Watch the moment it turns around and the moment it presses into a box, which are the two places '
		+ 'a renderer guessing forward from the velocity would overshoot and snap back.',
	backend: 'stop',
	// Long enough that the choppiness is unmistakable rather than something to squint at.
	physicsStep: 100,

	controls(host): Array<Control> {
		return [
			{
				kind: 'slider',
				label: 'Speed',
				min: 20,
				// The top of this against the top of the physics step slider is what BOX_WIDTH is sized for, so
				// the example stays about interpolation rather than about tunnelling wherever the two are left.
				max: 400,
				step: 10,
				value: settings.speed,
				format: value => `${value} u/s`,
				// Applied live, and to the direction it is currently walking in, so the unit does not turn round
				// just because the slider moved.
				change(value) {
					settings.speed = value;
					const velocity = unit?.components.velocity;
					if(velocity) {
						velocity.velocityX = value * direction;
					}
				},
			},
			{
				kind: 'slider',
				label: 'Turn every',
				min: 500,
				max: 5000,
				step: 100,
				value: settings.turnEvery,
				format: value => `${(value / 1000).toFixed(1)} s`,
				change(value) {
					settings.turnEvery = value;
				},
			},
			{
				kind: 'slider',
				label: 'Gap',
				min: 80,
				// Far enough out that the boxes still have the level's own wall behind them at full stretch.
				max: 350,
				step: 10,
				value: settings.gap,
				format: value => `${value} u`,
				change(value) {
					settings.gap = value;
					host.restart();
				},
			},
		];
	},

	create(runtime): void {
		const { world, level } = runtime;
		const middleX = level.width / 2;
		const middleY = level.height / 2;

		// Two boxes with a size but no velocity.  The physics system never moves them - it only moves what has
		// both a transform and a velocity - but they are still found as the other half of a collision, which is
		// what makes them something to walk into rather than through.  They still ask to be interpolated: the
		// render position of something that never moves simply tracks its transform, which is one branch fewer
		// than deciding per entity whether it is the kind of thing that moves.
		world.loadEntity({ x: middleX - settings.gap, y: middleY, width: BOX_WIDTH, height: BOX_HEIGHT, interpolate: true });
		world.loadEntity({ x: middleX + settings.gap, y: middleY, width: BOX_WIDTH, height: BOX_HEIGHT, interpolate: true });

		direction = 1;
		sinceTurn = 0;
		unit = world.loadEntity({
			x: middleX,
			y: middleY,
			radius: UNIT_RADIUS,
			velocityX: settings.speed * direction,
			velocityY: 0,
			// What gives the entity an interpolation block at all, and so what the canvas draws it from.
			interpolate: true,
		});
	},

	// The kind of game logic that has nothing to do with physics: a timer on the main thread that writes a new
	// velocity into the shared block, which the next physics run - wherever it is running - picks up.
	update(runtime, elapsedTime): void {
		sinceTurn += elapsedTime;
		if(sinceTurn < settings.turnEvery) {
			return;
		}

		sinceTurn -= settings.turnEvery;
		direction = -direction;

		const velocity = unit?.components.velocity;
		if(velocity) {
			// The velocity is *not* zeroed when the unit is stopped by a box - physics decides how far a move
			// gets, not what the entity wants - so this is always turning a live heading around rather than
			// starting one from rest.
			velocity.velocityX = settings.speed * direction;
		}
	},
};

export default interpolationWalk;
