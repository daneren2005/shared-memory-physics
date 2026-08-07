import bodyDefinition, { type BodyComponent } from './body-component';
import bouncinessDefinition, { type BouncinessComponent } from './bounciness-component';
import interpolationDefinition, { type InterpolationComponent } from './interpolation-component';
import transformDefinition, { type TransformComponent } from './transform-component';
import velocityDefinition, { type VelocityComponent } from './velocity-component';

// The component definitions this library supplies.  A game spreads them into its own registry so its world
// allocates their memory pools alongside its game specific components:
//
//   const registry = { ...physicsRegistry, health: healthDefinition };
//   const world = new BaseWorld(registry);
//
// The names here are what the physics systems query on, so they must be kept as the registry keys.
export const physicsRegistry = {
	transform: transformDefinition,
	velocity: velocityDefinition,
	body: bodyDefinition,
	bounciness: bouncinessDefinition,
	interpolation: interpolationDefinition,
};

// The slice of a game's component map that the physics systems need.  Declared as a type alias (not an
// interface) so it satisfies the ECS's `ComponentMap` index signature.  Systems here are generic over the
// game's full component map and only require that it extends this.
export type PhysicsComponents = {
	transform: TransformComponent
	velocity: VelocityComponent
	body: BodyComponent
	bounciness: BouncinessComponent
	interpolation: InterpolationComponent
};

// The slice InterpolationSystem needs, which is a strictly smaller one: it never looks at a velocity or a body.
// Split out so a game can be generic over it on its own, and so the interpolation update declares exactly what
// it touches rather than inheriting the physics list.
export type InterpolationComponents = {
	transform: TransformComponent
	interpolation: InterpolationComponent
};

// The same components as their concrete backing arrays, which is the form a system's update function sees them
// in on the worker thread.  `body` is optional here because it is optional on the query that moves entities -
// movement does not need it, and it is only sent along when something is going to collide.  The collidable
// query requires it, so CollisionComponents narrows it back to guaranteed for the entities found through that.
//
// A game that hands extra components to its collision callback widens this with its own:
//
//   type GameUpdateComponents = PhysicsUpdateComponents & { health?: Float32Array };
export type PhysicsUpdateComponents = {
	transform: Float32Array
	velocity: Float32Array
	body?: Uint32Array
	// Optional in the same way and for the same reason: an entity that does not bounce does not have the
	// component, and it is only ever read for the moving entity itself, which the sweep bounces on collision.
	bounciness?: Float32Array
	// Optional in the same way and for the same reason: an entity a game never draws interpolated does not have
	// the component, and the update writes nothing for it.
	interpolation?: Float32Array
	// For checking if entity is dead during run
	entity?: Uint32Array
};

// The blocks the interpolation update works on.  Both are required - the system's query asks for both - which
// is what lets the update read them without a guard per entity per frame.
export type InterpolationUpdateComponents = {
	transform: Float32Array
	interpolation: Float32Array
};
