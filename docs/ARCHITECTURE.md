# Architecture Map

Internal orientation doc. Read this before exploring the source — it exists so an agent (or a
new contributor) can jump straight to the right file instead of re-deriving the layout. Keep it
current: see the rule in [AGENTS.md](../AGENTS.md). Example-driven API friction is tracked in
[LIBRARY-ERGONOMICS.md](LIBRARY-ERGONOMICS.md).

For **public API and behaviour** (what each component means, collision semantics, interpolation
trade-offs, examples), the [README](../README.md) is the source of truth — this doc points at its
sections rather than repeating them. For the **roadmap / scratch notes**, see `NOTES.md` (do not edit).

## Mental model

A 2D physics layer built on `@daneren2005/shared-memory-ecs`. `PhysicalWorld` also owns a live
`SharedSpatialMap` that client code and workers can query without rebuilding an index. All state lives in the ECS's
`SharedArrayBuffer` component blocks, so the simulation can run on a **worker thread** while the
main thread reads positions straight off its entities with no message-passing per entity.

The two library-supplied ECS `System`s (`PhysicsSystem`, `InterpolationSystem`) run on the main
thread and orchestrate; the actual per-entity work is an **update function** (`physicsUpdate` /
the closure from `createPhysicsUpdate`) that runs identically in-process or in a worker. The same
update module is imported by both the main thread and the game's worker entry file, so the two
backends never drift.

```
main thread                              worker thread (optional)
  PhysicsSystem ── posts blocks + commands ──► EntitySystemWorker
    (gathers query, snapshots queue)            runs physicsUpdate / createPhysicsUpdate closure
  InterpolationSystem                          preRun: builds CollisionBroadphase (flatbush R-tree)
    (per-frame lerp for render)                per entity: accelerate → sweep → move → bounce/onCollision
                                               writes transform/interpolation into shared memory
  reads transform off shared block ◄───────────────────────────────┘  (no copy travels back)
```

## File map (`src/`)

