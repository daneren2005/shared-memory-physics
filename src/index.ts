export { default as transformDefinition } from './components/transform-component';
export {
	TRANSFORM_X_INDEX,
	TRANSFORM_Y_INDEX,
	TRANSFORM_WIDTH_INDEX,
	TRANSFORM_HEIGHT_INDEX,
	TRANSFORM_ANGLE_INDEX,
	TRANSFORM_SIZE,
} from './components/transform-component';
export type {
	TransformComponent,
	TransformConfig,
	TransformSerialization,
} from './components/transform-component';

export { default as velocityDefinition } from './components/velocity-component';
export {
	VELOCITY_X_INDEX,
	VELOCITY_Y_INDEX,
	VELOCITY_SIZE,
} from './components/velocity-component';
export type {
	VelocityComponent,
	VelocityConfig,
	VelocitySerialization,
} from './components/velocity-component';

export { default as bodyDefinition, canCollide, isSensor, isContinuous, isDying, markDying, bodyShape } from './components/body-component';
export {
	SHAPE_RECTANGLE,
	SHAPE_CIRCLE,
	SHAPE_CAPSULE,
	DEFAULT_COLLIDE_CATEGORY,
	DEFAULT_COLLIDE_MASK,
	BODY_FLAGS_INDEX,
	BODY_SHAPE_MASK,
	BODY_SENSOR_FLAG,
	BODY_CCD_FLAG,
	BODY_DYING_FLAG,
	BODY_CATEGORY_INDEX,
	BODY_MASK_INDEX,
	BODY_SIZE,
} from './components/body-component';
export type {
	BodyComponent,
	BodyConfig,
} from './components/body-component';

export { default as bouncinessDefinition } from './components/bounciness-component';
export {
	BOUNCINESS_INDEX,
	BOUNCINESS_SIZE,
} from './components/bounciness-component';
export type {
	BouncinessComponent,
	BouncinessConfig,
} from './components/bounciness-component';

export { default as interpolationDefinition, snapEntity, startSpawnInterpolation } from './components/interpolation-component';
export {
	INTERPOLATION_X_INDEX,
	INTERPOLATION_Y_INDEX,
	INTERPOLATION_PREV_X_INDEX,
	INTERPOLATION_PREV_Y_INDEX,
	INTERPOLATION_PROGRESS_INDEX,
	INTERPOLATION_SYNCED_TICK_INDEX,
	INTERPOLATION_DURATION_INDEX,
	INTERPOLATION_TICK_INDEX,
	INTERPOLATION_SIZE,
} from './components/interpolation-component';
export type {
	InterpolationComponent,
	InterpolationConfig,
	SnappableEntity,
	SpawnableEntity,
	SpawnInterpolationOptions,
} from './components/interpolation-component';

export { physicsRegistry } from './components/registry';
export type {
	PhysicsComponents,
	PhysicsUpdateComponents,
	InterpolationComponents,
	InterpolationUpdateComponents,
} from './components/registry';

export { default as SpatialWorld, addSpatialMapData, getSpatialMap, addSpatialTreeData, getSpatialTree } from './world';
export type {
	SpatialMapSystemWorld,
	SpatialMapWorldData,
	SpatialMapWorldSource,
	SpatialTreeSystemWorld,
	SpatialTreeWorldData,
	SpatialTreeWorldSource,
	SpatialWorldEntity,
	SpatialWorldFilter,
	SpatialWorldOptions,
} from './world';

export {
	shapesOverlap,
	contactNormal,
	shapeHalfWidth,
	shapeHalfHeight,
	shapeIsEmpty,
	shapeRadius,
	capsuleHalfLength,
	boundsHalfWidth,
	boundsHalfHeight,
	orientedBoxesOverlap,
	segmentSegmentDistanceSquared,
	segmentBoxDistanceSquared,
	pointSegmentDistanceSquared,
} from './math/shapes';
export type { Vector } from './math/shapes';

export { default as CollisionBroadphase, COLLIDABLE_QUERY } from './systems/collision';
export type { CollisionComponents, CollisionEntity, CollisionFunction, MoveResult, MovingEntity, SweepResult } from './systems/collision';

export { default as SpatialIndex } from './systems/spatial-index';
export type { SpatialComponents, SpatialEntity, SpatialFilter } from './systems/spatial-index';

export { default as physicsUpdate, createPhysicsUpdate, POSITION_UPDATED_EVENT } from './systems/physics-update';
export type { DeathInterpolationEntity, PhysicsGroupConfig, PhysicsUpdateFunction, PhysicsUpdateMetadata, PhysicsUpdateOptions, PhysicsWorld } from './systems/physics-update';
export { default as PhysicsSystem, DEFAULT_PHYSICS_STEP_MS } from './systems/physics-system';
export type { PhysicsSystemConfig } from './systems/physics-system';

export { default as interpolationUpdate } from './systems/interpolation-update';
export { default as InterpolationSystem } from './systems/interpolation-system';
export type { InterpolationSystemConfig } from './systems/interpolation-system';
