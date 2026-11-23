// A solid: a closed triangle mesh kept in a form that is cheap to cut. Vertices are interleaved floats (position
// first), every vertex knows its weld (vertices at one place share a weld even when their normals or UVs differ),
// and every triangle knows its material slot. The cap slot is the inside of the object.
import * as THREE from 'three';

export interface Field {
	name: string;
	size: number;
	offset: number;
}

export interface Solid {
	stride: number;
	layout: Field[];
	/** Offsets of the fields the cutter treats specially (-1 when the solid has none). */
	oNormal: number;
	oUv: number;
	oTangent: number;
	oRest: number;
	/** count × stride floats. */
	v: Float32Array;
	count: number;
	/** Weld per vertex; vertices of one weld have exactly equal positions. */
	weld: Uint32Array;
	welds: number;
	/** Three vertex indices per triangle. */
	tris: Uint32Array;
	/** Material slot per triangle. */
	slot: Uint8Array;
	ntris: number;
	/** The slot cut faces get. */
	capSlot: number;
}

export interface Measure {
	volume: number;
	centroid: [number, number, number];
	min: [number, number, number];
	max: [number, number, number];
}

const FIELDS = ['position', 'normal', 'uv', 'tangent', 'color', 'rest'];

/**
 * A solid from any geometry. `rest` (where each point was in the uncut object, which the inside materials read)
 * is the position unless the geometry brings its own. Holes in the surface are closed, so every cut can be capped.
 */
export function solidFromGeometry(source: THREE.BufferGeometry, capSlot = 1): Solid {
	const geo = source;
	if (!geo.getAttribute('normal')) geo.computeVertexNormals();
	const pos = geo.getAttribute('position');
	const count = pos.count;
	const layout: Field[] = [];
	let stride = 0;
	for (const name of FIELDS) {
		const a = geo.getAttribute(name);
		const size = a ? a.itemSize : name === 'uv' ? 2 : name === 'rest' ? 3 : 0;
		if (!size) continue;
		layout.push({ name, size, offset: stride });
		stride += size;
	}
	const v = new Float32Array(count * stride);
	for (const f of layout) {
		const a = geo.getAttribute(f.name) ?? (f.name === 'rest' ? pos : null);
		if (!a) continue;
		for (let i = 0; i < count; i++) for (let c = 0; c < f.size; c++) v[i * stride + f.offset + c] = a.getComponent(i, c);
	}
	// Welds: vertices within a millionth of the object's size are one place, and are moved to exactly one position
	geo.computeBoundingBox();
	const size = geo.boundingBox!.getSize(new THREE.Vector3()).length() || 1;
	const q = size * 1e-6;
	const weld = new Uint32Array(count);
	const seen = new Map<string, number>();
	const first: number[] = [];
	for (let i = 0; i < count; i++) {
		const o = i * stride;
		const key = `${Math.round(v[o] / q)},${Math.round(v[o + 1] / q)},${Math.round(v[o + 2] / q)}`;
		let w = seen.get(key);
		if (w === undefined) {
			w = first.length;
			seen.set(key, w);
			first.push(i);
		} else {
			const r = first[w] * stride;
			v[o] = v[r];
			v[o + 1] = v[r + 1];
			v[o + 2] = v[r + 2];
		}
		weld[i] = w;
	}
	const index = geo.getIndex();
	const total = index ? index.count / 3 : count / 3;
	const groups = geo.groups.length ? geo.groups : [{ start: 0, count: total * 3, materialIndex: 0 }];
	const tris: number[] = [];
	const slot: number[] = [];
	for (const g of groups) {
		const end = Math.min(total * 3, g.start + g.count);
		for (let k = g.start; k + 2 < end; k += 3) {
			const a = index ? index.getX(k) : k;
			const b = index ? index.getX(k + 1) : k + 1;
			const c = index ? index.getX(k + 2) : k + 2;
			// (A triangle with two corners at one place has no area and no edge worth pairing)
			if (weld[a] === weld[b] || weld[b] === weld[c] || weld[c] === weld[a]) continue;
			tris.push(a, b, c);
			slot.push(g.materialIndex ?? 0);
		}
	}
	const field = (name: string) => layout.find((f) => f.name === name)?.offset ?? -1;
	const solid: Solid = {
		stride,
		layout,
		oNormal: field('normal'),
		oUv: field('uv'),
		oTangent: field('tangent'),
		oRest: field('rest'),
		v,
		count,
		weld,
		welds: first.length,
		tris: Uint32Array.from(tris),
		slot: Uint8Array.from(slot),
		ntris: slot.length,
		capSlot,
	};
	return closeHoles(solid);
}

