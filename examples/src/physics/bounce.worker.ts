import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import { bounceUpdate } from './bounce-update';

// The worker entry point for the bouncing examples.  It exists as its own file because a bundler has to be
// able to see `new Worker(new URL(...))` written out in the app's own source (see ./index.ts) - and because
// this is the module the collision callback reaches the worker thread through.
createComponentWorker(self, bounceUpdate);
