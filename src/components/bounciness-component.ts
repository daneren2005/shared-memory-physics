import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// How much of its speed an entity keeps when it bounces off something it ran into, as a fraction of the part of
// its velocity that pointed *into* what it hit.  The physics system reflects that entity about the contact
// normal on collision and scales the reflected part by this - see the bounce in createPhysicsUpdate.
//
//   1   - a perfect bounce: the velocity into the surface comes straight back out at the same speed, so a
//         head-on hit simply flips the velocity and the entity keeps running forever.
//   0.5 - half of that speed comes back, so the entity loses half its speed into the wall on each bounce.
//   0   - nothing bounces: the velocity into the surface is cancelled and only the part sliding along it is
//         left, so the entity comes to rest against the wall rather than rebounding off it.
//
// Only entities that actually bounce carry this - it is loaded off a config that names `bounciness`, so a world
// of terrain and walls pays nothing for it.  An entity without it is still stopped by what it runs into (the
// sweep does that for everything); it just does not turn around.
export interface BouncinessComponent {
	index: number
	bounciness: number
}

// A config that gives a `bounciness` is what loads the component, the same way a size is what loads a transform.
// It is defining config out of a game's entity template - the material an entity is made of rather than live
// state - which is why there is no `save`: a reloaded entity gets its bounciness back from the template.
export interface BouncinessConfig {
	bounciness?: number
}

// The one index into the backing Float32Array block.  The bounce reads the same offset off the raw shared block,
// so it is exported for it (and for any game system that touches the block directly).
export const BOUNCINESS_INDEX = 0;
export const BOUNCINESS_SIZE = 1;

export const bouncinessDefinition: ComponentDefinition<BouncinessComponent, Float32Array, BouncinessConfig> = {
	type: Float32Array,
	size: BOUNCINESS_SIZE,
	loadProperties: ['bounciness'],
	load(entity, memory, config) {
		const index = memory.create([config.bounciness ?? 0]);
		const block = memory.getBlock(index);

		return {
			index,
			get bounciness() {
				return block[BOUNCINESS_INDEX];
			},
			set bounciness(value: number) {
				block[BOUNCINESS_INDEX] = value;
			},
		};
	},
};

export default bouncinessDefinition;
