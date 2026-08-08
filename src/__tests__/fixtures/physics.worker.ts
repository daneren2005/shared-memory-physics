import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import physicsUpdate from '../../systems/physics-update';

// Worker entry point, mirroring the file a game writes for PhysicsSystem's `getWorker`. `self` is passed
// explicitly for @vitest/web-worker, which injects it as a module local; in a browser it is the true global.
createComponentWorker(self, physicsUpdate);
