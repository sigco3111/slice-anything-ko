// Shared by the test scripts: muted Chromium with WebGPU and the pointer-lock guard, a preview server, page helpers.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { guard } from './no-pointer-lock.mjs';
guard(chromium);

// (PATCH_CHROME picks the browser; without it, Playwright's own)
export const CHROME = process.env.PATCH_CHROME || undefined;
export const CHROME_ARGS = ['--mute-audio', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..');

export function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0) return fallback;
	const v = process.argv[i + 1];
	return v === undefined || v.startsWith('--') ? true : v;
}

function freePort() {
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, '127.0.0.1', () => {
			const p = s.address().port;
			s.close(() => res(p));
		});
	});
}

/** Serves dist/ on a free port (or uses --url). */
export async function serve() {
	const given = arg('url');
	if (typeof given === 'string') return { url: given, stop() {} };
	const port = await freePort();
	const child = spawn(process.execPath, [join(here, 'preview.mjs'), join(root, 'dist'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
	await new Promise((res, rej) => {
		child.stdout.on('data', (d) => String(d).includes('http://') && res());
		child.on('exit', (c) => rej(new Error(`preview exited ${c}`)));
	});
	return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}

/** Opens the demo with the clock stepped by hand, and waits until it is ready. */
export async function open(url, { width = 1920, height = 1080, query = '', fixed = true } = {}) {
	const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
	const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
	const errors = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
		else if (process.env.VERBOSE) console.log('page:', m.text());
	});
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
	page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
	await page.goto(`${url}?dpr=1${fixed ? '&clock=fixed' : ''}${query}`);
	await page.waitForFunction(() => window.__slice?.ready, null, { timeout: 120000 }).catch((e) => {
		console.error('not ready:', errors.join('\n'));
		throw e;
	});
	return { browser, page, errors };
}
