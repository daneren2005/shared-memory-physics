import { createPhysicsUpdate } from '@daneren2005/shared-memory-physics';
import type { Components } from '../world';

// Movement that comes to rest against whatever is in the way and stays there, with no response of its own.
// That is what the interpolation example wants: a unit that walks into a box and presses against it until its
// own timer turns it around, rather than one that bounces off and hides the very thing being looked at.
//
// Every update `createPhysicsUpdate` builds sweeps, so this is the whole of it - being stopped short is the
// response, and there is no callback because there is nothing else to say about it.
export const stopUpdate = createPhysicsUpdate<Components>();

export default stopUpdate;
