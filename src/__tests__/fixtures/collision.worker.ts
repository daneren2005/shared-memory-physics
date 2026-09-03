import { createEntitySystemWorker } from '@daneren2005/shared-memory-ecs';
import collisionUpdate from './collision-update';

// Worker entry point for a collision physics system, as a game would write it. The callback rides along with the
// import, the only way it reaches the worker.
createEntitySystemWorker(self, collisionUpdate);