| File | Responsibility | Key exports |
| --- | --- | --- |
| `index.ts` | Public barrel — the entire published surface. | (re-exports everything below) |
| `components/registry.ts` | `physicsRegistry` map + the component-map type slices systems are generic over. | `physicsRegistry`, `PhysicsComponents`, `PhysicsUpdateComponents`, `InterpolationComponents`, `InterpolationUpdateComponents` |
| `components/transform-component.ts` | Where/how big/facing. `x,y` = **centre**; `angle` radians CCW. | `transformDefinition`, `TRANSFORM_*_INDEX`, `TRANSFORM_SIZE` |
| `components/velocity-component.ts` | World units per **second**. Keyed `velocityX/Y` in configs. | `velocityDefinition`, `VELOCITY_*_INDEX` |
| `components/dynamics-component.ts` | Persistent acceleration + inverse mass. Acceleration, queued forces, and queued impulses are integrated on the physics backend. | `dynamicsDefinition`, `DYNAMICS_*_INDEX` |
| `components/body-component.ts` | Shape + collide category/mask + sensor + continuous-collision flag, plus a runtime-only `dying` bit. A body is what makes an entity collidable. Shape/sensor/ccd/dying share one packed flags word (`BODY_FLAGS_INDEX`), read via `bodyShape`/`isSensor`/`isContinuous`/`isDying`. | `bodyDefinition`, `canCollide`, `isSensor`, `isContinuous`, `isDying`, `markDying`, `bodyShape`, `SHAPE_*`, `BODY_*` |
| `components/polygon-component.ts` | Fixed-capacity sidecar block for convex polygon vertices. Validates 3-16 boundary vertices and stores them normalized around their source bounds, so transform size scales the outline. Only polygon entities allocate it. | `polygonDefinition`, `preparePolygon`, `MAX_POLYGON_VERTICES`, `POLYGON_*` |
| `components/bounciness-component.ts` | Standalone bounce float (not part of body block). | `bouncinessDefinition`, `BOUNCINESS_INDEX` |
| `components/interpolation-component.ts` | Render position + publication protocol fields (`prev`, `progress`, `tick`, `duration`), exposed on the block so a spawn can seed a first segment by hand. | `interpolationDefinition`, `snapEntity`, `startSpawnInterpolation`, `INTERPOLATION_*_INDEX` |
| `systems/physics-system.ts` | Main-thread `EntityWorkerSystem`: gathers entities, snapshots one-run force/impulse/velocity commands, decides which queries/blocks travel, stamps `tick`, and gates move-reporting. Fixed step default. `startInterpolation(entity)` seeds a just-spawned mover so it is drawn moving now (feeds its step + accumulator to `startSpawnInterpolation`). | `PhysicsSystem`, `DEFAULT_PHYSICS_STEP_MS`, `PhysicsSystemConfig`, `VelocityAssignment` |
| `systems/physics-update.ts` | The per-entity update run on either backend. `physicsUpdate` = movement only; `createPhysicsUpdate` = sweeping + native bounce + `onCollision`. Owns interpolation publication, the atomic move, and the callback command queue retained by each backend. `world.dieAtImpact` (set per run in `preRun`) is the death-interpolation entry a callback calls instead of `entityDied`. | `physicsUpdate`, `createPhysicsUpdate`, `POSITION_UPDATED_EVENT`, `PhysicsWorld`, `PhysicsCallbackWorld`, `DeathInterpolationEntity` |
| `systems/dynamics.ts` | Shared semi-implicit Euler step, command accumulation/combination, and sorted per-run lookup used by both library movement paths before they calculate displacement. System transport is a flat `Float64Array`; custom worlds and combined callback commands use records. | `integrateDynamics`, `DynamicsCommand`, `DynamicsCommandBuffer`, `DynamicsCommandQueue`, `DynamicsWorld` |
| `systems/collision.ts` | Broadphase (flatbush R-tree bucketed by collide category) + narrowphase sweep/overlap. `contactPoint` and `contactNormal` report first-touch geometry, including for swept sensors. | `CollisionBroadphase`, `COLLIDABLE_QUERY`, `CollisionContact`, `MoveResult`, `SweepResult` |
| `systems/bounce.ts` | Native velocity response at solid contacts: reflect entities with bounciness and optionally stop non-bouncing entities along the contact normal. Applied to both sides of a contact. | `bouncePair`, `bounce` (internal) |
| `systems/spatial-index.ts` | Same R-tree without collide categories — targeting / range / nearest queries. Snapshot per run. | `SpatialIndex`, `SpatialFilter` |
| `systems/spatial-bounds.ts` | Converts transform/body shapes to the axis-aligned bounds stored in the live spatial map. | `spatialBounds` (internal) |
| `world.ts` | `BaseWorld` subclass that owns the live `SharedSpatialMap`, tracks entity/component lifecycle, exposes entity-level searches, and supplies map handles to worker worlds. | `PhysicalWorld`, `addPhysicalWorldData`, `getSpatialMap` |
| `systems/interpolation-system.ts` | Main-thread system that runs the per-frame render-position lerp. | `InterpolationSystem`, `InterpolationSystemConfig` |
| `systems/interpolation-update.ts` | The lerp itself (`render = prev + (current-prev)*alpha`), runnable in a worker too. | `interpolationUpdate` |
| `math/shapes.ts` | Primitive-shape overlap, contact direction + distance functions. Rectangle/circle/capsule remain an oriented core grown by a radius. | `shapesOverlap`, `contactNormal`, `orientedBoxesOverlap`, `segment*DistanceSquared`, `shapeHalfWidth/Height`, `shapeRadius`, `Vector` |
| `math/polygons.ts` | Convex SAT used only when at least one side is a polygon; projects the other polygon or primitive analytically and supplies the matching contact normal. | `polygonShapesOverlap`, `polygonContactNormal` |

