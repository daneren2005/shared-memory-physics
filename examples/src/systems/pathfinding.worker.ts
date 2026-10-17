import { createEntitySystemWorker } from '@daneren2005/shared-memory-ecs';
import { examplePathfindingUpdate } from './pathfinding-update';

createEntitySystemWorker(self, examplePathfindingUpdate);
