import { snapEntity } from '@daneren2005/shared-memory-physics';
import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import type { Control } from '../controls';
import type { EntityStyle, Example, ExampleHost, ExampleRuntime, HudText } from '../example';
import { BRICK_CATEGORY } from '../physics/breakout-update';
import type { Components, Config } from '../world';

// Breakout, built on top of the same sweep-and-bounce every other example runs.  The ball is an ordinary mover
// carrying a `bounciness` component, so the library turns it around off the walls, the bricks and the paddle
// natively - there is no bounce code in the game at all.  What the game adds is:
//
//   - a brick dies in the physics thread: the breakout backend runs a collision callback that kills a brick the
//     ball has bounced off (see ../physics/breakout-update.ts).  The game only watches for the removal - which is
//     how it scores - rather than testing overlaps itself;
//   - the paddle is steered by the arrow keys, which set its velocity and let physics carry (and wall-clamp) it;
//   - the angle off the paddle is the game's own, taken from where the ball lands across the paddle, so you aim
//     by moving.
//
// The bounciness is a little over 1, so every bounce hands the ball back a touch more speed than it came in with
// and a rally slowly winds up - capped short of where a 50ms step could carry it clean through a brick.

// One world unit is one pixel.  The ball is a small circle; the paddle a wide, thin box near the bottom.
const BALL_RADIUS = 8;
const PADDLE_HEIGHT = 18;
// How far the paddle's centre sits above the bottom edge of the level.
const PADDLE_BOTTOM_MARGIN = 40;

// The brick field: a grid inset from the sides, starting below a strip left clear at the top for the HUD.
const FIELD_TOP = 72;
const FIELD_SIDE = 30;
const BRICK_HEIGHT = 22;
const BRICK_GAP = 5;

// How many lives a new game starts with.
const START_LIVES = 3;

// How fast the paddle travels while a key is held, in units per second.  Not a slider - it is feel, not something
// the demonstration is about - so it is fixed here.
const PADDLE_SPEED = 520;

// The furthest the paddle can throw the ball off vertical, in radians - a hit dead-centre goes straight up, a
// hit right on the edge comes off at this angle.  A touch under 60 degrees, so an edge hit is sharp without ever
// sending the ball sideways enough to stall.
const MAX_ENGLISH = 1.0;
// The least share of the ball's speed that has to be vertical, kept every frame so a rally can never settle into
// a flat left-right bounce with nothing coming down - the ball always makes progress up or down.  The redirect
// keeps the ball's speed, only its heading changes.
const MIN_VERTICAL_FRACTION = 0.2;

// The fastest the ball is ever allowed to travel, in units per second.  This is a physics limit, not a difficulty
// one: physics runs on a 50ms step and a move is swept to where it *ends*, so a single step covering more ground
// than an obstacle is thick would land the ball past it with nothing left to stop against.  At this speed a step
// is about 28 units, comfortably inside the shallowest thing the ball has to bounce off (the paddle and the brick
// faces), so the winding-up bounciness has somewhere to climb to without ever punching through.
const MAX_BALL_SPEED = 560;

// How much slack the paddle overlap test is given, in units: enough to still catch the ball resting on the paddle
// a frame after it lands there, so the game sets the outgoing angle before the ball leaves.
const PADDLE_SKIN = 6;

// One colour per brick row, cycled top to bottom, so the field reads as bands.  A higher row is worth more, which
// falls out of `settings.rows - row` below rather than living in this list.
const ROW_COLORS = [0xF87171, 0xFB923C, 0xFBBF24, 0x4ADE80, 0x38BDF8, 0xA78BFA, 0xF472B6];

const BALL_COLOR = 0xF8FAFC;
const PADDLE_COLOR = 0x38BDF8;

const settings = {
	// The speed the ball launches at.  It winds up from here as it bounces (see bounciness) rather than being held
	// to this, so this is only where a life starts.
	ballSpeed: 240,
	bounciness: 1.1,
	paddleWidth: 120,
	rows: 6,
	cols: 12,
};

// Where the game currently is.  'ready' is the ball sitting on the paddle waiting to be launched, 'playing' is a
// ball in flight, and 'won'/'lost' are the two ends, each waiting on a space to start over.
type State = 'ready' | 'playing' | 'won' | 'lost';

// A live brick, keyed in the map below by its entity id.  It holds only what the game needs once the physics
// thread has taken the entity away: the colour to draw it and the points it is worth when it dies.
interface Brick {
	color: number
	points: number
}

