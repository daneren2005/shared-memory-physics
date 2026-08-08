import PhysicsSystem, { type PhysicsSystemConfig } from '../physics-system';
import { POSITION_UPDATED_EVENT, type PhysicsWorld } from '../physics-update';
import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import { createTestWorld, type Components, type Config, type TestWorld } from '../../__tests__/fixtures/world';
import { SHAPE_CAPSULE } from '../../components/body-component';
import collisionUpdate, { type CollisionUpdateComponents, OTHER_DAMAGE, SELF_DAMAGE } from '../../__tests__/fixtures/collision-update';

// Worker entry points loaded by @vitest/web-worker for the 'worker' mode below.
const PHYSICS_WORKER_URL = new URL('../../__tests__/fixtures/physics.worker.ts', import.meta.url);
const COLLISION_WORKER_URL = new URL('../../__tests__/fixtures/collision.worker.ts', import.meta.url);

// One second, in the ms elapsedTime uses, so an entity at `velocity` units/s travels `velocity` units per run.
const ONE_SECOND = 1000;

// Waits a macrotask for a worker-mode run to land; a noop wait in main-thread mode.
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

// Entity selection and config, which do not depend on the backend, so these stay in-process.
describe('physics-system', () => {
	let world: TestWorld;
	let system: PhysicsSystem<Components>;
	beforeEach(() => {
		world = createTestWorld();
		system = new PhysicsSystem(world);
		world.addSystem(system);
	});
	afterEach(() => {
		system.destroy();
	});

	it('falls back to the main thread when no worker was supplied', () => {
		expect(system.isWorkerThread).toEqual(false);
	});

	it('only includes entities with both a transform and a velocity', () => {
		let moving = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, velocityX: 1, velocityY: 1 });
		let noVelocity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1 });
		let noTransform = world.loadEntity({ velocityX: 1, velocityY: 1 });

		expect(Array.from(system.entities.values(), entity => entity.eid)).toEqual([moving.eid]);
		expect(system.isEntityInSystem(noVelocity)).toEqual(false);
		expect(system.isEntityInSystem(noTransform)).toEqual(false);
	});

	it('picks up an entity once a velocity is added to it', () => {
		let entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1 });
		expect(system.isEntityInSystem(entity)).toEqual(false);

		entity.loadComponent('velocity', { velocityX: 1, velocityY: 1 });
		expect(system.isEntityInSystem(entity)).toEqual(true);

		entity.removeComponent('velocity');
		expect(system.isEntityInSystem(entity)).toEqual(false);
	});
});

// Movement runs against both backends, which must produce identical results: 'main-thread' in-process, 'worker'
// a real worker module.
type Mode = 'main-thread' | 'worker';
const MODES: Array<Mode> = ['main-thread', 'worker'];

