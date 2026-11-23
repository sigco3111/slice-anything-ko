// Stills of the yard from the named spots: `node scripts/look.mjs [--out shots/look] [--spots start,bust]`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { arg, open, root, serve } from './lib.mjs';
const out = join(root, arg('out', 'shots/look'));
mkdirSync(out, { recursive: true });
const server = await serve();
const { browser, page, errors } = await open(server.url, { width: Number(arg('w', 1920)), height: Number(arg('h', 1080)), query: arg('query', '') });
const spots = String(arg('spots', 'start,bust,mats,bamboo,pillars,table,lanterns,bell,crates')).split(',');
await page.evaluate(() => { __slice.bare(true); __slice.step(90); });
for (const s of spots) {
	// (A spot by name, or x:z:yaw:pitch)
	if (s.includes(':')) await page.evaluate((v) => { __slice.stand(v[0], v[1], v[2], v[3] ?? 0); __slice.step(3); }, s.split(':').map(Number));
	else await page.evaluate((s) => { __slice.spot(s); __slice.step(3); }, s);
	await page.screenshot({ path: join(out, `${s.replace(/[:.]/g, '_')}.png`) });
}
console.log(JSON.stringify(await page.evaluate(() => ({ pieces: __slice.pieces().length, moving: __slice.pieces().filter((p) => p.speed > 0.05 && !p.fixed).map((p) => [p.name, +p.speed.toFixed(2), p.at.map((x) => +x.toFixed(2))]) }))));
if (errors.length) console.log('ERRORS', errors.slice(0, 12));
await browser.close();
server.stop();
