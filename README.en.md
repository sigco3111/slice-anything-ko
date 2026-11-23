---
kind: system
engine: three.js
---

# Slice anything

Cut any mesh in a three.js scene along any plane, as many times as you like: every piece is a closed solid with its own Rapier body, and every cut face shows what the thing is made of.

![A marble bust cut through by a katana](cover.jpg)

Rings run through a cut post, seeds sit in a melon, veins go through marble, and the two halves of any cut match, because the inside is a solid texture read at each point's place in the uncut object. The demo is first person, with no hands and no rig: a blade, a courtyard at golden hour, and things worth cutting. A drag of the mouse is a swing, and the way you drag is the cut.

This is a place to start from, not a part to drop in. Take the cutter alone, or the whole demo, and bend it: a different blade, your own things, your own insides.

Code MIT. Art CC0 (Poly Haven's bust, blades, sky and surfaces; the rest is built in code). Credits are in `public/CREDITS.md`.

## What this owns

- **Renderer:** WebGPU. `src/demo/main.ts` makes its own `WebGPURenderer` (from `three/webgpu`) on the page's `#view` canvas. Every material is a node material. Without WebGPU three falls back to WebGL 2, which is far less tested here.
- **Frame loop:** It draws the whole frame. `main.ts` starts `renderer.setAnimationLoop`, steps Rapier at a fixed 1/120 s inside it, and ends in its own `RenderPipeline` (scene pass, bloom). Other things go in its `scene`; `window.__slice` hands back the camera, slicer, sword and yard once the demo is ready.
- **three:** `package.json` pins 0.186.1.
- **Rapier:** `@dimforge/rapier3d-compat`, pinned to **0.19.3** on purpose. In 0.21.0 a convex hull never comes to rest on flat ground (a 400 kg prism rocks and walks for good), and every piece here is a convex hull. 0.19 ships no licence file, so `build.mjs` puts Rapier's Apache-2.0 text into the build's notices. Move the pin only after watching cut pieces settle (`node scripts/settle.mjs`).
- **Copy, for the cutter alone:** `src/lib/` (six files, about 1,900 lines). It needs three, a Rapier world you step, and a scene. It makes no renderer and no loop. `cut.ts` and `solid.ts` need nothing but typed arrays and three's triangulation, so they run in Node or a worker.
- **Copy, for the demo:** all of `src/`, `public/`, `index.html`, `recipe.json` and `lib/patch-block.js`, with the `patch-block` alias from `vite.config.mjs`. `main.ts` needs `#view`, `#dot`, `#line`, `#hint`, `#tip` and `#cover` in the page.
- **Elsewhere:** The world is y up, in metres. The sky's `.hdr`, the textures and the models are in Git LFS: run `git lfs pull`, or the loader stops at a pointer file. The demo has no sound.

## Make something sliceable

A sliceable thing is **a mesh, an inside material and a density**. The slicer takes the mesh's geometry and place, closes it if it's open (a scan with no underside), and gives it a body.

```ts
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { Slicer, woodInside } from './src/lib/index.ts';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const slicer = new Slicer(world, RAPIER, scene);

// A post, stood in the ground: the piece that keeps the pin stays put, so a cut leaves a stump
const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2, 0.15), new THREE.MeshStandardNodeMaterial({ color: 0x6b4a2f }));
post.position.set(0, 1, 0);
slicer.add(post, { inside: woodInside(), density: 650, pins: [new THREE.Vector3(0, -0.98, 0)] });

// Cut everything a plane crosses (world space), with a push along the blade's travel
const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0.3, 1, 0).normalize(), new THREE.Vector3(0, 1.2, 0));
slicer.slice(plane, new THREE.Vector3(1.5, 0, 0));

// Each frame
world.step();
slicer.update(dt);

slicer.onCut = ({ parent, pieces, point, area }) => {
	// sparks, a sound, a score: parent.options.kind says what it was
};
```

- `add(mesh, options)`: the mesh's own material (or materials, by group) is the outside, `options.inside` is what cut faces get. Also `pins`, `friction`, `restitution`, `kind` (yours, handed back in `onCut`), `minVolume`, `awake`, `part` and `tumble` (how the two sides part), damping and `inertia`.
- `slice(plane, push, only)` queues a cut of everything the plane crosses, `only` choosing which. `cut(piece, plane, push)` cuts one piece. A blade is a plane and a reach: the demo cuts only what the blade's edge swept through (`sword.onReach` in `main.ts`).
- `link(a, b, point)` joins two pieces, or a piece and the world, with a ball joint that follows whichever piece keeps that point when either is cut. A lantern on a rope falls when the rope is cut, and its top half stays hanging when the lantern is.
- **Insides** are in `src/lib/inside.ts`: marble, stone, wood, bamboo, melon, orange, apple, metal and plain. Your own is any node material that reads `attribute('rest', 'vec3')`, the point's place in the uncut object, in metres.
- `cutPreview` draws a thin line on everything where a plane would cut it (the demo's focus). Wrap a material in `withCutPreview` to have it show the line.
- `cut(solid, normal, constant)` in `src/lib/cut.ts` is the bare cutter: no scene, no physics.
- If you draw between fixed physics steps, call `slicer.beforeStep()` before each `world.step()` and `slicer.update(dt, alpha)` after, as the demo does.

**What a cut does:**

1. Every point of the mesh is put on one side of the plane. A point on the plane counts as just above it, so no triangle is ever cut through a corner.
2. Triangles that cross are split. The new points are shared by both triangles on an edge and by both sides.
3. The cut's outline is chained into loops and triangulated, with holes (a hollow crate, a bamboo stalk), into a cap for each side. Points the triangulation leaves out are put back, so the cap meets the surface at every point.
4. Each side's connected parts become pieces of their own: a cut through a U leaves two on one side.
5. Each piece gets its volume and centre of mass from its own closed surface, a convex hull collider, the parent's motion at its own centre, the blade's push and a little parting speed that light things show and heavy ones don't. Bits under the dust size are dropped.

**Lessons, measured here:**

- **Stage the cut.** Cuts are queued and worked off within `budgetMs` (5) a frame. A big one is itself done in stages: the cut, each new piece's hull and geometry, then the swap in one frame. A 17,000-triangle bust takes three frames of 4 to 8 ms, not one of 20 to 50.
- **Warm every inside before play.** `slicer.warm(point)` puts a tiny cut piece of every set of materials where the camera and the sun see it, and returns a function that removes them. The demo draws real frames through its real passes in between, behind the loading cover. Without it the first cut of each kind of thing froze for 0.15 to 1.3 s while the GPU built that inside's pipeline.
- **Compile for the pass you draw in.** `renderer.compileAsync(scene, camera)` compiles for the canvas, at the top level. A scene pass draws into its own target, one level down inside the picture's own draw, which is another context to the renderer. So `main.ts` sets the pass's render target and hands `compileAsync` the pass's context. Without the target the pipelines were built again at first draw. Without the context all 41 of the scene's shaders were worked out a second time in the first frame (`node scripts/builds.mjs` lists every build).
- **Ask for every pipeline at once.** three 0.186's `compileAsync` waits for each pipeline before it asks for the next, so the GPU builds one at a time. `main.ts` gives it a list of its own to wait on and waits for them all together at the end. The compile step went from 3.0 s to 0.7 s, and with the line above a load from the disk went from 4.3 s to 1.7 s. Both reach into the renderer's private parts (`_pipelines`, `_renderContexts`), so check them when three moves.
- **Feed the GPU in small helpings while loading.** A browser has one graphics process for every page, so a demo that holds it up freezes the page around its frame too. Three things did, for 0.4 to 0.5 s each: every texture sent at once (now one at a time, a GPU fence between), the shadow and bloom shaders all built in the first frame (now a dozen more things shown each warm frame), and the sky's reflection filter, a big shader three builds on the spot at first use (now walked through once with drawing off, to learn what it draws, and compiled ahead). The worst gap on the page while the demo loads went from 500 ms to about 130.
- **Noise from a texture.** The insides read one 64³ tiling texture (`src/lib/noise.ts`), not noise worked out in the shader, and take colours and sizes as uniforms, so materials of one kind share a pipeline. Two dozen shaders build in about 3 s where they took about 10.
- **The `rest` trap.** Because pipelines are shared, every mesh drawn with one of these materials needs its own `rest` attribute, laid out like the pieces' (position, normal, uv, rest). A `rest` that is an alias of the position attribute draws other meshes wrongly.
- **One shell, or it falls apart.** A plinth made of boxes stood on each other is several solids, and a cut lets them slide apart at the joins. Build such things as one closed shell (`stepped()` in `src/demo/yard.ts`).
- **A fixed step.** Slow motion and the instant the blade bites change the frame's time. Stepping Rapier by that time sent the bell flying; a fixed 1/120 s step, drawn between steps, doesn't.
- **A reset you can watch.** Setting the yard out again is a few milliseconds a thing, and all at once it was a frame people saw. `yard.reset()` sets it out over a second, thing by thing, the bust last. It also means Reset always changes the picture, which Patch's test looks for.

## The demo

Click the frame to look around. Drag to slash: the way you drag is the cut. Hold the right mouse button to focus: time slows and the line the blade would cut is drawn on everything in reach, and the wheel turns it. WASD or the arrows to walk, 1 and 2 for the katana and the longsword, F to have a fruit thrown past you, R to put everything back, H to hide the hints.

The block page talks to the demo over the `patch-block` message channel (`lib/patch-block.js`). The controls are defined once, in `make-recipe.mjs`, which writes `recipe.json`:

| Control | What it does |
| --- | --- |
| Blade | Katana or longsword |
| Speed | How fast time runs, down to a tenth |
| Cut line | Draws the cut line on everything in reach |
| Gravity | How hard cut pieces fall |
| Cutting per frame | The slicer's budget, in milliseconds |
| Blade bites | The instant's hold in the first thing the blade meets |
| Camera shake | The shake when it bites |
| Reset | A button: everything back whole, set out over a second |

Test hooks are on `window.__slice`, and `?clock=fixed` hands the clock to them.

## Build and check

```
npm install
npm run build        # recipe.json, patch.json, dist/ with LICENSE.txt and THIRD-PARTY-NOTICES.md
npm run serve        # http://127.0.0.1:5374/
npm run typecheck
```

The scripts run a muted, headless Chromium with the pointer lock faked (`scripts/no-pointer-lock.mjs`), so a test never grabs your mouse. `PATCH_CHROME` picks the browser; without it, Playwright's own.

- `node scripts/fuzz-node.mjs 3000`: the cutter alone on code-built shapes, in Node.
- `node scripts/fuzz.mjs`: every object in the demo, cut at random, every piece checked closed.
- `node scripts/perf.mjs` and `--fps`: a heap of pieces cut at once, and the frame rate with over a hundred pieces down.
- `node scripts/cold.mjs`: a first visit with an empty cache, the CPU slowed four times and a 30 Mbit/s line.
- `node scripts/trace.mjs`: frame times across the first and second cut of each kind of thing.
- `node scripts/builds.mjs` and `pipes.mjs`: every shader and pipeline the load builds, and when.
- `BLOCK_CHECK=<test-block.mjs> node test.mjs`: the block demo check, every control and button driven as Patch's page drives them.

## Known limits

- Static meshes only. Skinned meshes are out of scope.
- Colliders are convex hulls, so a hollow or deeply concave piece collides as its hull.
- A cut plane lying exactly on an existing flat face, to the last bit, can leave a small part of a cap facing inwards. The pieces are still closed. It showed in 26 of about 21,500 pieces of a 27,000-cut run of random planes on code-built shapes; a blade swung by hand doesn't land there.
- The slicer keeps at most `maxPieces` (700; the demo 800) and stops cutting past it.

## Licence

Code: MIT (`LICENSE`). Art: CC0 1.0, every file credited in `public/CREDITS.md`. Libraries' notices are written into the build as `THIRD-PARTY-NOTICES.md`.
