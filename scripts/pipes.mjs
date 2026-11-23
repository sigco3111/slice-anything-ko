// How many shader modules and pipelines the load builds, when, and how many are the same code.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { CHROME, CHROME_ARGS, arg } from './lib.mjs';
const port = 5433 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, ['scripts/preview.mjs', arg('dir', 'dist'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => child.stdout.on('data', (d) => String(d).includes('http://') && res()));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
await page.addInitScript(() => {
	const log = (window.__pipes = { modules: [], pipes: [] });
	const P = GPUDevice.prototype;
	const m = P.createShaderModule;
	P.createShaderModule = function (d) {
		log.modules.push([performance.now(), d.code.length, d.code]);
		return m.call(this, d);
	};
	for (const name of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync']) {
		const f = P[name];
		P[name] = function (d) {
			const t = performance.now();
			const entry = [name, t, 0, d.label ?? '', d.multisample?.count ?? 1, (d.fragment?.targets ?? []).map((x) => x.format).join('+') || 'depth-only', d.depthStencil?.format ?? ''];
			log.pipes.push(entry);
			const r = f.call(this, d);
			if (r?.then) r.then(() => (entry[2] = performance.now() - t));
			return r;
		};
	}
});
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__block?.block, null, { timeout: 180000 });
await page.waitForTimeout(1500);
const out = await page.evaluate(() => {
	const { modules, pipes } = window.__pipes;
	const marks = Object.fromEntries(window.__block.boot.map(([n, t]) => [n, Math.round(t)]));
	const phase = (t) => (t < marks.pipelines ? (t < marks['set up'] ? 'before' : 'compile') : t < marks.warmed ? 'warm' : 'after');
	const count = {};
	for (const p of pipes) {
		const k = `${phase(p[1])} ${p[0]} x${p[4]} ${p[5]} ${p[6]}`;
		count[k] = (count[k] ?? 0) + 1;
	}
	const codes = new Map();
	for (const [t, len, code] of modules) codes.set(code, (codes.get(code) ?? 0) + 1);
	const mphase = {};
	for (const [t] of modules) mphase[phase(t)] = (mphase[phase(t)] ?? 0) + 1;
	const slow = pipes.filter((p) => p[2] > 300).length;
	return { marks, modules: modules.length, uniqueModules: codes.size, modulesByPhase: mphase, chars: modules.reduce((a, m) => a + m[1], 0), pipes: pipes.length, count, slow, longest: Math.max(...pipes.map((p) => p[2])) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
child.kill();