/** A geometry to draw the solid with: one group per material slot. */
export function geometryFromSolid(s: Solid): THREE.BufferGeometry {
	const geo = new THREE.BufferGeometry();
	for (const f of s.layout) {
		const a = new Float32Array(s.count * f.size);
		for (let i = 0; i < s.count; i++) for (let c = 0; c < f.size; c++) a[i * f.size + c] = s.v[i * s.stride + f.offset + c];
		geo.setAttribute(f.name, new THREE.BufferAttribute(a, f.size));
	}
	let slots = 0;
	for (let t = 0; t < s.ntris; t++) slots = Math.max(slots, s.slot[t] + 1);
	const index = new Uint32Array(s.ntris * 3);
	let n = 0;
	for (let m = 0; m < slots; m++) {
		const start = n;
		for (let t = 0; t < s.ntris; t++) {
			if (s.slot[t] !== m) continue;
			index[n++] = s.tris[3 * t];
			index[n++] = s.tris[3 * t + 1];
			index[n++] = s.tris[3 * t + 2];
		}
		if (n > start) geo.addGroup(start, n - start, m);
	}
	geo.setIndex(new THREE.BufferAttribute(index, 1));
	geo.computeBoundingSphere();
	geo.computeBoundingBox();
	return geo;
}

/** Volume, centre of mass (uniform density) and bounds. Exact for a closed solid. */
export function measure(s: Solid): Measure {
	const { v, stride, tris } = s;
	const min: [number, number, number] = [Infinity, Infinity, Infinity];
	const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < s.count; i++)
		for (let a = 0; a < 3; a++) {
			const x = v[i * stride + a];
			if (x < min[a]) min[a] = x;
			if (x > max[a]) max[a] = x;
		}
	// (Tetrahedra from the box's middle, not the origin: a small piece far from the origin loses no precision)
	const ox = (min[0] + max[0]) / 2;
	const oy = (min[1] + max[1]) / 2;
	const oz = (min[2] + max[2]) / 2;
	let vol = 0;
	let cx = 0;
	let cy = 0;
	let cz = 0;
	for (let t = 0; t < s.ntris; t++) {
		const a = tris[3 * t] * stride;
		const b = tris[3 * t + 1] * stride;
		const c = tris[3 * t + 2] * stride;
		const ax = v[a] - ox, ay = v[a + 1] - oy, az = v[a + 2] - oz;
		const bx = v[b] - ox, by = v[b + 1] - oy, bz = v[b + 2] - oz;
		const cx2 = v[c] - ox, cy2 = v[c + 1] - oy, cz2 = v[c + 2] - oz;
		const d = ax * (by * cz2 - bz * cy2) + ay * (bz * cx2 - bx * cz2) + az * (bx * cy2 - by * cx2);
		vol += d;
		cx += d * (ax + bx + cx2);
		cy += d * (ay + by + cy2);
		cz += d * (az + bz + cz2);
	}
	const volume = vol / 6;
	const k = Math.abs(vol) > 1e-18 ? 1 / (4 * vol) : 0;
	return { volume, centroid: k ? [ox + cx * k, oy + cy * k, oz + cz * k] : [ox, oy, oz], min, max };
}

/** Turns the solid inside out: for a mesh whose triangles all face inwards. */
export function invert(s: Solid): void {
	for (let t = 0; t < s.ntris; t++) {
		const b = s.tris[3 * t + 1];
		s.tris[3 * t + 1] = s.tris[3 * t + 2];
		s.tris[3 * t + 2] = b;
	}
	if (s.oNormal >= 0) for (let i = 0; i < s.count; i++) for (let a = 0; a < 3; a++) s.v[i * s.stride + s.oNormal + a] *= -1;
}

/** Moves the solid's positions (not `rest`) by −offset. */
export function recentre(s: Solid, offset: ArrayLike<number>): void {
	for (let i = 0; i < s.count; i++) for (let a = 0; a < 3; a++) s.v[i * s.stride + a] -= offset[a];
}

