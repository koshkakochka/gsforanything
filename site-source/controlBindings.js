// Key remapping for the desktop camera control styles (Controls tab → Camera)
// and the shared key-input field used there and by Custom Controls.
//
// Keys are stored as KeyboardEvent.code values ('KeyW', 'ArrowUp', 'Space',
// 'Digit1', …), so a binding follows the physical key whatever the keyboard
// layout. The modifier keys are stored without their side ('Shift',
// 'Control', 'Alt', 'Meta') and match either the left or the right key.
//
// Each style action has up to two keys (primary, alternate) and the stock
// three.js code it stands for: cameraControls.js turns a pressed key into the
// stock code before handing it to the stock control, so with the defaults
// every control behaves exactly as before.
//
// Saved in this browser (localStorage `gs.controlKeys.v3`, only the actions
// that differ from the defaults). Key layouts are a keyboard / user
// preference like the camera mode itself, so they are not saved with scenes.

export const CONTROL_KEYS_STORAGE_KEY = 'gs.controlKeys.v3';
// Layouts saved by the PR #48 dev builds (v1, v2): a key field that kept
// focus turned the next key pressed to walk (W) into Move right's key, so D
// went dead while → still worked. Dropped once so every action starts from its
// defaults again; only ever existed on dev.
const LEGACY_STORAGE_KEYS = ['gs.controlKeys.v1', 'gs.controlKeys.v2'];

const PAN_ROTATE_NOTE = 'Shift / Ctrl / ⌘ + a pan key rotates instead';

export const REMAP_STYLES = {
	orbit: {
		label: 'Orbit',
		actions: [
			{ id: 'panUp', label: 'Pan up', stock: 'ArrowUp', keys: ['ArrowUp'] },
			{ id: 'panDown', label: 'Pan down', stock: 'ArrowDown', keys: ['ArrowDown'] },
			{ id: 'panLeft', label: 'Pan left', stock: 'ArrowLeft', keys: ['ArrowLeft'] },
			{ id: 'panRight', label: 'Pan right', stock: 'ArrowRight', keys: ['ArrowRight'] }
		],
		fixed: [
			['Left-drag', 'Rotate'],
			['Right-drag, or Shift / Ctrl / ⌘ + left-drag', 'Pan'],
			['Wheel or middle-drag', 'Zoom'],
			['Shift / Ctrl / ⌘ + pan key', 'Rotate'],
			['Touch', 'One finger rotates, two fingers zoom and pan']
		],
		note: PAN_ROTATE_NOTE
	},
	map: {
		label: 'Map',
		actions: [
			{ id: 'panUp', label: 'Pan forward', stock: 'ArrowUp', keys: ['ArrowUp'] },
			{ id: 'panDown', label: 'Pan back', stock: 'ArrowDown', keys: ['ArrowDown'] },
			{ id: 'panLeft', label: 'Pan left', stock: 'ArrowLeft', keys: ['ArrowLeft'] },
			{ id: 'panRight', label: 'Pan right', stock: 'ArrowRight', keys: ['ArrowRight'] }
		],
		fixed: [
			['Left-drag', 'Pan'],
			['Right-drag, or Shift / Ctrl / ⌘ + left-drag', 'Rotate'],
			['Wheel or middle-drag', 'Zoom'],
			['Shift / Ctrl / ⌘ + pan key', 'Rotate'],
			['Touch', 'One finger pans, two fingers zoom and rotate']
		],
		note: PAN_ROTATE_NOTE
	},
	fly: {
		label: 'Fly',
		actions: [
			{ id: 'forward', label: 'Move forward', stock: 'KeyW', keys: ['KeyW'] },
			{ id: 'back', label: 'Move back', stock: 'KeyS', keys: ['KeyS'] },
			{ id: 'left', label: 'Move left', stock: 'KeyA', keys: ['KeyA'] },
			{ id: 'right', label: 'Move right', stock: 'KeyD', keys: ['KeyD'] },
			{ id: 'up', label: 'Move up', stock: 'KeyR', keys: ['KeyR'] },
			{ id: 'down', label: 'Move down', stock: 'KeyF', keys: ['KeyF'] },
			{ id: 'pitchUp', label: 'Look up', stock: 'ArrowUp', keys: ['ArrowUp'] },
			{ id: 'pitchDown', label: 'Look down', stock: 'ArrowDown', keys: ['ArrowDown'] },
			{ id: 'yawLeft', label: 'Turn left', stock: 'ArrowLeft', keys: ['ArrowLeft'] },
			{ id: 'yawRight', label: 'Turn right', stock: 'ArrowRight', keys: ['ArrowRight'] },
			{ id: 'rollLeft', label: 'Roll left', stock: 'KeyQ', keys: ['KeyQ'] },
			{ id: 'rollRight', label: 'Roll right', stock: 'KeyE', keys: ['KeyE'] },
			{ id: 'slow', label: 'Slow (hold)', stock: 'ShiftLeft', keys: ['Shift'] }
		],
		fixed: [
			['Drag the scene', 'Look around'],
			['On-screen joysticks / game controller', 'Move and look']
		]
	},
	firstperson: {
		label: 'First person',
		actions: [
			{ id: 'forward', label: 'Move forward', stock: 'KeyW', keys: ['KeyW', 'ArrowUp'] },
			{ id: 'backward', label: 'Move back', stock: 'KeyS', keys: ['KeyS', 'ArrowDown'] },
			{ id: 'left', label: 'Move left', stock: 'KeyA', keys: ['KeyA', 'ArrowLeft'] },
			{ id: 'right', label: 'Move right', stock: 'KeyD', keys: ['KeyD', 'ArrowRight'] }
		],
		fixed: [
			['Click the scene', 'Mouse look'],
			['Esc', 'Release the mouse (browser key, not remappable)'],
			['On-screen joysticks / game controller', 'Walk and look']
		]
	}
};
export const KEYS_PER_ACTION = 2;

