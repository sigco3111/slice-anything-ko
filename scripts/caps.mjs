// Close-ups of cut faces: each kind of object is cut once, the far side taken away, and the face photographed.
// `node scripts/caps.mjs [--only bust,melon]`
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { arg, open, root, serve } from './lib.mjs';
const out = join(root, arg('out', 'shots/caps'));
mkdirSync(out, { recursive: true });
const server = await serve();
const { browser, page, errors } = await open(server.url, { width: 960, height: 720, query: arg('query', '') });
// name or kind to cut, the plane's normal (world), how far along the normal from the piece's middle, camera distance
const jobs = [
	['bust', [-0.15, 0.92, 0.3], 0.1, 0.8],
	['pillar', [-0.2, 0.92, 0.25], 0.2, 0.7],
	['plinth', [-0.2, 0.92, 0.25], 0.1, 1.0],
	['post', [-0.2, 0.9, 0.3], 0.3, 0.42],
	['straw', [-0.25, 0.9, 0.25], 0.1, 0.34],
	['bamboo', [-0.25, 0.85, 0.4], -0.7, 0.22],
	['melon', [-0.2, 0.92, 0.3], 0.0, 0.5],
	['orange', [-0.25, 0.9, 0.3], 0.0, 0.17],
	['apple', [-0.25, 0.9, 0.3], 0.0, 0.17],
	['lantern', [-0.2, 0.95, 0.2], 0.0, 0.45],
	['metal', [-0.25, 0.9, 0.3], 0.0, 0.42],
	['crate', [-0.3, 0.88, 0.35], 0.05, 0.95],
	['rope', [-0.3, 0.9, 0.3], 0.0, 0.09],
];
const only = arg('only') ? String(arg('only')).split(',') : null;
const made = [];
for (const [name, normal, along, distance] of jobs) {
	if (only && !only.includes(name)) continue;
	const info = await page.evaluate(([name, normal, along, distance]) => {
		const s = __slice;
		s.bare(true);
		s.reset();
		s.step(30);
		const V = s.sword.rig.position.constructor;
		const match = (p) => (name === 'crate' ? p.options.kind === 'wood' && p.solid.ntris === 24 && p.mesh.position.x > 4 : name === 'post' ? p.options.kind === 'wood' && p.solid.ntris === 12 : name === 'pillar' ? p.mesh.name === 'stone' && p.solid.ntris > 100 : name === 'plinth' ? p.mesh.name === 'stone' && p.solid.ntris < 100 && p.mesh.position.x < 1 : p.mesh.name === name);
		const piece = [...s.slicer.pieces].find(match);
		if (!piece) return { error: 'no piece ' + name };
		const n = new V(...normal).normalize();
		const c = piece.mesh.position.clone().addScaledVector(n, along);
		const plane = { normal: n, constant: -n.dot(c) };
		const before = s.cuts.total;
		s.slicer.cut(piece, plane);
		// (A big cut is worked through over a few frames)
		for (let i = 0; i < 12 && s.cuts.total === before; i++) s.step(1);
		if (s.cuts.total === before) return { error: 'no cut ' + name };
		// Keep the lower side, take the rest away, and look at the face from the side the normal points to
		const parts = s.cuts.last;
		const keep = parts.filter((p) => n.dot(p.mesh.position) + plane.constant < 0).sort((a, b) => b.volume - a.volume)[0] ?? parts[0];
		for (const p of parts) if (p !== keep) s.slicer.remove(p);
		keep.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		keep.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
		const g = keep.body.gravityScale();
		keep.body.setGravityScale(0, true);
		s.step(2);
		// The face's middle: the mean of the kept piece's cap vertices
		const solid = keep.solid;
		const mid = new V();
		let k = 0;
		for (let t = 0; t < solid.ntris; t++) {
			if (solid.slot[t] !== solid.capSlot) continue;
			for (let e = 0; e < 3; e++) {
				const i = solid.tris[3 * t + e] * solid.stride;
				mid.x += solid.v[i];
				mid.y += solid.v[i + 1];
				mid.z += solid.v[i + 2];
				k++;
			}
		}
		mid.multiplyScalar(1 / Math.max(1, k)).applyQuaternion(keep.mesh.quaternion).add(keep.mesh.position);
		// From the sun's side of the normal, so the face is lit
		const side = new V(-0.76, 0.1, 0.6).normalize();
		// (With the sun behind the camera, so the face shows its colour and not the sun's glare)
		const eye = mid.clone().addScaledVector(n, distance * 0.75).addScaledVector(side, distance * 0.6);
		s.view(eye.x, eye.y, eye.z, mid.x, mid.y, mid.z, 42);
		keep.body.setGravityScale(g, true);
		return { name, tris: solid.ntris, capTris: k / 3, volume: keep.volume };
	}, [name, normal, along, distance]);
	if (info.error) {
		console.log(info.error);
		continue;
	}
	await page.screenshot({ path: join(out, `${name}.png`) });
	made.push(name);
	console.log(JSON.stringify(info));
}
if (errors.length) console.log('ERRORS', errors.slice(0, 10));
await browser.close();
server.stop();
if (made.length > 1) {
	const cols = 4;
	const rows = Math.ceil(made.length / cols);
	const inputs = made.flatMap((n) => ['-i', join(out, `${n}.png`)]);
	execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${made.map((_, i) => `[${i}]scale=480:360[s${i}]`).join(';')};${made.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${made.length}:layout=${made.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 360}`).join('|')}:fill=black`, join(out, 'sheet.png')]);
	console.log(`sheet ${cols}x${rows}`);
}
