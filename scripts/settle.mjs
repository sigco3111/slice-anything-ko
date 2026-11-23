// Leaves the yard alone for a while and reports what moved: nothing should.
import { open, serve } from './lib.mjs';
const server = await serve();
const { browser, page, errors } = await open(server.url, { width: 960, height: 540 });
const out = await page.evaluate(() => {
	const before = new Map(__slice.pieces().map((p) => [p.id, p]));
	const log = [];
	for (let k = 0; k < 6; k++) {
		__slice.step(100);
		const now = __slice.pieces();
		const fast = now.filter((p) => p.speed > 0.03).map((p) => `${p.name}:${p.speed.toFixed(2)}`);
		log.push({ frame: (k + 1) * 100, moving: fast.length, fast: fast.slice(0, 8), awake: now.filter((p) => !p.asleep && !p.fixed).length });
	}
	const drift = __slice.pieces().map((p) => ({ name: p.name, d: Math.hypot(...p.at.map((x, i) => x - before.get(p.id).at[i])) })).filter((x) => x.d > 0.01).map((x) => `${x.name}:${x.d.toFixed(3)}`);
	return { log, drift };
});
console.log(JSON.stringify(out, null, 1));
if (errors.length) console.log('ERRORS', errors.slice(0, 10));
await browser.close();
server.stop();
