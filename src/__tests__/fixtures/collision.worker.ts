import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import collisionUpdate from './collision-update';

// Real worker entry point for a physics system with collision callbacks: exactly the same file a game writes,
// except that it imports its update from a fixture rather than its own source.  The callback rides along with
// the import, which is the only way it can reach the worker at all.
createComponentWorker(self, collisionUpdate);
