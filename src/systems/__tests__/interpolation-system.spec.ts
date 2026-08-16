import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import PhysicsSystem from '../physics-system';
import InterpolationSystem from '../interpolation-system';
import { snapEntity } from '../../components/interpolation-component';
import { createTestWorld, type Components, type Config, type TestWorld } from '../../__tests__/fixtures/world';
import collisionUpdate, { type CollisionUpdateComponents } from '../../__tests__/fixtures/collision-update';

const PHYSICS_WORKER_URL = new URL('../../__tests__/fixtures/physics.worker.ts', import.meta.url);
const COLLISION_WORKER_URL = new URL('../../__tests__/fixtures/collision.worker.ts', import.meta.url);

// A step and frame that divide evenly, so every number below is exact: five frames to a step.
const STEP = 50;
const FRAME = 10;
// One unit of drawn movement per frame, so a jerk is a number a test can name.
const SPEED = 100;
const PER_FRAME = SPEED * FRAME / 1000;

// Waits a macrotask for a worker-mode run to land; a noop wait in main-thread mode.
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

// The drawn position, which a renderer reads instead of the transform.
function drawn(entity: BaseEntity<Components, Config>): [number, number] {
	const block = entity.components.interpolation!;

	return [block.x, block.y];
}

type Mode = 'main-thread' | 'worker';
const MODES: Array<Mode> = ['main-thread', 'worker'];

