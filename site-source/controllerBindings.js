// Remappable game controller (Gamepad API) and VR controller (WebXR)
// bindings, next to the remappable keys (controlBindings.js).
//
// Stock camera styles: every row of inputBindings.js CONTROLLER_STYLES (and
// GLOBAL_PAD_ROWS) can be given another gamepad / VR input in Controls →
// Camera. Custom Controls key params (customControls.js, including a custom
// camera mode's params) store their overrides here too, per scheme id and
// param name.
//
// Saved in this browser: localStorage `gs.controllerBindings.v1`
//   { styles: { fly: { gamepad: { up: 'RT' }, xr: { up: 'R-Trigger' } }, global: { gamepad: { switchMode: 'Menu' } } },
//     schemes: { car: { gamepad: { accelerate: 'RT' }, xr: { horn: 'R-Squeeze' } } } }
// Only bindings that differ from the defaults are kept; '' = unbound. New key
// (nothing was stored for controllers before), so nothing to migrate.
//
// Conflicts are refused like keys: an input another row of the same style
// (plus the global buttons) / the same scheme already uses can't be given to
// a second row on the same device; free it first.
//
// Capture (createBindField): click a Gamepad / VR field → it listens. The
// next input that goes from rest past the threshold (button / trigger ½,
// stick ¾ of the way in one direction) is assigned; one already held when
// listening starts must be let go first. Esc, a click elsewhere or Cancel
// stops listening. A picker under the row lists every input for people
// without the device at hand (and None).
// VR: the trigger of a hand whose ray is on a menu window never counts (it is
// clicking the menu: the Cancel / pick buttons, or anywhere else, which
// cancels); point that hand away from the menu to bind its trigger. Every
// other input of either hand counts, after a 300 ms grace period. While
// listening, GS's own uses of the headset buttons / sticks (push-to-talk,
// ray toggle, UI toggle, locomotion, scrolling) and the scene's bindings pause.

import { PAD_INPUTS, XR_INPUTS, CONTROLLER_STYLES, GLOBAL_PAD_ROWS, normalizePadBinding, normalizeXrBinding,
	padShort, xrShort, padLabel, xrLabel, padInputsRaw, xrInputsRaw, isStickBinding } from './inputBindings.js';

export const CONTROLLER_BINDINGS_STORAGE_KEY = 'gs.controllerBindings.v1';
export const DEVICES = ['gamepad', 'xr'];
const norm = (device, b) => (device === 'gamepad' ? normalizePadBinding(b) : normalizeXrBinding(b));
export const deviceInputs = (device) => (device === 'gamepad' ? PAD_INPUTS : XR_INPUTS);
export const bindShort = (device, b) => (device === 'gamepad' ? padShort(b) : xrShort(b));
export const bindLabel = (device, b) => (device === 'gamepad' ? padLabel(b) : xrLabel(b));
export const DEVICE_NAME = { gamepad: 'Gamepad', xr: 'VR' };

