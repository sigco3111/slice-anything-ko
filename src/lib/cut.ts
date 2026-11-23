// The cut: a solid and a plane in, the solids on each side out, each closed again by a cap in the cap slot.
// Pure arithmetic on typed arrays (no three.js scene objects), so it can run on any thread.
import { planeBasis, triangulateLoops, type Solid } from './solid.ts';

export interface CutResult {
	/** Closed pieces on the side the normal points away from (n·p + d < 0), one per connected part. */
	below: Solid[];
	/** Pieces on the side the normal points to. */
	above: Solid[];
	/** False when the plane missed the solid: the solid itself is then the only piece, on its side. */
	cut: boolean;
}

class Floats {
	a: Float32Array;
	n = 0;
	constructor(capacity: number) {
		this.a = new Float32Array(Math.max(64, capacity));
	}
	room(k: number): number {
		if (this.n + k > this.a.length) {
			const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
			b.set(this.a.subarray(0, this.n));
			this.a = b;
		}
		const at = this.n;
		this.n += k;
		return at;
	}
}

/** One side of the cut as it is built. */
class Side {
	v: Floats;
	weld: number[] = [];
	tris: number[] = [];
	slot: number[] = [];
	count = 0;
	welds = 0;
	/** Source vertex → vertex here, source weld → weld here (-1: not copied yet). */
	vmap: Int32Array;
	wmap: Int32Array;
	/** Vertices made on cut edges, by source vertex pair. */
	emap = new Map<number, number>();
	/** Cut point → weld here, and a vertex here that sits on it. */
	pweld: number[] = [];
	pvert: number[] = [];
	/** Cut points that landed exactly on a source weld of this side: [point, source weld]. */
	same: number[] = [];

	readonly src: Solid;

	constructor(src: Solid) {
		this.src = src;
		this.v = new Floats((src.count * src.stride) >> 1);
		this.vmap = new Int32Array(src.count).fill(-1);
		this.wmap = new Int32Array(src.welds).fill(-1);
	}

	copy(i: number): number {
		let k = this.vmap[i];
		if (k >= 0) return k;
		const { src } = this;
		const at = this.v.room(src.stride);
		this.v.a.set(src.v.subarray(i * src.stride, (i + 1) * src.stride), at);
		const w = src.weld[i];
		if (this.wmap[w] < 0) this.wmap[w] = this.welds++;
		this.weld.push(this.wmap[w]);
		k = this.count++;
		this.vmap[i] = k;
		return k;
	}
}

/**
 * Cuts `src` along the plane n·p + d = 0 (n a unit vector, in the solid's own space).
 * `uvScale`: cap UVs are metres along the plane times this.
 */
