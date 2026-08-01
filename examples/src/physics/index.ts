import type { PhysicsUpdateFunction } from '@daneren2005/shared-memory-physics';
import type { Components, ExampleUpdateComponents } from '../world';
import { breakoutUpdate } from './breakout-update';
import { sweepUpdate } from './sweep-update';

// An update function and the worker that runs it, kept together because they have to agree: whatever a game
// hands `PhysicsSystem` as its `updateFunction` for the in-process fallback must be the same function its
// worker file handed `createComponentWorker`, or the two backends behave differently.
export interface PhysicsBackend {
	updateFunction: PhysicsUpdateFunction<Components, ExampleUpdateComponents>
	getWorker(): Worker
}

// The `new Worker(new URL(...))` calls are written out here, in the app's own source, because that literal form
// is what a bundler needs in order to find the worker entry and build it.
//
//   - `sweep` is what most examples run: movement that sweeps and bounces, with no collision callback, so an
//     entity turns around off what it hits only through the `bounciness` component it carries - see ./sweep-update.ts.
//   - `breakout` is the same movement plus one callback that kills a brick the ball has bounced off, run in the
//     physics thread rather than on the main thread - see ./breakout-update.ts.
export const PHYSICS_BACKENDS = {
	sweep: {
		updateFunction: sweepUpdate,
		getWorker: () => new Worker(new URL('./sweep.worker.ts', import.meta.url), { type: 'module' }),
	},
	breakout: {
		updateFunction: breakoutUpdate,
		getWorker: () => new Worker(new URL('./breakout.worker.ts', import.meta.url), { type: 'module' }),
	},
} satisfies Record<string, PhysicsBackend>;

export type PhysicsBackendName = keyof typeof PHYSICS_BACKENDS;
