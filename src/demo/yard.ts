// The courtyard at golden hour, and everything in it worth cutting.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { appleInside, bambooInside, marbleInside, melonInside, metalInside, orangeInside, plainInside, stoneInside, woodInside } from '../lib/inside.ts';
import type { Piece, SliceableOptions, Slicer } from '../lib/slicer.ts';
import { mark } from './marks.ts';
import { appleSkin, bambooSkin, boards, fromStandard, granite, lanternPaper, melonSkin, orangeSkin, patina, ropeSkin, scanned, strawInside, strawSkin, texturesReady } from './materials.ts';

/** Where the sun is, from the yard (unit vector). Low and behind the player's left shoulder at the start. */
export const SUN = new THREE.Vector3(-0.76, 0.26, 0.6).normalize();
/** The sky image, and where the sun is in it (scripts/sun.mjs), for turning the sky to match. */
const SKY = { file: 'syferfontein6dClearPureSky/syferfontein_6d_clear_puresky_1k.hdr', sun: Math.atan2(0.582, 0.807) };

export interface Yard {
	/** Puts every target back. */
	/** Puts everything back whole: over the next few frames, or at once with `now`. */
	reset(now?: boolean): void;
	/** Lobs a fruit from the launcher to pass in front of `eye`. */
	throwFruit(eye: THREE.Vector3, forward: THREE.Vector3): Piece;
	/** Called for every cut, for what the yard itself does about it (a cut lantern goes dark). */
	cut(parent: Piece): void;
	update(dt: number): void;
	sun: THREE.DirectionalLight;
	/** Named places to stand, for the test scripts: [x, z, yaw, pitch]. */
	spots: Record<string, [number, number, number, number]>;
}

/** A box whose UVs are in metres. `upright`: the texture's grain runs up the box, not along it. */
function box(w: number, h: number, d: number, upright = false): THREE.BufferGeometry {
	const g = new THREE.BoxGeometry(w, h, d);
	const uv = g.getAttribute('uv');
	const sizes = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
	for (let f = 0; f < 6; f++)
		for (let i = 0; i < 4; i++) {
			const u = uv.getX(f * 4 + i) * sizes[f][0];
			const v = uv.getY(f * 4 + i) * sizes[f][1];
			if (upright) uv.setXY(f * 4 + i, v, u);
			else uv.setXY(f * 4 + i, u, v);
		}
	g.clearGroups();
	return g;
}

/** A solid of revolution about Y from a profile of [radius, height] points. */
function lathe(profile: [number, number][], segments = 24): THREE.BufferGeometry {
	return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/** The same surface facing the other way (a cavity inside a solid). */
function inward(g: THREE.BufferGeometry): THREE.BufferGeometry {
	const out = g.index ? g.toNonIndexed() : g.clone();
	for (const name of ['position', 'normal', 'uv']) {
		const a = out.getAttribute(name);
		for (let i = 0; i < a.count; i += 3)
			for (let c = 0; c < a.itemSize; c++) {
				const t = a.getComponent(i + 1, c);
				a.setComponent(i + 1, c, a.getComponent(i + 2, c));
				a.setComponent(i + 2, c, t);
			}
	}
	const n = out.getAttribute('normal');
	for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
	return out;
}

const join = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
	for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
	return g;
}))!;

const rgb = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

