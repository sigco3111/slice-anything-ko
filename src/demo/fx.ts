// What flies off a cut: chips and drops (small lit solids), and sparks and motes (small sprites that face the eye).
// (Dust puffs are off: a soft sprite drifting through a flat cut face shows as a line across it.)
import * as THREE from 'three/webgpu';
import { attribute, float, length, smoothstep, uv, vec2, vec4 } from 'three/tsl';

interface Bit {
	p: THREE.Vector3;
	v: THREE.Vector3;
	spin: THREE.Vector3;
	rot: THREE.Euler;
	size: number;
	life: number;
	age: number;
	drag: number;
	gravity: number;
}

interface Puff {
	p: THREE.Vector3;
	v: THREE.Vector3;
	size: number;
	grow: number;
	life: number;
	age: number;
	colour: THREE.Color;
	alpha: number;
	gravity: number;
	glow: boolean;
}

const BITS = 420;
const PUFFS = 220;
const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const S = new THREE.Vector3();
const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;

const KINDS: Record<string, { chips: number; chip: [number, number, number][]; size: [number, number]; rough: number; puffs: number; puff: [number, number, number]; sparks: number; drag: number; gravity: number }> = {
	stone: { chips: 16, chip: [[0.8, 0.78, 0.74], [0.6, 0.58, 0.55]], size: [0.004, 0.011], rough: 0.8, puffs: 0, puff: [0.86, 0.82, 0.76], sparks: 5, drag: 0.4, gravity: 1 },
	wood: { chips: 14, chip: [[0.78, 0.58, 0.34], [0.55, 0.36, 0.2]], size: [0.003, 0.009], rough: 0.8, puffs: 0, puff: [0.8, 0.68, 0.5], sparks: 0, drag: 0.8, gravity: 1 },
	straw: { chips: 18, chip: [[0.82, 0.78, 0.46], [0.62, 0.62, 0.3]], size: [0.003, 0.009], rough: 0.9, puffs: 0, puff: [0.85, 0.8, 0.55], sparks: 0, drag: 2.2, gravity: 0.7 },
	bamboo: { chips: 10, chip: [[0.86, 0.8, 0.56], [0.4, 0.5, 0.18]], size: [0.003, 0.008], rough: 0.7, puffs: 0, puff: [0.85, 0.82, 0.6], sparks: 0, drag: 1.2, gravity: 1 },
	fruit: { chips: 22, chip: [[0.85, 0.1, 0.1], [0.95, 0.5, 0.1]], size: [0.002, 0.005], rough: 0.15, puffs: 0, puff: [0.95, 0.6, 0.5], sparks: 0, drag: 0.5, gravity: 1 },
	lantern: { chips: 16, chip: [[0.95, 0.88, 0.7], [0.9, 0.75, 0.5]], size: [0.004, 0.012], rough: 0.95, puffs: 0, puff: [1, 0.8, 0.5], sparks: 8, drag: 5, gravity: 0.35 },
	metal: { chips: 4, chip: [[0.95, 0.72, 0.42], [0.8, 0.6, 0.3]], size: [0.002, 0.006], rough: 0.25, puffs: 0, puff: [1, 1, 1], sparks: 34, drag: 0.3, gravity: 1 },
	rope: { chips: 6, chip: [[0.8, 0.7, 0.48], [0.6, 0.5, 0.3]], size: [0.002, 0.008], rough: 0.95, puffs: 0, puff: [1, 1, 1], sparks: 0, drag: 3, gravity: 0.6 },
};

export class Fx {
	private readonly bits: Bit[] = [];
	private readonly puffs: Puff[] = [];
	private readonly bitMesh: THREE.InstancedMesh;
	private readonly puffMesh: THREE.InstancedMesh;
	private readonly tint: THREE.InstancedBufferAttribute;
	/** While set, one chip is drawn here whatever else is: so the chips' pipelines are built during load. */
	prime: THREE.Vector3 | null = null;