describe.each(MODES)('physics-system velocity movement (%s)', (mode) => {
	let world: TestWorld;
	let system: PhysicsSystem<Components>;
	beforeEach(async () => {
		world = createTestWorld();
		system = new PhysicsSystem(world, {
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(PHYSICS_WORKER_URL, { type: 'module' }),
		});
		world.addSystem(system);

		// Wait for the worker to load, so it is never torn down mid-import.
		await system.init();
	});
	afterEach(() => {
		system.destroy();
	});

	// Every entity gets a size, which is what gives it a transform.
	function createEntity(config: Config): BaseEntity<Components, Config> {
		return world.loadEntity({ width: 1, height: 1, ...config });
	}
	async function run(elapsedTime: number): Promise<void> {
		system.run(elapsedTime);
		await flush();
	}

	// Guards the parameterization: a worker silently falling back to the main thread would still pass every test.
	it('uses the backend the mode asked for', () => {
		expect(system.isWorkerThread).toEqual(mode === 'worker');
	});

	it('moves an entity along both axes', async () => {
		let entity = createEntity({ x: 10, y: 20, velocityX: 3, velocityY: -4 });

		await run(ONE_SECOND);

		expect(entity.components.transform?.x).toEqual(13);
		expect(entity.components.transform?.y).toEqual(16);
	});

	it('scales movement by the elapsed time of the run', async () => {
		let entity = createEntity({ x: 0, y: 0, velocityX: 8, velocityY: 4 });

		// A quarter-second run moves a quarter of the per-second velocity.
		await run(ONE_SECOND / 4);

		expect(entity.components.transform?.x).toEqual(2);
		expect(entity.components.transform?.y).toEqual(1);
	});

	it('accumulates movement across repeated runs', async () => {
		let entity = createEntity({ x: 0, y: 0, velocityX: 5, velocityY: 10 });

		await run(ONE_SECOND);
		await run(ONE_SECOND);
		await run(ONE_SECOND);

		// In worker mode later runs only send the id and rely on the cached block, so a correct total proves that too.
		expect(entity.components.transform?.x).toEqual(15);
		expect(entity.components.transform?.y).toEqual(30);
	});

	it('leaves an entity with zero velocity where it is', async () => {
		let entity = createEntity({ x: 7, y: 9, velocityX: 0, velocityY: 0 });

		await run(ONE_SECOND);

		expect(entity.components.transform?.x).toEqual(7);
		expect(entity.components.transform?.y).toEqual(9);
	});

	it('moves each entity by its own velocity', async () => {
		let fast = createEntity({ x: 0, y: 0, velocityX: 10, velocityY: 0 });
		let slow = createEntity({ x: 0, y: 0, velocityX: 1, velocityY: 0 });
		let still = createEntity({ x: 100, y: 100, tag: 1 });

		await run(ONE_SECOND);

		expect(fast.components.transform?.x).toEqual(10);
		expect(slow.components.transform?.x).toEqual(1);
		// No velocity, so not in the system and never moved.
		expect(still.components.transform?.x).toEqual(100);
		expect(still.components.transform?.y).toEqual(100);
	});

	it('follows a velocity changed after the entity was created', async () => {
		let entity = createEntity({ x: 0, y: 0, velocityX: 1, velocityY: 0 });

		await run(ONE_SECOND);
		expect(entity.components.transform?.x).toEqual(1);

		// The velocity block is shared memory, so a main-thread write is picked up by the next run.
		entity.components.velocity!.velocityX = -2;
		await run(ONE_SECOND);

		expect(entity.components.transform?.x).toEqual(-1);
	});

	it('stops moving an entity once it leaves the system', async () => {
		let entity = createEntity({ x: 0, y: 0, velocityX: 4, velocityY: 0 });

		await run(ONE_SECOND);
		expect(entity.components.transform?.x).toEqual(4);

		entity.removeComponent('velocity');
		await run(ONE_SECOND);

		expect(entity.components.transform?.x).toEqual(4);
	});

	it('moves entities when driven through the world update loop', async () => {
		let entity = createEntity({ x: 0, y: 0, velocityX: 2, velocityY: 3 });

		world.update(ONE_SECOND);
		await flush();

		expect(entity.components.transform?.x).toEqual(2);
		expect(entity.components.transform?.y).toEqual(3);
	});
});

function noop(): void {}

// What a system would tell this run's update about reporting, the only place the answer exists.
function reportsMoves(system: PhysicsSystem<Components, CollisionUpdateComponents>): boolean | undefined {
	const world: PhysicsWorld = { gameTime: 0, elapsedTime: 1000, tick: 0 };
	system.addDataToWorld(world);

	return world.reportMoves;
}