// ---- storage ----
const field = (device) => (device === 'gamepad' ? 'pad' : 'xr');
let store = read();
const listeners = new Set();
function read() {
	try {
		const raw = JSON.parse(localStorage.getItem(CONTROLLER_BINDINGS_STORAGE_KEY) || 'null');
		return sanitize(raw);
	} catch { return { styles: {}, schemes: {} }; }
}
function cleanMap(device, m, allowed) {
	const out = {};
	if (!m || typeof m !== 'object') return out;
	for (const [id, b] of Object.entries(m)) {
		if (allowed && !allowed.has(id)) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(id)) continue;
		const n = norm(device, b);
		if (n !== null) out[id] = n;
	}
	return out;
}
function sanitize(raw) {
	const out = { styles: {}, schemes: {} };
	if (!raw || typeof raw !== 'object') return out;
	for (const style of [...Object.keys(CONTROLLER_STYLES), 'global']) {
		const s = raw.styles?.[style];
		if (!s) continue;
		for (const device of DEVICES) {
			if (style === 'global' && device === 'xr') continue;
			const ids = new Set(stockRows(style, device).map((r) => r.id));
			const m = cleanMap(device, s[device], ids);
			// drop defaults and an input used twice (keep the first row)
			const seen = new Set();
			for (const r of stockRows(style, device)) if (!(r.id in m) && r[field(device)]) seen.add(r[field(device)]);
			for (const r of stockRows(style, device)) {
				if (!(r.id in m)) continue;
				const def = r[field(device)];
				if (m[r.id] === def) { delete m[r.id]; continue; }
				if (m[r.id] && seen.has(m[r.id])) { delete m[r.id]; continue; }
				if (m[r.id]) seen.add(m[r.id]);
			}
			if (Object.keys(m).length) (out.styles[style] ||= {})[device] = m;
		}
	}
	if (raw.schemes && typeof raw.schemes === 'object') {
		for (const [id, s] of Object.entries(raw.schemes).slice(0, 64)) {
			if (!/^[A-Za-z0-9_.-]{1,48}$/.test(id) || !s || typeof s !== 'object') continue;
			for (const device of DEVICES) {
				const m = cleanMap(device, s[device]);
				if (Object.keys(m).length) (out.schemes[id] ||= {})[device] = m;
			}
		}
	}
	return out;
}
function write() {
	try {
		if (Object.keys(store.styles).length || Object.keys(store.schemes).length) localStorage.setItem(CONTROLLER_BINDINGS_STORAGE_KEY, JSON.stringify(store));
		else localStorage.removeItem(CONTROLLER_BINDINGS_STORAGE_KEY);
	} catch { /* storage blocked */ }
}
function emit(what) { for (const fn of listeners) { try { fn(what); } catch (e) { console.error(e); } } }
export function onControllerBindingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Re-read storage (another tab, tests). */
export function reloadControllerBindings() { store = read(); emit({ all: true }); }

// ---- stock styles ----
/** Rows of a style that exist on a device (style 'global': the gamepad buttons for every style). */
export function stockRows(style, device) {
	const rows = style === 'global' ? (device === 'gamepad' ? GLOBAL_PAD_ROWS : []) : (CONTROLLER_STYLES[style] || []);
	return rows.filter((r) => r[field(device)] != null);
}
export function stockDefault(style, device, id) {
	const r = stockRows(style, device).find((x) => x.id === id);
	return r ? r[field(device)] || '' : '';
}
export function getStock(style, device, id) {
	const m = store.styles[style]?.[device];
	return m && id in m ? m[id] : stockDefault(style, device, id);
}
/** { id: binding } for a style and device. */
export function stockBindings(style, device) {
	return Object.fromEntries(stockRows(style, device).map((r) => [r.id, getStock(style, device, r.id)]));
}
/** Row of the same style (or the global buttons) already using an input: { style, id, label } or null. */
export function stockOwner(style, device, id, b, labelOf = (st, r) => r.label || r.id) {
	if (!b) return null;
	const scopes = style === 'global' ? (device === 'gamepad' ? Object.keys(CONTROLLER_STYLES).concat('global') : []) : [style].concat(device === 'gamepad' ? ['global'] : []);
	for (const st of scopes) {
		for (const r of stockRows(st, device)) {
			if (st === style && r.id === id) continue;
			if (getStock(st, device, r.id) === b) return { style: st, id: r.id, label: labelOf(st, r) };
		}
	}
	return null;
}
/** Bind an input (''= none). Refused (false) when unknown or used by another row. */
export function setStock(style, device, id, b) {
	if (!stockRows(style, device).some((r) => r.id === id)) return false;
	const n = norm(device, b);
	if (n === null) return false;
	if (n && stockOwner(style, device, id, n)) return false;
	const def = stockDefault(style, device, id);
	if (n === def) {
		const m = store.styles[style]?.[device];
		if (m) { delete m[id]; if (!Object.keys(m).length) delete store.styles[style][device]; if (!Object.keys(store.styles[style]).length) delete store.styles[style]; }
	} else {
		((store.styles[style] ||= {})[device] ||= {})[id] = n;
	}
	write();
	emit({ style, device });
	return true;
}
export function resetStock(style, device) {
	if (store.styles[style]) { delete store.styles[style][device]; if (!Object.keys(store.styles[style]).length) delete store.styles[style]; }
	write();
	emit({ style, device });
}
export function isStockCustomized(style, device) { return !!store.styles[style]?.[device]; }

