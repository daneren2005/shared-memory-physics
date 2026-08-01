import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

// What an entity collides *as*, and what it is willing to collide *with*.  Only entities with a body take part
// in collisions at all - but a body is loaded for anything with a size, so in practice the way to opt an entity
// out is `collideCategory: 0` rather than leaving the component off.
//
// The categories themselves are the game's to name.  This library only ever reads them as bits, so a game
// declares whatever set it needs (ground, air, projectile, terrain, ...) and hands the numbers in through the
// config.
export interface BodyComponent {
	index: number
	shape: number
	collideCategory: number
	collideMask: number
	// Whether this body is a sensor: it takes part in collision *detection* - a mover that overlaps it still gets
	// its onCollision, and it can still be found by a spatial-index search - but it stops nothing.  Nothing is
	// swept short against it and nothing bounces off it, so a solid entity passes straight through where it would
	// come to rest against an ordinary body.  See canCollide for the category/mask rules, which a sensor obeys
	// unchanged: sensor is only about the *response*, not about which pairs are looked at.
	sensor: boolean
}

// The shapes a body can be.  All three are held in the same transform - a position, a width, a height and an
// angle - so which one an entity is changes what that data means rather than where it lives:
//
//   SHAPE_RECTANGLE - a width x height box turned to `angle`
//   SHAPE_CIRCLE    - a circle of diameter `width`, which `angle` does not affect
//   SHAPE_CAPSULE   - a capsule `width` from end to end and `height` thick, lying along the way it faces
//
// See src/math/shapes.ts for what each one means geometrically.
export const SHAPE_RECTANGLE = 1;
export const SHAPE_CIRCLE = 2;
export const SHAPE_CAPSULE = 3;

const KNOWN_SHAPES = [SHAPE_RECTANGLE, SHAPE_CIRCLE, SHAPE_CAPSULE];

// What a body collides as when the game does not say: a single bit, so a world where nothing sets a category
// behaves exactly as it did before categories existed.
export const DEFAULT_COLLIDE_CATEGORY = 1;
// ...and what it is willing to collide with: every bit, so a default body meets anything whose own mask lets
// it.  0xFFFFFFFF does not fit in a signed int, but it is stored in a Uint32Array and JS bitwise operators
// work on the same 32 bits, so it ANDs correctly against any category a game can supply.
export const DEFAULT_COLLIDE_MASK = 0xFFFFFFFF;

// Whether two bodies collide: each side's mask has to accept the other's category.
//
// The test is deliberately **symmetric**, so a pair either collides or does not regardless of which one moved
// into which.  That matters because collisions are reported per entity as each one moves: a rule that depended
// on the direction would make the outcome depend on the order the system happened to move them in.  A game
// that wants a one-sided *response* - a projectile that hurts a unit without the unit hurting it back - gets
// that by checking `other` inside its own onCollision, not by the two entities disagreeing about whether they
// touched.
//
// So a ground unit that should be hit by projectiles has to name projectiles in its own mask, not just the
// other way round.  `collideCategory: 0` collides with nothing at all, since every mask ANDs to 0 against it.
//
// `&` yields a signed 32 bit result, so a mask with the top bit set comes back negative - compare against 0
// rather than testing for a positive number.
export function canCollide(categoryA: number, maskA: number, categoryB: number, maskB: number): boolean {
	return (maskA & categoryB) !== 0 && (maskB & categoryA) !== 0;
}

// A size is what loads a body, the same way it is what loads a transform: anything big enough to be in the
// world is collidable by default, and the collide properties are there to narrow that rather than to grant it.
// They are all *defining* config out of a game's entity template, which is why there is no `save` below - a
// reloaded entity gets its category and mask back from the template, not from the save.
export interface BodyConfig {
	// Not read by the loader, only listed in `loadProperties`: they are what marks a config as describing
	// something that has a place in the world, and so something that can be run into.
	width?: number
	height?: number

	// One of the SHAPE_ constants above.  Defaults to a circle for a config given a `radius` and a rectangle
	// otherwise, so only capsules have to name their shape.
	shape?: number
	// Not read here either - the transform is what turns it into a width and a height - but a config that gives
	// a radius is describing a circle, and that is what decides the default shape above.
	radius?: number
	// The bit(s) this entity collides as, and the bits it is willing to collide with.  See canCollide.
	collideCategory?: number
	collideMask?: number
	// Makes the body a sensor: found and reported like any other, but never blocking or bounced off, so movers
	// pass through it.  Defaults to false - a body that says nothing is solid.  See BodyComponent#sensor.
	sensor?: boolean
}

// Indexes into the backing Uint32Array block.  The collision broadphase reads the same offsets off the raw
// shared block, so they are exported for it (and for any game system that touches the block directly).
export const BODY_SHAPE_INDEX = 0;
export const BODY_CATEGORY_INDEX = 1;
export const BODY_MASK_INDEX = 2;
// 1 for a sensor, 0 for an ordinary solid body.  Held in the block rather than as a JS flag so the broadphase
// and the bounce - both of which read the raw shared array on the worker thread - can see it the same way they
// see the shape and the collide bits.
export const BODY_SENSOR_INDEX = 3;
export const BODY_SIZE = 4;

// Whether a body block is a sensor.  Exported so a game system touching the block directly reads the flag the
// same way the library's own broadphase and bounce do, rather than hard-coding the offset and the `!== 0`.
export function isSensor(body: Uint32Array): boolean {
	return body[BODY_SENSOR_INDEX] !== 0;
}

export const bodyDefinition: ComponentDefinition<BodyComponent, Uint32Array, BodyConfig> = {
	type: Uint32Array,
	size: BODY_SIZE,
	loadProperties: ['width', 'height', 'radius', 'shape', 'collideCategory', 'collideMask', 'sensor'],
	load(entity, memory, config) {
		const index = memory.create([
			toShape(config),
			config.collideCategory ?? DEFAULT_COLLIDE_CATEGORY,
			config.collideMask ?? DEFAULT_COLLIDE_MASK,
			config.sensor ? 1 : 0,
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
			// Stored as 1/0 in the block but read and written as a boolean here, so a game toggles a sensor on and
			// off the same way it reads it - the block form is an implementation detail the broadphase shares.
			get sensor() {
				return block[BODY_SENSOR_INDEX] !== 0;
			},
			set sensor(value: boolean) {
				block[BODY_SENSOR_INDEX] = value ? 1 : 0;
			},
		};
	},
};

// An unknown shape is thrown on rather than defaulted: silently treating it as a rectangle would leave an
// entity colliding with the wrong outline, which is far harder to spot than a config that fails to load.
//
// A config that says nothing is read off the size it gave instead - a `radius` describes a circle, and anything
// else is a rectangle - so a game only has to name a shape for the one case its size cannot imply.
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
