import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
const buf = readFileSync(process.argv[2]);
const l = new HDRLoader(); l.setDataType(THREE.FloatType);
const t = l.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const { width: w, height: h, data } = t; const ch = data.length / (w * h);
let best = 0, bx = 0, by = 0; let sum = [0, 0, 0], sx = 0, sy = 0, sw = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * ch; const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]; if (lum > best) { best = lum; bx = x; by = y; } }
// centroid of the brightest region
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * ch; const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]; if (lum > best * 0.2) { sx += x * lum; sy += y * lum; sw += lum; for (let c = 0; c < 3; c++) sum[c] += data[o + c]; } }
const u = (sx / sw + 0.5) / w, v = (sy / sw + 0.5) / h;
// equirect: u = atan2(z, x)/(2π)+0.5 ; v = asin(y)/π + 0.5 (three's equirectUV), image row 0 is the top for this loader (flipY false) 
const phi = (u - 0.5) * 2 * Math.PI, theta = (0.5 - v) * Math.PI;
console.log({ w, h, ch, best, bx, by, u, v, elevationDeg: theta * 180 / Math.PI, dir: [Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)], colour: sum.map((c) => c / Math.max(...sum)), flipY: t.flipY });
// mean sky colour for the upper hemisphere
let m = [0, 0, 0], n = 0; for (let y = 0; y < h / 2; y++) for (let x = 0; x < w; x += 4) { const o = (y * w + x) * ch; const wgt = Math.cos((0.5 - (y + 0.5) / h) * Math.PI); for (let c = 0; c < 3; c++) m[c] += Math.min(data[o + c], 50) * wgt; n += wgt; }
console.log('sky mean', m.map((c) => c / n));
