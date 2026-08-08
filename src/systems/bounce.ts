import { BODY_SENSOR_INDEX, BODY_SHAPE_INDEX, SHAPE_RECTANGLE } from '../components/body-component';
import { BOUNCINESS_INDEX } from '../components/bounciness-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import { contactNormal } from '../math/shapes';
import type { Vector } from '../math/shapes';

interface BounceEntity {
	components: {
		transform: Float32Array
		velocity?: Float32Array
		bounciness?: Float32Array
		body?: Uint32Array
	}
}

// Scratch, reused rather than allocated: a run is one unbroken pass, never re-entered part way through.
const NORMAL: Vector = { x: 0, y: 0 };

// Turns both sides of a contact around, each by its own bounciness. The two leave along the same line, so the
// normal is worked out once and the far side is turned round rather than asked for again.
export function bouncePair(self: BounceEntity, other: BounceEntity): void {
	if(!canBounce(self) && !canBounce(other)) {
		return;
	}

	if(isSurface(self, other) && collisionNormal(self, other, NORMAL)) {
		reflect(self, NORMAL.x, NORMAL.y);
		reflect(other, -NORMAL.x, -NORMAL.y);
	}
}

// Turns `self` around off `other` and writes the new heading into its velocity block. `bounciness` is how much
// of the speed into the surface comes back: 1 reflects perfectly, 0 cancels it (slide along the surface) - see
// BouncinessComponent. Only `self` is touched.
export function bounce(self: BounceEntity, other: BounceEntity): void {
	if(!canBounce(self) || !isSurface(self, other)) {
		return;
	}

	if(collisionNormal(self, other, NORMAL)) {
		reflect(self, NORMAL.x, NORMAL.y);
	}
}

// Mirrors an entity's velocity about a surface it is leaving along `normal`, a unit vector pointing away from it.
function reflect(entity: BounceEntity, normalX: number, normalY: number): void {
	const bounciness = entity.components.bounciness;
	const velocity = entity.components.velocity;
	if(!bounciness || !velocity) {
		return;
	}

	const velocityX = velocity[VELOCITY_X_INDEX];
	const velocityY = velocity[VELOCITY_Y_INDEX];

	// How much of the velocity points into what it hit. Zero or more means it is already on its way out, and
	// reflecting again while the two still overlap would turn it straight back in.
	const into = velocityX * normalX + velocityY * normalY;
	if(into >= 0) {
		return;
	}

	// Reverse the normal component and scale by bounciness, leaving the surface component alone. Scale is 2 at
	// bounciness 1 (mirror reflection) and 1 at 0 (removes the normal component, sliding along the surface).
	const scale = (1 + bounciness[BOUNCINESS_INDEX]) * into;
	velocity[VELOCITY_X_INDEX] = velocityX - scale * normalX;
	velocity[VELOCITY_Y_INDEX] = velocityY - scale * normalY;
}

function canBounce(entity: BounceEntity): boolean {
	return entity.components.bounciness !== undefined && entity.components.velocity !== undefined;
}

// A sensor is felt only through onCollision, never as a surface, so neither side bounces. The pair is still
// reported - this decides the bounce, not the collision.
function isSurface(self: BounceEntity, other: BounceEntity): boolean {
	return !isSensorBody(self.components.body) && !isSensorBody(other.components.body);
}

// Which way `self` is pushed off `other`, as a unit vector, or false when the two are exactly on top of each
// other and there is no such direction. Taken off the shapes themselves, at the angle they are turned to, so a
// contact that is not square to the world still reflects the speed that was closing on it.
function collisionNormal(self: BounceEntity, other: BounceEntity, out: Vector): boolean {
	const selfTransform = self.components.transform;
	const otherTransform = other.components.transform;

	return contactNormal(
		shapeOf(self.components.body),
		selfTransform[TRANSFORM_X_INDEX], selfTransform[TRANSFORM_Y_INDEX],
		selfTransform[TRANSFORM_WIDTH_INDEX], selfTransform[TRANSFORM_HEIGHT_INDEX], selfTransform[TRANSFORM_ANGLE_INDEX],
		shapeOf(other.components.body),
		otherTransform[TRANSFORM_X_INDEX], otherTransform[TRANSFORM_Y_INDEX],
		otherTransform[TRANSFORM_WIDTH_INDEX], otherTransform[TRANSFORM_HEIGHT_INDEX], otherTransform[TRANSFORM_ANGLE_INDEX],
		out,
	);
}

// A size-only entity with no body collides as a rectangle.
function shapeOf(body: Uint32Array | undefined): number {
	return body ? body[BODY_SHAPE_INDEX] : SHAPE_RECTANGLE;
}

// A missing body is a solid, not a sensor.
function isSensorBody(body: Uint32Array | undefined): boolean {
	return body !== undefined && body[BODY_SENSOR_INDEX] !== 0;
}

export default bounce;