export function cut(src: Solid, n: ArrayLike<number>, d: number, uvScale = 1): CutResult {
	const { v, stride, weld, tris, count } = src;
	// Which side each place is on. A place on the plane counts as just above it, so no triangle is ever cut
	// through a corner and every case below is the general one.
	let size = 0;
	for (let a = 0; a < 3; a++) {
		let lo = Infinity;
		let hi = -Infinity;
		for (let i = 0; i < count; i += Math.max(1, count >> 9)) {
			const x = v[i * stride + a];
			if (x < lo) lo = x;
			if (x > hi) hi = x;
		}
		size = Math.max(size, hi - lo);
	}
	const eps = Math.max(1e-7, size * 2e-6);
	const dist = new Float64Array(src.welds);
	const known = new Uint8Array(src.welds);
	let below = 0;
	let above = 0;
	for (let i = 0; i < count; i++) {
		const w = weld[i];
		if (known[w]) continue;
		known[w] = 1;
		const o = i * stride;
		let x = n[0] * v[o] + n[1] * v[o + 1] + n[2] * v[o + 2] + d;
		if (x > -eps && x < eps) x = eps;
		dist[w] = x;
		if (x < 0) below++;
		else above++;
	}
	if (!below) return { below: [], above: [src], cut: false };
	if (!above) return { below: [src], above: [], cut: false };

	const sides = [new Side(src), new Side(src)];
	// Cut points: one per weld edge that crosses, shared by every triangle on that edge
	const points: number[] = [];
	const pointOf = new Map<number, number>();
	const pointAt = new Map<string, number>();
	// Cap edges, as cut point pairs, turning the way the lower side's cap needs them
	const segFrom: number[] = [];
	const segTo: number[] = [];

	/** The vertex on side `s` where the edge between source vertices i and j crosses the plane. */
	const crossing = (i: number, j: number, s: number): number => {
		// (Always worked out from the lower end to the upper, so both triangles on an edge get the same floats)
		const lo = dist[weld[i]] < 0 ? i : j;
		const hi = lo === i ? j : i;
		const side = sides[s];
		const key = lo * count + hi;
		const have = side.emap.get(key);
		if (have !== undefined) return have;
		const wl = weld[lo];
		const wh = weld[hi];
		const t = dist[wl] / (dist[wl] - dist[wh]);
		const pkey = wl * src.welds + wh;
		let p = pointOf.get(pkey);
		const a = lo * stride;
		const b = hi * stride;
		if (p === undefined) {
			// (As the floats the vertices will hold: cut points that land on one place are one point, so the
			// surface never gets edges of no length, which later cuts would turn into caps that fold back)
			const x = Math.fround(v[a] + (v[b] - v[a]) * t);
			const y = Math.fround(v[a + 1] + (v[b + 1] - v[a + 1]) * t);
			const z = Math.fround(v[a + 2] + (v[b + 2] - v[a + 2]) * t);
			const place = `${x},${y},${z}`;
			p = pointAt.get(place);
			if (p === undefined) {
				p = points.length / 3;
				pointAt.set(place, p);
				points.push(x, y, z);
				sides[0].pweld.push(-1);
				sides[1].pweld.push(-1);
				sides[0].pvert.push(-1);
				sides[1].pvert.push(-1);
			}
			pointOf.set(pkey, p);
			if (x === v[a] && y === v[a + 1] && z === v[a + 2]) sides[0].same.push(p, wl);
			if (x === v[b] && y === v[b + 1] && z === v[b + 2]) sides[1].same.push(p, wh);
		}
		const at = side.v.room(stride);
		const out = side.v.a;
		for (let c = 3; c < stride; c++) out[at + c] = v[a + c] + (v[b + c] - v[a + c]) * t;
		out[at] = points[3 * p];
		out[at + 1] = points[3 * p + 1];
		out[at + 2] = points[3 * p + 2];
		if (src.oNormal >= 0) unit(out, at + src.oNormal);
		if (src.oTangent >= 0) {
			unit(out, at + src.oTangent);
			out[at + src.oTangent + 3] = v[a + src.oTangent + 3];
		}
		if (side.pweld[p] < 0) side.pweld[p] = side.welds++;
		side.weld.push(side.pweld[p]);
		const k = side.count++;
		side.pvert[p] = k;
		side.emap.set(key, k);
		return k;
	};

	for (let t = 0; t < src.ntris; t++) {
		const i0 = tris[3 * t];
		const i1 = tris[3 * t + 1];
		const i2 = tris[3 * t + 2];
		const s0 = dist[weld[i0]] < 0 ? 0 : 1;
		const s1 = dist[weld[i1]] < 0 ? 0 : 1;
		const s2 = dist[weld[i2]] < 0 ? 0 : 1;
		const m = src.slot[t];
		if (s0 === s1 && s1 === s2) {
			const side = sides[s0];
			side.tris.push(side.copy(i0), side.copy(i1), side.copy(i2));
			side.slot.push(m);
			continue;
		}
		// The corner alone on its side first, the other two after it in the triangle's own order
		let l = i0, a = i1, b = i2, sl = s0;
		if (s1 !== s0 && s1 !== s2) {
			l = i1;
			a = i2;
			b = i0;
			sl = s1;
		} else if (s2 !== s0 && s2 !== s1) {
			l = i2;
			a = i0;
			b = i1;
			sl = s2;
		}
		const lone = sides[sl];
		const pair = sides[1 - sl];
		const pl = crossing(l, a, sl);
		const ql = crossing(b, l, sl);
		lone.tris.push(lone.copy(l), pl, ql);
		lone.slot.push(m);
		const po = crossing(l, a, 1 - sl);
		const qo = crossing(b, l, 1 - sl);
		const ka = pair.copy(a);
		const kb = pair.copy(b);
		pair.tris.push(po, ka, kb, po, kb, qo);
		pair.slot.push(m, m);
		const p = pointOf.get(key2(src, weld, dist, l, a))!;
		const q = pointOf.get(key2(src, weld, dist, b, l))!;
		// The lower side's cap runs against its own triangles' cut edges
		if (p === q) continue;
		if (sl === 0) {
			segFrom.push(q);
			segTo.push(p);
		} else {
			segFrom.push(p);
			segTo.push(q);
		}
	}

	// Chain the cap edges into loops
	const npts = points.length / 3;
	const head = new Int32Array(npts).fill(-1);
	const nextSeg = new Int32Array(segFrom.length);
	for (let k = 0; k < segFrom.length; k++) {
		nextSeg[k] = head[segFrom[k]];
		head[segFrom[k]] = k;
	}
	const used = new Uint8Array(segFrom.length);
	const take = (p: number): number => {
		for (let k = head[p]; k >= 0; k = nextSeg[k])
			if (!used[k]) {
				used[k] = 1;
				return segTo[k];
			}
		return -1;
	};
	const loops: number[][] = [];
	for (let k = 0; k < segFrom.length; k++) {
		if (used[k]) continue;
		used[k] = 1;
		const start = segFrom[k];
		const loop = [start];
		let cur = segTo[k];
		while (cur !== start && cur >= 0) {
			loop.push(cur);
			cur = take(cur);
		}
		// (A chain that never comes back, on a surface that wasn't closed, is closed straight across)
		if (loop.length >= 3) loops.push(loop);
	}

	// The caps: the same triangles on both sides, facing opposite ways
	const [bu, bv] = planeBasis(n);
	const flat: number[] = [];
	const xy: number[] = [];
	const rings: number[][] = [];
	for (const loop of loops) {
		const ring: number[] = [];
		for (const p of loop) {
			ring.push(flat.length);
			flat.push(p);
			const x = points[3 * p], y = points[3 * p + 1], z = points[3 * p + 2];
			xy.push(x * bu[0] + y * bu[1] + z * bu[2], x * bv[0] + y * bv[1] + z * bv[2]);
		}
		rings.push(ring);
	}
	const capTris = triangulateLoops(xy, rings);
	for (let s = 0; s < 2; s++) {
		const side = sides[s];
		const sign = s === 0 ? 1 : -1;
		const base = side.count;
		const out = side.v;
		for (let i = 0; i < flat.length; i++) {
			const p = flat[i];
			const from = side.pvert[p] * stride;
			const at = out.room(stride);
			out.a.copyWithin(at, from, from + stride);
			if (src.oNormal >= 0) for (let a = 0; a < 3; a++) out.a[at + src.oNormal + a] = n[a] * sign;
			if (src.oUv >= 0) {
				out.a[at + src.oUv] = xy[2 * i] * uvScale;
				out.a[at + src.oUv + 1] = xy[2 * i + 1] * uvScale;
			}
			if (src.oTangent >= 0) {
				for (let a = 0; a < 3; a++) out.a[at + src.oTangent + a] = bu[a];
				out.a[at + src.oTangent + 3] = sign;
			}
			side.weld.push(side.pweld[p]);
			side.count++;
		}
		for (let k = 0; k < capTris.length; k += 3) {
			if (s === 0) side.tris.push(base + capTris[k], base + capTris[k + 1], base + capTris[k + 2]);
			else side.tris.push(base + capTris[k], base + capTris[k + 2], base + capTris[k + 1]);
			side.slot.push(src.capSlot);
		}
	}
	settle(sides[0]);
	settle(sides[1]);
	return { below: parts(sides[0]), above: parts(sides[1]), cut: true };
}