/** Directed weld edges with no opposite: 0 for a closed solid. */
export function openEdges(s: Solid): number {
	const edges = new Map<number, number>();
	const key = (a: number, b: number) => a * s.welds + b;
	for (let t = 0; t < s.ntris; t++)
		for (let e = 0; e < 3; e++) {
			const a = s.weld[s.tris[3 * t + e]];
			const b = s.weld[s.tris[3 * t + ((e + 1) % 3)]];
			edges.set(key(a, b), (edges.get(key(a, b)) ?? 0) + 1);
		}
	let open = 0;
	for (const [k, n] of edges) {
		const a = Math.floor(k / s.welds);
		const b = k - a * s.welds;
		const back = edges.get(key(b, a)) ?? 0;
		if (n > back) open += n - back;
	}
	return open;
}

/**
 * Triangulates loops lying in the plane with normal `n` (unit), given as 2D points in a basis u × v = n.
 * Loops turning anticlockwise are outlines, clockwise ones are holes in the smallest outline around them.
 * Returns triangles as indices into the points, anticlockwise, using every point of every loop it could.
 */
export function triangulateLoops(xy: Float64Array | number[], loops: number[][]): number[] {
	const area = (loop: number[]) => {
		let a = 0;
		for (let i = 0; i < loop.length; i++) {
			const p = loop[i];
			const q = loop[(i + 1) % loop.length];
			a += xy[2 * p] * xy[2 * q + 1] - xy[2 * q] * xy[2 * p + 1];
		}
		return a / 2;
	};
	const inside = (x: number, y: number, loop: number[]) => {
		let c = false;
		for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
			const xi = xy[2 * loop[i]], yi = xy[2 * loop[i] + 1];
			const xj = xy[2 * loop[j]], yj = xy[2 * loop[j] + 1];
			if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
		}
		return c;
	};
	const outers: { loop: number[]; area: number; holes: number[][] }[] = [];
	const holes: number[][] = [];
	// (Loops that enclose nothing, and holes with no outline around them, still owe the surface their edges:
	// they are filled as fans, which have no area to show)
	const flatLoops: number[][] = [];
	for (const loop of loops) {
		if (loop.length < 3) continue;
		const a = area(loop);
		if (a > 0) outers.push({ loop, area: a, holes: [] });
		else if (a < 0) holes.push(loop);
		else flatLoops.push(loop);
	}
	outers.sort((a, b) => a.area - b.area);
	for (const hole of holes) {
		const x = xy[2 * hole[0]];
		const y = xy[2 * hole[0] + 1];
		const home = outers.find((o) => o.area > -area(hole) && inside(x, y, o.loop));
		if (home) home.holes.push(hole);
		else flatLoops.push(hole);
	}
	const out: number[] = [];
	for (const loop of flatLoops) for (let i = 1; i + 1 < loop.length; i++) out.push(loop[0], loop[i], loop[i + 1]);
	for (const o of outers) {
		// A ring is cleaned before it is triangulated: points that repeat go, and so do spikes (out and straight
		// back along one line, which a cut through a triangle with no area leaves). What is left out is put back
		// below as triangles with no area.
		const clean = (loop: number[]) => {
			const out: number[] = [];
			const spike = (a: number, b: number, c: number) => {
				const ux = xy[2 * b] - xy[2 * a], uy = xy[2 * b + 1] - xy[2 * a + 1];
				const vx = xy[2 * c] - xy[2 * b], vy = xy[2 * c + 1] - xy[2 * b + 1];
				const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
				if (lu === 0 || lv === 0) return true;
				return Math.abs(ux * vy - uy * vx) <= 1e-9 * lu * lv && ux * vx + uy * vy < 0;
			};
			for (const p of loop) {
				out.push(p);
				while (out.length >= 3 && spike(out[out.length - 3], out[out.length - 2], out[out.length - 1])) out.splice(out.length - 2, 1);
				if (out.length >= 2 && xy[2 * out[out.length - 1]] === xy[2 * out[out.length - 2]] && xy[2 * out[out.length - 1] + 1] === xy[2 * out[out.length - 2] + 1]) out.pop();
			}
			// (And across the ring's ends)
			for (let again = true; again && out.length >= 3; ) {
				again = false;
				const m = out.length;
				if (spike(out[m - 2], out[m - 1], out[0])) {
					out.pop();
					again = true;
				} else if (spike(out[m - 1], out[0], out[1])) {
					out.shift();
					again = true;
				}
			}
			return out;
		};
		const outline = clean(o.loop);
		if (outline.length < 3) {
			for (const loop of [o.loop, ...o.holes]) for (let i = 1; i + 1 < loop.length; i++) out.push(loop[0], loop[i], loop[i + 1]);
			continue;
		}
		const rings = [outline, ...o.holes.map(clean).filter((r) => r.length >= 3)];
		const tri: number[] = [];
		const earcut = (rings: number[][]) => {
			const flat = rings.flat();
			const contour = rings[0].map((p) => new THREE.Vector2(xy[2 * p], xy[2 * p + 1]));
			const holeRings = rings.slice(1).map((r) => r.map((p) => new THREE.Vector2(xy[2 * p], xy[2 * p + 1])));
			for (const f of THREE.ShapeUtils.triangulateShape(contour, holeRings)) {
				const a = flat[f[0]], b = flat[f[1]], c = flat[f[2]];
				const d = (xy[2 * b] - xy[2 * a]) * (xy[2 * c + 1] - xy[2 * a + 1]) - (xy[2 * c] - xy[2 * a]) * (xy[2 * b + 1] - xy[2 * a + 1]);
				if (d >= 0) tri.push(a, b, c);
				else tri.push(a, c, b);
			}
		};
		earcut(rings);
		// Earcut leaves out triangles with no area (three points in a line), so its outline can differ from the
		// rings': a point skipped, an edge unpaired. The edges still owed are chained into rings of their own.
		const total = xy.length / 2;
		const owed = (): number[][] => {
			const count = new Map<number, number>();
			const add = (a: number, b: number, n: number) => {
				const k = a < b ? a * total + b : b * total + a;
				count.set(k, (count.get(k) ?? 0) + (a < b ? n : -n));
			};
			for (const ring of [o.loop, ...o.holes]) for (let i = 0; i < ring.length; i++) add(ring[i], ring[(i + 1) % ring.length], 1);
			for (let t = 0; t < tri.length; t += 3) for (let e = 0; e < 3; e++) add(tri[t + e], tri[t + ((e + 1) % 3)], -1);
			const next = new Map<number, number[]>();
			for (const [k, n] of count) {
				if (!n) continue;
				const a = Math.floor(k / total);
				const b = k - a * total;
				const [from, to] = n > 0 ? [a, b] : [b, a];
				for (let i = 0; i < Math.abs(n); i++) {
					const list = next.get(from);
					if (list) list.push(to);
					else next.set(from, [to]);
				}
			}
			const chains: number[][] = [];
			for (const [from, tos] of next) {
				while (tos.length) {
					const chain = [from];
					let cur = tos.pop()!;
					while (cur !== from) {
						chain.push(cur);
						const more = next.get(cur);
						if (!more || !more.length) break;
						cur = more.pop()!;
					}
					chains.push(chain);
				}
			}
			return chains;
		};
		// A ring owed that encloses real area is a part earcut gave up on (an outline that touches itself):
		// it is triangulated by itself. What is owed after that has no area, and is filled with flat fans, so
		// the cap meets the surface at every point and nothing is left as a T-junction.
		let again = false;
		for (const chain of owed()) {
			const ring = clean(chain);
			if (ring.length >= 3 && area(ring) > 1e-7 * o.area) {
				earcut([ring]);
				again = true;
			} else for (let i = 1; i + 1 < chain.length; i++) tri.push(chain[0], chain[i], chain[i + 1]);
		}
		if (again) for (const chain of owed()) for (let i = 1; i + 1 < chain.length; i++) tri.push(chain[0], chain[i], chain[i + 1]);
		for (const i of tri) out.push(i);
	}
	return out;
}

