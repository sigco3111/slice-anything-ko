// Cuts every kind of object in the demo along random planes (pieces of pieces too) and checks each piece:
// closed, no NaNs, caps facing out, volumes adding up. `node scripts/fuzz.mjs [--planes 300]`
import { arg, open, serve } from './lib.mjs';
const server = await serve();
const { browser, page, errors } = await open(server.url, { width: 640, height: 360 });
const report = await page.evaluate((n) => __slice.fuzz(n), Number(arg('planes', 300)));
console.table(report);
let bad = 0;
for (const [k, r] of Object.entries(report)) if (r.open || r.nan || r.openBefore || r.worstVolumeError > 1e-3) { bad++; console.log('FAIL', k, r); }
const flipped = Object.values(report).reduce((s, r) => s + r.flipped, 0), pieces = Object.values(report).reduce((s, r) => s + r.pieces, 0);
console.log(`${Object.keys(report).length} objects, ${pieces} pieces, ${flipped} with part of a cap facing in`);
console.log(bad ? `FAIL: ${bad}` : 'pass fuzz');
if (errors.length) console.log('ERRORS', errors.slice(0, 10));
await browser.close();
server.stop();
process.exit(bad ? 1 : 0);
