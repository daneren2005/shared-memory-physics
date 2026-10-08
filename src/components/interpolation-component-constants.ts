export const INTERPOLATION_X_INDEX = 0;
export const INTERPOLATION_Y_INDEX = 1;
export const INTERPOLATION_SYNCED_TICK_INDEX = 2;
export const INTERPOLATION_DURATION_INDEX = 3;
// Published last; NaN marks an in-progress transform and timing update.
export const INTERPOLATION_TICK_INDEX = 4;
// Cumulative time preserves segments replaced before the renderer observes them.
export const INTERPOLATION_TOTAL_DURATION_INDEX = 5;
export const INTERPOLATION_SYNCED_DURATION_INDEX = 6;
export const INTERPOLATION_REMAINING_DURATION_INDEX = 7;
// Consumer-owned target used while physics publishes the next segment.
export const INTERPOLATION_TARGET_X_INDEX = 8;
export const INTERPOLATION_TARGET_Y_INDEX = 9;
export const INTERPOLATION_SYNCED_STEP_DURATION_INDEX = 10;
// Channel 0 is ungated; other channels wait for their PhysicsSystem to commit.
export const INTERPOLATION_CHANNEL_INDEX = 11;
// Previous publication remains readable until the current run commits.
export const INTERPOLATION_PREVIOUS_X_INDEX = 12;
export const INTERPOLATION_PREVIOUS_Y_INDEX = 13;
export const INTERPOLATION_PREVIOUS_DURATION_INDEX = 14;
export const INTERPOLATION_PREVIOUS_TOTAL_DURATION_INDEX = 15;
// Previous-slot stamp follows the same NaN-while-writing protocol.
export const INTERPOLATION_PREVIOUS_TICK_INDEX = 16;
export const INTERPOLATION_SIZE = 17;
