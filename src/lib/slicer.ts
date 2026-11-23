// Slice anything: meshes in a three.js scene that a plane can cut, as many times as you like. Every piece is a
// closed solid with its own Rapier body; cut faces get the object's inside material; cuts are queued and worked
// off inside a time budget each frame, so a swing through a pile never stalls a frame.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { cut } from './cut.ts';
import { geometryFromSolid, invert, measure, recentre, solidFromGeometry, type Solid } from './solid.ts';

export interface SliceableOptions {
	/** The inside: what cut faces are drawn with. It can read the `rest` attribute (the point's place in the uncut object, metres). */
	inside: THREE.Material;
	/** kg/m³. Default 1000. */
	density?: number;
	/** Points (in the mesh's own space) that hold it to the world: the piece that keeps one stays fixed. */
	pins?: THREE.Vector3[];
	friction?: number;
	restitution?: number;
	/** Yours to read back in `onCut`: what it is made of, for sounds and effects. */
	kind?: string;
	/** Pieces under this many m³ can't be cut again. Default: the slicer's. */
	minVolume?: number;
	/** Cap UVs per metre. Default 1. */
	uvScale?: number;
	/** False: the body sleeps until something touches it (a statue on its plinth). */
	awake?: boolean;
	/** How quickly its turning and its travel die away (Rapier's damping). Defaults 0.25 and 0.05. */
	angularDamping?: number;
	linearDamping?: number;
	/** How fast its two sides part after a cut, m/s. Default: the slicer's, less the heavier the piece. */
	part?: number;
	/** How fast the two sides turn away from each other about the blade, rad/s (fruit falling open). Default 0. */
	tumble?: number;
	/** Extra resistance to turning, kg·m² about every axis: for thin things on joints (a rope's lengths), which spin up without it. */
	inertia?: number;
}

export interface CutEvent {
	/** The piece that was cut (already removed). */
	parent: Piece;
	pieces: Piece[];
	/** The cut plane, world space. */
	plane: THREE.Plane;
	/** A point on the cut, world space: the middle of the parent projected on the plane. */
	point: THREE.Vector3;
	/** Centres of bits too small to keep. */
	dust: THREE.Vector3[];
	/** Area of the cut face, m². */
	area: number;
}

export interface SlicerOptions {
	/** Pieces under this many m³ can't be cut. Default 2e-5 (a 2.7 cm cube). */
	minVolume?: number;
	/** Bits under this many m³ are dropped as dust. Default a tenth of minVolume. */
	dustVolume?: number;
	/** Most pieces alive; the smallest go first. Default 700. */
	maxPieces?: number;
	/** Milliseconds of cutting a frame. Default 5. */
	budgetMs?: number;
	/** How fast the two sides part, m/s. Default 0.35. */
	part?: number;
}

interface Link {
	a: Piece;
	b: Piece | null;
	/** Anchors in each piece's own space (b null: a world point). */
	anchorA: THREE.Vector3;
	anchorB: THREE.Vector3;
	joint: RAPIER.ImpulseJoint | null;
	post: RAPIER.RigidBody | null;
}

/** A piece's collider points, bounding radius and geometry: the slow part of making it, done ahead of the frame it appears in. */
interface Prepared {
	points: Float32Array;
	radius: number;
	geometry: THREE.BufferGeometry;
}

/**
 * One cut, worked through in stages so no single frame carries all of a big one: the cut itself, then each new
 * piece's collider points and geometry, then (all in one frame, so nothing is ever half there) the swap of the old
 * piece for the new ones.
 */
interface Job {
	piece: Piece;
	/** The plane in the piece's space. */
	normal: THREE.Vector3;
	constant: number;
	push: THREE.Vector3;
	sides?: Solid[][];
	boxes?: ReturnType<typeof measure>[][];
	/** New pieces still to prepare: [side, index]. */
	todo?: [number, number][];
	ready?: Map<Solid, Prepared>;
}

let nextId = 1;

export class Piece {
	readonly id = nextId++;
	solid: Solid;
	mesh: THREE.Mesh;
	body: RAPIER.RigidBody;
	volume: number;
	/** Bounding radius about the body's origin (its centre of mass). */
	radius: number;
	options: SliceableOptions;
	materials: THREE.Material[];
	pins: THREE.Vector3[];
	links: Link[] = [];
	/** How many cuts made it. */
	generation: number;
	alive = true;
	queued = false;
	born = 0;
	/** Where the body was before the last physics step: the mesh is drawn between there and where it is now. */
	readonly was = { p: new THREE.Vector3(), q: new THREE.Quaternion() };