Tests sit in `__tests__/` next to what they cover; shared worker/world fixtures live in
`src/__tests__/fixtures/`. `examples/` is a Phaser-rendered playground (Phaser is a dev dep only). Its shared
renderer supports optional stick-figure, coin, and enemy appearances while collision geometry remains an
ordinary physics body; the platformer example demonstrates gravity, jumping, patrols, sensors, and game events.

The platformer demonstrates dynamics from both threads: persistent acceleration supplies gravity, a main-thread
velocity command supplies jumping, and its worker-safe collision callback queues knockback. Its update opts into
`stopVelocityOnContact`, so floors, ceilings, walls, and slopes settle velocity without callback code.

## Invariants & gotchas (the non-obvious rules)

- **Polygon bodies are convex and capped at 16 vertices.** `vertices` loads a separate fixed-size polygon block,
  so primitive bodies pay no vertex storage. Loading recentres and normalizes the outline to its source bounds;
  the transform's width/height scale it thereafter. Primitive pairs stay on `math/shapes.ts`; only a pair with
  `SHAPE_POLYGON` enters `math/polygons.ts`. Concave outlines must be split into convex bodies.
- **Fixed 50ms step by default** (`DEFAULT_PHYSICS_STEP_MS`). A move is swept where it *ends*, so a
  step longer than an obstacle is thick lets a fast entity tunnel through it. `deltaBetweenRuns: 0`
  = every frame. (README → "The step")
- **Continuous collision detection is a per-body opt-out of that ceiling** (`continuousCollisionDetection`
  on the body block, the `BODY_CCD_FLAG` bit of the packed flags word). It swaps the single end-of-move test for a swept-path test - one extra
  covering-shape overlap per candidate, gated on `searcher.ccd` so no non-ccd body pays anything. It touches
  three places in `collision.ts`: `gatherContinuousCandidates` + `sweepContinuous`/`entryFraction` (blocking,
  first-contact rather than rest-against, so it handles a pass-through refine cannot), the swept branch of
  `forEachOverlapping` (detection - this is what catches a fast *sensor*, since a sensor is never gathered as a
  blocker), and the free `sweptOverlaps`. A continuous body never corner-slides. `forEachOverlapping` runs after
  the move, so it takes the just-applied delta as trailing args to reconstruct the path; `sweep`/`resolveMove`
  run before the move, so `searcher.x/y` is already the start.
- **The `tick` publication protocol.** Interpolation reads `prev`/transform across a release-store
  `tick` (written last via `storeFloat32`) and drops the frame if it changed mid-read. A subclass
  overriding `addDataToWorld` **must call `super.addDataToWorld(world)`** or nothing gets a tick and
  interpolation stops noticing steps.
- **Moves use `addAtomicFloat32`, not `+=`.** The transform is shared memory another thread may add
  to in the same instant; a plain read-modify-write would drop a move.
- **Dynamics is integrated before movement.** Both library update paths use semi-implicit Euler, so persistent
  acceleration and queued force change this step's velocity before displacement, followed by the queued impulse.
  The collision broadphase grows moving entries by the larger of their starting and resulting velocities;
  otherwise two command-driven movers could leave the boxes indexed for their old velocities and never become
  candidates.
- **Dynamics commands cross at the run boundary.** `PhysicsSystem.addDataToWorld` swaps out the pending map and
  sends an entity-id-sorted flat `Float64Array`, avoiding record-by-record structured cloning. Commands queued
  after that swap target the next run. Every snapshot is consumed once, including entries whose entity is absent
  from the mover query; an entity without `dynamics` uses inverse mass `1`. Force and impulse are integrated first;
  queued velocity axes then replace the result before movement, with the last assignment per axis winning.