/** A basis (u, v) of the plane with normal n, with u × v = n. */
export function planeBasis(n: ArrayLike<number>): [number[], number[]] {
	const a = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : Math.abs(n[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
	let u = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]];
	const l = Math.hypot(u[0], u[1], u[2]);
	u = [u[0] / l, u[1] / l, u[2] / l];
	const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
	return [u, v];
}

/** Closes the holes of an open surface with flat patches in the cap slot (a scan with no underside, a bowl). */
export function closeHoles(s: Solid): Solid {
	const key = (a: number, b: number) => a * s.welds + b;
	const edges = new Map<number, number>();
	for (let t = 0; t < s.ntris; t++)
		for (let e = 0; e < 3; e++) {
			const k = key(s.weld[s.tris[3 * t + e]], s.weld[s.tris[3 * t + ((e + 1) % 3)]]);
			edges.set(k, (edges.get(k) ?? 0) + 1);
		}
	// Each edge with no opposite needs one: the patch's edges run the other way
	const next = new Map<number, number[]>();
	const vertexAt = new Map<number, number>();
	let any = false;
	for (let t = 0; t < s.ntris; t++)
		for (let e = 0; e < 3; e++) {
			const va = s.tris[3 * t + e];
			const vb = s.tris[3 * t + ((e + 1) % 3)];
			const a = s.weld[va];
			const b = s.weld[vb];
			const n = edges.get(key(a, b))!;
			const back = edges.get(key(b, a)) ?? 0;
			if (n <= back) continue;
			edges.set(key(a, b), n - 1);
			any = true;
			const list = next.get(b);
			if (list) list.push(a);
			else next.set(b, [a]);
			vertexAt.set(a, va);
			vertexAt.set(b, vb);
		}
	if (!any) return s;
	const loops: number[][] = [];
	for (const [from, tos] of next) {
		while (tos.length) {
			const loop = [from];
			let cur = tos.pop()!;
			while (cur !== from && loop.length < 100000) {
				loop.push(cur);
				const out = next.get(cur);
				if (!out || !out.length) break;
				cur = out.pop()!;
			}
			if (loop.length >= 3) loops.push(loop);
		}
	}
	const { stride, v } = s;
	const extraV: number[] = [];
	const extraW: number[] = [];
	const extraT: number[] = [];
	let count = s.count;
	for (const loop of loops) {
		// The patch's plane: Newell's normal of the loop, about its middle
		const n = [0, 0, 0];
		const mid = [0, 0, 0];
		for (let i = 0; i < loop.length; i++) {
			const p = vertexAt.get(loop[i])! * stride;
			const q = vertexAt.get(loop[(i + 1) % loop.length])! * stride;
			n[0] += (v[p + 1] - v[q + 1]) * (v[p + 2] + v[q + 2]);
			n[1] += (v[p + 2] - v[q + 2]) * (v[p] + v[q]);
			n[2] += (v[p] - v[q]) * (v[p + 1] + v[q + 1]);
			for (let a = 0; a < 3; a++) mid[a] += v[p + a] / loop.length;
		}
		const l = Math.hypot(n[0], n[1], n[2]);
		if (l < 1e-20) continue;
		n[0] /= l;
		n[1] /= l;
		n[2] /= l;
		const [bu, bv] = planeBasis(n);
		const xy = new Float64Array(loop.length * 2);
		const base = count;
		loop.forEach((w, i) => {
			const p = vertexAt.get(w)! * stride;
			const x = v[p] * bu[0] + v[p + 1] * bu[1] + v[p + 2] * bu[2];
			const y = v[p] * bv[0] + v[p + 1] * bv[1] + v[p + 2] * bv[2];
			xy[2 * i] = x;
			xy[2 * i + 1] = y;
			const at = extraV.length;
			for (let c = 0; c < stride; c++) extraV.push(v[p + c]);
			if (s.oNormal >= 0) for (let a = 0; a < 3; a++) extraV[at + s.oNormal + a] = n[a];
			if (s.oUv >= 0) {
				extraV[at + s.oUv] = x;
				extraV[at + s.oUv + 1] = y;
			}
			if (s.oTangent >= 0) {
				for (let a = 0; a < 3; a++) extraV[at + s.oTangent + a] = bu[a];
				extraV[at + s.oTangent + 3] = 1;
			}
			extraW.push(w);
			count++;
		});
		const tri = triangulateLoops(xy, [loop.map((_, i) => i)]);
		for (const i of tri) extraT.push(base + i);
	}
	const nv = new Float32Array(count * stride);
	nv.set(s.v);
	nv.set(extraV, s.count * stride);
	const nw = new Uint32Array(count);
	nw.set(s.weld);
	nw.set(extraW, s.count);
	const nt = new Uint32Array(s.ntris * 3 + extraT.length);
	nt.set(s.tris);
	nt.set(extraT, s.ntris * 3);
	const ns = new Uint8Array(s.ntris + extraT.length / 3);
	ns.set(s.slot);
	ns.fill(s.capSlot, s.ntris);
	return { ...s, v: nv, count, weld: nw, tris: nt, slot: ns, ntris: ns.length };
}
