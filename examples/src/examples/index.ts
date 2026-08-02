import type { Example } from '../example';
import { boids } from './boids';
import { bouncingCircles } from './bouncing-circles';
import { bouncingRectangles } from './bouncing-rectangles';
import { breakout } from './breakout';
import { clickToMove } from './click-to-move';
import { interpolationWalk } from './interpolation-walk';
import { sensors } from './sensors';

// The order they appear in the nav, and the first one is what a visit with no hash lands on.
export const EXAMPLES: Array<Example> = [
	bouncingCircles,
	bouncingRectangles,
	interpolationWalk,
	clickToMove,
	sensors,
	breakout,
	boids,
];

export function findExample(id: string): Example | undefined {
	return EXAMPLES.find(example => example.id === id);
}