// How a collision-detecting system is set up; backend-independent, so in-process.
describe('physics-system collision setup', () => {
	let world: TestWorld;
	let systems: Array<PhysicsSystem<Components, CollisionUpdateComponents>> = [];
	function createSystem(options: PhysicsSystemConfig<Components, CollisionUpdateComponents> = {}) {
		const system = new PhysicsSystem<Components, CollisionUpdateComponents>(world, options);
		systems.push(system);
		world.addSystem(system);

		return system;
	}
	beforeEach(() => {
		world = createTestWorld();
		systems = [];
	});
	afterEach(() => {
		systems.forEach(system => system.destroy());
	});

	it('gathers no collidable query for a system that only moves things', () => {
		expect(createSystem().options.queries).toBeUndefined();
	});

	it('takes the collidable query and extra components from the update function', () => {
		// createPhysicsUpdate stamps both on, so a game declares them once in the shared module.
		const system = createSystem({ updateFunction: collisionUpdate });

		// body/bounciness/interpolation/entity all travel with movers on the collision path - see PhysicsSystem.
		expect(system.options.optional).toEqual(['body', 'bounciness', 'interpolation', 'entity', 'health']);
		expect(system.options.queries?.collidable).toEqual({
			required: ['transform', 'body'],
			optional: ['velocity', 'entity', 'health'],
		});
	});

	it('leaves the body out of a system that only moves things', () => {
		// Nothing reads a category. Interpolation stays, since publishing a step is not turned on by collision.
		expect(createSystem({ optional: ['health'] }).options.optional).toEqual(['interpolation', 'health']);
	});

	// Reporting moves costs per worker run, so it is decided per run off whether anything is listening.
	describe('reporting moves', () => {
		it('says nothing when nothing is listening', () => {
			expect(reportsMoves(createSystem())).toEqual(false);
		});

		it('starts reporting as soon as something listens', () => {
			const system = createSystem();
			system.on(POSITION_UPDATED_EVENT, noop);

			expect(reportsMoves(system)).toEqual(true);
		});

		it('stops again when the listener goes away', () => {
			// Asked per run, so a scene that tears its listener down stops paying for it.
			const system = createSystem();
			system.on(POSITION_UPDATED_EVENT, noop);
			system.off(POSITION_UPDATED_EVENT, noop);

			expect(reportsMoves(system)).toEqual(false);
		});

		it('can be forced either way', () => {
			// For a listener this system cannot see, and for turning it off regardless.
			expect(reportsMoves(createSystem({ reportMoves: true }))).toEqual(true);

			const silenced = createSystem({ reportMoves: false });
			silenced.on(POSITION_UPDATED_EVENT, noop);
			expect(reportsMoves(silenced)).toEqual(false);
		});
	});

	it('collides with entities the system does not move', () => {
		// The collidable query is everything with a transform, so a velocity-less station is still collidable.
		const system = createSystem({ updateFunction: collisionUpdate });
		const moving = world.loadEntity({ x: 0, y: 0, width: 10, height: 10, velocityX: 1, velocityY: 0, health: 3 });
		const still = world.loadEntity({ x: 100, y: 0, width: 10, height: 10, health: 3 });

		expect(Array.from(system.entities.values(), entity => entity.eid)).toEqual([moving.eid]);
		expect(system.isEntityInSystem(still)).toEqual(false);
		expect(system.options.queries?.collidable).toBeDefined();
	});
});

