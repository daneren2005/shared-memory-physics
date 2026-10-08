import {
	SHAPE_RECTANGLE,
	SHAPE_CIRCLE,
	SHAPE_CAPSULE,
	SHAPE_POLYGON,
	DEFAULT_COLLIDE_CATEGORY,
	DEFAULT_COLLIDE_MASK,
	BODY_FLAGS_INDEX,
	BODY_CATEGORY_INDEX,
	BODY_MASK_INDEX,
	BODY_SIZE,
	BODY_SHAPE_MASK,
	BODY_SENSOR_FLAG,
	BODY_CCD_FLAG,
	BODY_DYING_FLAG,
	BODY_BLOCKS_PATH_FLAG,
} from './body-component-constants';
import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';
import type { PolygonVertex } from './polygon-component';

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
	// A hint for pathfinding to route around this body. Physics never reads it; it assumes the body never moves.
	blocksPath: boolean
}

const KNOWN_SHAPES = [SHAPE_RECTANGLE, SHAPE_CIRCLE, SHAPE_CAPSULE, SHAPE_POLYGON];

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
	vertices?: ReadonlyArray<PolygonVertex>
	// The bits this entity collides as, and the bits it collides with. See canCollide.
	collideCategory?: number
	collideMask?: number
	// Makes the body a sensor: found and reported, but never blocking or bounced off. Defaults to solid.
	sensor?: boolean
	continuousCollisionDetection?: boolean
	// Marks the body as something pathfinding routes around. Defaults to false.
	blocksPath?: boolean
}

// Readers off a raw body block, exported so the broadphase, bounce and game systems unpack the flags the same way.
export function bodyShape(body: Uint32Array): number {
	return body[BODY_FLAGS_INDEX] & BODY_SHAPE_MASK;
}
export function isSensor(body: Uint32Array): boolean {
	return (body[BODY_FLAGS_INDEX] & BODY_SENSOR_FLAG) !== 0;
}
export function isContinuous(body: Uint32Array): boolean {
	return (body[BODY_FLAGS_INDEX] & BODY_CCD_FLAG) !== 0;
}
export function blocksPath(body: Uint32Array): boolean {
	return (body[BODY_FLAGS_INDEX] & BODY_BLOCKS_PATH_FLAG) !== 0;
}
export function isDying(body: Uint32Array): boolean {
	return (body[BODY_FLAGS_INDEX] & BODY_DYING_FLAG) !== 0;
}
// Sets the dying flag. One-way for the entity's remaining life - nothing clears it, since a dying entity is gone
// a run later.
export function markDying(body: Uint32Array): void {
	body[BODY_FLAGS_INDEX] |= BODY_DYING_FLAG;
}

class BodyComponentImpl extends Component<Uint32Array> implements BodyComponent {
	get shape() {
		return this.block[BODY_FLAGS_INDEX] & BODY_SHAPE_MASK;
	}
	set shape(value: number) {
		this.block[BODY_FLAGS_INDEX] = (this.block[BODY_FLAGS_INDEX] & ~BODY_SHAPE_MASK) | (value & BODY_SHAPE_MASK);
	}
	get collideCategory() {
		return this.block[BODY_CATEGORY_INDEX];
	}
	set collideCategory(value: number) {
		this.block[BODY_CATEGORY_INDEX] = value;
	}
	get collideMask() {
		return this.block[BODY_MASK_INDEX];
	}
	set collideMask(value: number) {
		this.block[BODY_MASK_INDEX] = value;
	}
	get sensor() {
		return (this.block[BODY_FLAGS_INDEX] & BODY_SENSOR_FLAG) !== 0;
	}
	set sensor(value: boolean) {
		this.block[BODY_FLAGS_INDEX] = value ? (this.block[BODY_FLAGS_INDEX] | BODY_SENSOR_FLAG) : (this.block[BODY_FLAGS_INDEX] & ~BODY_SENSOR_FLAG);
	}
	get continuousCollisionDetection() {
		return (this.block[BODY_FLAGS_INDEX] & BODY_CCD_FLAG) !== 0;
	}
	set continuousCollisionDetection(value: boolean) {
		this.block[BODY_FLAGS_INDEX] = value ? (this.block[BODY_FLAGS_INDEX] | BODY_CCD_FLAG) : (this.block[BODY_FLAGS_INDEX] & ~BODY_CCD_FLAG);
	}
	get blocksPath() {
		return (this.block[BODY_FLAGS_INDEX] & BODY_BLOCKS_PATH_FLAG) !== 0;
	}
	set blocksPath(value: boolean) {
		this.block[BODY_FLAGS_INDEX] = value ? (this.block[BODY_FLAGS_INDEX] | BODY_BLOCKS_PATH_FLAG) : (this.block[BODY_FLAGS_INDEX] & ~BODY_BLOCKS_PATH_FLAG);
	}
}

export const bodyDefinition: ComponentDefinition<BodyComponent, Uint32Array, BodyConfig> = {
	type: Uint32Array,
	size: BODY_SIZE,
	loadProperties: ['width', 'height', 'radius', 'vertices', 'shape', 'collideCategory', 'collideMask', 'sensor', 'continuousCollisionDetection', 'blocksPath'],
	toBlock(config) {
		return [
			toFlags(config),
			config.collideCategory ?? DEFAULT_COLLIDE_CATEGORY,
			config.collideMask ?? DEFAULT_COLLIDE_MASK,
		];
	},
	attach(entity, memory, index) {
		return new BodyComponentImpl(memory.getBlock(index), index);
	},
};

// Packs the config's shape and boolean flags into the single flags word stored at BODY_FLAGS_INDEX.
function toFlags(config: BodyConfig): number {
	let flags = toShape(config);
	if(config.sensor) {
		flags |= BODY_SENSOR_FLAG;
	}
	if(config.continuousCollisionDetection) {
		flags |= BODY_CCD_FLAG;
	}
	if(config.blocksPath) {
		flags |= BODY_BLOCKS_PATH_FLAG;
	}

	return flags;
}

// An unknown shape throws rather than defaulting: colliding with the wrong outline is harder to spot than a
// failed load. A config that names no shape is read off its size - `radius` is a circle, anything else a rectangle.
function toShape(config: BodyConfig): number {
	const shape = config.shape;
	if(shape === undefined) {
		return config.vertices !== undefined ? SHAPE_POLYGON : config.radius !== undefined ? SHAPE_CIRCLE : SHAPE_RECTANGLE;
	} else if(!KNOWN_SHAPES.includes(shape)) {
		throw new Error(`Unknown body shape: ${shape}`);
	}
	if(shape === SHAPE_POLYGON && config.vertices === undefined) {
		throw new Error('A polygon body requires vertices');
	}

	return shape;
}

export default bodyDefinition;
