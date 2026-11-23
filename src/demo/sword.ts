// The blade, first person, no hands: the grip runs off the bottom of the screen. A swing is a sweep of the blade
// in one plane, the plane you drew with the mouse, and that plane is what cuts: an object splits where the edge
// went through it, when the edge goes through it.
import * as THREE from 'three/webgpu';
import { attribute, float, vec4 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface Blade {
	name: string;
	file: string;
	scale: number;
	/** Along the model's Y, after scale: where the hand holds it, where the edge starts, the tip. */
	hold: number;
	edge: number;
	tip: number;
	/** Seconds: drawing back, the cut, carrying through, coming back to rest. */
	windup: number;
	strike: number;
	follow: number;
	recover: number;
	/** The pause when it bites (seconds of real time), the push it gives (m/s), how hard it shakes the view. */
	stop: number;
	push: number;
	shake: number;
	/** How far each way from straight ahead it sweeps (rad). */
	sweep: number;
}

export const BLADES: Blade[] = [
	{ name: 'Katana', file: 'assets/swords/katana/antique_katana_01_2k.gltf', scale: 1.2, hold: -0.13, edge: 0.12, tip: 0.835, windup: 0.12, strike: 0.1, follow: 0.15, recover: 0.27, stop: 0.04, push: 0.9, shake: 0.5, sweep: 1.05 },
	{ name: 'Longsword', file: 'assets/swords/estoc/antique_estoc_2k.gltf', scale: 0.92, hold: -0.02, edge: 0.24, tip: 1.19, windup: 0.17, strike: 0.12, follow: 0.2, recover: 0.36, stop: 0.052, push: 1.7, shake: 1, sweep: 1.1 },
];

/** A swing's plane in the camera's space: the hand's pivot, the two directions the blade sweeps between, the normal. */
interface Frame {
	pivot: THREE.Vector3;
	a: THREE.Vector3;
	b: THREE.Vector3;
	n: THREE.Vector3;
}

export interface Reach {
	/** The cut plane, world space. */
	plane: THREE.Plane;
	/** The pivot and the frame's directions, world space. */
	pivot: THREE.Vector3;
	a: THREE.Vector3;
	b: THREE.Vector3;
	/** How far the blade has swept this frame (rad from straight ahead): from, to. */
	from: number;
	to: number;
	/** How far from the pivot the edge starts and the tip is (m). */
	near: number;
	far: number;
	/** Which way the edge is moving at angle φ, world space. */
	travel(phi: number): THREE.Vector3;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const PIVOT = new THREE.Vector3(0.17, -0.27, -0.08);

export class Sword {
	/** Rides the camera. */
	readonly rig = new THREE.Group();
	readonly holder = new THREE.Group();
	blade = BLADES[0];
	index = 0;
	/** The cut's direction on screen (rad, 0 right, π/2 up). */
	theta = -0.6;
	/** 'rest' | 'windup' | 'strike' | 'follow' | 'recover' */
	phase = 'rest';
	private t = 0;
	private frame: Frame | null = null;
	private phi = 0;
	private last = 0;
	private readonly models: THREE.Object3D[] = [];
	private readonly idle = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
	private readonly from = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
	private sway = new THREE.Vector2();
	private bob = 0;
	private clock = 0;
	private flip = 1;
	private readonly trail: Trail;
	swings = 0;
	private bitten = false;
	/**
	 * Called as the blade sweeps further round its plane. Return an angle inside the sweep to hold the blade
	 * there (where it bit into something): the swing carries on from that angle.
	 */
	onReach: (reach: Reach) => number | void = () => {};

	constructor(camera: THREE.Camera, scene: THREE.Scene) {
		camera.add(this.rig);
		this.rig.add(this.holder);
		this.trail = new Trail();
		scene.add(this.trail.mesh);
	}

	async load(): Promise<void> {
		const loader = new GLTFLoader();
		for (const b of BLADES) {
			const gltf = await loader.loadAsync(b.file);
			const model = gltf.scene;
			model.scale.setScalar(b.scale);
			model.position.y = -b.hold;
			model.traverse((o) => {
				const m = o as THREE.Mesh;
				if (!m.isMesh) return;
				m.castShadow = false;
				m.frustumCulled = false;
				const mat = m.material as THREE.MeshStandardMaterial;
				// (Steel that picks up the sky: the scan's roughness is kept, the blade just made a little keener)
				mat.envMapIntensity = 1.6;
			});
			model.visible = false;
			this.holder.add(model);
			this.models.push(model);
		}
		this.select(0);
	}

	/** Shows every blade at once (or goes back to the chosen one): for building their pipelines during load. */
	showAll(on: boolean): void {
		this.models.forEach((m, k) => (m.visible = on || k === this.index));
	}

	/** Brings the blade up from below the frame to its rest: after a reset, or a change of blade. */
	raise(): void {
		if (this.phase !== 'rest') return;
		this.from.p.copy(this.idle.p).add(new THREE.Vector3(0.06, -0.55, 0.12));
		this.from.q.copy(this.idle.q);
		this.apply(this.from.p, this.from.q);
		this.phase = 'recover';
		this.t = 0;
	}

	select(i: number): void {
		if (this.phase !== 'rest') return;
		this.index = i;
		this.blade = BLADES[i];
		this.models.forEach((m, k) => (m.visible = k === i));
		// At rest: low on the right, tip up and a little in, the flat turned to catch the light; the grip is out of frame
		const dir = new THREE.Vector3(-0.1, 0.86, -0.5).normalize();
		const edge = new THREE.Vector3(-0.55, -0.45, -0.7).normalize();
		this.idle.p.set(0.3, -0.37, -0.44);
		this.idle.q.copy(orient(dir, edge));
		this.apply(this.idle.p, this.idle.q);
	}

	/** The plane a swing in direction `theta` would cut, for a target `distance` ahead (camera space). */
	private frameFor(theta: number, distance: number): Frame {
		const target = new THREE.Vector3(0, 0, -distance);
		const a = target.sub(PIVOT).normalize();
		const s = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
		const b = s.addScaledVector(a, -s.dot(a)).normalize();
		return { pivot: PIVOT.clone(), a, b, n: new THREE.Vector3().crossVectors(a, b) };
	}

	/** The world plane a swing would cut now: what the focus preview shows. */
	preview(camera: THREE.Camera, distance: number): THREE.Plane {
		const f = this.frameFor(this.theta, distance);
		const n = f.n.clone().transformDirection(camera.matrixWorld);
		const p = f.pivot.clone().applyMatrix4(camera.matrixWorld);
		return new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
	}

	/** How far the tip gets from the eye, roughly: what is in reach. */
	get reach(): number {
		return this.blade.tip - this.blade.hold + 0.24;
	}

	/** Starts a swing along `theta` (or the last direction mirrored, if none is given) at a target `distance` ahead. */
	swing(distance: number, theta?: number): boolean {
		if (this.phase !== 'rest' && this.phase !== 'recover') return false;
		if (theta === undefined) {
			// (A click with no drag: back the other way along the last line)
			this.theta += Math.PI;
		} else this.theta = theta;
		this.theta = Math.atan2(Math.sin(this.theta), Math.cos(this.theta));
		this.frame = this.frameFor(this.theta, distance);
		this.from.p.copy(this.holder.position);
		this.from.q.copy(this.holder.quaternion);
		this.phase = 'windup';
		this.t = 0;
		this.phi = this.last = -this.blade.sweep;
		this.swings++;
		this.flip = -this.flip;
		this.bitten = false;
		this.trail.clear();
		return true;
	}

	/** Blade pose at angle φ of the current swing (camera space). */
	private pose(phi: number, reachOut = 1): { p: THREE.Vector3; q: THREE.Quaternion } {
		const f = this.frame!;
		const dir = f.a.clone().multiplyScalar(Math.cos(phi)).addScaledVector(f.b, Math.sin(phi));
		const travel = f.a.clone().multiplyScalar(-Math.sin(phi)).addScaledVector(f.b, Math.cos(phi));
		const p = f.pivot.clone().addScaledVector(f.a, (0.06 + 0.17 * Math.cos(phi)) * reachOut).addScaledVector(f.b, 0.1 * Math.sin(phi));
		return { p, q: orient(dir, travel) };
	}

	private apply(p: THREE.Vector3, q: THREE.Quaternion): void {
		this.holder.position.copy(p);
		this.holder.quaternion.copy(q);
	}

	/**
	 * Each frame. `dt` is the sword's own time (it keeps moving when the world is slowed), `look` how far the view
	 * turned this frame (rad), `speed` how fast the player walks (0..1).
	 */
	update(dt: number, real: number, camera: THREE.Camera, look: THREE.Vector2, speed: number): void {
		const b = this.blade;
		this.clock += real;
		this.t += dt;
		let reached: [number, number] | null = null;
		if (this.phase === 'windup') {
			const k = clamp01(this.t / b.windup);
			const to = this.pose(-b.sweep, 0.75);
			// Drawn back a touch past the start, so the cut has somewhere to come from
			const e = 1 - (1 - k) * (1 - k);
			this.holder.position.lerpVectors(this.from.p, to.p, e);
			this.holder.quaternion.slerpQuaternions(this.from.q, to.q, e);
			if (k >= 1) {
				this.phase = 'strike';
				this.t = 0;
			}
		} else if (this.phase === 'strike') {
			const k = clamp01(this.t / b.strike);
			// Fast through the middle
			const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
			this.last = this.phi;
			this.phi = -b.sweep + 2 * b.sweep * e;
			const at = this.pose(this.phi, 0.75 + 0.25 * Math.sin(Math.PI * k));
			this.apply(at.p, at.q);
			reached = [this.last, this.phi];
			if (k >= 1) {
				this.phase = 'follow';
				this.t = 0;
			}
		} else if (this.phase === 'follow') {
			const k = clamp01(this.t / b.follow);
			const e = 1 - (1 - k) ** 3;
			const at = this.pose(b.sweep + 0.32 * e, 1 - 0.3 * e);
			this.apply(at.p, at.q);
			if (k >= 1) {
				this.phase = 'recover';
				this.t = 0;
				this.from.p.copy(this.holder.position);
				this.from.q.copy(this.holder.quaternion);
			}
		} else if (this.phase === 'recover') {
			const k = clamp01(this.t / b.recover);
			this.holder.position.lerpVectors(this.from.p, this.idle.p, smooth(k));
			this.holder.quaternion.slerpQuaternions(this.from.q, this.idle.q, smooth(k));
			if (k >= 1) this.phase = 'rest';
		}
		// At rest it breathes, lags the view a little and bobs with the walk
		this.sway.lerp(look, Math.min(1, real * 10));
		this.bob += real * speed * 9;
		if (this.phase === 'rest' || this.phase === 'recover') {
			const amount = this.phase === 'rest' ? 1 : 0.4;
			const breath = Math.sin(this.clock * 1.3);
			this.rig.position.set(-this.sway.x * 0.6 + Math.sin(this.bob * 0.5) * 0.008 * speed, this.sway.y * 0.5 + breath * 0.003 - Math.abs(Math.cos(this.bob * 0.5)) * 0.012 * speed, 0).multiplyScalar(amount);
			this.rig.rotation.set(this.sway.y * 1.2 * amount, this.sway.x * 1.5 * amount, breath * 0.006 + Math.sin(this.bob * 0.5) * 0.02 * speed);
		} else {
			this.rig.position.multiplyScalar(0.6);
			this.rig.rotation.set(this.rig.rotation.x * 0.6, this.rig.rotation.y * 0.6, this.rig.rotation.z * 0.6);
		}
		camera.updateMatrixWorld();
		this.rig.updateMatrixWorld(true);
		const b0 = this.blade;
		const lower = b0.edge - b0.hold + (b0.tip - b0.edge) * 0.15;
		const upper = b0.tip - b0.hold;
		if (reached && this.frame) {
			const f = this.frame;
			const m = camera.matrixWorld;
			const a = f.a.clone().transformDirection(m);
			const bb = f.b.clone().transformDirection(m);
			const pivot = f.pivot.clone().applyMatrix4(m);
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(f.n.clone().transformDirection(m), pivot);
			const stop = this.onReach({
				plane,
				pivot,
				a,
				b: bb,
				from: reached[0],
				to: reached[1],
				near: 0.23 + (this.blade.edge - this.blade.hold) * 0.6,
				far: 0.23 + this.blade.tip - this.blade.hold,
				travel: (phi) => a.clone().multiplyScalar(-Math.sin(phi)).addScaledVector(bb, Math.cos(phi)),
			});
			if (typeof stop === 'number' && !this.bitten && stop < reached[1]) {
				// The blade is held where it bit, and the swing's clock is set back to match
				this.bitten = true;
				this.phi = Math.max(reached[0], stop);
				const e = (this.phi + b0.sweep) / (2 * b0.sweep);
				const k = e < 0.5 ? Math.sqrt(e / 2) : 1 - Math.sqrt((1 - e) / 2);
				this.t = k * b0.strike;
				this.phase = 'strike';
				const at = this.pose(this.phi, 0.75 + 0.25 * Math.sin(Math.PI * k));
				this.apply(at.p, at.q);
				this.rig.updateMatrixWorld(true);
			}
			// The streak the edge leaves: several samples a frame, so a fast cut still draws a clean arc
			const steps = 6;
			for (let j = 1; j <= steps; j++) {
				const phi = reached[0] + ((this.phi - reached[0]) * j) / steps;
				const at = this.pose(phi, 0.9);
				const world = new THREE.Matrix4().compose(at.p, at.q, new THREE.Vector3(1, 1, 1)).premultiply(this.rig.matrixWorld);
				this.trail.add(new THREE.Vector3(0, lower, 0).applyMatrix4(world), new THREE.Vector3(0, upper, 0).applyMatrix4(world));
			}
		} else if (this.phase === 'follow' && this.t < 0.04) this.trail.add(new THREE.Vector3(0, lower, 0).applyMatrix4(this.holder.matrixWorld), new THREE.Vector3(0, upper, 0).applyMatrix4(this.holder.matrixWorld));
		this.trail.update(real);
	}

	/** Blade's tip and where its edge starts, world space (for the test scripts' stills). */
	ends(): [THREE.Vector3, THREE.Vector3] {
		return [new THREE.Vector3(0, this.blade.edge - this.blade.hold, 0).applyMatrix4(this.holder.matrixWorld), new THREE.Vector3(0, this.blade.tip - this.blade.hold, 0).applyMatrix4(this.holder.matrixWorld)];
	}
}

/** The model's turn for a blade pointing along `dir` with its edge leading along `travel` (model: blade +Y, edge −X). */
function orient(dir: THREE.Vector3, travel: THREE.Vector3): THREE.Quaternion {
	const y = dir.clone().normalize();
	const x = travel.clone().addScaledVector(y, -travel.dot(y)).normalize().negate();
	const z = new THREE.Vector3().crossVectors(x, y);
	return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** A pale streak between two points of the blade over its last moments, fading fast. */
class Trail {
	readonly mesh: THREE.Mesh;
	private readonly n = 72;
	private readonly a: THREE.Vector3[] = [];
	private readonly b: THREE.Vector3[] = [];
	private readonly age: number[] = [];
	private readonly pos: Float32Array;
	private readonly alpha: Float32Array;
	private readonly geo = new THREE.BufferGeometry();

	constructor() {
		this.pos = new Float32Array(this.n * 6);
		this.alpha = new Float32Array(this.n * 2);
		this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
		this.geo.setAttribute('fade', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
		const index: number[] = [];
		for (let i = 0; i < this.n - 1; i++) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
		this.geo.setIndex(index);
		const m = new THREE.MeshBasicNodeMaterial();
		m.transparent = true;
		m.depthWrite = false;
		m.side = THREE.DoubleSide;
		m.blending = THREE.AdditiveBlending;
		m.fog = false;
		const fade = attribute('fade', 'float');
		m.colorNode = vec4(float(1.0).mul(fade), float(0.9).mul(fade), float(0.74).mul(fade), 1);
		this.mesh = new THREE.Mesh(this.geo, m);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 10;
	}

	clear(): void {
		this.a.length = this.b.length = this.age.length = 0;
	}

	add(base: THREE.Vector3, tip: THREE.Vector3): void {
		this.a.unshift(base);
		this.b.unshift(tip);
		this.age.unshift(0);
	}

	update(dt: number): void {
		const LIFE = 0.2;
		for (let i = 0; i < this.age.length; i++) this.age[i] += dt;
		while (this.age.length > this.n || (this.age.length && this.age[this.age.length - 1] > LIFE)) {
			this.a.pop();
			this.b.pop();
			this.age.pop();
		}
		const m = this.age.length;
		for (let i = 0; i < this.n; i++) {
			const j = Math.min(i, Math.max(0, m - 1));
			const p = this.a[j];
			const q = this.b[j];
			if (p) this.pos.set([p.x, p.y, p.z, q.x, q.y, q.z], i * 6);
			const f = i < m && m > 1 ? (1 - this.age[i] / LIFE) * (1 - i / m) : 0;
			// Faint near the hand, bright along the last third to the tip
			this.alpha[2 * i] = f * f * 0.05;
			this.alpha[2 * i + 1] = f * f * 0.55;
		}
		this.geo.getAttribute('position').needsUpdate = true;
		this.geo.getAttribute('fade').needsUpdate = true;
	}
}