function key2(src: Solid, weld: Uint32Array, dist: Float64Array, i: number, j: number): number {
	const wi = weld[i];
	const wj = weld[j];
	return dist[wi] < 0 ? wi * src.welds + wj : wj * src.welds + wi;
}

function unit(a: Float32Array, at: number): void {
	const l = Math.hypot(a[at], a[at + 1], a[at + 2]);
	if (l > 0) {
		a[at] /= l;
		a[at + 1] /= l;
		a[at + 2] /= l;
	}
}

/** Makes one weld of the welds that share a place, and drops the triangles left with no area. */
function settle(side: Side): void {
	const { weld, tris, slot } = side;
	if (side.same.length) {
		const parent = new Int32Array(side.welds);
		for (let i = 0; i < parent.length; i++) parent[i] = i;
		const find = (x: number): number => {
			while (parent[x] !== x) {
				parent[x] = parent[parent[x]];
				x = parent[x];
			}
			return x;
		};
		for (let k = 0; k < side.same.length; k += 2) {
			const a = side.pweld[side.same[k]];
			const b = side.wmap[side.same[k + 1]];
			if (a >= 0 && b >= 0) parent[find(a)] = find(b);
		}
		const remap = new Int32Array(side.welds).fill(-1);
		let n = 0;
		for (let i = 0; i < weld.length; i++) {
			const r = find(weld[i]);
			if (remap[r] < 0) remap[r] = n++;
			weld[i] = remap[r];
		}
		side.welds = n;
	}
	let k = 0;
	for (let t = 0; t < slot.length; t++) {
		const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
		if (weld[a] === weld[b] || weld[b] === weld[c] || weld[c] === weld[a]) continue;
		tris[3 * k] = a;
		tris[3 * k + 1] = b;
		tris[3 * k + 2] = c;
		slot[k++] = slot[t];
	}
	tris.length = 3 * k;
	slot.length = k;
}

