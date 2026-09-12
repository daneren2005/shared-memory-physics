import { createTestWorld, type TestWorld } from '../../__tests__/fixtures/world';
import { startSpawnInterpolation } from '../interpolation-component';

// The seed itself, one call at a time: what `startSpawnInterpolation` writes into the block. The handover to the
// first real physics step is covered end to end in interpolation-system.spec.ts.
describe('startSpawnInterpolation', () => {
	let world: TestWorld;
	beforeEach(() => {
		world = createTestWorld();
	});

	it('opens the render at the spawn point and jumps the transform forward by what is left of the step', () => {
		// 200 u/s over a 50ms step is 10 units; 0.4 into the step leaves 0.6, so the transform jumps 6 units from
		// 100 to 106 and the render opens at the spawn (100) to move out to there.
		const entity = world.loadEntity({ x: 100, y: 0, width: 1, height: 1, velocityX: 200, interpolate: true });
		startSpawnInterpolation(entity, { stepMs: 50, stepFraction: 0.4, tick: 3 });

		expect(entity.components.transform!.x).toBeCloseTo(106);
		const interpolation = entity.components.interpolation!;
		expect(interpolation.prevX).toBeCloseTo(100);
		expect(interpolation.prevY).toBeCloseTo(0);
		expect(interpolation.x).toBeCloseTo(100); // drawn at the spawn point
		expect(interpolation.y).toBeCloseTo(0);
		expect(interpolation.duration).toBeCloseTo(30); // 50 * 0.6
		expect(interpolation.progress).toEqual(0);
		expect(interpolation.syncedTick).toEqual(3);
		expect(interpolation.tick).toEqual(3);
		expect(interpolation.totalDuration).toBeCloseTo(30);
		expect(interpolation.syncedDuration).toBeCloseTo(30);
		expect(interpolation.remainingDuration).toBeCloseTo(30);
	});

	it('carries both axes', () => {
		const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, velocityX: 100, velocityY: -40, interpolate: true });
		// The whole step is still to come, so the jump is a full step: 5 and -2 units.
		startSpawnInterpolation(entity, { stepMs: 50, stepFraction: 0, tick: 1 });

		expect(entity.components.transform!.x).toBeCloseTo(5);
		expect(entity.components.transform!.y).toBeCloseTo(-2);
		const interpolation = entity.components.interpolation!;
		expect(interpolation.x).toBeCloseTo(0); // still opened at the spawn point
		expect(interpolation.y).toBeCloseTo(0);
	});

	it('clamps the fraction into range', () => {
		const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, velocityX: 200, interpolate: true });
		startSpawnInterpolation(entity, { stepMs: 50, stepFraction: 1.5, tick: 1 });

		const interpolation = entity.components.interpolation!;
		// Clamped to a full step already elapsed: nothing of it is left, so there is no jump and no segment.
		expect(interpolation.x).toBeCloseTo(0);
		expect(interpolation.duration).toEqual(0);
		expect(entity.components.transform!.x).toBeCloseTo(0);
	});

	it('leaves an entity with no velocity at its at-rest seed', () => {
		const entity = world.loadEntity({ x: 5, y: 5, width: 1, height: 1, interpolate: true });
		startSpawnInterpolation(entity, { stepMs: 50, stepFraction: 0.5, tick: 2 });

		expect(entity.components.transform!.x).toEqual(5);
		const interpolation = entity.components.interpolation!;
		expect(interpolation.prevX).toEqual(5);
		expect(interpolation.x).toEqual(5);
		expect(interpolation.duration).toEqual(0);
		expect(interpolation.tick).toEqual(0);
	});

	it('does nothing for an entity with no interpolation component', () => {
		const entity = world.loadEntity({ x: 0, y: 0, width: 1, height: 1, velocityX: 200 });
		expect(() => startSpawnInterpolation(entity, { stepMs: 50, stepFraction: 0.5, tick: 1 })).not.toThrow();
		expect(entity.components.interpolation).toBeUndefined();
		// The transform is not jumped when there is no interpolation to seed.
		expect(entity.components.transform!.x).toEqual(0);
	});
});
