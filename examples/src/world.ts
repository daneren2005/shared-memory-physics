import type { ComponentsOf, EntityConfigOf, EntityUpdateComponents } from '@daneren2005/shared-memory-ecs';
import { physicsRegistry, SpatialWorld } from '@daneren2005/shared-memory-physics';
import type { PhysicsUpdateComponents } from '@daneren2005/shared-memory-physics';

// A game spreads `physicsRegistry` into its own registry alongside its game specific components.  The examples
// have none of their own - everything they do is position, size and velocity - so the physics components are
// the whole of it.
export const registry = {
	...physicsRegistry,
};

export type Components = ComponentsOf<typeof registry>;
export type Config = EntityConfigOf<typeof registry>;
export type ExampleWorld = SpatialWorld<typeof registry>;

// The blocks an example's physics update works on, which is what the collision callbacks below are typed
// against.  With no components of our own it is exactly what the library needs, but it is spelled out here
// because that is where a game would widen it: `& { health?: Float32Array }`.
export type ExampleUpdateComponents = PhysicsUpdateComponents & EntityUpdateComponents<Components>;

// The shared buffer the components live in is capped at 1 MB per buffer - a pointer into it is only so wide - and
// the heap grows by chaining more of them as entities are loaded, so there is nothing to size up front: even the
// boids stress test at fifty thousand just grows itself a handful of buffers while it is being filled, before the
// workers are started.
export function createExampleWorld(): ExampleWorld {
	return new SpatialWorld(registry, {
		spatial: { gridSize: 50, buckets: 8_192, maxEntities: 100_000, maxSlots: 400_000 },
	});
}
