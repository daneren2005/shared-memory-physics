// Main-thread registry of each world's PhysicsSystems, so an InterpolationSystem can snapshot every run's commit
// once per frame. A worker publishes entity by entity while the main thread renders, so without one snapshot some
// entities of a run would be drawn at its new step and others at the old one.
export interface InterpolationCommitSource {
	// The last tick whose run has finished publishing every entity.
	readonly committedTick: number
}

const channelsByWorld = new WeakMap<object, Array<InterpolationCommitSource | undefined>>();

// Channels start at 1 so a zeroed block reads as "no channel" and stays ungated.
export function registerInterpolationChannel(world: object, source: InterpolationCommitSource): number {
	let channels = channelsByWorld.get(world);
	if(!channels) {
		channels = [undefined];
		channelsByWorld.set(world, channels);
	}
	channels.push(source);

	return channels.length - 1;
}

export function unregisterInterpolationChannel(world: object, channel: number): void {
	const channels = channelsByWorld.get(world);
	if(channels && channel > 0 && channel < channels.length) {
		channels[channel] = undefined;
	}
}

// Indexed by channel. An unregistered slot is NaN, which leaves its entities ungated.
export function snapshotCommittedTicks(world: object): Array<number> | undefined {
	const channels = channelsByWorld.get(world);
	if(!channels) {
		return undefined;
	}

	return channels.map(source => source ? source.committedTick : Number.NaN);
}
