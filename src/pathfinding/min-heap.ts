// Binary min-heap of integer ids ordered by a primary then secondary key. Keys are captured on push, so an id pushed
// again with a better key simply sits beside its stale entry; the caller skips stale pops.
export default class MinHeap {
	private ids: Int32Array;
	private primary: Float64Array;
	private secondary: Float64Array;
	private count = 0;

	constructor(capacity = 64) {
		this.ids = new Int32Array(capacity);
		this.primary = new Float64Array(capacity);
		this.secondary = new Float64Array(capacity);
	}

	get size(): number {
		return this.count;
	}

	clear(): void {
		this.count = 0;
	}

	push(id: number, primary: number, secondary = 0): void {
		if(this.count === this.ids.length) {
			this.grow();
		}
		let i = this.count++;
		while(i > 0) {
			const parent = (i - 1) >> 1;
			if(!this.less(primary, secondary, this.primary[parent], this.secondary[parent])) {
				break;
			}
			this.set(i, this.ids[parent], this.primary[parent], this.secondary[parent]);
			i = parent;
		}
		this.set(i, id, primary, secondary);
	}

	// -1 when empty.
	pop(): number {
		if(this.count === 0) {
			return -1;
		}
		const top = this.ids[0];
		const last = --this.count;
		if(last > 0) {
			const id = this.ids[last];
			const primary = this.primary[last];
			const secondary = this.secondary[last];
			let i = 0;
			for(;;) {
				const left = i * 2 + 1;
				if(left >= last) {
					break;
				}
				const right = left + 1;
				const child = right < last && this.less(this.primary[right], this.secondary[right], this.primary[left], this.secondary[left]) ? right : left;
				if(!this.less(this.primary[child], this.secondary[child], primary, secondary)) {
					break;
				}
				this.set(i, this.ids[child], this.primary[child], this.secondary[child]);
				i = child;
			}
			this.set(i, id, primary, secondary);
		}
		return top;
	}

	private less(primaryA: number, secondaryA: number, primaryB: number, secondaryB: number): boolean {
		return primaryA < primaryB || (primaryA === primaryB && secondaryA < secondaryB);
	}

	private set(i: number, id: number, primary: number, secondary: number): void {
		this.ids[i] = id;
		this.primary[i] = primary;
		this.secondary[i] = secondary;
	}

	private grow(): void {
		const capacity = this.ids.length * 2;
		const ids = new Int32Array(capacity);
		const primary = new Float64Array(capacity);
		const secondary = new Float64Array(capacity);
		ids.set(this.ids);
		primary.set(this.primary);
		secondary.set(this.secondary);
		this.ids = ids;
		this.primary = primary;
		this.secondary = secondary;
	}
}