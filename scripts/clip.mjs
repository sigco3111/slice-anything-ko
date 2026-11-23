// The clip: one first-person take, frame-stepped at 60 fps, played by a script that moves like a person: it
// walks at walking pace, turns its head with a little overshoot, and reacts to the thrown fruit when it is close.
// `node scripts/clip.mjs [--out shots/clip.mp4] [--w 1920 --h 1080] [--until 9.6] [--stills]`
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { arg, open, root, serve } from './lib.mjs';
const out = join(root, arg('out', 'shots/clip.mp4'));
const width = Number(arg('w', 1920)), height = Number(arg('h', 1080));
const until = Number(arg('until', 10.2));
const server = await serve();
const { browser, page, errors } = await open(server.url, { width, height });

// The take: where to stand and what to look at over time, and what to do when.
await page.evaluate(() => {
	const s = __slice;
	const V = s.camera.position.constructor;
	s.bare(true);
	s.step(90);
	s.stand(0.25, 3.7, 0, -0.03);
	const path = [
		{ t: 0, at: [0.25, 3.7], look: [0, 1.55, 0.6] },
		{ t: 0.95, at: [0.12, 1.78], look: [0.02, 1.58, 0.6] },
		{ t: 1.55, at: [0.12, 1.78], look: [0.0, 1.5, 0.6] },
		{ t: 2.45, at: [-0.98, 1.56], look: [-1.5, 1.05, 0.7] },
		{ t: 3.15, at: [-0.98, 1.56], look: [-1.5, 1.0, 0.7] },
		{ t: 3.75, at: [-1.25, 2.2], look: [-3.6, 1.7, -2.4] },
		{ t: 6.7, at: [-1.25, 2.2], look: [-3.6, 1.6, -2.4] },
		{ t: 7.3, at: [-0.78, 0.9], look: [-1.5, 1.5, -2.2] },
		{ t: 8.3, at: [-1.8, -1.2], look: [-1.9, 1.36, -2.2] },
		{ t: 12, at: [-1.8, -1.2], look: [-1.9, 1.34, -2.2] },
	];
	const acts = [
		{ t: 1.05, do: () => s.swing(36) },
		{ t: 2.62, do: () => s.swing(-22) },
		{ t: 3.95, do: () => (state.fruit = s.throwFruit()) },
		{ t: 8.55, do: () => s.swing(8) },
	];
	const state = { t: 0, fruit: null, cutAt: 0, yawV: 0, pitchV: 0, focusOff: 0, done: new Set() };
	const ease = (k) => k * k * (3 - 2 * k);
	s.bot((dt) => {
		state.t += dt;
		const t = state.t;
		let i = 0;
		while (i < path.length - 2 && t > path[i + 1].t) i++;
		const a = path[i], b = path[i + 1];
		const k = ease(Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))));
		// Walk toward where the path says to be, no faster than a walk
		const want = new V(a.at[0] + (b.at[0] - a.at[0]) * k, 0, a.at[1] + (b.at[1] - a.at[1]) * k);
		const d = want.sub(new V(s.player.at.x, 0, s.player.at.z));
		const speed = Math.min(3.0, d.length() / Math.max(dt, 1e-3) * 0.35);
		s.player.drive = d.lengthSq() > 1e-6 ? d.normalize().multiplyScalar(speed) : new V();
		// Turn the head toward the target like a sprung mass: quick, a touch past, and back
		const look = [0, 1, 2].map((c) => a.look[c] + (b.look[c] - a.look[c]) * k);
		const eye = new V(s.player.at.x, s.player.at.y + s.eye, s.player.at.z);
		// (Eyes on the fruit from the throw until a moment after the cut)
		if (state.fruit && state.fruit.alive) state.seen = state.fruit.mesh.position.clone();
		if (state.seen && (!state.cutAt || t < state.cutAt + 0.75)) {
			look[0] = state.seen.x; look[1] = state.seen.y; look[2] = state.seen.z;
		}
		const to = new V(look[0] - eye.x, look[1] - eye.y, look[2] - eye.z);
		const yaw = Math.atan2(-to.x, -to.z), pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
		const W = 11, Z = 0.62;
		let dy = yaw - s.player.yaw;
		dy = Math.atan2(Math.sin(dy), Math.cos(dy));
		state.yawV += (W * W * dy - 2 * Z * W * state.yawV) * dt;
		state.pitchV += (W * W * (pitch - s.player.pitch) - 2 * Z * W * state.pitchV) * dt;
		s.player.yaw += state.yawV * dt;
		s.player.pitch += state.pitchV * dt;
		for (const act of acts) if (t >= act.t && !state.done.has(act)) { state.done.add(act); act.do(); }
		// The fruit: focus as it comes close, cut when it is nearly in reach, let go a moment after
		if (state.fruit && state.fruit.alive && !state.cutAt) {
			const far = state.fruit.mesh.position.distanceTo(eye);
			if (far < 2.3) s.focus(true);
			if (far < 1.13) { s.swing(76); state.cutAt = t; }
		}
		if (state.cutAt && !state.focusOff && t > state.cutAt + 1.55) { s.focus(false); state.focusOff = t; }
	});
});

const ff = arg('stills') ? null : spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '60', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '15', '-preset', 'slow', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
if (arg('stills')) mkdirSync(join(root, 'shots/clip-stills'), { recursive: true });
const frames = Math.round(until * 60);
const every = Number(arg('every', 20));
for (let f = 0; f < frames; f++) {
	await page.evaluate(() => __slice.step(1));
	if (ff) ff.stdin.write(await page.screenshot({ type: 'jpeg', quality: 95 }));
	else if (f % every === 0) await page.screenshot({ path: join(root, 'shots/clip-stills', `${String(f).padStart(4, '0')}.png`) });
}
console.log(JSON.stringify(await page.evaluate(() => ({ cuts: __slice.cuts.total, pieces: __slice.pieces().length, worstCutMs: +__slice.slicer.stats.worstMs.toFixed(1) }))));
if (errors.length) console.log('ERRORS', errors.slice(0, 10));
if (ff) {
	ff.stdin.end();
	await new Promise((r) => ff.on('close', r));
	console.log('wrote', out);
}
await browser.close();
server.stop();
