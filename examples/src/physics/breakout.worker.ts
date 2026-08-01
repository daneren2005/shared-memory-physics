import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import { breakoutUpdate } from './breakout-update';

// The worker entry point for the breakout backend.  It is its own file, spelled out with `new Worker(new
// URL(...))` in ./index.ts, because that literal form is what a bundler needs to find and build a worker.  It
// hands the *same* update function the main thread runs to createComponentWorker, so the brick-killing collision
// callback baked into it behaves identically whether physics is on a worker or the in-process fallback.
createComponentWorker(self, breakoutUpdate);
