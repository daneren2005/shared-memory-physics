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
| `components/body-component.ts` | Shape + collide category/mask. A body is what makes an entity collidable. | `bodyDefinition`, `canCollide`, `isSensor`, `SHAPE_*`, `BODY_*_INDEX` |
| `components/bounciness-component.ts` | Standalone bounce float (not part of body block). | `bouncinessDefinition`, `BOUNCINESS_INDEX` |
| `components/interpolation-component.ts` | Render position + publication protocol fields (`prev`, `progress`, `tick`, `duration`). | `interpolationDefinition`, `snapEntity`, `INTERPOLATION_*_INDEX` |
| `systems/physics-system.ts` | Main-thread `ComponentSystem`: gathers entities, decides which queries/blocks travel, stamps `tick`, gates move-reporting. Fixed step default. | `PhysicsSystem`, `DEFAULT_PHYSICS_STEP_MS`, `PhysicsSystemConfig` |
| `systems/physics-update.ts` | The per-entity update run on either backend. `physicsUpdate` = movement only; `createPhysicsUpdate` = sweeping + native bounce + `onCollision`. Owns the interpolation publish protocol and the atomic move. | `physicsUpdate`, `createPhysicsUpdate`, `POSITION_UPDATED_EVENT`, `PhysicsWorld` |
| `systems/collision.ts` | Broadphase (flatbush R-tree bucketed by collide category) + narrowphase sweep/overlap. | `CollisionBroadphase`, `COLLIDABLE_QUERY`, `MoveResult`, `SweepResult` |
| `systems/bounce.ts` | Native reflect-off-contact used by the sweep when an entity has bounciness. | `bounce` (internal) |
| `systems/spatial-index.ts` | Same R-tree without collide categories — targeting / range / nearest queries. Snapshot per run. | `SpatialIndex`, `SpatialFilter` |
| `systems/interpolation-system.ts` | Main-thread system that runs the per-frame render-position lerp. | `InterpolationSystem`, `InterpolationSystemConfig` |
| `systems/interpolation-update.ts` | The lerp itself (`render = prev + (current-prev)*alpha`), runnable in a worker too. | `interpolationUpdate` |
| `math/shapes.ts` | Shape overlap + distance primitives. All 3 shapes = an oriented core grown by a radius. | `shapesOverlap`, `orientedBoxesOverlap`, `segment*DistanceSquared`, `shapeHalfWidth/Height`, `shapeRadius` |

Tests sit in `__tests__/` next to what they cover; shared worker/world fixtures live in
`src/__tests__/fixtures/`. `examples/` is a Phaser-rendered playground (Phaser is a dev dep only).

## Invariants & gotchas (the non-obvious rules)

- **Fixed 50ms step by default** (`DEFAULT_PHYSICS_STEP_MS`). A move is swept where it *ends*, so a
  step longer than an obstacle is thick lets a fast entity tunnel through it. `deltaBetweenRuns: 0`
  = every frame. (README → "The step")
- **The `tick` publication protocol.** Interpolation reads `prev`/transform across a release-store
  `tick` (written last via `storeFloat32`) and drops the frame if it changed mid-read. A subclass
  overriding `addDataToWorld` **must call `super.addDataToWorld(world)`** or nothing gets a tick and
  interpolation stops noticing steps.
- **Moves use `addAtomicFloat32`, not `+=`.** The transform is shared memory another thread may add
  to in the same instant; a plain read-modify-write would drop a move.
- **`POSITION_UPDATED_EVENT` carries only ids**, as one array per run (never per entity — that's the
  whole point). The worker only pays for it when someone is listening (`reportMoves`).
- **Collision is per moved entity, not per pair.** Callback fires for `self` (the mover), once per
  thing it landed on. Two movers colliding = one call each, roles swapped. Filtering is symmetric.
- **Render position (`interpolation`) is read-only for rendering.** Anything deterministic (AI,
  targeting, saves) must read `transform`; the render position depends on local frame timing.
- **Only capsules must name their `shape`**; circle vs rectangle is inferred from `radius` vs
  `width/height`. Touching exactly = not overlapping; zero-area = never overlaps.

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
