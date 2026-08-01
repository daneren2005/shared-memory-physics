import physicsUpdate, { createPhysicsUpdate, POSITION_UPDATED_EVENT, type PhysicsWorld } from '../physics-update';
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

// Drives the update function directly against raw blocks, without a world or a system in the way - so these
// pin down the integration math itself.  physics-system.spec.ts covers the same logic end to end.
describe('physics-update', () => {
	const callbacks: ComponentSystemCallbacks = {
		entityComponentChanged: () => {},
		emitEntityEvent: () => {},
		emitSystemEvent: () => {},
		entityDied: () => {},
		createEntity: () => {},
	};

	function move(position: [number, number], velocity: [number, number], elapsedTime: number): [number, number] {
		// Built at the full block size and written through the exported offsets, so a transform that grows more
		// fields (width, height, angle) does not quietly change what this is testing.
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

	// Position is where the entity is rather than what it is, so a game that keeps anything of its own keyed off
	// it - a spatial index, a minimap - hears about every move rather than having to poll the block.
	describe('reporting the move', () => {
		// Every event the move reported, as `event.entityId` or `entityId.component.prop` - so a test says how many
		// events there were as well as what they were about, which is the whole point of reporting a run's moves as
		// ids on the system rather than as an event apiece on the entities.  Nothing carries a position: the
		// transform block the update just wrote is the same memory the main thread reads, so `endedUpAt` below
		// checks the move by reading that block instead.
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
				// A move is reported through the batched event alone, so neither of the per-entity callbacks may fire
				// for one as well - two reports of the same thing is exactly what this is meant to stop.
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
			// A move along a single axis is one report, the same as a diagonal one: a listener wants the place, and
			// the place is in the block whichever axes changed to get there.
			expect(eventsFrom([3, 0]).events).toEqual([`${POSITION_UPDATED_EVENT}.7`]);
			expect(eventsFrom([0, -4]).events).toEqual([`${POSITION_UPDATED_EVENT}.7`]);
		});

		it('says nothing at all about an entity that did not move', () => {
			expect(eventsFrom([0, 0]).events).toEqual([]);
		});

		it('says nothing at all when the run was told not to report', () => {
			// PhysicsSystem sets this from whether anything is listening.  The saving is not here - it is the id
			// that never joins the run's event array, and so the array that is never cloned back across the worker
			// boundary once a step.
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
			// And the entity still moved: this silences the report, not the physics.
			expect(transform[TRANSFORM_X_INDEX]).toEqual(3);
		});
	});
});

// The update built by createPhysicsUpdate, driven straight against raw blocks the way the worker would: preRun
// once over the collidable query, then every entity in turn.  This is where stopping short of another entity is
// pinned down together with the callbacks that go with it - physics-system.spec.ts covers the same end to end.
interface Unit {
	x: number
	y: number
	width?: number
	height?: number
	velocityX?: number
	velocityY?: number
	shape?: number
	// Left off, the unit has no bounciness block at all - the case a game's terrain and walls are.
	bounciness?: number
	// A sensor is detected and reported but stops nothing: a mover passes through it rather than coming to rest
	// against it, and a bouncing one does not turn around off it.
	sensor?: boolean
}

// The blocks one entity would arrive at the worker with.  Units are 10x10, still, and collide with everything
// unless the unit says otherwise, so most of them only have to say where they are.
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

	const components: PhysicsUpdateComponents = { transform, velocity, body };
	// Only a unit that names a bounciness carries the block, the same way only such an entity would at runtime.
	if(unit.bounciness !== undefined) {
		const bounciness = new Float32Array(BOUNCINESS_SIZE);
		bounciness[BOUNCINESS_INDEX] = unit.bounciness;
		components.bounciness = bounciness;
	}

	return { entityId, components };
}

// A round 10-wide unit, whose body reads the circle shape off its radius the same way a config would.
function circle(unit: Omit<Unit, 'width' | 'height' | 'shape'>): Unit {
	return { ...unit, width: 10, height: 10, shape: SHAPE_CIRCLE };
}

