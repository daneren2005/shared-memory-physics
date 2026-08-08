import physicsUpdate, { createPhysicsUpdate, POSITION_UPDATED_EVENT, type PhysicsWorld } from '../physics-update';
import { DEAD_INDEX } from '@daneren2005/shared-memory-ecs';
import type { ComponentSystemCallbacks } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../../components/registry';
import { COLLIDABLE_QUERY, type MovingEntity } from '../collision';
import {
	BODY_CATEGORY_INDEX, BODY_MASK_INDEX, BODY_SENSOR_INDEX, BODY_SHAPE_INDEX, BODY_SIZE,
	DEFAULT_COLLIDE_CATEGORY, DEFAULT_COLLIDE_MASK, SHAPE_CIRCLE, SHAPE_RECTANGLE,
} from '../../components/body-component';
import { BOUNCINESS_INDEX, BOUNCINESS_SIZE } from '../../components/bounciness-component';
import { TRANSFORM_HEIGHT_INDEX, TRANSFORM_SIZE, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';
import { VELOCITY_SIZE, VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../../components/velocity-component';

// Drives the update against raw blocks with no world or system, pinning down the integration math itself;
// physics-system.spec.ts covers the same end to end.
describe('physics-update', () => {
	const callbacks: ComponentSystemCallbacks = {
		entityComponentChanged: () => {},
		emitEntityEvent: () => {},
		emitSystemEvent: () => {},
		entityDied: () => {},
		createEntity: () => {},
	};

	function move(position: [number, number], velocity: [number, number], elapsedTime: number): [number, number] {
		// Full block size, written through the exported offsets, so a transform that grows fields does not change
		// what this tests.
		const transform = new Float32Array(TRANSFORM_SIZE);
		transform[TRANSFORM_X_INDEX] = position[0];
		transform[TRANSFORM_Y_INDEX] = position[1];

		const velocityBlock = new Float32Array(VELOCITY_SIZE);
		velocityBlock[VELOCITY_X_INDEX] = velocity[0];
		velocityBlock[VELOCITY_Y_INDEX] = velocity[1];

		const world: PhysicsWorld = { gameTime: 0, elapsedTime, tick: 1 };
		physicsUpdate(world, 1, { transform, velocity: velocityBlock }, {}, callbacks);

		return [transform[TRANSFORM_X_INDEX], transform[TRANSFORM_Y_INDEX]];
	}

	it('adds one second of velocity to the position', () => {
		expect(move([0, 0], [3, 4], 1000)).toEqual([3, 4]);
	});

	it('scales velocity by the elapsed time', () => {
		expect(move([0, 0], [10, 20], 500)).toEqual([5, 10]);
	});

	it('moves relative to the current position', () => {
		expect(move([100, -50], [1, 2], 1000)).toEqual([101, -48]);
	});

	it('moves backwards on a negative velocity', () => {
		expect(move([0, 0], [-2, -6], 1000)).toEqual([-2, -6]);
	});

	it('does not move on a zero velocity', () => {
		expect(move([12, 34], [0, 0], 1000)).toEqual([12, 34]);
	});

	it('does not move on a zero elapsed time', () => {
		expect(move([12, 34], [5, 5], 0)).toEqual([12, 34]);
	});

	it('keeps each axis independent', () => {
		expect(move([0, 0], [5, 0], 1000)).toEqual([5, 0]);
		expect(move([0, 0], [0, 5], 1000)).toEqual([0, 5]);
	});

	it('reads velocity from the same block offsets the component writes', () => {
		const velocity = new Float32Array(VELOCITY_SIZE);
		velocity[VELOCITY_X_INDEX] = 7;
		velocity[VELOCITY_Y_INDEX] = -7;

		expect(move([0, 0], [velocity[VELOCITY_X_INDEX], velocity[VELOCITY_Y_INDEX]], 1000)).toEqual([7, -7]);
	});

	describe('reporting the move', () => {
		// Every event the move fired, so a test asserts how many there were as well as what they were about. No
		// position travels; `endedUpAt` reads the shared transform block instead.
		function eventsFrom(velocity: [number, number]): { events: Array<string>, endedUpAt: [number, number] } {
			const events: Array<string> = [];
			const transform = new Float32Array(TRANSFORM_SIZE);
			const velocityBlock = new Float32Array(VELOCITY_SIZE);
			velocityBlock[VELOCITY_X_INDEX] = velocity[0];
			velocityBlock[VELOCITY_Y_INDEX] = velocity[1];

			physicsUpdate({ gameTime: 0, elapsedTime: 1000, tick: 1 }, 7, { transform, velocity: velocityBlock }, {}, {
				...callbacks,
				emitSystemEvent(event, entityId) {
					events.push(`${event}.${entityId}`);
				},
				// A move is reported through the batched event alone; the per-entity callbacks must not fire for one too.
				emitEntityEvent(entityId, event) {
					events.push(`${entityId}.${event}`);
				},
				entityComponentChanged(entityId, componentName, prop) {
					events.push(`${entityId}.${componentName}.${String(prop)}`);
				},
			});

			return {
				events,
				endedUpAt: [transform[TRANSFORM_X_INDEX], transform[TRANSFORM_Y_INDEX]],
			};
		}

		it('reports the entity that moved once, by id, with the position left in the block', () => {
			const { events, endedUpAt } = eventsFrom([3, -4]);
			expect(events).toEqual([`${POSITION_UPDATED_EVENT}.7`]);
			expect(endedUpAt).toEqual([3, -4]);
		});

		it('reports one move however many axes it moved along', () => {
			// A single-axis move is one report, same as a diagonal one.
			expect(eventsFrom([3, 0]).events).toEqual([`${POSITION_UPDATED_EVENT}.7`]);
			expect(eventsFrom([0, -4]).events).toEqual([`${POSITION_UPDATED_EVENT}.7`]);
		});

		it('says nothing at all about an entity that did not move', () => {
			expect(eventsFrom([0, 0]).events).toEqual([]);
		});

		it('says nothing at all when the run was told not to report', () => {
			// PhysicsSystem sets this from whether anything is listening; the saving is in the worker, not here.
			const transform = new Float32Array(TRANSFORM_SIZE);
			const velocity = new Float32Array(VELOCITY_SIZE);
			velocity[VELOCITY_X_INDEX] = 3;

			const events: Array<string> = [];
			physicsUpdate({ gameTime: 0, elapsedTime: 1000, tick: 1, reportMoves: false }, 7, { transform, velocity }, {}, {
				...callbacks,
				emitSystemEvent(event, entityId) {
					events.push(`${event}.${entityId}`);
				},
			});

			expect(events).toEqual([]);
			// The entity still moved: this silences the report, not the physics.
			expect(transform[TRANSFORM_X_INDEX]).toEqual(3);
		});
	});
});

// The createPhysicsUpdate update, driven against raw blocks like the worker: preRun once, then every entity.
interface Unit {
	x: number
	y: number
	width?: number
	height?: number
	velocityX?: number
	velocityY?: number
	shape?: number
	// Left off, the unit has no bounciness block - the case a game's terrain and walls are.
	bounciness?: number
	sensor?: boolean
	dead?: boolean
}

// Units default to 10x10, still, colliding with everything, so most only give a position.
function createUnit(unit: Unit, entityId: number): MovingEntity<PhysicsUpdateComponents> {
	const transform = new Float32Array(TRANSFORM_SIZE);
	transform[TRANSFORM_X_INDEX] = unit.x;
	transform[TRANSFORM_Y_INDEX] = unit.y;
	transform[TRANSFORM_WIDTH_INDEX] = unit.width ?? 10;
	transform[TRANSFORM_HEIGHT_INDEX] = unit.height ?? 10;

	const velocity = new Float32Array(VELOCITY_SIZE);
	velocity[VELOCITY_X_INDEX] = unit.velocityX ?? 0;
	velocity[VELOCITY_Y_INDEX] = unit.velocityY ?? 0;

	const body = new Uint32Array(BODY_SIZE);
	body[BODY_SHAPE_INDEX] = unit.shape ?? SHAPE_RECTANGLE;
	body[BODY_CATEGORY_INDEX] = DEFAULT_COLLIDE_CATEGORY;
	body[BODY_MASK_INDEX] = DEFAULT_COLLIDE_MASK;
	body[BODY_SENSOR_INDEX] = unit.sensor ? 1 : 0;

	const entity = new Uint32Array(2);
	entity[DEAD_INDEX] = unit.dead ? 1 : 0;

	const components: PhysicsUpdateComponents & { entity: Uint32Array } = { transform, velocity, body, entity };
	// Only a unit that names a bounciness carries the block, as at runtime.
	if(unit.bounciness !== undefined) {
		const bounciness = new Float32Array(BOUNCINESS_SIZE);
		bounciness[BOUNCINESS_INDEX] = unit.bounciness;
		components.bounciness = bounciness;
	}

	return { entityId, components };
}

// A round 10-wide unit.
function circle(unit: Omit<Unit, 'width' | 'height' | 'shape'>): Unit {
	return { ...unit, width: 10, height: 10, shape: SHAPE_CIRCLE };
}

describe('createPhysicsUpdate', () => {
	// What a callback was told, including where the mover had ended up - the position onCollision must trust.
	interface Collision {
		self: number
		other: number
		selfX: number
		selfY: number
	}

	// One run over the list in order; entity ids are list positions + 1.
	function run(units: Array<Unit>, elapsedTime = 1000, reportMoves?: boolean) {
		const entities = units.map((unit, index) => createUnit(unit, index + 1));
		const collisions: Array<Collision> = [];
		const changes: Array<string> = [];

		const update = createPhysicsUpdate({
			onCollision(world, self, other) {
				collisions.push({
					self: self.entityId,
					other: other.entityId,
					selfX: self.components.transform[TRANSFORM_X_INDEX],
					selfY: self.components.transform[TRANSFORM_Y_INDEX],
				});
			},
		});

		const world: PhysicsWorld = { gameTime: 0, elapsedTime, tick: 1, reportMoves };
		const queries = { [COLLIDABLE_QUERY]: entities };
		const recording: ComponentSystemCallbacks<PhysicsComponents> = {
			entityComponentChanged(entityId, componentName, prop) {
				changes.push(`${entityId}.${componentName}.${String(prop)}`);
			},
			emitEntityEvent(entityId, event) {
				changes.push(`${entityId}.${event}`);
			},
			emitSystemEvent(event, entityId) {
				changes.push(`${event}.${entityId}`);
			},
			entityDied: () => {},
			createEntity: () => {},
		};

		update.preRun!(world, entities, queries, recording);
		for(const entity of entities) {
			update(world, entity.entityId, entity.components, queries, recording);
		}

		return {
			collisions,
			changes,
			// Every pair reported, as [self, other].
			pairs: () => collisions.map(collision => [collision.self, collision.other]),
			// Just what the mover (entity 1) ran into; other entities' calls are noise here.
			hits: () => collisions.filter(collision => collision.self === 1).map(collision => collision.other),
			x: (entityId: number) => entities[entityId - 1].components.transform[TRANSFORM_X_INDEX],
			y: (entityId: number) => entities[entityId - 1].components.transform[TRANSFORM_Y_INDEX],
		};
	}

	it('stops an entity on the edge of what it moved into', () => {
		// 30 apart, 10 wide each, so edges meet at 20 - short of the 25 asked for.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		expect(result.x(1)).toBeCloseTo(20, 3);
	});

	it('still runs the callback for what it stopped against', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		// Reported because the move was stopped by it, not because they overlap (they only touch).
		expect(result.pairs()).toEqual([[1, 2]]);
	});

	it('has already put the entity down before the callback runs', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		// The callback sees the resting position, not the 25 it would have reached.
		expect(result.collisions[0].selfX).toBeCloseTo(20, 3);
		expect(result.collisions[0].selfY).toEqual(0);
	});

	it('reports the position it stopped at rather than the one it asked for', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		// One report, only after the final position was known.
		expect(result.changes).toEqual([`${POSITION_UPDATED_EVENT}.1`]);
	});

	it('still stops where it should when the run was told not to report', () => {
		// The sweep and move are physics; turning the report off must leave them unchanged.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }], 1000, false);

		expect(result.x(1)).toBeCloseTo(20, 3);
		expect(result.changes).toEqual([]);
		// The collision callback is not a position report and still runs.
		expect(result.pairs()).toEqual([[1, 2]]);
	});

	it('says nothing about an entity a wall left with nowhere to go', () => {
		// Already touching, so its whole move is taken away and there is nothing to report.
		const result = run([{ x: 0, y: 0, velocityX: 5 }, { x: 10, y: 0 }]);

		expect(result.x(1)).toEqual(0);
		expect(result.changes).toEqual([]);
		expect(result.pairs()).toEqual([[1, 2]]);
	});

	// One decision over everything it lands on: the callback for the far one must not settle where the mover stops.
	it('does not stop inside the near one because it collided with the far one first', () => {
		// The far one is ahead of the near one in the list; stopping at the first found would rest at 18, inside it.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 28, y: 0 }, { x: 20, y: 0 }]);

		expect(result.x(1)).toBeCloseTo(10, 3);
		// Only the near one is reported; the far one was never reached.
		expect(result.hits()).toEqual([3]);
	});

	it('comes out the same with the near one found first', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 20, y: 0 }, { x: 28, y: 0 }]);

		expect(result.x(1)).toBeCloseTo(10, 3);
		expect(result.hits()).toEqual([2]);
	});

	it('reports both of two it came to rest against at once', () => {
		// One above, one below the path, near edges level, so it wedges between them at once.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: -5 }, { x: 30, y: 5 }]);

		expect(result.x(1)).toBeCloseTo(20, 3);
		expect(result.pairs()).toEqual([[1, 2], [1, 3]]);
	});

	it('leaves an entity that started inside another free to move out of it', () => {
		// Blocking on something it already overlaps would pin it forever, so it moves and takes its callback with it.
		const result = run([{ x: 0, y: 0, velocityX: 2 }, { x: 5, y: 0 }]);

		expect(result.x(1)).toEqual(2);
		expect(result.hits()).toEqual([2]);
	});

	it('passes a mover straight through a sensor while still running its callback', () => {
		// A sensor blocks nothing, so the mover takes its whole 25, and the overlap is still reported.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0, sensor: true }]);

		expect(result.x(1)).toEqual(25);
		expect(result.hits()).toEqual([2]);
	});

	it('reports the sensor from the overlap rather than as something it stopped against', () => {
		// A sensor is never in the blocking list, so the pair comes from the end-of-move overlap.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 20, y: 0, sensor: true }]);

		expect(result.hits()).toEqual([2]);
		// The mover ends inside the sensor - its whole 25, not stopped short.
		expect(result.collisions[0].selfX).toEqual(25);
	});

	it('still reports two entities that are simply sitting on top of each other', () => {
		// Neither moves, so this is the overlap check: one call each, roles swapped.
		const result = run([{ x: 0, y: 0 }, { x: 5, y: 0 }]);

		expect(result.pairs()).toEqual([[1, 2], [2, 1]]);
	});

	it('gives the entity that moves first the clear road', () => {
		// 30 apart, each asking 12 towards the other: the first gets its whole move, the second stops against it.
		const result = run([{ x: 0, y: 0, velocityX: 12 }, { x: 30, y: 0, velocityX: -12 }]);

		expect(result.x(1)).toEqual(12);
		expect(result.x(2)).toBeCloseTo(22, 3);
		expect(result.pairs()).toEqual([[2, 1]]);
	});

	it('stops a move along y the same way', () => {
		const result = run([{ x: 0, y: 0, velocityY: -25 }, { x: 0, y: -30 }]);

		expect(result.y(1)).toBeCloseTo(-20, 3);
		expect(result.changes).toEqual([`${POSITION_UPDATED_EVENT}.1`]);
	});

	// Sweeping is not turned on by the callback: coming to rest is physics, the callback is the game's response.
	// A world of walls and terrain wants the first without the second.
	describe('with no onCollision', () => {
		const ignored: ComponentSystemCallbacks = {
			entityComponentChanged: () => {},
			emitEntityEvent: () => {},
			emitSystemEvent: () => {},
			entityDied: () => {},
			createEntity: () => {},
		};

		// The same single run as `run`, on an update built with nothing asked of it.
		function runWithoutCallback(units: Array<Unit>, elapsedTime = 1000) {
			const entities = units.map((unit, index) => createUnit(unit, index + 1));
			const update = createPhysicsUpdate();

			const world: PhysicsWorld = { gameTime: 0, elapsedTime, tick: 1 };
			const queries = { [COLLIDABLE_QUERY]: entities };

			update.preRun!(world, entities, queries, ignored);
			for(const entity of entities) {
				update(world, entity.entityId, entity.components, queries, ignored);
			}

			return (entityId: number) => entities[entityId - 1].components.transform[TRANSFORM_X_INDEX];
		}

		it('still stops an entity on the edge of what it moved into', () => {
			expect(runWithoutCallback([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }])(1)).toBeCloseTo(20, 3);
		});

		it('still leaves an entity with nowhere to go exactly where it is', () => {
			expect(runWithoutCallback([{ x: 0, y: 0, velocityX: 5 }, { x: 10, y: 0 }])(1)).toEqual(0);
		});

		it('still moves an entity that has nothing in its way', () => {
			expect(runWithoutCallback([{ x: 0, y: 0, velocityX: 25 }, { x: 300, y: 0 }])(1)).toEqual(25);
		});

		it('asks for the collidable query, which is what the sweep is searched through', () => {
			// PhysicsSystem reads this to decide whether to gather the query at all.
			expect(createPhysicsUpdate().physics.collision).toEqual(true);
		});
	});

	// An entity can be killed by earlier onCollision callback or another worker
	describe('with something already dead in the way', () => {
		it('does not stop against a dead entity', () => {
			// The wall that would stop the mover at 20, but dead: it sails its whole 25 through the corpse.
			const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0, dead: true }]);

			expect(result.x(1)).toEqual(25);
		});

		it('runs no collision callback for a dead entity it moves over', () => {
			const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0, dead: true }]);

			expect(result.hits()).toEqual([]);
		});

		it('still stops against a live entity beyond a dead one', () => {
			// A dead one where the mover would stop and a live one past it: it passes through the corpse to the wall.
			const result = run([{ x: 0, y: 0, velocityX: 45 }, { x: 30, y: 0, dead: true }, { x: 50, y: 0 }]);

			expect(result.x(1)).toBeCloseTo(40, 3);
			expect(result.hits()).toEqual([3]);
		});

		it('does not report a dead entity a still one is sitting on top of', () => {
			// The live one skips the dead one it overlaps, and the dead one does not run.
			const result = run([{ x: 0, y: 0 }, { x: 5, y: 0, dead: true }]);

			expect(result.pairs()).toEqual([]);
		});

		// A dead entity that is itself a mover, killed this run but not yet dropped: it must not move or run its
		// callbacks, where it would be killed again.
		it('does not move a dead entity or run its callbacks', () => {
			const result = run([{ x: 0, y: 0, velocityX: 25, dead: true }, { x: 5, y: 0 }]);

			expect(result.x(1)).toEqual(0);
			expect(result.hits()).toEqual([]);
			// The live one skips the dead mover it overlaps, so no pair at all.
			expect(result.pairs()).toEqual([]);
		});
	});

	it('stops short by the same fraction however long the run is', () => {
		// The stop is a place, not a share of the move, so a half-time run ends at the same edge if it can reach it.
		expect(run([{ x: 0, y: 0, velocityX: 50 }, { x: 30, y: 0 }], 500).x(1)).toBeCloseTo(20, 3);
		// A run too short to reach it is not stopped.
		expect(run([{ x: 0, y: 0, velocityX: 50 }, { x: 30, y: 0 }], 100).x(1)).toEqual(5);
	});
});

