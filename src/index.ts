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

export { default as bodyDefinition, canCollide } from './components/body-component';
export {
	SHAPE_RECTANGLE,
	SHAPE_CIRCLE,
	SHAPE_CAPSULE,
	DEFAULT_COLLIDE_CATEGORY,
	DEFAULT_COLLIDE_MASK,
	BODY_SHAPE_INDEX,
	BODY_CATEGORY_INDEX,
	BODY_MASK_INDEX,
	BODY_SIZE,
} from './components/body-component';
export type {
	BodyComponent,
	BodyConfig,
} from './components/body-component';

export { physicsRegistry } from './components/registry';
export type { PhysicsComponents, PhysicsUpdateComponents } from './components/registry';

export {
	shapesOverlap,
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

export { default as CollisionBroadphase, COLLIDABLE_QUERY } from './systems/collision';
export type { CollisionComponents, CollisionEntity, CollisionFunction, MovingEntity, SweepResult } from './systems/collision';

export { default as SpatialIndex } from './systems/spatial-index';
export type { SpatialComponents, SpatialEntity, SpatialFilter } from './systems/spatial-index';

export { default as physicsUpdate, createPhysicsUpdate, POSITION_UPDATED_EVENT } from './systems/physics-update';
export type { PhysicsUpdateFunction, PhysicsUpdateMetadata, PhysicsUpdateOptions } from './systems/physics-update';
export { default as PhysicsSystem } from './systems/physics-system';
export type { PhysicsSystemConfig } from './systems/physics-system';
