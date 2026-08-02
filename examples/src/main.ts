import { DEFAULT_PHYSICS_STEP_MS, InterpolationSystem, PhysicsSystem } from '@daneren2005/shared-memory-physics';
import { PerformanceTiming } from '@daneren2005/shared-memory-ecs';
import type { BaseEntity, System } from '@daneren2005/shared-memory-ecs';
import { renderControls } from './controls';
import type { Control } from './controls';
import type { EntityStyle, HudText, Example, ExampleHost, ExampleRuntime } from './example';
import { EXAMPLES, findExample } from './examples';
import { LEVEL, createWalls } from './level';
import { PHYSICS_BACKENDS } from './physics';
import type { PhysicsBackend } from './physics';
import { createGame } from './renderer';
import type { Renderable } from './renderer';
import { createExampleWorld } from './world';
import type { Components, Config, ExampleUpdateComponents } from './world';

// How often the stats under the controls are rewritten.  Every frame would be unreadable and would put a dozen
// DOM writes in the way of the thing being measured.
const STATS_INTERVAL_MS = 250;

// Drives everything outside the canvas: which example is up, the controls beside it, and the world those
// controls are pointed at.  The Phaser scene calls back into `step` once a frame and reads `runtime` to draw,
// so this is the only place that knows a world is being replaced.
class ExamplesPage implements ExampleHost, Renderable {
	runtime: ExampleRuntime | undefined;

	private example: Example = EXAMPLES[0];
	// SharedArrayBuffer is only handed to a cross-origin isolated page, and the ECS falls back to running the
	// update in-process without it - so a worker is asked for only where it would genuinely be one.
	private useWorker = crossOriginIsolated;
	// How long a physics step covers, in milliseconds; 0 means "run every frame".  Starts at the library's own
	// default and is reset per example, since an example can ask for a different one.
	private physicsStep = DEFAULT_PHYSICS_STEP_MS;
	// Whether the canvas is drawn from `interpolation.x` or straight off the transform.  Flipping it does not
	// touch the world at all - the interpolation system is always running - so the two can be compared on the
	// same scene, mid-motion, with no rebuild in between.  Read by the scene, which is why it is not private.
	interpolate = true;
	// Every build is numbered so that a world whose worker finished starting after a newer build had already
	// begun is thrown away rather than becoming the live one.
	private build = 0;

	// Every system the current world runs on the simulation step rather than every frame: the physics system, and
	// whatever the example asked for beside it (the boids steering).  The physics-step slider retunes all of them
	// together, and the stats panel reports each one's time on its own thread.  Interpolation is not among them -
	// it runs every frame by design, on the main thread, and its cost is already inside the main-thread figure.
	private steppedSystems: Array<System<Components>> = [];
	// Times the world's update - the main thread and each system - for an example that asks for it (boids, the
	// stress test).  Undefined for every other example, so the timers are not even attached.  Rebuilt with the
	// world, and torn down first so its listeners come off the world before it is destroyed.
	private performance: PerformanceTiming<Components> | undefined;

	private frames = 0;
	private sinceStats = 0;

	constructor(private readonly elements: PageElements) {
		for(const example of EXAMPLES) {
			const link = document.createElement('a');
			link.href = `#${example.id}`;
			link.textContent = example.title;
			link.dataset.example = example.id;
			elements.nav.append(link);
		}
	}

	select(example: Example): void {
		this.example = example;
		// An example that is about what a long step looks like starts on a long one; everything else gets the
		// library's default back, so switching away from that example does not leave its setting behind.
		this.physicsStep = example.physicsStep ?? DEFAULT_PHYSICS_STEP_MS;
		renderControls(this.elements.simulationControls, this.simulationControls());

		this.elements.title.textContent = example.title;
		this.elements.description.textContent = example.description;
		for(const link of this.elements.nav.children) {
			link.classList.toggle('active', link instanceof HTMLElement && link.dataset.example === example.id);
		}

		// Built once per example rather than once per world: a control that retunes something live has to keep
		// working across the restarts the ones beside it cause, so they reach the world through `this` instead
		// of closing over whichever one was up when they were made.
		renderControls(this.elements.exampleControls, example.controls(this));

		this.rebuild();
	}

	restart(): void {
		this.rebuild();
	}

	// Handed a click in world units by the scene and passed straight on to the current example, if it is one that
	// listens for clicks - the page itself has nothing to do with where the pointer went.
	pointerDown(x: number, y: number): void {
		if(this.runtime) {
			this.example.pointerDown?.(this.runtime, x, y);
		}
	}

	// Whether the current example wants the renderer's cheap swarm path - thousands of movers drawn as darts in
	// one pass.  Read by the scene each frame; only boids sets it.
	get swarm(): boolean {
		return this.example.swarm ?? false;
	}

