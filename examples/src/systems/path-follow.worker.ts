import { createEntitySystemWorker } from '@daneren2005/shared-memory-ecs';
import { pathFollowUpdate } from './path-follow-update';

createEntitySystemWorker(self, pathFollowUpdate);
