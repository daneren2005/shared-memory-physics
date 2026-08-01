// A seeded random number generator (mulberry32), so an example that is rebuilt - because a slider moved, or
// because the physics backend was switched - lays its entities out exactly the same way as it did before.
// Without that, comparing two settings would mean comparing two different scenes.
export default class Random {
	private state: number;

	constructor(seed: number) {
		this.state = seed;
	}

	// A float in [0, 1).
	next(): number {
		this.state = (this.state + 0x6D2B79F5) | 0;
		let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	}

	// A float in [min, max).
	between(min: number, max: number): number {
		return min + this.next() * (max - min);
	}
}
