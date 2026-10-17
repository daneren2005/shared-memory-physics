export { COLLIDABLE_QUERY, DEFAULT_PHYSICS_STEP_MS, POSITION_UPDATED_EVENT } from './constants';

export { default as transformDefinition } from './components/transform-component';
export {
	TRANSFORM_X_INDEX,
	TRANSFORM_Y_INDEX,
	TRANSFORM_WIDTH_INDEX,
	TRANSFORM_HEIGHT_INDEX,
	TRANSFORM_ANGLE_INDEX,
	TRANSFORM_SIZE,
} from './components/transform-component-constants';
export type {
	TransformComponent,
	TransformConfig,
	TransformSerialization,
} from './components/transform-component';

export { default as velocityDefinition } from './components/velocity-component';
export {
	VELOCITY_X_INDEX,
	VELOCITY_Y_INDEX,
	VELOCITY_DAMPING_INDEX,
	VELOCITY_SIZE,
} from './components/velocity-component-constants';
export type {
	VelocityComponent,
	VelocityConfig,
	VelocitySerialization,
} from './components/velocity-component';

export { default as dynamicsDefinition } from './components/dynamics-component';
export {
	DYNAMICS_ACCELERATION_X_INDEX,
	DYNAMICS_ACCELERATION_Y_INDEX,
	DYNAMICS_INVERSE_MASS_INDEX,
	DYNAMICS_SIZE,
} from './components/dynamics-component-constants';
export type {
	DynamicsComponent,
	DynamicsConfig,
	DynamicsSerialization,
} from './components/dynamics-component';

export { default as bodyDefinition, canCollide, isSensor, isContinuous, blocksPath, isDying, markDying, bodyShape } from './components/body-component';
export {
	SHAPE_RECTANGLE,
	SHAPE_CIRCLE,
	SHAPE_CAPSULE,
	SHAPE_POLYGON,
	DEFAULT_COLLIDE_CATEGORY,
	DEFAULT_COLLIDE_MASK,
	BODY_FLAGS_INDEX,
	BODY_SHAPE_MASK,
	BODY_SENSOR_FLAG,
	BODY_CCD_FLAG,
	BODY_DYING_FLAG,
	BODY_BLOCKS_PATH_FLAG,
	BODY_CATEGORY_INDEX,
	BODY_MASK_INDEX,
	BODY_SIZE,
} from './components/body-component-constants';
export type {
	BodyComponent,
	BodyConfig,
} from './components/body-component';

export { default as polygonDefinition, preparePolygon } from './components/polygon-component';
export {
	MAX_POLYGON_VERTICES,
	POLYGON_VERTEX_COUNT_INDEX,
	POLYGON_VERTICES_INDEX,
	POLYGON_SIZE,
} from './components/polygon-component-constants';
export type { PolygonComponent, PolygonConfig, PolygonVertex, PreparedPolygon } from './components/polygon-component';

export { default as bouncinessDefinition } from './components/bounciness-component';
export {
	BOUNCINESS_INDEX,
	BOUNCINESS_SIZE,
} from './components/bounciness-component-constants';
export type {
	BouncinessComponent,
	BouncinessConfig,
} from './components/bounciness-component';

export { default as interpolationDefinition } from './components/interpolation-component';
export {
	INTERPOLATION_X_INDEX,
	INTERPOLATION_Y_INDEX,
	INTERPOLATION_SYNCED_TICK_INDEX,
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_TOTAL_DURATION_INDEX,
	INTERPOLATION_SYNCED_DURATION_INDEX,
	INTERPOLATION_REMAINING_DURATION_INDEX,
	INTERPOLATION_TARGET_X_INDEX,
	INTERPOLATION_TARGET_Y_INDEX,
	INTERPOLATION_SYNCED_STEP_DURATION_INDEX,
	INTERPOLATION_CHANNEL_INDEX,
	INTERPOLATION_PREVIOUS_X_INDEX,
	INTERPOLATION_PREVIOUS_Y_INDEX,
	INTERPOLATION_PREVIOUS_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_TOTAL_DURATION_INDEX,
	INTERPOLATION_PREVIOUS_TICK_INDEX,
	INTERPOLATION_SIZE,
} from './components/interpolation-component-constants';
export type {
	InterpolationComponent,
	InterpolationConfig,
} from './components/interpolation-component';

export {
	default as navigationDefinition,
	isNavigating,
	isPathPending,
	isUnreachable,
	navigateTo,
	navigationGoal,
	requestPath,
	setNavigationGoal,
	stopNavigating,
	waypoint,
	waypointX,
	waypointY,
	writePath,
} from './components/navigation-component';
export {
	NAVIGATION_REQUEST_INDEX,
	NAVIGATION_RESULT_INDEX,
	NAVIGATION_OUTCOME_INDEX,
	NAVIGATION_WAYPOINT_INDEX,
	NAVIGATION_WAYPOINT_COUNT_INDEX,
	NAVIGATION_ACTIVE_INDEX,
	NAVIGATION_GOAL_X_INDEX,
	NAVIGATION_GOAL_Y_INDEX,
	NAVIGATION_WAYPOINTS_INDEX,
	NAVIGATION_MAX_WAYPOINTS,
	NAVIGATION_SIZE,
} from './components/navigation-component-constants';
export type { NavigationComponent, NavigationConfig } from './components/navigation-component';