// All of the game's state is module-level and rebuilt from scratch in `create`, the same way the sensors example
// keeps its `triggered` set: an example outlives any number of world rebuilds, and its control handlers reach the
// live state through here rather than closing over a world a restart has already thrown away.
let host: ExampleHost | undefined;
let ball: BaseEntity<Components, Config> | undefined;
let paddle: BaseEntity<Components, Config> | undefined;
// The live bricks, keyed by entity id so `entityStyle` can colour one by id and the death handler in `create` can
// score one by id as the physics thread removes it.
const bricks = new Map<number, Brick>();
let state: State = 'ready';
let score = 0;
let lives = START_LIVES;

// The keys, updated by the listeners at the bottom of this file and read here every frame.  `action` is the space
// bar, which both launches the ball and starts a new game.
const keys = { left: false, right: false, action: false };
// So a launch (or a restart) fires once per press rather than every frame the space bar is held.  See update.
let actionLatched = false;

export const breakout: Example = {
	id: 'breakout',
	title: 'Breakout',
	description: 'The classic, built on the same sweep-and-bounce every other example runs. The ball is an '
		+ 'ordinary mover with a bounciness a little over 1, so the library turns it around off the walls, the '
		+ 'bricks and the paddle natively - and hands back a touch more speed each time, so a rally slowly winds '
		+ 'up. What the game adds sits on top: a brick is killed in the physics thread by a collision callback the '
		+ 'breakout backend runs (the game only watches for the removal, to score it), the arrow keys set the '
		+ 'paddle\'s velocity and physics carries it (the side walls stop it for free), and the angle off the '
		+ 'paddle is taken from where the ball lands across it, so you aim by moving. Physics runs at the usual '
		+ '50ms step with the motion interpolated for the screen. Left and right to move, space to launch. Clear '
		+ 'every brick to win; miss the ball three times and it is over.',
	backend: 'breakout',

	controls(hostArg): Array<Control> {
		// Captured once when the example is selected and reached by the key handlers (for a restart) and by the
		// live-tuning sliders below, so none of them has to close over a particular world.
		host = hostArg;

		return [
			{
				kind: 'slider',
				label: 'Launch speed',
				min: 140,
				max: 320,
				step: 10,
				value: settings.ballSpeed,
				format: value => `${value} u/s`,
				// Only the launch speed, so this takes effect the next time the ball leaves the paddle rather than
				// retuning one already winding up in flight.
				change(value) {
					settings.ballSpeed = value;
				},
			},
			{
				kind: 'slider',
				label: 'Bounciness',
				min: 1,
				max: 1.3,
				step: 0.05,
				value: settings.bounciness,
				format: value => value.toFixed(2),
				// Applied live: bounciness is a plain float on the ball's own block, so writing it changes how much
				// speed the very next bounce hands back with no rebuild.
				change(value) {
					settings.bounciness = value;
					const bounciness = ball?.components.bounciness;
					if(bounciness) {
						bounciness.bounciness = value;
					}
				},
			},
			{
				kind: 'slider',
				label: 'Paddle width',
				min: 60,
				max: 220,
				step: 10,
				value: settings.paddleWidth,
				// Applied live: the collision reads the paddle's size straight off its transform, so writing the
				// width widens what the ball bounces off with no rebuild.
				change(value) {
					settings.paddleWidth = value;
					const transform = paddle?.components.transform;
					if(transform) {
						transform.width = value;
					}
				},
			},
			{
				kind: 'slider',
				label: 'Rows',
				min: 1,
				max: 7,
				value: settings.rows,
				// The brick grid is laid out once when the world is built, so changing it starts a new game.
				change(value) {
					settings.rows = value;
					host?.restart();
				},
			},
			{
				kind: 'slider',
				label: 'Columns',
				min: 4,
				max: 18,
				value: settings.cols,
				change(value) {
					settings.cols = value;
					host?.restart();
				},
			},
			{
				kind: 'button',
				label: 'New game',
				press: () => host?.restart(),
			},
		];
	},

	create(runtime): void {
		const { world, level } = runtime;

		// A fresh game: throw away everything the last world left behind so nothing here points at an entity a
		// rebuild has already freed.
		bricks.clear();
		ball = undefined;
		paddle = undefined;
		score = 0;
		lives = START_LIVES;
		state = 'ready';
		// The space bar may well be held right now - it is what triggered the restart - so require it to be released
		// and pressed again before it launches the ball, rather than launching on the same press.
		actionLatched = true;

		// The level's four walls are laid down by the page before this runs, and Breakout wants the bottom one
		// gone: a ball that gets past the paddle should fall out of play, not bounce back up.  The bottom wall is
		// the one whose centre sits below the level - every other entity in the world right now (the other three
		// walls) is above or beside it - so it is found by that and removed.
		for(const entity of world.entities.values()) {
			const transform = entity.components.transform;
			if(transform && transform.y > level.height) {
				world.removeEntity(entity);
				break;
			}
		}

		// A brick dies in the physics thread (the breakout backend's collision callback calls `entityDied`), which
		// the ECS turns into an ordinary removal on the main thread.  That removal is what the game scores off: the
		// entity is looked up in the brick map, credited, and dropped.  Watched here rather than in `update` because
		// the death lands whenever the physics run reports back, which on a worker is not on any particular frame.
		world.on('entity-removed', (entity: BaseEntity<Components, Config>) => {
			const brick = bricks.get(entity.eid);
			if(brick) {
				score += brick.points;
				bricks.delete(entity.eid);
			}
		});

		buildBricks(runtime);

		paddle = world.loadEntity({
			x: level.width / 2,
			y: level.height - PADDLE_BOTTOM_MARGIN,
			width: settings.paddleWidth,
			height: PADDLE_HEIGHT,
			// A velocity it is steered through - the arrow keys write into it and physics does the moving, so the
			// side walls stop the paddle the same way they stop anything else.
			velocityX: 0,
			velocityY: 0,
			interpolate: true,
		});

		// The ball carries the bounciness that makes it turn around off everything - and hand back a little extra
		// speed each time - and starts at rest; `update` sits it on the paddle every frame until it is launched.
		ball = world.loadEntity({
			x: level.width / 2,
			y: level.height - PADDLE_BOTTOM_MARGIN - PADDLE_HEIGHT / 2 - BALL_RADIUS - 1,
			radius: BALL_RADIUS,
			velocityX: 0,
			velocityY: 0,
			bounciness: settings.bounciness,
			interpolate: true,
		});
	},

	update(runtime): void {
		const { level } = runtime;
		if(!ball || !paddle) {
			return;
		}

		const ballTransform = ball.components.transform;
		const ballVelocity = ball.components.velocity;
		const paddleTransform = paddle.components.transform;
		const paddleVelocity = paddle.components.velocity;
		if(!ballTransform || !ballVelocity || !paddleTransform || !paddleVelocity) {
			return;
		}

		// A press this frame is the space bar down now and up (or already consumed) last frame, so holding it does
		// nothing after the first frame.
		const actionPressed = keys.action && !actionLatched;
		actionLatched = keys.action;

		// Both ends of the game freeze everything and wait for a fresh press to start over.
		if(state === 'won' || state === 'lost') {
			if(actionPressed) {
				host?.restart();
			}

			return;
		}

		// The paddle follows the keys whether the ball is in flight or still waiting to be launched, so the player
		// can line up a shot before letting go of it.
		paddleVelocity.velocityX = ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * PADDLE_SPEED;
		paddleVelocity.velocityY = 0;

		if(state === 'ready') {
			parkBallOnPaddle(ballTransform, ballVelocity, paddleTransform);

			if(actionPressed) {
				launch(ballVelocity);
			}

			return;
		}

		// In flight: keep it inside its speed limits and off a flat rally, let the paddle set its angle, and check
		// whether it has been won or lost this frame.  Nothing removes a brick here - that happens in the physics
		// thread, and the death handler in `create` has already scored anything that fell this frame.
		conditionBall(ballVelocity);
		bounceOffPaddle(ballTransform, ballVelocity, paddleTransform);

		if(bricks.size === 0) {
			state = 'won';
			freeze(ballVelocity, paddleVelocity);

			return;
		}

		// Past the bottom edge with the bottom wall gone: the ball is out of play.
		if(ballTransform.y - BALL_RADIUS > level.height) {
			loseLife(ballVelocity, paddleVelocity);
		}
	},

	// The ball is white, the paddle its own blue, and each brick keeps the colour of its row; everything else -
	// there is nothing else left in view - falls back to the renderer's default.
	entityStyle(runtime, entity): EntityStyle | undefined {
		if(entity === ball) {
			return { color: BALL_COLOR, alpha: 1 };
		}
		if(entity === paddle) {
			return { color: PADDLE_COLOR, alpha: 1 };
		}

		const brick = bricks.get(entity.eid);
		if(brick) {
			return { color: brick.color, alpha: 1 };
		}

		return undefined;
	},

	// The score and lives in the corner, and a banner across the middle for whatever the game is waiting on - a
	// launch, or a fresh start after a win or a loss.  Cleared to nothing while a ball is in flight.
	hud(): HudText | undefined {
		const status = [`Score  ${score}`, `Lives  ${lives}`, `Bricks ${bricks.size}`];

		let banner: string | undefined;
		if(state === 'ready') {
			banner = 'Press space to launch\n← → to move';
		} else if(state === 'won') {
			banner = `You cleared the board!\nScore ${score}\nPress space to play again`;
		} else if(state === 'lost') {
			banner = `Game over\nScore ${score}\nPress space to play again`;
		}

		return { status, banner };
	},
};