// ---- Custom Controls schemes (customControls.js keeps the logic) ----
export function schemeOverrides(schemeId) {
	const s = store.schemes[schemeId] || {};
	return { gamepad: { ...(s.gamepad || {}) }, xr: { ...(s.xr || {}) } };
}
export function saveSchemeOverrides(schemeId, over) {
	const s = {};
	for (const d of DEVICES) if (over[d] && Object.keys(over[d]).length) s[d] = { ...over[d] };
	if (Object.keys(s).length) store.schemes[schemeId] = s; else delete store.schemes[schemeId];
	write();
}
export function normalizeBinding(device, b) { return norm(device, b); }

// ---- capture ----
const GRACE_MS = { gamepad: 120, xr: 300 };
const REST = 0.25;
const threshold = (b) => (isStickBinding(b) ? 0.75 : 0.5);
let active = null; // { device, onAssign(b), onCancel(), t0, rest: Set }
// After an assignment the input that was pressed is still held: until it is
// let go (or 3 s pass) it reaches neither GS nor the scene, so binding a
// button never also presses it.
let settling = null; // { device, name, until }
export const capture = {
	/** 'gamepad' | 'xr' while a field listens, else null. */
	get listening() { return active ? active.device : null; },
	/** Device whose input is paused now (listening, or the assigned input not let go yet). */
	get busy() {
		if (active) return active.device;
		if (settling && performance.now() > settling.until) settling = null;
		return settling ? settling.device : null;
	},
	start(device, handlers) {
		if (active) capture.cancel();
		settling = null;
		active = { device, ...handlers, t0: performance.now(), rest: new Set() };
	},
	cancel() { const a = active; active = null; if (a) { try { a.onCancel?.(); } catch (e) { console.error(e); } } },
	_assign(b) {
		const a = active; active = null;
		if (b) settling = { device: a.device, name: b, until: performance.now() + 3000 };
		try { a.onAssign(b); } catch (e) { console.error(e); }
	},
	_feed(device, inputs, skip) {
		if (settling && settling.device === device && !active) {
			if ((inputs[settling.name] ?? 0) < REST || performance.now() > settling.until) settling = null;
			return;
		}
		if (!active || active.device !== device) return;
		const late = performance.now() - active.t0 >= GRACE_MS[device];
		for (const [name, v] of Object.entries(inputs)) {
			if (skip && skip.has(name)) { active.rest.delete(name); continue; }
			if (v < REST) { active.rest.add(name); continue; }
			if (late && v >= threshold(name) && active.rest.has(name)) { capture._assign(name); return; }
		}
	},
	/** Raw Gamepad (main.js pollGamepads, every frame while busy). */
	feedPad(gp) { if (capture.busy === 'gamepad') capture._feed('gamepad', padInputsRaw(gp)); },
	/** One headset controller (main.js XR loop). rayOnWindow: its trigger is clicking the menu. */
	feedXr(hand, gp, rayOnWindow) {
		if (capture.busy !== 'xr') return;
		const inputs = xrInputsRaw(hand, gp);
		// settling: only the hand that has the input reports it
		if (settling && !active && !(settling.name in inputs)) return;
		capture._feed('xr', inputs, rayOnWindow ? new Set([hand === 'left' ? 'L-Trigger' : 'R-Trigger']) : null);
	}
};

// ---- field ----
let pickerSeq = 0;
/**
 * A Gamepad / VR binding field: shows the binding ("Gamepad A"), click to
 * listen. opts: { device, value, auto, remapped, ariaLabel, host (element the
 * picker goes after; default: the closest row), onCommit(b) → true | false }.
 */
