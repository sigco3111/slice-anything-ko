// The demo's build: index.html at the top of dist, every path relative, nothing from other hosts.
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default {
	root: here,
	base: './',
	publicDir: 'public',
	resolve: {
		alias: [{ find: /^patch-block$/, replacement: fileURLToPath(new URL('./lib/patch-block.js', import.meta.url)) }],
		dedupe: ['three'],
	},
	server: { host: '127.0.0.1' },
	// (license: every npm library's notice goes in THIRD-PARTY-NOTICES.md; build.mjs adds the one text a package doesn't ship)
	build: { target: 'es2022', outDir: `${here}dist`, emptyOutDir: true, chunkSizeWarningLimit: 6000, modulePreload: { polyfill: false }, license: { fileName: 'THIRD-PARTY-NOTICES.md' } },
};
