import physicsUpdate, { createPhysicsUpdate, POSITION_UPDATED_EVENT } from '../physics-update';
import type { ComponentSystemCallbacks, ComponentSystemWorld } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../../components/registry';
import { COLLIDABLE_QUERY, type MovingEntity } from '../collision';
import { BODY_CATEGORY_INDEX, BODY_MASK_INDEX, BODY_SHAPE_INDEX, BODY_SIZE, DEFAULT_COLLIDE_CATEGORY, DEFAULT_COLLIDE_MASK, SHAPE_RECTANGLE } from '../../components/body-component';
import { TRANSFORM_HEIGHT_INDEX, TRANSFORM_SIZE, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';
import { VELOCITY_SIZE, VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../../components/velocity-component';

// Drives the update function directly against raw blocks, without a world or a system in the way - so these
// pin down the integration math itself.  physics-system.spec.ts covers the same logic end to end.
describe('physics-update', () => {
	const callbacks: ComponentSystemCallbacks = {
		entityComponentChanged: () => {},
		emitEntityEvent: () => {},
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

		const world: ComponentSystemWorld = { gameTime: 0, elapsedTime };
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
		// Every event the move reported, as [entityId.event, ...args] - so a test says how many events there were
		// as well as what was in them, which is the whole point of reporting a move as one event rather than two.
		function eventsFrom(velocity: [number, number]): Array<Array<unknown>> {
			const events: Array<Array<unknown>> = [];
			const transform = new Float32Array(TRANSFORM_SIZE);
			const velocityBlock = new Float32Array(VELOCITY_SIZE);
			velocityBlock[VELOCITY_X_INDEX] = velocity[0];
			velocityBlock[VELOCITY_Y_INDEX] = velocity[1];

			physicsUpdate({ gameTime: 0, elapsedTime: 1000 }, 7, { transform, velocity: velocityBlock }, {}, {
				...callbacks,
				emitEntityEvent(entityId, event, ...args) {
					events.push([`${entityId}.${event}`, ...args]);
				},
				// Position is reported through its own event now, so the property-at-a-time callback must not fire for
				// a move as well - two reports of the same thing is exactly what this is meant to stop.
				entityComponentChanged(entityId, componentName, prop, value) {
					events.push([`${entityId}.${componentName}.${String(prop)}`, value]);
				},
			});

			return events;
		}

		it('reports where the entity ended up as a single event carrying both axes', () => {
			expect(eventsFrom([3, -4])).toEqual([[`7.${POSITION_UPDATED_EVENT}`, 3, -4]]);
		});

		it('still reports both axes when only one of them moved', () => {
			// The axis that did not move comes through as where the entity is rather than being left out, so a
			// listener always has the whole position without having to remember the last one it was told.
			expect(eventsFrom([3, 0])).toEqual([[`7.${POSITION_UPDATED_EVENT}`, 3, 0]]);
			expect(eventsFrom([0, -4])).toEqual([[`7.${POSITION_UPDATED_EVENT}`, 0, -4]]);
		});

		it('says nothing at all about an entity that did not move', () => {
			expect(eventsFrom([0, 0])).toEqual([]);
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
	body[BODY_SHAPE_INDEX] = SHAPE_RECTANGLE;
	body[BODY_CATEGORY_INDEX] = DEFAULT_COLLIDE_CATEGORY;
	body[BODY_MASK_INDEX] = DEFAULT_COLLIDE_MASK;

	return { entityId, components: { transform, velocity, body } };
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
	function run(units: Array<Unit>, elapsedTime = 1000) {
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

		const world: ComponentSystemWorld = { gameTime: 0, elapsedTime };
		const queries = { [COLLIDABLE_QUERY]: entities };
		const recording: ComponentSystemCallbacks<PhysicsComponents> = {
			entityComponentChanged(entityId, componentName, prop) {
				changes.push(`${entityId}.${componentName}.${String(prop)}`);
			},
			emitEntityEvent(entityId, event) {
				changes.push(`${entityId}.${event}`);
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
		expect(result.changes).toEqual([`1.${POSITION_UPDATED_EVENT}`]);
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
		expect(result.changes).toEqual([`1.${POSITION_UPDATED_EVENT}`]);
	});

	it('stops short by the same fraction however long the run is', () => {
		// The stop is a place rather than a share of the move, so a run that covers half the time still ends up
		// against the same edge - it just needs enough velocity to reach it.
		expect(run([{ x: 0, y: 0, velocityX: 50 }, { x: 30, y: 0 }], 500).x(1)).toBeCloseTo(20, 3);
		// ...and a run too short to reach it is not stopped at all.
		expect(run([{ x: 0, y: 0, velocityX: 50 }, { x: 30, y: 0 }], 100).x(1)).toEqual(5);
	});
});
