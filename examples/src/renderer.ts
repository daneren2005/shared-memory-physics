import { AUTO, Game, Math as PhaserMath, Scale, Scene } from 'phaser';
import { SHAPE_CAPSULE, SHAPE_CIRCLE, SHAPE_RECTANGLE } from '@daneren2005/shared-memory-physics';
import type { TransformComponent } from '@daneren2005/shared-memory-physics';
import type { BaseEntity } from '@daneren2005/shared-memory-ecs';
import type { EntityStyle, HudText, ExampleRuntime } from './example';
import { LEVEL } from './level';
import type { Level } from './level';
import type { Components, Config } from './world';

// What the scene needs from the page: somewhere to send the frame, and whatever world is currently up.
export interface Renderable {
	// Advances the simulation by a frame.  Returns nothing - everything the renderer wants is already in
	// shared memory by the time it comes back.
	step(elapsedTime: number): void
	readonly runtime: ExampleRuntime | undefined
	// Whether to draw from the render position or straight off the transform, so the two can be compared on the
	// same running scene.
	readonly interpolate: boolean
	// The canvas was clicked, at this point in world units.  The page forwards it to whichever example is up, so
	// the scene does not have to know which examples care about a click.
	pointerDown(x: number, y: number): void
	// The current example's own colour for this entity, or undefined to fall back to the renderer's default.  The
	// scene asks per entity per frame; the page routes it to whichever example is up - see Example#entityStyle.
	entityStyle(entity: BaseEntity<Components, Config>): EntityStyle | undefined
	// Whether the current example is a swarm - thousands of tiny movers to be drawn as heading-pointed darts in
	// one cheap pass, rather than as the handful of outlined shapes the default loop draws.  Set for boids and
	// nothing else; see the swarm path in `draw`.
	readonly swarm: boolean
	// The score, lives and banner the current example wants drawn over the canvas, or undefined for one that has
	// none.  Routed to whichever example is up the same way a colour is - see Example#hud.
	hud(): HudText | undefined
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
	// The two HUD layers, made once and rewritten each frame rather than recreated: the status lines pinned to
	// the top-left corner, and the banner across the middle.  Added after the graphics so they draw on top of
	// the shapes, and left empty for every example that returns no `hud` at all.
	private statusText!: Phaser.GameObjects.Text;
	private bannerText!: Phaser.GameObjects.Text;
	// The world size the camera zoom was last set for, so it is only redone when an example with a different one
	// comes up rather than every frame.  Zero until the first world is drawn.
	private cameraWidth = 0;
	private cameraHeight = 0;

	constructor(private readonly host: Renderable) {
		super('example');
	}