// Lays out the brick grid, inset from the sides and starting below the HUD strip, and records each one so it can
// be coloured and scored by id.  Each brick is tagged with BRICK_CATEGORY, which is how the physics thread's
// collision callback tells it apart from the walls and the paddle - see ../physics/breakout-update.ts.
function buildBricks(runtime: ExampleRuntime): void {
	const { world, level } = runtime;
	const { rows, cols } = settings;

	// The bricks fill the width between the side insets, sharing the gaps between them, so a wider grid means
	// narrower bricks rather than a field that runs off the edge.
	const fieldWidth = level.width - FIELD_SIDE * 2;
	const brickWidth = (fieldWidth - (cols - 1) * BRICK_GAP) / cols;

	for(let row = 0; row < rows; row++) {
		const color = ROW_COLORS[row % ROW_COLORS.length];
		// A higher row is worth more: the top row is worth `rows` and the bottom row 1.
		const points = rows - row;
		const y = FIELD_TOP + row * (BRICK_HEIGHT + BRICK_GAP) + BRICK_HEIGHT / 2;

		for(let col = 0; col < cols; col++) {
			const x = FIELD_SIDE + col * (brickWidth + BRICK_GAP) + brickWidth / 2;
			// A static box with the brick tag: a size (so it is a solid the ball rests against and bounces off) and
			// no velocity (so physics never moves it), collided as BRICK_CATEGORY so the callback can find it.
			const entity = world.loadEntity({
				x,
				y,
				width: brickWidth,
				height: BRICK_HEIGHT,
				collideCategory: BRICK_CATEGORY,
			});

			bricks.set(entity.eid, { color, points });
		}
	}
}

