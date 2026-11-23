// Builds the demo into dist/ (index.html at the top) with the files it loads and their licences:
// `npm install`, then `npm run build`.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
execSync('node make-recipe.mjs', { cwd: here, stdio: 'inherit' });
execSync(`node "${path.join(here, 'node_modules/vite/bin/vite.js')}" build --config vite.config.mjs`, { cwd: here, stdio: 'inherit' });
fs.copyFileSync(path.join(here, 'LICENSE'), path.join(dist, 'LICENSE.txt'));

// Rapier 0.19.3's package names its licence (Apache-2.0) but ships no licence file, so the build's notices get a
// heading for it with nothing under it. The text is put there: LICENSES/Apache-2.0-rapier.txt is the LICENSE file
// the same package ships from 0.20.0 on.
const notices = path.join(dist, 'THIRD-PARTY-NOTICES.md');
const heading = /^## @dimforge\/rapier3d-compat - [^\n]*\n/m;
let text = fs.readFileSync(notices, 'utf8');
if (!heading.test(text)) throw new Error('build: no Rapier heading in the notices');
if (!/rapier3d-compat[^#]*Apache License/.test(text)) {
	const licence = fs.readFileSync(path.join(here, 'public/LICENSES/Apache-2.0-rapier.txt'), 'utf8');
	text = text.replace(heading, (h) => `${h}\nCopyright Dimforge (https://github.com/dimforge/rapier.js).\n\n${licence.trimEnd()}\n\n`);
	fs.writeFileSync(notices, text);
}
if (!/rapier3d-compat[\s\S]*Apache License[\s\S]*## three/.test(fs.readFileSync(notices, 'utf8'))) throw new Error('build: the Rapier licence text is not in the notices');

let bytes = 0;
const sizes = {};
const sum = (dir) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) sum(p);
		else {
			const n = fs.statSync(p).size;
			bytes += n;
			const top = path.relative(dist, p).split(path.sep).slice(0, 2).join('/');
			sizes[top] = (sizes[top] ?? 0) + n;
		}
	}
};
sum(dist);
console.log(`dist: ${(bytes / 1048576).toFixed(1)} MB (${Object.entries(sizes).filter(([, n]) => n > 300000).map(([k, n]) => `${k} ${(n / 1048576).toFixed(1)}`).join(', ')})`);
