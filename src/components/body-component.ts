import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// What an entity collides as and what it collides with. A body is loaded for anything with a size, so the way
// to opt out is `collideCategory: 0`, not leaving the component off. Categories are the game's to name; the
// library only reads them as bits.
export interface BodyComponent {
	index: number
	shape: number
	collideCategory: number
	collideMask: number
	// A sensor takes part in detection - a mover overlapping it still gets its onCollision - but stops nothing:
	// nothing is swept short against it or bounces off it. Only about the response; it obeys canCollide unchanged.
	sensor: boolean
	// When set, this body's own move is tested along its whole path this run rather than only where it ends.
	continuousCollisionDetection: boolean
}

// The shapes a body can be, all held in the same transform (position, width, height, angle):
//   SHAPE_RECTANGLE - a width x height box turned to `angle`
//   SHAPE_CIRCLE    - a circle of diameter `width`, unaffected by `angle`
//   SHAPE_CAPSULE   - `width` end to end and `height` thick, lying along the way it faces
// See src/math/shapes.ts for the geometry.
export const SHAPE_RECTANGLE = 1;
export const SHAPE_CIRCLE = 2;
export const SHAPE_CAPSULE = 3;

const KNOWN_SHAPES = [SHAPE_RECTANGLE, SHAPE_CIRCLE, SHAPE_CAPSULE];

// Default category: a single bit, so a world that sets no categories behaves as before they existed.
export const DEFAULT_COLLIDE_CATEGORY = 1;
// Default mask: every bit, so a default body meets anything whose own mask allows it. Stored in a Uint32Array,
// so 0xFFFFFFFF ANDs correctly against any category despite not fitting a signed int.
export const DEFAULT_COLLIDE_MASK = 0xFFFFFFFF;

// Whether two bodies collide: each side's mask must accept the other's category. Symmetric by design, so the
// outcome does not depend on which entity moved first; a one-sided response is done by checking `other` inside
// onCollision. `collideCategory: 0` collides with nothing. `&` is signed, so compare against 0, not > 0.
export function canCollide(categoryA: number, maskA: number, categoryB: number, maskB: number): boolean {
	return (maskA & categoryB) !== 0 && (maskB & categoryA) !== 0;
}

// A size loads a body, as it loads a transform: anything with a place in the world is collidable by default,
// and the collide properties narrow that. All defining config from the entity template, so there is no `save`.
export interface BodyConfig {
	// Not read by the loader, only listed in `loadProperties`: they mark a config as having a place in the world.
	width?: number
	height?: number

	// One of the SHAPE_ constants. Defaults to a circle for a `radius` config and a rectangle otherwise, so only
	// capsules name their shape.
	shape?: number
	// Not read here - the transform turns it into width/height - but a `radius` config decides the default shape.
	radius?: number
	// The bits this entity collides as, and the bits it collides with. See canCollide.
	collideCategory?: number
	collideMask?: number
	// Makes the body a sensor: found and reported, but never blocking or bounced off. Defaults to solid.
	sensor?: boolean
	continuousCollisionDetection?: boolean
}

// Indexes into the backing Uint32Array block, exported because the broadphase reads the same offsets off the
// raw shared block.
export const BODY_SHAPE_INDEX = 0;
export const BODY_CATEGORY_INDEX = 1;
export const BODY_MASK_INDEX = 2;
// 1 for a sensor, 0 for solid. In the block, not a JS flag, so the broadphase and bounce read it on the worker.
export const BODY_SENSOR_INDEX = 3;
export const BODY_CCD_INDEX = 4;
export const BODY_SIZE = 5;

// Whether a body block is a sensor. Exported so a game system reads the flag the way the broadphase does.
export function isSensor(body: Uint32Array): boolean {
	return body[BODY_SENSOR_INDEX] !== 0;
}

export const bodyDefinition: ComponentDefinition<BodyComponent, Uint32Array, BodyConfig> = {
	type: Uint32Array,
	size: BODY_SIZE,
	loadProperties: ['width', 'height', 'radius', 'shape', 'collideCategory', 'collideMask', 'sensor', 'continuousCollisionDetection'],
	load(entity, memory, config) {
		const index = memory.create([
			toShape(config),
			config.collideCategory ?? DEFAULT_COLLIDE_CATEGORY,
			config.collideMask ?? DEFAULT_COLLIDE_MASK,
			config.sensor ? 1 : 0,
			config.continuousCollisionDetection ? 1 : 0,
		]);
		const block = memory.getBlock(index);

		return {
			index,
			get shape() {
				return block[BODY_SHAPE_INDEX];
			},
			set shape(value: number) {
				block[BODY_SHAPE_INDEX] = value;
			},
			get collideCategory() {
				return block[BODY_CATEGORY_INDEX];
			},
			set collideCategory(value: number) {
				block[BODY_CATEGORY_INDEX] = value;
			},
			get collideMask() {
				return block[BODY_MASK_INDEX];
			},
			set collideMask(value: number) {
				block[BODY_MASK_INDEX] = value;
			},
			get sensor() {
				return block[BODY_SENSOR_INDEX] !== 0;
			},
			set sensor(value: boolean) {
				block[BODY_SENSOR_INDEX] = value ? 1 : 0;
			},
			get continuousCollisionDetection() {
				return block[BODY_CCD_INDEX] !== 0;
			},
			set continuousCollisionDetection(value: boolean) {
				block[BODY_CCD_INDEX] = value ? 1 : 0;
			},
		};
	},
};

// An unknown shape throws rather than defaulting: colliding with the wrong outline is harder to spot than a
// failed load. A config that names no shape is read off its size - `radius` is a circle, anything else a rectangle.
function toShape(config: BodyConfig): number {
	const shape = config.shape;
	if(shape === undefined) {
		return config.radius !== undefined ? SHAPE_CIRCLE : SHAPE_RECTANGLE;
	} else if(!KNOWN_SHAPES.includes(shape)) {
		throw new Error(`Unknown body shape: ${shape}`);
	}

	return shape;
}

export default bodyDefinition;
