import { bouncePair, default as bounce } from '../bounce';
import { BODY_SENSOR_FLAG, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '../../components/body-component';

const EIGHTH_TURN = Math.PI / 4;

interface EntityOptions {
	shape?: number
	width?: number
	height?: number
	angle?: number
	velocityX?: number
	velocityY?: number
	bounciness?: number
	sensor?: boolean
}

function entity(x: number, y: number, options: EntityOptions = {}) {
	const width = options.width ?? 10;

	return {
		components: {
			transform: new Float32Array([x, y, width, options.height ?? width, options.angle ?? 0]),
			velocity: new Float32Array([options.velocityX ?? 0, options.velocityY ?? 0]),
			bounciness: new Float32Array([options.bounciness ?? 1]),
			body: new Uint32Array([(options.shape ?? SHAPE_RECTANGLE) | (options.sensor ? BODY_SENSOR_FLAG : 0), 1, 0xffffffff]),
		},
	};
}

describe('bounce', () => {
	it('turns a mover back off the face it ran into', () => {
		const self = entity(0, 0, { velocityX: 100 });
		bounce(self, entity(10, 0));

		expect(self.components.velocity[0]).toBeCloseTo(-100);
		expect(self.components.velocity[1]).toBeCloseTo(0);
	});

	it('keeps the speed along the surface and only turns what pointed into it', () => {
		const self = entity(0, 0, { velocityX: 100, velocityY: 40 });
		bounce(self, entity(10, 0));

		expect(self.components.velocity[0]).toBeCloseTo(-100);
		expect(self.components.velocity[1]).toBeCloseTo(40);
	});

	it('takes off the speed into the surface and no more at no bounciness', () => {
		const self = entity(0, 0, { velocityX: 100, velocityY: 40, bounciness: 0 });
		bounce(self, entity(10, 0));

		expect(self.components.velocity[0]).toBeCloseTo(0);
		expect(self.components.velocity[1]).toBeCloseTo(40);
	});

	it('leaves a mover already on its way out alone', () => {
		const self = entity(0, 0, { velocityX: -100 });
		bounce(self, entity(10, 0));

		expect(self.components.velocity[0]).toBeCloseTo(-100);
	});

	it('never bounces off a sensor', () => {
		const self = entity(0, 0, { velocityX: 100 });
		bounce(self, entity(10, 0, { sensor: true }));

		expect(self.components.velocity[0]).toBeCloseTo(100);
	});

	// The pair used to be turned around off whichever world axis their bounding boxes ran into least far, which
	// only names the face that was hit when the two are square to the world. Anything facing where it is going -
	// a ship, a car - meets at an angle, where that normal is across the way it was travelling: the reflection
	// then flipped the wrong component, or found no speed into the surface at all and let it drive on through.
	describe('turned bodies', () => {
		it('turns a mover back off a wall laid along the diagonal', () => {
			const wall = entity(0, 0, { width: 100, height: 4, angle: EIGHTH_TURN, bounciness: 0 });
			const self = entity(-2.4, 2.4, { width: 2, height: 2, velocityX: 10, velocityY: -10 });
			bounce(self, wall);

			// Square onto the wall's face, so the whole velocity turns round.
			expect(self.components.velocity[0]).toBeCloseTo(-10, 1);
			expect(self.components.velocity[1]).toBeCloseTo(10, 1);
		});

		it('turns a mover running along the world axis into a diagonal wall', () => {
			// The case that used to do nothing at all: with the normal snapped to (0, 1) nothing pointed into the
			// wall, so the bounce was skipped and the mover carried on through it.
			const wall = entity(0, 0, { width: 100, height: 4, angle: EIGHTH_TURN, bounciness: 0 });
			const self = entity(-2.4, 2.4, { width: 2, height: 2, velocityX: 10 });
			bounce(self, wall);

			// Reflected off a 45 degree face: what was travelling in x leaves in y.
			expect(self.components.velocity[0]).toBeCloseTo(0, 1);
			expect(self.components.velocity[1]).toBeCloseTo(10, 1);
		});

		it('turns a circle off a diagonal wall it would otherwise have run down', () => {
			// A long wall fills so much of its bounding box that both axes tie, which used to send the circle
			// straight up - across its heading, so nothing pointed into the wall and it sailed on.
			const self = entity(-2, 2, { shape: SHAPE_CIRCLE, width: 4, velocityX: 10 });
			bounce(self, entity(0, 0, { width: 1000, height: 4, angle: EIGHTH_TURN, bounciness: 0 }));

			expect(self.components.velocity[0]).toBeCloseTo(0, 1);
			expect(self.components.velocity[1]).toBeCloseTo(10, 1);
		});
	});

	it('turns both sides of a contact around, each by its own bounciness', () => {
		const self = entity(0, 0, { shape: SHAPE_CIRCLE, velocityX: 100 });
		const other = entity(10, 0, { shape: SHAPE_CIRCLE, velocityX: -20, bounciness: 0.5 });
		bouncePair(self, other);

		expect(self.components.velocity[0]).toBeCloseTo(-100);
		expect(other.components.velocity[0]).toBeCloseTo(10);
	});
});
