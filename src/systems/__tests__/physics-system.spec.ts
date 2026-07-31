import PhysicsSystem, { type PhysicsSystemConfig } from '../physics-system';
import { POSITION_UPDATED_EVENT } from '../physics-update';
import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import { createTestWorld, type Components, type Config, type TestWorld } from '../../__tests__/fixtures/world';
import { SHAPE_CAPSULE } from '../../components/body-component';
import collisionUpdate, { type CollisionUpdateComponents, OTHER_DAMAGE, SELF_DAMAGE } from '../../__tests__/fixtures/collision-update';

// Worker entry points loaded by @vitest/web-worker for the 'worker' mode below.
const PHYSICS_WORKER_URL = new URL('../../__tests__/fixtures/physics.worker.ts', import.meta.url);
const COLLISION_WORKER_URL = new URL('../../__tests__/fixtures/collision.worker.ts', import.meta.url);

// One second of simulation, in the milliseconds elapsedTime is measured in - so an entity moving at
// `velocity` units per second travels exactly `velocity` units per run.
const ONE_SECOND = 1000;

// Lets a worker-mode run() settle: postMessage to a real worker is async, so we wait a macrotask for the
// run-complete message to come back.  In main-thread mode the work is synchronous and this is a noop wait.
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

// Which entities the system picks up, and how it is configured - neither depends on where the update runs, so
// these stay on the in-process backend rather than spinning up a worker per test.
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
		// With nothing to run the update on there is no worker to ask for, so the system uses the in-process
		// ComponentWebWorker instead of trying to start one.
		expect(system.isWorkerThread).toEqual(false);
	});

	it('only includes entities with both a transform and a velocity', () => {
		let moving = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, velocityX: 1, velocityY: 1 });
		let noVelocity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1 });
		let noTransform = world.loadEntity({ velocityX: 1, velocityY: 1 });

		expect(system.entities.map(entity => entity.eid)).toEqual([moving.eid]);
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

// The movement itself runs against both backends: 'main-thread' uses the in-process ComponentWebWorker
// (forceMainThread), 'worker' uses a real worker module driven through createComponentWorker.  Both must
// produce identical movement.
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

		// Wait for the worker to finish loading before the test runs, so it is never torn down mid-import.
		await system.init();
	});
	afterEach(() => {
		// Terminate any real worker spun up during the test.
		system.destroy();
	});

	// A size is what gives an entity a transform at all, so every entity here gets one even though nothing in
	// this block collides.
	function createEntity(config: Config): BaseEntity<Components, Config> {
		return world.loadEntity({ width: 1, height: 1, ...config });
	}
	// Runs a single physics step covering `elapsedTime` ms and waits for it to land on the entity.
	async function run(elapsedTime: number): Promise<void> {
		system.run(elapsedTime);
		await flush();
	}

	// Guards the parameterization itself: if a real worker ever silently fell back to the main thread, every
	// test below would still pass while only covering one backend.
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

		// A quarter second run moves a quarter of the per-second velocity.
		await run(ONE_SECOND / 4);

		expect(entity.components.transform?.x).toEqual(2);
		expect(entity.components.transform?.y).toEqual(1);
	});

	it('accumulates movement across repeated runs', async () => {
		let entity = createEntity({ x: 0, y: 0, velocityX: 5, velocityY: 10 });

		await run(ONE_SECOND);
		await run(ONE_SECOND);
		await run(ONE_SECOND);

		// In worker mode the later runs only send the entity id and rely on the worker's cached
		// shared-memory block, so a correct total here proves that caching path works too.
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
		// No velocity, so it is not in the system at all and never moves.
		expect(still.components.transform?.x).toEqual(100);
		expect(still.components.transform?.y).toEqual(100);
	});

	it('follows a velocity changed after the entity was created', async () => {
		let entity = createEntity({ x: 0, y: 0, velocityX: 1, velocityY: 0 });

		await run(ONE_SECOND);
		expect(entity.components.transform?.x).toEqual(1);

		// The velocity block is shared memory, so writing it on the main thread is picked up by the next run
		// without re-sending anything to the worker.
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

// How a system is put together from an update function that detects collisions.  None of this depends on where
// the update runs, so it stays on the in-process backend.
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
		// createPhysicsUpdate stamps both onto the function, so a game declares them once in the module its
		// worker file and its system both import rather than repeating them here.
		const system = createSystem({ updateFunction: collisionUpdate });

		// The body joins what travels with the entities this system moves, because an entity reads its own
		// category and mask before it searches for what it hit.
		expect(system.options.optional).toEqual(['body', 'health']);
		expect(system.options.queries?.collidable).toEqual({
			required: ['transform', 'body'],
			optional: ['velocity', 'health'],
		});
	});

	it('leaves the body out of a system that only moves things', () => {
		// Nothing is going to read a category, so shipping a block per moving entity for it would be waste.
		expect(createSystem({ optional: ['health'] }).options.optional).toEqual(['health']);
	});

	it('collides with entities the system does not move', () => {
		// The collidable query is everything with a transform, so a station with no velocity of its own is still
		// something a ship can run into - even though it is not in the system's own entity list.
		const system = createSystem({ updateFunction: collisionUpdate });
		const moving = world.loadEntity({ x: 0, y: 0, width: 10, height: 10, velocityX: 1, velocityY: 0, health: 3 });
		const still = world.loadEntity({ x: 100, y: 0, width: 10, height: 10, health: 3 });

		expect(system.entities.map(entity => entity.eid)).toEqual([moving.eid]);
		expect(system.isEntityInSystem(still)).toEqual(false);
		expect(system.options.queries?.collidable).toBeDefined();
	});
});

