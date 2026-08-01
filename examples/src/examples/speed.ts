import type { ExampleRuntime } from '../example';

// Rescales everything that moves to a new speed without changing which way it is going, so a speed slider can
// be dragged mid-run instead of throwing the scene away and laying it out again.
//
// Writing `velocity.velocityX` is writing the shared block behind it, so a physics run already in flight on a
// worker picks the change up on its next pass with nothing sent across.  Entities the system never moves - the
// walls, the boxes in the walk example - have no velocity component at all and are skipped by that alone.
export function setSpeed(runtime: ExampleRuntime | undefined, speed: number): void {
	if(!runtime) {
		return;
	}

	for(const entity of runtime.world.entities.values()) {
		const velocity = entity.components.velocity;
		if(!velocity) {
			continue;
		}

		const current = Math.hypot(velocity.velocityX, velocity.velocityY);
		if(current === 0) {
			continue;
		}

		const scale = speed / current;
		velocity.velocityX *= scale;
		velocity.velocityY *= scale;
	}
}
