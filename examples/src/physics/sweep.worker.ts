import { createEntitySystemWorker } from '@daneren2005/shared-memory-ecs';
import { sweepUpdate } from './sweep-update';

// The worker entry point every example runs.  It exists as its own file because a bundler has to be able to see
// `new Worker(new URL(...))` written out in the app's own source (see ./index.ts).  There is no collision
// callback to carry across any more - bouncing is the `bounciness` component the entities load - so this is
// simply the shared sweep update run off the main thread.
createEntitySystemWorker(self, sweepUpdate);
