import {
	SpatialIndex,
	getSpatialMap,
	TRANSFORM_X_INDEX,
	TRANSFORM_Y_INDEX,
	VELOCITY_X_INDEX,
	VELOCITY_Y_INDEX,
} from '@daneren2005/shared-memory-physics';
import type { ComponentSystemWorld, EntityUpdateComponents, EntityUpdateFunction } from '@daneren2005/shared-memory-ecs';
import type { SpatialMapSystemWorld } from '@daneren2005/shared-memory-physics';
import type { Components } from '../world';

// Craig Reynolds' boids, as steering and nothing else.  Every boid looks at the flock around it and works three
// rules into its own velocity - separation (turn away from the ones it is crowding), alignment (fall in with
// their heading) and cohesion (drift toward their middle) - and out of those three local rules a flock falls out
// that no boid is told to make.
//
// **Nothing here moves anything.**  This update writes the velocity block and stops; the position it produces is
// integrated by an ordinary PhysicsSystem running the library's own `physicsUpdate` in a *different* worker, and
// published for the renderer to interpolate by exactly the same code every other example's movement runs through.
// That split is the point: steering is game logic, movement is physics, and the two only meet in shared memory -
// this worker writes velocities, the physics worker reads them, with nothing copied and nothing sent between them.
//
// The two run at the same step and so are usually in flight at the same moment on two different cores, which
// means a physics run can integrate a velocity this one is part way through rewriting.  A float write is not torn,
// so the worst of it is a boid that spends one 50ms step moving on last step's heading in one axis - which is
// exactly the sort of thing a flock absorbs without a visible seam.  Anything that cannot absorb it wants the two
// in one system rather than a lock.

// The knobs a slider beside the canvas tunes live.  They cannot be read from a closure the way a main-thread
// example's settings are - this runs in a worker, which has its own copy of the module - so the page sends them
// across on the per-run world object instead (see SteeringSystem) and they are read back off `world.steering`.
// Held to plain numbers because the world object is structured-cloned to the worker every run.
export interface SteeringParams {
	// Speed is held between these two, every frame: a boid always moving, never running away.  In world units
	// (pixels) per second.
	minSpeed: number
	maxSpeed: number
	// How far a boid looks for flockmates, and the shorter range within which it actively pushes away from them.
	perception: number
	separationRange: number
	// How hard each of the three rules pulls, relative to the others.  These are the three sliders.
	separation: number
	alignment: number
	cohesion: number
}

// The field the flock is kept inside.  It rides across on the world object rather than being a constant in here
// because this update has no business knowing which example is running it - the page hands it whatever level the
// flock was laid out in, and the edge steering below reads it back.
export interface SteeringBounds {
	width: number
	height: number
}

// The world object this update is handed: the base one the ECS always sends, plus the two things the steering
// needs that only the main thread knows.  Both are optional because a run driven by hand may carry neither, in
// which case nothing is steered at all.
export interface SteeringWorld extends ComponentSystemWorld, SpatialMapSystemWorld {
	steering?: SteeringParams
	bounds?: SteeringBounds
}

// The blocks this update works on.  Both are required - the system's query asks for both - which is what lets the
// update read them without a guard per boid per run.  A type alias rather than an interface so it satisfies the
// ECS's index-signature constraint on component maps.
export type SteeringUpdateComponents = {
	transform: Float32Array
	velocity: Float32Array
};

// The most flockmates any one boid folds in per run.  A boid deep in a dense clump has hundreds within its
// perception, and steering off every one costs the same for a result that looks no different from steering off the
// nearest couple of dozen - so the search is capped, which is also what keeps the per-boid cost flat as the flock
// grows rather than climbing with the crowding.
const MAX_NEIGHBORS = 20;

// How near the edge a boid starts being turned back, and how hard.  Boids carry no body, so the walls every other
// example is stopped by are not even in their way - instead a boid feels a push back inward over this margin,
// which reads as the flock banking away from the edge rather than bouncing off it.
const EDGE_MARGIN = 70;
const EDGE_TURN = 320;

// Built in preRun and read by every boid update that follows in the same run.  A run is one unbroken pass, so a
// plain closure variable is safe: there is never a second run part way through this one to replace it.  Undefined
// only for an update driven by hand with no preRun, in which case a boid simply flies straight.
let flock: SpatialIndex<SteeringUpdateComponents> | undefined;

export const steeringUpdate: EntityUpdateFunction<Components, SteeringUpdateComponents & EntityUpdateComponents<Components>, SteeringWorld> = (world, entityId, components) => {
	const params = world.steering;
	const bounds = world.bounds;
	// A run with no index behind it, or one the page sent nothing across on, leaves the velocity exactly as it
	// found it - and the boid flies on in a straight line until a run that does carry them lands.
	if(!flock || !params || !bounds) {
		return;
	}

	steer(flock, entityId, components, params, bounds, world.elapsedTime / 1000);
};

// The one hook that sees every boid at once, which makes it the only place the index can be built from a single
// consistent moment.  It is rebuilt every run because the flock has moved since the last one: an index built last
// run is an index of where everyone used to be.
//
// The entities it is built over are this system's *own* list - every boid in the world - so there is no separate
// flock query to gather.  The blocks in it are the same shared memory the physics worker is writing positions
// into, so what a boid steers off is where its neighbours are now rather than a copy of where they were.
steeringUpdate.preRun = (world, entities) => {
	flock = new SpatialIndex<SteeringUpdateComponents>(getSpatialMap(world), entities);
};