// ---- Key names ----
const MOD_CODES = { ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta', OSLeft: 'Meta', OSRight: 'Meta' };
const PUNCT = { '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote' };
const PUNCT_LABEL = Object.fromEntries(Object.entries(PUNCT).map(([ch, code]) => [code, ch]));
const ALIASES = {
	space: 'Space', spacebar: 'Space', ' ': 'Space',
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	'↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight',
	arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
	shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', '⌘': 'Meta',
	enter: 'Enter', return: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
	insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', capslock: 'CapsLock'
};
const CODE_RE = /^(Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal)|F(?:[1-9]|1[0-9]|2[0-4])|Arrow(?:Up|Down|Left|Right)|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|IntlBackslash|Shift|Control|Alt|Meta)$/;
// Keys that can't be bound: Esc releases mouse look and closes dialogs.
const RESERVED = new Set(['Escape']);

/** A KeyboardEvent.code (or a key code from storage) → the stored form, or null. */
export function normalizeCode(code) {
	if (typeof code !== 'string' || !code) return null;
	if (MOD_CODES[code]) return MOD_CODES[code];
	if (RESERVED.has(code)) return null;
	return CODE_RE.test(code) ? code : null;
}

/** Text typed into a key field ('W', 'w', 'ArrowUp', 'space', '1', '-') → code, or null. */
export function parseKeyName(text) {
	if (typeof text !== 'string') return null;
	if (text === ' ') return 'Space';
	const t = text.trim();
	if (!t) return null;
	if (/^[a-z]$/i.test(t)) return 'Key' + t.toUpperCase();
	if (/^[0-9]$/.test(t)) return 'Digit' + t;
	if (PUNCT[t]) return PUNCT[t];
	const alias = ALIASES[t.toLowerCase()];
	if (alias) return alias;
	if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(t)) return 'F' + t.slice(1);
	// Exact code names, case-insensitive ('keyw' → 'KeyW').
	const fixed = t.replace(/^key([a-z])$/i, (m, c) => 'Key' + c.toUpperCase()).replace(/^digit([0-9])$/i, 'Digit$1');
	const direct = normalizeCode(fixed);
	if (direct) return direct;
	const lower = t.toLowerCase();
	for (const name of ['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote', 'IntlBackslash', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter', 'NumpadEqual']) {
		if (name.toLowerCase() === lower) return name;
	}
	if (/^numpad[0-9]$/i.test(t)) return 'Numpad' + t.slice(6);
	return null;
}

