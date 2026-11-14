// Custom control schemes (Controls tab → Custom Controls).
//
// Scene code (normally a chat reply's vr-exec block) declares a control
// scheme with a parameter list; GS shows those parameters as a settings UI
// (key fields, sliders, toggles, selects) and the scheme's own code reads the
// live values:
//
//   const car = gsControls.defineCustomScheme({
//     id: 'car', name: 'Car', description: 'Drive the red car.',
//     cameraMode: 'off',            // optional: camera mode while the scheme is active
//     params: [
//       { name: 'accelerate', label: 'Accelerate', type: 'key', default: 'W' },
//       { name: 'steerLeft', label: 'Steer left', type: 'key', default: 'A' },
//       { name: 'topSpeed', label: 'Top speed (m/s)', type: 'number', default: 12, min: 2, max: 40, step: 1 },
//       { name: 'autoBrake', label: 'Brake when idle', type: 'boolean', default: true },
//       { name: 'view', label: 'Camera', type: 'select', options: ['Chase', 'Hood'], default: 'Chase' }
//     ]
//   });
//   gs.onUpdate((dt) => { if (car.isDown('accelerate')) speed += car.values.topSpeed * dt; });
//   car.onChange((name, value) => { ... });   car.onPress('horn', () => honk());
//
// Defining the same id again (hot reload, a later reply) replaces the
// definition and its listeners and keeps the values of params whose name and
// type are unchanged. Clearing or loading a scene removes every scheme.
// Values: scene file (`customControls` in buildSceneData) > this browser
// (localStorage `gs.customControls.v1`, per scheme id) > the declared default.

import { normalizeCode, parseKeyName, keyLabel, codeMatches, createKeyInput, findDuplicates, describeDuplicates } from './controlBindings.js';

export const CUSTOM_CONTROLS_STORAGE_KEY = 'gs.customControls.v1';
export const PARAM_TYPES = ['key', 'number', 'boolean', 'select'];
const MAX_SCHEMES = 8;
const MAX_PARAMS = 40;
const MAX_TEXT = 200;

const clip = (s, n = MAX_TEXT) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const ID_RE = /^[A-Za-z0-9_.-]{1,48}$/;

function readStore() {
	try { const v = JSON.parse(localStorage.getItem(CUSTOM_CONTROLS_STORAGE_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; }
	catch { return {}; }
}
function writeStore(store) {
	try {
		if (Object.keys(store).length) localStorage.setItem(CUSTOM_CONTROLS_STORAGE_KEY, JSON.stringify(store));
		else localStorage.removeItem(CUSTOM_CONTROLS_STORAGE_KEY);
	} catch { /* storage blocked */ }
}

function toKey(v) {
	if (v === '' || v == null) return '';
	return normalizeCode(v) || parseKeyName(String(v)) || null;
}

/** Validate one param declaration → normalized param, or throws. */
function normalizeParam(p, i) {
	if (!p || typeof p !== 'object') throw new Error(`params[${i}] must be an object`);
	const name = String(p.name ?? '');
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name)) throw new Error(`params[${i}].name must be an identifier (letters, digits, _)`);
	const type = String(p.type || '').toLowerCase();
	if (!PARAM_TYPES.includes(type)) throw new Error(`params[${i}] "${name}": type must be one of ${PARAM_TYPES.join(', ')}`);
	const out = { name, type, label: clip(p.label || name, 80), description: clip(p.description || '', 160) };
	if (type === 'key') {
		const d = toKey(p.default);
		if (d === null) throw new Error(`params[${i}] "${name}": default "${p.default}" is not a key name (e.g. 'W', 'ArrowUp', 'Space', 'Shift')`);
		out.default = d;
	} else if (type === 'number') {
		const min = Number.isFinite(+p.min) ? +p.min : 0;
		const max = Number.isFinite(+p.max) ? +p.max : Math.max(min + 1, Number.isFinite(+p.default) ? +p.default * 2 || 1 : 1);
		if (max <= min) throw new Error(`params[${i}] "${name}": max must be greater than min`);
		const step = Number.isFinite(+p.step) && +p.step > 0 ? +p.step : Math.pow(10, Math.floor(Math.log10((max - min) / 100)));
		out.min = min; out.max = max; out.step = step;
		out.default = clampNum(Number.isFinite(+p.default) ? +p.default : min, out);
		out.unit = clip(p.unit || '', 16);
	} else if (type === 'boolean') {
		out.default = !!p.default;
	} else if (type === 'select') {
		const opts = Array.isArray(p.options) ? p.options : [];
		out.options = opts.slice(0, 30).map((o) => (o && typeof o === 'object')
			? { value: clip(o.value ?? o.label, 80), label: clip(o.label ?? o.value, 80) }
			: { value: clip(o, 80), label: clip(o, 80) }).filter((o) => o.value !== '');
		if (!out.options.length) throw new Error(`params[${i}] "${name}": select needs options`);
		const d = p.default == null ? out.options[0].value : clip(p.default, 80);
		out.default = out.options.some((o) => o.value === d) ? d : out.options[0].value;
	}
	return out;
}
function clampNum(v, p) {
	v = Math.min(p.max, Math.max(p.min, v));
	if (p.step > 0) v = p.min + Math.round((v - p.min) / p.step) * p.step;
	return Math.round(v * 1e6) / 1e6;
}
function coerce(p, v) {
	if (p.type === 'key') { const k = toKey(v); return k === null ? undefined : k; }
	if (p.type === 'number') { const n = Number(v); return Number.isFinite(n) ? clampNum(n, p) : undefined; }
	if (p.type === 'boolean') return typeof v === 'boolean' ? v : (v === 'true' ? true : v === 'false' ? false : undefined);
	if (p.type === 'select') { const s = String(v); return p.options.some((o) => o.value === s) ? s : undefined; }
	return undefined;
}

