import { BaseWorld } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition, ComponentsOf, EntityConfigOf } from '@daneren2005/shared-memory-ecs';
import { physicsRegistry } from '../../components/registry';

// A stand-in game component, so tests run against the same shape a game has, not a physics-only world.
export interface TagComponent {
	index: number
	tag: number
}
export const tagDefinition: ComponentDefinition<TagComponent, Int32Array, { tag: number }> = {
	type: Int32Array,
	size: 1,
	loadProperties: ['tag'],
	load(entity, memory, config) {
		const index = memory.create([config.tag]);
		const block = memory.getBlock(index);

		return {
			index,
			get tag() {
				return block[0];
			},
			set tag(value: number) {
				block[0] = value;
			},
		};
	},
};

// A game component a collision callback reaches through `optional`, so a collision can take a bite out of it.
export interface HealthComponent {
	index: number
	health: number
}
export const HEALTH_INDEX = 0;
export const healthDefinition: ComponentDefinition<HealthComponent, Float32Array, { health: number }> = {
	type: Float32Array,
	size: 1,
	loadProperties: ['health'],
	load(entity, memory, config) {
		const index = memory.create([config.health]);
		const block = memory.getBlock(index);

		return {
			index,
			get health() {
				return block[HEALTH_INDEX];
			},
			set health(value: number) {
				block[HEALTH_INDEX] = value;
			},
		};
	},
};

export const registry = {
	...physicsRegistry,
	tag: tagDefinition,
	health: healthDefinition,
};

export type Components = ComponentsOf<typeof registry>;
export type Config = EntityConfigOf<typeof registry>;
export type TestWorld = BaseWorld<typeof registry>;

export function createTestWorld(): TestWorld {
	return new BaseWorld(registry);
}
