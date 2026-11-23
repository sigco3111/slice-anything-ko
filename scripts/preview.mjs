// Serves a built folder: `node scripts/preview.mjs dist 5374`.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 5374);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg' };
createServer(async (req, res) => {
	try {
		let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		if (path.endsWith('/')) path += 'index.html';
		const file = normalize(join(root, path));
		if (!file.startsWith(root)) throw new Error('outside');
		await stat(file);
		res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
		res.end(await readFile(file));
	} catch {
		res.writeHead(404);
		res.end('not found');
	}
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
