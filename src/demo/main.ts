// Slice anything, the demo: a courtyard at golden hour, a blade, and things worth cutting.
// On Patch's block page it is steered through Patch's block demo helper (lib/patch-block.js): the page draws the
// controls in recipe.json (made by make-recipe.mjs) and this file answers them.
import * as THREE from 'three/webgpu';
import { builtinAOContext, float, length, mix, mrt, normalView, pass, screenUV, smoothstep, uniform, vec3 } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { patchBlock } from 'patch-block';
import { block as recipeBlock } from '../../recipe.json';
import { cutPreview } from '../lib/inside.ts';
import { cut as cutSolid } from '../lib/cut.ts';
import { measure, openEdges } from '../lib/solid.ts';
import { Slicer, type Piece } from '../lib/slicer.ts';
import { Fx } from './fx.ts';
import { BLADES, Sword, type Reach } from './sword.ts';
import { buildYard, SUN } from './yard.ts';
import { loaded as loadedTextures } from './materials.ts';
import { mark, marks } from './marks.ts';
import { installPanel } from './panel.ts';

const params = new URLSearchParams(location.search);
const fixedClock = params.get('clock') === 'fixed';
const $ = (id: string) => document.getElementById(id)!;

type Value = number | boolean | string;

async function boot() {
	mark('script');
	// The page is answered at once, before anything heavy: every control's value is kept here, in step from onSet
	const values: Record<string, Value> = {};
	const live: { set: (id: string, value: Value) => void; trigger: (id: string) => void } = { set() {}, trigger() {} };
	let visible = true;
	const block = patchBlock({
		...recipeBlock,
		onSet(id: string, value: Value) {
			values[id] = value;
			live.set(id, value);
		},
		onTrigger(id: string) {
			live.trigger(id);
		},
		onVisible(on: boolean) {
			visible = on;
		},
	});
	Object.assign(values, block.values);
	const progress = (share: number, words: string) => {
		block.progress(share, words);
		const el = document.getElementById('prog');
		if (el) el.textContent = words ?? '';
	};
	progress(0.03, '불러오는 중');
	await RAPIER.init();
	mark('physics');
	const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
	world.numSolverIterations = 8;
	// Physics runs at a fixed step whatever the frame rate or the slow motion, and is drawn between steps
	const STEP = 1 / 120;
	world.timestep = STEP;
	let owed = 0;

	const canvas = $('view') as HTMLCanvasElement;
	const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: params.has('webgl') });
	await renderer.init();
	mark('renderer');
	progress(0.1, '마당 불러오는 중');
	renderer.setPixelRatio(Math.min(devicePixelRatio, Number(params.get('dpr') ?? 1.5)));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = Number(params.get('exposure') ?? 1.12);

	// (?builds lists every shader the renderer builds, and when: scripts/builds.mjs)
	if (params.has('builds')) {
		const builds: unknown[] = ((window as unknown as { __builds: unknown[] }).__builds = []);
		(renderer.debug as unknown as { onNodeBuilderCreated: (b: unknown, o: { material: THREE.Material; object: THREE.Object3D; context: { id: number }; initialCacheKey: number }) => void }).onNodeBuilderCreated = (_b, o) => builds.push([Math.round(performance.now()), o.material.type, o.material.name, o.object.name || o.object.type, o.context?.id]);
	}
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(72, 1, 0.03, 300);
	scene.add(camera);
	const slicer = new Slicer(world, RAPIER, scene, { maxPieces: 800 });
	// (The blades come down the wire while the yard is built, not after it)
	const sword = new Sword(camera, scene);
	const blades = sword.load();
	const yard = await buildYard(scene, world, RAPIER, slicer, params);
	mark('yard');
	await blades;
	mark('blades');
	progress(0.35, '셰이더 만드는 중');
	const fx = new Fx(scene);
	fx.motes(70, new THREE.Box3(new THREE.Vector3(-6, 0.3, -5), new THREE.Vector3(6, 3, 5)));

	// The picture: the scene, a little bloom, a vignette, and in focus a cooler, quieter grade
	const focusAmount = uniform(0);
	const pipeline = new THREE.RenderPipeline(renderer);
	const scenePass = pass(scene, camera);
	if (params.get('ao') === '1') {
		// Ambient occlusion, from a first pass of normals and depth: things sit on the ground and in their corners
		const first = pass(scene, camera, { samples: 0 });
		first.setMRT(mrt({ output: normalView }));
		const occlusion = ao(first.getTextureNode('depth'), first.getTextureNode(), camera);
		occlusion.resolutionScale = 0.5;
		occlusion.radius.value = 0.45;
		occlusion.thickness.value = 0.6;
		occlusion.scale.value = 1.15;
		scenePass.contextNode = builtinAOContext(occlusion.getTextureNode().sample(screenUV).r);
	}
	const colour = scenePass.getTextureNode('output');
	const lit = colour.add(bloom(colour, 0.13, 0.5, 1.5));
	const grey = lit.r.mul(0.3).add(lit.g.mul(0.55)).add(lit.b.mul(0.15));
	const quiet = mix(lit.rgb, vec3(grey, grey, grey).mul(vec3(0.95, 0.98, 1.05)), focusAmount.mul(0.28));
	const edge = smoothstep(0.38, 0.86, length(screenUV.sub(0.5)));
	pipeline.outputNode = quiet.mul(float(1).sub(edge.mul(focusAmount.mul(0.5).add(0.28))));

	// The player: a capsule walked about by Rapier's character controller
	const EYE = 0.74;
	const player = {
		body: world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.9, 5)),
		at: new THREE.Vector3(0, 0.9, 5),
		/** Set by a test script to walk the player at this velocity (m/s) in place of the keys. */
		drive: null as THREE.Vector3 | null,
		yaw: 0,
		pitch: 0,
		vy: 0,
		speed: 0,
		grounded: true,
	};
	const playerCollider = world.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.275), player.body);
	const walker = world.createCharacterController(0.02);
	walker.enableAutostep(0.25, 0.15, true);
	walker.enableSnapToGround(0.25);
	walker.setApplyImpulsesToDynamicBodies(true);
	walker.setCharacterMass(70);

	// Input
	const keys = new Set<string>();
	const look = new THREE.Vector2();
	const stroke = { down: false, x: 0, y: 0, fired: false };
	let focus = false;
	let focusBlend = 0;
	let started = false;
	let hitStop = 0;
	let trauma = 0;
	let bot: null | ((dt: number) => void) = null;
	const swingCut = new Map<number, THREE.Vector3>();
	let swingHits = 0;

	const targetDistance = (): number => {
		const origin = camera.getWorldPosition(new THREE.Vector3());
		const dir = camera.getWorldDirection(new THREE.Vector3());
		const hit = world.castRay(new RAPIER.Ray(origin, dir), sword.reach, true, undefined, undefined, playerCollider);
		return THREE.MathUtils.clamp(hit ? hit.timeOfImpact + 0.04 : sword.reach * 0.8, 0.55, sword.reach - 0.08);
	};
	const fire = (theta?: number) => {
		if (!sword.swing(targetDistance(), theta)) return false;
		swingCut.clear();
		swingHits = 0;
		return true;
	};
	const release = () => {
		if (!stroke.down) return;
		stroke.down = false;
		if (stroke.fired) return;
		const far = Math.hypot(stroke.x, stroke.y);
		fire(far > 14 ? Math.atan2(-stroke.y, stroke.x) : undefined);
	};
	canvas.addEventListener('click', () => {
		if (document.pointerLockElement !== canvas) canvas.requestPointerLock()?.catch?.(() => {});
	});
	document.addEventListener('pointerlockchange', () => {
		const locked = document.pointerLockElement === canvas;
		$('hint').classList.toggle('hidden', locked);
		if (locked) started = true;
		else {
			keys.clear();
			focus = false;
			stroke.down = false;
		}
	});
	canvas.addEventListener('mousedown', (e) => {
		if (document.pointerLockElement !== canvas) return;
		if (e.button === 0) {
			stroke.down = true;
			stroke.fired = false;
			stroke.x = stroke.y = 0;
		} else if (e.button === 2) focus = true;
	});
	window.addEventListener('mouseup', (e) => {
		if (e.button === 0) release();
		else if (e.button === 2) focus = false;
	});
	canvas.addEventListener('contextmenu', (e) => e.preventDefault());
	window.addEventListener('mousemove', (e) => {
		if (document.pointerLockElement !== canvas) return;
		if (stroke.down && !stroke.fired) {
			// The drag is the cut: its direction on screen is the blade's
			stroke.x += e.movementX;
			stroke.y += e.movementY;
			const far = Math.hypot(stroke.x, stroke.y);
			if (far > 10) sword.theta = Math.atan2(-stroke.y, stroke.x);
			if (far > 110 && !focus) {
				stroke.fired = true;
				fire(sword.theta);
			}
			return;
		}
		const k = 0.0022 * (focus ? 0.45 : 1);
		player.yaw -= e.movementX * k;
		player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * k, -1.45, 1.45);
		look.x += e.movementX * k;
		look.y += e.movementY * k;
	});
	window.addEventListener('wheel', (e) => {
		if (focus) sword.theta += Math.sign(e.deltaY) * (Math.PI / 12);
	});
	window.addEventListener('keydown', (e) => {
		keys.add(e.code);
		if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
		if (e.repeat) return;
		if (e.code === 'Digit1' || e.code === 'Digit2') {
			const blade = e.code === 'Digit1' ? 'katana' : 'longsword';
			values.blade = blade;
			live.set('blade', blade);
			block.state({ blade });
		} else if (e.code === 'KeyR') live.trigger('reset');
		else if (e.code === 'KeyF') live.trigger('throw');
		else if (e.code === 'KeyH') document.body.classList.toggle('bare');
	});
	window.addEventListener('keyup', (e) => keys.delete(e.code));
	window.addEventListener('blur', () => keys.clear());
	const throwFruit = () => yard.throwFruit(camera.getWorldPosition(new THREE.Vector3()), camera.getWorldDirection(new THREE.Vector3()));

	// What Patch's page (or a key) asks for
	let wantBlade: number | null = null;
	const START = { x: 0, z: 5 };
	live.set = (id, value) => {
		if (id === 'blade') wantBlade = value === 'longsword' ? 1 : 0;
		else if (id === 'gravity') world.gravity = { x: 0, y: -Number(value), z: 0 };
		else if (id === 'budget') slicer.budgetMs = Number(value);
	};
	live.trigger = (id) => {
		if (id === 'throw') throwFruit();
		else if (id === 'reset') {
			yard.reset();
			// You too: back where you started, the blade coming up to the ready
			player.at.set(START.x, 0.9, START.z);
			player.body.setTranslation(player.at, true);
			player.yaw = player.pitch = player.vy = 0;
			sword.raise();
		}
	};
	for (const [id, value] of Object.entries(values)) live.set(id, value);

	// Alone on a static host (not inside Patch's block page) there is no page to draw the recipe's controls,
	// so a Korean panel renders them here and answers them the same way.
	if (window.parent === window) {
		const panel = installPanel({
			controls: recipeBlock.controls ?? [],
			triggers: recipeBlock.triggers ?? [],
			values,
			set: (id, value) => {
				values[id] = value;
				live.set(id, value);
				block.state({ [id]: value });
			},
			trigger: (id) => live.trigger(id),
		});
		const innerSet = live.set;
		live.set = (id, value) => {
			innerSet(id, value);
			panel.sync(id);
		};
	}

	// What the blade does to what it meets
	// How long the blade is held where it bites, as a share of the blade's own pause: three frames at most for the
	// katana (52 ms in stone), four for the longsword (68 ms)
	const HARD: Record<string, number> = { stone: 1.3, metal: 1.3, wood: 1, straw: 0.75, bamboo: 0.7, fruit: 0.45, lantern: 0.3, rope: 0.15 };
	const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
	sword.onReach = (reach: Reach) => {
		// The edge's sweep this frame, as rays from the hand out along the blade: whatever one meets is cut on the
		// blade's plane. The first thing met holds the blade for an instant, part-way into it.
		const steps = Math.max(1, Math.ceil((reach.to - reach.from) / 0.02));
		let hold: number | undefined;
		for (let i = 1; i <= steps && hold === undefined; i++) {
			const phi = reach.from + ((reach.to - reach.from) * i) / steps;
			const dir = reach.a.clone().multiplyScalar(Math.cos(phi)).addScaledVector(reach.b, Math.sin(phi));
			ray.origin = reach.pivot.clone().addScaledVector(dir, reach.near);
			ray.dir = dir;
			world.intersectionsWithRay(ray, reach.far - reach.near, true, (hit) => {
				const piece = slicer.byCollider.get(hit.collider.handle);
				if (!piece || swingCut.has(piece.id)) return true;
				const travel = reach.travel(phi);
				swingCut.set(piece.id, travel);
				if (slicer.cut(piece, reach.plane, travel.clone().multiplyScalar(sword.blade.push))) {
					const hard = HARD[piece.options.kind ?? 'wood'] ?? 1;
					if (!swingHits) {
						// Held at the middle of what it met (or a little way in, if that is far round)
						const rel = piece.mesh.position.clone().sub(reach.pivot);
						const middle = Math.atan2(rel.dot(reach.b), rel.dot(reach.a));
						hold = THREE.MathUtils.clamp(middle, phi, phi + 0.3);
					}
					// (Only the first thing a swing meets holds the blade: a second pause mid-swing reads as a stutter)
					if (!swingHits && values.hold !== false) hitStop = sword.blade.stop * hard;
					if (values.shake !== false) trauma = Math.min(1, trauma + sword.blade.shake * 0.22 * hard);
					swingHits++;
				}
				return true;
			}, undefined, undefined, playerCollider);
		}
		return hold;
	};
	const JUICE: Record<string, [number, number, number][]> = { melon: [[0.85, 0.08, 0.1], [0.95, 0.3, 0.3]], orange: [[1, 0.55, 0.08], [1, 0.75, 0.3]], apple: [[0.95, 0.93, 0.8], [0.8, 0.85, 0.6]] };
	const cuts = { total: 0, last: [] as Piece[] };
	slicer.onCut = (e) => {
		cuts.total++;
		cuts.last = e.pieces;
		const travel = swingCut.get(e.parent.id) ?? new THREE.Vector3(0, 0, 0);
		for (const p of e.pieces) swingCut.set(p.id, travel);
		const kind = e.parent.options.kind ?? 'wood';
		fx.burst(kind, e.point, e.plane.normal, travel, Math.sqrt(e.area) * 3, Math.min(0.2, e.parent.radius * 0.5), JUICE[e.parent.mesh.name]);
		for (const d of e.dust) fx.burst(kind, d, e.plane.normal, travel, 0.1, 0.01, JUICE[e.parent.mesh.name]);
		yard.cut(e.parent);
	};

	const resize = () => {
		const w = canvas.clientWidth || innerWidth;
		const h = canvas.clientHeight || innerHeight;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	};
	window.addEventListener('resize', resize);
	resize();

	const forward = new THREE.Vector3();
	const right = new THREE.Vector3();
	let shakeT = 0;
	let frames = 0;
	let simTime = 0;

	const frame = (real: number) => {
		real = Math.min(real, 0.1);
		frames++;
		bot?.(real);
		// Time: focus slows the world to a crawl and the blade to half; a bite stops both for an instant
		focusBlend += ((focus ? 1 : 0) - focusBlend) * Math.min(1, real * 9);
		const stopped = hitStop > 0;
		hitStop = Math.max(0, hitStop - real);
		// (The Speed control slows the world; the blade slows less, as it does in focus)
		const speed = THREE.MathUtils.clamp(Number(values.speed ?? 1), 0.05, 1);
		const worldDt = real * speed * THREE.MathUtils.lerp(1, 0.1, focusBlend) * (stopped ? 0.03 : 1);
		const swordDt = real * Math.sqrt(speed) * THREE.MathUtils.lerp(1, 0.5, focusBlend) * (stopped ? 0.04 : 1);
		if (wantBlade !== null && sword.phase === 'rest') {
			if (wantBlade !== sword.index) {
				sword.select(wantBlade);
				sword.raise();
			}
			wantBlade = null;
		}
		simTime += worldDt;

		// Walking
		forward.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
		right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
		const move = new THREE.Vector3();
		if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward);
		if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward);
		// (The arrows turn, for anyone without the mouse in the frame)
		if (keys.has('ArrowLeft')) player.yaw += real * 1.8;
		if (keys.has('ArrowRight')) player.yaw -= real * 1.8;
		if (keys.has('KeyD')) move.add(right);
		if (keys.has('KeyA')) move.sub(right);
		const pace = (keys.has('ShiftLeft') ? 5 : 3.1) * (stroke.down ? 0.5 : 1);
		if (move.lengthSq()) move.normalize().multiplyScalar(pace);
		if (player.drive) move.copy(player.drive);
		// (The player keeps most of their own pace in focus: slowed, not stuck)
		const moveDt = real * THREE.MathUtils.lerp(1, 0.35, focusBlend);
		if (player.grounded && keys.has('Space')) player.vy = 4.2;
		player.vy -= 9.81 * 1.6 * moveDt;
		const want = { x: move.x * moveDt, y: player.vy * moveDt, z: move.z * moveDt };
		// (The player moves every frame, physics step or not: the capsule is put where they are before it is asked)
		player.body.setTranslation(player.at, false);
		world.propagateModifiedBodyPositionsToColliders();
		walker.computeColliderMovement(playerCollider, want);
		const got = walker.computedMovement();
		player.grounded = walker.computedGrounded();
		if (player.grounded && player.vy < 0) player.vy = 0;
		player.at.x += got.x;
		player.at.y += got.y;
		player.at.z += got.z;
		player.body.setNextKinematicTranslation(player.at);
		player.speed += (Math.min(1, Math.hypot(got.x, got.z) / Math.max(1e-5, moveDt) / 3.1) - player.speed) * Math.min(1, real * 10);

		owed += worldDt;
		let steps = 0;
		for (; owed >= STEP && steps < 8; steps++) {
			slicer.beforeStep();
			world.step();
			owed -= STEP;
		}
		if (steps === 8) owed = 0;
		const p = player.at;
		// A shake that dies fast: a couple of degrees at most
		trauma = Math.max(0, trauma - real * 2.8);
		shakeT += real * 38;
		const shake = trauma * trauma;
		camera.position.set(p.x, p.y + EYE, p.z);
		camera.rotation.set(player.pitch + Math.sin(shakeT * 1.3) * 0.02 * shake, player.yaw + Math.sin(shakeT) * 0.022 * shake, Math.sin(shakeT * 0.7) * 0.015 * shake, 'YXZ');
		camera.fov = THREE.MathUtils.lerp(72, 64, focusBlend);
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld();

		sword.update(swordDt, real, camera, look, player.speed);
		look.set(0, 0);
		slicer.update(worldDt, owed / STEP);
		yard.update(real);
		fx.update(worldDt, camera);

		// In focus, the line the blade would cut is drawn on everything in reach
		const showing = focus || values.line === true || (stroke.down && !stroke.fired && Math.hypot(stroke.x, stroke.y) > 10);
		cutPreview.strength.value += ((showing ? 1 : 0) - cutPreview.strength.value) * Math.min(1, real * 14);
		if (cutPreview.strength.value > 0.01) {
			const plane = sword.preview(camera, targetDistance());
			cutPreview.plane.value.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
			camera.getWorldPosition(cutPreview.centre.value);
			cutPreview.reach.value = sword.reach + 0.25;
		}
		focusAmount.value = focusBlend;
		$('line').style.opacity = String(Math.min(1, cutPreview.strength.value * (focus ? 0.5 : 0.9)));
		$('line').style.transform = `translate(-50%, -50%) rotate(${-sword.theta}rad)`;
		// (A scene pass draws once a frame; stepped by hand, several frames can share one task, so each starts its own)
		if (fixedClock) (renderer as unknown as { _nodes: { nodeFrame: { update(): void } } })._nodes.nodeFrame.update();
		pipeline.render();
	};

	// Test hooks: step the clock by hand, stand in named spots, swing along an angle, and check the cutter itself
	const api = {
		ready: false,
		marks,
		trace: null as null | unknown[][],
		slicer,
		sword,
		yard,
		player,
		cuts,
		get frames() {
			return frames;
		},
		get simTime() {
			return simTime;
		},
		step(n = 1, dt = 1 / 60) {
			for (let i = 0; i < n; i++) frame(dt);
		},
		stand(x: number, z: number, yaw = 0, pitch = 0) {
			player.at.set(x, 0.9, z);
			player.body.setTranslation(player.at, true);
			player.body.setNextKinematicTranslation(player.at);
			player.yaw = yaw;
			player.pitch = pitch;
			player.vy = 0;
		},
		spot(name: string, pitch?: number) {
			const s = yard.spots[name];
			api.stand(s[0], s[1], s[2], pitch ?? s[3]);
		},
		lookAt(x: number, y: number, z: number) {
			const p = player.at;
			const d = new THREE.Vector3(x - p.x, y - (p.y + EYE), z - p.z);
			player.yaw = Math.atan2(-d.x, -d.z);
			player.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
		},
		swing: (degrees?: number) => fire(degrees === undefined ? undefined : (degrees * Math.PI) / 180),
		focus(on: boolean) {
			focus = on;
		},
		aim(degrees: number) {
			sword.theta = (degrees * Math.PI) / 180;
		},
		blade: (i: number) => sword.select(i),
		throwFruit,
		camera,
		eye: EYE,
		get focused() {
			return focusBlend;
		},
		reset: () => yard.reset(true),
		bot(fn: null | ((dt: number) => void)) {
			bot = fn;
		},
		keys,
		bare(on: boolean) {
			document.body.classList.toggle('bare', on);
		},
		/** A camera not tied to the player, for stills: position and what to look at. */
		view(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov = 50, blade = false) {
			camera.position.set(px, py, pz);
			camera.lookAt(tx, ty, tz);
			camera.fov = fov;
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld(true);
			sword.rig.visible = blade;
			// (A scene pass draws once a frame: this starts another, so a still can follow a step in one task)
			(renderer as unknown as { _nodes: { nodeFrame: { update(): void } } })._nodes.nodeFrame.update();
			pipeline.render();
			sword.rig.visible = true;
		},
		pieces() {
			return [...slicer.pieces].map((piece) => {
				const t = piece.body.translation();
				const v = piece.body.linvel();
				return { id: piece.id, name: piece.mesh.name, kind: piece.options.kind, volume: piece.volume, radius: piece.radius, at: [t.x, t.y, t.z], speed: Math.hypot(v.x, v.y, v.z), tris: piece.solid.ntris, generation: piece.generation, fixed: piece.fixed, asleep: piece.body.isSleeping() };
			});
		},
		/** Cuts every kind of object along `planes` random planes each and checks every piece. */
		fuzz(planes = 200) {
			let seed = 99;
			const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
			const report: Record<string, unknown> = {};
			const seen = new Set<string>();
			for (const piece of slicer.pieces) {
				const key = `${piece.mesh.name || piece.options.kind}:${piece.solid.ntris}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const src = piece.solid;
				const m = measure(src);
				const size = Math.cbrt(m.volume);
				let made = 0, open = 0, nan = 0, sliver = 0, flipped = 0, worst = 0, ms = 0, worstMs = 0, parts = 0;
				let stock = [src];
				for (let k = 0; k < planes; k++) {
					const target = stock[Math.floor(rnd() * stock.length)];
					const tm = measure(target);
					const n = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
					const through = new THREE.Vector3(...tm.centroid).add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.4 * Math.cbrt(tm.volume)));
					const t0 = performance.now();
					const r = cutSolid(target, [n.x, n.y, n.z], -n.dot(through));
					const took = performance.now() - t0;
					ms += took;
					worstMs = Math.max(worstMs, took);
					if (!r.cut) continue;
					made++;
					const out = [...r.below, ...r.above];
					let sum = 0;
					const keep = [];
					for (const s of out) {
						parts++;
						const pm = measure(s);
						sum += pm.volume;
						if (openEdges(s)) open++;
						for (let i = 0; i < s.count * s.stride; i++)
							if (!Number.isFinite(s.v[i])) {
								nan++;
								break;
							}
						if (pm.volume < 1e-7) {
							sliver++;
							continue;
						}
						// Cap faces look away from the piece
						let cap = 0, wrong = 0;
						for (let t = 0; t < s.ntris; t++) {
							if (s.slot[t] !== s.capSlot) continue;
							const a = s.tris[3 * t] * s.stride, b = s.tris[3 * t + 1] * s.stride, c = s.tris[3 * t + 2] * s.stride;
							const ux = s.v[b] - s.v[a], uy = s.v[b + 1] - s.v[a + 1], uz = s.v[b + 2] - s.v[a + 2];
							const vx = s.v[c] - s.v[a], vy = s.v[c + 1] - s.v[a + 1], vz = s.v[c + 2] - s.v[a + 2];
							const d = (uy * vz - uz * vy) * s.v[a + s.oNormal] + (uz * vx - ux * vz) * s.v[a + s.oNormal + 1] + (ux * vy - uy * vx) * s.v[a + s.oNormal + 2];
							cap += Math.abs(d);
							if (d < 0) wrong -= d;
						}
						if (wrong > 0.01 * cap) flipped++;
						keep.push(s);
					}
					worst = Math.max(worst, Math.abs(sum - tm.volume) / tm.volume);
					stock.splice(stock.indexOf(target), 1, ...keep);
					if (stock.length > 60) stock = stock.slice(-60);
				}
				report[key] = { tris: src.ntris, openBefore: openEdges(src), size: +size.toFixed(3), cuts: made, pieces: parts, open, nan, flipped, dust: sliver, worstVolumeError: +worst.toExponential(2), msPerCut: +(ms / Math.max(1, made)).toFixed(3), worstMs: +worstMs.toFixed(2) };
			}
			return report;
		},
	};
	(window as unknown as { __slice: typeof api }).__slice = api;

	mark('set up');
	// Before play: every pipeline the game can ask for is built now, behind the loading screen, by drawing real
	// frames through the real passes with a tiny cut piece of every material in view, a chip, and both blades.
	// (Built at first use, each was a freeze of a tenth of a second to over a second at the first cut of each kind.)
	const device = (renderer.backend as unknown as { device?: GPUDevice }).device;
	// (Nothing here may hold the load up for good: if the GPU never answers, play starts anyway)
	const within = (work: Promise<unknown> | undefined, ms: number) => Promise.race([work, new Promise((r) => setTimeout(r, ms))]);
	const settled = async () => {
		await within(device?.queue.onSubmittedWorkDone(), 5000);
		await new Promise((r) => setTimeout(r, 0));
	};
	if (params.get('warm') !== '0') {
		const unwarm = slicer.warm(new THREE.Vector3(0, 1.5, 4.25));
		fx.prime = new THREE.Vector3(0, 1.42, 4.25);
		sword.showAll(true);
		cutPreview.strength.value = 1;
		// First all at once and off the main thread: the renderer is asked to build the scene's pipelines for a
		// target like the scene pass's own (same formats, same samples). Built one by one at first draw, the same
		// pipelines took five times as long.
		camera.position.set(player.at.x, player.at.y + EYE, player.at.z);
		camera.rotation.set(0, 0, 0);
		camera.updateMatrixWorld(true);
		// (The browser has one graphics process for every page, Patch's around this frame included, so work that
		// holds it up freezes them all. So the load's GPU work is fed to it in small helpings. First the textures,
		// one at a time: sent all at once at the first compile they held everything up for 0.4 s.)
		const textures = new Set<THREE.Texture>(loadedTextures);
		scene.traverse((o) => {
			const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.Material[] | undefined;
			if (m && !Array.isArray(m)) for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap]) if (t) textures.add(t);
		});
		for (const t of textures) {
			if (!t.image) continue;
			renderer.initTexture(t);
			await settled();
		}
		mark('textures sent');
		const target = scenePass.renderTarget;
		target.samples = renderer.samples;
		const size = renderer.getDrawingBufferSize(new THREE.Vector2());
		target.setSize(size.x, size.y);
		renderer.setRenderTarget(target);
		// (three's compileAsync waits for each pipeline before it asks for the next, so the GPU builds one at a
		// time. Here it is handed a list of its own to wait on, which stays empty: every pipeline is asked for
		// straight away, the GPU builds them side by side, and they are all waited for together at the end.)
		const pipelines = (renderer as unknown as { _pipelines: { getForRender: (object: unknown, promises?: Promise<unknown>[] | null) => unknown } })._pipelines;
		const getForRender = pipelines.getForRender;
		const building: Promise<unknown>[] = [];
		pipelines.getForRender = function (object, promises) {
			return getForRender.call(this, object, promises ? building : promises);
		};
		// (And it compiles for a top-level draw, while the scene pass draws one level down, inside the picture's own
		// draw: a different context to the renderer, whose shaders it then worked out all over again in the first
		// frame, 41 of them. Here it is given the pass's context.)
		const contexts = (renderer as unknown as { _renderContexts: { get: (target: unknown, mrt: unknown, depth?: number) => unknown } })._renderContexts;
		const getContext = contexts.get;
		contexts.get = function (target, mrt) {
			return getContext.call(this, target, mrt, 1);
		};
		// (The sky's blurred copies, for reflections, are filtered by a big shader that three builds on the spot at
		// first use: 0.4 s with everything held up. So the filtering is walked through once with drawing turned
		// off, to learn what it draws and into what, those are compiled like the rest, and the real filtering,
		// which the first material asks for, finds its pipelines made.)
		if (scene.environment) {
			const dry = new THREE.PMREMGenerator(renderer);
			const draws: [THREE.Object3D, THREE.Camera, THREE.RenderTarget | null][] = [];
			const render = renderer.render;
			renderer.render = ((o: THREE.Object3D, c: THREE.Camera) => void draws.push([o, c, renderer.getRenderTarget()])) as typeof renderer.render;
			let blurred: THREE.RenderTarget | null = null;
			try {
				blurred = dry.fromEquirectangular(scene.environment);
			} finally {
				renderer.render = render;
			}
			const compiled = new Set<string>();
			for (const [o, c, to] of draws) {
				const key = `${((o as THREE.Mesh).material as THREE.Material | undefined)?.uuid}:${to?.texture.uuid}`;
				if (compiled.has(key)) continue;
				compiled.add(key);
				renderer.setRenderTarget(to);
				await within(renderer.compileAsync(o, c), 10000);
			}
			await within(Promise.all(building), 20000);
			blurred?.dispose();
			renderer.setRenderTarget(target);
			mark('sky filters');
		}
		await within(renderer.compileAsync(scene, camera), 20000);
		contexts.get = getContext;
		pipelines.getForRender = getForRender;
		await within(Promise.all(building), 20000);
		renderer.setRenderTarget(null);
		mark('pipelines');
		progress(0.9, '준비하는 중');
		// Then real frames through the real passes: whatever the first step missed (shadows, the picture's own
		// passes) is built here, at first draw. A few things more are shown each frame, so each frame has only a
		// few shadow shaders to build: all in the first frame, they held everything up for half a second.
		const shown: THREE.Object3D[] = [];
		scene.traverse((o) => {
			if ((o as THREE.Mesh).isMesh && o.visible) shown.push(o);
		});
		for (const o of shown) o.visible = false;
		for (let i = 0; i < shown.length; i += 12) {
			for (const o of shown.slice(i, i + 12)) o.visible = true;
			frame(1 / 120);
			await settled();
		}
		// And then until one goes by quickly
		for (let i = 0; i < 8; i++) {
			const t = performance.now();
			frame(1 / 120);
			await settled();
			if (i > 0 && performance.now() - t < 40) break;
		}
		unwarm();
		fx.prime = null;
		sword.showAll(false);
		cutPreview.strength.value = 0;
		mark('warmed');
	}
	frame(1 / 120);
	await settled();
	mark('first frame');
	api.ready = true;
	document.body.classList.add('ready');
	(window as unknown as { __block: unknown }).__block = { block, values, app: api, boot: marks };
	block.ready();
	if (!fixedClock) {
		let last = performance.now();
		renderer.setAnimationLoop(() => {
			const now = performance.now();
			// (Nothing is worked out or drawn while Patch's page says the demo is out of sight)
			if (!visible) {
				last = now;
				return;
			}
			const gap = now - last;
			frame(gap / 1000);
			last = now;
			// (For scripts/trace.mjs: the time since the last frame, the time this one's own work took, what it did)
			if (api.trace) api.trace.push([+gap.toFixed(1), +(performance.now() - now).toFixed(1), cuts.total, +slicer.stats.frameMs.toFixed(1), hitStop > 0 ? 1 : 0, sword.phase]);
		});
	}
	void SUN;
}

boot().catch((e) => {
	console.error(e);
	$('start').textContent = '이 데모는 WebGPU 또는 WebGL 2를 지원하는 브라우저가 필요합니다.';
});
