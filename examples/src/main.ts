import { DEFAULT_PHYSICS_STEP_MS, InterpolationSystem, PhysicsSystem } from '@daneren2005/shared-memory-physics';
import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import { renderControls } from './controls';
import type { Control } from './controls';
import type { EntityStyle, Example, ExampleHost, ExampleRuntime } from './example';
import { EXAMPLES, findExample } from './examples';
import { LEVEL, createWalls } from './level';
import { PHYSICS_BACKENDS } from './physics';
import { createGame } from './renderer';
import type { Renderable } from './renderer';
import { createExampleWorld } from './world';
import type { Components, Config } from './world';

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

	// Asked by the scene per entity per frame for the current example's own colour for it, or undefined to let the
	// renderer's default stand.  Routed to the example the same way a click is: the page only knows which one is up.
	entityStyle(entity: BaseEntity<Components, Config>): EntityStyle | undefined {
		if(!this.runtime) {
			return undefined;
		}

		return this.example.entityStyle?.(this.runtime, entity);
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

		// Terminates the old worker, if there was one, before its replacement is asked for.
		this.runtime?.world.destroy();
		this.runtime = undefined;

		const world = createExampleWorld();
		const backend = PHYSICS_BACKENDS[this.example.backend];
		const physics = new PhysicsSystem<Components>(world, {
			updateFunction: backend.updateFunction,
			getWorker: backend.getWorker,
			// Falls back to running the same update in-process, which is also what the ECS does on its own when
			// the page has no SharedArrayBuffer to share the components through.
			forceMainThread: !this.useWorker,
			deltaBetweenRuns: this.physicsStep,
		});
		// After physics, so a step is drawn on the frame it happened rather than the one after.  It is wired to
		// nothing: how far along a step to draw is worked out from what has landed in each entity's own block, so
		// the physics-step slider below is followed with nothing told to it.
		world.addSystem(physics);
		const interpolation = world.addSystem(new InterpolationSystem<Components>(world));

		const runtime: ExampleRuntime = { world, physics, interpolation, level: LEVEL };
		createWalls(world, LEVEL);
		this.example.create(runtime);

		// Starting a real worker is asynchronous, so a rebuild that was asked for while this one was waiting
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
				// A plain field on the system, so this takes effect on the very next frame: the system banks
				// elapsed time until it has a step's worth and then runs once for the lot.  Each run publishes how
				// much time it covered, so interpolation follows the slider without being told about it.
				change: value => {
					this.physicsStep = value;
					if(this.runtime) {
						this.runtime.physics.deltaBetweenRuns = value;
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

		this.elements.stats.replaceChildren(...Object.entries({
			fps: Math.round(this.frames * 1000 / this.sinceStats).toString(),
			// The four walls are entities too, and are the reason this is not the number the slider says.
			entities: entities.toString(),
			physics: runtime.physics.isWorkerThread ? 'worker thread' : 'main thread',
			memory: crossOriginIsolated ? 'shared' : 'not shared',
			drawn: this.interpolate ? 'interpolated' : 'raw transform',
		}).flatMap(([label, value]) => {
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