	constructor(solid: Solid, mesh: THREE.Mesh, body: RAPIER.RigidBody, volume: number, radius: number, options: SliceableOptions, materials: THREE.Material[], pins: THREE.Vector3[], generation: number) {
		this.solid = solid;
		this.mesh = mesh;
		this.body = body;
		this.volume = volume;
		this.radius = radius;
		this.options = options;
		this.materials = materials;
		this.pins = pins;
		this.generation = generation;
	}

	get fixed(): boolean {
		return this.pins.length > 0;
	}
}

// Directions a big piece's hull is found along: its collider is the hull of its furthest points along each
const DIRS: number[] = [];
for (let i = 0; i < 122; i++) {
	const y = 1 - (2 * (i + 0.5)) / 122;
	const r = Math.sqrt(1 - y * y);
	const a = i * 2.399963229728653;
	DIRS.push(Math.cos(a) * r, y, Math.sin(a) * r);
}
for (const d of [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]) DIRS.push(d);
/** Pieces with no more places than this give the hull every one of them. */
const HULL_ALL = 1200;

const V = new THREE.Vector3();
const Q = new THREE.Quaternion();

export class Slicer {
	readonly pieces = new Set<Piece>();
	readonly byCollider = new Map<number, Piece>();
	onCut: (event: CutEvent) => void = () => {};
	/** Worst frame's cutting time since the last reset (ms), and cuts done: for checking the budget holds. */
	stats = { cuts: 0, worstMs: 0, lastMs: 0, queued: 0, frameMs: 0, solidMs: 0, hullMs: 0, bodyMs: 0, meshMs: 0, cutMs: 0 };
	readonly minVolume: number;
	readonly dustVolume: number;
	readonly maxPieces: number;
	budgetMs: number;
	part: number;
	private readonly queue: Job[] = [];
	private readonly links = new Set<Link>();
	private readonly solids = new WeakMap<THREE.BufferGeometry, Map<string, Solid>>();
	private clock = 0;
	private readonly world: RAPIER.World;
	private readonly rapier: typeof RAPIER;
	private readonly scene: THREE.Object3D;

	constructor(world: RAPIER.World, rapier: typeof RAPIER, scene: THREE.Object3D, options: SlicerOptions = {}) {
		this.world = world;
		this.rapier = rapier;
		this.scene = scene;
		this.minVolume = options.minVolume ?? 2e-5;
		this.dustVolume = options.dustVolume ?? this.minVolume / 10;
		this.maxPieces = options.maxPieces ?? 700;
		this.budgetMs = options.budgetMs ?? 5;
		this.part = options.part ?? 0.35;
	}