/** Stored code → the short name shown in a key field ('W', '1', 'ArrowUp', 'Space', 'Shift'). */
export function keyLabel(code) {
	if (!code) return '';
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	if (PUNCT_LABEL[code]) return PUNCT_LABEL[code];
	return code;
}

/** Does a stored binding match a KeyboardEvent.code? */
export function codeMatches(binding, code) {
	if (!binding || !code) return false;
	return binding === code || binding === MOD_CODES[code];
}

// ---- Style bindings (state + storage) ----
let overrides = readStored();
const listeners = new Set();

function readStored() {
	try { for (const k of LEGACY_STORAGE_KEYS) localStorage.removeItem(k); } catch { /* storage blocked */ }
	try {
		const raw = JSON.parse(localStorage.getItem(CONTROL_KEYS_STORAGE_KEY) || 'null');
		return sanitizeOverrides(raw);
	} catch { return {}; }
}
function sanitizeOverrides(raw) {
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [style, def] of Object.entries(REMAP_STYLES)) {
		const s = raw[style];
		if (!s || typeof s !== 'object') continue;
		for (const a of def.actions) {
			if (!Array.isArray(s[a.id])) continue;
			// Accept codes ('KeyD') and names ('d', 'D', 'ArrowRight'); drop junk
			// and a key repeated within the action.
			const keys = [];
			for (const k of s[a.id].slice(0, KEYS_PER_ACTION)) {
				const code = (k === '' || k == null) ? '' : (normalizeCode(k) || parseKeyName(String(k)) || '');
				keys.push(code && keys.includes(code) ? '' : code);
			}
			// An action left with no key at all (blank or missing entries) falls
			// back to its default keys instead of going dead.
			if (!keys.some(Boolean)) continue;
			const defaults = defaultKeys(style, a.id);
			if (padKeys(keys).every((k, i) => k === defaults[i])) continue;
			(out[style] ||= {})[a.id] = keys;
		}
		// A key may only belong to one action: a stored layout where it is
		// used twice (older builds allowed it) keeps it on the first action
		// only; an action left with no key gets its defaults back.
		if (out[style]) {
			const seen = new Set();
			for (const a of def.actions) {
				const o = out[style][a.id];
				let keys = o ? padKeys(o) : defaultKeys(style, a.id);
				if (o) {
					// A key taken by an earlier action goes back to this slot's
					// default key when that one is free.
					const defaults = defaultKeys(style, a.id);
					keys = keys.map((k, i) => {
						if (!k || !seen.has(k)) return k;
						const d = defaults[i];
						return d && !seen.has(d) && !keys.includes(d) ? d : '';
					});
					if (!keys.some(Boolean)) keys = defaults.map((k) => (k && seen.has(k) ? '' : k));
					if (keys.every((k, i) => k === defaults[i])) delete out[style][a.id];
					else out[style][a.id] = keys;
				}
				for (const k of keys) if (k) seen.add(k);
			}
			if (!Object.keys(out[style]).length) delete out[style];
		}
	}
	return out;
}
function writeStored() {
	try {
		if (Object.keys(overrides).length) localStorage.setItem(CONTROL_KEYS_STORAGE_KEY, JSON.stringify(overrides));
		else localStorage.removeItem(CONTROL_KEYS_STORAGE_KEY);
	} catch { /* storage blocked */ }
}
function emit(style) { for (const fn of listeners) { try { fn(style); } catch (e) { console.error(e); } } }
export function onBindingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function padKeys(keys) {
	const out = keys.slice(0, KEYS_PER_ACTION);
	while (out.length < KEYS_PER_ACTION) out.push('');
	return out;
}
export function defaultKeys(style, actionId) {
	const a = REMAP_STYLES[style]?.actions.find((x) => x.id === actionId);
	return a ? padKeys(a.keys) : padKeys([]);
}
/** The keys bound to one action (always KEYS_PER_ACTION entries; '' = empty). */
export function getKeys(style, actionId) {
	const o = overrides[style]?.[actionId];
	return o ? padKeys(o) : defaultKeys(style, actionId);
}
/** { actionId: [keys] } for a style. */
export function getStyleBindings(style) {
	const def = REMAP_STYLES[style];
	if (!def) return {};
	return Object.fromEntries(def.actions.map((a) => [a.id, getKeys(style, a.id)]));
}
/** The other action of a style that already uses a key: { id, label } or null. */
export function keyOwner(style, actionId, code) {
	const def = REMAP_STYLES[style];
	const norm = code ? normalizeCode(code) : '';
	if (!def || !norm) return null;
	for (const a of def.actions) {
		if (a.id !== actionId && getKeys(style, a.id).includes(norm)) return { id: a.id, label: a.label };
	}
	return null;
}
/** Bind a key. A key another action of the style already uses is refused
 *  (returns false): it would silently take the key from one of them, which is
 *  how a stray W in Move right's field left D dead. Change that one first. */
