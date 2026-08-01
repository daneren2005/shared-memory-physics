import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import { stopUpdate } from './stop-update';

// The worker entry point for the interpolation example - the same arrangement as ./bounce.worker.ts, with the
// update that stops rather than bounces.
createComponentWorker(self, stopUpdate);
