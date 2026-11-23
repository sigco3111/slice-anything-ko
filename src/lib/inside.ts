// Insides: materials for cut faces. Each is a solid texture read at `rest`, the point's place in the uncut object
// (metres, the object's own axes), so the two halves of a cut match and the grain runs through the object the
// way it would: rings around a post's heart, seeds in a ring inside a melon, veins through a block of marble.
// Also the cut preview: a thin line drawn on every object where a plane would cut it.
import * as THREE from 'three/webgpu';
import { abs, atan, attribute, clamp, dot, float, Fn, fract, fwidth, length, max, mix, positionWorld, pow, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { cells3, fbm3, noise3 } from './noise.ts';

type Float = THREE.Node<'float'>;
type Vec3 = THREE.Node<'vec3'>;
const rest = attribute('rest', 'vec3');

/** The plane the preview line is drawn on (xyz normal, w constant, world space), how strongly, and where it fades out. */
export const cutPreview = {
	plane: uniform(new THREE.Vector4(0, 1, 0, 0)),
	strength: uniform(0),
	centre: uniform(new THREE.Vector3()),
	reach: uniform(1.6),
	colour: uniform(new THREE.Color(1.0, 0.82, 0.5)),
};

const previewLine = Fn(() => {
	const d = abs(dot(positionWorld, cutPreview.plane.xyz).add(cutPreview.plane.w));
	const px = d.div(max(fwidth(d), 1e-6));
	const core = float(1).sub(smoothstep(0.6, 1.8, px));
	const halo = float(1).sub(smoothstep(0.0, 0.012, d)).mul(0.25);
	const near = float(1).sub(smoothstep(cutPreview.reach.mul(0.75), cutPreview.reach, length(positionWorld.sub(cutPreview.centre))));
	return cutPreview.colour.mul(core.add(halo)).mul(near).mul(cutPreview.strength).mul(6);
});

/** Adds the cut preview line to a node material (on top of whatever it already emits). */
export function withCutPreview<T extends THREE.MeshStandardNodeMaterial>(material: T): T {
	const base = material.emissiveNode;
	material.emissiveNode = base ? vec3(base as Vec3).add(previewLine()) : previewLine();
	return material;
}

// (Colours and sizes go in as uniforms, never as numbers written into the shader: two posts of different woods
// are then one shader and one pipeline to the GPU, built once)
const tone = (c: THREE.Color): Vec3 => uniform(new THREE.Vector3(c.r, c.g, c.b));

function standard(colour: Vec3, roughness: Float | number, metalness = 0): THREE.MeshStandardNodeMaterial {
	const m = new THREE.MeshStandardNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = typeof roughness === 'number' ? uniform(roughness) : roughness;
	m.metalnessNode = float(metalness);
	return withCutPreview(m);
}

/** Marble: a pale body with veins that come and go through it. `tint` the body, `vein` the veins. */
export function marbleInside(tint = new THREE.Color(0.84, 0.81, 0.75), vein = new THREE.Color(0.33, 0.31, 0.31)): THREE.MeshStandardNodeMaterial {
	const p = rest;
	const warp = fbm3(p.mul(1.7), 3, 2, 0.5);
	const sheet = fbm3(vec3(p.x.mul(3.1).add(warp.mul(1.4)), p.y.mul(2.2), p.z.mul(3.1).sub(warp)), 5, 2.1, 0.55);
	const fade = fbm3(p.mul(4.3).add(7), 3, 2, 0.5);
	// A vein is where a sheet of noise crosses zero: a fine dark line with a soft stain either side, fading in and out
	// (The noise is read from a texture, whose steps are coarser than noise worked out in the shader: the line is
	// drawn wide enough to stay whole)
	const line = smoothstep(0.07, 0.0, abs(sheet)).mul(smoothstep(-0.3, 0.2, fade));
	const stain = smoothstep(0.34, 0.0, abs(sheet)).mul(0.34);
	const second = smoothstep(0.045, 0.0, abs(fbm3(p.mul(6.5).add(3), 4, 2, 0.5))).mul(smoothstep(0.0, 0.4, fade.negate())).mul(0.6);
	const cloud = warp.mul(0.5).add(0.5);
	const body = mix(tone(tint), tone(tint).mul(vec3(0.9, 0.88, 0.86)), cloud.mul(0.7));
	const colour = mix(body, tone(vein), clamp(line.mul(0.9).add(stain).add(second), 0, 1));
	// (Crystals catch the light: a fine sparkle in the roughness)
	const grain = noise3(p.mul(900));
	return standard(colour, float(0.44).add(grain.mul(0.12)));
}

/** Granite or sandstone: speckled grains, `grain` of them to the metre. */
export function stoneInside(a = new THREE.Color(0.62, 0.6, 0.57), b = new THREE.Color(0.3, 0.29, 0.28), c = new THREE.Color(0.78, 0.72, 0.66), grain = 150): THREE.MeshStandardNodeMaterial {
	const g = uniform(grain);
	const cells = cells3(rest.mul(g));
	const big = cells3(rest.mul(g.mul(0.37)).add(5));
	const shade = fbm3(rest.mul(4), 3, 2, 0.5).mul(0.5).add(0.5);
	let colour = mix(tone(a), tone(c), smoothstep(0.3, 0.7, big).mul(0.8));
	colour = mix(colour, tone(b), smoothstep(0.4, 0.2, cells).mul(0.55));
	colour = colour.mul(shade.mul(0.2).add(0.86));
	return standard(colour, float(0.66).add(cells.mul(0.12)));
}

/**
 * Wood: growth rings around the heart, which runs along Y through `heart` (x, z in metres; put it far off for a
 * sawn board). `rings` per metre.
 */
export function woodInside(light = new THREE.Color(0.74, 0.55, 0.33), dark = new THREE.Color(0.42, 0.26, 0.13), rings = 150, heart = new THREE.Vector2(0, 0)): THREE.MeshStandardNodeMaterial {
	const centre = uniform(heart);
	const q = vec2(rest.x, rest.z).sub(centre);
	const wobble = fbm3(vec3(rest.x.mul(3), rest.y.mul(0.6), rest.z.mul(3)), 3, 2, 0.5).mul(0.012);
	const r = length(q).add(wobble);
	const ring = fract(r.mul(uniform(rings)));
	// Early wood pale and wide, late wood a dark line
	const late = smoothstep(0.55, 0.92, ring).mul(float(1).sub(smoothstep(0.94, 1.0, ring)));
	const rays = noise3(vec3(atan(q.y, q.x).mul(40), rest.y.mul(6), r.mul(30))).mul(0.5).add(0.5);
	const fibre = noise3(vec3(rest.x.mul(700), rest.y.mul(12), rest.z.mul(700))).mul(0.5).add(0.5);
	let colour = mix(tone(light), tone(dark), late.mul(0.85));
	colour = colour.mul(rays.mul(0.12).add(0.9)).mul(fibre.mul(0.14).add(0.9));
	// (Darker heartwood toward the middle)
	colour = colour.mul(mix(float(0.82), float(1), smoothstep(0.0, 0.07, r)));
	return standard(colour, float(0.62).add(late.mul(0.1)));
}

/** Bamboo: a pale fibrous wall with dark vessel dots, denser toward the skin. `inner` and `outer` the wall's radii (m). */
export function bambooInside(inner = 0.028, outer = 0.04): THREE.MeshStandardNodeMaterial {
	const r = length(vec2(rest.x, rest.z));
	const t = clamp(r.sub(uniform(inner)).div(uniform(outer - inner)), 0, 1);
	const dots = cells3(vec3(rest.x.mul(1300), rest.y.mul(30), rest.z.mul(1300)));
	const vessel = smoothstep(0.34, 0.16, dots).mul(mix(float(0.35), float(1), t));
	let colour = mix(vec3(0.8, 0.74, 0.54), vec3(0.7, 0.62, 0.37), t);
	colour = mix(colour, vec3(0.42, 0.33, 0.16), vessel.mul(0.8));
	// (The skin itself is a thin green line)
	colour = mix(colour, vec3(0.36, 0.45, 0.16), smoothstep(0.93, 1.0, t));
	return standard(colour, 0.55);
}

/** A watermelon with semi-axes `axes` (m): red flesh, a ring of seeds, pale rind, green skin. */
export function melonInside(axes = new THREE.Vector3(0.13, 0.16, 0.13)): THREE.MeshPhysicalNodeMaterial {
	const q = rest.div(vec3(axes.x, axes.y, axes.z));
	const d = length(q);
	const cells = cells3(rest.mul(42));
	const fibre = fbm3(rest.mul(60), 3, 2, 0.5).mul(0.5).add(0.5);
	let colour = mix(vec3(0.9, 0.13, 0.14), vec3(0.97, 0.27, 0.25), fibre);
	// Paler, grainier heart
	colour = mix(colour, vec3(0.95, 0.42, 0.38), smoothstep(0.35, 0.0, d).mul(0.35));
	// Seeds: in a band, in the three lobes a melon has
	const lobes = sin(atan(q.z, q.x).mul(3)).mul(0.5).add(0.5);
	const band = smoothstep(0.3, 0.44, d).mul(float(1).sub(smoothstep(0.68, 0.78, d))).mul(smoothstep(0.05, 0.4, lobes));
	const seed = smoothstep(0.3, 0.18, cells).mul(band);
	colour = mix(colour, vec3(0.06, 0.035, 0.03), seed);
	colour = mix(colour, vec3(0.97, 0.62, 0.55), smoothstep(0.76, 0.86, d));
	colour = mix(colour, vec3(0.9, 0.93, 0.74), smoothstep(0.84, 0.9, d));
	colour = mix(colour, vec3(0.55, 0.72, 0.35), smoothstep(0.93, 0.965, d));
	colour = mix(colour, vec3(0.1, 0.27, 0.09), smoothstep(0.965, 0.99, d));
	const m = new THREE.MeshPhysicalNodeMaterial();
	m.colorNode = colour;
	// Wet flesh, dry rind
	m.roughnessNode = mix(float(0.4), float(0.6), smoothstep(0.82, 0.9, d)).add(fibre.mul(0.1));
	m.clearcoatNode = float(0.3).mul(float(1).sub(smoothstep(0.82, 0.9, d)));
	m.clearcoatRoughnessNode = float(0.35);
	return withCutPreview(m);
}

/** An orange of radius `radius` (m): segments around the Y axis, pith, peel. */
export function orangeInside(radius = 0.042): THREE.MeshPhysicalNodeMaterial {
	const d = length(rest).div(radius);
	const angle = atan(rest.z, rest.x);
	const rxz = length(vec2(rest.x, rest.z)).div(radius);
	const seg = abs(fract(angle.mul(10 / (2 * Math.PI))).sub(0.5)).mul(2);
	const membrane = max(smoothstep(0.9, 0.98, seg), smoothstep(0.1, 0.05, rxz));
	const sacs = cells3(vec3(rest.x.mul(420), rest.y.mul(160), rest.z.mul(420)));
	let colour = mix(vec3(0.96, 0.36, 0.02), vec3(1.0, 0.52, 0.08), smoothstep(0.1, 0.5, sacs));
	colour = mix(colour, vec3(0.99, 0.78, 0.5), membrane.mul(0.8));
	colour = mix(colour, vec3(0.98, 0.9, 0.72), smoothstep(0.8, 0.86, d));
	colour = mix(colour, vec3(0.96, 0.45, 0.04), smoothstep(0.92, 0.96, d));
	const m = new THREE.MeshPhysicalNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = mix(float(0.25), float(0.55), smoothstep(0.8, 0.88, d));
	m.clearcoatNode = float(0.6).mul(float(1).sub(smoothstep(0.8, 0.88, d)));
	m.clearcoatRoughnessNode = float(0.2);
	return withCutPreview(m);
}

/** An apple of radius `radius` (m): pale flesh, a five-chambered core with seeds. */
export function appleInside(radius = 0.04): THREE.MeshPhysicalNodeMaterial {
	const d = length(rest).div(radius);
	const rxz = length(vec2(rest.x, rest.z)).div(radius);
	const y = rest.y.div(radius);
	const angle = atan(rest.z, rest.x);
	const chamber = pow(abs(sin(angle.mul(2.5))), 0.6);
	const coreShape = rxz.div(mix(float(0.16), float(0.4), chamber)).add(abs(y).div(0.5));
	const core = smoothstep(1.05, 0.9, coreShape);
	const seed = smoothstep(0.8, 0.6, rxz.div(mix(float(0.12), float(0.32), chamber)).add(abs(y.add(0.05)).div(0.26)));
	const speck = noise3(rest.mul(700)).mul(0.5).add(0.5);
	let colour = mix(vec3(0.86, 0.84, 0.7), vec3(0.82, 0.79, 0.6), speck.mul(0.5));
	colour = mix(colour, vec3(0.86, 0.9, 0.62), smoothstep(0.82, 0.97, d).mul(0.6));
	colour = mix(colour, vec3(0.9, 0.84, 0.6), core.mul(0.7));
	colour = mix(colour, vec3(0.22, 0.11, 0.05), seed);
	// (The core's line: a fine green-gold ring around it)
	colour = mix(colour, vec3(0.74, 0.76, 0.4), smoothstep(0.08, 0.0, abs(coreShape.sub(1.25))).mul(0.5));
	const m = new THREE.MeshPhysicalNodeMaterial();
	m.colorNode = colour;
	m.roughnessNode = float(0.38);
	m.clearcoatNode = float(0.35);
	m.clearcoatRoughnessNode = float(0.3);
	return withCutPreview(m);
}

/** Fresh-cut metal: bright, with the fine drag lines a blade leaves. */
export function metalInside(colour = new THREE.Color(0.96, 0.7, 0.42), roughness = 0.24): THREE.MeshStandardNodeMaterial {
	const drag = noise3(vec3(rest.x.mul(40), rest.y.mul(1600), rest.z.mul(40))).mul(0.5).add(0.5);
	const fine = noise3(rest.mul(2400)).mul(0.5).add(0.5);
	return standard(tone(colour).mul(drag.mul(0.12).add(0.9)), uniform(roughness).add(drag.mul(0.14)).add(fine.mul(0.05)), 1);
}

/** Anything plain inside: one colour with a little grain (paper, rope, plaster, wax). */
export function plainInside(colour = new THREE.Color(0.9, 0.86, 0.74), roughness = 0.8): THREE.MeshStandardNodeMaterial {
	const grain = fbm3(rest.mul(300), 2, 2, 0.5).mul(0.5).add(0.5);
	return standard(tone(colour).mul(grain.mul(0.16).add(0.88)), roughness);
}
