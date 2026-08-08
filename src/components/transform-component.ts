import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// Where an entity is, how big it is, and which way it faces: a position, its box, and the box's rotation.
export interface TransformComponent {
	index: number
	x: number
	y: number
	width: number
	height: number
	angle: number
}

// The defining half of a transform, from the entity template: the size that gives an entity a transform at all
// (a config with no size does not load one). `width`/`height` are the unrotated box and required, since a
// zero-area box never overlaps anything. `angle` is radians counter-clockwise from +x, the game's to set. A
// round entity may give a `radius` instead, loaded as a width and height of its diameter; both at once throws.
export interface TransformConfig {
	width: number
	height: number
	angle?: number
	radius?: number
}
// The live runtime half: the physics system moves the position every run, so it round-trips through `save`. Size
// and facing come back from the template. `x`/`y` are the centre of the box, not a corner.
export interface TransformSerialization {
	x: number
	y: number
}

// Indexes into the backing Float32Array block, exported because the physics update reads the same offsets off
// the raw block.
export const TRANSFORM_X_INDEX = 0;
export const TRANSFORM_Y_INDEX = 1;
export const TRANSFORM_WIDTH_INDEX = 2;
export const TRANSFORM_HEIGHT_INDEX = 3;
export const TRANSFORM_ANGLE_INDEX = 4;
export const TRANSFORM_SIZE = 5;

export const transformDefinition: ComponentDefinition<TransformComponent, Float32Array, TransformConfig, TransformSerialization> = {
	type: Float32Array,
	size: TRANSFORM_SIZE,
	// A size marks a config as having a transform. x/y are not listed: they come off a save, not the template.
	loadProperties: ['width', 'height', 'radius'],
	load(entity, memory, config) {
		// A radius is the same size said differently; turn it into width/height so nothing downstream cares. Both
		// at once cannot be honoured, so it throws rather than picking a winner.
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
