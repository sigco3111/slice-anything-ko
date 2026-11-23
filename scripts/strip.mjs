// A slow-motion strip of one cut through the statue: focus on, one diagonal swing, eight frames across it.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { arg, open, root, serve } from './lib.mjs';
const out = join(root, 'shots/strip');
mkdirSync(out, { recursive: true });
const server = await serve();
const { browser, page, errors } = await open(server.url, { width: 1920, height: 1080 });
await page.evaluate(() => { __slice.bare(true); __slice.step(60); __slice.spot('bust'); __slice.step(20); __slice.focus(true); __slice.aim(34); __slice.step(40); });
await page.screenshot({ path: join(out, 'f0.png') });
await page.evaluate(() => __slice.swing(34));
// Up to the bite, then on through the head parting
const bite = await page.evaluate(() => { for (let i = 0; i < 80; i++) { __slice.step(1); if (__slice.cuts.total) return i; } return -1; });
await page.evaluate(() => __slice.step(3));
await page.screenshot({ path: join(out, 'f1.png') });
const gaps = [10, 14, 22, 34, 50, 70];
let k = 2;
for (const g of gaps) {
	await page.evaluate((g) => __slice.step(g), g);
	if (k === 4) await page.evaluate(() => __slice.focus(false));
	await page.screenshot({ path: join(out, `f${k++}.png`) });
}
console.log('bite at frame', bite, JSON.stringify(await page.evaluate(() => ({ cuts: __slice.cuts.total, worstCutMs: +__slice.slicer.stats.worstMs.toFixed(1) }))));
if (errors.length) console.log('ERRORS', errors.slice(0, 10));
await browser.close();
server.stop();
const inputs = Array.from({ length: 8 }, (_, i) => ['-i', join(out, `f${i}.png`)]).flat();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${Array.from({ length: 8 }, (_, i) => `[${i}]scale=960:540[s${i}]`).join(';')};${Array.from({ length: 8 }, (_, i) => `[s${i}]`).join('')}xstack=inputs=8:layout=${Array.from({ length: 8 }, (_, i) => `${(i % 4) * 960}_${Math.floor(i / 4) * 540}`).join('|')},format=rgb24`, '-pix_fmt', 'rgb24', join(root, 'shots/statue-cut-strip.png')]);
console.log('wrote shots/statue-cut-strip.png');
