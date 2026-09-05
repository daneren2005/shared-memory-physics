import { describe, it, expect } from 'vitest';
import { createPhysicsUpdate, type PhysicsWorld } from '../physics-update';
import { DEAD_INDEX } from '@daneren2005/shared-memory-ecs';
import type { BaseComponent, EntityWorkerSystemCallbacks } from '@daneren2005/shared-memory-ecs';
import type { PhysicsComponents, PhysicsUpdateComponents } from '../../components/registry';
import { COLLIDABLE_QUERY, type MovingEntity } from '../collision';
import { BODY_CATEGORY_INDEX, BODY_FLAGS_INDEX, BODY_MASK_INDEX, BODY_SIZE, DEFAULT_COLLIDE_CATEGORY, DEFAULT_COLLIDE_MASK, SHAPE_RECTANGLE } from '../../components/body-component';
import { TRANSFORM_HEIGHT_INDEX, TRANSFORM_SIZE, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';
import { VELOCITY_SIZE, VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../../components/velocity-component';

// A game whose entities carry a numeric group id, the shape createPhysicsUpdate's `group` option reads. The block
// is one Uint32; the id sits at index 0. This is exactly how space-sim groups by solarSystemId.
const GROUP_INDEX = 0;
interface GroupComponent extends BaseComponent {
	groupId: number
}
type GroupComponents = PhysicsComponents & { group: GroupComponent };
type GroupUpdateComponents = PhysicsUpdateComponents & { group?: Uint32Array };

interface Unit {
	x: number
	y: number
	group: number
	velocityX?: number
	velocityY?: number
}

// 10x10 boxes colliding with everything, tagged with their group. Same block feeds the collidable query and the
// per-entity update, as it does on the worker.
function createUnit(unit: Unit, entityId: number): MovingEntity<GroupUpdateComponents> {
	const transform = new Float32Array(TRANSFORM_SIZE);
	transform[TRANSFORM_X_INDEX] = unit.x;
	transform[TRANSFORM_Y_INDEX] = unit.y;
	transform[TRANSFORM_WIDTH_INDEX] = 10;
	transform[TRANSFORM_HEIGHT_INDEX] = 10;

	const velocity = new Float32Array(VELOCITY_SIZE);
	velocity[VELOCITY_X_INDEX] = unit.velocityX ?? 0;
	velocity[VELOCITY_Y_INDEX] = unit.velocityY ?? 0;

	const body = new Uint32Array(BODY_SIZE);
	body[BODY_FLAGS_INDEX] = SHAPE_RECTANGLE;
	body[BODY_CATEGORY_INDEX] = DEFAULT_COLLIDE_CATEGORY;
	body[BODY_MASK_INDEX] = DEFAULT_COLLIDE_MASK;

	const entity = new Uint32Array(2);
	entity[DEAD_INDEX] = 0;

	const group = new Uint32Array(1);
	group[GROUP_INDEX] = unit.group;

	return { entityId, components: { transform, velocity, body, entity, group } };
}

interface RunResult {
	collisions: Array<string>
	positions: Array<[number, number]>
}

// One run over the list, entity ids are list positions + 1. Drives the update like the worker: preRun once, then
// every entity, all sharing the one collidable list.
function run(units: Array<Unit>, skipGroup?: number, elapsedTime = 1000): RunResult {
	const entities = units.map((unit, index) => createUnit(unit, index + 1));
	const collisions: Array<string> = [];

	const update = createPhysicsUpdate<GroupComponents, GroupUpdateComponents>({
		group: { component: 'group', index: GROUP_INDEX },
		onCollision(_world, self, other) {
			const [a, b] = self.entityId < other.entityId ? [self.entityId, other.entityId] : [other.entityId, self.entityId];
			collisions.push(`${a}-${b}`);
		},
	});

	const world: PhysicsWorld = { gameTime: 0, elapsedTime, tick: 1, skipGroup, getString: () => '' };
	const queries = { [COLLIDABLE_QUERY]: entities };
	const ignored: EntityWorkerSystemCallbacks<GroupComponents> = {
		entityComponentChanged: () => {},
		emitEntityEvent: () => {},
		emitSystemEvent: () => {},
		entityDied: () => {},
		addComponent: () => {},
		removeComponent: () => {},
		createEntity: () => {},
	};

	update.preRun!(world, entities, queries, ignored);
	for(const entity of entities) {
		update(world, entity.entityId, entity.components, queries, ignored);
	}

	return {
		collisions: collisions.sort(),
		positions: entities.map(entity => [entity.components.transform[TRANSFORM_X_INDEX], entity.components.transform[TRANSFORM_Y_INDEX]]),
	};
}

describe('grouped createPhysicsUpdate', () => {
	it('stamps the group onto its metadata for PhysicsSystem to read', () => {
		const update = createPhysicsUpdate<GroupComponents, GroupUpdateComponents>({ group: { component: 'group', index: GROUP_INDEX } });
		expect(update.physics.group).toEqual({ component: 'group', index: GROUP_INDEX });
	});

	it('never collides entities in different groups sharing the same spot', () => {
		expect(run([{ x: 0, y: 0, group: 1 }, { x: 0, y: 0, group: 2 }]).collisions).toEqual([]);
	});

	it('still collides entities in the same group', () => {
		expect(run([{ x: 0, y: 0, group: 1 }, { x: 0, y: 0, group: 1 }]).collisions).toEqual(['1-2']);
	});

	it('sweeps each group against its own tree: a wall stops only its own group', () => {
		// Two identical movers stepping 12 towards a wall at x=20; the wall is in group 1, so only mover 1 rests
		// short against it (~x=10, half-widths touching) while mover 2 sails its full 12 with no wall in group 2.
		const result = run([
			{ x: 0, y: 0, group: 1, velocityX: 12 },
			{ x: 0, y: 100, group: 2, velocityX: 12 },
			{ x: 20, y: 0, group: 1 }, // wall
		]);
		expect(result.positions[0][0]).toBeLessThan(11);
		expect(result.positions[1][0]).toBeCloseTo(12);
	});

	it('leaves the skipped group unmoved and uncollided while stepping the rest', () => {
		const result = run([
			{ x: 0, y: 0, group: 1, velocityX: 50 }, // skipped: must not move
			{ x: 0, y: 0, group: 1 }, // skipped: no collision reported for group 1
			{ x: 0, y: 100, group: 2 }, // stepped; overlaps the other group-2 unit
			{ x: 0, y: 100, group: 2 }, // collides with unit 3
		], 1);

		expect(result.positions[0]).toEqual([0, 0]);
		expect(result.collisions).toEqual(['3-4']);
	});
});
