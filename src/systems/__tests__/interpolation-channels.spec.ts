import { registerInterpolationChannel, snapshotCommittedTicks, unregisterInterpolationChannel } from '../interpolation-channels';

describe('interpolation-channels', () => {
	it('has nothing to snapshot for a world with no physics systems', () => {
		expect(snapshotCommittedTicks({})).toBeUndefined();
	});

	it('snapshots each registered system under its channel, leaving channel 0 ungated', () => {
		const world = {};
		const first = registerInterpolationChannel(world, { committedTick: 4 });
		const second = registerInterpolationChannel(world, { committedTick: 9 });

		const snapshot = snapshotCommittedTicks(world)!;
		expect(Number.isNaN(snapshot[0])).toBe(true);
		expect(snapshot[first]).toBe(4);
		expect(snapshot[second]).toBe(9);
	});

	it('reads the committed tick at snapshot time', () => {
		const world = {};
		const source = { committedTick: 1 };
		const channel = registerInterpolationChannel(world, source);
		source.committedTick = 2;

		expect(snapshotCommittedTicks(world)![channel]).toBe(2);
	});

	it('ungates a destroyed system without renumbering the others', () => {
		const world = {};
		const first = registerInterpolationChannel(world, { committedTick: 4 });
		const second = registerInterpolationChannel(world, { committedTick: 9 });
		unregisterInterpolationChannel(world, first);

		const snapshot = snapshotCommittedTicks(world)!;
		expect(Number.isNaN(snapshot[first])).toBe(true);
		expect(snapshot[second]).toBe(9);
	});
});