/** A side's connected parts as solids of their own (a cut through a U leaves two pieces on one side). */
function parts(side: Side): Solid[] {
	const { src } = side;
	const ntris = side.slot.length;
	if (!ntris) return [];
	const parent = new Int32Array(side.welds);
	for (let i = 0; i < parent.length; i++) parent[i] = i;
	const find = (x: number): number => {
		while (parent[x] !== x) {
			parent[x] = parent[parent[x]];
			x = parent[x];
		}
		return x;
	};
	const { tris, weld } = side;
	for (let t = 0; t < ntris; t++) {
		const a = find(weld[tris[3 * t]]);
		const b = find(weld[tris[3 * t + 1]]);
		const c = find(weld[tris[3 * t + 2]]);
		if (b !== a) parent[b] = a;
		if (c !== a) parent[find(c)] = a;
	}
	const whole = (): Solid => ({
		...src,
		v: side.v.a.slice(0, side.count * src.stride),
		count: side.count,
		weld: Uint32Array.from(side.weld),
		welds: side.welds,
		tris: Uint32Array.from(tris),
		slot: Uint8Array.from(side.slot),
		ntris,
	});
	const root = find(weld[tris[0]]);
	let one = true;
	for (let t = 1; t < ntris && one; t++) one = find(weld[tris[3 * t]]) === root;
	if (one) return [whole()];
	const groups = new Map<number, number[]>();
	for (let t = 0; t < ntris; t++) {
		const r = find(weld[tris[3 * t]]);
		const g = groups.get(r);
		if (g) g.push(t);
		else groups.set(r, [t]);
	}
	const out: Solid[] = [];
	const stride = src.stride;
	const vmap = new Int32Array(side.count);
	const wmap = new Int32Array(side.welds);
	for (const list of groups.values()) {
		vmap.fill(-1);
		wmap.fill(-1);
		const v = new Floats(list.length * stride);
		const w: number[] = [];
		const tr = new Uint32Array(list.length * 3);
		const sl = new Uint8Array(list.length);
		let count = 0;
		let welds = 0;
		list.forEach((t, k) => {
			sl[k] = side.slot[t];
			for (let e = 0; e < 3; e++) {
				const i = tris[3 * t + e];
				if (vmap[i] < 0) {
					const at = v.room(stride);
					v.a.set(side.v.a.subarray(i * stride, (i + 1) * stride), at);
					if (wmap[weld[i]] < 0) wmap[weld[i]] = welds++;
					w.push(wmap[weld[i]]);
					vmap[i] = count++;
				}
				tr[3 * k + e] = vmap[i];
			}
		});
		out.push({ ...src, v: v.a.slice(0, count * stride), count, weld: Uint32Array.from(w), welds, tris: tr, slot: sl, ntris: list.length });
	}
	return out;
}
