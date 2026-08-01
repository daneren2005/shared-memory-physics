import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import PhysicsSystem from '../physics-system';
import InterpolationSystem from '../interpolation-system';
import { snapEntity } from '../../components/interpolation-component';
import { createTestWorld, type Components, type Config, type TestWorld } from '../../__tests__/fixtures/world';
import collisionUpdate, { type CollisionUpdateComponents } from '../../__tests__/fixtures/collision-update';

const PHYSICS_WORKER_URL = new URL('../../__tests__/fixtures/physics.worker.ts', import.meta.url);
const COLLISION_WORKER_URL = new URL('../../__tests__/fixtures/collision.worker.ts', import.meta.url);

// A step and a frame that divide evenly into each other, so every number below is exact rather than nearly
// right: five frames to a step.
const STEP = 50;
const FRAME = 10;
// One unit of drawn movement per frame at this speed, which is what makes a jerk in the motion something a
// test can name rather than something it has to eyeball.
const SPEED = 100;
const PER_FRAME = SPEED * FRAME / 1000;

// Lets a worker-mode run() settle: postMessage to a real worker is async, so we wait a macrotask for the
// run-complete message to come back.  In main-thread mode the work is synchronous and this is a noop wait.
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

// The drawn position, which is what a renderer reads instead of the transform.
function drawn(entity: BaseEntity<Components, Config>): [number, number] {
	const block = entity.components.interpolation!;

	return [block.x, block.y];
}

type Mode = 'main-thread' | 'worker';
const MODES: Array<Mode> = ['main-thread', 'worker'];

// Both backends, because worker mode is the only configuration where the writer is genuinely on another thread -
// which is what the publication stamp exists for.  Waiting for the run to land between frames is what a real
// page gets too: physics is posted at the end of one frame and read at the top of the next.
describe.each(MODES)('interpolation-system (%s)', (mode) => {
	let world: TestWorld;
	let physics: PhysicsSystem<Components>;
	let interpolation: InterpolationSystem<Components>;

	beforeEach(async () => {
		world = createTestWorld();
		physics = new PhysicsSystem<Components>(world, {
			deltaBetweenRuns: STEP,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(PHYSICS_WORKER_URL, { type: 'module' }),
		});
		interpolation = new InterpolationSystem<Components>(world);

		// Physics first, so a step is drawn on the frame it happened rather than the one after.  Nothing about
		// the smoothness depends on the order - the pacing is driven by what has landed in the block, not by
		// where this system sits in the list - it is only worth one frame of latency.
		world.addSystem(physics);
		world.addSystem(interpolation);

		await world.init();
	});
	afterEach(() => {
		interpolation.destroy();
		physics.destroy();
	});

	function createEntity(config: Config): BaseEntity<Components, Config> {
		return world.loadEntity({ width: 1, height: 1, interpolate: true, ...config });
	}
	// One rendered frame: the world update, then whatever the worker had to say about it.
	async function frame(elapsedTime = FRAME): Promise<void> {
		world.update(elapsedTime);
		await flush();
	}
	// Every drawn position across `count` frames, oldest first.
	async function drawnOver(entity: BaseEntity<Components, Config>, count: number): Promise<Array<[number, number]>> {
		const positions: Array<[number, number]> = [];
		for(let i = 0; i < count; i++) {
			await frame();
			positions.push(drawn(entity));
		}

		return positions;
	}

	it('starts an entity drawn where it spawned rather than at the origin', async () => {
		// The block is seeded from the config, so an entity added between physics steps has somewhere real to be
		// drawn before it has ever been in a run.
		const entity = createEntity({ x: 300, y: -40, velocityX: SPEED });
		expect(drawn(entity)).toEqual([300, -40]);

		await frame();
		expect(drawn(entity)).toEqual([300, -40]);
	});

	// The point of the whole thing: the drawn position changes by the same amount every frame, where the
	// transform changes by a step's worth once every five.
	it('advances by exactly one frame of the velocity, every frame', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });

		// One step plus a frame of warm-up: there is no segment to blend along until physics has published one.
		await drawnOver(entity, STEP / FRAME + 2);

		const positions = await drawnOver(entity, 12);
		for(let i = 1; i < positions.length; i++) {
			expect(positions[i][0] - positions[i - 1][0]).toBeCloseTo(PER_FRAME, 4);
		}
	});

	// The transform only moves on one frame in five, which is the choppiness being fixed - stated as an
	// assertion so the test above is measuring something rather than agreeing with itself.
	it('changes the transform only once a step', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
		await drawnOver(entity, STEP / FRAME + 2);

		const positions: Array<number> = [];
		for(let i = 0; i < 10; i++) {
			await frame();
			positions.push(entity.components.transform!.x);
		}

		// Ten frames cover two steps, so the transform takes three values across them - where a renderer reading
		// it directly would need ten to look smooth.  That gap is the whole reason this system exists.
		expect(new Set(positions).size).toEqual(3);
	});

	// C's whole guarantee: nothing is ever drawn ahead of where the simulation has actually got to.
	it('never draws a position the simulation has not reached', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });

		for(let i = 0; i < 20; i++) {
			await frame();
			expect(drawn(entity)[0]).toBeLessThanOrEqual(entity.components.transform!.x);
		}
	});

	// The case the whole option was chosen for.  Guessing forward from a velocity draws a turning entity a step
	// into its old heading and then snaps it back by |dv| * step - here 7 units, against the 1 a frame is worth.
	it('never jumps when an entity is redirected', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityY: -SPEED });
		await drawnOver(entity, 12);

		const velocity = entity.components.velocity!;
		velocity.velocityY = 0;
		velocity.velocityX = -SPEED;

		const positions = await drawnOver(entity, 12);
		for(let i = 1; i < positions.length; i++) {
			const moved = Math.hypot(positions[i][0] - positions[i - 1][0], positions[i][1] - positions[i - 1][1]);
			// A frame's worth of the speed and no more - the turn shows up as a corner in the drawn path rather
			// than as a jump anywhere along it.
			expect(moved).toBeLessThanOrEqual(PER_FRAME * 1.001);
		}
	});

	it('holds still while the world is paused', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
		await drawnOver(entity, 12);

		// Nothing is written for this: a paused world runs no systems at all, so neither accumulator moves.
		world.pause();
		const held = drawn(entity);
		for(let i = 0; i < 6; i++) {
			await frame();
			expect(drawn(entity)).toEqual(held);
		}

		world.resume();
		await frame();
		expect(drawn(entity)[0]).toBeCloseTo(held[0] + PER_FRAME, 4);
	});

	it('draws at half speed under a half timeScale', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
		world.timeScale = 0.5;
		await drawnOver(entity, STEP / FRAME * 2 + 2);

		const positions = await drawnOver(entity, 12);
		for(let i = 1; i < positions.length; i++) {
			expect(positions[i][0] - positions[i - 1][0]).toBeCloseTo(PER_FRAME / 2, 4);
		}
	});

	// The one thing blending between real positions cannot work out for itself: a teleport and a long move are
	// the same two numbers.
	describe('a teleport', () => {
		async function teleport(): Promise<BaseEntity<Components, Config>> {
			const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
			await drawnOver(entity, 12);
			entity.components.transform!.x = 500;

			return entity;
		}

		it('is drawn as a slide without snapEntity', async () => {
			const entity = await teleport();
			const before = drawn(entity)[0];
			await frame();

			// Documenting the sharp edge rather than pretending it is not there: the entity is drawn part way
			// along a 500-unit segment it never travelled, and takes the rest of the step to arrive.
			expect(drawn(entity)[0]).toBeGreaterThan(before);
			expect(drawn(entity)[0]).toBeLessThan(500);
		});

		it('lands on the very next frame with it', async () => {
			const entity = await teleport();
			snapEntity(entity);
			await frame();

			expect(drawn(entity)[0]).toEqual(500);
		});
	});

	it('leaves an entity with no interpolation component alone', async () => {
		// Interpolation is opt-in per entity, so a world can draw most things smoothly and still keep something
		// out of it entirely.
		const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, velocityX: SPEED });
		await drawnOver(createEntity({ x: 0, y: 0 }), 12);

		expect(entity.components.interpolation).toBeUndefined();
		expect(entity.components.transform!.x).toBeGreaterThan(0);
	});
});

