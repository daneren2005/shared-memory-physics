import type { InterpolationSystem, PhysicsSystem } from '@daneren2005/shared-memory-physics';
import type { Control } from './controls';
import type { Level } from './level';
import type { PhysicsBackendName } from './physics';
import type { Components, ExampleWorld } from './world';

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
}
