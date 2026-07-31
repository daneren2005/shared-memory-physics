# @daneren2005/shared-memory-physics

2D physics components and systems for
[`@daneren2005/shared-memory-ecs`](https://www.npmjs.com/package/@daneren2005/shared-memory-ecs). Everything
lives in the ECS's shared-memory blocks, so the simulation can run on a worker thread while the main thread
reads positions straight off its entities.

The ECS (`>=1.1.1`) and the shared-memory primitives it is built on are **peer dependencies**: a game must
register these components against the same copy of the ECS it builds its world with.

```sh
npm install @daneren2005/shared-memory-physics @daneren2005/shared-memory-ecs @daneren2005/shared-memory-objects
```

## Components

| Component   | Config                                       | Serialization              | Block                                          |
| ----------- | -------------------------------------------- | -------------------------- | ---------------------------------------------- |
| `transform` | `width`, `height`, `angle?` / `radius`       | `x`, `y`                   | `Float32Array` – where, how big, facing        |
| `velocity`  | –                                            | `velocityX?`, `velocityY?` | `Float32Array` – world units per second        |
| `body`      | `shape?`, `collideCategory?`, `collideMask?` | –                          | `Uint32Array` – what shape, what collides with |

Entity configs are flat and shared across every component, so velocity is keyed as `velocityX` / `velocityY`
rather than `x` / `y` (which already belong to the transform). Either velocity axis on its own is enough to
load one, and the missing one defaults to `0`.

The transform is split in two. **Config** is what your entity template says - `width` and `height` are
required, `angle` defaults to `0` - and a size is what loads the component at all: a config with neither a
width nor a height does not get a transform. **Serialization** is the live state that changes as the world
runs, so `save()` returns only `x` / `y` and a reloaded entity gets its size and starting facing back from
your own template rather than the save.

`x` / `y` are the **centre** of the box, not a corner: the box is rotated about that point and collision
projects out from it in both directions. `angle` is in **radians** counter-clockwise from the +x axis, and
nothing here writes it - it is yours to set, usually from the heading, and collision reads it. `width` /
`height` are the unrotated size; a box with no area never overlaps anything, not even another box sharing its
exact position.

The `body` is what makes an entity collidable, and a size loads one just as it loads a transform - so
everything with a place in the world collides with everything else until you say otherwise. All of it is
defining config out of your own template, which is why `save` returns nothing for it: a reloaded entity gets
its shape and categories back from the template rather than from the save. See
[Body shapes](#body-shapes) for `shape` and [Collision filtering](#collision-filtering) for the other two.

## Body shapes

An entity is one of three shapes, and all three live in the same transform - so which one it is changes what
that width and height *mean* rather than where they are kept:

| `shape`           | Config                                | What it is                                                    |
| ----------------- | ------------------------------------- | ------------------------------------------------------------- |
| `SHAPE_RECTANGLE` | `width`, `height`                     | a `width` x `height` box turned to `angle` – the default      |
| `SHAPE_CIRCLE`    | `radius`                              | a circle of diameter `width`, which `angle` does not affect   |
| `SHAPE_CAPSULE`   | `width`, `height`, `shape`             | `width` from end to end, `height` thick, lying along `angle`  |

```ts
import { SHAPE_CAPSULE } from '@daneren2005/shared-memory-physics';

world.loadEntity({ x: 0, y: 0, width: 10, height: 4 });                          // a rectangle
world.loadEntity({ x: 0, y: 0, radius: 5 });                                     // a circle
world.loadEntity({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });   // a capsule
```

`radius` is the same size said differently: it loads as a `width` and a `height` of the diameter, so there is
still only one size in the block however the config spelled it. Giving both a `radius` and a `width` throws
rather than one quietly winning. A config that says nothing about its `shape` is read off the size it gave - a
`radius` describes a circle, anything else a rectangle - so **only capsules have to name their shape**, and an
unrecognised one throws rather than quietly becoming a rectangle.

A capsule's `width` is its **whole** length, caps included, and it lies along the way the entity faces: a 40x10
capsule is a 30-long core with a 5 radius cap at each end, and it is the same 10 thick all the way down. One
told it is no longer than it is wide collapses to a circle rather than turning itself inside out.

Because a circle is a capsule whose core has no length, all three shapes are *an oriented core grown by a
radius* - a box with no radius, a point, or a segment - which leaves only three overlap tests rather than one
per pairing: box against box (the separating axis test), core against core, and core against box. Touching
exactly still counts as **not** overlapping, whichever pair it is, and a shape with no area never overlaps
anything. Which of the two sizes decides that depends on the shape: a circle with no height is a perfectly
good circle, while a rectangle with no height is nothing at all.

`shapesOverlap` is exported, along with `shapeHalfWidth` / `shapeHalfHeight` (the axis-aligned box a shape is
indexed under), `shapeRadius`, `shapeIsEmpty`, `capsuleHalfLength`, and the distance primitives underneath -
`segmentSegmentDistanceSquared`, `segmentBoxDistanceSquared` and `pointSegmentDistanceSquared`.
`orientedBoxesOverlap`, `boundsHalfWidth` and `boundsHalfHeight` are still there and still rectangle-only.

## Registering

Spread `physicsRegistry` into your own registry so the world allocates the memory pools for these components
alongside your game specific ones. The keys are what the systems query on, so keep them as they are:

```ts
import { BaseWorld } from '@daneren2005/shared-memory-ecs';
import { physicsRegistry } from '@daneren2005/shared-memory-physics';

const registry = {
	...physicsRegistry,
	health: healthDefinition,
};
const world = new BaseWorld(registry);

const entity = world.loadEntity({ x: 0, y: 0, width: 10, height: 5, velocityX: 10, velocityY: 0, maxHealth: 100 });
console.log(entity.components.transform!.x); // 0
```

## PhysicsSystem

`PhysicsSystem` moves every entity that has both a `transform` and a `velocity`, integrating velocity into
position once per run - and, once you give it an update built by [`createPhysicsUpdate`](#collisions), tells
you which entities have run into each other. It is generic over your full component map, so your world passes
straight in:

```ts
import { PhysicsSystem } from '@daneren2005/shared-memory-physics';

world.addSystem(new PhysicsSystem(world));

await world.init();
world.update(1000); // one second: the entity above is now at x = 10
```

`elapsedTime` is in milliseconds (what `BaseWorld#update` is driven with) and velocity is in world units per
**second**, so a run covering 16ms moves an entity 16/1000ths of its velocity.

An entity that moved is reported back to the main thread as a single `position-updated` event carrying where
it ended up, so anything you keep keyed off position can follow a move rather than having to poll the block:

```ts
import { POSITION_UPDATED_EVENT } from '@daneren2005/shared-memory-physics';

entity.on(POSITION_UPDATED_EVENT, (x, y) => {
	// 12.5, -3
});
```

Both axes come with it even when only one of them moved, so a listener always has the whole position without
having to remember the last one it was told - and a diagonal move costs one event across the worker boundary
rather than the two a `component-property-updated` per property would. The move is not reported as a property
change as well, so a listener on `component-property-updated` no longer hears about positions at all.

An entity that did not move says nothing, so a world of still entities stays quiet - and so does one held
against something it cannot move past.

The move is written with `addAtomicFloat32` rather than a plain `+=`, so a game system on another thread can
add to the same position in the same instant without either move being lost.

### Running off the main thread

Bundlers need the `new Worker(new URL(...))` call written out in your own source, so the worker entry file
lives in your game and is handed to the system through `getWorker`:

```ts
// physics.worker.ts
import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import { physicsUpdate } from '@daneren2005/shared-memory-physics';

createComponentWorker(self, physicsUpdate);
```

```ts
world.addSystem(new PhysicsSystem(world, {
	getWorker: () => new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' }),
	// Optional: run at a fixed timestep instead of every frame.
	deltaBetweenRuns: 1000 / 60,
}));
```

Without a `getWorker` (or where Web Workers / `SharedArrayBuffer` are unavailable) the exact same
`physicsUpdate` runs in-process on the main thread instead.

## Collisions

`createPhysicsUpdate` builds an update that, right after moving each entity, tells a callback of yours what
that entity has moved into. The callback runs wherever the update runs - on the worker thread, in the same
pass as the movement - so it cannot be handed to `PhysicsSystem` at construction time: functions do not
survive `postMessage`. It reaches the worker by being baked into a module that both the worker file and the
main thread import.

```ts
// game-physics-update.ts - imported by *both* the worker file and the system below
import {
	createPhysicsUpdate,
	VELOCITY_X_INDEX,
	VELOCITY_Y_INDEX,
	type PhysicsUpdateComponents,
} from '@daneren2005/shared-memory-physics';
import { HEALTH_INDEX } from './health-component';

// The blocks the update touches: the two physics needs, plus your own.
export type GameUpdateComponents = PhysicsUpdateComponents & { health?: Float32Array };

export const gamePhysicsUpdate = createPhysicsUpdate<Components, GameUpdateComponents>({
	// Extra components to send along to the callback, on top of the transform and velocity.
	optional: ['health'],
	onCollision(world, self, other, queries, callbacks) {
		// `self` just moved into `other`.  Bounce it back off whatever it hit...
		self.components.velocity[VELOCITY_X_INDEX] *= -1;
		self.components.velocity[VELOCITY_Y_INDEX] *= -1;

		// ...and take a bite out of the thing it ran into, if that is something with health.
		const health = other.components.health;
		if(health && (health[HEALTH_INDEX] -= 1) <= 0) {
			// The worker has blocks, not entities, so a death goes back to the main thread as an event.
			callbacks.entityDied(other.entityId);
		}
	},
});
```

```ts
// physics.worker.ts
import { createComponentWorker } from '@daneren2005/shared-memory-ecs';
import { gamePhysicsUpdate } from './game-physics-update';

createComponentWorker(self, gamePhysicsUpdate);
```

```ts
world.addSystem(new PhysicsSystem<Components, GameUpdateComponents>(world, {
	updateFunction: gamePhysicsUpdate,
	getWorker: () => new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' }),
}));
```

`createPhysicsUpdate` stamps what it needs onto the function it returns, so `optional` and the collidable
query come across with `updateFunction` and never have to be repeated on the system.

**Per entity, not per pair.** The callback fires for the entity that *moved*, once for each thing it ended up
on top of. `self` is that entity, with every block the system asked for; `other` is what it hit, where only
`transform` is guaranteed. Two moving entities that run into each other therefore get one call each with the
roles swapped - which is what lets a callback act on itself and leave the other side to its own call. An
entity with no velocity is never `self`, because the system never moves it, but it is still found as `other`.

Writes go straight into shared memory, so a callback can bounce an entity by flipping its velocity, or push a
value another thread also touches with the atomics from `@daneren2005/shared-memory-objects`. To reach past
the two entities in front of it - to credit a third for a kill, say - a callback can walk
`queries[COLLIDABLE_QUERY]`, the full collidable list. Anything that has to happen on the main thread goes
through `callbacks`: `entityDied`, `entityComponentChanged`, `createEntity`, and `emitEntityEvent` for an
event of your own - the same one the move above reports itself through.

**What collides.** Everything with a transform and a `body`, not only the entities the system moves, so a
ship can run into a station that has no velocity of its own. Shapes that only just touch do not count as
overlapping, and one with no area never collides at all.

### Stopping at the edge

An entity is never moved into another one. Before anything is written to the transform, the move is swept
against everything along its path, and the entity is put down on the edge of whatever is in the way - then
`onCollision` runs for it, exactly as it would if the two had ended up overlapping.

```ts
// A ship at x = 0 and a station at x = 30, both 10 wide, with a velocity that asks for 25 in this run.
world.update(1000);
console.log(ship.components.transform!.x); // ~20, their edges touching - not 25, and never inside it
```

The move is one decision over everything it lands on rather than one per entity, so a mover ending up on top of
two units comes to rest against the *near* one however the two happened to come up, and only the near one is
reported as a collision - the far one was never reached. An entity wedged between two at the same moment gets a
call for each.

Two details worth knowing:

- **An entity that was already inside another one is let through.** Something you spawned on top of it, or
  another system pushed it into, cannot be what *this* move ran into, and blocking on it would pin the entity
  there for good. It still gets its `onCollision` call for the overlap.
- **An entity with nowhere left to go stays exactly where it is** rather than creeping the last fraction
  forwards each run, so it reports no position change while it pushes - but it does keep reporting the
  collision for as long as it keeps pushing.

**What it costs.** A move is checked where it *ends*, so a clear one - which is nearly every move - is a single
shape test against each thing near where it lands, and nothing more. Only a move that is genuinely stopping
somewhere pays for working out where: contact is then halved in on rather than solved, since three shapes at any
rotation to one another have no single formula for when a pair first touches, while the overlap test the
narrowphase already has answers it for any pair anywhere. The position an entity is put down at is always one
that tested clear, so it is genuinely outside everything - within about `1e-4` world units of touching.

The trade for that is **a move long enough to carry an entity clean past something is not stopped by it**: by
the time the move is out there is nothing left to land on. That takes a single run covering more ground than the
thing in the way is thick, so at any normal frame rate it does not arise - a ship crossing 100 units a second
moves 1.6 of them per frame at 60fps. A fixed `deltaBetweenRuns` puts a ceiling on it if your game has anything
fast enough to care.

### Collision filtering

Every body collides **as** a `collideCategory` and **with** a `collideMask`, both plain 32-bit fields. The
categories are yours to name - this library only ever reads them as bits - and a pair collides when each
side's mask accepts the other's category:

```ts
// Your own categories, in your own game.
const GROUND = 1 << 0;
const AIR = 1 << 1;
const PROJECTILE = 1 << 2;

world.loadEntity({ x: 0, y: 0, width: 10, height: 10, collideCategory: GROUND, collideMask: GROUND | PROJECTILE });
world.loadEntity({ x: 0, y: 0, width: 10, height: 10, collideCategory: AIR, collideMask: AIR | PROJECTILE });
// A ranged attack the ground unit fires, which can hit either of them.
world.loadEntity({ x: 0, y: 0, width: 2, height: 2, collideCategory: PROJECTILE, collideMask: GROUND | AIR });
```

The ground unit and the air unit pass straight through each other; the attack hits both.

The test is **symmetric** - both sides have to accept each other - so a pair either collides or does not
regardless of which one moved into which. That matters because collisions are reported per entity as each one
moves: a rule that depended on the direction would make the outcome depend on the order the system happened
to move them in. The thing to remember is that the unit above has to name `PROJECTILE` in its own mask; a
projectile naming `GROUND` is not on its own enough. A one-sided *response* - an attack that hurts a unit
without the unit hurting it back - is something your `onCollision` decides by looking at `other`, not
something the two entities disagree about having touched.

`collideCategory` defaults to `1` and `collideMask` to every bit, so a world that sets neither behaves as it
did before categories existed. Either `collideCategory: 0` or `collideMask: 0` opts an entity out of
collisions entirely, in both directions. `canCollide(categoryA, maskA, categoryB, maskB)` is exported if you
want to run the same test yourself.

Both fields live in the shared block, so a system on any thread can write them and the next run picks the
change up - a unit that takes off becomes an air unit without anything being re-sent to the worker.

The broadphase is bucketed by category rather than being one tree over everything, so a projectile that can
only hit units never walks the tree the terrain is in.

**How it is found.** `preRun` builds a [Flatbush](https://github.com/mourner/flatbush) R-tree over every
collidable entity as it stands at the top of the run. That is the only moment they all agree on, so each
entity's box is grown by however far its velocity could carry it before the run is out, keeping the tree a
true superset of what can really collide - grown both ways rather than along the heading, since a callback
can turn an entity around before it has had its own move. Then each entity, as it moves, searches the trees its
mask accepts with where it has actually ended up, and every candidate that gets past the masks goes through the
full [shape](#body-shapes) test. `CollisionBroadphase` is exported if you want the tree itself, and the
geometry is all reachable on its own - see the end of [Body shapes](#body-shapes).

**One thing to know about the ordering.** Entities move one at a time, and the narrowphase reads live
positions - so an entity that has not had its own move yet is still tested where it started. Two entities
closing head on will usually collide off the *second* one's move, when both are in their new places, rather
than off both. The pair is never missed, just attributed to the side that moved last. The same ordering is why
the entity that moves first gets the clear road: it takes its whole move, and the second one is the one that
comes to rest against it.

## Using physicsUpdate in your own system

`physicsUpdate` is a plain `EntityUpdateFunction`, so a game that already has its own movement system can call
it rather than adding a second system - the block offsets it reads are exported too:

```ts
import { physicsUpdate, TRANSFORM_X_INDEX, VELOCITY_X_INDEX } from '@daneren2005/shared-memory-physics';
```

`CollisionBroadphase` is available the same way, for a system that wants the collision detection without the
movement. Build one per run from a list of `{ entityId, components }` and how many **seconds** the run covers
(that is what sizes the room left for movement), then ask it what any given entity is overlapping:

```ts
import { CollisionBroadphase, COLLIDABLE_QUERY } from '@daneren2005/shared-memory-physics';

const broadphase = new CollisionBroadphase(queries[COLLIDABLE_QUERY], world.elapsedTime / 1000);
broadphase.forEachOverlapping({ entityId, components }, other => { /* ... */ });
```

`sweep` is the other half, for a system that moves things itself and wants the same
[stopping at the edge](#stopping-at-the-edge). Hand it the move you were about to make and it says how much of
it is available, along with whatever the rest of it would have run into:

```ts
const { fraction, blocking } = broadphase.sweep({ entityId, components }, moveX, moveY);
transform[TRANSFORM_X_INDEX] += moveX * fraction;
transform[TRANSFORM_Y_INDEX] += moveY * fraction;
```

`blocking` is what the entity came to rest *against*, which `forEachOverlapping` will not report from that
resting place: the two are touching rather than through each other.

## Spatial queries

`SpatialIndex` answers the other kind of question about where things are - who is in this area, and what is
the closest thing to this point - for the systems that are not about collisions at all: targeting, aggro
range, spawning somewhere clear, area effects. It is the same R-tree the broadphase is built on, without the
collide categories or the shape tests.

Build one from anything shaped like a query result and it reads the transform (and the body, to know which
outline that transform describes) off each entity. Only the transform is needed, so it indexes anything with
a place in the world rather than only what collides:

```ts
import { SpatialIndex } from '@daneren2005/shared-memory-physics';

const index = new SpatialIndex(queries.collidable);
```

Nothing reads the blocks after that, so the index is a **snapshot** of where everything was when it was
built - build one per run, in `preRun`, and let every entity in that run search it.

| Query                                              | Answers                                              |
| -------------------------------------------------- | ---------------------------------------------------- |
| `search(minX, minY, maxX, maxY, filter?)`           | everything whose box reaches into that one            |
| `searchAround(x, y, reachX, reachY, filter?)`       | the same, written from the middle out                 |
| `findNearest(x, y, maxDistance?, filter?)`          | the closest one, or `undefined`                       |
| `findNearby(x, y, maxResults, maxDistance?, filter?)` | the closest `maxResults`, nearest first             |

Every one of them takes a `filter`, run per candidate the tree turns up, and hands it the whole entity -
`{ entityId, components }` - so it can read back any block that came along with the query. That is where the
things the index cannot know go: the searcher's own id, which side something is on, whether it is worth
shooting at.

```ts
const target = index.findNearest(x, y, 150, other => other.entityId !== entityId && isEnemy(other));
```

`findNearest` walks the tree in distance order rather than searching a box and sorting what comes back, so
ask it directly rather than building the sort yourself - it settles as soon as the nearest box is reached, and
`maxDistance` stops it walking the rest of the world when the answer is that there is nobody. Distance is
measured to an entity's **box**, not to its centre, so a large target is as near as its nearest edge and
`maxDistance` reads as a range past the hull.

## Building

```sh
npm install
npm run build      # emits dist/ (js + d.ts)
npm run type-check
npm test
```