	constructor(scene: THREE.Scene) {
		const bitMat = new THREE.MeshStandardNodeMaterial();
		bitMat.roughness = 0.55;
		this.bitMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), bitMat, BITS);
		this.bitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.bitMesh.setColorAt(0, new THREE.Color(1, 1, 1));
		this.bitMesh.count = 0;
		this.bitMesh.frustumCulled = false;
		this.bitMesh.castShadow = true;
		scene.add(this.bitMesh);

		const quad = new THREE.PlaneGeometry(1, 1);
		this.tint = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 4), 4);
		this.tint.setUsage(THREE.DynamicDrawUsage);
		quad.setAttribute('tint', this.tint);
		const puffMat = new THREE.MeshBasicNodeMaterial();
		puffMat.transparent = true;
		puffMat.depthWrite = false;
		puffMat.fog = false;
		const tint = attribute('tint', 'vec4');
		const soft = smoothstep(0.5, 0.05, length(uv().sub(vec2(0.5, 0.5))));
		puffMat.colorNode = vec4(tint.xyz, float(1));
		puffMat.opacityNode = soft.mul(tint.w);
		this.puffMesh = new THREE.InstancedMesh(quad, puffMat, PUFFS);
		this.puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.puffMesh.count = 0;
		this.puffMesh.frustumCulled = false;
		this.puffMesh.renderOrder = 9;
		scene.add(this.puffMesh);
	}

	/**
	 * A cut through something of `kind` at `point`: bits fly along the blade's `travel` and off both sides of the
	 * plane. `amount` scales how much (the cut face's size).
	 */
	burst(kind: string, point: THREE.Vector3, normal: THREE.Vector3, travel: THREE.Vector3, amount: number, spread: number, tone?: [number, number, number][]): void {
		const k = KINDS[kind] ?? KINDS.wood;
		const scale = Math.min(1.6, 0.45 + amount);
		const along = new THREE.Vector3().crossVectors(normal, travel).normalize();
		const palette = tone ?? k.chip;
		for (let i = 0; i < Math.round(k.chips * scale) && this.bits.length < BITS; i++) {
			const c = palette[i % palette.length];
			const p = point.clone().addScaledVector(travel, rnd(spread)).addScaledVector(along, rnd(spread));
			const v = travel.clone().multiplyScalar(0.6 + Math.random() * 2.2).addScaledVector(normal, rnd(1.1)).addScaledVector(along, rnd(0.7));
			v.y += 0.5 + Math.random() * 1.2;
			this.bits.push({ p, v, spin: new THREE.Vector3(rnd(14), rnd(14), rnd(14)), rot: new THREE.Euler(rnd(3), rnd(3), rnd(3)), size: k.size[0] + Math.random() * (k.size[1] - k.size[0]), life: 1.2 + Math.random() * 1.6, age: 0, drag: k.drag, gravity: k.gravity });
			this.bitMesh.setColorAt(this.bits.length - 1, new THREE.Color(c[0], c[1], c[2]).multiplyScalar(0.8 + Math.random() * 0.4));
		}
		for (let i = 0; i < Math.round(k.puffs * scale) && this.puffs.length < PUFFS; i++) {
			const p = point.clone().addScaledVector(travel, rnd(spread)).addScaledVector(along, rnd(spread));
			const v = travel.clone().multiplyScalar(0.2 + Math.random() * 0.5).addScaledVector(normal, rnd(0.25));
			v.y += 0.1 + Math.random() * 0.2;
			this.puffs.push({ p, v, size: 0.05 + Math.random() * 0.08, grow: 0.25 + Math.random() * 0.3, life: 0.7 + Math.random() * 0.9, age: 0, colour: new THREE.Color(...k.puff).multiplyScalar(0.7), alpha: 0.14, gravity: -0.02, glow: false });
		}
		for (let i = 0; i < Math.round(k.sparks * scale) && this.puffs.length < PUFFS; i++) {
			const v = travel.clone().multiplyScalar(1.5 + Math.random() * 4).addScaledVector(normal, rnd(1.6)).addScaledVector(along, rnd(1.2));
			v.y += Math.random() * 1.5;
			this.puffs.push({ p: point.clone().addScaledVector(travel, rnd(spread * 0.6)), v, size: 0.005 + Math.random() * 0.007, grow: -0.006, life: 0.25 + Math.random() * 0.5, age: 0, colour: new THREE.Color(1, 0.72, 0.3), alpha: 1, gravity: 0.6, glow: true });
		}
	}

	/** Motes in the low sun: a few specks that drift for good. */
	motes(count: number, box: THREE.Box3): void {
		for (let i = 0; i < count; i++) {
			const p = new THREE.Vector3(THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random()), THREE.MathUtils.lerp(box.min.y, box.max.y, Math.random()), THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random()));
			this.puffs.push({ p, v: new THREE.Vector3(rnd(0.03), rnd(0.012), rnd(0.03)), size: 0.004 + Math.random() * 0.006, grow: 0, life: Infinity, age: Math.random() * 100, colour: new THREE.Color(1, 0.85, 0.6), alpha: 0.5, gravity: 0, glow: true });
		}
	}

	update(dt: number, camera: THREE.Camera): void {
		let n = 0;
		for (let i = 0; i < this.bits.length; i++) {
			const b = this.bits[i];
			b.age += dt;
			if (b.age > b.life) continue;
			b.v.y -= 9.81 * b.gravity * dt;
			b.v.multiplyScalar(Math.max(0, 1 - b.drag * dt));
			b.p.addScaledVector(b.v, dt);
			if (b.p.y < b.size * 0.5) {
				// On the ground it skids to a stop
				b.p.y = b.size * 0.5;
				b.v.y = Math.abs(b.v.y) * 0.25;
				b.v.x *= 0.6;
				b.v.z *= 0.6;
				b.spin.multiplyScalar(0.5);
			}
			b.rot.x += b.spin.x * dt;
			b.rot.y += b.spin.y * dt;
			b.rot.z += b.spin.z * dt;
			const fade = Math.min(1, (b.life - b.age) / 0.3);
			M.compose(b.p, Q.setFromEuler(b.rot), S.set(b.size * fade, b.size * 0.45 * fade, b.size * 0.8 * fade));
			if (n !== i) {
				this.bits[n] = b;
				const c = new THREE.Color();
				this.bitMesh.getColorAt(i, c);
				this.bitMesh.setColorAt(n, c);
			}
			this.bitMesh.setMatrixAt(n++, M);
		}
		this.bits.length = n;
		if (!n && this.prime) this.bitMesh.setMatrixAt(n++, M.compose(this.prime, Q.identity(), S.set(0.004, 0.004, 0.004)));
		this.bitMesh.count = n;
		this.bitMesh.instanceMatrix.needsUpdate = true;
		if (this.bitMesh.instanceColor) this.bitMesh.instanceColor.needsUpdate = true;

		let m = 0;
		const t = this.tint.array as Float32Array;
		for (let i = 0; i < this.puffs.length; i++) {
			const p = this.puffs[i];
			p.age += dt;
			if (p.age > p.life) continue;
			p.v.y -= 9.81 * p.gravity * dt;
			if (p.life !== Infinity) p.v.multiplyScalar(Math.max(0, 1 - (p.glow ? 1.5 : 2.5) * dt));
			else {
				// (Motes wander)
				p.v.x += rnd(0.02) * dt;
				p.v.z += rnd(0.02) * dt;
				p.v.y += (rnd(0.02) - p.v.y * 0.5) * dt;
			}
			p.p.addScaledVector(p.v, dt);
			if (p.p.y < 0.01 && p.life !== Infinity) {
				p.p.y = 0.01;
				p.v.set(0, 0, 0);
			}
			const k = p.life === Infinity ? 0.5 + 0.5 * Math.sin(p.age * 0.7) : 1 - p.age / p.life;
			const size = Math.max(0.001, p.size + p.grow * p.age);
			M.compose(p.p, camera.quaternion, S.set(size, size, size));
			this.puffs[m] = p;
			this.puffMesh.setMatrixAt(m, M);
			const bright = p.glow ? 2.2 : 1;
			t[4 * m] = p.colour.r * bright;
			t[4 * m + 1] = p.colour.g * bright;
			t[4 * m + 2] = p.colour.b * bright;
			t[4 * m + 3] = p.alpha * (p.glow ? k : k * k);
			m++;
		}
		this.puffs.length = m;
		this.puffMesh.count = m;
		this.puffMesh.instanceMatrix.needsUpdate = true;
		this.tint.needsUpdate = true;
	}
}
