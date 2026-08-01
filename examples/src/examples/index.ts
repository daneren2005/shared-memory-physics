import type { Example } from '../example';
import { bouncingCircles } from './bouncing-circles';
import { bouncingRectangles } from './bouncing-rectangles';
import { interpolationWalk } from './interpolation-walk';

// The order they appear in the nav, and the first one is what a visit with no hash lands on.
export const EXAMPLES: Array<Example> = [
	bouncingCircles,
	bouncingRectangles,
	interpolationWalk,
];

export function findExample(id: string): Example | undefined {
	return EXAMPLES.find(example => example.id === id);
}
