# @daneren2005/shared-memory-physics

2D physics components and systems for
[`@daneren2005/shared-memory-ecs`](https://www.npmjs.com/package/@daneren2005/shared-memory-ecs). Everything
lives in the ECS's shared-memory blocks, so the simulation can run on a worker thread while the main thread
reads positions straight off its entities.

Examples at https://daneren2005.github.io/shared-memory-physics/

The ECS (`>=1.1.1`) and the shared-memory primitives it is built on are **peer dependencies**: a game must
register these components against the same copy of the ECS it builds its world with.

```sh
npm install @daneren2005/shared-memory-physics @daneren2005/shared-memory-ecs @daneren2005/shared-memory-objects
```

## Components

| Component       | Config                                       | Serialization              | Block                                          |
| --------------- | -------------------------------------------- | -------------------------- | ---------------------------------------------- |
| `transform`     | `width`, `height`, `angle?` / `radius`       | `x`, `y`, `angle`          | `Float32Array` – where, how big, facing        |
| `velocity`      | –                                            | `velocityX?`, `velocityY?` | `Float32Array` – world units per second        |
| `body`          | `shape?`, `collideCategory?`, `collideMask?`, `sensor?`, `continuousCollisionDetection?` | –                          | `Uint32Array` – what shape, what collides with |
| `interpolation` | `interpolate`                                | –                          | `Float32Array` – where to *draw* it            |

Entity configs are flat and shared across every component, so velocity is keyed as `velocityX` / `velocityY`
rather than `x` / `y` (which already belong to the transform). Either velocity axis on its own is enough to
load one, and the missing one defaults to `0`.

The transform is split in two. **Config** is what your entity template says - `width` and `height` are
required, `angle` defaults to `0` - and a size is what loads the component at all: a config with neither a
width nor a height does not get a transform. **Serialization** is the live state that changes as the world
runs, so `save()` returns `x` / `y` and `angle`, while a reloaded entity gets its size back from your own
template rather than the save.

`x` / `y` are the **centre** of the box, not a corner: the box is rotated about that point and collision
projects out from it in both directions. `angle` is in **radians** counter-clockwise from the +x axis, and
the physics never writes it - it is yours to set, usually from the heading, and collision reads it - but it
round-trips through `save` so a turned entity comes back facing the same way. `width` /
`height` are the unrotated size; a box with no area never overlaps anything, not even another box sharing its
exact position.

`interpolation` is where to **draw** an entity, which stops being the same thing as where it is the moment
physics runs less often than the screen refreshes. It is opt-in per entity (`interpolate: true`) and filled in
by [`InterpolationSystem`](#interpolation) - see that section for what it costs and what it buys.

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

`contactNormal` answers the other half of a contact: the unit direction one shape is pushed off the other,
written into a `{ x, y }` you pass in, and `false` when the two are exactly on top of each other and there is no
such direction. It splits the same three ways off the same geometry, so the direction is the face that was
actually hit at the angle the pair is turned to - not the nearest world axis. This is what the native bounce
reflects around; a game reaching for its own response can use it the same way.

`shapesOverlap` is exported, along with `shapeHalfWidth` / `shapeHalfHeight` (the axis-aligned box a shape is
indexed under), `shapeRadius`, `shapeIsEmpty`, `capsuleHalfLength`, and the distance primitives underneath -
`segmentSegmentDistanceSquared`, `segmentBoxDistanceSquared` and `pointSegmentDistanceSquared`, each of which
takes an optional `out` vector and fills it with the gap it measured. `orientedBoxesOverlap`, `boundsHalfWidth`
and `boundsHalfHeight` are still there and still rectangle-only.

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

### The step

`PhysicsSystem` runs on a fixed step of **50ms** unless you say otherwise (`DEFAULT_PHYSICS_STEP_MS`). Collision
is by a distance the whole of it, so running it 20 times a second rather than 60 is two thirds less of the frame
spent on it for a simulation that is no less correct - only coarser. What that costs is smoothness, which is
what [`InterpolationSystem`](#interpolation) is for.

```ts
new PhysicsSystem(world, { deltaBetweenRuns: 0 });   // back to every frame
```

The step has one real ceiling: a move is swept where it *ends*, so **a longer step is a longer move, and a move
longer than the thing in its way is thick goes clean through it**. At 50ms an entity crossing 300 units a second
covers 15 of them per step, so anything it must be stopped by has to be thicker than that. A game with genuinely
fast entities either keeps the step short or makes its walls thick.

The system accumulates frame time and runs once it has a step's worth, so a 16ms frame runs physics on roughly
every third one and hands it the whole 50ms. Nothing is lost and nothing is run twice.

`PhysicsSystem` also stamps each run with a `tick`, which is what the interpolation block is published under.
A game that subclasses the system to attach per-run data of its own **must call `super.addDataToWorld(world)`**:

```ts
class GamePhysicsSystem extends PhysicsSystem<Components, GameComponents, GameWorld> {
	addDataToWorld(world: GameWorld): void {
		super.addDataToWorld(world);   // without this, nothing gets a tick
		world.bounds = this.bounds;
	}
}
```

`GameWorld` extends `PhysicsWorld` (which is `ComponentSystemWorld` plus that `tick`) rather than
`ComponentSystemWorld` directly.

A run's moves are reported back to the main thread as a single `position-updated` event **on the system**,
carrying the ids of everything that moved, so anything you keep keyed off position can follow the moves
rather than having to poll every block:

```ts
import { POSITION_UPDATED_EVENT } from '@daneren2005/shared-memory-physics';

const physics = world.addSystem(new PhysicsSystem(world));

physics.on(POSITION_UPDATED_EVENT, (entityIds: Array<number>) => {
	for(const eid of entityIds) {
		const transform = world.getEntityByEid(eid)?.components.transform;
		// transform.x / transform.y are where it ended up
	}
});
```

Nearly every entity moves on nearly every run, so this is the one thing a physics system must not report an
entity at a time: an event object apiece in the worker, cloned across the boundary, then a lookup and an emit
apiece on the main thread costs more, at a few thousand entities, than moving them did. One array of ids
costs one listener call for the whole run.

No position travels with the id, because there is no need: the transform is a `SharedArrayBuffer` block, so
the position the worker wrote is already on the main thread by the time the event lands - read it off the
entity (or straight off the block). The move is not reported as a property change either, so a listener on
`component-property-updated` never hears about positions.

An entity that did not move is not in the list, so a world of still entities stays quiet - and so does one
held against something it cannot move past.

**A run only reports at all when something is listening.** The bill for this event is paid in the worker - an id
per moved entity pushed into the run's event array, and that array structured-cloned back across the boundary -
so `PhysicsSystem` checks per run whether it has a listener and tells the update not to bother when it does not.
That matters most for a game rendering from [`interpolation`](#interpolation), which wants nothing to do with an
event that fires at the physics rate: it is the rate that game is drawing *around*. Nothing has to be
configured for it, but `reportMoves: true` forces it on for a listener attached somewhere the system cannot see
it, and `reportMoves: false` turns it off regardless.

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

## Interpolation

A 50ms physics step against a 16ms frame means the transform only changes on one frame in three, and an entity
drawn straight off it visibly stutters. `InterpolationSystem` fills in a **render position** that changes every
frame instead, by blending between the two positions physics published either side of its last step:

```
render = prev + (current - prev) * alpha
```

Every position it writes is therefore one the simulation actually produced - somewhere on the segment between
two real ones, never a guess past the end of one. There is nothing to tune and no case where it draws something
that did not happen: an entity that stopped against a wall is drawn easing into the wall and stopping, and one
that turned a corner is drawn turning the corner rather than carrying on into its old heading for a frame and
being snapped back. The cost is **one step of latency, always** - what is on screen is where the world was a
step ago.

```ts
import { InterpolationSystem, PhysicsSystem } from '@daneren2005/shared-memory-physics';

world.addSystem(new PhysicsSystem<Components>(world, { getWorker }));
world.addSystem(new InterpolationSystem<Components>(world));

world.loadEntity({ x: 0, y: 0, width: 10, height: 10, velocityX: 100, interpolate: true });
```

It takes no configuration and is not wired to the physics system. Everything it needs - the two positions, how
much simulated time lies between them, and whether that pair is new - is published into the block by whichever
run wrote it, so a game that retunes `deltaBetweenRuns` mid-flight is followed with nothing told to this system.

Then draw from `interpolation` instead of `transform`, keeping the size and facing where they have always been:

```ts
const { x, y } = entity.components.interpolation ?? entity.components.transform!;
const { width, height, angle } = entity.components.transform!;
```

Draw from it **every frame**, not from `position-updated`. That event fires once per physics step, which is
exactly the cadence interpolation exists to hide - a sprite moved by it would be as choppy as one reading the
transform. Once nothing is listening to it, `PhysicsSystem` stops reporting moves at all and the whole event
costs nothing; see [the note above](#the-step).

**Only rendering should read it.** Range checks, targeting, AI steering, "can I build here" and anything you
persist all want `transform` - the real position. The render position is a function of local frame timing, so
two machines drawing the same simulation at 144Hz and 30Hz hold *different* numbers in it at the same tick;
anything that branches on it stops being deterministic. Nothing in this library ever reads it back, which is
what keeps the simulation itself unaffected.

### A slow physics run costs latency and nothing else

This is the property the whole thing is for, and it is worth being explicit about because it is easy to build
something that looks right and does not have it. **If a physics run takes longer than a frame, nothing about the
motion changes** - it is drawn a little further behind, at exactly the same speed. A worker that consistently
takes 30ms to come back costs 30ms of latency, which is not something an eye can see; only *variance* in how
late it is can be seen at all.

That works because the pacing is driven by the steps that have **landed** in the block, not by the physics
system's own accumulator. The accumulator resets when a run is *posted*, and on a worker thread that is not when
its results arrive - a run posted with 14ms of leftover and taking 30ms to come back leaves a whole frame where
the accumulator says "0.3 of the way into the new step" while the block still holds the one before it, so the
entity is drawn 0.3 along a segment it was drawn 0.96 along last frame. Backwards, then a lurch forward, on
every step.

For the same reason each run publishes **how much simulated time it covered** rather than that being assumed to
be the step: a run that comes back late leaves more than a step's worth banked, and the next one covers two at
once. Dividing that segment by the step would draw it at double speed.

Ordering against the physics system is only a preference - after it means a step is picked up on the frame it
happened rather than the one after, which is one frame of latency and nothing else.

### What it does not need

- **Pause and `timeScale`** are free. `BaseWorld#runUpdate` skips every system while paused and scales the
  elapsed time it hands them, so the pacing stops and slows with the simulation on its own.
- **Spawns at rest** are free. The block is seeded from the entity's config, so something added between steps is
  drawn standing where it was put rather than sliding in from the origin. A spawn *already moving* is the one case
  that needs a hand - see [`startInterpolation`](#a-moving-spawn-startinterpolation) below.
- **Velocity changes, collisions and coming to rest** are all just steps the simulation took, and are drawn as
  they happened.

### What it does need: `snapEntity`

A teleport and a long move are the same two numbers, so this is the one thing blending cannot work out for
itself. Write a transform directly and the entity is drawn sliding the whole way there over the next step:

```ts
import { snapEntity } from '@daneren2005/shared-memory-physics';

entity.components.transform!.x = 500;
snapEntity(entity);   // drawn at 500 on the very next frame
```

### A moving spawn: `startInterpolation`

Blending has only one position for a brand-new entity - where it spawned - so it holds there until the first
physics step gives it a second, up to a whole step later. For anything at rest that is exactly right (the bullet
above stands where it was put). For something spawned *already moving* - a bullet leaving a barrel - that step of
stillness reads as the shot hanging in the air before it goes.

`startInterpolation` fixes it by **opening the render at the spawn point** and moving it out along the entity's own
velocity at its true speed, **jumping the transform forward** to where that motion reaches by the time the first
real step lands. So the entity is drawn leaving the spawn in its true direction from the very next frame, and the
seeded segment hands straight over to the first step with no seam. How far it jumps - and how long the seeded
segment lasts - is whatever is left of the current step, since that is when the first run lands:

```ts
const bullet = world.loadEntity({
  x: 0, y: 0, velocityX: 400, velocityY: 0, radius: 3, interpolate: true,
});
physics.startInterpolation(bullet);   // drawn from the spawn point and moving out, not parked there until the first step
```

It reads the step and the accumulator off the system, so there is nothing to pass.

**The jump skips a collision sweep.** It is a real move of the transform, applied without sweeping the span it
covers, so the entity skips forward up to a step: it can **tunnel** through anything within that span of the spawn,
and it runs that far ahead of where its velocity alone would have put it from then on. This is a deliberate trade
for **spawned projectiles**, where leaving the muzzle instantly matters more than that first sweep - a shot fired
*into* a target still lands inside it and is caught and killed by the next run's overlap test; only something thin
enough to sit entirely within that jumped span is passed through uncaught. Reach for it on bullets and the like,
not on something that must never skip a step of collision. Because the transform is jumped to the segment's end,
the render is still never drawn ahead of the simulation.

A no-op for an entity with no velocity or no interpolation, or while the system steps every frame. Driving physics
by hand rather than through `PhysicsSystem`? Call the underlying `startSpawnInterpolation(entity, { stepMs,
stepFraction, tick })` directly.

### A moving death: `dieAtImpact`

The same lag runs the other way at the end of a life. A fast entity moves a whole step at a time and, with
`continuousCollisionDetection` on, is killed the run its *swept path* first crosses what it hits - which can be a
near-full stride before its step actually lands there. Remove it on the spot and the render, itself a step behind,
draws it blinking out well short of the target. A bullet dies in mid-air.

`dieAtImpact` fixes it as the mirror of the spawn seeding: instead of `callbacks.entityDied`, a collision callback
calls it to **end the dying entity's current segment on the exact point it struck** (`CollisionBroadphase.contactPoint`,
the same entry fraction the sweep already refines) and **defer the kill by one run** - the one extra step the render
needs to play that last stride onto the impact before the entity is gone:

```ts
onCollision(world, self, other, queries, callbacks) {
  // `self` (a fast sensor bullet) just swept through `other`.  Draw it reaching `other`, then die - rather than
  // vanishing a stride short.
  world.dieAtImpact(self, other);

  // Gameplay still happens now: the hit lands this run, only the visual removal waits.
  callbacks.emitEntityEvent(other.entityId, 'hit');
}
```

Either side of the pair can be the one to kill - `dieAtImpact(dying, other)` takes whichever carried the fatal
role, working out that entity's own approach from its velocity. The struck entity is marked with a runtime `dying`
bit (`BODY_DYING_FLAG`) that leaves it out of the broadphase at once, so nothing runs into it again while it plays
out, and it is removed at the top of its next update. The bit lives in shared memory, so any worker stepping the
entity honours it. Nothing clears it - a dying entity is gone a run later.

`dieAtImpact` is set on the world every run by `createPhysicsUpdate`; keep a `callbacks.entityDied` fallback if you
call `onCollision` by hand without a `preRun`. It moves position only - raise your own hit or score event on the
spot, as above.

### The cost

32 bytes per interpolated entity, three extra writes per entity per physics step, and a per-frame pass of one
lerp per entity on the main thread - order 0.2ms at 10,000 entities. An entity without the component pays
nothing at all. `forceMainThread: false` plus a `getWorker` moves the pass to a worker for worlds large enough
that it shows up in a profile, at the price of the render position being one frame stale; because consumers only
ever read `interpolation.x`, that is a constructor flag rather than a migration.

Physics writes `prev` and then the transform on the worker thread while the main thread reads both, so the block
carries a tick stamp that is written **last**, with a release store. The update reads it on either side of its
own reads and drops the frame if it changed, rather than blending a `prev` from one step against a transform
from another - which is the one mismatch that would draw an entity moving backwards.

## Collisions

`createPhysicsUpdate` builds an update whose entities notice each other: every move is swept against whatever
is in front of it, so nothing is ever moved into anything else, and a callback of yours is told what each
entity ran into. The callback runs wherever the update runs - on the worker thread, in the same pass as the
movement - so it cannot be handed to `PhysicsSystem` at construction time: functions do not survive
`postMessage`. It reaches the worker by being baked into a module that both the worker file and the main
thread import.

The callback is optional and the [sweep](#stopping-at-the-edge) is not. `createPhysicsUpdate()` with nothing
asked of it at all is movement that comes to rest against walls, terrain and other units and says nothing
about any of it:

```ts
// Stopped by everything, responds to nothing.
export const gamePhysicsUpdate = createPhysicsUpdate<Components>();
```

Movement that walks straight through the world is the bare [`physicsUpdate`](#using-physicsupdate-in-your-own-system)
instead, which is also the only one that costs nothing per entity for the collidable query.

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

**Once per pair, per run.** Both sides of a contact find it - one by sweeping into it, the other by overlapping
it on its own turn - and the callback fires once, for whichever got there first. `self` is that entity, with
every block the system asked for; `other` is the one it hit, where only `transform` is guaranteed. **The other
side gets no call of its own**, so a callback that only touches `self` leaves it untouched: apply damage, tag a
kill, or raise an event for *both* entities in the one call. Which of the two is `self` follows update order
and is not something to depend on. An entity with no velocity is never `self`, because the system never moves
it, but it is still found as `other`.

Writes go straight into shared memory, so a callback can bounce an entity by flipping its velocity, or push a
value another thread also touches with the atomics from `@daneren2005/shared-memory-objects`. To reach past
the two entities in front of it - to credit a third for a kill, say - a callback can walk
`queries[COLLIDABLE_QUERY]`, the full collidable list. Anything that has to happen on the main thread goes
through `callbacks`: `entityDied`, `entityComponentChanged`, `createEntity`, and `emitEntityEvent` for an
event of your own - the same one the move above reports itself through. To kill a *fast* mover on impact and
still have it drawn reaching what it hit, call `world.dieAtImpact(dying, other)` in place of `entityDied` - see
[`dieAtImpact`](#a-moving-death-dieatimpact).

**What collides.** Everything with a transform and a `body`, not only the entities the system moves, so a
ship can run into a station that has no velocity of its own. Shapes that only just touch do not count as
overlapping, and one with no area never collides at all.

### Stopping at the edge

An entity is never moved into another one. Before anything is written to the transform, the move is swept
against everything along its path, and the entity is put down on the edge of whatever is in the way - then
`onCollision` runs for it, exactly as it would if the two had ended up overlapping.

This is every update `createPhysicsUpdate` builds, with or without a callback: where an entity is allowed to
end up is physics' decision, and what the game does about the contact is a separate one.

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

**Continuous collision detection** lifts that ceiling for the bodies that need it, without slowing down the
ones that do not. Set `continuousCollisionDetection: true` on a body and its own move is tested along the whole
path it swept this run rather than only where the step ends - so a bullet that steps clean past a target still
comes to rest against it (or, if it is a sensor, still reports the pass through it). It is one extra swept-shape
test per candidate and only for that body: every other body stays on the single end-of-move test. Each shape
sweeps to a single covering shape - a rectangle to an oriented box spanning start to end, a circle or capsule to
a capsule down its path - chosen to be a superset of the ground actually covered, so a contact is reported early
at worst, never missed. A continuous body comes straight to rest at its first contact and does not corner-slide,
which is the behaviour a fast thing wants anyway. Reach for it on the small, fast things that tunnel - bullets,
thrown weapons - and leave it off everything else.

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

### Scoping a system to a group

Categories decide which *kinds* of body collide; `scope` decides which *world* they collide in. A game that
runs several independent groups at once - solar systems around the same origin, floors of a dungeon - gives
each group its own `PhysicsSystem` with a `scope`, and each one then only ever sees, moves, or collides against
the entities that pass it:

```ts
world.addSystem(new PhysicsSystem<Components>(world, {
	updateFunction: gamePhysicsUpdate,
	scope: entity => entity.components.solarSystem?.solarSystemId === solId,
}));
```

Unlike a category rule - which every body in the world is still weighed against - a scoped-out body never
enters this system's broadphase at all, so two groups whose boxes overlap around a shared origin cannot collide
across the boundary, and the tree each run builds is only as big as its own group. `scope` is separate from the
sharding `filter` (which narrows only *which* movers a worker steps, still sweeping the whole world so one
simulation can spread across cores); an entity handed both has to pass each to be moved.

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

Both honour a body's `continuousCollisionDetection` flag. `sweep` picks it up on its own - a continuous body's
move is swept along its whole path. `forEachOverlapping` needs the move handed to it, since it runs after the
entity has already been put down: `forEachOverlapping(self, handle, moveX, moveY)` tests the path a continuous
body just swept, while the two-argument form (and every non-continuous body) tests only where it now stands.

## Spatial queries

`PhysicalWorld` keeps every transformed entity in a live, shared `SharedSpatialMap`. The physics worker updates
the entry immediately after it writes a final position, while entity add/remove and transform/body component
changes are tracked on the main thread. That makes the same index available for occasional main-thread checks
such as picking an entity under the mouse, and for worker systems that would otherwise rebuild an index for only
a few queries:

```ts
import { PhysicalWorld, physicsRegistry } from '@daneren2005/shared-memory-physics';

const world = new PhysicalWorld(physicsRegistry, {
  spatial: { gridSize: 50, maxEntities: 100_000 },
});

const clicked = world.findNearestSpatial(mouseX, mouseY, 0);
const nearby = world.searchSpatialAround(x, y, 100, 100);
```

`searchSpatial`, `searchSpatialAround`, `findNearestSpatial`, and `findNearbySpatial` return live entities and
accept entity filters. Shape-aware axis-aligned bounds are stored: rotated rectangles and capsules occupy the
box around their actual outline. A direct transform/body edit outside the physics update must be followed by
`world.updateSpatialEntity(entity)`. A custom physics wrapper that changes a transform after calling the library
update can call `updateSpatialMap(workerWorld, entityId, components)` instead.

`PhysicsSystem` requires a `PhysicalWorld` (or another `BaseWorld` that implements `PhysicalWorldSource`) and
automatically shares its map with the physics worker. Another worker system can receive the same map by calling
`addPhysicalWorldData(sourceWorld, runWorld)` from its system's `addDataToWorld`, then `getSpatialMap(runWorld)` in
its update. The worker world must come from `@daneren2005/shared-memory-ecs` 1.5.1 or newer so it carries the
shared heap used to reconstruct the map handle.

The live map is intentionally not the collision or bulk-query hot path. `CollisionBroadphase` and
`SpatialIndex` still use Flatbush snapshots: packing one immutable R-tree per run is faster when that run will
make a large number of queries. Use the live map for continuous availability and sparse queries; use
`SpatialIndex` for query-heavy systems such as targeting every entity every tick.

`SpatialIndex` is the same R-tree the collision broadphase is built on, without collide categories or shape
tests. Build one from anything shaped like a query result and it reads the transform (and the body, to know which
outline that transform describes) off each entity. Only the transform is needed, so it indexes anything with a
place in the world rather than only what collides:

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

## Examples

Three runnable examples live in [`examples/`](./examples), rendered with [Phaser](https://phaser.io) (a dev
dependency - it is not part of the library) and driven by plain HTML controls beside the canvas:

```sh
npm start          # http://127.0.0.1:8080
```

- **Bouncing circles** - circles with a random position and heading, reflected off each other and off the
  walls by the native bounce, which mirrors the velocity about the contact normal.
- **Bouncing rectangles** - the same, on boxes of random width and height, where the normal is the face the
  two are least through each other on rather than the line between their centres.
- **Walking into a wall** - one unit between two boxes, turned around on a timer so it presses into each of
  them in turn. It starts on a deliberately long 100ms physics step, so turning **interpolate rendering** off is
  a direct before-and-after on the same running scene: the same simulation, drawn six frames at a time instead
  of one.

Every page has a **physics step** slider (starting at the library's own 50ms) and an **interpolate rendering**
toggle, so the trade the [interpolation section](#interpolation) describes can be looked at rather than
reasoned about.

The examples import the library as `@daneren2005/shared-memory-physics`, aliased at the source next door, so
the code reads the way a game's would and editing a system hot-reloads the running page. `npm start` also
serves the two [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated)
headers `SharedArrayBuffer` needs, so physics genuinely runs on a worker there; where a browser will not hand
one out, the ECS runs the same update in-process instead and the **Run physics in a worker** toggle says so.

The walls the examples bounce off are ordinary entities - a transform and a body, no velocity - so they are
stopped against by the same sweep that stops anything against anything.

Every push to `dev` or `production` publishes them to GitHub Pages, both to the same place - so the site shows
whichever branch pushed last, which is what you want while the examples are changing faster than releases are
cut. See [`.github/workflows/pages.yml`](./.github/workflows/pages.yml) for the one-time repository setting it
needs, and for the one line to drop when it should go back to publishing releases only.

## Building

```sh
npm install
npm run build            # emits dist/ (js + d.ts)
npm run build:examples   # emits examples/dist/
npm run type-check
npm test
```
