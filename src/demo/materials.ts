// The demo's surfaces: scanned materials for the courtyard, and the outsides of the things you cut. The cuttable
// ones read `rest` like their insides do, so a pattern (a melon's stripes, bamboo's joints) stays put on every piece.
import * as THREE from 'three/webgpu';
import { abs, atan, attribute, clamp, float, fract, length, mix, normalWorld, sin, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl';
import { cells3, fbm3, noise3 } from '../lib/noise.ts';
import { withCutPreview } from '../lib/inside.ts';

const rest = attribute('rest', 'vec3');
// (As uniforms, so materials that differ only in colour are one shader to the GPU)
const tone = (c: THREE.Color): THREE.Node<'vec3'> => uniform(new THREE.Vector3(c.r, c.g, c.b));
const loader = new THREE.TextureLoader();
const pending: Promise<unknown>[] = [];
/** Every texture loaded here, for sending to the GPU one at a time during load. */
export const loaded: THREE.Texture[] = [];

function map(path: string, srgb: boolean): THREE.Texture {
	let done!: (v: unknown) => void;
	pending.push(new Promise((res) => (done = res)));
	const t = loader.load(path, done, undefined, () => {
		console.warn(`texture missing: ${path}`);
		done(null);
	});
	loaded.push(t);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.anisotropy = 8;
	if (srgb) t.colorSpace = THREE.SRGBColorSpace;
	return t;
}

/** Resolves when every texture asked for so far has loaded. */
export const texturesReady = () => Promise.all(pending);

/** A scanned material from assets/materials. The mesh's UVs are in metres; one tile covers `width` metres. */
export function scanned(folder: string, file: string, width: number, tint = new THREE.Color(1, 1, 1)): THREE.MeshStandardNodeMaterial {
	const base = `assets/materials/${folder}/${file}`;
	const m = new THREE.MeshStandardNodeMaterial();
	const colour = map(`${base}_baseColor.jpg`, true);
	const normal = map(`${base}_normal.jpg`, false);
	const arm = map(`${base}_arm.jpg`, false);
	const at = uv().div(uniform(width));
	m.colorNode = texture(colour, at).mul(tone(tint));
	const packed = texture(arm, at);
	m.roughnessNode = packed.g;
	m.metalnessNode = float(0);
	m.aoNode = packed.r;
	normal.repeat.set(1 / width, 1 / width);
	m.normalMap = normal;
	return m;
}


/** Granite, weathered: the same stone as its inside, darker, with rain marks down it. */
export function granite(a: THREE.Color, b: THREE.Color, c: THREE.Color, grain = 150): THREE.MeshStandardNodeMaterial {
	const g = uniform(grain);
	const cells = cells3(rest.mul(g));
	const big = cells3(rest.mul(g.mul(0.37)).add(5));
	const stain = fbm3(vec3(rest.x.mul(5), rest.y.mul(0.9), rest.z.mul(5)), 4, 2, 0.5).mul(0.5).add(0.5);
	let colour = mix(tone(a), tone(c), smoothstep(0.3, 0.7, big).mul(0.7));
	colour = mix(colour, tone(b), smoothstep(0.4, 0.2, cells).mul(0.45));
	colour = colour.mul(mix(float(0.7), float(1.0), stain));
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = float(0.9);
	m.metalnessNode = float(0);
	return withCutPreview(m);
}

/** Bamboo's skin: green going gold, a dark line and a pale bloom at each joint. `joint` metres between joints. */
export function bambooSkin(joint: number, hue: number): THREE.MeshStandardNodeMaterial {
	const y = rest.y.div(uniform(joint));
	const f = fract(y);
	const line = smoothstep(0.035, 0.0, abs(f.sub(0.5)).sub(0.47).abs());
	const node = smoothstep(0.06, 0.0, abs(f.sub(0.98)));
	const bloom = smoothstep(0.82, 0.96, f).mul(0.35);
	const streak = noise3(vec3(atan(rest.z, rest.x).mul(14), rest.y.mul(1.5), 0)).mul(0.5).add(0.5);
	const green = mix(vec3(0.2, 0.36, 0.1), vec3(0.42, 0.5, 0.14), streak.mul(0.6).add(uniform(hue)));
	let colour = mix(green, vec3(0.7, 0.72, 0.5), bloom);
	colour = mix(colour, vec3(0.16, 0.14, 0.07), node.mul(0.75));
	void line;
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = mix(float(0.32), float(0.6), node);
	m.metalnessNode = float(0);
	return withCutPreview(m);
}

/** A rolled straw mat: fine woven lines, darker ties around it at `ties` (heights in metres). */
export function strawSkin(ties: number[]): THREE.MeshStandardNodeMaterial {
	const weave = sin(rest.y.mul(900)).mul(0.5).add(0.5);
	const warp = noise3(vec3(atan(rest.z, rest.x).mul(60), rest.y.mul(40), 1)).mul(0.5).add(0.5);
	const fade = fbm3(rest.mul(6), 3, 2, 0.5).mul(0.5).add(0.5);
	let colour = mix(vec3(0.4, 0.38, 0.18), vec3(0.52, 0.47, 0.25), fade);
	colour = colour.mul(weave.mul(0.22).add(0.8)).mul(warp.mul(0.15).add(0.88));
	let tie: THREE.Node<'float'> = float(0);
	for (const h of ties) tie = tie.add(smoothstep(0.012, 0.006, abs(rest.y.sub(h))));
	colour = mix(colour, vec3(0.3, 0.22, 0.1), clamp(tie, 0, 1));
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = float(0.85);
	m.metalnessNode = float(0);
	return withCutPreview(m);
}

/** The mat's inside: its layers, rolled in a spiral about Y. */
export function strawInside(): THREE.MeshStandardNodeMaterial {
	const r = length(vec2(rest.x, rest.z));
	const turn = atan(rest.z, rest.x).div(2 * Math.PI);
	const layer = fract(r.div(0.006).add(turn));
	const gap = smoothstep(0.75, 0.95, layer);
	const fibre = noise3(vec3(rest.x.mul(900), rest.y.mul(60), rest.z.mul(900))).mul(0.5).add(0.5);
	let colour = mix(vec3(0.76, 0.69, 0.43), vec3(0.6, 0.53, 0.28), fibre.mul(0.6));
	colour = mix(colour, vec3(0.3, 0.27, 0.12), gap.mul(0.75));
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = float(0.8);
	m.metalnessNode = float(0);
	return withCutPreview(m);
}

/** A watermelon's rind: jagged dark stripes running end to end (Y is its long axis). */
export function melonSkin(): THREE.MeshPhysicalNodeMaterial {
	const angle = atan(rest.z, rest.x);
	const wobble = fbm3(vec3(angle.mul(3), rest.y.mul(26), 0), 3, 2, 0.5);
	const stripe = smoothstep(0.1, 0.5, sin(angle.mul(9).add(wobble.mul(2.4))).mul(0.5).add(0.5).add(wobble.mul(0.35)));
	const mottled = fbm3(rest.mul(40), 3, 2, 0.5).mul(0.5).add(0.5);
	const colour = mix(vec3(0.05, 0.16, 0.04), vec3(0.3, 0.5, 0.17), stripe).mul(mottled.mul(0.3).add(0.8));
	const m = new THREE.MeshPhysicalNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = float(0.34);
	m.clearcoatNode = float(0.35);
	m.clearcoatRoughnessNode = float(0.3);
	return withCutPreview(m);
}

export function orangeSkin(): THREE.MeshPhysicalNodeMaterial {
	const pores = cells3(rest.mul(650));
	const m = new THREE.MeshPhysicalNodeMaterial();
	m.colorNode = mix(vec3(0.88, 0.3, 0.02), vec3(0.96, 0.4, 0.04), smoothstep(0.1, 0.5, pores));
	m.roughnessNode = mix(float(0.55), float(0.3), smoothstep(0.1, 0.4, pores));
	m.clearcoatNode = float(0.25);
	m.clearcoatRoughnessNode = float(0.4);
	return withCutPreview(m);
}

export function appleSkin(radius: number): THREE.MeshPhysicalNodeMaterial {
	const blush = fbm3(vec3(atan(rest.z, rest.x).mul(1.2), rest.y.mul(30), 2), 3, 2, 0.5).mul(0.5).add(0.5);
	const streak = noise3(vec3(atan(rest.z, rest.x).mul(40), rest.y.mul(30), 0)).mul(0.5).add(0.5);
	const up = rest.y.div(radius).mul(0.5).add(0.5);
	let colour = mix(vec3(0.72, 0.7, 0.2), vec3(0.62, 0.04, 0.06), smoothstep(0.2, 0.75, blush.add(up.mul(0.35))));
	colour = colour.mul(streak.mul(0.25).add(0.82));
	const speck = smoothstep(0.08, 0.03, cells3(rest.mul(500)));
	colour = mix(colour, vec3(0.85, 0.78, 0.5), speck.mul(0.5));
	const m = new THREE.MeshPhysicalNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = float(0.28);
	m.clearcoatNode = float(0.6);
	m.clearcoatRoughnessNode = float(0.15);
	return withCutPreview(m);
}

/** Sawn timber for crates and stands: boards `board` metres wide with dark gaps between them, grain along each board. */
export function boards(light: THREE.Color, dark: THREE.Color, board: number): THREE.MeshStandardNodeMaterial {
	// Boards run across whichever way the face looks least along
	const n = abs(normalWorld);
	const across = mix(rest.y, rest.x, smoothstep(0.5, 0.6, n.y));
	const along = mix(mix(rest.x, rest.z, smoothstep(0.5, 0.6, n.x)), rest.z, smoothstep(0.5, 0.6, n.y));
	const k = across.div(board);
	const gap = smoothstep(0.03, 0.0, abs(fract(k).sub(0.5)).sub(0.48).abs());
	const id = k.floor();
	const grain = fbm3(vec3(along.mul(3), across.mul(60), id.mul(7.3)), 4, 2, 0.5).mul(0.5).add(0.5);
	const shade = noise3(vec3(id.mul(3.1), 0.5, 0.5)).mul(0.12).add(0.94);
	let colour = mix(tone(light), tone(dark), smoothstep(0.35, 0.8, grain)).mul(shade);
	colour = mix(colour, vec3(0.05, 0.035, 0.02), smoothstep(0.02, 0.0, abs(fract(k).sub(0.5).abs().sub(0.5))).mul(0.85));
	void gap;
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = float(0.78);
	m.metalnessNode = float(0);
	return withCutPreview(m);
}

/** Lantern paper lit from inside: ribs every `rib` metres, brighter toward the middle. */
export function lanternPaper(rib: number, glow: THREE.Node<'float'>): THREE.MeshStandardNodeMaterial {
	const ribs = smoothstep(0.1, 0.0, abs(fract(rest.y.div(rib)).sub(0.5)).sub(0.42).abs());
	const fibre = fbm3(rest.mul(90), 3, 2, 0.5).mul(0.5).add(0.5);
	const paper = mix(vec3(0.93, 0.84, 0.68), vec3(0.8, 0.68, 0.5), fibre.mul(0.5));
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = mix(paper, vec3(0.25, 0.16, 0.08), ribs.mul(0.7));
	m.roughnessNode = float(0.9);
	m.metalnessNode = float(0);
	m.emissiveNode = vec3(1.0, 0.55, 0.2).mul(glow).mul(fibre.mul(0.3).add(0.75)).mul(float(1).sub(ribs.mul(0.6)));
	m.side = THREE.DoubleSide;
	return withCutPreview(m);
}

/** Old bronze: dark, with green in the hollows. */
export function patina(): THREE.MeshStandardNodeMaterial {
	const stain = fbm3(rest.mul(18), 4, 2, 0.5).mul(0.5).add(0.5);
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = mix(vec3(0.42, 0.27, 0.13), vec3(0.2, 0.33, 0.26), smoothstep(0.55, 0.8, stain).mul(0.7));
	m.roughnessNode = mix(float(0.38), float(0.75), smoothstep(0.5, 0.8, stain));
	m.metalnessNode = mix(float(1), float(0.3), smoothstep(0.55, 0.8, stain));
	return withCutPreview(m);
}

/** Rope: a twist of pale strands. */
export function ropeSkin(): THREE.MeshStandardNodeMaterial {
	const twist = sin(atan(rest.z, rest.x).mul(3).add(rest.y.mul(700))).mul(0.5).add(0.5);
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = mix(vec3(0.5, 0.4, 0.24), vec3(0.78, 0.68, 0.46), twist);
	m.roughnessNode = float(0.9);
	m.metalnessNode = float(0);
	return withCutPreview(m);
}

/** A glTF material as a node material, so it can carry the cut preview. */
export function fromStandard(source: THREE.MeshStandardMaterial): THREE.MeshStandardNodeMaterial {
	const m = new THREE.MeshStandardNodeMaterial();
	m.map = source.map;
	m.normalMap = source.normalMap;
	m.normalScale.copy(source.normalScale);
	m.roughnessMap = source.roughnessMap;
	m.metalnessMap = source.metalnessMap;
	m.aoMap = source.aoMap;
	m.color.copy(source.color);
	m.roughness = source.roughness;
	m.metalness = source.metalness;
	return withCutPreview(m);
}