/**
 * The scheme registry and the Custom Controls panel.
 * opts: { mount, isTyping(), getCameraMode(), setCameraMode(m, {persist}), cameraModes, onSchemesChange(), describeCameraKey(code) }
 */
export function createCustomControls(opts = {}) {
	const schemes = new Map(); // id -> scheme record
	const pressed = new Set();  // KeyboardEvent.code values held now
	let pendingSceneValues = null; // values from a loading scene file
	let mount = opts.mount || null;
	const isTyping = opts.isTyping || (() => false);

	// ---- keyboard state (ignored while typing in a text field) ----
	window.addEventListener('keydown', (e) => {
		if (isTyping() || e.ctrlKey || e.metaKey) return;
		if (!pressed.has(e.code)) {
			pressed.add(e.code);
			for (const s of schemes.values()) {
				for (const p of s.params) {
					if (p.type !== 'key' || !codeMatches(s.values[p.name], e.code)) continue;
					for (const fn of s.pressListeners.get(p.name) || []) { try { fn(e); } catch (err) { console.error(err); } }
				}
			}
		}
	});
	window.addEventListener('keyup', (e) => pressed.delete(e.code));
	window.addEventListener('blur', () => pressed.clear());
	document.addEventListener('focusin', () => { if (isTyping()) pressed.clear(); });

	function isCodeDown(binding) {
		if (!binding) return false;
		for (const c of pressed) if (codeMatches(binding, c)) return true;
		return false;
	}

	function persist(s) {
		const store = readStore();
		const diff = {};
		for (const p of s.params) if (s.values[p.name] !== p.default) diff[p.name] = s.values[p.name];
		if (Object.keys(diff).length) store[s.id] = diff; else delete store[s.id];
		writeStore(store);
	}

	function makeHandle(s) {
		const handle = {
			get id() { return s.id; },
			get name() { return s.name; },
			/** Live values object: { paramName: value } (keys are KeyboardEvent.code values). */
			get values() { return { ...s.values }; },
			get(name) { return s.values[name]; },
			set(name, value) { return setValue(s.id, name, value); },
			/** True while the key bound to a `key` param is held (false while typing in a text field). */
			isDown(name) { const p = s.byName.get(name); return !!p && p.type === 'key' && !isTyping() && isCodeDown(s.values[name]); },
			/** The bound key's short name ('W', 'ArrowUp', 'Space'). */
			keyName(name) { return keyLabel(s.values[name]); },
			onChange(fn) { if (typeof fn === 'function') s.changeListeners.add(fn); return () => s.changeListeners.delete(fn); },
			onPress(name, fn) {
				if (typeof fn !== 'function') return () => {};
				if (!s.pressListeners.has(name)) s.pressListeners.set(name, new Set());
				s.pressListeners.get(name).add(fn);
				return () => s.pressListeners.get(name)?.delete(fn);
			},
			reset() { resetScheme(s.id); },
			remove() { removeScheme(s.id); }
		};
		return handle;
	}

	function define(def) {
		if (!def || typeof def !== 'object') throw new Error('defineCustomScheme needs { id, name, params }');
		const id = String(def.id ?? '');
		if (!ID_RE.test(id)) throw new Error('defineCustomScheme: id must be 1-48 letters, digits, ".", "_" or "-"');
		if (!Array.isArray(def.params) || !def.params.length) throw new Error('defineCustomScheme: params must be a non-empty array');
		if (def.params.length > MAX_PARAMS) throw new Error(`defineCustomScheme: at most ${MAX_PARAMS} params`);
		if (!schemes.has(id) && schemes.size >= MAX_SCHEMES) throw new Error(`defineCustomScheme: at most ${MAX_SCHEMES} schemes`);
		const params = def.params.map(normalizeParam);
		const names = new Set();
		for (const p of params) { if (names.has(p.name)) throw new Error(`defineCustomScheme: duplicate param "${p.name}"`); names.add(p.name); }
		const cameraModes = opts.cameraModes || [];
		const cameraMode = def.cameraMode == null ? null : String(def.cameraMode);
		if (cameraMode && cameraModes.length && !cameraModes.includes(cameraMode)) throw new Error(`defineCustomScheme: cameraMode must be one of ${cameraModes.join(', ')}`);

		const old = schemes.get(id);
		const stored = readStore()[id] || {};
		const fromScene = pendingSceneValues?.[id] || null;
		const values = {};
		for (const p of params) {
			let v;
			const prev = old?.byName.get(p.name);
			if (prev && prev.type === p.type) v = coerce(p, old.values[p.name]);
			if (v === undefined && fromScene && p.name in fromScene) v = coerce(p, fromScene[p.name]);
			if (v === undefined && p.name in stored) v = coerce(p, stored[p.name]);
			if (v === undefined) v = p.default;
			values[p.name] = v;
		}
		if (fromScene) delete pendingSceneValues[id];
		const s = {
			id,
			name: clip(def.name || id, 80),
			description: clip(def.description || '', 400),
			cameraMode,
			prevCameraMode: old ? old.prevCameraMode : null,
			params,
			byName: new Map(params.map((p) => [p.name, p])),
			values,
			changeListeners: new Set(),
			pressListeners: new Map(),
			definedAt: old ? old.definedAt : Date.now()
		};
		if (!cameraMode && old?.cameraMode) { restoreCamera(old); s.prevCameraMode = null; }
		if (cameraMode && opts.setCameraMode) {
			if (!old || old.prevCameraMode == null) s.prevCameraMode = opts.getCameraMode?.() ?? null;
			if (opts.getCameraMode?.() !== cameraMode) opts.setCameraMode(cameraMode, { persist: false });
		}
		s.handle = makeHandle(s);
		schemes.set(id, s);
		render();
		opts.onSchemesChange?.({ type: old ? 'update' : 'define', id, name: s.name });
		return s.handle;
	}

	function setValue(id, name, value) {
		const s = schemes.get(id);
		const p = s?.byName.get(name);
		if (!p) return false;
		const v = coerce(p, value);
		if (v === undefined) return false;
		if (s.values[name] === v) return true;
		s.values[name] = v;
		persist(s);
		for (const fn of s.changeListeners) { try { fn(name, v, { ...s.values }); } catch (e) { console.error(e); } }
		syncField(s, p);
		refreshWarnings(s);
		return true;
	}

	function resetScheme(id) {
		const s = schemes.get(id);
		if (!s) return;
		for (const p of s.params) setValue(id, p.name, p.default);
	}

	function restoreCamera(s) {
		if (s.cameraMode && s.prevCameraMode && opts.setCameraMode && opts.getCameraMode?.() === s.cameraMode) {
			opts.setCameraMode(s.prevCameraMode, { persist: false });
		}
	}
	function removeScheme(id) {
		const s = schemes.get(id);
		if (!s) return;
		schemes.delete(id);
		restoreCamera(s);
		render();
		opts.onSchemesChange?.({ type: 'remove', id, name: s.name });
	}
	/** Scene cleared / replaced: every scheme goes (its code is gone). */
	function reset() {
		if (!schemes.size) return;
		const list = [...schemes.values()];
		schemes.clear();
		for (const s of list.reverse()) restoreCamera(s);
		pressed.clear();
		render();
		opts.onSchemesChange?.({ type: 'reset' });
	}

	// ---- scene file ----
	function forScene() {
		const out = {};
		for (const s of schemes.values()) {
			const diff = {};
			for (const p of s.params) if (s.values[p.name] !== p.default) diff[p.name] = s.values[p.name];
			if (Object.keys(diff).length) out[s.id] = diff;
		}
		return Object.keys(out).length ? { customControls: out } : {};
	}
	function setPendingSceneValues(data) {
		const cc = data && data.customControls;
		pendingSceneValues = cc && typeof cc === 'object' && !Array.isArray(cc) ? JSON.parse(JSON.stringify(cc)) : null;
	}

	// ---- UI ----
	const fieldSync = new Map(); // `${id}:${name}` -> fn(value)
	const warnEls = new Map();   // id -> element

	function render() {
		if (!mount) return;
		fieldSync.clear();
		warnEls.clear();
		mount.textContent = '';
		if (!schemes.size) {
			const empty = document.createElement('div');
			empty.className = 'gs-cc-empty';
			empty.id = 'gs-cc-empty';
			const h = document.createElement('div');
			h.className = 'gs-cc-empty-title';
			h.textContent = 'No custom control scheme yet';
			const p1 = document.createElement('p');
			p1.textContent = 'Ask the chat for a new control scheme and its settings show up here: key fields for its keys, sliders for numbers, switches and lists. Changes apply right away.';
			const ex = document.createElement('p');
			ex.className = 'gs-cc-example';
			ex.textContent = 'Example: "Make a car I can drive with a custom control scheme: W/S to drive, A/D to steer, Space to brake, with a top speed slider."';
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'dchat-btn secondary';
			btn.id = 'gs-cc-ask';
			btn.textContent = 'Describe a scheme in chat';
			btn.addEventListener('click', () => opts.onAskChat?.());
			empty.append(h, p1, ex, btn);
			mount.appendChild(empty);
			return;
		}
		for (const s of schemes.values()) { mount.appendChild(renderScheme(s)); refreshWarnings(s); }
	}

	function renderScheme(s) {
		const card = document.createElement('section');
		card.className = 'gs-cc-scheme';
		card.dataset.schemeId = s.id;
		const head = document.createElement('div');
		head.className = 'gs-cc-head';
		const title = document.createElement('div');
		title.className = 'gs-cc-title';
		title.textContent = s.name;
		const reset = document.createElement('button');
		reset.type = 'button';
		reset.className = 'dchat-btn secondary gs-cc-reset';
		reset.textContent = 'Reset to defaults';
		reset.addEventListener('click', () => resetScheme(s.id));
		head.append(title, reset);
		card.appendChild(head);
		if (s.description) {
			const d = document.createElement('div');
			d.className = 'dchat-controls-help gs-cc-desc';
			d.textContent = s.description;
			card.appendChild(d);
		}
		if (s.cameraMode) {
			const d = document.createElement('div');
			d.className = 'dchat-controls-help gs-cc-camera';
			d.textContent = s.cameraMode === 'off'
				? 'This scheme moves the camera itself, so the camera controls are Off while it is active.'
				: `Camera controls are set to ${s.cameraMode} while this scheme is active.`;
			card.appendChild(d);
		}
		const list = document.createElement('div');
		list.className = 'gs-cc-params';
		for (const p of s.params) list.appendChild(renderParam(s, p));
		card.appendChild(list);
		const warn = document.createElement('div');
		warn.className = 'gs-remap-warning gs-cc-warning';
		warn.setAttribute('role', 'status');
		warnEls.set(s.id, warn);
		card.appendChild(warn);
		return card;
	}

	function renderParam(s, p) {
		const row = document.createElement('div');
		row.className = 'gs-cc-param gs-remap-row';
		row.dataset.param = p.name;
		row.dataset.type = p.type;
		const label = document.createElement('label');
		label.className = 'gs-remap-label';
		label.textContent = p.label;
		if (p.description) label.title = p.description;
		const ctl = document.createElement('div');
		ctl.className = 'gs-remap-keys';
		const fid = `gs-cc-${s.id}-${p.name}`.replace(/[^A-Za-z0-9_-]/g, '_');
		let sync = () => {};
		if (p.type === 'key') {
			const k = createKeyInput({ value: s.values[p.name], ariaLabel: `${s.name}: ${p.label}`, onCommit: (code) => setValue(s.id, p.name, code) });
			k.input.id = fid;
			ctl.appendChild(k.input);
			sync = (v) => k.set(v);
		} else if (p.type === 'number') {
			const range = document.createElement('input');
			range.type = 'range'; range.min = p.min; range.max = p.max; range.step = p.step; range.value = s.values[p.name];
			range.id = fid; range.className = 'gs-cc-range';
			range.setAttribute('aria-label', p.label);
			const num = document.createElement('input');
			num.type = 'number'; num.min = p.min; num.max = p.max; num.step = p.step; num.value = s.values[p.name];
			num.className = 'gs-cc-number';
			num.setAttribute('aria-label', `${p.label} value`);
			range.addEventListener('input', () => setValue(s.id, p.name, range.value));
			num.addEventListener('change', () => { if (!setValue(s.id, p.name, num.value)) num.value = s.values[p.name]; });
			num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); e.stopPropagation(); });
			ctl.append(range, num);
			if (p.unit) { const u = document.createElement('span'); u.className = 'gs-cc-unit'; u.textContent = p.unit; ctl.appendChild(u); }
			sync = (v) => { range.value = v; if (document.activeElement !== num) num.value = v; };
		} else if (p.type === 'boolean') {
			const cb = document.createElement('input');
			cb.type = 'checkbox'; cb.id = fid; cb.className = 'gs-cc-toggle'; cb.checked = !!s.values[p.name];
			cb.setAttribute('role', 'switch');
			cb.addEventListener('change', () => setValue(s.id, p.name, cb.checked));
			ctl.appendChild(cb);
			sync = (v) => { cb.checked = !!v; };
		} else if (p.type === 'select') {
			const sel = document.createElement('select');
			sel.id = fid; sel.className = 'gs-cc-select';
			for (const o of p.options) { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; sel.appendChild(op); }
			sel.value = s.values[p.name];
			sel.addEventListener('change', () => setValue(s.id, p.name, sel.value));
			ctl.appendChild(sel);
			sync = (v) => { sel.value = v; };
		}
		label.htmlFor = fid;
		row.append(label, ctl);
		fieldSync.set(`${s.id}:${p.name}`, sync);
		return row;
	}

	function syncField(s, p) { fieldSync.get(`${s.id}:${p.name}`)?.(s.values[p.name]); }

	function refreshWarnings(s) {
		const el = warnEls.get(s.id);
		if (!el) return;
		const keyParams = s.params.filter((p) => p.type === 'key');
		const dup = findDuplicates(keyParams.map((p) => ({ label: p.label, keys: [s.values[p.name]] })));
		const lines = describeDuplicates(dup);
		const camera = [];
		if (opts.describeCameraKey) {
			for (const p of keyParams) {
				const what = opts.describeCameraKey(s.values[p.name]);
				if (what) camera.push(`${keyLabel(s.values[p.name])} (${p.label}) also ${what}`);
			}
		}
		el.textContent = '';
		if (lines.length) {
			const w = document.createElement('div');
			w.className = 'gs-remap-dup';
			w.textContent = '⚠ Same key twice: ' + lines.join('; ') + '.';
			el.appendChild(w);
		}
		if (camera.length) {
			const n = document.createElement('div');
			n.className = 'gs-cc-overlap';
			n.textContent = 'Note: ' + camera.join('; ') + '.';
			el.appendChild(n);
		}
		el.hidden = !el.childNodes.length;
		const card = mount?.querySelector(`[data-scheme-id="${CSS.escape(s.id)}"]`);
		if (card) {
			card.querySelectorAll('.gs-cc-param[data-type="key"] input').forEach((inp) => {
				inp.classList.toggle('duplicate', !!inp.dataset.code && dup.has(inp.dataset.code));
			});
		}
	}

	render();

	return {
		define,
		get schemes() { return [...schemes.values()].map((s) => s.handle); },
		get(id) { return schemes.get(id)?.handle || null; },
		/** Plain description of every scheme (for tests and the chat). */
		describe() {
			return [...schemes.values()].map((s) => ({
				id: s.id, name: s.name, description: s.description, cameraMode: s.cameraMode,
				params: s.params.map((p) => ({ ...p, options: p.options ? p.options.map((o) => ({ ...o })) : undefined })),
				values: { ...s.values }
			}));
		},
		remove: removeScheme,
		reset,
		forScene,
		setPendingSceneValues,
		refreshAllWarnings() { for (const s of schemes.values()) refreshWarnings(s); },
		mount(el) { mount = el; render(); },
		get count() { return schemes.size; }
	};
}
