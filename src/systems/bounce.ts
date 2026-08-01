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

// Scratch, reused rather than allocated: the bounce runs once per collision per run, and the update is never
// re-entered part way through - a run is one unbroken pass over the entities.
const NORMAL: Vector = { x: 0, y: 0 };
const SELF_HALF: Vector = { x: 0, y: 0 };
const OTHER_HALF: Vector = { x: 0, y: 0 };

// Turns `self` around off `other`, having just run into it, and writes the new heading back into its velocity
// block.  `bounciness` is how much of the speed into the surface comes back out: 1 reflects it perfectly (a
// head-on hit flips the velocity), 0 cancels it (the entity slides along the surface and stops pressing into
// it), and values between lose that share of the speed on each bounce - see BouncinessComponent.
//
// Only `self` is touched.  A collision is reported per entity as each one moves, so two entities that run into
// each other each get their own call with the roles swapped and each bounces itself; a wall never moves, so it
// never bounces at all.  Writing the block is all it takes: it is shared memory, so the next run - and the main
// thread - see the new heading immediately.
export function bounce<T extends PhysicsUpdateComponents>(self: MovingEntity<T>, other: CollisionEntity<T>): void {
	const bounciness = self.components.bounciness;
	if(!bounciness) {
		return;
	}

	// Nothing bounces off a sensor, and a sensor bounces off nothing: a sensor is felt only through onCollision,
	// never as a surface, so the two pass through each other and the velocity is left exactly as it was.  The
	// pair is still reported - this is a `return` from the bounce, not from the collision - so a callback that
	// wants to react to the overlap still runs.
	if(isSensorBody(self.components.body) || isSensorBody(other.components.body)) {
		return;
	}

	if(!collisionNormal(self, other, NORMAL)) {
		return;
	}

	const velocity = self.components.velocity;
	const velocityX = velocity[VELOCITY_X_INDEX];
	const velocityY = velocity[VELOCITY_Y_INDEX];

	// How much of the velocity points *into* what it hit.  Zero or more means this entity is already on its way
	// out - two that are still overlapping keep reporting the collision for as long as they overlap, and
	// reflecting a second time would turn it straight back in.
	const into = velocityX * NORMAL.x + velocityY * NORMAL.y;
	if(into >= 0) {
		return;
	}

	// The part of the velocity along the contact normal is reversed and scaled by how bouncy the entity is, and
	// the part along the surface is left alone, so a glancing hit stays glancing and a head-on one comes back.
	// At bounciness 1 the scale is 2, which is a mirror reflection that keeps the speed; at 0 it is 1, which
	// removes the normal component entirely and leaves the entity sliding along the surface.
	const scale = (1 + bounciness[BOUNCINESS_INDEX]) * into;
	velocity[VELOCITY_X_INDEX] = velocityX - scale * NORMAL.x;
	velocity[VELOCITY_Y_INDEX] = velocityY - scale * NORMAL.y;
}

// Which way `self` should be pushed back off `other`, as a unit vector, or false when the two are exactly on
// top of each other and there is no such direction.
function collisionNormal<T extends PhysicsUpdateComponents>(self: MovingEntity<T>, other: CollisionEntity<T>, out: Vector): boolean {
	const selfTransform = self.components.transform;
	const otherTransform = other.components.transform;
	const dx = selfTransform[TRANSFORM_X_INDEX] - otherTransform[TRANSFORM_X_INDEX];
	const dy = selfTransform[TRANSFORM_Y_INDEX] - otherTransform[TRANSFORM_Y_INDEX];

	const selfShape = shapeOf(self.components.body);
	const otherShape = shapeOf(other.components.body);

	// Two circles touch at one point and the normal there is the line between their centres, exactly.
	if(selfShape === SHAPE_CIRCLE && otherShape === SHAPE_CIRCLE) {
		const distance = Math.sqrt(dx * dx + dy * dy);
		if(distance === 0) {
			return false;
		}

		out.x = dx / distance;
		out.y = dy / distance;

		return true;
	}

	// Anything with a flat side is answered by the axis the two are *least* through each other on, which is the
	// face that was hit.  A circle against a tall thin left wall overlaps it hugely in y and barely at all in x,
	// so x wins and the bounce is horizontal - which is the answer the centre-to-centre line above would have
	// got badly wrong, the wall's centre being a long way off up the screen.
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

// The body travels with every entity a collision reaches, but the type allows for one without it, so the shape
// a size-only entity would collide as is the fallback.
function shapeOf(body: Uint32Array | undefined): number {
	return body ? body[BODY_SHAPE_INDEX] : SHAPE_RECTANGLE;
}

// Whether a body block is a sensor, allowing for the entity that arrived without one at all - a size-only entity
// is a solid, not a sensor, so a missing body is false rather than a guess either way.
function isSensorBody(body: Uint32Array | undefined): boolean {
	return body !== undefined && body[BODY_SENSOR_INDEX] !== 0;
}

// How far the shape reaches from its centre along each axis, allowing for whatever it is rotated to - the same
// numbers the library's own broadphase boxes an entity with.
function halfSize(transform: Float32Array, shape: number, out: Vector): void {
	const width = transform[TRANSFORM_WIDTH_INDEX];
	const height = transform[TRANSFORM_HEIGHT_INDEX];
	const angle = transform[TRANSFORM_ANGLE_INDEX];

	out.x = shapeHalfWidth(shape, width, height, angle);
	out.y = shapeHalfHeight(shape, width, height, angle);
}

export default bounce;
