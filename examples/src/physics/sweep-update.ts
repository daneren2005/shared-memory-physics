import { createPhysicsUpdate } from '@daneren2005/shared-memory-physics';
import type { Components } from '../world';

// Movement that sweeps, so an entity comes to rest against whatever is in its way rather than ending up inside
// it - and nothing else.  Every example runs this one update: what an entity does *about* a collision is no
// longer a callback here but the `bounciness` component it carries (or does not).
//
//   - The bouncing circles and rectangles load `bounciness: 1`, so physics turns them around off what they hit
//     with no code in this file at all - see the library's bounce.
//   - The walk example loads no bounciness, so its unit is stopped on the face of a box and simply stays there.
//
// It lives in its own module because both backends have to run the same function - the worker file next door
// imports it and hands it to `createEntitySystemWorker`, and the main thread hands it to `PhysicsSystem` as its
// `updateFunction` - so the in-process fallback and the worker behave identically.
export const sweepUpdate = createPhysicsUpdate<Components>();

export default sweepUpdate;
