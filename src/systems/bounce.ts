import { BODY_SENSOR_INDEX, BODY_SHAPE_INDEX, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '../components/body-component';
import { BOUNCINESS_INDEX } from '../components/bounciness-component';
import { TRANSFORM_ANGLE_INDEX, TRANSFORM_HEIGHT_INDEX, TRANSFORM_WIDTH_INDEX, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../components/transform-component';
import { VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../components/velocity-component';
import { shapeHalfHeight, shapeHalfWidth } from '../math/shapes';
import type { PhysicsUpdateComponents } from '../components/registry';
import type { CollisionEntity, MovingEntity } from './collision';

interface Vector {
	x: number
	y: number
}

// Scratch, reused rather than allocated: a run is one unbroken pass, never re-entered part way through.
const NORMAL: Vector = { x: 0, y: 0 };
const SELF_HALF: Vector = { x: 0, y: 0 };
const OTHER_HALF: Vector = { x: 0, y: 0 };

// Turns `self` around off `other` and writes the new heading into its velocity block. `bounciness` is how much
// of the speed into the surface comes back: 1 reflects perfectly, 0 cancels it (slide along the surface) - see
// BouncinessComponent. Only `self` is touched; two movers that hit each other each get their own swapped call.
export function bounce<T extends PhysicsUpdateComponents>(self: MovingEntity<T>, other: CollisionEntity<T>): void {
	const bounciness = self.components.bounciness;
	if(!bounciness) {
		return;
	}

	// A sensor is felt only through onCollision, never as a surface, so neither side bounces. The pair is still
	// reported - this returns from the bounce, not the collision.
	if(isSensorBody(self.components.body) || isSensorBody(other.components.body)) {
		return;
	}

	if(!collisionNormal(self, other, NORMAL)) {
		return;
	}

	const velocity = self.components.velocity;
	const velocityX = velocity[VELOCITY_X_INDEX];
	const velocityY = velocity[VELOCITY_Y_INDEX];

	// How much of the velocity points into what it hit. Zero or more means it is already on its way out, and
	// reflecting again while the two still overlap would turn it straight back in.
	const into = velocityX * NORMAL.x + velocityY * NORMAL.y;
	if(into >= 0) {
		return;
	}

	// Reverse the normal component and scale by bounciness, leaving the surface component alone. Scale is 2 at
	// bounciness 1 (mirror reflection) and 1 at 0 (removes the normal component, sliding along the surface).
	const scale = (1 + bounciness[BOUNCINESS_INDEX]) * into;
	velocity[VELOCITY_X_INDEX] = velocityX - scale * NORMAL.x;
	velocity[VELOCITY_Y_INDEX] = velocityY - scale * NORMAL.y;
}

// Which way `self` is pushed off `other`, as a unit vector, or false when the two are exactly on top of each
// other and there is no such direction.
function collisionNormal<T extends PhysicsUpdateComponents>(self: MovingEntity<T>, other: CollisionEntity<T>, out: Vector): boolean {
	const selfTransform = self.components.transform;
	const otherTransform = other.components.transform;
	const dx = selfTransform[TRANSFORM_X_INDEX] - otherTransform[TRANSFORM_X_INDEX];
	const dy = selfTransform[TRANSFORM_Y_INDEX] - otherTransform[TRANSFORM_Y_INDEX];

	const selfShape = shapeOf(self.components.body);
	const otherShape = shapeOf(other.components.body);

	// Two circles touch at one point; the normal is the line between their centres.
	if(selfShape === SHAPE_CIRCLE && otherShape === SHAPE_CIRCLE) {
		const distance = Math.sqrt(dx * dx + dy * dy);
		if(distance === 0) {
			return false;
		}

		out.x = dx / distance;
		out.y = dy / distance;

		return true;
	}

	// Anything with a flat side bounces off the axis of least overlap - the face that was hit. A circle against
	// a tall thin wall barely overlaps in x, so x wins and the bounce is horizontal; the centre-to-centre line
	// above would get this badly wrong, the wall's centre being far off screen.
	halfSize(selfTransform, selfShape, SELF_HALF);
	halfSize(otherTransform, otherShape, OTHER_HALF);
	const overlapX = SELF_HALF.x + OTHER_HALF.x - Math.abs(dx);
	const overlapY = SELF_HALF.y + OTHER_HALF.y - Math.abs(dy);

	if(overlapX < overlapY) {
		out.x = dx < 0 ? -1 : 1;
		out.y = 0;
	} else {
		out.x = 0;
		out.y = dy < 0 ? -1 : 1;
	}

	return true;
}

// A size-only entity with no body collides as a rectangle.
function shapeOf(body: Uint32Array | undefined): number {
	return body ? body[BODY_SHAPE_INDEX] : SHAPE_RECTANGLE;
}

// A missing body is a solid, not a sensor.
function isSensorBody(body: Uint32Array | undefined): boolean {
	return body !== undefined && body[BODY_SENSOR_INDEX] !== 0;
}

// How far the shape reaches from its centre along each axis at its rotation - the broadphase's boxing numbers.
function halfSize(transform: Float32Array, shape: number, out: Vector): void {
	const width = transform[TRANSFORM_WIDTH_INDEX];
	const height = transform[TRANSFORM_HEIGHT_INDEX];
	const angle = transform[TRANSFORM_ANGLE_INDEX];

	out.x = shapeHalfWidth(shape, width, height, angle);
	out.y = shapeHalfHeight(shape, width, height, angle);
}

export default bounce;