	create(): void {
		this.graphics = this.add.graphics();

		this.statusText = this.add.text(16, 12, '', {
			fontFamily: 'ui-monospace, monospace',
			fontSize: '18px',
			color: '#E2E8F0',
		});
		this.bannerText = this.add.text(LEVEL.width / 2, LEVEL.height / 2, '', {
			fontFamily: 'ui-monospace, monospace',
			fontSize: '34px',
			color: '#F8FAFC',
			align: 'center',
		}).setOrigin(0.5);

		// The level is drawn at its own size, so a pointer read off the scene is already in world units and needs
		// no unproject - the click and the entity it is steering share one coordinate space.
		this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
			this.host.pointerDown(pointer.worldX, pointer.worldY);
		});
	}

	update(time: number, delta: number): void {
		this.host.step(Math.min(delta, MAX_FRAME_MS));
		// An example that simulates in a bigger world than the canvas is sized to (boids) is fitted by zooming the
		// camera out rather than by growing the canvas, so the whole world lands in the same space just smaller.
		const level = this.host.runtime?.level;
		if(level) {
			this.applyCamera(level);
		}
		this.draw();
		this.drawHud();
	}

	// Zooms the camera so `level` fills the canvas, and recentres on it.  Only touched when the world's size
	// actually changes - switching examples, or the first build - since setting it every frame is needless.  The
	// zoom is uniform (the worlds share the canvas' aspect ratio) so nothing is stretched or letterboxed.
	private applyCamera(level: Level): void {
		if(level.width === this.cameraWidth && level.height === this.cameraHeight) {
			return;
		}

		const zoom = Math.min(LEVEL.width / level.width, LEVEL.height / level.height);
		const camera = this.cameras.main;
		camera.setZoom(zoom);
		camera.centerOn(level.width / 2, level.height / 2);
		this.cameraWidth = level.width;
		this.cameraHeight = level.height;
	}

	private draw(): void {
		const graphics = this.graphics;
		graphics.clear();

		const level = this.host.runtime?.level ?? LEVEL;
		graphics.lineStyle(2, LEVEL_BORDER_COLOR, 1);
		graphics.strokeRect(0, 0, level.width, level.height);

		const runtime = this.host.runtime;
		if(!runtime) {
			return;
		}

		// A swarm - thousands of boids - is drawn its own way: the default loop's outlined, filled circle is a
		// triangulated arc plus a stroke plus a matrix save/restore *per entity*, which is fine for a scene of a
		// few dozen and falls over at ten thousand.  The swarm path draws each as a single flat triangle instead,
		// so a whole flock is one cheap pass with no strokes and no arcs.
		if(this.host.swarm) {
			this.drawSwarm(runtime.world.entities.values());

			return;
		}

		for(const entity of runtime.world.entities.values()) {
			const transform = entity.components.transform;
			if(!transform) {
				continue;
			}

			// The example gets first say on how one of its entities is drawn - that is how the sensors read as
			// coloured zones - and only where it declines does the renderer's own rule apply: palette by id for a
			// mover, flat grey for the scenery the physics system never moves.
			const style = this.host.entityStyle(entity);
			const color = style ? style.color : entity.components.velocity ? PALETTE[entity.eid % PALETTE.length] : STATIC_COLOR;
			graphics.fillStyle(color, style?.alpha ?? 0.85);
			graphics.lineStyle(1.5, color, 1);

			// Where to draw it and how big it is come from different blocks: the interpolation component holds
			// only a position, and everything about the shape stays on the transform.  An entity the example
			// never asked to interpolate - the walls - has no interpolation block and falls back to the one
			// place a position always exists.
			const interpolation = this.host.interpolate ? entity.components.interpolation : undefined;
			drawShape(graphics, interpolation ?? transform, transform, entity.components.body?.shape ?? SHAPE_RECTANGLE);
		}
	}

	// Draws a swarm the cheap way: one flat, unstroked triangle per mover, pointed the way it is going.  This is
	// what lets the boids example carry ten thousand entities - the per-entity work is a colour, three points and
	// a single `fillTriangle`, with none of the arc triangulation, stroking or per-shape canvas save/restore the
	// default loop does.  Everything without a velocity (the level's walls) is skipped, since a swarm is all
	// movers and scenery has no heading to point.
	private drawSwarm(entities: Iterable<BaseEntity<Components, Config>>): void {
		const graphics = this.graphics;

		for(const entity of entities) {
			const velocity = entity.components.velocity;
			const transform = entity.components.transform;
			if(!velocity || !transform) {
				continue;
			}

			// The example still gets first say on the colour - the boids example returns a hue taken from the
			// heading - and only where it declines does the id palette stand in.
			const style = this.host.entityStyle(entity);
			const color = style ? style.color : PALETTE[entity.eid % PALETTE.length];
			graphics.fillStyle(color, style?.alpha ?? 0.9);

			// Drawn at the render position when interpolating, the transform otherwise - the same choice the
			// default loop makes - and pointed along its velocity, with its size taken from the transform.
			const position = (this.host.interpolate ? entity.components.interpolation : undefined) ?? transform;
			drawDart(graphics, position.x, position.y, velocity.velocityX, velocity.velocityY, transform.width);
		}
	}

	// The score, lives and banner the current example asked for, written straight into the two text objects.
	// Phaser#setText takes a joined string, so the status lines - however many the example returned - are joined
	// with a newline, and an example with nothing to say clears both back to empty.
	private drawHud(): void {
		const hud = this.host.hud();
		this.statusText.setText(hud?.status ? hud.status.join('\n') : '');
		this.bannerText.setText(hud?.banner ?? '');
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

	// A capsule is `width` end to end and `height` thick, lying along `angle`: a rectangle with a semicircle
	// cap on each end, which is the outline the library actually collides it as.
	if(shape === SHAPE_CAPSULE) {
		drawCapsule(graphics, x, y, width, height, angle);

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

// One boid: a small three-point dart pointed along its velocity, filled flat with whatever colour is already
// set.  The tip leads the way it is going and the two tail corners trail behind, worked out from the heading and
// the vector square to it - no rotation matrix, so this is a handful of multiplies and one `fillTriangle`, which
// is the whole reason a flock of ten thousand of them draws.  A boid that has been stopped dead points up rather
// than collapsing to a line.
function drawDart(graphics: Phaser.GameObjects.Graphics, x: number, y: number, velocityX: number, velocityY: number, size: number): void {
	const speed = Math.hypot(velocityX, velocityY);
	let headingX = 0;
	let headingY = -1;
	if(speed > 0) {
		headingX = velocityX / speed;
		headingY = velocityY / speed;
	}

	// Along the heading, and square to it.  The dart is a little longer than it is wide so the direction reads.
	const length = size * 1.6;
	const halfWidth = size * 0.7;
	const perpX = -headingY;
	const perpY = headingX;

	// The tip leads by more than the tail trails, so the point of the dart sits ahead of the boid's centre.
	const tipX = x + headingX * length * 0.6;
	const tipY = y + headingY * length * 0.6;
	const backX = x - headingX * length * 0.4;
	const backY = y - headingY * length * 0.4;

	graphics.fillTriangle(
		tipX, tipY,
		backX + perpX * halfWidth, backY + perpY * halfWidth,
		backX - perpX * halfWidth, backY - perpY * halfWidth,
	);
}

// Builds the stadium outline once as a ring of points and fills it as a single polygon, so the fill alpha does
// not double up where a rectangle and two circles would otherwise overlap.  Drawn in the capsule's own frame -
// origin at its centre, +x along its length - which is why the points are the unrotated shape and the canvas
// carries the position and angle.
function drawCapsule(graphics: Phaser.GameObjects.Graphics, x: number, y: number, width: number, height: number, angle: number): void {
	const radius = height / 2;
	// How far each cap's centre sits from the middle.  Clamped at 0 so a capsule drawn shorter than it is thick
	// degrades to a circle rather than turning itself inside out.
	const capOffset = Math.max(0, width / 2 - radius);
	const SEGMENTS = 12;

	const points: Array<PhaserMath.Vector2> = [];
	// Right cap, swept from the top of the shape round through +x to the bottom.
	for(let i = 0; i <= SEGMENTS; i++) {
		const a = -Math.PI / 2 + (Math.PI * i) / SEGMENTS;
		points.push(new PhaserMath.Vector2(capOffset + Math.cos(a) * radius, Math.sin(a) * radius));
	}
	// Left cap, carrying on from the bottom round through -x back to the top, so the two caps close into one ring.
	for(let i = 0; i <= SEGMENTS; i++) {
		const a = Math.PI / 2 + (Math.PI * i) / SEGMENTS;
		points.push(new PhaserMath.Vector2(-capOffset + Math.cos(a) * radius, Math.sin(a) * radius));
	}

	graphics.save();
	graphics.translateCanvas(x, y);
	if(angle !== 0) {
		graphics.rotateCanvas(angle);
	}
	graphics.fillPoints(points, true);
	graphics.strokePoints(points, true);
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
