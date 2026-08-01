import type { ExampleWorld } from './world';

// One world unit is one pixel, so nothing has to be scaled on the way to the canvas.
export interface Level {
	width: number
	height: number
}

export const LEVEL: Level = {
	width: 900,
	height: 600,
};

// The edges of the level are ordinary entities: four rectangles with a transform and a body but no velocity,
// so the physics system never moves them and every mover is stopped against them by the same sweep that stops
// it against anything else.  That is the point of them being entities rather than a bounds check in the
// update - the library only knows about shapes, and "the wall" is just another shape.
//
// They are thick enough that no single run can carry an entity clean through one: a sweep looks at where a
// move *ends*, so something moving further in one run than the wall is deep would find nothing left to land
// on.  At any sane speed and step this is a huge margin.
const WALL_THICKNESS = 400;

export function createWalls(world: ExampleWorld, level: Level): void {
	const { width, height } = level;
	const half = WALL_THICKNESS / 2;

	// Each one sits entirely outside the level, with its inside face exactly on the boundary, so the playable
	// area is the whole canvas and none of the walls is ever drawn.  The side walls are run past the corners so
	// that a corner has no gap to squeeze through.
	world.loadEntity({ x: -half, y: height / 2, width: WALL_THICKNESS, height: height + WALL_THICKNESS * 2 });
	world.loadEntity({ x: width + half, y: height / 2, width: WALL_THICKNESS, height: height + WALL_THICKNESS * 2 });
	world.loadEntity({ x: width / 2, y: -half, width: width + WALL_THICKNESS * 2, height: WALL_THICKNESS });
	world.loadEntity({ x: width / 2, y: height + half, width: width + WALL_THICKNESS * 2, height: WALL_THICKNESS });
}
