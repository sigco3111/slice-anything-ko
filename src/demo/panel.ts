// Standalone settings panel, in Korean: on Patch's block page the page draws the controls from recipe.json and
// answers them over patch-block messages. On a plain static host there is no such page, so this panel renders
// the same controls itself and answers them the same way. It is only installed when the demo runs alone
// (window.parent === window), so Patch's own controls keep steering the demo there.

type Value = number | boolean | string;

type Control = {
	id: string;
	label: string;
	type: 'choice' | 'number' | 'toggle' | 'color';
	options?: { value: string; label: string }[];
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
};

type Trigger = { id: string; label: string };

export function installPanel(opts: {
	controls: Control[];
	triggers: Trigger[];
	values: Record<string, Value>;
	set: (id: string, value: Value) => void;
	trigger: (id: string) => void;
}): { sync: (id: string) => void } {
	const { controls, triggers, values, set, trigger } = opts;
	const panel = document.createElement('details');
	panel.id = 'panel';
	const summary = document.createElement('summary');
	summary.textContent = '설정';
	panel.appendChild(summary);
	const body = document.createElement('div');
	body.className = 'body';
	panel.appendChild(body);

	const syncers = new Map<string, () => void>();

	for (const control of controls) {
		const row = document.createElement('div');
		row.className = 'row';
		const label = document.createElement('span');
		label.textContent = control.label;
		row.appendChild(label);

		if (control.type === 'choice') {
			const seg = document.createElement('div');
			seg.className = 'seg';
			const buttons: HTMLButtonElement[] = [];
			for (const option of control.options ?? []) {
				const b = document.createElement('button');
				b.textContent = option.label;
				b.addEventListener('click', () => set(control.id, option.value));
				buttons.push(b);
				seg.appendChild(b);
			}
			syncers.set(control.id, () => {
				for (const [i, option] of (control.options ?? []).entries()) buttons[i].classList.toggle('on', values[control.id] === option.value);
			});
			row.appendChild(seg);
		} else if (control.type === 'number') {
			const wrap = document.createElement('div');
			wrap.className = 'seg';
			const input = document.createElement('input');
			input.type = 'range';
			input.min = String(control.min ?? 0);
			input.max = String(control.max ?? 1);
			input.step = String(control.step ?? 0.01);
			const val = document.createElement('span');
			val.className = 'val';
			input.addEventListener('input', () => set(control.id, Number(input.value)));
			syncers.set(control.id, () => {
				const v = Number(values[control.id]);
				input.value = String(v);
				val.textContent = `${Math.round(v * 100) / 100}${control.unit ?? ''}`;
			});
			wrap.appendChild(input);
			wrap.appendChild(val);
			row.appendChild(wrap);
		} else if (control.type === 'toggle') {
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.addEventListener('change', () => set(control.id, input.checked));
			syncers.set(control.id, () => {
				input.checked = Boolean(values[control.id]);
			});
			row.appendChild(input);
		}
		body.appendChild(row);
	}

	const buttons = document.createElement('div');
	buttons.className = 'row seg';
	for (const t of [...triggers, { id: 'throw', label: '과일 던지기' }]) {
		const b = document.createElement('button');
		b.textContent = t.label;
		b.addEventListener('click', () => trigger(t.id));
		buttons.appendChild(b);
	}
	body.appendChild(buttons);

	const keys = document.createElement('div');
	keys.className = 'keys';
	keys.textContent = '1/2 검 바꾸기 · R 초기화 · F 과일 · H 화면 표시 끄기';
	body.appendChild(keys);

	document.body.appendChild(panel);
	const sync = (id: string) => syncers.get(id)?.();
	for (const control of controls) sync(control.id);
	return { sync };
}
