// The block demo check: the built demo in a frame, driven the way Patch's block page drives it (hello, every
// control through its values, every trigger, visible off and on), with a picture taken after each step.
// Build first (`npm run build`). It uses a shared checker: BLOCK_CHECK=<path to test-block.mjs> node test.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.BLOCK_CHECK) throw new Error('BLOCK_CHECK must point at the block checker (test-block.mjs)');
// (The checker empties the folder it writes its pictures to: it gets one of its own, never shots/)
process.env.BLOCK_SHOTS ??= path.join(here, 'check');
const { testBlock } = await import(pathToFileURL(process.env.BLOCK_CHECK).href);
const still = 'changes how things move or how cuts are worked off, not the picture at rest';
const report = await testBlock({
	dir: here,
	name: 'slice anything',
	port: 4931,
	loadTimeout: 90000,
	settle: 700,
	waits: { 'trigger:reset': 900, 'set:blade': 900 },
	mayStayStill: { 'set:speed': still, 'set:gravity': still, 'set:budget': still, 'set:hold': still, 'set:shake': still, 'set:line': 'the line is drawn on things in reach, and nothing is in reach from where the demo starts' },
});
console.log(JSON.stringify(report.summary ?? report, null, 1).slice(0, 2500));
