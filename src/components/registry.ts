import bodyDefinition, { type BodyComponent } from './body-component';
import bouncinessDefinition, { type BouncinessComponent } from './bounciness-component';
import dynamicsDefinition, { type DynamicsComponent } from './dynamics-component';
import interpolationDefinition, { type InterpolationComponent } from './interpolation-component';
import polygonDefinition, { type PolygonComponent } from './polygon-component';
import transformDefinition, { type TransformComponent } from './transform-component';
import velocityDefinition, { type VelocityComponent } from './velocity-component';

// The component definitions this library supplies. A game spreads them into its own registry:
//
//   const registry = { ...physicsRegistry, health: healthDefinition };
//
// The keys here are what the physics systems query on, so they must stay as the registry keys.
export const physicsRegistry = {
	transform: transformDefinition,
	velocity: velocityDefinition,
	body: bodyDefinition,
	polygon: polygonDefinition,
	bounciness: bouncinessDefinition,
	dynamics: dynamicsDefinition,
	interpolation: interpolationDefinition,
};

// The slice of a game's component map the physics systems need. A type alias, not an interface, so it satisfies
// the ECS's `ComponentMap` index signature; systems only require the game's map extends this.
export type PhysicsComponents = {
	transform: TransformComponent
	velocity: VelocityComponent
	body: BodyComponent
	polygon: PolygonComponent
	bounciness: BouncinessComponent
	dynamics: DynamicsComponent
	interpolation: InterpolationComponent
};

// The strictly smaller slice InterpolationSystem needs: it never looks at velocity or body. Split out so the
// interpolation update declares exactly what it touches.
export type InterpolationComponents = {
	transform: TransformComponent
	interpolation: InterpolationComponent
};

// The same components as their backing arrays, the form an update sees on the worker thread. `body`, `bounciness`,
// `dynamics` and `interpolation` are optional because an entity may lack them; the collidable query requires `body`, so
// CollisionComponents narrows it back to guaranteed there. A game widens this for extra callback components:
//
//   type GameUpdateComponents = PhysicsUpdateComponents & { health?: Float32Array };
export type PhysicsUpdateComponents = {
	transform: Float32Array
	velocity: Float32Array
	body?: Uint32Array
	polygon?: Float32Array
	bounciness?: Float32Array
	dynamics?: Float32Array
	interpolation?: Float32Array
	// For checking if entity is dead during run
	entity?: Uint32Array
};

// The blocks the interpolation update works on. Both required - the query asks for both - so no per-entity guard.
export type InterpolationUpdateComponents = {
	transform: Float32Array
	interpolation: Float32Array
};