export async function buildYard(scene: THREE.Scene, world: RAPIER.World, rapier: typeof RAPIER, slicer: Slicer, params: URLSearchParams): Promise<Yard> {
	// Sky and light
	const which = SKY;
	const sky = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(`assets/hdri/${which.file}`);
	// The sky's own sun is taken down to the brightness of bright cloud: the sun's light comes from the lamp
	// below (which casts shadows), and left in the sky it would be counted twice and glare off every smooth face
	const texels = sky.image.data as Float32Array;
	for (let i = 0; i < texels.length; i++) if (texels[i] > 12) texels[i] = 12;
	sky.needsUpdate = true;
	mark('sky');
	sky.mapping = THREE.EquirectangularReflectionMapping;
	scene.environment = sky;
	scene.background = sky;
	scene.backgroundBlurriness = 0.02;
	const yaw = Number(params.get('envyaw') ?? which.sun - Math.atan2(SUN.z, SUN.x));
	scene.backgroundRotation.set(0, yaw, 0);
	scene.environmentRotation.set(0, yaw, 0);
	scene.environmentIntensity = Number(params.get('env') ?? 0.6);
	scene.backgroundIntensity = Number(params.get('sky') ?? 0.62);
	const sun = new THREE.DirectionalLight(rgb(1.0, 0.56, 0.28), Number(params.get('sun') ?? 3.5));
	sun.position.copy(SUN).multiplyScalar(30);
	sun.castShadow = true;
	sun.shadow.mapSize.set(4096, 4096);
	const cam = sun.shadow.camera;
	cam.left = -13;
	cam.right = 13;
	cam.top = 13;
	cam.bottom = -13;
	cam.near = 5;
	cam.far = 60;
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.03;
	sun.shadow.radius = 2.5;
	scene.add(sun, sun.target);
	scene.fog = new THREE.FogExp2(rgb(0.9, 0.56, 0.4).getHex(), 0.007);

	// The courtyard: paving, a gravel strip on the sun's side, plastered walls with tiled copings, a timber frame
	const paving = scanned('patternedPaving02', 'patterned_paving_02', 1.8, rgb(1.15, 1.06, 0.98));
	const gravel = scanned('gravelFloor', 'gravel_floor', 2.25, rgb(1.15, 1.08, 1.0));
	const plaster = scanned('plasteredWall02', 'plastered_wall_02', 2.23, rgb(1.0, 0.92, 0.8));
	const timber = scanned('darkPlanks', 'dark_planks', 2, rgb(1.2, 1.05, 0.9));
	const tiles = scanned('greyRoofTiles', 'grey_roof_tiles', 3, rgb(0.85, 0.85, 0.9));
	const still = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, ry = 0, collide = true): THREE.Mesh => {
		const mesh = new THREE.Mesh(g, m);
		mesh.position.set(x, y, z);
		mesh.rotation.y = ry;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		scene.add(mesh);
		if (collide) {
			g.computeBoundingBox();
			const s = g.boundingBox!.getSize(new THREE.Vector3());
			const c = g.boundingBox!.getCenter(new THREE.Vector3()).applyEuler(mesh.rotation).add(mesh.position);
			const body = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(c.x, c.y, c.z).setRotation(mesh.quaternion));
			world.createCollider(rapier.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2).setFriction(0.9), body);
		}
		return mesh;
	};
	still(box(11.5, 0.4, 16), paving, 2.25, -0.2, 0);
	still(box(4.5, 0.4, 16), gravel, -5.75, -0.22, 0);
	const kerb = box(0.18, 0.12, 16);
	// (A copy, not the position attribute itself: materials of one kind now share one pipeline, and a pipeline
	// laid out for a mesh whose `rest` and position are one buffer draws every other mesh of that kind wrong)
	kerb.setAttribute('rest', kerb.getAttribute('position').clone());
	still(kerb, granite(rgb(0.42, 0.41, 0.4), rgb(0.28, 0.28, 0.28), rgb(0.52, 0.5, 0.47), 150), -3.5, 0.0, 0, 0, false);
	const wall = (x: number, z: number, length: number, height: number, ry: number) => {
		still(box(length, height, 0.3), plaster, x, height / 2, z, ry);
		// The coping: two tiled slopes
		const g = new THREE.BufferGeometry();
		const l = length / 2 + 0.05, w = 0.34, r = 0.16;
		g.setAttribute('position', new THREE.Float32BufferAttribute([-l, 0, w, l, 0, w, l, r, 0, -l, r, 0, l, 0, -w, -l, 0, -w, -l, r, 0, l, r, 0, -l, 0, w, -l, r, 0, -l, 0, -w, l, 0, -w, l, r, 0, l, 0, w], 3));
		g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2 * l, 0, 2 * l, 0.4, 0, 0.4, 0, 0, 2 * l, 0, 2 * l, 0.4, 0, 0.4, 0, 0, 0.3, 0.2, 0.6, 0, 0, 0, 0.3, 0.2, 0.6, 0], 2));
		g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 11, 12, 13]);
		g.computeVertexNormals();
		still(g, tiles, x, height, z, ry, false);
		still(box(length + 0.1, 0.06, 0.5), timber, x, height - 0.03, z, ry, false);
	};
	wall(2.25, -8, 11.8, 2.9, 0);
	wall(8, 0, 16.3, 2.9, Math.PI / 2);
	wall(0, 8, 16.3, 2.3, 0);
	wall(-8, 0, 16.3, 0.95, Math.PI / 2);
	wall(-3.7, -8, 0.6, 0.95, 0);
	// The frame the lanterns and the bell hang from
	const BEAM = 3.02;
	still(box(0.22, BEAM + 0.2, 0.22, true), timber, -3.1, (BEAM + 0.2) / 2, -2.2);
	still(box(0.22, BEAM + 0.2, 0.22, true), timber, 3.1, (BEAM + 0.2) / 2, -2.2);
	still(box(7.6, 0.24, 0.26), timber, 0, BEAM + 0.12, -2.2, 0, false);
	still(box(6.6, 0.14, 0.16), timber, 0, BEAM - 0.42, -2.2, 0, false);
	// A low table for the fruit, and the launcher: a box with a bamboo mouth
	const TABLE = 0.93;
	still(box(1.7, 0.07, 0.62), timber, 2.5, TABLE - 0.035, 3.4, 0.25);
	still(box(0.1, TABLE - 0.07, 0.5, true), timber, 1.85, (TABLE - 0.07) / 2, 3.24, 0.25, false);
	still(box(0.1, TABLE - 0.07, 0.5, true), timber, 3.15, (TABLE - 0.07) / 2, 3.57, 0.25, false);
	still(box(1.25, 0.08, 0.1), timber, 2.5, 0.3, 3.4, 0.25, false);
	const LAUNCH = new THREE.Vector3(-4.6, 0.75, -3.6);
	still(box(0.7, 0.55, 0.7), timber, LAUNCH.x, 0.275, LAUNCH.z, 0.6);
	const mouth = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.55, 24, 1, true), new THREE.MeshStandardNodeMaterial({ color: rgb(0.16, 0.11, 0.07), roughness: 0.7, side: THREE.DoubleSide }));
	mouth.position.copy(LAUNCH).add(new THREE.Vector3(0.06, 0.05, 0.05));
	mouth.rotation.set(0.55, 0.9, 0);
	mouth.castShadow = true;
	scene.add(mouth);

	// The statue
	const gltf = await new GLTFLoader().loadAsync('assets/models/marbleBust01.glb');
	gltf.scene.updateMatrixWorld(true);
	let bust!: THREE.BufferGeometry;
	let bustSkin!: THREE.Material;
	gltf.scene.traverse((o) => {
		const m = o as THREE.Mesh;
		if (!m.isMesh || bust) return;
		bust = m.geometry.clone().applyMatrix4(m.matrixWorld).applyMatrix4(new THREE.Matrix4().makeScale(2, 2, 2));
		for (const name of Object.keys(bust.attributes)) if (!['position', 'normal', 'uv'].includes(name)) bust.deleteAttribute(name);
		bustSkin = fromStandard(m.material as THREE.MeshStandardMaterial);
	});
	mark('statue file');
	await texturesReady();
	mark('textures');

	// Materials for the things you cut (made once: every piece of every reset shares them)
	const marble = marbleInside();
	const plinthSkin = granite(rgb(0.3, 0.3, 0.305), rgb(0.19, 0.19, 0.2), rgb(0.38, 0.375, 0.37), 150);
	const plinthIn = stoneInside(rgb(0.56, 0.55, 0.54), rgb(0.26, 0.26, 0.27), rgb(0.72, 0.69, 0.65), 150);
	const pillarSkin = granite(rgb(0.42, 0.34, 0.26), rgb(0.3, 0.25, 0.2), rgb(0.5, 0.41, 0.32), 170);
	const pillarIn = stoneInside(rgb(0.74, 0.62, 0.48), rgb(0.55, 0.45, 0.36), rgb(0.84, 0.74, 0.6), 170);
	const postSkin = woodInside(rgb(0.17, 0.105, 0.065), rgb(0.085, 0.054, 0.034), 150, new THREE.Vector2(0.02, -0.03));
	const postIn = woodInside(rgb(0.8, 0.6, 0.36), rgb(0.5, 0.31, 0.15), 150, new THREE.Vector2(0.02, -0.03));
	const crateSkin = boards(rgb(0.46, 0.33, 0.19), rgb(0.28, 0.19, 0.11), 0.1);
	const crateIn = woodInside(rgb(0.86, 0.72, 0.48), rgb(0.66, 0.5, 0.28), 260, new THREE.Vector2(1.4, 0.9));
	const straw = strawSkin([-0.3, 0, 0.3]);
	const strawIn = strawInside();
	const standSkin = woodInside(rgb(0.19, 0.125, 0.076), rgb(0.1, 0.065, 0.04), 180, new THREE.Vector2(0.6, 0.2));
	const standIn = woodInside(rgb(0.82, 0.64, 0.4), rgb(0.55, 0.36, 0.18), 180, new THREE.Vector2(0.6, 0.2));
	const melon = { skin: melonSkin(), inside: melonInside(new THREE.Vector3(0.125, 0.16, 0.125)) };
	const orange = { skin: orangeSkin(), inside: orangeInside(0.043) };
	const apple = { skin: appleSkin(0.04), inside: appleInside(0.04) };
	const rope = ropeSkin();
	const ropeIn = plainInside(rgb(0.86, 0.78, 0.58));
	const bronze = patina();
	const bronzeIn = metalInside();
	const paperIn = plainInside(rgb(0.95, 0.9, 0.78), 0.9);
	const lanterns = [0, 1, 2].map(() => {
		const glow = uniform(1);
		return { glow, level: 1, skin: lanternPaper(0.03, glow), options: null as SliceableOptions | null };
	});

	const place = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, options: SliceableOptions, rotation?: THREE.Euler, name = ''): Piece => {
		const mesh = new THREE.Mesh(g, m);
		mesh.position.set(x, y, z);
		if (rotation) mesh.rotation.copy(rotation);
		mesh.name = name || options.kind || '';
		return slicer.add(mesh, options);
	};

	// Shapes
	const sphere = new THREE.SphereGeometry(1, 30, 20);
	const melonShape = sphere.clone().scale(0.125, 0.16, 0.125);
	const orangeShape = sphere.clone().scale(0.043, 0.04, 0.043);
	const appleShape = sphere.clone();
	{
		const p = appleShape.getAttribute('position');
		for (let i = 0; i < p.count; i++) {
			const y = p.getY(i);
			const dent = 1 - 0.16 * Math.pow(Math.abs(y), 6) + 0.06 * (1 - y * y) * (y > 0 ? 1 : 0.4);
			p.setXYZ(i, p.getX(i) * dent, y * 0.9 * (1 - 0.1 * Math.pow(Math.abs(y), 8)), p.getZ(i) * dent);
		}
		appleShape.scale(0.04, 0.04, 0.04).computeVertexNormals();
	}
	const pillarShape = lathe([[0, 0], [0.22, 0], [0.22, 0.1], [0.17, 0.15], [0.16, 0.22], [0.15, 1.95], [0.165, 2.0], [0.2, 2.04], [0.2, 2.14], [0, 2.14]], 32);
	// (Stepped blocks are one closed shell each, turned as a four-sided lathe: boxes merely stood on each other are
	// separate solids, and a cut would let them fall apart at the joins)
	const stepped = (profile: [number, number][]) => {
		const g = lathe(profile.map(([side, y]) => [side * Math.SQRT1_2, y] as [number, number]), 4).rotateY(Math.PI / 4).toNonIndexed();
		g.computeVertexNormals();
		return g;
	};
	const plinthShape = stepped([[0, 0], [0.6, 0], [0.6, 0.12], [0.5, 0.12], [0.5, 0.86], [0.58, 0.86], [0.58, 0.96], [0, 0.96]]);
	const rollShape = new THREE.CylinderGeometry(0.058, 0.058, 0.95, 28, 1);
	const standShape = stepped([[0, 0], [0.5, 0], [0.5, 0.08], [0.09, 0.08], [0.09, 0.44], [0, 0.44]]);
	const crateShape = join([box(0.5, 0.5, 0.5), inward(box(0.455, 0.455, 0.455))]);
	const bellShape = lathe([[0, 0.3], [0.05, 0.295], [0.082, 0.25], [0.093, 0.13], [0.108, 0.045], [0.135, 0], [0.118, 0], [0.097, 0.045], [0.082, 0.13], [0.072, 0.24], [0.045, 0.278], [0, 0.283]], 36);
	const lanternShape = (() => {
		const outer: [number, number][] = [[0, -0.15]];
		const cavity: [number, number][] = [[0, -0.146]];
		for (let i = 0; i <= 10; i++) {
			const y = -0.15 + 0.03 * i;
			const r = 0.13 * Math.sqrt(Math.max(0, 1 - (y / 0.19) ** 2));
			outer.push([r, y]);
			if (i > 0 && i < 10) cavity.push([r - 0.004, y]);
		}
		outer.push([0, 0.15]);
		cavity.push([0, 0.146]);
		return join([lathe(outer, 24), inward(lathe(cavity, 24))]);
	})();
	const bamboo = (height: number, radius: number, joint: number) => {
		const outer: [number, number][] = [[0, 0], [radius, 0]];
		const parts: THREE.BufferGeometry[] = [];
		for (let y = joint * 0.6; y < height - 0.05; y += joint) {
			const r = radius * (1 - 0.25 * (y / height));
			outer.push([r, y - 0.012], [r + 0.0035, y], [r, y + 0.012]);
		}
		outer.push([radius * 0.75, height], [0, height]);
		parts.push(lathe(outer, 14));
		for (let y0 = joint * 0.6 - joint; y0 < height - 0.05; y0 += joint) {
			const a = Math.max(0.02, y0 + 0.012);
			const b = Math.min(height - 0.02, y0 + joint - 0.012);
			if (b - a < 0.05) continue;
			const r = radius * (1 - 0.25 * ((a + b) / 2 / height)) * 0.7;
			parts.push(inward(lathe([[0, a], [r, a], [r, b], [0, b]], 12)));
		}
		return join(parts);
	};
	const stalks = [
		{ x: -5.2, z: 1.9, h: 3.4, r: 0.04, lean: [0.03, -0.02] },
		{ x: -4.75, z: 1.25, h: 3.0, r: 0.034, lean: [-0.04, 0.03] },
		{ x: -5.5, z: 0.9, h: 3.7, r: 0.045, lean: [0.02, 0.04] },
		{ x: -4.5, z: 2.35, h: 2.7, r: 0.03, lean: [-0.03, -0.04] },
		{ x: -5.9, z: 1.7, h: 3.2, r: 0.036, lean: [0.05, 0.01] },
		{ x: -4.95, z: 0.45, h: 2.9, r: 0.032, lean: [-0.02, -0.05] },
		{ x: -4.3, z: 1.75, h: 3.1, r: 0.038, lean: [0.035, 0.03] },
	].map((s) => ({ ...s, r: 0.037, shape: bamboo(s.h, 0.037, 0.34) }));
	// (One skin and one inside for every stalk: seven of each was fourteen shaders to build for one look)
	const bambooOut = bambooSkin(0.34, 0.12);
	const bambooIn = bambooInside(0.037 * 0.7, 0.037);

	const hang = (top: THREE.Vector3, length: number, thick: number, load: Piece, loadTop: THREE.Vector3) => {
		const n = Math.max(1, Math.round(length / 0.2));
		const seg = length / n;
		const shape = new THREE.CylinderGeometry(thick, thick, seg, 8, 1);
		let above: Piece | null = null;
		for (let i = 0; i < n; i++) {
			const piece = place(shape, rope, top.x, top.y - seg * (i + 0.5), top.z, { inside: ropeIn, density: 1100, kind: 'rope', minVolume: 2e-7, friction: 0.8, angularDamping: 2.5, linearDamping: 0.4, inertia: 3e-4 });
			slicer.link(piece, above, new THREE.Vector3(top.x, top.y - seg * i, top.z));
			above = piece;
		}
		slicer.link(load, above, loadTop);
	};

	// (Setting the yard out is a few milliseconds a thing, and all at once it is a frame people see. So a reset is
	// set out over a second, thing by thing, the bust last: you watch the yard being put back.)
	const todo: (() => void)[] = [];
	let resetAt = 0;
	let resetCount = 0;
	const reset = (now = false) => {
		slicer.clear();
		todo.length = 0;
		const step = (work: () => void) => todo.push(work);
		// The bust on its plinth
		step(() => place(plinthShape, plinthSkin, 0, 0, 0.6, { inside: plinthIn, density: 2650, kind: 'stone', friction: 0.55, awake: false }));
		step(() => place(bust, bustSkin, 0, 0.961, 0.6, { inside: marble, density: 2700, kind: 'stone', friction: 0.5, awake: false }, undefined, 'bust'));
		// Pillars and a timber post
		step(() => place(pillarShape, pillarSkin, 2.7, 0, 0.3, { inside: pillarIn, density: 2300, kind: 'stone', friction: 0.55, awake: false }));
		step(() => place(pillarShape, pillarSkin, 3.9, 0, 1.5, { inside: pillarIn, density: 2300, kind: 'stone', friction: 0.55, awake: false }));
		step(() => place(box(0.15, 2.0, 0.15), postSkin, 1.6, 1.0, 2.0, { inside: postIn, density: 650, kind: 'wood', pins: [new THREE.Vector3(0, -0.98, 0)] }, new THREE.Euler(0, 0.4, 0)));
		// Rolled mats on their stands
		for (const [x, z] of [[-1.7, 2.3], [-2.6, 1.2], [-1.5, 0.7]]) step(() => {
			place(standShape, standSkin, x, 0, z, { inside: standIn, density: 700, kind: 'wood', pins: [new THREE.Vector3(0, 0.02, 0)] }, new THREE.Euler(0, x, 0));
			place(rollShape, straw, x, 0.44 + 0.475, z, { inside: strawIn, density: 420, kind: 'straw', pins: [new THREE.Vector3(0, -0.45, 0)] });
		});
		// Bamboo
		for (const s of stalks) step(() => place(s.shape, bambooOut, s.x, -0.02, s.z, { inside: bambooIn, density: 700, kind: 'bamboo', pins: [new THREE.Vector3(0, 0.01, 0)], minVolume: 4e-6 }, new THREE.Euler(s.lean[0], 0, s.lean[1])));
		// Fruit on the table, crates beside it
		const top = TABLE;
		const onTable = (dx: number, dz: number) => new THREE.Vector3(2.5 + dx * Math.cos(0.25) + dz * Math.sin(0.25), top, 3.4 - dx * Math.sin(0.25) + dz * Math.cos(0.25));
		const fruit = (kind: 'melon' | 'orange' | 'apple', at: THREE.Vector3, rot = new THREE.Euler()) => {
			const f = kind === 'melon' ? { ...melon, shape: melonShape, lift: 0.125 } : kind === 'orange' ? { ...orange, shape: orangeShape, lift: 0.04 } : { ...apple, shape: appleShape, lift: 0.036 };
			return place(f.shape, f.skin, at.x, at.y + f.lift, at.z, { inside: f.inside, density: 950, kind: 'fruit', friction: 0.6, restitution: 0.15, minVolume: 3e-6, part: 0.45, tumble: 2.6 }, rot, kind);
		};
		step(() => {
		fruit('melon', onTable(-0.35, 0.02), new THREE.Euler(0, 0.4, Math.PI / 2));
		fruit('orange', onTable(0.12, -0.12));
		fruit('orange', onTable(0.24, 0.05), new THREE.Euler(0.4, 0, 0.3));
		fruit('orange', onTable(0.36, -0.1), new THREE.Euler(1.2, 0, 0.2));
		fruit('apple', onTable(0.55, 0.08));
		fruit('apple', onTable(0.66, -0.06), new THREE.Euler(0.2, 1, 0.1));
		fruit('apple', onTable(0.05, 0.14), new THREE.Euler(0, 2, -0.1));
		});
		for (const [x, y, z, ry] of [[4.5, 0.25, 3.3, 0.2], [5.1, 0.25, 3.0, -0.3], [4.8, 0.75, 3.15, 0.5]]) step(() => place(crateShape, crateSkin, x, y, z, { inside: crateIn, density: 560, kind: 'wood', awake: false }, new THREE.Euler(0, ry, 0)));
		// Lanterns and the bell, on ropes from the beam
		lanterns.forEach((l, i) => step(() => {
			const x = [-1.9, 1.9, -0.75][i];
			const drop = [1.05, 1.2, 0.8][i];
			l.level = 1;
			const options: SliceableOptions = { inside: paperIn, density: 420, kind: 'lantern', friction: 0.6, minVolume: 2e-6 };
			l.options = options;
			const y = BEAM - 0.5 - drop - 0.15;
			const piece = place(lanternShape, l.skin, x, y, -2.2, options);
			hang(new THREE.Vector3(x, BEAM - 0.5, -2.2), drop, 0.007, piece, new THREE.Vector3(x, y + 0.15, -2.2));
		}));
		step(() => {
		const bell = place(bellShape, bronze, 0.85, BEAM - 0.5 - 0.6 - 0.3, -2.2, { inside: bronzeIn, density: 8700, kind: 'metal', friction: 0.4, restitution: 0.25 });
		hang(new THREE.Vector3(0.85, BEAM - 0.5, -2.2), 0.6, 0.014, bell, new THREE.Vector3(0.85, BEAM - 0.5 - 0.6, -2.2));
		});
		// (The bust and its plinth go last)
		todo.push(...todo.splice(0, 2));
		resetAt = performance.now();
		resetCount = todo.length;
		if (now) while (todo.length) todo.shift()!();
	};
	const setOut = (ms: number) => {
		const t0 = performance.now();
		const due = Math.ceil(resetCount * THREE.MathUtils.clamp((t0 - resetAt - 120) / 900, 0, 1));
		while (todo.length && resetCount - todo.length < due && performance.now() - t0 < ms) todo.shift()!();
	};
	mark('materials');
	reset(true);
	mark('targets');

	let thrown = 0;
	return {
		reset,
		sun,
		spots: {
			start: [0, 5, 0, -0.05],
			bust: [0.1, 1.75, 0, -0.02],
			mats: [-1.62, 3.25, 0.08, -0.5],
			bamboo: [-3.7, 1.5, 1.2, -0.25],
			pillars: [2.3, 1.2, -0.42, -0.2],
			table: [2.2, 4.25, -0.22, -0.62],
			lanterns: [-1.85, -1.3, 0, -0.05],
			bell: [0.8, -1.3, 0, 0.0],
			crates: [4.75, 4.05, 0.05, -0.75],
			post: [1.35, 2.85, -0.28, -0.3],
		},
		throwFruit(eye, forward) {
			const kinds = ['melon', 'orange', 'apple', 'orange', 'apple'] as const;
			const kind = kinds[thrown++ % kinds.length];
			const f = kind === 'melon' ? { ...melon, shape: melonShape } : kind === 'orange' ? { ...orange, shape: orangeShape } : { ...apple, shape: appleShape };
			const from = LAUNCH.clone().add(new THREE.Vector3(0.12, 0.3, 0.1));
			const piece = place(f.shape, f.skin, from.x, from.y, from.z, { inside: f.inside, density: 950, kind: 'fruit', friction: 0.6, restitution: 0.15, minVolume: 3e-6, part: 0.45, tumble: 2.6 }, new THREE.Euler(thrown, thrown * 2, 0), kind);
			// To pass an arm's length in front of the eyes, a little below them, after `time` seconds
			const to = eye.clone().addScaledVector(new THREE.Vector3(forward.x, 0, forward.z).normalize(), 0.95).add(new THREE.Vector3(0, -0.12, 0));
			const time = 1.05;
			const v = to.sub(from).divideScalar(time);
			v.y += 0.5 * 9.81 * time;
			piece.body.setLinvel(v, true);
			piece.body.setAngvel({ x: 2 + thrown, y: 1.5, z: -2 }, true);
			return piece;
		},
		cut(parent) {
			const l = lanterns.find((x) => x.options === parent.options);
			if (l) l.level = 0.12;
		},
		update(dt) {
			setOut(3);
			for (const l of lanterns) l.glow.value += (l.level * (0.92 + 0.08 * Math.sin(performance.now() / 90 + l.level * 7)) - l.glow.value) * Math.min(1, dt * 6);
		},
	};
}
