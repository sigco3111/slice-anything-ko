// Writes recipe.json (the demo's recipe: its controls for Patch's block page, how it is tested, its credits) and
// patch.json (what pch and the release scripts read): `node make-recipe.mjs`. The demo reads its controls from
// recipe.json, so this is the one place they are defined.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const cc0 = (files, source, author) => ({ files, license: 'CC0-1.0', source, author });

const recipe = {
	mode: 'browser',
	block: {
		controls: [
			{ id: 'blade', label: '검', hint: '손에 쥐는 검입니다. 카타나는 빠르고 가볍고, 롱소드는 더 느리지만 길고 무겁습니다.', type: 'choice', options: [{ value: 'katana', label: '카타나' }, { value: 'longsword', label: '롱소드' }], default: 'katana', essential: true },
			{ id: 'speed', label: '속도', hint: '시간이 흐르는 빠르기입니다. 1보다 작으면 슬로우 모션입니다.', type: 'number', min: 0.1, max: 1, step: 0.05, default: 1, unit: '×', essential: true },
			{ id: 'line', label: '절단선', hint: '칼이 닿는 범위 안의 모든 물체에 칼날이 지나갈 선을 그립니다. 마우스 오른쪽 버튼을 누르고 있어도 표시됩니다.', type: 'toggle', default: false, essential: true },
			{ id: 'gravity', label: '중력', hint: '잘린 조각이 떨어지는 힘입니다.', type: 'number', min: 1, max: 20, step: 0.1, default: 9.8, unit: 'm/s²' },
			{ id: 'budget', label: '프레임당 절단', hint: '한 프레임에 절단에 쓰는 밀리초입니다. 조각 더미를 가르는 휘두름은 이 안에서 필요한 만큼 여러 프레임에 나눠 처리됩니다.', type: 'number', min: 1, max: 12, step: 0.5, default: 5, unit: 'ms' },
			{ id: 'hold', label: '칼날 물림', hint: '칼날이 처음 닿은 물체에 순간 머무는지 정합니다.', type: 'toggle', default: true },
			{ id: 'shake', label: '화면 흔들림', hint: '칼날이 물릴 때 화면이 흔들리는지 정합니다.', type: 'toggle', default: true },
		],
		presets: [],
		// (Slashing is a drag inside the frame, so there is no Slash button. And no Throw fruit: one fruit coming
		// from across the yard is too small a change for Patch's test to tell from the dust in the air, and a
		// button has to show what it did. F throws one.)
		triggers: [{ id: 'reset', label: '초기화', hint: '모든 것을 온전한 상태로 되돌리고, 시작 지점으로 돌아갑니다.' }],
	},
	test: { move_keys: ['KeyW', 'ArrowUp'] },
	credits: [
		cc0('assets/models/marbleBust01.glb', 'https://polyhaven.com/a/marble_bust_01', 'Rico Cilliers (Marble Bust 01)'),
		cc0('assets/swords/katana/', 'https://polyhaven.com/a/antique_katana_01', 'Tal Swicegood (Antique Katana 01)'),
		cc0('assets/swords/estoc/', 'https://polyhaven.com/a/antique_estoc', 'James Ray Cock and Ulan Cabanilla (Antique Estoc; textures scaled to 1K by Patch)'),
		cc0('assets/hdri/', 'https://polyhaven.com/a/syferfontein_6d_clear_puresky', 'Greg Zaal and Jarod Guest (Syferfontein 6d Clear, Pure Sky)'),
		cc0('assets/materials/patternedPaving02/', 'https://polyhaven.com/a/patterned_paving_02', 'Dimitrios Savva (Patterned Paving 02)'),
		cc0('assets/materials/plasteredWall02/', 'https://polyhaven.com/a/plastered_wall_02', 'Charlotte Baglioni (Plastered Wall 02)'),
		cc0('assets/materials/darkPlanks/', 'https://polyhaven.com/a/dark_planks', 'Rob Tuytel (Dark Planks)'),
		cc0('assets/materials/gravelFloor/', 'https://polyhaven.com/a/gravel_floor', 'Jenelle van Heerden and Matterfield (Gravel Floor; recompressed by Patch)'),
		cc0('assets/materials/greyRoofTiles/', 'https://polyhaven.com/a/grey_roof_tiles', 'Rob Tuytel (Grey Roof Tiles)'),
		{ files: 'assets/', license: 'MIT', source: 'https://github.com/mrdoob/three.js', author: 'three.js authors' },
		{ files: 'assets/', license: 'Apache-2.0', source: 'https://github.com/dimforge/rapier.js', author: 'Dimforge (Rapier 0.19.3)' },
	],
};
fs.writeFileSync(path.join(here, 'recipe.json'), JSON.stringify(recipe, null, '\t') + '\n');
fs.writeFileSync(path.join(here, 'patch.json'), JSON.stringify({ project: 'blendi/slice-anything', version: pkg.version, channel: 'private', files: 'dist', recipe }, null, '\t') + '\n');
console.log(`recipe.json and patch.json written (${recipe.block.controls.length} controls, ${recipe.block.triggers.length} triggers, version ${pkg.version})`);