export function setKey(style, actionId, slot, code) {
	const def = REMAP_STYLES[style];
	const a = def?.actions.find((x) => x.id === actionId);
	if (!a || slot < 0 || slot >= KEYS_PER_ACTION) return false;
	const norm = code ? normalizeCode(code) : '';
	if (code && !norm) return false;
	if (norm && keyOwner(style, actionId, norm)) return false;
	let keys = getKeys(style, actionId);
	keys[slot] = norm || '';
	if (norm && keys[1 - slot] === norm) keys[1 - slot] = ''; // same key twice in one action
	const defaults = defaultKeys(style, actionId);
	// Clearing the last key of an action puts its defaults back (an action
	// with no key would just stop working).
	if (!keys.some(Boolean)) keys = defaults.slice();
	if (keys.every((k, i) => k === defaults[i])) {
		if (overrides[style]) { delete overrides[style][actionId]; if (!Object.keys(overrides[style]).length) delete overrides[style]; }
	} else {
		(overrides[style] ||= {})[actionId] = keys;
	}
	writeStored();
	emit(style);
	return true;
}
export function resetStyle(style) {
	if (!REMAP_STYLES[style]) return;
	delete overrides[style];
	writeStored();
	emit(style);
}
export function isStyleCustomized(style) { return !!overrides[style]; }
/** Re-read storage (another tab, tests). */
export function reloadBindings() { overrides = readStored(); for (const s of Object.keys(REMAP_STYLES)) emit(s); }

/** Action bound to a pressed key in a style: { id, stock } or null. */
export function actionForCode(style, code) {
	const def = REMAP_STYLES[style];
	if (!def) return null;
	for (const a of def.actions) {
		if (getKeys(style, a.id).some((k) => codeMatches(k, code))) return a;
	}
	return null;
}

/** Keys used by more than one action (or twice by one): Map code → [labels]. */
export function findDuplicates(entries) {
	// entries: [{ label, keys: [code, …] }]
	const seen = new Map();
	for (const e of entries) {
		for (const k of e.keys) {
			if (!k) continue;
			if (!seen.has(k)) seen.set(k, []);
			seen.get(k).push(e.label);
		}
	}
	const dup = new Map();
	for (const [k, labels] of seen) if (labels.length > 1) dup.set(k, labels);
	return dup;
}
export function styleDuplicates(style) {
	const def = REMAP_STYLES[style];
	if (!def) return new Map();
	return findDuplicates(def.actions.map((a) => ({ label: a.label, keys: getKeys(style, a.id) })));
}
export function describeDuplicates(dup) {
	return [...dup].map(([k, labels]) => `${keyLabel(k)} is used by ${[...new Set(labels)].join(' and ')}${new Set(labels).size < labels.length ? ' (twice)' : ''}`);
}

