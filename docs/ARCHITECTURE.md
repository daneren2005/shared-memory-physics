# Architecture Map

Internal orientation doc. Read this before exploring the source — it exists so an agent (or a
new contributor) can jump straight to the right file instead of re-deriving the layout. Keep it
current: see the rule in [AGENTS.md](../AGENTS.md).

For **public API and behaviour** (what each component means, collision semantics, interpolation
trade-offs, examples), the [README](../README.md) is the source of truth — this doc points at its
sections rather than repeating them. For the **roadmap / scratch notes**, see `NOTES.md` (do not edit).

## Mental model

A 2D physics layer built on `@daneren2005/shared-memory-ecs`. All state lives in the ECS's
`SharedArrayBuffer` component blocks, so the simulation can run on a **worker thread** while the
main thread reads positions straight off its entities with no message-passing per entity.

The two library-supplied ECS `System`s (`PhysicsSystem`, `InterpolationSystem`) run on the main
thread and orchestrate; the actual per-entity work is an **update function** (`physicsUpdate` /
the closure from `createPhysicsUpdate`) that runs identically in-process or in a worker. The same
update module is imported by both the main thread and the game's worker entry file, so the two
backends never drift.

```
main thread                              worker thread (optional)
  PhysicsSystem ── posts entity blocks ──► ComponentWorker
    (gathers query, stamps tick)             runs physicsUpdate / createPhysicsUpdate closure
  InterpolationSystem                          preRun: builds CollisionBroadphase (flatbush R-tree)
    (per-frame lerp for render)                per entity: sweep → move → bounce/onCollision
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
| `components/body-component.ts` | Shape + collide category/mask + sensor + continuous-collision flag, plus a runtime-only `dying` bit. A body is what makes an entity collidable. Shape/sensor/ccd/dying share one packed flags word (`BODY_FLAGS_INDEX`), read via `bodyShape`/`isSensor`/`isContinuous`/`isDying`. | `bodyDefinition`, `canCollide`, `isSensor`, `isContinuous`, `isDying`, `markDying`, `bodyShape`, `SHAPE_*`, `BODY_*` |
| `components/bounciness-component.ts` | Standalone bounce float (not part of body block). | `bouncinessDefinition`, `BOUNCINESS_INDEX` |
| `components/interpolation-component.ts` | Render position + publication protocol fields (`prev`, `progress`, `tick`, `duration`), exposed on the block so a spawn can seed a first segment by hand. | `interpolationDefinition`, `snapEntity`, `startSpawnInterpolation`, `INTERPOLATION_*_INDEX` |
| `systems/physics-system.ts` | Main-thread `ComponentSystem`: gathers entities, decides which queries/blocks travel, stamps `tick`, gates move-reporting. Fixed step default. `startInterpolation(entity)` seeds a just-spawned mover so it is drawn moving now (feeds its step + accumulator to `startSpawnInterpolation`). | `PhysicsSystem`, `DEFAULT_PHYSICS_STEP_MS`, `PhysicsSystemConfig` |
| `systems/physics-update.ts` | The per-entity update run on either backend. `physicsUpdate` = movement only; `createPhysicsUpdate` = sweeping + native bounce + `onCollision`. Owns the interpolation publish protocol and the atomic move. `world.dieAtImpact` (set per run in `preRun`) is the death-interpolation entry a callback calls instead of `entityDied`. | `physicsUpdate`, `createPhysicsUpdate`, `POSITION_UPDATED_EVENT`, `PhysicsWorld`, `DeathInterpolationEntity` |
| `systems/collision.ts` | Broadphase (flatbush R-tree bucketed by collide category) + narrowphase sweep/overlap. `contactPoint` reports where a mover first touched a target, for death interpolation. | `CollisionBroadphase`, `COLLIDABLE_QUERY`, `MoveResult`, `SweepResult` |
| `systems/bounce.ts` | Native reflect-off-contact used by the sweep when an entity has bounciness. Applied to both sides of a contact. | `bouncePair`, `bounce` (internal) |
| `systems/spatial-index.ts` | Same R-tree without collide categories — targeting / range / nearest queries. Snapshot per run. | `SpatialIndex`, `SpatialFilter` |
| `systems/interpolation-system.ts` | Main-thread system that runs the per-frame render-position lerp. | `InterpolationSystem`, `InterpolationSystemConfig` |
| `systems/interpolation-update.ts` | The lerp itself (`render = prev + (current-prev)*alpha`), runnable in a worker too. | `interpolationUpdate` |
| `math/shapes.ts` | Shape overlap, contact direction + distance primitives. All 3 shapes = an oriented core grown by a radius. | `shapesOverlap`, `contactNormal`, `orientedBoxesOverlap`, `segment*DistanceSquared`, `shapeHalfWidth/Height`, `shapeRadius`, `Vector` |

Tests sit in `__tests__/` next to what they cover; shared worker/world fixtures live in
`src/__tests__/fixtures/`. `examples/` is a Phaser-rendered playground (Phaser is a dev dep only).

## Invariants & gotchas (the non-obvious rules)

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
- **`POSITION_UPDATED_EVENT` carries only ids**, as one array per run (never per entity — that's the
  whole point). The worker only pays for it when someone is listening (`reportMoves`).
- **`filter` vs `scope` on `PhysicsSystem`.** Both are query filters the ECS applies at gather time
  (`ComponentSystemQuery.filter`), but they sit on different queries. `filter` narrows only the mover
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
- **The native bounce turns both sides around** in that one resolution, each by its own bounciness,
  because the sweep leaves the pair *touching* rather than overlapping — the entity that was run into
  would never find the contact on its own turn, and one that died mid-run is filtered out of the tree
  before it could. A mover with no bounciness therefore still runs the overlap pass when *anything*
  in the run is bouncy (`CollisionBroadphase.hasBounciness`). The bounce is a reflection, not an
  impulse: a still entity has no velocity into the surface, so nothing is transferred to it.
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

- `@daneren2005/shared-memory-ecs` and `-objects` are **peer deps** — a game must register these
  components against the same ECS copy it builds its world with.
- `flatbush` is a real runtime dependency (the R-tree).
- Never use barrel imports from the ECS/objects packages internally — import from the deep path
  (e.g. `.../utils/atomic-math`) for tree-shaking. See recent commit history.

## Dev workflow

```sh
npm run type-check   # tsc --noEmit — run after every edit
npm run lint         # oxlint (NODE_ENV=production)
npm test             # vitest run
npm run build        # dist/ (js + d.ts)
npm start            # examples playground on http://127.0.0.1:8080
```

- After editing the **ECS** copy in `node_modules`, rebuild + copy its dist (see memory:
  ECS local dev workflow). The **game** consumes a published physics copy the same way — use
  `npm run build:game` to build and copy dist into the game's `node_modules`.
- Constraints (from AGENTS.md): no `any`, no `@ts-nocheck`, comments concise and rare, do not run
  git commands, do not modify `NOTES.md`.
