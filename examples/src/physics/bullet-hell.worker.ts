import { createEntitySystemWorker } from '@daneren2005/shared-memory-ecs';
import { bulletHellUpdate } from './bullet-hell-update';

// The worker entry point for the bullet-hell backend.  It is its own file, spelled out with `new Worker(new
// URL(...))` in ./index.ts, because that literal form is what a bundler needs to find and build a worker.  It
// hands the *same* update the main thread runs to createEntitySystemWorker, so the bullet-killing collision
// callback behaves identically whether physics is on a worker or the in-process fallback.
createEntitySystemWorker(self, bulletHellUpdate);