	/**
	 * Makes a mesh cuttable. Its geometry (any closed or open triangle mesh, with or without an index or groups)
	 * and its place in the world are taken; the mesh itself is left alone and can be thrown away. The mesh's
	 * material (or materials, by group) is the outside; `options.inside` is what cuts show.
	 */
	add(mesh: THREE.Mesh, options: SliceableOptions): Piece {
		mesh.updateWorldMatrix(true, false);
		const position = new THREE.Vector3();
		const quaternion = new THREE.Quaternion();
		const scale = new THREE.Vector3();
		mesh.matrixWorld.decompose(position, quaternion, scale);
		const outside = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
		const t0 = performance.now();
		// (Welding a scan and closing its holes is the slow part of adding it, so each geometry is done once: adding
		// the same thing again, as a reset does, copies the result)
		const key = `${scale.x},${scale.y},${scale.z},${outside.length}`;
		let made = this.solids.get(mesh.geometry)?.get(key);
		if (!made) {
			const geometry = mesh.geometry.clone();
			// (Scale is baked in, so `rest` is in metres and a body never carries a scale)
			geometry.applyMatrix4(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z));
			made = solidFromGeometry(geometry, outside.length);
			if (measure(made).volume < 0) invert(made);
			if (!this.solids.has(mesh.geometry)) this.solids.set(mesh.geometry, new Map());
			this.solids.get(mesh.geometry)!.set(key, made);
		}
		const solid: Solid = { ...made, v: made.v.slice(), weld: made.weld, tris: made.tris, slot: made.slot };
		this.stats.solidMs += performance.now() - t0;
		const pins = (options.pins ?? []).map((p) => p.clone().multiply(scale));
		const piece = this.spawn(solid, position, quaternion, null, options, [...outside, options.inside], pins, 0, mesh.name);
		if (!piece) throw new Error('slicer: the mesh has no volume');
		return piece;
	}

	/** A ball joint between two pieces (or a piece and the world, with `b` null) at a world point. It follows whichever piece keeps that point when either is cut. */
	link(a: Piece, b: Piece | null, at: THREE.Vector3): void {
		const link: Link = { a, b, anchorA: this.toLocal(a, at), anchorB: b ? this.toLocal(b, at) : at.clone(), joint: null, post: null };
		this.links.add(link);
		a.links.push(link);
		b?.links.push(link);
		this.join(link);
	}

	/** Queues a cut of every piece the plane (world space) crosses, or of those `only` accepts. Returns how many. */
	slice(plane: THREE.Plane, push = new THREE.Vector3(), only?: (piece: Piece) => boolean): number {
		let n = 0;
		for (const piece of this.pieces) {
			if (only && !only(piece)) continue;
			const t = piece.body.translation();
			if (Math.abs(plane.normal.x * t.x + plane.normal.y * t.y + plane.normal.z * t.z + plane.constant) > piece.radius) continue;
			if (this.cut(piece, plane, push)) n++;
		}
		return n;
	}

	/** Queues a cut of one piece along a world plane. `push`: velocity (m/s) the blade gives both sides. */
	cut(piece: Piece, plane: THREE.Plane, push = new THREE.Vector3()): boolean {
		if (!piece.alive || piece.queued || piece.volume < (piece.options.minVolume ?? this.minVolume)) return false;
		// (Where the piece is drawn, which is what the blade was seen to pass through)
		const t = piece.mesh.position;
		const normal = plane.normal.clone().applyQuaternion(Q.copy(piece.mesh.quaternion).invert());
		const constant = plane.normal.x * t.x + plane.normal.y * t.y + plane.normal.z * t.z + plane.constant;
		piece.queued = true;
		this.queue.push({ piece, normal, constant, push: push.clone() });
		return true;
	}

	/** Before each physics step: remembers where every moving piece is, for drawing between steps. */
	beforeStep(): void {
		for (const piece of this.pieces) {
			if (piece.body.isSleeping()) continue;
			const t = piece.body.translation();
			const r = piece.body.rotation();
			piece.was.p.set(t.x, t.y, t.z);
			piece.was.q.set(r.x, r.y, r.z, r.w);
		}
	}

	/**
	 * Each frame, after the physics steps: does the queued cuts the budget allows, then moves the meshes to
	 * their bodies. `alpha` (0..1): how far the frame is between the last two physics steps, for a fixed step
	 * drawn smoothly at any speed; leave it at 1 if you step once a frame.
	 */
	update(dt = 1 / 60, alpha = 1): void {
		this.clock += dt;
		const start = performance.now();
		let done = 0;
		let stages = 0;
		while (this.queue.length && (stages === 0 || performance.now() - start < this.budgetMs)) {
			if (this.advance(this.queue[0])) {
				this.queue.shift();
				done++;
			}
			stages++;
		}
		this.stats.frameMs = stages ? performance.now() - start : 0;
		if (stages) {
			const ms = performance.now() - start;
			this.stats.cuts += done;
			this.stats.lastMs = ms;
			if (ms > this.stats.worstMs) this.stats.worstMs = ms;
		}
		this.stats.queued = this.queue.length;
		for (const piece of this.pieces) {
			if (piece.body.isSleeping() && piece.born < this.clock - 0.1) continue;
			const t = piece.body.translation();
			const r = piece.body.rotation();
			piece.mesh.position.set(t.x, t.y, t.z);
			piece.mesh.quaternion.set(r.x, r.y, r.z, r.w);
			if (alpha < 1) {
				piece.mesh.position.lerpVectors(piece.was.p, piece.mesh.position, alpha);
				piece.mesh.quaternion.slerpQuaternions(piece.was.q, piece.mesh.quaternion, alpha);
			}
		}
	}

	/** True while cuts wait their turn. */
	get busy(): boolean {
		return this.queue.length > 0;
	}

	/** The piece a ray hits first, with how far along. */
	raycast(origin: THREE.Vector3, direction: THREE.Vector3, far: number): { piece: Piece | null; distance: number } | null {
		const hit = this.world.castRay(new this.rapier.Ray(origin, direction), far, true);
		if (!hit) return null;
		return { piece: this.byCollider.get(hit.collider.handle) ?? null, distance: hit.timeOfImpact };
	}

	/**
	 * Puts a tiny, already cut piece of every set of materials in use at `at` (somewhere the camera and the sun
	 * can see), and returns a function that takes them away again. Draw a frame or two in between, through the
	 * same passes the game draws with: the renderer then has every pipeline a cut can ask for (the inside of each
	 * thing, in each pass, shadows too) before the first cut, where otherwise the first cut of each kind stalls
	 * while they are built.
	 */
	warm(at: THREE.Vector3, size = 0.02): () => void {
		const group = new THREE.Group();
		const seen = new Set<string>();
		const shape = new THREE.BoxGeometry(1, 1, 1);
		shape.clearGroups();
		const box = solidFromGeometry(shape, 1);
		const half = cut(box, [0.3, 0.9, 0.2], 0.05).below[0];
		let i = 0;
		for (const piece of this.pieces) {
			const key = piece.materials.map((m) => m.uuid).join();
			if (seen.has(key)) continue;
			seen.add(key);
			// (The same two halves for all: outside in slot 0 of however many outsides, inside in the last)
			const solid = { ...half, slot: half.slot.map((m) => (m === 1 ? piece.materials.length - 1 : 0)), capSlot: piece.materials.length - 1 };
			const mesh = new THREE.Mesh(geometryFromSolid(solid), piece.materials);
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.scale.setScalar(size);
			mesh.position.set(at.x + ((i % 8) - 3.5) * size * 1.6, at.y + Math.floor(i / 8) * size * 1.6, at.z);
			group.add(mesh);
			i++;
		}
		this.scene.add(group);
		return () => {
			this.scene.remove(group);
			for (const m of group.children) (m as THREE.Mesh).geometry.dispose();
		};
	}

	remove(piece: Piece): void {
		if (!piece.alive) return;
		piece.alive = false;
		this.pieces.delete(piece);
		for (const link of [...piece.links]) this.unlink(link);
		for (let i = 0; i < piece.body.numColliders(); i++) this.byCollider.delete(piece.body.collider(i).handle);
		this.world.removeRigidBody(piece.body);
		this.scene.remove(piece.mesh);
		piece.mesh.geometry.dispose();
	}

	clear(): void {
		this.queue.length = 0;
		for (const piece of [...this.pieces]) this.remove(piece);
	}

	private toLocal(piece: Piece, world: THREE.Vector3): THREE.Vector3 {
		const t = piece.body.translation();
		const r = piece.body.rotation();
		return world.clone().sub(V.set(t.x, t.y, t.z)).applyQuaternion(Q.set(r.x, r.y, r.z, r.w).invert());
	}

	private join(link: Link): void {
		const { rapier, world } = this;
		let other: RAPIER.RigidBody;
		let anchorB = link.anchorB;
		if (link.b) other = link.b.body;
		else {
			link.post = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(link.anchorB.x, link.anchorB.y, link.anchorB.z));
			other = link.post;
			anchorB = new THREE.Vector3();
		}
		link.joint = world.createImpulseJoint(rapier.JointData.spherical(link.anchorA, anchorB), link.a.body, other, true);
		// (Linked pieces meet end to end: their colliders must not fight the joint)
		link.joint.setContactsEnabled(false);
	}

	private unlink(link: Link): void {
		// (Removing a body removes its joints with it, so only the bookkeeping and the post are ours)
		if (link.joint && link.a.alive && (!link.b || link.b.alive)) this.world.removeImpulseJoint(link.joint, true);
		if (link.post) this.world.removeRigidBody(link.post);
		link.joint = null;
		link.post = null;
		this.links.delete(link);
		link.a.links = link.a.links.filter((l) => l !== link);
		if (link.b) link.b.links = link.b.links.filter((l) => l !== link);
	}

	/** Does the next stage of a cut. True when the cut is finished (or was dropped). */
	private advance(job: Job): boolean {
		const { piece } = job;
		if (!piece.alive) return true;
		const n = job.normal;
		if (!job.sides) {
			const t0 = performance.now();
			const result = cut(piece.solid, [n.x, n.y, n.z], job.constant, piece.options.uvScale ?? 1);
			this.stats.cutMs += performance.now() - t0;
			if (!result.cut) {
				piece.queued = false;
				return true;
			}
			job.sides = [result.below, result.above];
			job.boxes = job.sides.map((list) => list.map((s) => measure(s)));
			job.todo = [];
			job.ready = new Map();
			job.sides.forEach((list, side) => list.forEach((_, k) => job.boxes![side][k].volume >= this.dustVolume && job.todo!.push([side, k])));
			return false;
		}
		if (job.todo!.length) {
			const [side, k] = job.todo!.pop()!;
			const solid = job.sides[side][k];
			recentre(solid, job.boxes![side][k].centroid);
			job.ready!.set(solid, this.prepare(solid));
			return false;
		}
		this.commit(job);
		return true;
	}

	/** The last stage: the old piece goes and the new ones appear, with its motion, pins and joints. */
	private commit(job: Job): void {
		const { piece } = job;
		piece.queued = false;
		const n = job.normal;
		const sides = job.sides!;
		const boxes = job.boxes!;
		const t = piece.body.translation();
		const r = piece.body.rotation();
		const position = new THREE.Vector3(t.x, t.y, t.z);
		const quaternion = new THREE.Quaternion(r.x, r.y, r.z, r.w);
		const lin = piece.body.linvel();
		const ang = piece.body.angvel();
		const motion = { lin: new THREE.Vector3(lin.x, lin.y, lin.z), ang: new THREE.Vector3(ang.x, ang.y, ang.z), push: job.push, normal: n.clone().applyQuaternion(quaternion) };
		const dustAt: THREE.Vector3[] = [];
		const made: { piece: Piece; centre: THREE.Vector3; side: number }[] = [];
		// Which new piece keeps each pin and each joint: the one on the point's side whose box is nearest it
		const owner = (p: THREE.Vector3): [number, number] => {
			const side = n.x * p.x + n.y * p.y + n.z * p.z + job.constant < 0 ? 0 : 1;
			let best = 0;
			let least = Infinity;
			boxes[side].forEach((m, k) => {
				const dx = Math.max(m.min[0] - p.x, 0, p.x - m.max[0]);
				const dy = Math.max(m.min[1] - p.y, 0, p.y - m.max[1]);
				const dz = Math.max(m.min[2] - p.z, 0, p.z - m.max[2]);
				const d = dx * dx + dy * dy + dz * dz;
				if (d < least) {
					least = d;
					best = k;
				}
			});
			return [side, best];
		};
		const pinOwners = piece.pins.map(owner);
		const linkEnds = piece.links.map((link) => ({ link, isA: link.a === piece, at: owner(link.a === piece ? link.anchorA : link.anchorB) }));
		let area = 0;
		for (let side = 0; side < 2; side++)
			sides[side].forEach((solid, k) => {
				const m = boxes[side][k];
				const centre = new THREE.Vector3(m.centroid[0], m.centroid[1], m.centroid[2]);
				if (m.volume < this.dustVolume) {
					dustAt.push(centre.applyQuaternion(quaternion).add(position));
					return;
				}
				const pins = piece.pins.filter((_, i) => pinOwners[i][0] === side && pinOwners[i][1] === k).map((p) => p.clone().sub(centre));
				const child = this.spawn(solid, centre.clone().applyQuaternion(quaternion).add(position), quaternion, { ...motion, offset: centre.clone().applyQuaternion(quaternion), side }, piece.options, piece.materials, pins, piece.generation + 1, piece.mesh.name, m.volume, job.ready!.get(solid));
				if (child) {
					made.push({ piece: child, centre, side });
					child.was.p.copy(centre).applyQuaternion(piece.was.q).add(piece.was.p);
					child.was.q.copy(piece.was.q);
				}
				if (side === 0) for (let t = 0; t < solid.ntris; t++) if (solid.slot[t] === solid.capSlot) area += triangleArea(solid, t);
			});
		// Joints go to the pieces that kept their anchors
		const moved: Link[] = [];
		for (const { link, isA, at } of linkEnds) {
			const heir = made.find((c) => c.side === at[0] && sides[at[0]].indexOf(c.piece.solid) === at[1]);
			const other = isA ? link.b : link.a;
			if (link.post) this.world.removeRigidBody(link.post);
			link.post = null;
			link.joint = null;
			if (!heir || (other && !other.alive)) {
				this.links.delete(link);
				if (other) other.links = other.links.filter((l) => l !== link);
				continue;
			}
			if (isA) {
				link.a = heir.piece;
				link.anchorA = link.anchorA.clone().sub(heir.centre);
			} else {
				link.b = heir.piece;
				link.anchorB = link.anchorB.clone().sub(heir.centre);
			}
			heir.piece.links.push(link);
			moved.push(link);
		}
		piece.links = [];
		this.remove(piece);
		// (A joint whose both ends were this piece is joined once, after both ends moved)
		for (const link of new Set(moved)) if (link.a.alive && (!link.b || link.b.alive)) this.join(link);
		const world = job.normal.clone().applyQuaternion(quaternion);
		const plane = new THREE.Plane(world, 0);
		plane.constant = -world.dot(position) + job.constant;
		const point = plane.projectPoint(position, new THREE.Vector3());
		this.onCut({ parent: piece, pieces: made.map((c) => c.piece), plane, point, dust: dustAt, area });
		this.trim();
	}

	private spawn(
		solid: Solid,
		position: THREE.Vector3,
		quaternion: THREE.Quaternion,
		motion: { lin: THREE.Vector3; ang: THREE.Vector3; push: THREE.Vector3; normal: THREE.Vector3; offset: THREE.Vector3; side: number } | null,
		options: SliceableOptions,
		materials: THREE.Material[],
		pins: THREE.Vector3[],
		generation: number,
		name: string,
		knownVolume?: number,
		prepared?: Prepared,
	): Piece | null {
		const { rapier, world } = this;
		let volume = knownVolume ?? 0;
		if (knownVolume === undefined) {
			const m = measure(solid);
			if (!(m.volume > 0)) return null;
			volume = m.volume;
			const c = new THREE.Vector3(m.centroid[0], m.centroid[1], m.centroid[2]);
			recentre(solid, m.centroid);
			for (const p of pins) p.sub(c);
			position = position.clone().add(c.applyQuaternion(quaternion));
		}
		const t1 = performance.now();
		const { points, radius, geometry } = prepared ?? this.prepare(solid);
		const t2 = performance.now();
		void t1;
		const fixed = pins.length > 0;
		const desc = (fixed ? rapier.RigidBodyDesc.fixed() : rapier.RigidBodyDesc.dynamic()).setTranslation(position.x, position.y, position.z).setRotation(quaternion);
		if (!fixed) {
			if (options.inertia) desc.setAdditionalMassProperties(1e-4, { x: 0, y: 0, z: 0 }, { x: options.inertia, y: options.inertia, z: options.inertia }, { x: 0, y: 0, z: 0, w: 1 });
			desc.setLinearDamping(options.linearDamping ?? 0.05).setAngularDamping(options.angularDamping ?? 0.25).setCcdEnabled(radius < 0.08);
			if (motion) {
				// Where it was going, plus the blade's push, plus a little apart from the cut
				// (Light things spring apart; a block of stone only slides)
				const mass = (options.density ?? 1000) * volume;
				const sign = motion.side ? 1 : -1;
				const part = options.part ?? this.part / (1 + mass / 1.5);
				const lin = motion.lin.clone().add(V.copy(motion.ang).cross(motion.offset)).addScaledVector(motion.push, 1 / (1 + mass / 6)).addScaledVector(motion.normal, sign * part);
				const ang = motion.ang.clone();
				// (Falling open: each side turns about the blade's own line, away from the other)
				if (options.tumble && motion.push.lengthSq() > 1e-8) ang.addScaledVector(V.crossVectors(motion.normal, motion.push).normalize(), -sign * options.tumble);
				desc.setLinvel(lin.x, lin.y, lin.z).setAngvel(ang);
			} else if (options.awake === false) desc.setSleeping(true);
		}
		const body = world.createRigidBody(desc);
		let collider = rapier.ColliderDesc.convexHull(points);
		if (!collider) {
			const m = measure(solid);
			collider = rapier.ColliderDesc.cuboid(Math.max(0.004, (m.max[0] - m.min[0]) / 2), Math.max(0.004, (m.max[1] - m.min[1]) / 2), Math.max(0.004, (m.max[2] - m.min[2]) / 2));
		}
		collider.setFriction(options.friction ?? 0.7).setRestitution(options.restitution ?? 0.1).setMass((options.density ?? 1000) * volume);
		const handle = world.createCollider(collider, body);
		const t3 = performance.now();
		this.stats.bodyMs += t3 - t2;
		const mesh = new THREE.Mesh(geometry, materials);
		mesh.name = name;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.position.copy(position);
		mesh.quaternion.copy(quaternion);
		this.scene.add(mesh);
		this.stats.meshMs += performance.now() - t3;
		const piece = new Piece(solid, mesh, body, volume, radius, options, materials, pins, generation);
		piece.born = this.clock;
		piece.was.p.copy(position);
		piece.was.q.copy(quaternion);
		this.pieces.add(piece);
		this.byCollider.set(handle.handle, piece);
		return piece;
	}

	/** A piece's collider points, its radius and its geometry. */
	private prepare(solid: Solid): Prepared {
		const t0 = performance.now();
		// The collider: the piece's convex hull. A small piece gives every place it has; a big one, its furthest
		// points along a spread of directions (a hull of a hundred-odd points, found in one pass).
		const { v, stride, count } = solid;
		let radius = 0;
		let points: Float32Array;
		if (solid.welds <= HULL_ALL) {
			points = new Float32Array(solid.welds * 3);
			const seen = new Uint8Array(solid.welds);
			let k = 0;
			for (let i = 0; i < count; i++) {
				const w = solid.weld[i];
				if (seen[w]) continue;
				seen[w] = 1;
				const x = v[i * stride], y = v[i * stride + 1], z = v[i * stride + 2];
				radius = Math.max(radius, x * x + y * y + z * z);
				points[k++] = x;
				points[k++] = y;
				points[k++] = z;
			}
			points = points.subarray(0, k);
		} else {
			const best = new Float64Array(DIRS.length / 3).fill(-Infinity);
			const at = new Int32Array(DIRS.length / 3);
			for (let i = 0; i < count; i++) {
				const x = v[i * stride], y = v[i * stride + 1], z = v[i * stride + 2];
				const r2 = x * x + y * y + z * z;
				if (r2 > radius) radius = r2;
				for (let d = 0, k = 0; d < DIRS.length; d += 3, k++) {
					const s = x * DIRS[d] + y * DIRS[d + 1] + z * DIRS[d + 2];
					if (s > best[k]) {
						best[k] = s;
						at[k] = i;
					}
				}
			}
			const chosen = new Set<number>(at);
			points = new Float32Array(chosen.size * 3);
			let k = 0;
			for (const i of chosen) {
				points[k++] = v[i * stride];
				points[k++] = v[i * stride + 1];
				points[k++] = v[i * stride + 2];
			}
		}
		radius = Math.sqrt(radius);
		this.stats.hullMs += performance.now() - t0;
		const t1 = performance.now();
		const geometry = geometryFromSolid(solid);
		this.stats.meshMs += performance.now() - t1;
		return { points, radius, geometry };
	}

	/** Past the limit, the smallest loose pieces go. */
	private trim(): void {
		if (this.pieces.size <= this.maxPieces) return;
		const loose = [...this.pieces].filter((p) => !p.fixed && !p.links.length && !p.queued).sort((a, b) => a.volume - b.volume);
		for (let i = 0; i < loose.length && this.pieces.size > this.maxPieces; i++) this.remove(loose[i]);
	}
}

function triangleArea(s: Solid, t: number): number {
	const a = s.tris[3 * t] * s.stride, b = s.tris[3 * t + 1] * s.stride, c = s.tris[3 * t + 2] * s.stride;
	const ux = s.v[b] - s.v[a], uy = s.v[b + 1] - s.v[a + 1], uz = s.v[b + 2] - s.v[a + 2];
	const vx = s.v[c] - s.v[a], vy = s.v[c + 1] - s.v[a + 1], vz = s.v[c + 2] - s.v[a + 2];
	return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}
