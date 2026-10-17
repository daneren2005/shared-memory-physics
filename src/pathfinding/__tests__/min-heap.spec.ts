import MinHeap from '../min-heap';
import { seededRandom } from './grid-fixtures';

describe('MinHeap', () => {
	it('pops -1 when empty', () => {
		expect(new MinHeap().pop()).toBe(-1);
	});

	it('pops ids in order of their key', () => {
		const heap = new MinHeap();
		heap.push(1, 5);
		heap.push(2, 1);
		heap.push(3, 3);

		expect([heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual([2, 3, 1, -1]);
	});

	it('breaks ties on the secondary key', () => {
		const heap = new MinHeap();
		heap.push(1, 4, 9);
		heap.push(2, 4, 1);
		heap.push(3, 4, 5);

		expect([heap.pop(), heap.pop(), heap.pop()]).toEqual([2, 3, 1]);
	});

	it('keeps a re-pushed id beside its stale entry', () => {
		const heap = new MinHeap();
		heap.push(7, 10);
		heap.push(7, 2);

		expect(heap.size).toBe(2);
		expect([heap.pop(), heap.pop()]).toEqual([7, 7]);
	});

	it('grows past its starting capacity', () => {
		const heap = new MinHeap(2);
		for(let i = 0; i < 100; i++) {
			heap.push(i, 100 - i);
		}

		expect(heap.size).toBe(100);
		expect(heap.pop()).toBe(99);
	});

	it('empties on clear', () => {
		const heap = new MinHeap();
		heap.push(1, 1);
		heap.clear();

		expect(heap.size).toBe(0);
		expect(heap.pop()).toBe(-1);
	});

	it('sorts a large random set', () => {
		const random = seededRandom(42);
		const keys = Array.from({ length: 1_000 }, () => random());
		const heap = new MinHeap();
		keys.forEach((key, id) => heap.push(id, key));

		const popped: Array<number> = [];
		while(heap.size > 0) {
			popped.push(keys[heap.pop()]);
		}

		expect(popped).toEqual([...keys].sort((a, b) => a - b));
	});
});