// One event per completed run, carrying the ids of moved entities.
export const POSITION_UPDATED_EVENT = 'position-updated';

export const COLLIDABLE_QUERY = 'collidable';
export const DEFAULT_PHYSICS_STEP_MS = 50;

// Backlog beyond this many steps is eased away instead of leaving a persistent render delay.
export const BACKLOG_TARGET_STEPS = 1.5;
// Extra fraction of each frame's render budget available for catching up.
export const BACKLOG_CATCHUP_RATE = 0.5;
