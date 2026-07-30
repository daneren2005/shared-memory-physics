import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import physicsUpdate from '../../systems/physics-update';

// Real worker entry point, mirroring the file a game writes for PhysicsSystem's `getWorker`.  `self` is passed
// explicitly so this works under @vitest/web-worker, which injects it as a module local rather than a real
// global; in a browser worker `self` is the true global, so passing it is equivalent.
createComponentWorker(self, physicsUpdate);