export function createBindField({ device, value = '', auto = false, remapped = false, ariaLabel = '', host = null, onCommit = () => true } = {}) {
	const el = document.createElement('button');
	el.type = 'button';
	el.className = 'gs-bind-chip gs-bind-field';
	el.dataset.kind = device;
	const cap = document.createElement('small');
	const val = document.createElement('b');
	el.append(cap, val);
	let cur = value || '', isAuto = auto, isRemapped = remapped, picker = null;
	const what = DEVICE_NAME[device];
	function show() {
		el.dataset.binding = cur;
		el.dataset.auto = isAuto ? '1' : '0';
		el.dataset.remapped = isRemapped ? '1' : '0';
		el.classList.toggle('none', !cur);
		el.classList.toggle('remapped', isRemapped);
		cap.textContent = `${what} `; // textContent reads "Gamepad A"
		val.textContent = el.classList.contains('listening') ? 'Press…' : bindShort(device, cur);
		const long = `${device === 'xr' ? 'VR controller' : 'Game controller'}: ${bindLabel(device, cur)}`;
		el.title = `${long}. Click, then press a ${device === 'xr' ? 'VR controller' : 'game controller'} button or push a stick / trigger, or pick one from the list.`;
		el.setAttribute('aria-label', `${ariaLabel ? ariaLabel + ', ' : ''}${long}`);
	}
	const outside = (e) => { if (!el.contains(e.target) && !(picker && picker.contains(e.target))) capture.cancel(); };
	const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); capture.cancel(); } };
	function stop() {
		el.classList.remove('listening');
		el.setAttribute('aria-pressed', 'false');
		document.removeEventListener('pointerdown', outside, true);
		document.removeEventListener('click', outside, true);
		document.removeEventListener('keydown', onKey, true);
		picker?.remove(); picker = null;
		show();
	}
	function commit(b) {
		stop();
		if (b === cur) return;
		if (onCommit(b) === false) { el.classList.add('invalid'); setTimeout(() => el.classList.remove('invalid'), 1500); }
	}
	function buildPicker() {
		const p = document.createElement('div');
		p.className = 'gs-bind-picker';
		p.dataset.kind = device;
		p.id = `gs-bind-picker-${++pickerSeq}`;
		p.setAttribute('role', 'group');
		p.setAttribute('aria-label', `Pick a ${what} input`);
		const hint = document.createElement('div');
		hint.className = 'gs-bind-picker-hint';
		hint.textContent = device === 'xr'
			? 'Press a VR controller button or push a thumbstick / trigger (point away from the menu to use that hand\'s trigger), or pick:'
			: 'Press a button or push a stick / trigger on the game controller, or pick:';
		const grid = document.createElement('div');
		grid.className = 'gs-bind-picker-grid';
		for (const b of [...deviceInputs(device), '']) {
			const o = document.createElement('button');
			o.type = 'button';
			o.className = 'gs-bind-option';
			o.dataset.binding = b;
			o.textContent = b ? bindShort(device, b) : 'None';
			o.title = b ? bindLabel(device, b) : 'No binding';
			if (b === cur) o.classList.add('current');
			o.addEventListener('click', (e) => { e.stopPropagation(); active = null; commit(b); });
			grid.appendChild(o);
		}
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'gs-bind-option gs-bind-cancel';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', (e) => { e.stopPropagation(); capture.cancel(); });
		grid.appendChild(cancel);
		p.append(hint, grid);
		return p;
	}
	el.addEventListener('click', (e) => {
		e.stopPropagation();
		if (el.classList.contains('listening')) { capture.cancel(); return; }
		capture.start(device, { onAssign: commit, onCancel: stop });
		el.classList.add('listening');
		el.setAttribute('aria-pressed', 'true');
		picker = buildPicker();
		const row = host || el.closest('.gs-remap-row, .gs-ctl-row, .gs-cc-param') || el.parentElement;
		row.after(picker);
		el.setAttribute('aria-controls', picker.id);
		show();
		setTimeout(() => {
			if (!el.classList.contains('listening')) return;
			document.addEventListener('pointerdown', outside, true);
			document.addEventListener('click', outside, true);
			document.addEventListener('keydown', onKey, true);
		}, 0);
	});
	show();
	return {
		el,
		get value() { return cur; },
		set(b, { auto: a = isAuto, remapped: r = isRemapped } = {}) { cur = b || ''; isAuto = a; isRemapped = r; show(); },
		get listening() { return el.classList.contains('listening'); }
	};
}