// The native bounce from a bounciness block, no onCollision: physics turning an entity around on contact.
describe('createPhysicsUpdate bounce', () => {
	// One run of a bounce-only update. Returns each entity's ending velocity, where the flip shows up.
	function run(units: Array<Unit>, elapsedTime = 1000) {
		const entities = units.map((unit, index) => createUnit(unit, index + 1));
		const update = createPhysicsUpdate();

		const world: PhysicsWorld = { gameTime: 0, elapsedTime, tick: 1 };
		const queries = { [COLLIDABLE_QUERY]: entities };
		const ignored: ComponentSystemCallbacks = {
			entityComponentChanged: () => {},
			emitEntityEvent: () => {},
			emitSystemEvent: () => {},
			entityDied: () => {},
			createEntity: () => {},
		};

		update.preRun!(world, entities, queries, ignored);
		for(const entity of entities) {
			update(world, entity.entityId, entity.components, queries, ignored);
		}

		return {
			velocityX: (entityId: number) => entities[entityId - 1].components.velocity[VELOCITY_X_INDEX],
			velocityY: (entityId: number) => entities[entityId - 1].components.velocity[VELOCITY_Y_INDEX],
		};
	}

	it('flips the velocity of a full-bounciness unit that runs head-on into a wall', () => {
		// At bounciness 1 the whole velocity into the face comes back.
		const result = run([{ x: 0, y: 0, velocityX: 25, bounciness: 1 }, { x: 30, y: 0 }]);

		expect(result.velocityX(1)).toBeCloseTo(-25, 3);
		expect(result.velocityY(1)).toEqual(0);
	});

	it('keeps half the speed at bounciness 0.5', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25, bounciness: 0.5 }, { x: 30, y: 0 }]);

		expect(result.velocityX(1)).toBeCloseTo(-12.5, 3);
	});

	it('cancels the velocity into the surface at bounciness 0', () => {
		// Nothing bounces: the velocity into the wall is removed and the mover rests against it.
		const result = run([{ x: 0, y: 0, velocityX: 25, bounciness: 0 }, { x: 30, y: 0 }]);

		expect(result.velocityX(1)).toBeCloseTo(0, 3);
	});

	it('keeps the velocity along the surface and only flips the part into it', () => {
		// A glancing hit on a tall wall: x into the face reverses, y along it is left alone.
		const result = run([{ x: 0, y: 0, velocityX: 25, velocityY: 40, bounciness: 1 }, { x: 30, y: 0, height: 200 }]);

		expect(result.velocityX(1)).toBeCloseTo(-25, 3);
		expect(result.velocityY(1)).toBeCloseTo(40, 3);
	});

	it('bounces two circles apart along the line between their centres', () => {
		// The contact normal between two circles is the line joining their centres.
		const result = run([
			circle({ x: 0, y: 0, velocityX: 20, bounciness: 1 }),
			circle({ x: 12, y: 0 }),
		]);

		expect(result.velocityX(1)).toBeCloseTo(-20, 3);
	});

	it('leaves a unit with no bounciness block moving as it was, merely stopped short', () => {
		// A game's walls and terrain: stopped by the sweep, but nothing turns the velocity around.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		expect(result.velocityX(1)).toEqual(25);
	});

	it('does not bounce a full-bounciness unit off a sensor', () => {
		// Nothing bounces off a sensor, so the mover keeps its heading and sails through.
		const result = run([{ x: 0, y: 0, velocityX: 25, bounciness: 1 }, { x: 30, y: 0, sensor: true }]);

		expect(result.velocityX(1)).toEqual(25);
	});
});