// An entity that comes to rest against something is the case guessing forward from a velocity gets wrong, so it
// gets its own world - one whose update sweeps.
describe.each(MODES)('interpolation-system against a wall (%s)', (mode) => {
	let world: TestWorld;
	let physics: PhysicsSystem<Components, CollisionUpdateComponents>;
	let interpolation: InterpolationSystem<Components>;

	beforeEach(async () => {
		world = createTestWorld();
		physics = new PhysicsSystem<Components, CollisionUpdateComponents>(world, {
			updateFunction: collisionUpdate,
			deltaBetweenRuns: STEP,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(COLLISION_WORKER_URL, { type: 'module' }),
		});
		interpolation = new InterpolationSystem<Components>(world);
		world.addSystem(physics);
		world.addSystem(interpolation);

		await world.init();
	});
	afterEach(() => {
		interpolation.destroy();
		physics.destroy();
	});

	// A ship at 0 walking into a station at 30, both 10 wide, so their edges meet with the ship at 20.  Health is
	// high enough that nothing dies of the contact.
	const RESTING_PLACE = 20;
	async function walkIntoTheWall(): Promise<Array<number>> {
		const ship = world.loadEntity({ x: 0, y: 0, width: 10, height: 10, velocityX: SPEED, health: 1000, interpolate: true });
		world.loadEntity({ x: 30, y: 0, width: 10, height: 10, health: 1000 });

		const positions: Array<number> = [];
		for(let i = 0; i < 40; i++) {
			world.update(FRAME);
			await flush();
			positions.push(ship.components.interpolation!.x);
		}

		return positions;
	}

	it('is never drawn inside what stopped it', async () => {
		for(const x of await walkIntoTheWall()) {
			expect(x).toBeLessThanOrEqual(RESTING_PLACE);
		}
	});

	it('eases into it and stays there, with no rubber band', async () => {
		const positions = await walkIntoTheWall();

		expect(positions[positions.length - 1]).toBeCloseTo(RESTING_PLACE, 3);
		// Never once drawn backwards: the entity was going forwards the whole time, so a frame that moved it back
		// would be a correction for a position it should not have been drawn at in the first place.
		for(let i = 1; i < positions.length; i++) {
			expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
		}
	});
});
