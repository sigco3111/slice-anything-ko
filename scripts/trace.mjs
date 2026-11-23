// Frame times across the first and second cut of each kind of thing, in real time on the build as served.
// For every swing: the worst gap between frames, how many gaps were over 20 ms, the worst frame's own work, and
// what the slicer spent (cutting, hulls, bodies, meshes). Run it under the GPU lock.
// `node scripts/trace.mjs --url http://127.0.0.1:5374/ [--out work/trace.json]`
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { guard } from './no-pointer-lock.mjs';
import { arg, CHROME, CHROME_ARGS, serve } from './lib.mjs';
guard(chromium);
const server = await serve();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${server.url}?dpr=1`);
await page.waitForFunction(() => window.__slice?.ready, null, { timeout: 180000 });
await page.evaluate(() => __slice.bare(true));
await page.waitForTimeout(1500);
// spot, blade, two swing directions (the second cuts what the first left, or its neighbour of the same kind)
const stops = [['bust', 0, 30, -20, 'marble'], ['pillars', 0, -25, 20, 'stone'], ['mats', 0, -30, 25, 'straw'], ['post', 0, 30, -25, 'wood'], ['bamboo', 0, 20, -15, 'bamboo'], ['table', 0, 5, 50, 'fruit'], ['lanterns', 0, 60, 10, 'paper'], ['bell', 1, -10, 25, 'metal'], ['crates', 1, 40, -30, 'crate wood']];
const rows = [];
const swing = async (deg, focus) => {
	const before = await page.evaluate(([deg, focus]) => {
		const s = __slice;
		const st = s.slicer.stats;
		const b = { cuts: s.cuts.total, cut: st.cutMs, hull: st.hullMs, body: st.bodyMs, mesh: st.meshMs };
		if (focus) s.focus(true);
		s.trace = [];
		s.swing(deg);
		return b;
	}, [deg, focus]);
	await page.waitForTimeout(focus ? 2200 : 1300);
	return page.evaluate((b) => {
		const s = __slice;
		const t = s.trace;
		s.trace = null;
		s.focus(false);
		const st = s.slicer.stats;
		const gaps = t.map((f) => f[0]);
		const worst = Math.max(...gaps);
		const at = gaps.indexOf(worst);
		// The frame a cut first shows in, and the worst gap within 12 frames either side of it
		const first = t.findIndex((f, i) => i > 0 && f[2] > t[i - 1][2]);
		const near = first < 0 ? [] : gaps.slice(Math.max(0, first - 12), first + 13);
		return { cuts: s.cuts.total - b.cuts, frames: t.length, worstGap: worst, worstAtFrame: at, cutShowsAtFrame: first, worstNearCut: near.length ? Math.max(...near) : null, over20: gaps.filter((g) => g > 20).length, worstOwnWork: Math.max(...t.map((f) => f[1])), worstCuttingInAFrame: Math.max(...t.map((f) => f[3])), hitStopFrames: t.filter((f) => f[4]).length, slicer: { cut: +(st.cutMs - b.cut).toFixed(1), hull: +(st.hullMs - b.hull).toFixed(1), body: +(st.bodyMs - b.body).toFixed(1), mesh: +(st.meshMs - b.mesh).toFixed(1) }, aroundCut: first < 0 ? [] : t.slice(Math.max(0, first - 3), first + 5).map((f) => `${f[0]}/${f[1]}${f[4] ? 's' : ''}`) };
	}, before);
};
for (const [spot, blade, a, b, label] of stops) {
	await page.evaluate(([spot, blade]) => { __slice.blade(blade); __slice.spot(spot); }, [spot, blade]);
	await page.waitForTimeout(700);
	const one = await swing(a, false);
	await page.waitForTimeout(500);
	const two = await swing(b, false);
	rows.push({ kind: label, first: one, second: two });
	console.log(label.padEnd(11), 'first: worst gap', String(one.worstGap).padStart(6), 'ms, over 20 ms:', one.over20, '| own work', one.worstOwnWork, '| cutting', one.worstCuttingInAFrame, '| hit-stop frames', one.hitStopFrames, '| around the cut', one.aroundCut.join(' '), '\n           second: worst gap', String(two.worstGap).padStart(6), 'ms, over 20 ms:', two.over20, '| own work', two.worstOwnWork, '| cutting', two.worstCuttingInAFrame, '| slicer', JSON.stringify(one.slicer));
}
// Focus: entering it, then a cut in it
await page.evaluate(() => { __slice.reset(); __slice.blade(0); __slice.spot('bust'); });
await page.waitForTimeout(800);
const enter = await page.evaluate(() => new Promise((res) => { __slice.trace = []; __slice.focus(true); setTimeout(() => { const g = __slice.trace.map((f) => f[0]); __slice.trace = null; res({ worstGap: Math.max(...g), over20: g.filter((x) => x > 20).length }); }, 900); }));
const inFocus = await swing(30, true);
console.log('focus       entering: worst gap', enter.worstGap, 'ms, over 20 ms:', enter.over20, '| cut in focus: worst gap', inFocus.worstGap, 'over 20 ms:', inFocus.over20, 'around the cut', inFocus.aroundCut.join(' '));
// A thrown fruit, cut in the air
const out = arg('out');
if (typeof out === 'string') writeFileSync(out, JSON.stringify({ rows, enter, inFocus }, null, 1));
if (errors.length) console.log('ERRORS', errors.slice(0, 5));
await browser.close();
server.stop();
