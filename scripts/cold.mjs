// A first visit: a new browser profile each time, so the network and shader caches are empty, with the page's CPU and
// the network slowed to a normal laptop's (4x CPU, 30 Mbit/s, 40 ms). Prints how long `ready` took and what the first
// moments after it are like: idle, then a first cut, a thrown fruit, the other blade and a reset straight away.
//
//   node scripts/cold.mjs [--url <url>] [--runs 1] [--cpu 4] [--idle-only]
//
// Muted, headless Chromium with WebGPU and the pointer-lock guard.
import { chromium } from 'playwright';
import { CHROME, CHROME_ARGS, arg, serve } from './lib.mjs';

const server = await serve();
const cpu = Number(arg('cpu', 4));
for (let run = 1; run <= Number(arg('runs', 1)); run++) {
	const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
	const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
	await page.addInitScript(() => {
		const frames = { last: 0, slow: [] };
		window.__frames = frames;
		const tick = (now) => {
			if (frames.last && now - frames.last > 50) frames.slow.push(Math.round(now - frames.last) + '@' + (now / 1000).toFixed(2));
			frames.last = now;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	const cdp = await context.newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 30e6 / 8, uploadThroughput: 10e6 / 8 });
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
	const started = Date.now();
	await page.goto(server.url);
	await page.waitForFunction(() => window.__block?.block, null, { timeout: 180000, polling: 50 });
	const ready = (Date.now() - started) / 1000;
	const slowSince = () => page.evaluate(() => window.__frames.slow.splice(0));
	await slowSince();
	await page.waitForTimeout(arg('idle-only') ? 500 : 3000);
	const afterReady = await slowSince();
	const boot = await page.evaluate(() => window.__block.boot ?? null);
	const steps = {};
	if (!arg('idle-only')) {
		const tries = [
			['first cut', () => page.evaluate(() => (window.__slice.spot('bust'), window.__slice.swing(20)))],
			['second cut', () => page.evaluate(() => window.__slice.swing(-35))],
			['throw', () => page.keyboard.press('KeyF')],
			['longsword', () => page.keyboard.press('Digit2')],
			['reset', () => page.keyboard.press('KeyR')],
		];
		await page.mouse.click(640, 360);
		for (const [name, go] of tries) {
			await go();
			await page.waitForTimeout(1800);
			steps[name] = await slowSince();
		}
	}
	console.log(JSON.stringify({ run, ready: Number(ready.toFixed(1)), boot, afterReady, steps, errors: errors.slice(0, 5) }));
	await browser.close();
}
server.stop();
