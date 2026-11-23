// One swing at each kind of thing, three frames each (the bite, a moment after, settled), on one sheet.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { arg, open, root, serve } from './lib.mjs';
const out = join(root, 'shots/tour');
mkdirSync(out, { recursive: true });
const server = await serve();
const { browser, page, errors } = await open(server.url, { width: 960, height: 540 });
const stops = [['bust', 15, 0], ['mats', -30, 0], ['bamboo', 20, 0], ['pillars', -25, 1], ['table', 5, 0], ['lanterns', 60, 0], ['bell', -10, 1], ['crates', 40, 1], ['post', 30, 1]];
const rows = [];
for (const [spot, deg, blade] of stops) {
	await page.evaluate(([spot, blade]) => { __slice.bare(true); __slice.reset(); __slice.step(40); __slice.blade(blade); __slice.spot(spot); __slice.step(10); }, [spot, blade]);
	await page.evaluate((deg) => __slice.swing(deg), deg);
	// Step to the bite: the first frame a cut is made
	const bite = await page.evaluate(() => { for (let i = 0; i < 40; i++) { __slice.step(1); if (__slice.cuts.total) return i; } return -1; });
	await page.evaluate(() => __slice.step(1));
	await page.screenshot({ path: join(out, `${spot}-a.png`) });
	await page.evaluate(() => __slice.step(22));
	await page.screenshot({ path: join(out, `${spot}-b.png`) });
	await page.evaluate(() => __slice.step(110));
	await page.screenshot({ path: join(out, `${spot}-c.png`) });
	const info = await page.evaluate(() => ({ cuts: __slice.cuts.total, worstMs: +__slice.slicer.stats.worstMs.toFixed(1), fast: __slice.pieces().filter((p) => p.speed > 4).length, pieces: __slice.pieces().length }));
	console.log(spot, 'bite at frame', bite, JSON.stringify(info));
	await page.evaluate(() => { __slice.cuts.total = 0; __slice.slicer.stats.worstMs = 0; });
	rows.push(spot);
}
if (errors.length) console.log('ERRORS', errors.slice(0, 10));
await browser.close();
server.stop();
const inputs = rows.flatMap((s) => ['a', 'b', 'c'].flatMap((k) => ['-i', join(out, `${s}-${k}.png`)]));
const n = rows.length * 3;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${Array.from({ length: n }, (_, i) => `[${i}]scale=640:360[s${i}]`).join(';')};${Array.from({ length: n }, (_, i) => `[s${i}]`).join('')}xstack=inputs=${n}:layout=${Array.from({ length: n }, (_, i) => `${(i % 3) * 640}_${Math.floor(i / 3) * 360}`).join('|')},format=rgb24`, '-pix_fmt', 'rgb24', join(out, 'sheet.png')]);
