// A path is pending while the request and result ids differ. Requesters bump the request id; the pathfinding update
// writes the waypoints and outcome first and the result id last, so a settled path is never read half written.
export const NAVIGATION_REQUEST_INDEX = 0;
export const NAVIGATION_RESULT_INDEX = 1;
export const NAVIGATION_OUTCOME_INDEX = 2;
// Written only by the follower once a path settles; reset with each new path.
export const NAVIGATION_WAYPOINT_INDEX = 3;
export const NAVIGATION_WAYPOINT_COUNT_INDEX = 4;
// Explicit flag because (0, 0) is a valid goal. Only active movers are searched for or rechecked.
export const NAVIGATION_ACTIVE_INDEX = 5;
// Goal and waypoints are Float32 bit patterns in the Int32 block, read with loadFloat32.
export const NAVIGATION_GOAL_X_INDEX = 6;
export const NAVIGATION_GOAL_Y_INDEX = 7;
export const NAVIGATION_WAYPOINTS_INDEX = 8;
// A longer path is cut short and marked Incomplete, so the follower asks again from its end.
export const NAVIGATION_MAX_WAYPOINTS = 32;
export const NAVIGATION_SIZE = NAVIGATION_WAYPOINTS_INDEX + NAVIGATION_MAX_WAYPOINTS * 2;