	// Asked by the scene per entity per frame for the current example's own colour for it, or undefined to let the
	// renderer's default stand.  Routed to the example the same way a click is: the page only knows which one is up.
	entityStyle(entity: BaseEntity<Components, Config>): EntityStyle | undefined {
		if(!this.runtime) {
			return undefined;
		}

		return this.example.entityStyle?.(this.runtime, entity);
	}

	// Asked by the scene once a frame for the current example's HUD text, routed the same way a colour is: the
	// page only knows which example is up, and only breakout has anything to return.
	hud(): HudText | undefined {
		if(!this.runtime) {
			return undefined;
		}

		return this.example.hud?.(this.runtime);
	}

	// Called once per rendered frame by the scene, with however long the frame took.
	step(elapsedTime: number): void {
		const runtime = this.runtime;
		if(!runtime) {
			return;
		}

		// The example's own logic first, so a velocity it writes is the one this update moves on.
		this.example.update?.(runtime, elapsedTime);
		runtime.world.update(elapsedTime);

		this.frames++;
		this.sinceStats += elapsedTime;
		if(this.sinceStats >= STATS_INTERVAL_MS) {
			this.renderStats(runtime);
			this.frames = 0;
			this.sinceStats = 0;
		}
	}

	private rebuild(): void {
		this.buildWorld().catch(error => {
			console.error('Failed to build the example world', error);
		});
	}

	private async buildWorld(): Promise<void> {
		const build = ++this.build;

		// Terminates the old workers, if there were any, before their replacements are asked for.  The timing comes
		// off first so its listeners are gone before the world it was watching is torn down.
		this.performance?.destroy();
		this.performance = undefined;
		this.runtime?.world.destroy();
		this.runtime = undefined;
		this.steppedSystems = [];

		const world = createExampleWorld();
		const backend: PhysicsBackend = PHYSICS_BACKENDS[this.example.backend];
		// The world this example simulates in - the shared LEVEL unless it asked for more room, in which case the
		// scene zooms out to fit rather than the canvas growing (see the renderer's camera).  It is what the walls
		// are laid on, what the example lays its entities out in, and what a system of its own is bounded by.
		const level = this.example.world ?? LEVEL;

		// Whatever the example runs beside physics, added first so a velocity one of them writes is moved on the
		// same frame rather than the next.  Only boids has any - its steering - and every other example gets an
		// empty list and a world with nothing in it but the physics below.
		const exampleSystems = this.example.systems?.({
			world,
			level,
			// Falls back to running in-process, which is also what the ECS does on its own when the page has no
			// SharedArrayBuffer to share the components through.
			forceMainThread: !this.useWorker,
			deltaBetweenRuns: this.physicsStep,
		}) ?? [];
		for(const system of exampleSystems) {
			world.addSystem(system);
		}

		// The standard physics system, run exactly as a game would run it: the backend's update on its own worker,
		// stepping at whatever the slider says.  There is nothing example-specific about it - an example that wants
		// something else out of physics changes the update it points at, not this.
		const physics = world.addSystem(new PhysicsSystem<Components, ExampleUpdateComponents>(world, {
			updateFunction: backend.updateFunction,
			getWorker: backend.getWorker,
			forceMainThread: !this.useWorker,
			deltaBetweenRuns: this.physicsStep,
		}));
		this.steppedSystems = [...exampleSystems, physics];

		// After physics, so a step is drawn on the frame it happened rather than the one after.  It is wired to
		// nothing: how far along a step to draw is worked out from what has landed in each entity's own block, so
		// the physics-step slider below is followed with nothing told to it.
		const interpolation = world.addSystem(new InterpolationSystem<Components>(world));

		// Only for an example that asks for it - the stress test.  It watches the world's update events and each
		// system's worker-finished ones, so it has to be attached now, before the first update runs.  Recalculated
		// a couple of times a second so the numbers move without flickering.
		if(this.example.timing) {
			this.performance = new PerformanceTiming<Components>(world, { ticksBetweenUpdates: 500 });
		}

		const runtime: ExampleRuntime = { world, physics, interpolation, level };
		createWalls(world, level);
		this.example.create(runtime);

		// Starting real workers is asynchronous, so a rebuild that was asked for while this one was waiting
		// wins and this world is dropped on the floor.
		await world.init();
		if(build !== this.build) {
			world.destroy();

			return;
		}

		this.runtime = runtime;
	}

