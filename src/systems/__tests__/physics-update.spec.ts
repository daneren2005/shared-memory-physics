import physicsUpdate from '../physics-update';
import type { ComponentSystemCallbacks, ComponentSystemWorld } from '@daneren2005/shared-memory-ecs';
import { TRANSFORM_SIZE, TRANSFORM_X_INDEX, TRANSFORM_Y_INDEX } from '../../components/transform-component';
import { VELOCITY_SIZE, VELOCITY_X_INDEX, VELOCITY_Y_INDEX } from '../../components/velocity-component';

// Drives the update function directly against raw blocks, without a world or a system in the way - so these
// pin down the integration math itself.  physics-system.spec.ts covers the same logic end to end.
describe('physics-update', () => {
	const callbacks: ComponentSystemCallbacks = {
		entityComponentChanged: () => {},
		entityDied: () => {},
		createEntity: () => {},
	};

	function move(position: [number, number], velocity: [number, number], elapsedTime: number): [number, number] {
		// Built at the full block size and written through the exported offsets, so a transform that grows more
		// fields (width, height, angle) does not quietly change what this is testing.
		const transform = new Float32Array(TRANSFORM_SIZE);
		transform[TRANSFORM_X_INDEX] = position[0];
		transform[TRANSFORM_Y_INDEX] = position[1];

		const velocityBlock = new Float32Array(VELOCITY_SIZE);
		velocityBlock[VELOCITY_X_INDEX] = velocity[0];
		velocityBlock[VELOCITY_Y_INDEX] = velocity[1];

		const world: ComponentSystemWorld = { gameTime: 0, elapsedTime };
		physicsUpdate(world, 1, { transform, velocity: velocityBlock }, {}, callbacks);

		return [transform[TRANSFORM_X_INDEX], transform[TRANSFORM_Y_INDEX]];
	}

	it('adds one second of velocity to the position', () => {
		expect(move([0, 0], [3, 4], 1000)).toEqual([3, 4]);
	});

	it('scales velocity by the elapsed time', () => {
		expect(move([0, 0], [10, 20], 500)).toEqual([5, 10]);
	});

	it('moves relative to the current position', () => {
		expect(move([100, -50], [1, 2], 1000)).toEqual([101, -48]);
	});

	it('moves backwards on a negative velocity', () => {
		expect(move([0, 0], [-2, -6], 1000)).toEqual([-2, -6]);
	});

	it('does not move on a zero velocity', () => {
		expect(move([12, 34], [0, 0], 1000)).toEqual([12, 34]);
	});

	it('does not move on a zero elapsed time', () => {
		expect(move([12, 34], [5, 5], 0)).toEqual([12, 34]);
	});

	it('keeps each axis independent', () => {
		expect(move([0, 0], [5, 0], 1000)).toEqual([5, 0]);
		expect(move([0, 0], [0, 5], 1000)).toEqual([0, 5]);
	});

	it('reads velocity from the same block offsets the component writes', () => {
		const velocity = new Float32Array(VELOCITY_SIZE);
		velocity[VELOCITY_X_INDEX] = 7;
		velocity[VELOCITY_Y_INDEX] = -7;

		expect(move([0, 0], [velocity[VELOCITY_X_INDEX], velocity[VELOCITY_Y_INDEX]], 1000)).toEqual([7, -7]);
	});
});
