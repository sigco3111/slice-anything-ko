// Cold load, in real time: a fresh browser (empty cache) opens the build, and the time to the first playable
// frame is broken down by the page's own marks. `node scripts/load.mjs --url http://127.0.0.1:5374/ [--runs 2]`
import { chromium } from 'playwright';
import { guard } from './no-pointer-lock.mjs';
import { arg, CHROME, CHROME_ARGS, serve } from './lib.mjs';
guard(chromium);
const server = await serve();
const runs = Number(arg('runs', 2));
for (let r = 0; r < runs; r++) {
	// (A new browser each run: nothing cached, no shaders kept)
	const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
	const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
	const errors = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push(e.message));
	await page.addInitScript(() => {
		window.__long = [];
		try {
			new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true });
		} catch {}
	});
	const t0 = Date.now();
	await page.goto(`${server.url}?dpr=1`);
	await page.waitForFunction(() => window.__slice?.ready, null, { timeout: 180000 });
	const wall = Date.now() - t0;
	// The first few frames after ready: is the first second smooth?
	const first = await page.evaluate(() => new Promise((res) => {
		const gaps = [];
		let last = performance.now();
		const tick = () => { const n = performance.now(); gaps.push(+(n - last).toFixed(1)); last = n; if (gaps.length < 90) requestAnimationFrame(tick); else res(gaps); };
		requestAnimationFrame(tick);
	}));
	const out = await page.evaluate(() => {
		const res = performance.getEntriesByType('resource');
		const marks = __slice.marks;
		const steps = marks.map(([name, t], i) => [name, Math.round(t - (i ? marks[i - 1][1] : 0))]);
		return { steps, ready: Math.round(marks[marks.length - 1][1]), files: res.length, bytes: res.reduce((s, e) => s + (e.transferSize || e.encodedBodySize || 0), 0), downloadSpan: Math.round(Math.max(...res.map((e) => e.responseEnd))), long: window.__long.filter((l) => l[1] > 100), build: { ...__slice.slicer.stats } };
	});
	console.log(JSON.stringify({ run: r + 1, readyMs: out.ready, wallMs: wall, mb: +(out.bytes / 1e6).toFixed(1), files: out.files, lastFileAtMs: out.downloadSpan, steps: Object.fromEntries(out.steps), longTasksOver100ms: out.long, firstFramesWorstMs: Math.max(...first.slice(2)), firstFramesOver20: first.slice(2).filter((g) => g > 20).length, built: { solidMs: +out.build.solidMs.toFixed(0), hullMs: +out.build.hullMs.toFixed(0), bodyMs: +out.build.bodyMs.toFixed(0), meshMs: +out.build.meshMs.toFixed(0) } }));
	if (errors.length) console.log('ERRORS', errors.slice(0, 5));
	await browser.close();
}
server.stop();