// The collisions themselves run against both backends, the same way movement does: the callback has to behave
// identically whether it is running in-process or in a real worker it reached through an import.
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

	// A 10x10 entity that moves and can be hurt - the shape every test below starts from.  Health starts high
	// enough that a collision or two never kills anything by accident.
	const FULL_HEALTH = 10;
	function createShip(config: Config): BaseEntity<Components, Config> {
		return world.loadEntity({ width: 10, height: 10, velocityX: 0, velocityY: 0, health: FULL_HEALTH, ...config });
	}
	// Something with a transform but no velocity, so the system never moves it and it is only ever the `other`
	// side of a collision.
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

		// Both moved, so both got their own call: each took the self damage for the entity it landed on, and the
		// other damage from the entity that landed on it.  The worker wrote it straight into the shared block.
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

		// Only the ship moved, so only the ship's callback ran: it took the self damage, and reached across into
		// the station's block for the other damage.  The station never gets a call of its own.
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

	// A round entity, which gives its size as a radius instead of a width and a height - so it cannot go through
	// createShip, whose defaults would supply both and be refused.
	function createRound(config: Config): BaseEntity<Components, Config> {
		return world.loadEntity({ velocityX: 0, velocityY: 0, health: FULL_HEALTH, ...config });
	}

	it('collides two circles, and rounds off the corner a box would keep', async () => {
		// Offset along the diagonal by more than two 10 wide circles can reach, though two 10x10 boxes still would.
		let first = createRound({ x: 0, y: 0, radius: 5 });
		let second = createRound({ x: 8, y: 8, radius: 5 });

		await run(ONE_SECOND);

		expect(first.components.health?.health).toEqual(FULL_HEALTH);
		expect(second.components.health?.health).toEqual(FULL_HEALTH);

		// The same two positions as boxes do collide, so it is the shape doing the work rather than the distance.
		let box = createShip({ x: 100, y: 100 });
		let other = createShip({ x: 108, y: 108 });
		await run(ONE_SECOND);

		expect(box.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(other.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('collides a capsule along its length', async () => {
		// 40 from end to end, so its cap reaches x = 20 and just catches a ship whose edge is at 20.5 - 5 = 15.5.
		let capsule = createShip({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });
		let target = createShip({ x: 20.5, y: 0 });

		await run(ONE_SECOND);

		expect(capsule.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(target.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('does not collide a capsule with what is off its ends', async () => {
		let capsule = createShip({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });
		// Out beyond the cap by more than the ship's own half width.
		let target = createShip({ x: 40, y: 0 });

		await run(ONE_SECOND);

		expect(capsule.components.health?.health).toEqual(FULL_HEALTH);
		expect(target.components.health?.health).toEqual(FULL_HEALTH);
	});

	it('collides a circle with a capsule it has moved onto', async () => {
		let capsule = createShip({ x: 0, y: 0, width: 40, height: 10, shape: SHAPE_CAPSULE });
		// Closing on the capsule's side from above: 20 up, moving down 15, so it ends 5 above the centre line and
		// well inside the 5 the capsule is thick plus its own 1.
		let circle = createRound({ x: 0, y: 20, radius: 1, velocityY: -15 });

		await run(ONE_SECOND);

		// Stopped on the capsule's surface rather than going the whole 15: 5 of capsule thickness plus its own 1
		// of radius is as close as their centres can get.
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
		// Sitting right on top of each other, so only the categories can be keeping them apart.
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

		// The attack landed on both of them, and took the self damage once for each.
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
		// The body block is shared memory, so a unit that takes off is picked up by the next run without
		// anything being re-sent to the worker.
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
		// Two upright bars, five apart: as they stand they miss each other.
		let first = createShip({ x: 0, y: 0, width: 2, height: 10 });
		let second = createShip({ x: 5, y: 0, width: 2, height: 10 });

		await run(ONE_SECOND);
		expect(first.components.health?.health).toEqual(FULL_HEALTH);

		// Laid on its side, the second bar's long edge now crosses the gap.
		second.components.transform!.angle = Math.PI / 2;
		await run(ONE_SECOND);

		expect(first.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
		expect(second.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE - OTHER_DAMAGE);
	});

	it('collides an entity in the same run its movement drove it in', async () => {
		// 20 apart with 10 of width each, closing at 6 units per second from both sides - so between them this run
		// closes 12 of the 10 they have to spare, and they meet part way through it.
		let first = createShip({ x: 0, y: 0, velocityX: 6 });
		let second = createShip({ x: 20, y: 0, velocityX: -6 });

		await run(ONE_SECOND);

		// The check happens straight after each entity moves, so the run that closes the gap is the run that
		// reports it rather than the one after.  The first one moves before there is anything within reach and
		// gets its whole 6; the second is then stopped on its edge, 4 into its own 6.
		expect(first.components.transform?.x).toEqual(6);
		expect(second.components.transform?.x).toBeCloseTo(16);
		expect(first.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(second.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('finds a pair the broadphase would lose without room for their velocity', async () => {
		// 80 apart, closing at 40 a second: neither is anywhere near the other when the tree is built, and only
		// the room left for what each can cover in a run keeps the pair in the running at all.
		let first = createShip({ x: 0, y: 0, velocityX: 40 });
		let second = createShip({ x: 80, y: 0, velocityX: -40 });

		await run(ONE_SECOND);

		// The first one has 30 of clear road ahead of it at the moment it moves, so its whole 40 is taken; the
		// second then runs into it where it stopped.
		expect(first.components.transform?.x).toEqual(40);
		expect(second.components.transform?.x).toBeCloseTo(50);
		expect(first.components.health?.health).toBeLessThan(FULL_HEALTH);
		expect(second.components.health?.health).toBeLessThan(FULL_HEALTH);
	});

	it('stops an entity on the edge of what it moves into rather than inside it', async () => {
		// 30 apart with 10 of width each, so their edges meet with the ship at 20 - short of the 25 its velocity
		// asked for.
		let ship = createShip({ x: 0, y: 0, velocityX: 25 });
		let station = createStation({ x: 30, y: 0 });

		await run(ONE_SECOND);

		expect(ship.components.transform?.x).toBeCloseTo(20, 3);
		// And the callback still ran, even though the two are touching rather than through each other.
		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE);
		expect(station.components.health?.health).toEqual(FULL_HEALTH - OTHER_DAMAGE);
	});

	it('does not stop inside the near entity because the far one collided first', async () => {
		// A huddle the ship's move ends up on top of, with the far station created before the near one so it is
		// ahead of it in the collidable query: an implementation that stopped at the first collision it reported
		// would come to rest at 18, well inside the near one.
		let far = createStation({ x: 28, y: 0 });
		let near = createStation({ x: 20, y: 0 });
		let ship = createShip({ x: 0, y: 0, velocityX: 25 });

		await run(ONE_SECOND);

		expect(ship.components.transform?.x).toBeCloseTo(10, 3);
		// Only the near one was ever reached, so only the near one was collided with.
		expect(near.components.health?.health).toEqual(FULL_HEALTH - OTHER_DAMAGE);
		expect(far.components.health?.health).toEqual(FULL_HEALTH);
		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE);
	});

	it('holds an entity against what it is up against run after run', async () => {
		// Closing the last 4 of the gap on the first run, which leaves it touching at 20.
		let ship = createShip({ x: 16, y: 0, velocityX: 5 });
		createStation({ x: 30, y: 0 });

		await run(ONE_SECOND);
		const restingPlace = ship.components.transform?.x;
		expect(restingPlace).toBeCloseTo(20, 3);

		// Still pushing into it with the same velocity, and it has nowhere left to go: the position does not creep
		// forwards, and the collision keeps being reported for as long as it keeps pushing.
		await run(ONE_SECOND);

		expect(ship.components.transform?.x).toEqual(restingPlace);
		expect(ship.components.health?.health).toEqual(FULL_HEALTH - SELF_DAMAGE * 2);
	});

	it('reports where an entity ended up as it moves', async () => {
		let ship = createShip({ x: 0, y: 0, velocityX: 3, velocityY: -4 });
		let reported: Array<[number, number]> = [];
		ship.on(POSITION_UPDATED_EVENT, (x: number, y: number) => {
			reported.push([x, y]);
		});

		await run(ONE_SECOND);

		// Both axes in the one event rather than an event each: the whole point of the move having an event of its
		// own is that a diagonal move is one thing to send back to the main thread rather than two.
		expect(reported).toEqual([[3, -4]]);
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
		let reported: Array<number> = [];
		ship.on(POSITION_UPDATED_EVENT, (x: number) => {
			reported.push(x);
		});

		await run(ONE_SECOND);

		// One report rather than one for the move and another for being pushed back out of it: the block is only
		// written once the sweep has settled where the entity may go.
		expect(reported.length).toEqual(1);
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

		// The callback runs where the blocks are, with no entities in reach, so a death gets back to the main
		// thread as an event rather than being done there and then.
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