export { physicsRegistry, navigationRegistry } from './components/registry';
export type {
	NavigationComponents,
	PhysicsComponents,
	PhysicsUpdateComponents,
	InterpolationComponents,
	InterpolationUpdateComponents,
} from './components/registry';

export { default as PhysicalWorld } from './world';
export type {
	PhysicalSystemWorld,
	PhysicalWorldData,
	PhysicalWorldSource,
	PhysicalWorldEntity,
	PhysicalWorldFilter,
	PhysicalWorldOptions,
} from './world';

export {
	shapesOverlap,
	contactNormal,
	shapeHalfWidth,
	shapeHalfHeight,
	shapeIsEmpty,
	shapeRadius,
	capsuleHalfLength,
	capsuleCoreAngle,
	boundsHalfWidth,
	boundsHalfHeight,
	orientedBoxesOverlap,
	segmentSegmentDistanceSquared,
	segmentBoxDistanceSquared,
	pointSegmentDistanceSquared,
} from './math/shapes';
export type { Vector } from './math/shapes';
export { polygonShapesOverlap, polygonContactNormal } from './math/polygons';

export { default as CollisionBroadphase } from './systems/collision';
export type { CollisionComponents, CollisionContact, CollisionEntity, CollisionFunction, MoveResult, MovingEntity, SweepResult } from './systems/collision';

export { default as SpatialIndex } from './systems/spatial-index';
export type { SpatialComponents, SpatialEntity, SpatialFilter } from './systems/spatial-index';

export { setEntityPosition } from './actions/set-entity-position';
export { updateSpatialMap } from './actions/update-spatial-map';
export { getSpatialMap } from './actions/get-spatial-map';
export { addPhysicalWorldData } from './actions/add-physical-world-data';
export { snapEntity } from './actions/snap-entity';
export type { SnappableEntity } from './actions/snap-entity';
export { startSpawnInterpolation } from './actions/start-spawn-interpolation';
export type { SpawnableEntity, SpawnInterpolationOptions } from './actions/start-spawn-interpolation';
export { default as integrateDynamics } from './actions/integrate-dynamics';
export type { DynamicsCommand, DynamicsCommandBuffer, DynamicsCommandQueue, DynamicsCommands, DynamicsWorld } from './actions/dynamics-commands';

export { default as physicsUpdate, createPhysicsUpdate } from './systems/physics-update';
export type { DeathInterpolationEntity, PhysicsCallbackWorld, PhysicsGroupConfig, PhysicsUpdateFunction, PhysicsUpdateMetadata, PhysicsUpdateOptions, PhysicsWorld } from './systems/physics-update';
export { default as PhysicsSystem } from './systems/physics-system';
export type { PhysicsSystemConfig, VelocityAssignment } from './systems/physics-system';

export { default as NavGrid } from './pathfinding/nav-grid';
export type { Rect, TileRange } from './pathfinding/nav-grid';
export { default as GridAStar } from './pathfinding/grid-a-star';
export type { GridAStarOptions } from './pathfinding/grid-a-star';
export { default as MinHeap } from './pathfinding/min-heap';
export { PathStatus } from './pathfinding/path-search';
export type { PathRequest, PathResult, PathSearch, PathStatusValue, Point } from './pathfinding/path-search';
export { sweepCost } from './pathfinding/line-of-sight';
export { smoothPath } from './pathfinding/smooth-path';
export { FollowStep, followPath } from './pathfinding/follow-path';
export type { FollowStepValue } from './pathfinding/follow-path';
export {
	PATH_BLOCKERS_QUERY,
	PATH_GATES_QUERY,
	applyRectChanges,
	blockerRect,
	pathBlockerQueries,
} from './pathfinding/path-blockers';
export type { PathBlockerComponents, PathBlockerDelta, PathBlockerQueryOptions } from './pathfinding/path-blockers';
export {
	applyPathBlockerChanges,
	applyPathGateChanges,
	blockingRects,
	createNavigationState,
	navigationGridFor,
	setNavigationTerrainSpeed,
} from './pathfinding/navigation-state';
export type { NavigationState } from './pathfinding/navigation-state';
export { DEFAULT_PATH_SEARCH_ITERATION_BUDGET, createPathfindingUpdate, pathfindingUpdate } from './pathfinding/pathfinding-update';
export type {
	PathfindingInitData,
	PathfindingUpdateComponents,
	PathfindingUpdateFunction,
	PathfindingUpdateMetadata,
	PathfindingUpdateOptions,
	PathfindingWorld,
} from './pathfinding/pathfinding-update';
export { default as PathfindingSystem } from './pathfinding/pathfinding-system';
export type { PathfindingSystemConfig } from './pathfinding/pathfinding-system';

export { default as interpolationUpdate } from './systems/interpolation-update';
export type { InterpolationWorld } from './systems/interpolation-update';
export { default as InterpolationSystem } from './systems/interpolation-system';
export type { InterpolationSystemConfig } from './systems/interpolation-system';