describe('createPhysicsUpdate', () => {
	// What a callback was told, including where the entity that moved had ended up by the time it was told - the
	// position an onCollision has to be able to trust.
	interface Collision {
		self: number
		other: number
		selfX: number
		selfY: number
	}

	// One run over the whole list, in the order it is given - entity ids are its positions in the list + 1.
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
			// Just what the entity that moved ran into.  Anything else in the list is still, so the calls it makes
			// for its own neighbours are noise as far as a test of the mover is concerned.
			hits: () => collisions.filter(collision => collision.self === 1).map(collision => collision.other),
			x: (entityId: number) => entities[entityId - 1].components.transform[TRANSFORM_X_INDEX],
			y: (entityId: number) => entities[entityId - 1].components.transform[TRANSFORM_Y_INDEX],
		};
	}

	it('stops an entity on the edge of what it moved into', () => {
		// 30 apart with 10 of width each, so their edges meet with the mover at 20 - short of the 25 its velocity
		// asked for.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		expect(result.x(1)).toBeCloseTo(20, 3);
	});

	it('still runs the callback for what it stopped against', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		// Touching rather than through each other, so the overlap test at that resting place finds nothing - the
		// pair is reported because the move was stopped by it, not because they ended up overlapping.
		expect(result.pairs()).toEqual([[1, 2]]);
	});

	it('has already put the entity down before the callback runs', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		// The position the callback sees is the one it came to rest at, not the 25 it would have reached: nothing
		// is written to the block until the sweep has settled where it may go.
		expect(result.collisions[0].selfX).toBeCloseTo(20, 3);
		expect(result.collisions[0].selfY).toEqual(0);
	});

	it('reports the position it stopped at rather than the one it asked for', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		// One report, and only after the final position was known.
		expect(result.changes).toEqual([`${POSITION_UPDATED_EVENT}.1`]);
	});

	it('still stops where it should when the run was told not to report', () => {
		// The sweep and the move are physics; the report is a courtesy to whatever is keyed off position, and
		// turning it off has to leave the first two exactly as they were.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }], 1000, false);

		expect(result.x(1)).toBeCloseTo(20, 3);
		expect(result.changes).toEqual([]);
		// The collision callback is not a position report and still runs.
		expect(result.pairs()).toEqual([[1, 2]]);
	});

	it('says nothing about an entity a wall left with nowhere to go', () => {
		// Already exactly touching, so its whole move is taken away and there is no change to report.
		const result = run([{ x: 0, y: 0, velocityX: 5 }, { x: 10, y: 0 }]);

		expect(result.x(1)).toEqual(0);
		expect(result.changes).toEqual([]);
		expect(result.pairs()).toEqual([[1, 2]]);
	});

	// The reason a move is one decision over everything it lands on rather than one per entity: running the
	// callback for the far one first must not be what settles where the mover stops.
	it('does not stop inside the near one because it collided with the far one first', () => {
		// A huddle the move ends up on top of, with the far one deliberately ahead of the near one in the list:
		// stopping at the first entity a collision was found with would come to rest at 18, 8 inside the near one.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 28, y: 0 }, { x: 20, y: 0 }]);

		expect(result.x(1)).toBeCloseTo(10, 3);
		// And only the near one is reported: the far one was never reached, so nothing collided with it.
		expect(result.hits()).toEqual([3]);
	});

	it('comes out the same with the near one found first', () => {
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 20, y: 0 }, { x: 28, y: 0 }]);

		expect(result.x(1)).toBeCloseTo(10, 3);
		expect(result.hits()).toEqual([2]);
	});

	it('reports both of two it came to rest against at once', () => {
		// One above and one below the line it is travelling along, their near edges level, so it wedges between
		// them at the same moment rather than one of them being first.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: -5 }, { x: 30, y: 5 }]);

		expect(result.x(1)).toBeCloseTo(20, 3);
		expect(result.pairs()).toEqual([[1, 2], [1, 3]]);
	});

	it('leaves an entity that started inside another free to move out of it', () => {
		// Overlapping before the run began - spawned there, or pushed in by something else.  Blocking on it would
		// pin it inside for good, so it moves and takes its collision callback with it.
		const result = run([{ x: 0, y: 0, velocityX: 2 }, { x: 5, y: 0 }]);

		expect(result.x(1)).toEqual(2);
		expect(result.hits()).toEqual([2]);
	});

	it('passes a mover straight through a sensor while still running its callback', () => {
		// The sensor sits where a plain box would stop the mover at 20; as a sensor it blocks nothing, so the mover
		// takes its whole 25 - and the overlap is still reported, which is the whole point of the sensor.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0, sensor: true }]);

		expect(result.x(1)).toEqual(25);
		expect(result.hits()).toEqual([2]);
	});

	it('reports the sensor from the overlap rather than as something it stopped against', () => {
		// A sensor is never in the blocking list - nothing comes to rest against it - so the pair is reported by the
		// overlap at the end of the move, with the mover having ended up on top of it rather than resting on an edge.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 20, y: 0, sensor: true }]);

		expect(result.hits()).toEqual([2]);
		// The mover is well inside the sensor at the end of the move - the 25 it asked for, not stopped short of it.
		expect(result.collisions[0].selfX).toEqual(25);
	});

	it('still reports two entities that are simply sitting on top of each other', () => {
		// Neither is going anywhere, so this is the overlap check rather than the sweep - one call each, with the
		// roles swapped.
		const result = run([{ x: 0, y: 0 }, { x: 5, y: 0 }]);

		expect(result.pairs()).toEqual([[1, 2], [2, 1]]);
	});

	it('gives the entity that moves first the clear road', () => {
		// 30 apart, each asking for 12 towards the other.  The first moves while nothing is yet within reach and
		// gets its whole move; the second then comes to rest against it where it stopped, 10 off its centre.
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

	// Sweeping is not something the callback turns on: coming to rest against what is in the way is what physics
	// does about a collision, and what the game does about it is a separate question.  A world of walls and
	// terrain wants the first without ever writing the second.
	describe('with no onCollision', () => {
		const ignored: ComponentSystemCallbacks = {
			entityComponentChanged: () => {},
			emitEntityEvent: () => {},
			emitSystemEvent: () => {},
			entityDied: () => {},
			createEntity: () => {},
		};

		// The same single run as `run` above, on an update built with nothing asked of it at all.
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
			// PhysicsSystem reads this off the function to decide whether to gather the query at all, so an update
			// that sweeps but says it does not collide would be swept against an empty world.
			expect(createPhysicsUpdate().physics.collision).toEqual(true);
		});
	});

	it('stops short by the same fraction however long the run is', () => {
		// The stop is a place rather than a share of the move, so a run that covers half the time still ends up
		// against the same edge - it just needs enough velocity to reach it.
		expect(run([{ x: 0, y: 0, velocityX: 50 }, { x: 30, y: 0 }], 500).x(1)).toBeCloseTo(20, 3);
		// ...and a run too short to reach it is not stopped at all.
		expect(run([{ x: 0, y: 0, velocityX: 50 }, { x: 30, y: 0 }], 100).x(1)).toEqual(5);
	});
});