// Sits the ball on the paddle, ready to launch.  Because it is a teleport - the ball is being placed rather than
// moving there - the transform is written and then `snapEntity` collapses the interpolation segment onto it, so
// the ball is drawn sitting on the paddle rather than sliding across from wherever it was last step.  It is
// parked on the paddle's *rendered* position, which moves smoothly every frame, so the resting ball tracks the
// smoothly-drawn paddle rather than jumping with it once per 50ms physics step.
function parkBallOnPaddle(ballTransform: NonNullable<Components['transform']>, velocity: NonNullable<Components['velocity']>, paddleTransform: NonNullable<Components['transform']>): void {
	const paddleRender = paddle?.components.interpolation;
	ballTransform.x = paddleRender?.x ?? paddleTransform.x;
	ballTransform.y = (paddleRender?.y ?? paddleTransform.y) - paddleTransform.height / 2 - BALL_RADIUS - 1;
	velocity.velocityX = 0;
	velocity.velocityY = 0;

	if(ball) {
		snapEntity(ball);
	}
}

// Sends the ball off the paddle at a slight angle - toward whichever way the paddle is being pushed, or a random
// side if it is still - so it never launches dead straight into a vertical rut.
function launch(velocity: NonNullable<Components['velocity']>): void {
	const bias = keys.left ? -1 : keys.right ? 1 : (Math.random() < 0.5 ? -1 : 1);
	const theta = 0.35 * bias;
	velocity.velocityX = Math.sin(theta) * settings.ballSpeed;
	velocity.velocityY = -Math.cos(theta) * settings.ballSpeed;
	state = 'playing';
}

