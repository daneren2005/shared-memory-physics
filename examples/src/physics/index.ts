import type { PhysicsUpdateFunction } from '@daneren2005/shared-memory-physics';
import type { Components, ExampleUpdateComponents } from '../world';
import { sweepUpdate } from './sweep-update';

// An update function and the worker that runs it, kept together because they have to agree: whatever a game
// hands `PhysicsSystem` as its `updateFunction` for the in-process fallback must be the same function its
// worker file handed `createComponentWorker`, or the two backends behave differently.
export interface PhysicsBackend {
	updateFunction: PhysicsUpdateFunction<Components, ExampleUpdateComponents>
	getWorker(): Worker
}

// The `new Worker(new URL(...))` calls are written out here, in the app's own source, because that literal form
// is what a bundler needs in order to find the worker entry and build it.  There is a single backend now: every
// example runs the same sweep update and differs only in whether its entities carry a `bounciness` component,
// which is what turns them around on contact - see ./sweep-update.ts.
export const PHYSICS_BACKENDS = {
	sweep: {
		updateFunction: sweepUpdate,
		getWorker: () => new Worker(new URL('./sweep.worker.ts', import.meta.url), { type: 'module' }),
	},
} satisfies Record<string, PhysicsBackend>;

export type PhysicsBackendName = keyof typeof PHYSICS_BACKENDS;