- **Collision callback commands are next-run commands.** Each `PhysicsSystem` stamps a private queue id into its run
  data. The update function retains commands by that id inside the active backend, then `preRun` combines the
  previous callback's commands with commands received from `PhysicsSystem` and installs
  `queueForce`/`queueImpulse`/`queueVelocity` for the current callback to refill the queue. This cannot depend on the
  ECS update `init` hook: a fresh world initializes systems without running the separate load phase. Deferring makes
  behavior independent of update order. Forces and impulses sum; a main-thread velocity assignment is causally
  newer and replaces a callback assignment per named axis.
- **Flatbush remains the hot path.** `CollisionBroadphase` and `SpatialIndex` are packed snapshots for many
  queries in one run. `PhysicalWorld.spatialMap` is updated after each finalized physics move so clients and
  low-query workers always have an index without rebuilding Flatbush. A custom update that changes a transform
  after the library physics call must use `updateSpatialMap`; a main-thread edit uses `updateSpatialEntity`.
- **`POSITION_UPDATED_EVENT` carries only ids**, as one array per run (never per entity — that's the
  whole point). The worker only pays for it when someone is listening (`reportMoves`).
- **`filter` vs `scope` on `PhysicsSystem`.** Both are query filters the ECS applies at gather time
  (`EntityWorkerSystemQuery.filter`), but they sit on different queries. `filter` narrows only the mover
  query, so a shard steps a subset while still sweeping the whole world. `scope` is applied to the
  mover query *and* the `COLLIDABLE_QUERY`, so a scoped-out body never enters the broadphase — that is
  what isolates overlapping groups (solar systems). Given both, a mover must pass each; the collidable
  set is scoped but never sharded. No collision.ts change: the broadphase indexes whatever it's handed.
- **A contact is resolved once per pair per run.** Both sides find it — one sweeping into it, the
  other overlapping it on its own turn — and `CollisionBroadphase.claimContact` gives it to whichever
  looked first; the second side's turn is a no-op. So `onCollision` fires **once**, and a callback
  must act on *both* `self` and `other`: the other side gets no call of its own. Which one is `self`
  follows update order. Filtering is symmetric. The claim set lives on the broadphase because that is
  what a run is scoped to — `preRun` builds a new one, so nothing has to be cleared.
- **Callback normals are oriented from `other` to `self`.** `CollisionContact.normalX/Y` is evaluated at first
  touch and uses the same primitive/polygon geometry as bounce. Negate it for the other side. Continuous sensors
  that finish beyond a target are evaluated at their swept entry point; exact coincident centres report `(0, 0)`.
- **The native bounce turns both sides around** in that one resolution, each by its own bounciness,
  because the sweep leaves the pair *touching* rather than overlapping — the entity that was run into
  would never find the contact on its own turn, and one that died mid-run is filtered out of the tree
  before it could. A mover with no bounciness therefore still runs the overlap pass when *anything*
  in the run is bouncy (`CollisionBroadphase.hasBounciness`). The bounce is a reflection, not an
  impulse: a still entity has no velocity into the surface, so nothing is transferred to it.
- **`stopVelocityOnContact` is opt-in and subordinate to bounciness.** With it enabled on
  `createPhysicsUpdate`, each non-bouncy side of a solid contact loses only the velocity component pointing into
  the shape-accurate normal. The default remains sweep-only velocity behavior; sensors never receive a solid
  response, and entities carrying bounciness keep their existing restitution response.
- **Self is not re-checked for death between contacts.** The `DEAD_INDEX` guard runs once at the top
  of the update, and `forEachCandidate` filters dead *others*. An entity that wedges between two
  things in one run and dies on the first still resolves the second.