// Keeps the ball inside the two limits a winding-up rally needs, every frame: never faster than the step can
// safely resolve (see MAX_BALL_SPEED), and never so flat that it stops making vertical progress.  Both preserve
// the heading where they can - the cap scales the whole velocity, the vertical floor only redirects - so the
// bounciness is free to build the speed up between them without this cancelling it.
function conditionBall(velocity: NonNullable<Components['velocity']>): void {
	let velocityX = velocity.velocityX;
	let velocityY = velocity.velocityY;
	let magnitude = Math.hypot(velocityX, velocityY);
	if(magnitude === 0) {
		return;
	}

	if(magnitude > MAX_BALL_SPEED) {
		const scale = MAX_BALL_SPEED / magnitude;
		velocityX *= scale;
		velocityY *= scale;
		magnitude = MAX_BALL_SPEED;
	}

	const minVertical = magnitude * MIN_VERTICAL_FRACTION;
	if(Math.abs(velocityY) < minVertical) {
		const signY = velocityY < 0 ? -1 : 1;
		const signX = velocityX < 0 ? -1 : 1;
		velocityY = signY * minVertical;
		// Whatever speed is left after the vertical floor goes into the horizontal, keeping the side it was headed.
		velocityX = signX * Math.sqrt(Math.max(0, magnitude * magnitude - velocityY * velocityY));
	}

	velocity.velocityX = velocityX;
	velocity.velocityY = velocityY;
}

// The paddle's own bounce.  When the ball is touching the paddle, its outgoing direction is set from where it
// landed across the paddle's width - centre goes straight up, the edges throw it out to the sides - so the player
// steers the ball by moving.  The current speed is kept, so a bounce off the paddle winds the ball up exactly
// like a bounce off anything else; only the heading is the game's.  This overrides the native vertical bounce the
// ball would otherwise take off the paddle, which is why the paddle carries no bounciness of its own.
function bounceOffPaddle(ballTransform: NonNullable<Components['transform']>, velocity: NonNullable<Components['velocity']>, paddleTransform: NonNullable<Components['transform']>): void {
	const reachX = BALL_RADIUS + paddleTransform.width / 2 + PADDLE_SKIN;
	const reachY = BALL_RADIUS + paddleTransform.height / 2 + PADDLE_SKIN;
	if(Math.abs(ballTransform.x - paddleTransform.x) >= reachX || Math.abs(ballTransform.y - paddleTransform.y) >= reachY) {
		return;
	}

	// -1 at the left edge, 0 at the centre, +1 at the right.  Measured across the paddle's half-width plus the
	// ball's radius, so a hit on the very corner reaches the full angle rather than falling just short.
	const span = paddleTransform.width / 2 + BALL_RADIUS;
	const offset = clamp((ballTransform.x - paddleTransform.x) / span, -1, 1);
	const theta = offset * MAX_ENGLISH;
	const speed = Math.hypot(velocity.velocityX, velocity.velocityY);
	velocity.velocityX = Math.sin(theta) * speed;
	velocity.velocityY = -Math.cos(theta) * speed;
}

// A life is gone: either it is over, or the ball goes back onto the paddle for another go.  The 'ready' branch of
// update re-parks it there, so here it only has to reset the state and stop the ball.
function loseLife(ballVelocity: NonNullable<Components['velocity']>, paddleVelocity: NonNullable<Components['velocity']>): void {
	lives--;
	if(lives <= 0) {
		state = 'lost';
		freeze(ballVelocity, paddleVelocity);

		return;
	}

	state = 'ready';
	ballVelocity.velocityX = 0;
	ballVelocity.velocityY = 0;
}

// Stops the ball and the paddle dead, for the two states that are waiting on the player rather than simulating.
function freeze(ballVelocity: NonNullable<Components['velocity']>, paddleVelocity: NonNullable<Components['velocity']>): void {
	ballVelocity.velocityX = 0;
	ballVelocity.velocityY = 0;
	paddleVelocity.velocityX = 0;
	paddleVelocity.velocityY = 0;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

// The keyboard, wired once when this module loads rather than per world, so there is no listener to add and
// remove as the game is rebuilt.  The handlers only ever set the flags above; `update` - which runs only while
// this example is the one on screen - is the only thing that reads them, so the listeners sitting idle while
// another example is up costs nothing and touches nothing.  The default is suppressed only for the keys the game
// uses, and only while it is the current example (its id is the page's route), so arrow-key scrolling and the
// space bar are left alone everywhere else.
function setKey(event: KeyboardEvent, down: boolean): void {
	let handled = true;
	switch(event.key) {
		case 'ArrowLeft':
			keys.left = down;
			break;
		case 'ArrowRight':
			keys.right = down;
			break;
		case ' ':
			keys.action = down;
			break;
		default:
			handled = false;
	}

	if(handled && location.hash.slice(1) === breakout.id) {
		event.preventDefault();
	}
}

if(typeof window !== 'undefined') {
	window.addEventListener('keydown', event => setKey(event, true));
	window.addEventListener('keyup', event => setKey(event, false));
}

export default breakout;
