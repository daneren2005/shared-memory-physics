import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import { platformerUpdate } from './platformer-update';

createComponentWorker(self, platformerUpdate);
