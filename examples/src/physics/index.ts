import { physicsUpdate } from '@daneren2005/shared-memory-physics';
import type { PhysicsUpdateMetadata, PhysicsWorld } from '@daneren2005/shared-memory-physics';
import type { EntityUpdateFunction } from '@daneren2005/shared-memory-ecs';
import type { Components, ExampleUpdateComponents } from '../world';
import { breakoutUpdate } from './breakout-update';
import { bulletHellUpdate } from './bullet-hell-update';
import { platformerUpdate } from './platformer-update';
import { sweepUpdate } from './sweep-update';

// An update function and the worker that runs it, kept together because they have to agree: whatever a game
// hands `PhysicsSystem` as its `updateFunction` for the in-process fallback must be the same function its
// worker file handed `createComponentWorker`, or the two backends behave differently.
export interface PhysicsBackend {
	// The bare EntityUpdateFunction rather than PhysicsUpdateFunction, because not every backend sweeps: plain
	// movement carries no collision metadata at all, so its `physics` stamp is absent.  The two that do sweep
	// still satisfy this - their metadata is the optional field.
	updateFunction: EntityUpdateFunction<Components, ExampleUpdateComponents, PhysicsWorld> & { physics?: PhysicsUpdateMetadata<Components> }
	getWorker(): Worker
}

// The `new Worker(new URL(...))` calls are written out here, in the app's own source, because that literal form
// is what a bundler needs in order to find the worker entry and build it.
//
//   - `sweep` is what most examples run: movement that sweeps and bounces, with no collision callback, so an
//     entity turns around off what it hits only through the `bounciness` component it carries - see ./sweep-update.ts.
//   - `breakout` is the same movement plus one callback that kills a brick the ball has bounced off, run in the
//     physics thread rather than on the main thread - see ./breakout-update.ts.
//   - `bulletHell` is the same again, with a callback that kills a bullet the instant it touches anything and
//     reports the ones that reach the player.  The bullets are sensors, so the callback is all that acts on a
//     bullet contact - the sweep passes movers straight through them - see ./bullet-hell-update.ts.
//   - `movement` is the library's own `physicsUpdate` with nothing on top: it integrates the velocity, publishes
//     the interpolation step, and notices nothing around it.  Boids run on this - what turns them is a steering
//     system of the example's own (see ../systems/steering-system.ts), so the physics half is the plain one.
export const PHYSICS_BACKENDS = {
	sweep: {
		updateFunction: sweepUpdate,
		getWorker: () => new Worker(new URL('./sweep.worker.ts', import.meta.url), { type: 'module' }),
	},
	breakout: {
		updateFunction: breakoutUpdate,
		getWorker: () => new Worker(new URL('./breakout.worker.ts', import.meta.url), { type: 'module' }),
	},
	bulletHell: {
		updateFunction: bulletHellUpdate,
		getWorker: () => new Worker(new URL('./bullet-hell.worker.ts', import.meta.url), { type: 'module' }),
	},
	platformer: {
		updateFunction: platformerUpdate,
		getWorker: () => new Worker(new URL('./platformer.worker.ts', import.meta.url), { type: 'module' }),
	},
	movement: {
		updateFunction: physicsUpdate,
		getWorker: () => new Worker(new URL('./movement.worker.ts', import.meta.url), { type: 'module' }),
	},
} satisfies Record<string, PhysicsBackend>;

export type PhysicsBackendName = keyof typeof PHYSICS_BACKENDS;