// The native bounce a unit gets from carrying a bounciness block - no onCollision callback in sight, so this is
// physics turning an entity around on contact rather than a game doing it.  Driven straight against raw blocks
// the way the worker would, the same as createPhysicsUpdate above.
describe('createPhysicsUpdate bounce', () => {
	// One run of an update built with nothing but its native bounce, over the units given in order.  Returns the
	// velocity each entity ended the run with, which is where a bounce shows up: the flip is applied to the block
	// this run, and the next run's move follows it.
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
		// Moving right into a wall on its right at bounciness 1: the whole velocity into the face comes back, so
		// the mover is heading left at the same speed by the end of the run.
		const result = run([{ x: 0, y: 0, velocityX: 25, bounciness: 1 }, { x: 30, y: 0 }]);

		expect(result.velocityX(1)).toBeCloseTo(-25, 3);
		expect(result.velocityY(1)).toEqual(0);
	});

	it('keeps half the speed at bounciness 0.5', () => {
		// Half of the velocity into the surface comes back out, so a head-on hit reverses at half the speed.
		const result = run([{ x: 0, y: 0, velocityX: 25, bounciness: 0.5 }, { x: 30, y: 0 }]);

		expect(result.velocityX(1)).toBeCloseTo(-12.5, 3);
	});

	it('cancels the velocity into the surface at bounciness 0', () => {
		// Nothing bounces: the part of the velocity heading into the wall is removed and the mover comes to rest
		// against it rather than rebounding.
		const result = run([{ x: 0, y: 0, velocityX: 25, bounciness: 0 }, { x: 30, y: 0 }]);

		expect(result.velocityX(1)).toBeCloseTo(0, 3);
	});

	it('keeps the velocity along the surface and only flips the part into it', () => {
		// A glancing hit on a tall wall to the right: the wall is deep enough in y that the mover meets its left
		// face however far it has slid up it, so the x heading into the face reverses and the y sliding along it is
		// left exactly alone.
		const result = run([{ x: 0, y: 0, velocityX: 25, velocityY: 40, bounciness: 1 }, { x: 30, y: 0, height: 200 }]);

		expect(result.velocityX(1)).toBeCloseTo(-25, 3);
		expect(result.velocityY(1)).toBeCloseTo(40, 3);
	});

	it('bounces two circles apart along the line between their centres', () => {
		// A circle closing on another straight along x reverses straight back: the contact normal between two
		// circles is the line joining their centres.  10 wide each, so they touch when their centres are 10 apart.
		const result = run([
			circle({ x: 0, y: 0, velocityX: 20, bounciness: 1 }),
			circle({ x: 12, y: 0 }),
		]);

		expect(result.velocityX(1)).toBeCloseTo(-20, 3);
	});

	it('leaves a unit with no bounciness block moving as it was, merely stopped short', () => {
		// The case a game's walls and terrain are: it collides and is stopped by the sweep, but nothing turns its
		// velocity around, so the block still reads the heading it came in on.
		const result = run([{ x: 0, y: 0, velocityX: 25 }, { x: 30, y: 0 }]);

		expect(result.velocityX(1)).toEqual(25);
	});

	it('does not bounce a full-bounciness unit off a sensor', () => {
		// The same head-on hit that flips the velocity off a wall, but into a sensor: nothing bounces off a sensor,
		// so the mover keeps its heading and sails through rather than turning around.
		const result = run([{ x: 0, y: 0, velocityX: 25, bounciness: 1 }, { x: 30, y: 0, sensor: true }]);

		expect(result.velocityX(1)).toEqual(25);
	});
});
