import { createEntitySystemWorker } from '@daneren2005/shared-memory-ecs';
import { physicsUpdate } from '@daneren2005/shared-memory-physics';

// The worker entry point for the `movement` backend, which runs the library's own `physicsUpdate` with nothing
// wrapped around it: integrate the velocity, publish the interpolation step, notice nothing.  It is its own file,
// spelled out with `new Worker(new URL(...))` in ./index.ts, because that literal form is what a bundler needs to
// find and build a worker.
createEntitySystemWorker(self, physicsUpdate);
