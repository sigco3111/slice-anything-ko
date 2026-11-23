// Two measurements. The pile: fifty-odd pieces in a heap, all cut by one plane, and how the work spreads over
// frames. The frame rate: real time at 1080p with over a hundred pieces on the ground (run this one under the
// GPU lock). `node scripts/perf.mjs [--fps]`
import { arg, open, serve } from './lib.mjs';
const server = await serve();

// Runs in the page: cuts the crates into a heap of at least `want` pieces.
const heap = (want) => {
	const s = __slice;
	const V = s.sword.rig.position.constructor;
	const crates = (p) => p.options.kind === 'wood' && p.mesh.position.x > 4;
	const planes = [[0, 1, 0, -0.18], [0, 1, 0, -0.42], [0, 1, 0, -0.68], [0, 1, 0, -0.9], [1, 0, 0.2, -4.6], [1, 0, -0.2, -4.2], [1, 0, 0.1, -5.0], [0.2, 0, 1, -4.0], [-0.2, 0, 1, -2.2], [0.1, 0, 1, -3.5], [0.6, 0.6, 0.5, -4.6], [-0.5, 0.7, 0.5, -0.9], [0.3, 0.2, 1, -4.3], [1, 0.3, 0.1, -4.9]];
	for (const [x, y, z, d] of planes) {
		const n = new V(x, y, z).normalize();
		s.slicer.slice({ normal: n, constant: d / Math.hypot(x, y, z) }, new V(), crates);
		for (let i = 0; i < 30 && s.slicer.busy; i++) s.step(1);
		s.step(8);
		if ([...s.slicer.pieces].filter(crates).length >= want) break;
	}
	s.step(240);
	return [...s.slicer.pieces].filter(crates).length;
};

if (!arg('fps')) {
	const { browser, page, errors } = await open(server.url, { width: 1920, height: 1080 });
	const out = await page.evaluate(`(${heap.toString()})(50)`).then(async (pieces) => page.evaluate((pieces) => {
		const s = __slice;
		const V = s.sword.rig.position.constructor;
		const crates = (p) => p.options.kind === 'wood' && p.mesh.position.x > 4;
		s.spot('crates');
		// Frame time with nothing being cut
		const base = [];
		for (let i = 0; i < 30; i++) {
			const t = performance.now();
			s.step(1);
			base.push(performance.now() - t);
		}
		s.slicer.stats.worstMs = 0;
		s.slicer.stats.cuts = 0;
		const n = new V(0.35, 0.5, 0.8).normalize();
		// Through the heap's middle
		const mid = new V();
		const list = [...s.slicer.pieces].filter(crates);
		for (const p of list) mid.add(p.mesh.position);
		mid.multiplyScalar(1 / list.length);
		// Every piece of the heap at once, each through its own middle (one flat plane would miss most of them)
		let queued = 0;
		for (const p of list) if (s.slicer.cut(p, { normal: n, constant: -n.dot(p.mesh.position) }, new V(0.3, 0.2, 0))) queued++;
		void mid;
		const frames = [];
		for (let i = 0; i < 40; i++) {
			const t = performance.now();
			s.step(1);
			frames.push({ frame: +(performance.now() - t).toFixed(1), cutting: s.slicer.stats.queued || i === 0 || frames.length < 2 ? +s.slicer.stats.lastMs.toFixed(1) : 0, left: s.slicer.stats.queued });
			if (!s.slicer.busy && i > 3) break;
		}
		const sorted = base.slice().sort((a, b) => a - b);
		return { piecesInHeap: pieces, queued, cutsDone: s.slicer.stats.cuts, framesTaken: frames.findIndex((f) => f.left === 0) + 1, worstCuttingMsInAFrame: +s.slicer.stats.worstMs.toFixed(1), worstFrameMs: Math.max(...frames.map((f) => f.frame)), baselineFrameMs: +sorted[Math.floor(sorted.length / 2)].toFixed(1), frames: frames.slice(0, 12), piecesAfter: [...s.slicer.pieces].filter(crates).length, budgetMs: s.slicer.budgetMs };
	}, pieces));
	console.log(JSON.stringify(out, null, 1));
	if (errors.length) console.log('ERRORS', errors.slice(0, 10));
	await browser.close();
} else {
	const { browser, page, errors } = await open(server.url, { width: 1920, height: 1080, fixed: false });
	await page.evaluate(() => __slice.bare(true));
	const sample = () => page.evaluate(() => new Promise((res) => {
		const times = [];
		let last = performance.now();
		const tick = () => {
			const now = performance.now();
			times.push(now - last);
			last = now;
			if (times.length < 480) requestAnimationFrame(tick);
			else {
				times.shift();
				const sorted = times.slice().sort((a, b) => a - b);
				const mean = times.reduce((a, b) => a + b, 0) / times.length;
				res({ fps: +(1000 / mean).toFixed(1), meanMs: +mean.toFixed(2), p99Ms: +sorted[Math.floor(sorted.length * 0.99)].toFixed(2), worstMs: +sorted[sorted.length - 1].toFixed(2), allPieces: __slice.slicer.pieces.size, awake: __slice.pieces().filter((p) => !p.asleep && !p.fixed).length });
			}
		};
		requestAnimationFrame(tick);
	}));
	await page.waitForTimeout(4000);
	console.log(JSON.stringify({ what: 'untouched yard, start view', size: '1920x1080', ...(await sample()) }));
	// (In real time `step` adds frames on top of the page's own, which only hurries the heap along)
	const pieces = await page.evaluate(`(${heap.toString()})(110)`);
	await page.evaluate(() => __slice.spot('crates'));
	await page.waitForTimeout(9000);
	console.log(JSON.stringify({ what: 'heap of crate pieces in view', heapPieces: pieces, size: '1920x1080', ...(await sample()) }));
	if (errors.length) console.log('ERRORS', errors.slice(0, 10));
	await browser.close();
}
server.stop();