// Both backends, since worker mode is the only one where the writer is truly on another thread - what the
// publication stamp exists for.
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

		// Physics first, so a step is drawn on the frame it happened; the order is worth only one frame of latency.
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
	// One rendered frame: the world update, then whatever the worker reported.
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
		// The block is seeded from the config, so an entity added between steps has somewhere real to be drawn.
		const entity = createEntity({ x: 300, y: -40, velocityX: SPEED });
		expect(drawn(entity)).toEqual([300, -40]);

		await frame();
		expect(drawn(entity)).toEqual([300, -40]);
	});

	// The point of it all: the drawn position changes by the same amount every frame.
	it('advances by exactly one frame of the velocity, every frame', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });

		// A step plus a frame of warm-up: no segment to blend until physics has published one.
		await drawnOver(entity, STEP / FRAME + 2);

		const positions = await drawnOver(entity, 12);
		for(let i = 1; i < positions.length; i++) {
			expect(positions[i][0] - positions[i - 1][0]).toBeCloseTo(PER_FRAME, 4);
		}
	});

	// The transform moves one frame in five - the choppiness being fixed - asserted so the test above is real.
	it('changes the transform only once a step', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
		await drawnOver(entity, STEP / FRAME + 2);

		const positions: Array<number> = [];
		for(let i = 0; i < 10; i++) {
			await frame();
			positions.push(entity.components.transform!.x);
		}

		// Ten frames cover two steps, so the transform takes three values - a renderer reading it needs ten to
		// look smooth. That gap is why this system exists.
		expect(new Set(positions).size).toEqual(3);
	});

	// The whole guarantee: nothing is drawn ahead of where the simulation has got to.
	it('never draws a position the simulation has not reached', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });

		for(let i = 0; i < 20; i++) {
			await frame();
			expect(drawn(entity)[0]).toBeLessThanOrEqual(entity.components.transform!.x);
		}
	});

	// Guessing forward from velocity would draw a turning entity into its old heading and snap it back; blending
	// does not.
	it('never jumps when an entity is redirected', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityY: -SPEED });
		await drawnOver(entity, 12);

		const velocity = entity.components.velocity!;
		velocity.velocityY = 0;
		velocity.velocityX = -SPEED;

		const positions = await drawnOver(entity, 12);
		for(let i = 1; i < positions.length; i++) {
			const moved = Math.hypot(positions[i][0] - positions[i - 1][0], positions[i][1] - positions[i - 1][1]);
			// A frame's worth and no more - the turn is a corner in the path, not a jump.
			expect(moved).toBeLessThanOrEqual(PER_FRAME * 1.001);
		}
	});

	it('holds still while the world is paused', async () => {
		const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
		await drawnOver(entity, 12);

		// A paused world runs no systems, so neither accumulator moves.
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

	// The one thing blending cannot work out: a teleport and a long move are the same two numbers.
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

			// Documents the sharp edge: the entity is drawn part way along a 500-unit segment it never travelled.
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
		// Interpolation is opt-in per entity.
		const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, velocityX: SPEED });
		await drawnOver(createEntity({ x: 0, y: 0 }), 12);

		expect(entity.components.interpolation).toBeUndefined();
		expect(entity.components.transform!.x).toBeGreaterThan(0);
	});

	// A spawn is otherwise drawn parked at its spawn point until the first step reaches it (test above). For
	// something spawned already moving - a bullet leaving a barrel - that stillness reads as lag, so `startInterpolation`
	// opens the render at the spawn and jumps the transform forward so it is drawn leaving the spawn from the first frame.
	describe('a moving spawn', () => {
		const STEP_DISTANCE = SPEED * STEP / 1000;

		it('is drawn at the spawn point and moves out from there, not offset ahead of it', async () => {
			// Right at a step boundary, so the whole step is still to come and the jump is a full step.
			physics.currentDelta = 0;
			const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
			physics.startInterpolation(entity);

			// Drawn exactly at the spawn point, then moving out - where before it opened offset ahead of the spawn.
			expect(drawn(entity)).toEqual([0, 0]);
			// The transform is jumped forward to where the first step will pick it up.
			expect(entity.components.transform!.x).toBeCloseTo(STEP_DISTANCE, 4);

			await frame();
			expect(drawn(entity)[0]).toBeGreaterThan(0);
			expect(drawn(entity)[0]).toBeLessThanOrEqual(entity.components.transform!.x + 1e-4);
		});

		it('never goes backwards or ahead of the simulation across the handover to the first step', async () => {
			const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
			physics.startInterpolation(entity);

			let previous = drawn(entity)[0];
			for(let i = 0; i < 20; i++) {
				await frame();
				const [x] = drawn(entity);
				expect(x).toBeGreaterThanOrEqual(previous - 1e-4);
				expect(x).toBeLessThanOrEqual(entity.components.transform!.x + 1e-4);
				previous = x;
			}
		});

		it('settles to one frame of the velocity once the first real step has taken over', async () => {
			const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
			physics.startInterpolation(entity);

			// Past the seeded segment and its handover.
			await drawnOver(entity, STEP / FRAME + 4);

			const positions = await drawnOver(entity, 10);
			for(let i = 1; i < positions.length; i++) {
				expect(positions[i][0] - positions[i - 1][0]).toBeCloseTo(PER_FRAME, 4);
			}
		});

		it('opens at the spawn wherever in the step it lands, jumping only what is left of the step', () => {
			const entity = createEntity({ x: 0, y: 0, velocityX: SPEED });
			// Half a step already banked toward the next run, so only half a step is left to jump.
			physics.currentDelta = STEP / 2;
			physics.startInterpolation(entity);

			// The render always opens at the spawn point, whenever in the step the spawn happened.
			expect(drawn(entity)).toEqual([0, 0]);
			// ...and the transform is jumped forward by only the part of the step still to come.
			expect(entity.components.transform!.x).toBeCloseTo(STEP_DISTANCE * 0.5, 4);
		});

		it('does nothing while the system steps every frame', () => {
			const everyFrame = new PhysicsSystem<Components>(world, { deltaBetweenRuns: 0, forceMainThread: true });
			world.addSystem(everyFrame);

			const entity = createEntity({ x: 7, y: 0, velocityX: SPEED });
			everyFrame.startInterpolation(entity);

			// Neither jumped nor seeded: with no window between steps there is nothing to smooth over.
			expect(entity.components.transform!.x).toEqual(7);
			expect(drawn(entity)).toEqual([7, 0]);
			everyFrame.destroy();
		});
	});
});

// Coming to rest against something is the case velocity-guessing gets wrong, so it gets a world whose update sweeps.
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

	// A ship at 0 walking into a station at 30, both 10 wide, so edges meet at 20.
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
		// Never drawn backwards: the entity went forwards throughout, so a backward frame would be a correction.
		for(let i = 1; i < positions.length; i++) {
			expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
		}
	});
});
