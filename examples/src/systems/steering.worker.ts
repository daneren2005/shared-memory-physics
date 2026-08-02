import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import { steeringUpdate } from './steering-update';

// The worker entry point for the steering system.  It is its own file, spelled out with `new Worker(new URL(...))`
// in ./steering-system.ts, because that literal form is what a bundler needs to find and build a worker.
//
// This thread does nothing but write velocities.  The positions those velocities produce are integrated on the
// physics worker next door, off the same shared memory - see ./steering-update.ts.
createComponentWorker(self, steeringUpdate);