	// The controls that belong to the page rather than to any one example.
	private simulationControls(): Array<Control> {
		return [
			{
				kind: 'slider',
				label: 'Physics step',
				min: 0,
				max: 200,
				step: 5,
				value: this.physicsStep,
				format: value => value === 0 ? 'every frame' : `${value} ms`,
				// A plain field on each system, so this takes effect on the very next frame: a system banks
				// elapsed time until it has a step's worth and then runs once for the lot.  Each run publishes how
				// much time it covered, so interpolation follows the slider without being told about it.  An
				// example's own systems are retuned with physics rather than after it - they are one simulation.
				change: value => {
					this.physicsStep = value;
					for(const system of this.steppedSystems) {
						system.deltaBetweenRuns = value;
					}
				},
			},
			{
				kind: 'toggle',
				label: 'Interpolate rendering',
				value: this.interpolate,
				note: 'Draws each entity at `interpolation.x` - blended between the two positions physics published '
					+ 'either side of its last step - instead of at the transform, which only changes when a step '
					+ 'lands. Turn it off with the step above 0 and the choppiness it is fixing is what is left.',
				change: value => {
					this.interpolate = value;
				},
			},
			{
				kind: 'toggle',
				label: 'Run physics in a worker',
				value: this.useWorker,
				disabled: !crossOriginIsolated,
				note: crossOriginIsolated
					? undefined
					: 'This page is not cross-origin isolated, so the browser will not hand out a SharedArrayBuffer '
						+ 'and there is nothing for a worker to share. The same update runs on the main thread instead.',
				change: value => {
					this.useWorker = value;
					this.rebuild();
				},
			},
			{
				kind: 'button',
				label: 'Restart',
				press: () => this.rebuild(),
			},
		];
	}

	private renderStats(runtime: ExampleRuntime): void {
		const entities = runtime.world.entities.size;

		const rows: Record<string, string> = {
			fps: Math.round(this.frames * 1000 / this.sinceStats).toString(),
			// The four walls are entities too, and are the reason this is not the number the slider says.
			entities: entities.toString(),
			physics: runtime.physics.isWorkerThread ? 'worker thread' : 'main thread',
			memory: crossOriginIsolated ? 'shared' : 'not shared',
			drawn: this.interpolate ? 'interpolated' : 'raw transform',
		};

		// For a stress test, how long a step is taking and where.  The main-thread figure is the whole of the
		// world's update on this thread - gathering the deltas, handing each system its run, and folding in what
		// came back, plus the interpolation that runs here - while each system's figure is the time its update
		// took off on its own core.  None of them are added together: the workers run alongside the main thread
		// and alongside each other, not one after another, which is what splitting the boids' steering out of
		// physics buys.  Averaged over the last half second so a spike does not make the panel jump.
		if(this.performance) {
			rows['main thread'] = formatMs(this.performance.stats.update.avg);
			for(const system of this.steppedSystems) {
				const stats = this.performance.getSystemStats(system.name);
				if(stats) {
					rows[workerLabel(system.name)] = formatMs(stats.run.avg);
				}
			}
		}

		this.elements.stats.replaceChildren(...Object.entries(rows).flatMap(([label, value]) => {
			const term = document.createElement('dt');
			term.textContent = label;
			const description = document.createElement('dd');
			description.textContent = value;

			return [term, description];
		}));
	}
}

interface PageElements {
	nav: HTMLElement
	title: HTMLElement
	description: HTMLElement
	exampleControls: HTMLElement
	simulationControls: HTMLElement
	stats: HTMLElement
	game: HTMLElement
}

function element(id: string): HTMLElement {
	const found = document.getElementById(id);
	if(!found) {
		throw new Error(`The examples page is missing #${id}`);
	}

	return found;
}

// A timing figure for the stats panel: milliseconds to two places.  Two is enough to read a sub-millisecond
// system without the number jittering in the last digit every refresh.
function formatMs(value: number): string {
	return `${value.toFixed(2)} ms`;
}

// A system's name as the stats panel labels its row: `PhysicsSystem` becomes `physics worker`, `SteeringSystem`
// becomes `steering worker`.  The panel's labels are lower case prose, and the row has to say which thread the
// number was measured on, since the one above it is the main thread's.
function workerLabel(name: string): string {
	return `${name.replace(/System$/, '').toLowerCase()} worker`;
}

const elements: PageElements = {
	nav: element('examples'),
	title: element('example-title'),
	description: element('example-description'),
	exampleControls: element('example-controls'),
	simulationControls: element('simulation-controls'),
	stats: element('stats'),
	game: element('game'),
};
const page = new ExamplesPage(elements);

// The url hash is the route, so every example is linkable and the back button works, with no router to it.
function selectFromHash(): void {
	page.select(findExample(location.hash.slice(1)) ?? EXAMPLES[0]);
}

window.addEventListener('hashchange', selectFromHash);
selectFromHash();

createGame(elements.game, page);
