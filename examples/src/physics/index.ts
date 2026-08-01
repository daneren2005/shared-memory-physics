import type { PhysicsUpdateFunction } from '@daneren2005/shared-memory-physics';
import type { Components, ExampleUpdateComponents } from '../world';
import { bounceUpdate } from './bounce-update';
import { stopUpdate } from './stop-update';

// An update function and the worker that runs it, kept together because they have to agree: whatever a game
// hands `PhysicsSystem` as its `updateFunction` for the in-process fallback must be the same function its
// worker file handed `createComponentWorker`, or the two backends behave differently.
export interface PhysicsBackend {
	updateFunction: PhysicsUpdateFunction<Components, ExampleUpdateComponents>
	getWorker(): Worker
}

// The `new Worker(new URL(...))` calls are written out here, in the app's own source, because that literal
// form is what a bundler needs in order to find the worker entry and build it.  An example names the one it
// wants and the page below wires it up.
export const PHYSICS_BACKENDS = {
	bounce: {
		updateFunction: bounceUpdate,
		getWorker: () => new Worker(new URL('./bounce.worker.ts', import.meta.url), { type: 'module' }),
	},
	stop: {
		updateFunction: stopUpdate,
		getWorker: () => new Worker(new URL('./stop.worker.ts', import.meta.url), { type: 'module' }),
	},
} satisfies Record<string, PhysicsBackend>;

export type PhysicsBackendName = keyof typeof PHYSICS_BACKENDS;
