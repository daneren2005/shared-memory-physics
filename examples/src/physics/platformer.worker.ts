import { createEntitySystemWorker } from '@daneren2005/shared-memory-ecs';
import { platformerUpdate } from './platformer-update';

createEntitySystemWorker(self, platformerUpdate);
