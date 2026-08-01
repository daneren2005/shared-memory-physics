import { AUTO, Game, Scale, Scene } from 'phaser';
import { SHAPE_CIRCLE, SHAPE_RECTANGLE } from '@daneren2005/shared-memory-physics';
import type { TransformComponent } from '@daneren2005/shared-memory-physics';
import type { ExampleRuntime } from './example';
import { LEVEL } from './level';

// What the scene needs from the page: somewhere to send the frame, and whatever world is currently up.
export interface Renderable {
	// Advances the simulation by a frame.  Returns nothing - everything the renderer wants is already in
	// shared memory by the time it comes back.
	step(elapsedTime: number): void
	readonly runtime: ExampleRuntime | undefined
	// Whether to draw from the render position or straight off the transform, so the two can be compared on the
	// same running scene.
	readonly interpolate: boolean
}

// A frame after the tab has been in the background for a minute arrives with a delta of however long that was.
// Handing that to physics would teleport every entity across the level in a single step, so it is capped -
// the simulation simply misses the time the page was not being drawn.
const MAX_FRAME_MS = 100;

// One colour per entity, picked off its id, so an entity keeps the same colour for its whole life and two
// neighbours are almost never the same.  Cheaper and steadier than anything derived from what it is doing.
const PALETTE = [0x7DD3FC, 0xFCA5A5, 0xFDE68A, 0x86EFAC, 0xC4B5FD, 0xF9A8D4, 0x99F6E4, 0xFDBA74];
// What has a transform but no velocity: the boxes the walk example runs into.  Everything the physics system
// never moves is drawn in the same flat grey, so "this one is scenery" reads at a glance.
const STATIC_COLOR = 0x475569;
const LEVEL_BORDER_COLOR = 0x1E293B;

// The two components a position can come out of have this much in common and nothing else.
interface Position {
	x: number
	y: number
}

// Draws the world straight out of shared memory: every frame it walks the entities and reads their transform
// blocks, which the physics run - on this thread or a worker one - has already written.  Nothing is copied and
// no positions are pushed at the renderer; the block *is* the position.
//
// It is one Graphics object redrawn per frame rather than a sprite per entity because the examples change how
// many entities exist while they are running, and a redraw does not care.
class ExampleScene extends Scene {
	private graphics!: Phaser.GameObjects.Graphics;

	constructor(private readonly host: Renderable) {
		super('example');
	}

	create(): void {
		this.graphics = this.add.graphics();
	}

	update(time: number, delta: number): void {
		this.host.step(Math.min(delta, MAX_FRAME_MS));
		this.draw();
	}

	private draw(): void {
		const graphics = this.graphics;
		graphics.clear();

		graphics.lineStyle(2, LEVEL_BORDER_COLOR, 1);
		graphics.strokeRect(0, 0, LEVEL.width, LEVEL.height);

		const runtime = this.host.runtime;
		if(!runtime) {
			return;
		}

		for(const entity of runtime.world.entities.values()) {
			const transform = entity.components.transform;
			if(!transform) {
				continue;
			}

			const color = entity.components.velocity ? PALETTE[entity.eid % PALETTE.length] : STATIC_COLOR;
			graphics.fillStyle(color, 0.85);
			graphics.lineStyle(1.5, color, 1);

			// Where to draw it and how big it is come from different blocks: the interpolation component holds
			// only a position, and everything about the shape stays on the transform.  An entity the example
			// never asked to interpolate - the walls - has no interpolation block and falls back to the one
			// place a position always exists.
			const interpolation = this.host.interpolate ? entity.components.interpolation : undefined;
			drawShape(graphics, interpolation ?? transform, transform, entity.components.body?.shape ?? SHAPE_RECTANGLE);
		}
	}
}

// `position` is what to draw it at - the render position when the page is interpolating, the transform when it
// is not - and both are getters straight onto shared blocks a physics run or the interpolation system wrote,
// so neither is a copy something had to keep in step.
function drawShape(graphics: Phaser.GameObjects.Graphics, position: Position, transform: TransformComponent, shape: number): void {
	const { x, y } = position;
	const { width, height, angle } = transform;

	// A circle is a width and a height like everything else, and its angle means nothing to it.
	if(shape === SHAPE_CIRCLE) {
		graphics.fillCircle(x, y, width / 2);
		graphics.strokeCircle(x, y, width / 2);

		return;
	}

	// x/y is the *centre* of the box, and Phaser draws from a corner, so the box is drawn around the origin and
	// the origin is moved to the entity.  Nothing in these examples turns anything, but the rotation is honoured
	// so that anything drawn here matches what the library would collide it as.
	graphics.save();
	graphics.translateCanvas(x, y);
	if(angle !== 0) {
		graphics.rotateCanvas(angle);
	}
	graphics.fillRect(-width / 2, -height / 2, width, height);
	graphics.strokeRect(-width / 2, -height / 2, width, height);
	graphics.restore();
}

export function createGame(parent: HTMLElement, host: Renderable): Game {
	return new Game({
		type: AUTO,
		parent,
		width: LEVEL.width,
		height: LEVEL.height,
		backgroundColor: '#0B1120',
		banner: false,
		scale: {
			// The level is a fixed size in world units, so the canvas is scaled to whatever room the page has
			// rather than the world being resized under the simulation.
			mode: Scale.FIT,
			autoCenter: Scale.CENTER_HORIZONTALLY,
		},
		scene: new ExampleScene(host),
	});
}
