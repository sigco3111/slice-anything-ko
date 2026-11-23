// Every shader the renderer builds during load, by phase and by what it was for.
import { chromium } from 'playwright';
import { CHROME, CHROME_ARGS, serve } from './lib.mjs';
const server = await serve();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(server.url + '?builds');
await page.waitForFunction(() => window.__block?.block, null, { timeout: 180000 });
await page.waitForTimeout(1000);
const out = await page.evaluate(() => {
	const marks = Object.fromEntries(window.__block.boot.map(([n, t]) => [n, Math.round(t)]));
	const phase = (t) => (t < marks['set up'] ? 'before' : t < marks.pipelines ? 'compile' : t < marks.warmed ? 'warm' : 'after');
	const count = {};
	for (const [t, type, name, object, ctx] of window.__builds) {
		const k = `${phase(t)} ctx${ctx} ${type}${name ? ':' + name : ''}`;
		count[k] = (count[k] ?? 0) + 1;
	}
	return { marks, total: window.__builds.length, count };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
server.stop();
