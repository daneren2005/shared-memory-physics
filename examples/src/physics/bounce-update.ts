import {
	BODY_SHAPE_INDEX,
	SHAPE_CIRCLE,
	SHAPE_RECTANGLE,
	TRANSFORM_ANGLE_INDEX,
	TRANSFORM_HEIGHT_INDEX,
	TRANSFORM_WIDTH_INDEX,
	TRANSFORM_X_INDEX,
	TRANSFORM_Y_INDEX,
	VELOCITY_X_INDEX,
	VELOCITY_Y_INDEX,
	createPhysicsUpdate,
	shapeHalfHeight,
	shapeHalfWidth,
} from '@daneren2005/shared-memory-physics';
import type { CollisionEntity, MovingEntity } from '@daneren2005/shared-memory-physics';
import type { Components, ExampleUpdateComponents } from '../world';

interface Vector {
	x: number
	y: number
}

// Scratch, reused rather than allocated: this runs once per collision per run, and the update is never
// re-entered part way through - a run is one unbroken pass over the entities.
const NORMAL: Vector = { x: 0, y: 0 };
const SELF_HALF: Vector = { x: 0, y: 0 };
const OTHER_HALF: Vector = { x: 0, y: 0 };

// The physics update the two bouncing examples run: the library's movement and sweeping, plus a callback that
// turns whatever just ran into something around.
//
// It lives in its own module because both backends have to run the same function - the worker file next door
// imports it and hands it to `createComponentWorker`, and the main thread hands it to `PhysicsSystem` as its
// `updateFunction`.  A callback cannot be posted to a worker, so this shared module is how it gets there.
export const bounceUpdate = createPhysicsUpdate<Components>({
	// `self` has just been moved and has ended up on (or come to rest against) `other`.  Only `self` is
	// touched: `other` gets its own call when its turn to move comes round, with the roles swapped, and a
	// wall never moves at all so it never gets one.
	onCollision(world, self, other) {
		if(!collisionNormal(self, other, NORMAL)) {
			return;
		}

		const velocity = self.components.velocity;
		const velocityX = velocity[VELOCITY_X_INDEX];
		const velocityY = velocity[VELOCITY_Y_INDEX];

		// How much of the velocity points *into* what it hit.  Zero or more means this entity is already on its
		// way out - two that are still overlapping keep reporting the collision for as long as they overlap,
		// and reflecting a second time would turn it straight back in.
		const into = velocityX * NORMAL.x + velocityY * NORMAL.y;
		if(into >= 0) {
			return;
		}

		// A mirror bounce: the part of the velocity along the contact normal is reversed and the part along the
		// surface is left alone, so a glancing hit stays glancing and a head-on one comes straight back.  Speed
		// is unchanged, which is what keeps these examples running forever without winding down or blowing up.
		//
		// Writing the block is all it takes: it is shared memory, so the next run - and the main thread - see
		// the new heading immediately.
		velocity[VELOCITY_X_INDEX] = velocityX - 2 * into * NORMAL.x;
		velocity[VELOCITY_Y_INDEX] = velocityY - 2 * into * NORMAL.y;
	},
});

// Which way `self` should be pushed back off `other`, as a unit vector, or false when the two are exactly on
// top of each other and there is no such direction.
//
// This is the one piece of geometry the library does not supply, because it is a question about the *response*
// rather than about whether the two touch: `shapesOverlap` answers yes or no, and what a game does about it -
// bounce, stop, take damage, explode - is the game's.
function collisionNormal(self: MovingEntity<ExampleUpdateComponents>, other: CollisionEntity<ExampleUpdateComponents>, out: Vector): boolean {
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
	// face that was hit.  A circle against the tall thin left wall overlaps it hugely in y and barely at all in
	// x, so x wins and the bounce is horizontal - which is the answer the centre-to-centre line above would
	// have got badly wrong, the wall's centre being a long way off up the screen.
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

// The body travels with every entity a collision reaches, but the type allows for one without it, so the
// shape a size-only entity would collide as is the fallback.
function shapeOf(body: Uint32Array | undefined): number {
	return body ? body[BODY_SHAPE_INDEX] : SHAPE_RECTANGLE;
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

export default bounceUpdate;