// Collisions run against both backends: the callback must behave identically in-process or in a real worker.
describe.each(MODES)('physics-system collisions (%s)', (mode) => {
	let world: TestWorld;
	let system: PhysicsSystem<Components, CollisionUpdateComponents>;
	beforeEach(async () => {
		world = createTestWorld();
		system = new PhysicsSystem<Components, CollisionUpdateComponents>(world, {
			updateFunction: collisionUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(COLLISION_WORKER_URL, { type: 'module' }),
		});
		world.addSystem(system);

		await system.init();
	});
	afterEach(() => {
		system.destroy();
	});

	// A 10x10 mover that can be hurt, with health high enough not to die by accident.
	const FULL_HEALTH = 10;
	function createShip(config: Config): BaseEntity<Components, Config> {
		return world.loadEntity({ width: 10, height: 10, velocityX: 0, velocityY: 0, health: FULL_HEALTH, ...config });
	}
	// No velocity, so never moved and only ever the `other` side of a collision.
	function createStation(config: Config): BaseEntity<Components, Config> {
		return world.loadEntity({ width: 10, height: 10, health: FULL_HEALTH, ...config });
	}
	async function run(elapsedTime: number): Promise<void> {
		system.run(elapsedTime);
		await flush();
	}

	it('runs the callback for an entity that has moved onto another', async () => {
		let first = createShip({ x: 0, y: 0 });
		let second = createShip({ x: 5, y: 0 });

		await run(ONE_SECOND);

		// Both moved, so both got their own call: self damage plus the other damage from the entity that hit them.
		expect(first.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
		expect(second.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
	});

	it('leaves entities that are not touching alone', async () => {
		let first = createShip({ x: 0, y: 0 });
		let second = createShip({ x: 100, y: 0 });

		await run(ONE_SECOND);

		expect(first.components.health?.health).toEqual(FULL_HEALTH);
		expect(second.components.health?.health).toEqual(FULL_HEALTH);
	});

	it('collides an entity with one that has no velocity of its own', async () => {
		let ship = createShip({ x: 0, y: 0 });
		let station = createStation({ x: 5, y: 0 });

		await run(ONE_SECOND);

		// Only the ship moved, so only its callback ran: self damage, and other damage into the station's block.
		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE);
		expect(station.components.health?.health).toEqual(FULL_HEALTH - OTHER_DAMAGE);
	});

	it('ignores an entity the game never gave a size', async () => {
		let sized = createShip({ x: 0, y: 0 });
		let unsized = createShip({ x: 0, y: 0, width: 0, height: 0 });

		await run(ONE_SECOND);

		expect(sized.components.health?.health).toEqual(FULL_HEALTH);
		expect(unsized.components.health?.health).toEqual(FULL_HEALTH);
	});

	// Sizes via radius, so it cannot go through createShip, whose width/height defaults would be refused.
	function createRound(config: Config): BaseEntity<Components, Config> {
		return world.loadEntity({ velocityX: 0, velocityY: 0, health: FULL_HEALTH, ...config });
	}

	it('collides two circles, and rounds off the corner a box would keep', async () => {
		// Offset further than two circles reach, though two boxes still would.
		let first = createRound({ x: 0, y: 0, radius: 5 });
		let second = createRound({ x: 8, y: 8, radius: 5 });

		await run(ONE_SECOND);

		expect(first.components.health?.health).toEqual(FULL_HEALTH);
		expect(second.components.health?.health).toEqual(FULL_HEALTH);

		// The same positions as boxes do collide, so the shape is doing the work, not the distance.
		let box = createShip({ x: 100, y: 100 });
		let other = createShip({ x: 108, y: 108 });
		await run(ONE_SECOND);

		expect(box.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(other.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('collides a capsule along its length', async () => {
		// 40 long, so its cap reaches x = 20 and just catches a ship whose edge is at 15.5.
		let capsule = createShip({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });
		let target = createShip({ x: 20.5, y: 0 });

		await run(ONE_SECOND);

		expect(capsule.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(target.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('does not collide a capsule with what is off its ends', async () => {
		let capsule = createShip({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });
		// Beyond the cap by more than the ship's half width.
		let target = createShip({ x: 40, y: 0 });

		await run(ONE_SECOND);

		expect(capsule.components.health?.health).toEqual(FULL_HEALTH);
		expect(target.components.health?.health).toEqual(FULL_HEALTH);
	});

	it('collides a circle with a capsule it has moved onto', async () => {
		let capsule = createShip({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });
		// Dropping onto the capsule's side from 20 up at 15/s.
		let circle = createRound({ x: 0, y: 20, radius: 1, velocityY: -15 });

		await run(ONE_SECOND);

		// Stopped on the surface, not the whole 15: 5 of thickness plus its own 1 of radius is as close as it gets.
		expect(circle.components.transform?.y).toBeCloseTo(6);
		expect(circle.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(capsule.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	// Categories are the game's to name; the library only ever reads them as bits.
	const GROUND = 1 << 0;
	const AIR = 1 << 1;
	const PROJECTILE = 1 << 2;
	const groundUnit = { collideCategory: GROUND, collideMask: GROUND | PROJECTILE };
	const airUnit = { collideCategory: AIR, collideMask: AIR | PROJECTILE };
	const rangedAttack = { collideCategory: PROJECTILE, collideMask: GROUND | AIR };

	it('does not collide entities their categories keep apart', async () => {
		// Right on top of each other, so only the categories keep them apart.
		let ground = createShip({ x: 0, y: 0, ...groundUnit });
		let air = createShip({ x: 5, y: 0, ...airUnit });

		await run(ONE_SECOND);

		expect(ground.components.health?.health).toEqual(FULL_HEALTH);
		expect(air.components.health?.health).toEqual(FULL_HEALTH);
	});

	it('collides a ranged attack with both a ground and an air unit', async () => {
		let attack = createShip({ x: 0, y: 0, ...rangedAttack });
		let ground = createShip({ x: 5, y: 0, ...groundUnit });
		let air = createShip({ x: 0, y: 5, ...airUnit });

		await run(ONE_SECOND);

		// The attack landed on both, taking self damage once for each.
		expect(attack.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE * 2 - OTHER_DAMAGE * 2);
		expect(ground.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
		expect(air.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
	});

	it('leaves an entity with a category of 0 out of collisions entirely', async () => {
		let ship = createShip({ x: 0, y: 0 });
		let ghost = createShip({ x: 5, y: 0, collideCategory: 0 });

		await run(ONE_SECOND);

		expect(ship.components.health?.health).toEqual(FULL_HEALTH);
		expect(ghost.components.health?.health).toEqual(FULL_HEALTH);
	});

	it('follows a category changed after the entity was created', async () => {
		// The body block is shared memory, so a unit that takes off is picked up by the next run.
		let ground = createShip({ x: 0, y: 0, ...groundUnit });
		let air = createShip({ x: 5, y: 0, ...airUnit });

		await run(ONE_SECOND);
		expect(ground.components.health?.health).toEqual(FULL_HEALTH);

		ground.components.body!.collideCategory = AIR;
		ground.components.body!.collideMask = AIR | PROJECTILE;
		await run(ONE_SECOND);

		expect(ground.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
		expect(air.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
	});

	it('takes the entity\'s rotation into account', async () => {
		let first = createShip({ x: 0, y: 0, width: 2, height: 10 });
		let second = createShip({ x: 5, y: 0, width: 2, height: 10 });

		await run(ONE_SECOND);
		expect(first.components.health?.health).toEqual(FULL_HEALTH);

		// Laid on its side, the second bar's long edge crosses the gap.
		second.components.transform!.angle = Math.PI / 2;
		await run(ONE_SECOND);

		expect(first.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
		expect(second.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
	});

	it('collides an entity in the same run its movement drove it in', async () => {
		// 20 apart, 10 wide each, closing at 6/s from both sides: they meet part way through this run.
		let first = createShip({ x: 0, y: 0, velocityX: 6 });
		let second = createShip({ x: 20, y: 0, velocityX: -6 });

		await run(ONE_SECOND);

		// Checked straight after each move, so this run reports it: the first gets its whole 6, the second stops
		// on its edge 4 into its own 6.
		expect(first.components.transform?.x).toEqual(6);
		expect(second.components.transform?.x).toBeCloseTo(16);
		expect(first.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(second.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('finds a pair the broadphase would lose without room for their velocity', async () => {
		// 80 apart, closing at 40/s: only the velocity room keeps the pair in the running.
		let first = createShip({ x: 0, y: 0, velocityX: 40 });
		let second = createShip({ x: 80, y: 0, velocityX: -40 });

		await run(ONE_SECOND);

		// The first has 30 of clear road when it moves, so takes its whole 40; the second runs into it there.
		expect(first.components.transform?.x).toEqual(40);
		expect(second.components.transform?.x).toBeCloseTo(50);
		expect(first.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(second.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('stops an entity on the edge of what it moves into rather than inside it', async () => {
		// 30 apart, 10 wide each, so edges meet at 20 - short of the 25 asked for.
		let ship = createShip({ x: 0, y: 0, velocityX: 25 });
		let station = createStation({ x: 30, y: 0 });

		await run(ONE_SECOND);

		expect(ship.components.transform?.x).toBeCloseTo(20, 3);
		// The callback still ran, even though the two are only touching.
		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE);
		expect(station.components.health?.health).toEqual(FULL_HEALTH - OTHER_DAMAGE);
	});

	it('does not stop inside the near entity because the far one collided first', async () => {
		// The far station is ahead of the near one in the query, so stopping at the first collision would rest at
		// 18, inside the near one.
		let far = createStation({ x: 28, y: 0 });
		let near = createStation({ x: 20, y: 0 });
		let ship = createShip({ x: 0, y: 0, velocityX: 25 });

		await run(ONE_SECOND);

		expect(ship.components.transform?.x).toBeCloseTo(10, 3);
		// Only the near one was reached.
		expect(near.components.health?.health).toEqual(FULL_HEALTH - OTHER_DAMAGE);
		expect(far.components.health?.health).toEqual(FULL_HEALTH);
		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE);
	});

	it('holds an entity against what it is up against run after run', async () => {
		// Closes the last 4 of the gap on the first run, touching at 20.
		let ship = createShip({ x: 16, y: 0, velocityX: 5 });
		createStation({ x: 30, y: 0 });

		await run(ONE_SECOND);
		const restingPlace = ship.components.transform?.x;
		expect(restingPlace).toBeCloseTo(20, 3);

		// Still pushing with nowhere to go: the position does not creep, and the collision keeps being reported.
		await run(ONE_SECOND);

		expect(ship.components.transform?.x).toEqual(restingPlace);
		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE * 2);
	});

	it('reports the entities that moved on the system, once for the run', async () => {
		let ship = createShip({ x: 0, y: 0, velocityX: 3, velocityY: -4 });
		let reported: Array<Array<number>> = [];
		system.on(POSITION_UPDATED_EVENT, (entityIds: Array<number>) => {
			reported.push(entityIds);
		});

		await run(ONE_SECOND);

		// One call for the run carrying the ids, not an event apiece.
		expect(reported).toEqual([[ship.eid]]);
		// No position came with the id: the transform is shared memory, readable off the entity when the event lands.
		expect(ship.components.transform?.x).toBeCloseTo(3, 3);
		expect(ship.components.transform?.y).toBeCloseTo(-4, 3);
	});

	it('does not report the move as component property changes as well', async () => {
		let ship = createShip({ x: 0, y: 0, velocityX: 3, velocityY: -4 });
		let reported: Array<string> = [];
		ship.on('component-property-updated', (componentName: string, prop: string) => {
			reported.push(`${componentName}.${prop}`);
		});

		await run(ONE_SECOND);

		expect(reported).toEqual([]);
	});

	it('reports the position it came to rest at, not the one it was heading for', async () => {
		let ship = createShip({ x: 0, y: 0, velocityX: 25 });
		createStation({ x: 30, y: 0 });
		// Where the ship stood each time its move was reported, read off the block like a listener does.
		let reported: Array<number> = [];
		system.on(POSITION_UPDATED_EVENT, (entityIds: Array<number>) => {
			expect(entityIds).toEqual([ship.eid]);
			reported.push(ship.components.transform!.x);
		});

		await run(ONE_SECOND);

		// One report: the block is only written once the sweep has settled where the entity may go.
		expect(reported).toHaveLength(1);
		expect(reported[0]).toBeCloseTo(20, 3);
	});

	it('keeps moving entities while it collides them', async () => {
		let first = createShip({ x: 0, y: 0, velocityX: 3 });
		let second = createShip({ x: 5, y: 0, velocityX: 3 });

		await run(ONE_SECOND);

		expect(first.components.transform?.x).toEqual(3);
		expect(second.components.transform?.x).toEqual(8);
		expect(first.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('reports a death the callback triggered back to the main thread', async () => {
		let ship = createShip({ x: 0, y: 0, health: SELF_DAMAGE });
		let station = createStation({ x: 5, y: 0 });
		let died: Array<number> = [];
		ship.on('death', () => died.push(ship.eid));
		station.on('death', () => died.push(station.eid));

		await run(ONE_SECOND);

		// The callback runs with only blocks in reach, so a death gets back to the main thread as an event.
		expect(died).toEqual([ship.eid]);
		expect(ship.components.health?.health).toEqual(0);
	});

	it('stops colliding an entity once it leaves the world', async () => {
		let ship = createShip({ x: 0, y: 0 });
		let station = createStation({ x: 5, y: 0 });

		await run(ONE_SECOND);
		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE);

		world.removeEntity(station);
		await run(ONE_SECOND);

		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE);
	});
});
