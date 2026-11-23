// Noise for the solid textures, read from one small 3D texture that tiles, not worked out in the shader.
// A shader that computes fractal and cell noise itself is hundreds of lines once its loops are unrolled, and the
// GPU takes seconds to build a couple of dozen of them; a few texture reads build at once and draw faster.
import * as THREE from 'three/webgpu';
import { float, texture3D } from 'three/tsl';

type Vec3 = THREE.Node<'vec3'>;
type Float = THREE.Node<'float'>;

const SIZE = 64;
/** Lattice cells of smooth noise, and of cell noise, across the texture. */
const CELLS = 32;
const SPOTS = 8;

function build(): THREE.Data3DTexture {
	let seed = 1234567;
	const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
	// Two lattices of random values (two independent noises), and a jittered point in every cell
	const a = new Float32Array(CELLS ** 3);
	const b = new Float32Array(CELLS ** 3);
	for (let i = 0; i < a.length; i++) {
		a[i] = rnd();
		b[i] = rnd();
	}
	const spots = new Float32Array(SPOTS ** 3 * 3);
	for (let i = 0; i < spots.length; i++) spots[i] = rnd();
	const at = (g: Float32Array, x: number, y: number, z: number) => g[(x % CELLS) + CELLS * ((y % CELLS) + CELLS * (z % CELLS))];
	const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
	const smooth = (g: Float32Array, x: number, y: number, z: number) => {
		const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
		const u = fade(x - x0), v = fade(y - y0), w = fade(z - z0);
		const l = (p: number, q: number, t: number) => p + (q - p) * t;
		return l(l(l(at(g, x0, y0, z0), at(g, x0 + 1, y0, z0), u), l(at(g, x0, y0 + 1, z0), at(g, x0 + 1, y0 + 1, z0), u), v), l(l(at(g, x0, y0, z0 + 1), at(g, x0 + 1, y0, z0 + 1), u), l(at(g, x0, y0 + 1, z0 + 1), at(g, x0 + 1, y0 + 1, z0 + 1), u), v), w);
	};
	const data = new Uint8Array(SIZE ** 3 * 4);
	const wrap = (i: number) => ((i % SPOTS) + SPOTS) % SPOTS;
	for (let z = 0, o = 0; z < SIZE; z++)
		for (let y = 0; y < SIZE; y++)
			for (let x = 0; x < SIZE; x++, o += 4) {
				const k = CELLS / SIZE;
				data[o] = Math.round(smooth(a, x * k, y * k, z * k) * 255);
				data[o + 2] = Math.round(smooth(b, x * k, y * k, z * k) * 255);
				// Distance to the nearest jittered point, in cells
				const px = ((x + 0.5) * SPOTS) / SIZE, py = ((y + 0.5) * SPOTS) / SIZE, pz = ((z + 0.5) * SPOTS) / SIZE;
				const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
				let best = 9;
				for (let dz = -1; dz <= 1; dz++)
					for (let dy = -1; dy <= 1; dy++)
						for (let dx = -1; dx <= 1; dx++) {
							const i = 3 * (wrap(cx + dx) + SPOTS * (wrap(cy + dy) + SPOTS * wrap(cz + dz)));
							const ex = cx + dx + spots[i] - px, ey = cy + dy + spots[i + 1] - py, ez = cz + dz + spots[i + 2] - pz;
							const d = ex * ex + ey * ey + ez * ez;
							if (d < best) best = d;
						}
				data[o + 1] = Math.round(Math.min(1, Math.sqrt(best)) * 255);
				data[o + 3] = 255;
			}
	const t = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
	t.format = THREE.RGBAFormat;
	t.type = THREE.UnsignedByteType;
	t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
	t.minFilter = t.magFilter = THREE.LinearFilter;
	t.unpackAlignment = 1;
	t.needsUpdate = true;
	return t;
}

/** The noise texture: R and B smooth noises, G the distance to the nearest of a scatter of points. */
export const noiseTexture = build();

/** Smooth noise at p (one unit a cell), -1 to 1. */
export const noise3 = (p: Vec3): Float => texture3D(noiseTexture, p.div(CELLS)).r.mul(2).sub(1);

/** Octaves of smooth noise summed, each `lacunarity` times finer and `gain` times fainter. About -1 to 1. */
export function fbm3(p: Vec3, octaves = 3, lacunarity = 2, gain = 0.5): Float {
	let sum: Float = float(0);
	let f = 1;
	let amp = 1;
	for (let o = 0; o < octaves; o++) {
		// (Octaves alternate between the two noises and are shifted, so they never line up)
		const s = texture3D(noiseTexture, p.mul(f / CELLS).add(o * 0.37));
		sum = sum.add((o % 2 ? s.b : s.r).mul(2).sub(1).mul(amp));
		f *= lacunarity;
		amp *= gain;
	}
	return sum;
}

/** Cell noise at p (one unit a cell): 0 at a point of the scatter, rising to about 1 between points. */
export const cells3 = (p: Vec3): Float => texture3D(noiseTexture, p.div(SPOTS)).g;