- **A moving spawn is drawn frozen until its first step, unless seeded — and seeding opens at the spawn and jumps
  the transform forward.** Interpolation only blends between two positions the simulation produced, and a fresh
  entity has just the one, so it holds at its spawn point (up to a whole step) before the first run gives it a
  second. `startSpawnInterpolation` (via `PhysicsSystem#startInterpolation`) instead **opens the render at the spawn
  point** and moves it out along the velocity at true speed, **jumping the transform forward** to where that motion
  reaches by the time the first real step lands (whatever is left of the step, `1 - accumulator/step`), so the
  seeded segment hands straight over with no seam. The jump is a real move applied **without a collision sweep**:
  the entity skips forward up to a step (so it can *tunnel* through anything within that span of the spawn) and runs
  that far ahead of its velocity for the rest of its life. That is a deliberate trade for **spawned projectiles** —
  a shot fired into a target still lands inside it and is killed by the next run's overlap test; only something thin
  enough to sit entirely within that jumped span is passed through uncaught. Do not use it where a step of collision
  must not be skipped. The transform is jumped to the segment's end, so the render is still never drawn ahead of the
  simulation. The protocol fields (`progress`/`duration`/`syncedTick`/`tick`) are exposed on the interpolation
  block's wrapper for exactly this; `tick` round-trips through the release-store.
- **Death interpolation is the spawn seeding run backwards, and defers the kill by a step.** A callback that
  calls `world.dieAtImpact(dying, other)` instead of `callbacks.entityDied` retargets the dying entity's current
  interpolation segment to end on the point it struck (`CollisionBroadphase.contactPoint`, the entry fraction the
  CCD blocker path already refines) and sets the runtime-only `BODY_DYING_FLAG`. Nothing is removed on the spot;
  the entity is killed at the top of its **next** update, which is the one extra step the render needs to play the
  final stride onto the impact - otherwise a fast continuous mover, whose render lags a step and whose swept kill
  can fire a stride early, blinks out well short of what it hit. A dying body is filtered out of the broadphase
  (`forEachCandidate`), the same as a dead one, so it is never run into again on this run or the next. Gameplay
  events (a hit, a score) still fire immediately in the callback; only the visual removal waits. The flag is set
  in shared memory, not the update closure, so any worker stepping the entity sees it and it survives to the next
  run.
- **Render position (`interpolation`) is read-only for rendering.** Anything deterministic (AI,
  targeting, saves) must read `transform`; the render position depends on local frame timing.
- **Only capsules must name their `shape`**; circle vs rectangle is inferred from `radius` vs
  `width/height`. Touching exactly = not overlapping; zero-area = never overlaps.
- **The bounce normal comes off the same geometry detection used** (`contactNormal`), not off the
  bounding boxes: boxes part along the shallowest of their own four face directions, rounds along the
  gap between their cores. A bounding-box normal is only ever one of the world axes, so a pair meeting
  at an angle reflected the wrong component of its velocity - or, when nothing pointed along that axis,
  the `into >= 0` guard skipped the bounce and the mover carried straight on through.

## Thread / dependency notes

- `@daneren2005/shared-memory-ecs` (1.5.1+) and `-objects` are **peer deps** — a game must register these
  components against the same ECS copy it builds its world with.
- `flatbush` is a real runtime dependency (the R-tree).
- Never use barrel imports from the ECS/objects packages internally — import from the deep path
  (e.g. `.../utils/atomic-math`) for tree-shaking. See recent commit history.

## Dev workflow

```sh
npm run type-check   # tsc --noEmit — run after every edit
npm run lint         # oxlint (NODE_ENV=production)
npm test             # vitest run
npm run benchmark    # dynamics hot-path and command-transport microbenchmarks
npm run build        # dist/ (js + d.ts)
npm start            # examples playground on http://127.0.0.1:8080
```

- After editing the **ECS** copy in `node_modules`, rebuild + copy its dist (see memory:
  ECS local dev workflow). The **game** consumes a published physics copy the same way — use
  `npm run build:game` to build and copy dist into the game's `node_modules`.
- Constraints (from AGENTS.md): no `any`, no `@ts-nocheck`, comments concise and rare, do not run
  git commands, do not modify `NOTES.md`.
