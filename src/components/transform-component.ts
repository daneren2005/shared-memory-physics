import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// Where an entity is in the world, how big it is, and which way it is facing.  This is 2D physics, so the
// transform is a position, the box that sits around it, and the angle that box is rotated to.
export interface TransformComponent {
	index: number
	x: number
	y: number
	width: number
	height: number
	angle: number
}

// How big an entity is and which way it starts out facing.  This is the defining half of a transform: it is
// what a game's entity template says, the same for every ship of a type, and it is what gives an entity a
// transform at all - a config with neither a width nor a height does not load one.
//
// `width`/`height` are the *unrotated* size of the box, and are required: a box with no area never overlaps
// anything, so an entity without a real size could never collide.
//
// `angle` is in radians, measured counter-clockwise from the +x axis, so it feeds Math.cos / Math.sin
// directly.  Nothing in this library writes it - it is the game's to set, usually from its heading - which is
// why it is a starting facing here rather than saved state.
//
// A round entity can give a `radius` **instead of** a width and a height, which loads as a width and a height
// of its diameter - so there is still only one size in the block however the config spelled it.  Giving both
// throws rather than picking a winner.
export interface TransformConfig {
	width: number
	height: number
	angle?: number
	radius?: number
}
// Where the entity is, which is the half that is live runtime state: the physics system moves it every run,
// so it is what has to round-trip through `save` for a saved world to resume where it left off.  The size and
// facing come back from the game's own template rather than the save.
//
// `x`/`y` are the *centre* of the box, not a corner: the box is rotated about that point and collision
// projects out from it in both directions.
export interface TransformSerialization {
	x: number
	y: number
}

// Indexes into the backing Float32Array block.  The physics update reads the same offsets off the raw shared
// block, so they are exported for it (and for any game system that touches the block directly).
export const TRANSFORM_X_INDEX = 0;
export const TRANSFORM_Y_INDEX = 1;
export const TRANSFORM_WIDTH_INDEX = 2;
export const TRANSFORM_HEIGHT_INDEX = 3;
export const TRANSFORM_ANGLE_INDEX = 4;
export const TRANSFORM_SIZE = 5;

export const transformDefinition: ComponentDefinition<TransformComponent, Float32Array, TransformConfig, TransformSerialization> = {
	type: Float32Array,
	size: TRANSFORM_SIZE,
	// A size is what marks a config as having a transform at all.  x/y are not in the list: they come back off
	// a save rather than out of a game's entity template, so on their own they do not describe an entity that
	// has a place in the world.
	loadProperties: ['width', 'height', 'radius'],
	load(entity, memory, config) {
		// A radius is the same size said differently, so it is turned into a width and a height here and nothing
		// downstream has to know which way the config was written.  Both at once is a config that cannot be
		// honoured either way round, so it is refused rather than silently resolved.
		const radius = config.radius;
		let width = config.width;
		let height = config.height;
		if(radius !== undefined) {
			if(width !== undefined || height !== undefined) {
				throw new Error('A transform takes either a radius or a width and height, not both');
			}

			width = height = radius * 2;
		}

		const index = memory.create([config.x, config.y, width, height, config.angle ?? 0]);
		const block = memory.getBlock(index);

		return {
			index,
			get x() {
				return block[TRANSFORM_X_INDEX];
			},
			set x(value: number) {
				block[TRANSFORM_X_INDEX] = value;
			},
			get y() {
				return block[TRANSFORM_Y_INDEX];
			},
			set y(value: number) {
				block[TRANSFORM_Y_INDEX] = value;
			},
			get width() {
				return block[TRANSFORM_WIDTH_INDEX];
			},
			set width(value: number) {
				block[TRANSFORM_WIDTH_INDEX] = value;
			},
			get height() {
				return block[TRANSFORM_HEIGHT_INDEX];
			},
			set height(value: number) {
				block[TRANSFORM_HEIGHT_INDEX] = value;
			},
			get angle() {
				return block[TRANSFORM_ANGLE_INDEX];
			},
			set angle(value: number) {
				block[TRANSFORM_ANGLE_INDEX] = value;
			},
		};
	},
	save(component) {
		return {
			x: component.x,
			y: component.y,
		};
	},
};

export default transformDefinition;
