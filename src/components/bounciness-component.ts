import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// How much speed an entity keeps when it bounces, as a fraction of the velocity that pointed into what it hit:
// 1 is a perfect bounce, 0.5 loses half on each, 0 does not turn around at all. See the bounce in
// createPhysicsUpdate. Only bouncing entities carry this; one without it is still stopped by what it runs into
// (the sweep does that for everything), it just does not rebound.
export interface BouncinessComponent {
	index: number
	bounciness: number
}

// A `bounciness` config loads the component. Defining config from the entity template, so there is no `save`.
export interface BouncinessConfig {
	bounciness?: number
}

// Index into the backing Float32Array block, exported because the bounce reads the same offset off the raw block.
export const BOUNCINESS_INDEX = 0;
export const BOUNCINESS_SIZE = 1;

class BouncinessComponentImpl extends Component<Float32Array> implements BouncinessComponent {
	get bounciness() {
		return this.block[BOUNCINESS_INDEX];
	}
	set bounciness(value: number) {
		this.block[BOUNCINESS_INDEX] = value;
	}
}

export const bouncinessDefinition: ComponentDefinition<BouncinessComponent, Float32Array, BouncinessConfig> = {
	type: Float32Array,
	size: BOUNCINESS_SIZE,
	loadProperties: ['bounciness'],
	toBlock(config) {
		return [config.bounciness ?? 0];
	},
	attach(entity, memory, index) {
		return new BouncinessComponentImpl(memory.getBlock(index), index);
	},
};

export default bouncinessDefinition;
