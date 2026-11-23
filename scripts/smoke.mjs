// A minute of play on the served build, in real time: every spot, a swing at each, both blades, focus, a thrown
// fruit, reset. Fails on any console error. `node scripts/smoke.mjs --url http://127.0.0.1:5374/`
import { arg, open, serve } from './lib.mjs';
const server = await serve();
const { browser, page, errors } = await open(server.url, { width: 1280, height: 720, fixed: false });
const spots = ['bust', 'mats', 'bamboo', 'pillars', 'table', 'lanterns', 'bell', 'crates', 'post'];
let n = 0;
for (const round of [0, 1]) {
	for (const spot of spots) {
		await page.evaluate(([spot, blade, deg]) => { __slice.blade(blade); __slice.spot(spot); __slice.swing(deg); }, [spot, round, (n++ * 47) % 360]);
		await page.waitForTimeout(900);
		await page.evaluate((deg) => __slice.swing(deg), (n * 31) % 360);
		await page.waitForTimeout(900);
	}
	await page.evaluate(() => { __slice.spot('start'); __slice.focus(true); __slice.throwFruit(); });
	await page.waitForTimeout(2500);
	await page.evaluate(() => { __slice.swing(80); });
	await page.waitForTimeout(1500);
	await page.evaluate(() => { __slice.focus(false); });
	if (round === 0) await page.evaluate(() => __slice.reset());
	await page.waitForTimeout(800);
}
const out = await page.evaluate(() => ({ cuts: __slice.cuts.total, pieces: __slice.pieces().length, fast: __slice.pieces().filter((p) => p.speed > 8).length, low: __slice.pieces().filter((p) => p.at[1] < -1).length, worstCutMs: +__slice.slicer.stats.worstMs.toFixed(1), frames: __slice.frames }));
console.log(JSON.stringify(out));
console.log(errors.length ? `FAIL: ${errors.length} console errors\n${errors.slice(0, 8).join('\n')}` : 'pass smoke');
await browser.close();
server.stop();
process.exit(errors.length ? 1 : 0);
