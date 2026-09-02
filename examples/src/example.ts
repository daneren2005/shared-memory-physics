import type { BaseEntity, System } from '@daneren2005/shared-memory-ecs';
import type { InterpolationSystem, PhysicsSystem } from '@daneren2005/shared-memory-physics';
import type { Control } from './controls';
import type { Level } from './level';
import type { PhysicsBackendName } from './physics';
import type { Components, Config, ExampleWorld } from './world';

// How an example wants one of its entities drawn, when the renderer's own rule - palette by id for a mover, flat
// grey for scenery - is not what it means to show.  The sensors example returns one of these for a sensor block
// so it reads as a zone rather than a solid, and flips its colour the frame something is inside it.
export interface EntityStyle {
	// Fill and stroke colour as a Phaser hex int.
	color: number
	// Fill opacity from 0 to 1, so a zone can be drawn see-through with the shapes passing through it still
	// visible on top.  Left off, the renderer uses the same fill alpha it draws everything else at.
	alpha?: number
	// A small example-specific drawing layered into the shared renderer. Most entities use their physics shape;
	// game examples can opt into one of these appearances without changing what they collide as.
	appearance?: 'stick-figure' | 'coin' | 'enemy'
}

// Text an example wants drawn over the canvas, on top of the shapes.  The renderer's own job is the world -
// palette by id, grey for scenery - and it has nothing to say about a score or a "you win", so an example that
// is a game rather than a demonstration returns this from `hud` and the renderer lays it out.  The breakout
// example is the one that uses it; the rest leave `hud` off and nothing is drawn.
export interface HudText {
	// Short lines pinned to the top-left corner - a score, a life count - drawn small and one under the next.
	status?: ReadonlyArray<string>
	// A single message across the middle of the canvas, large: "Press space to launch", "Game over". Left off
	// (or empty) when there is nothing to announce, so the middle of the field is clear during play.
	banner?: string
}

// A world that has been built and had its walls put in, handed to an example so it can fill it.
export interface ExampleRuntime {
	world: ExampleWorld
	physics: PhysicsSystem<Components>
	// Fills in the render position every frame from the two positions physics published either side of its last
	// step.  Nothing here talks to it - a renderer reads `interpolation.x` off the entity - but it is on the
	// runtime so the page can say whether the world has one.
	interpolation: InterpolationSystem<Components>
	level: Level
}

// What an example is told when it is asked for its own systems - everything the page has already settled for the
// physics system, so an example's system runs on the same terms as the one beside it.
export interface ExampleSystemsConfig {
	// The world being built, to hand the system's constructor.
	world: ExampleWorld
	// The bounds this example is laying its entities out in, which is what a system that steers off the edges of
	// the field needs.
	level: Level
	// The state of the page's "Run physics in a worker" toggle, inverted: true means run in-process.  Passed on
	// so a system started here goes to the same backend physics did rather than quietly staying on a worker.
	forceMainThread: boolean
	// The step the page's slider is currently on, in milliseconds.
	deltaBetweenRuns: number
}

// What an example can ask the page for from inside a control handler.
export interface ExampleHost {
	// The running world, or undefined for the moment between a rebuild starting and the new world being ready
	// (starting a real worker is asynchronous).  A control that retunes something live has to allow for that.
	readonly runtime: ExampleRuntime | undefined
	// Throws the world away and builds it again from the current control values, for a slider - a count, a size -
	// that cannot be applied to entities that already exist.
	restart(): void
}

export interface Example {
	// Used in the url hash, so it is what a link to a particular example is.
	id: string
	title: string
	description: string
	// Which physics update this example's world runs.  There is one now - movement with collision detection that
	// sweeps - and an example bounces or not by whether the entities it loads carry a bounciness component.
	backend: PhysicsBackendName
	// Where the page's physics step slider starts for this example, in milliseconds, defaulting to the library's
	// own 50.  An example whose point is what a long step looks like asks for a longer one.
	physicsStep?: number
	// The world this example simulates in, defaulting to the shared LEVEL the canvas is sized to.  An example that
	// wants more room than that - boids, so the flock is not packed tight - sets a bigger one here, and the camera
	// zooms out to fit it in the same canvas rather than the canvas growing.  Kept to the canvas' aspect ratio so
	// the zoom is uniform and nothing is letterboxed.  This is the `level` an example is handed in its runtime, so
	// it lays its entities out (and reads its edges) in these units.
	world?: Level

	// Whether this example is a swarm - thousands of tiny movers the renderer should draw as heading-pointed
	// darts in one cheap pass rather than as outlined shapes one at a time.  Set by boids; left off (drawn the
	// normal way) by every other example.  See the swarm path in the renderer.
	swarm?: boolean
	// Whether to measure and show, in the stats panel, how long the world's update is taking - the main thread and
	// each physics system.  Worth the handful of timers only for a stress test whose whole point is how it scales,
	// which is boids; every other example leaves it off.  See PerformanceTiming and the page's stats.
	timing?: boolean

	// Systems this example runs *besides* the standard physics one - the boids steering, which writes the
	// velocities physics then integrates.  They are added to the world in front of the physics system, so a
	// velocity written on a frame is moved on that same frame, and the page's step slider retunes them alongside
	// it: they are all one simulation running at one rate.
	//
	// Handed the bare world rather than the runtime because the runtime is not finished until the physics system
	// it carries exists, and this runs before that.  Called once per world, so a system built here is thrown away
	// and rebuilt with everything else on a restart.
	systems?(config: ExampleSystemsConfig): Array<System<Components>>

	// The sliders and buttons to show beside the canvas.  Built once when the example is selected, and outliving
	// any number of rebuilds, so a control handler reaches the live world through `host` rather than closing
	// over one.
	controls(host: ExampleHost): Array<Control>

	// Fills a freshly built world.  Called again from scratch on every restart, so it must not depend on
	// anything left over from the last one.
	create(runtime: ExampleRuntime): void

	// Run once per rendered frame, immediately before the world update it belongs to.  This is where an example
	// puts the game logic that is not physics - the walk example's turn-around timer - and it runs on the main
	// thread, unlike the collision callbacks, so it has entities and components rather than raw blocks.
	update?(runtime: ExampleRuntime, elapsedTime: number): void

	// Called when the canvas is clicked, with the point in world units - one unit is one pixel and the level is
	// drawn at its own size, so these are the same coordinates entities live in.  Only an example that is steered
	// by clicking needs this; the rest leave it off and the click does nothing.
	pointerDown?(runtime: ExampleRuntime, x: number, y: number): void

	// An override for how a single entity is drawn, asked per entity every frame.  Return a colour (and optional
	// alpha) to draw it with, or undefined to leave it to the renderer's default.  This is where an example that
	// colours by something other than identity puts it - the sensors example reads a flag it set in `update` and
	// returns a hot colour for a sensor that is currently overlapping something, a calm one for one that is not.
	entityStyle?(runtime: ExampleRuntime, entity: BaseEntity<Components, Config>): EntityStyle | undefined

	// The score, lives and any banner to draw over the canvas this frame, or undefined for an example that has no
	// such text - which is all of them but breakout.  Asked once per frame and drawn on top of the shapes; see
	// HudText.  Read straight out of the game state the example keeps, the same way `entityStyle` reads its flag.
	hud?(runtime: ExampleRuntime): HudText | undefined
}
