// Cuts code-built shapes along random planes, again and again, and checks every piece: closed, volumes add up,
// caps face the right way, no NaNs. Runs in Node (no GPU): `node scripts/fuzz-node.mjs [cuts]`.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { solidFromGeometry, measure, openEdges } from '../src/lib/solid.ts';
import { cut } from '../src/lib/cut.ts';

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const shapes = {
	box: new THREE.BoxGeometry(1, 1.4, 0.8),
	boxFine: new THREE.BoxGeometry(1, 1, 1, 6, 6, 6),
	sphere: new THREE.SphereGeometry(0.6, 24, 16),
	cylinder: new THREE.CylinderGeometry(0.3, 0.3, 2, 24, 4),
	torus: new THREE.TorusGeometry(0.6, 0.2, 12, 32),
	knot: new THREE.TorusKnotGeometry(0.5, 0.14, 96, 10),
	cone: new THREE.ConeGeometry(0.5, 1.2, 20, 3),
	openCup: new THREE.CylinderGeometry(0.4, 0.3, 0.8, 20, 2, true),
};
// A hollow box: an outer shell and an inner one facing inwards
{
	const outer = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
	const inner = new THREE.BoxGeometry(0.8, 0.8, 0.8).toNonIndexed();
	const ip = inner.getAttribute('position');
	for (let i = 0; i < ip.count; i += 3) {
		for (const name of ['position', 'normal', 'uv']) {
			const a = inner.getAttribute(name);
			for (let c = 0; c < a.itemSize; c++) {
				const t = a.getComponent(i + 1, c);
				a.setComponent(i + 1, c, a.getComponent(i + 2, c));
				a.setComponent(i + 2, c, t);
			}
		}
	}
	const n = inner.getAttribute('normal');
	for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
	const g = new THREE.BufferGeometry();
	for (const name of ['position', 'normal', 'uv']) {
		const a = outer.getAttribute(name), b = inner.getAttribute(name);
		const arr = new Float32Array(a.array.length + b.array.length);
		arr.set(a.array); arr.set(b.array, a.array.length);
		g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
	}
	shapes.hollow = g;
}
const cuts = Number(process.argv[2] ?? 300);
let dbgN = 0;
if (process.env.DBG) globalThis.__dbgFill = (x) => { if (dbgN++ < 2) console.log(JSON.stringify(x)); };
let fail = 0;
const stats = {};
for (const [name, geo] of Object.entries(shapes)) {
	const first = solidFromGeometry(geo, 1);
	const v0 = measure(first).volume;
	const open0 = openEdges(first);
	let pieces = [first];
	let worst = 0, made = 0, ms = 0, bad = 0, axis = 0;
	for (let k = 0; k < cuts; k++) {
		// (Every fourth plane is axis-aligned through grid points: the exactly-on-a-vertex and collinear cases)
		const src = pieces[Math.floor(rnd() * pieces.length)];
		const m = measure(src);
		let n = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
		const through = new THREE.Vector3(...m.centroid).add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.3 * Math.cbrt(Math.abs(m.volume))));
		if (k % 4 === 0) {
			n = new THREE.Vector3(0, 0, 0).setComponent(axis++ % 3, 1);
			through.set(Math.round(through.x * 6) / 6, Math.round(through.y * 6) / 6, Math.round(through.z * 6) / 6);
		}
		const t0 = performance.now();
		const r = cut(src, n.toArray(), -n.dot(through));
		ms += performance.now() - t0;
		if (!r.cut) continue;
		const out = [...r.below, ...r.above];
		let sum = 0;
		for (const p of out) {
			const pm = measure(p);
			sum += pm.volume;
			const open = openEdges(p);
			let nan = false;
			for (let i = 0; i < p.count * p.stride; i++) if (!Number.isFinite(p.v[i])) nan = true;
			// Caps face away from the piece: every cap triangle's own normal agrees with its vertices' normal
			let flipped = 0, capArea = 0, flipArea = 0;
			for (let t = 0; t < p.ntris; t++) {
				if (p.slot[t] !== 1) continue;
				const a = p.tris[3 * t] * p.stride, b = p.tris[3 * t + 1] * p.stride, c = p.tris[3 * t + 2] * p.stride;
				const e1 = [p.v[b] - p.v[a], p.v[b + 1] - p.v[a + 1], p.v[b + 2] - p.v[a + 2]];
				const e2 = [p.v[c] - p.v[a], p.v[c + 1] - p.v[a + 1], p.v[c + 2] - p.v[a + 2]];
				const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
				const dot = g[0] * p.v[a + p.oNormal] + g[1] * p.v[a + p.oNormal + 1] + g[2] * p.v[a + p.oNormal + 2];
				capArea += Math.abs(dot); if (dot < 0) { flipArea -= dot; if (process.env.FLIP && dot < -1e-6) (p.__flipDump ??= []).push({ t, dot, gn: g.map((x) => +x.toExponential(2)), vn: [0, 1, 2].map((k) => +p.v[a + p.oNormal + k].toFixed(3)), cutN: n.toArray().map((x) => +x.toFixed(3)), pts: [a, b, c].map((o) => [p.v[o], p.v[o + 1], p.v[o + 2]].map((x) => +x.toFixed(5))) }); }
			}
			// (Pieces under a tenth of a cubic centimetre are dust the slicer throws away: only closedness counts there)
			const real = pm.volume > 1e-7;
			if (real && flipArea > 0.01 * capArea) flipped = flipArea / capArea;
			if (open || nan || flipped || (real && pm.volume <= 0)) {
				bad++;
				if (process.env.FLIP && p.__flipDump && bad < 3) console.log(JSON.stringify(p.__flipDump.slice(0, 4)));
				if (bad < 4) console.log(`  ${name} cut ${k}: open ${open} nan ${nan} flipped ${flipped} volume ${pm.volume.toExponential(2)} tris ${p.ntris}`);
			}
		}
		const err = Math.abs(sum - m.volume) / Math.max(Math.abs(m.volume), 1e-5);
		if (err > 1e-3 && worst <= 1e-3) console.log(`  ${name} cut ${k}: volume ${m.volume.toExponential(3)} became ${sum.toExponential(3)} in ${out.length} pieces (${out.map((p) => measure(p).volume.toExponential(2)).join(' ')}), src open ${openEdges(src)} tris ${src.ntris}`);
		worst = Math.max(worst, err);
		pieces.splice(pieces.indexOf(src), 1, ...out.filter((p) => measure(p).volume > 1e-7));
		made++;
	}
	const total = pieces.reduce((s, p) => s + measure(p).volume, 0);
	stats[name] = { open0, cuts: made, pieces: pieces.length, bad, worstVolumeError: +worst.toExponential(2), msPerCut: +(ms / Math.max(1, made)).toFixed(3), keptVolume: +(total / v0).toFixed(4) };
	if (bad || open0 || worst > 1e-3) fail++;
}
console.table(stats);
console.log(fail ? `FAIL: ${fail} shapes` : 'pass node-fuzz');
process.exit(fail ? 1 : 0);