// ---- Key field ----
/** Keep the select-all from focus: the click's own mouseup would otherwise
 *  drop the selection and put the caret after the text. */
export function keepSelection(input) {
	const onUp = (e) => { e.preventDefault(); };
	input.addEventListener('mouseup', onUp, { once: true });
	setTimeout(() => input.removeEventListener('mouseup', onUp), 600);
}
/**
 * A text input that records a key: click it ("Press a key") and press the key.
 * Every key, letters included, is taken from KeyboardEvent.code at once and the
 * field lets go of focus, so a key pressed afterwards to play never lands in
 * it. Esc / Enter / Tab leave it unchanged; Backspace / Delete clear it.
 * Without a usable code (phone soft keyboards) the key's name can be typed
 * ('W', 'ArrowUp', 'Space') and is kept when the field is left.
 * onCommit(code|'') runs whenever a valid key (or empty) is entered; when it
 * returns false the key was refused and the field shows the old key again.
 * Pressing anywhere outside the field also lets go of it.
 */
export function createKeyInput({ value = '', ariaLabel = 'Key', placeholder = 'none', onCommit = () => {} } = {}) {
	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'gs-key-input';
	input.autocomplete = 'off';
	input.spellcheck = false;
	input.setAttribute('autocapitalize', 'off');
	input.setAttribute('aria-label', ariaLabel);
	input.placeholder = placeholder;
	let committed = value || '';
	input.value = keyLabel(committed);
	input.dataset.code = committed;

	function show(code) { committed = code || ''; input.value = keyLabel(committed); input.dataset.code = committed; input.classList.remove('invalid'); }
	function commit(code) {
		code = code || '';
		if (code === committed) { show(code); return true; }
		const prev = committed;
		show(code);
		if (onCommit(code) === false) { show(prev); return false; }
		return true;
	}
	const leave = () => { if (document.activeElement === input) input.blur(); };
	// A press anywhere else (panel, resize handle, scene) lets go of the
	// field even where that press does not move focus by itself.
	const onOutsideDown = (e) => { if (e.target !== input) leave(); };
	input.addEventListener('focus', () => {
		input.placeholder = 'Press a key';
		input.classList.add('capturing');
		try { input.select(); } catch { /* ignore */ }
		keepSelection(input);
		document.addEventListener('pointerdown', onOutsideDown, true);
	});
	input.addEventListener('blur', () => {
		document.removeEventListener('pointerdown', onOutsideDown, true);
		input.placeholder = placeholder;
		input.classList.remove('capturing');
		// Typed names (phone keyboards) are kept on leaving.
		const t = input.value.trim();
		const parsed = t === '' ? '' : parseKeyName(t);
		if (parsed === null || (t !== '' && t === keyLabel(committed))) show(committed); else commit(parsed);
	});
	input.addEventListener('keydown', (e) => {
		e.stopPropagation(); // never reaches the camera controls / app shortcuts
		if (e.isComposing) return;
		if (e.key === 'Tab') return;
		if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); show(committed); leave(); return; }
		if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); commit(''); leave(); return; }
		const code = normalizeCode(e.code);
		if (!code) return; // soft keyboard: the typed text is read on leaving
		e.preventDefault();
		if (!commit(code)) input.classList.add('invalid');
		leave();
	});
	input.addEventListener('keyup', (e) => e.stopPropagation());
	input.addEventListener('input', () => {
		const t = input.value.trim();
		input.classList.toggle('invalid', t !== '' && parseKeyName(t) === null);
	});
	return {
		input,
		get code() { return committed; },
		set(code) { show(code); }
	};
}