// One boid's steering: search the flock around it, work the three rules into an acceleration, add the edges'
// push, and fold that into its velocity - then hold the result between the min and max speed so it keeps moving.
// Writes the velocity block in place and touches nothing else; the move that acts on it is the physics system's.
function steer(index: SpatialIndex<SteeringUpdateComponents>, entityId: number, components: SteeringUpdateComponents, params: SteeringParams, bounds: SteeringBounds, seconds: number): void {
	const transform = components.transform;
	const velocity = components.velocity;
	const x = transform[TRANSFORM_X_INDEX];
	const y = transform[TRANSFORM_Y_INDEX];
	let velocityX = velocity[VELOCITY_X_INDEX];
	let velocityY = velocity[VELOCITY_Y_INDEX];

	// The nearest flockmates within perception, itself excluded.  Nearest-first and capped, so a boid in a dense
	// clump folds in the closest handful rather than the whole crowd - see MAX_NEIGHBORS.
	const neighbors = index.findNearby(x, y, MAX_NEIGHBORS, params.perception, other => other.entityId !== entityId);

	// The three rules are summed as they go: the flock's middle and average heading for cohesion and alignment,
	// and a push away from each too-close neighbour for separation, weighted so the closer it is the harder it
	// shoves.
	let centerX = 0;
	let centerY = 0;
	let headingX = 0;
	let headingY = 0;
	let awayX = 0;
	let awayY = 0;
	const separationRangeSquared = params.separationRange * params.separationRange;

	for(const neighbor of neighbors) {
		const neighborTransform = neighbor.components.transform;
		const neighborVelocity = neighbor.components.velocity;
		const neighborX = neighborTransform[TRANSFORM_X_INDEX];
		const neighborY = neighborTransform[TRANSFORM_Y_INDEX];

		centerX += neighborX;
		centerY += neighborY;
		headingX += neighborVelocity[VELOCITY_X_INDEX];
		headingY += neighborVelocity[VELOCITY_Y_INDEX];

		const offsetX = x - neighborX;
		const offsetY = y - neighborY;
		const distanceSquared = offsetX * offsetX + offsetY * offsetY;
		// Closer than the separation range and not sitting exactly on top of it (which would divide by zero):
		// push away along the offset, scaled by 1/distance² so a neighbour half as far pushes four times as hard.
		if(distanceSquared > 0 && distanceSquared < separationRangeSquared) {
			awayX += offsetX / distanceSquared;
			awayY += offsetY / distanceSquared;
		}
	}

	// Each rule becomes a steering acceleration - the change in velocity that would bring the boid onto what the
	// rule wants - and the three are added in the caller's weights.  A boid with no neighbours steers off nothing
	// but the edges.
	let accelerationX = 0;
	let accelerationY = 0;
	if(neighbors.length > 0) {
		// Cohesion: toward the middle of the flockmates.
		const cohesion = steerToward(centerX / neighbors.length - x, centerY / neighbors.length - y, velocityX, velocityY, params.maxSpeed);
		// Alignment: onto their average heading.
		const alignment = steerToward(headingX, headingY, velocityX, velocityY, params.maxSpeed);
		// Separation: along the summed push away from the crowded ones.
		const separation = steerToward(awayX, awayY, velocityX, velocityY, params.maxSpeed);

		accelerationX = cohesion.x * params.cohesion + alignment.x * params.alignment + separation.x * params.separation;
		accelerationY = cohesion.y * params.cohesion + alignment.y * params.alignment + separation.y * params.separation;
	}

	velocityX += accelerationX * seconds;
	velocityY += accelerationY * seconds;

	// The edges turn the boid back rather than stopping it: a push inward that grows from nothing at the margin to
	// its full strength at the wall, so the flock banks away instead of piling up against a boundary it does not
	// collide with in the first place.
	if(x < EDGE_MARGIN) {
		velocityX += EDGE_TURN * seconds;
	} else if(x > bounds.width - EDGE_MARGIN) {
		velocityX -= EDGE_TURN * seconds;
	}
	if(y < EDGE_MARGIN) {
		velocityY += EDGE_TURN * seconds;
	} else if(y > bounds.height - EDGE_MARGIN) {
		velocityY -= EDGE_TURN * seconds;
	}

	// Hold the speed between the two bounds so the boid is always moving and never runs away - only its heading is
	// really free.  A boid that steering has stalled dead is nudged back up along its last heading, or straight up
	// if it has none, rather than sitting still.
	const speed = Math.hypot(velocityX, velocityY);
	if(speed > params.maxSpeed) {
		const scale = params.maxSpeed / speed;
		velocityX *= scale;
		velocityY *= scale;
	} else if(speed > 0 && speed < params.minSpeed) {
		const scale = params.minSpeed / speed;
		velocityX *= scale;
		velocityY *= scale;
	} else if(speed === 0) {
		velocityY = -params.minSpeed;
	}

	velocity[VELOCITY_X_INDEX] = velocityX;
	velocity[VELOCITY_Y_INDEX] = velocityY;
}

// Shared so the common "nothing to steer toward" case allocates nothing.  Never mutated - every other return
// builds a fresh object - so handing the same one back each time is safe.
const ZERO_STEER = { x: 0, y: 0 };

// Turns a direction a rule wants the boid to head into the acceleration that would get it there: aim the boid's
// full speed along that direction, then return the difference from where its velocity already points, so a boid
// already going the right way is steered gently and one going the wrong way hard.  A zero-length direction - no
// neighbours, or a separation push that cancelled out - asks for nothing.
function steerToward(directionX: number, directionY: number, velocityX: number, velocityY: number, maxSpeed: number): { x: number, y: number } {
	const length = Math.hypot(directionX, directionY);
	if(length === 0) {
		return ZERO_STEER;
	}

	return {
		x: (directionX / length) * maxSpeed - velocityX,
		y: (directionY / length) * maxSpeed - velocityY,
	};
}

export default steeringUpdate;
