// AI-described controls (Controls tab → "Describe a control").
//
// The user writes a control in plain language ("In VR Map, hold both grips
// and spread your hands to zoom in, pinch to zoom out"). GS sends that text,
// the camera mode, the input vocabulary below and the current bindings to the
// chat backend (/api/chat, same provider and keys as the chat) and asks for ONE
// declarative control definition (JSON). Nothing the AI returns is ever run as
// code: the definition is validated against the whitelists here (unknown
// inputs, actions or fields → a clear error, nothing applied) and a small
// interpreter applies it every frame next to the regular key / gamepad / VR
// bindings.
//
// ---- Definition format ("gs-control/1") ----
//   {
//     "format": "gs-control/1",
//     "name": "Two-hand grip zoom",                       // ≤ 60 chars
//     "summary": "Hold both grips; hands apart zooms in, together zooms out.",  // what the AI understood
//     "when": [ { "input": "xr:L-Squeeze", "is": "held" }, { "input": "xr:R-Squeeze", "is": "held" } ],
//     "bindings": [
//       { "source": "xr:handDistance", "action": "zoom", "sensitivity": 1,
//         "invert": false, "deadzone": 0.01, "smoothing": 0.3, "clamp": [-4, 4] }
//     ]
//   }
//   or, when the request can't be expressed: { "format": "gs-control/1", "error": "why" }.
//
// when (0–4 conditions, all must be true):
//   input: any button input (below); is: "held" (≥ ½) | "notHeld" | "pressed" (the frame it goes down).
// bindings (1–4): source → action.
//   Button / direction sources (0..1) and axes (-1..1) are rates: the action
//   moves at value × sensitivity × the action's speed per second.
//   Motion sources are deltas per frame: xr:handDistance (metres between the
//   controllers), xr:L-Hand-X/Y/Z, xr:R-Hand-X/Y/Z, xr:Hands-X/Y/Z (midpoint)
//   (a hand's movement in metres: X right, Y up, Z forward, relative to where
//   you face), mouse:MoveX / mouse:MoveY (pixels), mouse:Wheel (notches, up +).
//   Deltas count from the frame the conditions became true.
//   action: "zoom" (+ in) | "pan.x" (+ right) | "pan.y" (+ forward) | "fly.up" (+ up)
//     | "rotate.yaw" (+ turn right) | "rotate.pitch" (+ look up)
//     | "move.x" | "move.z" (+ forward) | "resetView" | "recenter" (on press)
//     | "param:<name>" (a value scene code reads: gsControls.aiValue(name);
//       "param:<schemeId>.<param>" sets a Custom Controls number param).
//   sensitivity 0.05–10 (default 1) · invert (grab-the-world drags: true)
//   deadzone: rates 0–0.9 of the range; deltas metres / pixels moved before it starts
//   smoothing 0–0.95 (0 = none) · clamp [min, max]: output per second (rates
//   and deltas alike; params: the value's range) · paramMode "add" | "set".
//
// ---- Input names ----
//   key:<KeyboardEvent.code>  (key:KeyQ, key:Space, key:Shift, key:ArrowUp …)
//   mouse:Left | mouse:Right | mouse:Middle (buttons) · mouse:MoveX/MoveY/Wheel (sources)
//   pad:<gamepad input> (inputBindings.js PAD_INPUTS: A B X Y LB RB LT RT DUp … LS-Up … RS-Press View Menu)
//     axes: pad:LS-X pad:LS-Y pad:RS-X pad:RS-Y (-1..1, right / down +)
//   xr:<VR input> (XR_INPUTS: L-Trigger R-Trigger L-Squeeze R-Squeeze A B X Y L-Stick-Up … L-StickPress)
//     axes: xr:L-Stick-X xr:L-Stick-Y xr:R-Stick-X xr:R-Stick-Y · motion: see above
//
// ---- Safety ----
// JSON only (no code fallback: the scene-param action covers scene-specific
// controls, and scene code reads the values itself). Strings are clipped,
// numbers clamped, unknown keys dropped; at most 4 conditions and 4 bindings,
// 12 AI controls per mode / scene. Typing (a text field, the VR keyboard) and
// listening for a binding pause every AI control. A VR hand pointing at a menu
// window keeps its buttons for the menu (they read 0 here, as for the scene).
//
// Saved: per camera mode in this browser (localStorage `gs.aiControls.v1`),
// Custom Controls ones per scene, in the scene file (`aiControls`).

import { PAD_INPUTS, XR_INPUTS, normalizePadBinding, normalizeXrBinding, padShort, xrShort } from './inputBindings.js';
import { normalizeCode, keyLabel } from './controlBindings.js';

export const AI_CONTROLS_STORAGE_KEY = 'gs.aiControls.v1';
export const DEFINITION_FORMAT = 'gs-control/1';
export const MAX_AI_CONTROLS = 12;
export const MAX_DESCRIPTION = 400;
const MAX_WHEN = 4;
const MAX_BINDINGS = 4;

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

// ---- vocabulary ----
export const AXIS_SOURCES = {
	'pad:LS-X': ['pad', 'leftX'], 'pad:LS-Y': ['pad', 'leftY'], 'pad:RS-X': ['pad', 'rightX'], 'pad:RS-Y': ['pad', 'rightY'],
	'xr:L-Stick-X': ['xr', 'left', 'x'], 'xr:L-Stick-Y': ['xr', 'left', 'y'], 'xr:R-Stick-X': ['xr', 'right', 'x'], 'xr:R-Stick-Y': ['xr', 'right', 'y']
};
export const MOTION_SOURCES = ['xr:handDistance', 'xr:L-Hand-X', 'xr:L-Hand-Y', 'xr:L-Hand-Z', 'xr:R-Hand-X', 'xr:R-Hand-Y', 'xr:R-Hand-Z',
	'xr:Hands-X', 'xr:Hands-Y', 'xr:Hands-Z', 'mouse:MoveX', 'mouse:MoveY', 'mouse:Wheel'];
export const MOUSE_BUTTONS = ['Left', 'Right', 'Middle'];
export const CONTINUOUS_ACTIONS = ['zoom', 'pan.x', 'pan.y', 'fly.up', 'rotate.yaw', 'rotate.pitch', 'move.x', 'move.z'];
export const DISCRETE_ACTIONS = ['resetView', 'recenter'];
const ACTION_LABEL = {
	zoom: 'zoom (in +)', 'pan.x': 'pan sideways (right +)', 'pan.y': 'pan forward / back (forward +)', 'fly.up': 'move up / down (up +)',
	'rotate.yaw': 'turn left / right (right +)', 'rotate.pitch': 'look up / down (up +)', 'move.x': 'move sideways (right +)',
	'move.z': 'move forward / back (forward +)', resetView: 'reset the camera view', recenter: 'recenter on the scene origin'
};
// Speeds: rate sources (per second at full value) and delta sources (per metre / pixel / notch).
const ACTION_KIND = { zoom: 'zoom', 'pan.x': 'move', 'pan.y': 'move', 'fly.up': 'move', 'move.x': 'move', 'move.z': 'move', 'rotate.yaw': 'rotate', 'rotate.pitch': 'rotate' };
export const GAIN = {
	rate: { zoom: 1.0, move: 3, rotate: 2.0, param: 1 },
	metre: { zoom: 3, move: 4, rotate: 3, param: 1 },
	pixel: { zoom: 0.01, move: 0.01, rotate: 0.005, param: 0.01 },
	notch: { zoom: 0.2, move: 0.5, rotate: 0.1, param: 0.1 }
};
const PARAM_RE = /^param:([A-Za-z_][A-Za-z0-9_]{0,31})(?:\.([A-Za-z_][A-Za-z0-9_]{0,47}))?$/;
const SCHEME_PARAM_RE = /^param:([A-Za-z0-9_-]{1,48})\.([A-Za-z_][A-Za-z0-9_]{0,47})$/;

/** Canonical button input name ('key:KeyQ', 'pad:LB', 'xr:R-Squeeze', 'mouse:Left') or null. */
export function normalizeButtonInput(v) {
	const s = String(v ?? '').trim();
	const m = s.match(/^(key|pad|gamepad|xr|vr|mouse)\s*[:.]\s*(.+)$/i);
	if (!m) return null;
	const dev = m[1].toLowerCase(), name = m[2].trim();
	if (dev === 'key') { const c = normalizeCode(name); return c && /^[A-Za-z0-9]{1,24}$/.test(c) ? `key:${c}` : null; }
	if (dev === 'pad' || dev === 'gamepad') { const b = normalizePadBinding(name); return b ? `pad:${b}` : null; }
	if (dev === 'xr' || dev === 'vr') { const b = normalizeXrBinding(name); return b ? `xr:${b}` : null; }
	const mb = MOUSE_BUTTONS.find((x) => x.toLowerCase() === name.toLowerCase());
	return mb ? `mouse:${mb}` : null;
}
/** Canonical source name and its kind: { name, kind: 'button' | 'axis' | 'metre' | 'pixel' | 'notch' } or null. */
export function normalizeSource(v) {
	const s = String(v ?? '').trim();
	const lower = s.toLowerCase().replace(/^gamepad:/, 'pad:').replace(/^vr:/, 'xr:');
	const axis = Object.keys(AXIS_SOURCES).find((k) => k.toLowerCase() === lower);
	if (axis) return { name: axis, kind: 'axis' };
	const mo = MOTION_SOURCES.find((k) => k.toLowerCase() === lower);
	if (mo) return { name: mo, kind: mo.startsWith('xr:') ? 'metre' : mo === 'mouse:Wheel' ? 'notch' : 'pixel' };
	const b = normalizeButtonInput(s);
	return b ? { name: b, kind: 'button' } : null;
}
function normalizeAction(v) {
	const s = String(v ?? '').trim();
	const c = [...CONTINUOUS_ACTIONS, ...DISCRETE_ACTIONS].find((a) => a.toLowerCase() === s.toLowerCase());
	if (c) return c;
	return PARAM_RE.test(s) ? s : null;
}
const isDiscrete = (a) => DISCRETE_ACTIONS.includes(a);
const isParam = (a) => typeof a === 'string' && a.startsWith('param:');

// ---- validation ----
/**
 * Validate an AI (or stored) definition. → { ok: true, def } or { ok: false, error }.
 * Only whitelisted inputs / actions / fields survive; unsupported ones are errors.
 */
export function validateDefinition(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'The AI did not return a control definition (expected a JSON object).' };
	if (raw.format != null && raw.format !== DEFINITION_FORMAT) return { ok: false, error: `Unknown definition format "${clip(raw.format, 40)}".` };
	if (raw.error) return { ok: false, error: `The AI could not turn that into a control: ${clip(raw.error, 240)}` };
	const def = { format: DEFINITION_FORMAT, name: clip(raw.name, 60) || 'AI control', summary: clip(raw.summary, 240), when: [], bindings: [] };
	const when = raw.when == null ? [] : Array.isArray(raw.when) ? raw.when : [raw.when];
	if (when.length > MAX_WHEN) return { ok: false, error: `Too many conditions (${when.length}, max ${MAX_WHEN}).` };
	for (const w of when) {
		const input = normalizeButtonInput(w && (w.input ?? w.button));
		if (!input) return { ok: false, error: `Unsupported input "${clip(w && (w.input ?? w.button), 40)}" in a condition.` };
		const is = String(w.is ?? w.state ?? 'held');
		const st = ['held', 'notHeld', 'pressed'].find((x) => x.toLowerCase() === is.toLowerCase());
		if (!st) return { ok: false, error: `Unsupported condition "${clip(is, 20)}" (use held, notHeld or pressed).` };
		def.when.push({ input, is: st });
	}
	const binds = Array.isArray(raw.bindings) ? raw.bindings : raw.bindings ? [raw.bindings] : (raw.source || raw.action ? [raw] : []);
	if (!binds.length) return { ok: false, error: 'The definition has no bindings (source → action).' };
	if (binds.length > MAX_BINDINGS) return { ok: false, error: `Too many bindings (${binds.length}, max ${MAX_BINDINGS}).` };
	for (const b of binds) {
		if (!b || typeof b !== 'object') return { ok: false, error: 'A binding is not an object.' };
		const src = normalizeSource(b.source);
		if (!src) return { ok: false, error: `Unsupported input "${clip(b.source, 40)}".` };
		const action = normalizeAction(b.action);
		if (!action) return { ok: false, error: `Unsupported action "${clip(b.action, 40)}".` };
		if (isDiscrete(action) && src.kind !== 'button') return { ok: false, error: `"${action}" needs a button source, not ${src.name}.` };
		const out = { source: src.name, action, sensitivity: num(b.sensitivity, 0.05, 10, 1), invert: b.invert === true };
		if (!isDiscrete(action)) {
			out.deadzone = num(b.deadzone, 0, src.kind === 'pixel' ? 200 : src.kind === 'metre' ? 0.5 : 0.9, 0);
			out.smoothing = num(b.smoothing, 0, 0.95, 0);
			if (Array.isArray(b.clamp) && b.clamp.length === 2) {
				let lo = num(b.clamp[0], -1e4, 1e4, null), hi = num(b.clamp[1], -1e4, 1e4, null);
				if (lo != null && hi != null) { if (lo > hi) [lo, hi] = [hi, lo]; out.clamp = [lo, hi]; }
			}
			if (isParam(action)) out.paramMode = b.paramMode === 'set' ? 'set' : 'add';
		}
		def.bindings.push(out);
	}
	return { ok: true, def };
}

/** Pull the JSON object out of an AI reply (```json fence, bare object, or the first {...}). */
export function parseAiReply(text) {
	const t = String(text ?? '');
	if (!t.trim()) return { ok: false, error: 'The AI returned an empty reply.' };
	const cands = [];
	const fence = t.match(/```(?:json|gs-control)?\s*\n?([\s\S]*?)```/i);
	if (fence) cands.push(fence[1]);
	cands.push(t);
	const a = t.indexOf('{'), z = t.lastIndexOf('}');
	if (a >= 0 && z > a) cands.push(t.slice(a, z + 1));
	for (const c of cands) {
		try { const v = JSON.parse(c.trim()); if (v && typeof v === 'object') return { ok: true, value: v }; } catch { /* next */ }
	}
	return { ok: false, error: 'The AI reply was not valid JSON, so nothing was applied. Try rewording the description.' };
}

// ---- human-readable ----
export function inputLabel(name) {
	const [dev, rest] = String(name).split(/:(.*)/s);
	if (dev === 'key') return `Key ${keyLabel(rest)}`;
	if (dev === 'mouse') return { Left: 'Left mouse button', Right: 'Right mouse button', Middle: 'Middle mouse button', MoveX: 'Mouse left / right', MoveY: 'Mouse up / down', Wheel: 'Mouse wheel' }[rest] || name;
	if (dev === 'pad') {
		const ax = { 'LS-X': 'Gamepad left stick ←/→', 'LS-Y': 'Gamepad left stick ↑/↓', 'RS-X': 'Gamepad right stick ←/→', 'RS-Y': 'Gamepad right stick ↑/↓' }[rest];
		return ax || `Gamepad ${padShort(rest)}`;
	}
	if (dev === 'xr') {
		const special = {
			handDistance: 'VR distance between your hands', 'L-Hand-X': 'VR left hand ←/→', 'L-Hand-Y': 'VR left hand ↑/↓', 'L-Hand-Z': 'VR left hand forward / back',
			'R-Hand-X': 'VR right hand ←/→', 'R-Hand-Y': 'VR right hand ↑/↓', 'R-Hand-Z': 'VR right hand forward / back',
			'Hands-X': 'VR both hands ←/→', 'Hands-Y': 'VR both hands ↑/↓', 'Hands-Z': 'VR both hands forward / back',
			'L-Stick-X': 'VR left stick ←/→', 'L-Stick-Y': 'VR left stick ↑/↓', 'R-Stick-X': 'VR right stick ←/→', 'R-Stick-Y': 'VR right stick ↑/↓'
		}[rest];
		return special || `VR ${xrShort(rest)}`;
	}
	return name;
}
export function actionLabel(a) {
	if (ACTION_LABEL[a]) return ACTION_LABEL[a];
	const m = SCHEME_PARAM_RE.exec(a);
	if (m) return `set ${m[1]} → ${m[2]}`;
	return isParam(a) ? `scene value "${a.slice(6)}"` : a;
}
/** Every input a definition reads (conditions first). */
export function definitionInputs(def) {
	const out = [];
	for (const w of def.when) if (!out.includes(w.input)) out.push(w.input);
	for (const b of def.bindings) if (!out.includes(b.source)) out.push(b.source);
	return out;
}
/** Which devices a definition uses: subset of ['keyboard', 'mouse', 'gamepad', 'vr']. */
export function definitionDevices(def) {
	const d = new Set();
	for (const i of definitionInputs(def)) d.add({ key: 'keyboard', mouse: 'mouse', pad: 'gamepad', xr: 'vr' }[i.split(':')[0]]);
	return [...d];
}
const ACTION_POS = { zoom: 'zoom in', 'pan.x': 'pan right', 'pan.y': 'pan forward', 'fly.up': 'move up', 'rotate.yaw': 'turn right', 'rotate.pitch': 'look up', 'move.x': 'move right', 'move.z': 'move forward' };
const ACTION_NEG = { zoom: 'zoom out', 'pan.x': 'pan left', 'pan.y': 'pan back', 'fly.up': 'move down', 'rotate.yaw': 'turn left', 'rotate.pitch': 'look down', 'move.x': 'move left', 'move.z': 'move back' };
/** Words for a two-way source's + and - directions. */
function sourceDirs(name) {
	if (name === 'xr:handDistance') return ['apart', 'together'];
	if (name === 'mouse:Wheel') return ['scroll up', 'scroll down'];
	if (name === 'mouse:MoveY' || /-Y$/.test(name) && /Stick|LS|RS/.test(name)) return ['down', 'up'];
	if (/-X$|MoveX$/.test(name)) return ['right', 'left'];
	if (/-Y$/.test(name)) return ['up', 'down'];
	if (/-Z$/.test(name)) return ['forward', 'back'];
	return ['+', '-'];
}
/** Plain-language lines: what the AI understood. */
export function describeDefinition(def) {
	const cond = def.when.map((w) => `${w.is === 'held' ? 'hold' : w.is === 'pressed' ? 'press' : 'not holding'} ${inputLabel(w.input)}`);
	const lines = def.bindings.map((b) => {
		const kind = normalizeSource(b.source)?.kind;
		let how;
		if (isDiscrete(b.action)) how = `press ${inputLabel(b.source)} to ${actionLabel(b.action)}`;
		else if (ACTION_POS[b.action]) {
			const [pos, neg] = b.invert ? [ACTION_NEG[b.action], ACTION_POS[b.action]] : [ACTION_POS[b.action], ACTION_NEG[b.action]];
			if (kind === 'button') how = `${inputLabel(b.source)} → ${pos}`;
			else { const [p, m] = sourceDirs(b.source); how = `${inputLabel(b.source)}: ${p} → ${pos}, ${m} → ${neg}`; }
		} else how = `${inputLabel(b.source)} → ${actionLabel(b.action)}${b.invert ? ' (inverted)' : ''}`;
		const extra = [];
		if (!isDiscrete(b.action)) {
			if (b.sensitivity !== 1) extra.push(`sensitivity ${b.sensitivity}`);
			if (b.deadzone) extra.push(`deadzone ${b.deadzone}${kind === 'metre' ? ' m' : kind === 'pixel' ? ' px' : ''}`);
			if (b.smoothing) extra.push(`smoothing ${b.smoothing}`);
			if (b.clamp) extra.push(`limit ${b.clamp[0]}…${b.clamp[1]}`);
			if (b.paramMode === 'set') extra.push('sets the value');
		}
		return how + (extra.length ? ` · ${extra.join(', ')}` : '');
	});
	return { when: cond.length ? `While you ${cond.join(' and ')}:` : 'Always on:', lines };
}

// ---- conflicts ----
/**
 * Inputs of a definition that something else already uses.
 * ctx: { keys: { code: label }, gamepad: { binding: label }, xr: { binding: label },
 *        reservedXr: { binding: label } (GS's own headset uses), others: [{ name, def }] }
 * → [{ input, label, with }]
 */
export function findConflicts(def, ctx = {}) {
	const out = [];
	const stickGroup = (b) => { const m = b.match(/^(LS|RS|L-Stick|R-Stick)-(Up|Down|Left|Right|X|Y)$/); return m ? m[1] : null; };
	const expand = (name) => {
		const [dev, rest] = name.split(/:(.*)/s);
		if (dev === 'pad' || dev === 'xr') {
			const g = stickGroup(rest);
			if (g) return { dev, list: (dev === 'pad' ? PAD_INPUTS : XR_INPUTS).filter((x) => x.startsWith(g + '-') && /(Up|Down|Left|Right)$/.test(x)) };
			if (rest === 'handDistance' || /Hand|Hands/.test(rest)) return { dev, list: [] };
			return { dev, list: [rest] };
		}
		return { dev, list: [rest] };
	};
	for (const input of definitionInputs(def)) {
		const { dev, list } = expand(input);
		const seen = new Set();
		const add = (what) => { if (!seen.has(what)) { seen.add(what); out.push({ input, label: inputLabel(input), with: what }); } };
		for (const n of list) {
			if (dev === 'key' && ctx.keys?.[n]) add(ctx.keys[n]);
			if (dev === 'pad' && ctx.gamepad?.[n]) add(ctx.gamepad[n]);
			if (dev === 'xr' && ctx.xr?.[n]) add(ctx.xr[n]);
			if (dev === 'xr' && ctx.reservedXr?.[n]) add(ctx.reservedXr[n]);
			if (dev === 'mouse' && ctx.mouse?.[n]) add(ctx.mouse[n]);
		}
		for (const o of ctx.others || []) {
			if (definitionInputs(o.def).some((x) => x === input || (stickGroup(x.split(':')[1] || '') && stickGroup(x.split(':')[1]) === stickGroup(input.split(':')[1] || '') && x.split(':')[0] === dev))) add(`AI control "${o.name}"`);
		}
	}
	return out;
}

// ---- AI request ----
export function buildSystemPrompt() {
	return `You turn a user's plain-language description of a camera / game control into ONE control definition for GS, a three.js WebXR editor. Reply with exactly one JSON object in a \`\`\`json fenced block and nothing else. Do NOT write any JavaScript and do NOT write vr-exec blocks: ignore any later instructions about vr-exec code, they do not apply to this request.

Format:
{ "format": "${DEFINITION_FORMAT}", "name": "<short name, ≤ 60 chars>", "summary": "<one sentence: what you understood>",
  "when": [ { "input": "<button input>", "is": "held" | "notHeld" | "pressed" } ],   // 0-4 conditions, ALL must be true
  "bindings": [ { "source": "<input>", "action": "<action>", "sensitivity": 1, "invert": false, "deadzone": 0, "smoothing": 0, "clamp": [min, max], "paramMode": "add" | "set" } ] }  // 1-4 bindings
If the request cannot be expressed with these inputs and actions, reply { "format": "${DEFINITION_FORMAT}", "error": "<short reason>" }.

Button inputs (also usable as 0..1 sources): "key:<KeyboardEvent.code>" (key:KeyQ, key:Space, key:Shift, key:Control, key:ArrowUp, key:Digit1); "mouse:Left" | "mouse:Right" | "mouse:Middle"; gamepad "pad:A|B|X|Y|LB|RB|LT|RT|DUp|DDown|DLeft|DRight|LS-Press|RS-Press|View|Menu" and stick directions "pad:LS-Up|LS-Down|LS-Left|LS-Right|RS-Up|…"; VR controllers "xr:L-Trigger|R-Trigger|L-Squeeze|R-Squeeze|A|B|X|Y|L-StickPress|R-StickPress" (Squeeze = grip/grab button; A/B right controller, X/Y left) and "xr:L-Stick-Up|L-Stick-Down|L-Stick-Left|L-Stick-Right|R-Stick-…".
Axis sources (-1..1, right / down positive): "pad:LS-X" "pad:LS-Y" "pad:RS-X" "pad:RS-Y" "xr:L-Stick-X" "xr:L-Stick-Y" "xr:R-Stick-X" "xr:R-Stick-Y".
Motion sources (change per frame, counted from the moment the conditions became true): "xr:handDistance" (metres between the two VR controllers: grows when the hands move apart), "xr:L-Hand-X|Y|Z", "xr:R-Hand-X|Y|Z", "xr:Hands-X|Y|Z" (midpoint of both hands; X right, Y up, Z forward relative to where the user faces, metres), "mouse:MoveX" "mouse:MoveY" (pixels, right / down positive), "mouse:Wheel" (notches, scrolling up positive).
Button and axis sources are rates (value × sensitivity × speed per second); motion sources are deltas.

Actions: "zoom" (+ zooms in, - out), "pan.x" (+ right), "pan.y" (+ forward), "fly.up" (+ up), "rotate.yaw" (+ turn right), "rotate.pitch" (+ look up), "move.x" (+ right), "move.z" (+ forward), "resetView" and "recenter" (fire once when their button source is pressed), "param:<name>" (a named value the scene reads; "param:<schemeId>.<param>" changes a Custom Controls number param; paramMode "set" makes the value follow the source, "add" accumulates; clamp is then the value's range).
Pan / move are in metres; zoom 1 = about 2.7x. Sensitivity 0.05-10 (1 is a good default). invert: true flips the direction (use it for "grab and drag the world" gestures, where the world follows the hand so the camera moves the opposite way). deadzone: for rates a fraction 0-0.9 of the range, for motion sources the metres / pixels to move before it starts (0.01 m is good for hand gestures, it ignores jitter). smoothing 0-0.95. clamp: optional [min, max] of the output per second.

Rules: use "held" conditions for "hold X and …" gestures; "both grips" means two conditions xr:L-Squeeze and xr:R-Squeeze held. Spreading the hands apart = handDistance growing = zoom in (positive) unless the user says otherwise. Prefer the inputs the user names; for "VR" use xr: inputs, for "gamepad" / "controller" (non-VR) use pad: inputs. Keep it to what the user asked; do not add extra bindings.

Examples:
"In VR Map, hold both grips and spread hands to zoom in, pinch to zoom out" →
{"format":"${DEFINITION_FORMAT}","name":"Two-hand grip zoom","summary":"Hold both grips; moving your hands apart zooms in, bringing them together zooms out.","when":[{"input":"xr:L-Squeeze","is":"held"},{"input":"xr:R-Squeeze","is":"held"}],"bindings":[{"source":"xr:handDistance","action":"zoom","sensitivity":1,"deadzone":0.01,"smoothing":0.3}]}
"Gamepad: hold LB and move right stick to orbit" →
{"format":"${DEFINITION_FORMAT}","name":"LB + right stick orbit","summary":"While LB is held, the right stick orbits the camera.","when":[{"input":"pad:LB","is":"held"}],"bindings":[{"source":"pad:RS-X","action":"rotate.yaw"},{"source":"pad:RS-Y","action":"rotate.pitch","invert":true}]}`;
}
/** The user message: the description plus the context the AI needs. ctx: { modeLabel, mode, scope, bindings, schemes, others } */
export function buildUserMessage(description, ctx = {}) {
	const lines = [`Describe this control as a ${DEFINITION_FORMAT} definition: "${clip(description, MAX_DESCRIPTION)}"`, ''];
	lines.push(`Camera mode: ${ctx.modeLabel || ctx.mode || 'unknown'}${ctx.scope === 'scene' ? ' (a control for this scene, Custom Controls)' : ''}.`);
	if (ctx.bindings) lines.push(`Current bindings in this mode (avoid clashing with them unless the user asks): ${JSON.stringify(ctx.bindings).slice(0, 4000)}`);
	if (ctx.reserved) lines.push(`GS's own VR controller uses (a control may take them over): ${ctx.reserved}`);
	if (ctx.schemes && ctx.schemes.length) lines.push(`Scene control schemes (for "param:<schemeId>.<param>"): ${JSON.stringify(ctx.schemes).slice(0, 2000)}`);
	if (ctx.others && ctx.others.length) lines.push(`AI controls already in this mode: ${ctx.others.map((o) => `"${o.name}" (${definitionInputs(o.def).join(', ')})`).join('; ').slice(0, 1200)}`);
	return lines.join('\n');
}

// ---- storage ----
function sanitizeRecord(r) {
	if (!r || typeof r !== 'object') return null;
	const v = validateDefinition(r.def);
	if (!v.ok) return null;
	const id = /^[a-z0-9]{4,24}$/.test(r.id || '') ? r.id : newId();
	return { id, description: clip(r.description, MAX_DESCRIPTION), enabled: r.enabled !== false, def: v.def, createdAt: typeof r.createdAt === 'string' ? r.createdAt.slice(0, 40) : new Date().toISOString() };
}
export function sanitizeList(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const r of list.slice(0, MAX_AI_CONTROLS)) { const s = sanitizeRecord(r); if (s && !out.some((x) => x.id === s.id)) out.push(s); }
	return out;
}
export function newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
const MODE_RE = /^[a-z]{2,16}$/;
export function readModeStore(storage = globalThis.localStorage) {
	try {
		const raw = JSON.parse(storage?.getItem(AI_CONTROLS_STORAGE_KEY) || 'null');
		const out = {};
		if (raw && raw.modes && typeof raw.modes === 'object') for (const [m, list] of Object.entries(raw.modes)) if (MODE_RE.test(m)) { const l = sanitizeList(list); if (l.length) out[m] = l; }
		return out;
	} catch { return {}; }
}
export function writeModeStore(modes, storage = globalThis.localStorage) {
	try {
		const clean = Object.fromEntries(Object.entries(modes).filter(([, l]) => l && l.length));
		if (Object.keys(clean).length) storage.setItem(AI_CONTROLS_STORAGE_KEY, JSON.stringify({ v: 1, modes: clean }));
		else storage.removeItem(AI_CONTROLS_STORAGE_KEY);
	} catch { /* storage blocked */ }
}

// ---- runtime interpreter ----
/**
 * Frame snapshot (built by main.js each frame; tests build their own):
 *   { dt, typing,
 *     keys: Set<code>, mouse: { buttons: Set<'Left'|'Right'|'Middle'>, dx, dy, wheel },
 *     pad: { connected, inputs: { name: 0..1 }, axes: { leftX, leftY, rightX, rightY } },
 *     xr: { presenting, headYaw (rad, rig frame), hands: { left|right: { connected, inputs: { name: 0..1 }, blocked, stick: [x, y], pos: [x, y, z] (rig-local) | null } } } }
 * step(frame, controls) → { camera: { zoom, 'pan.x', … } (amounts this frame), params: { name: value },
 *   events: [action], engaged: Set<input> (inputs of controls whose conditions hold now) }
 */
export function createAiRuntime() {
	const state = new Map(); // `${ctrlId}:${i}` -> { engaged, base, moved, smooth } ; `${ctrlId}:prev:<input>` edge state
	const params = new Map(); // name -> value
	const prevButtons = new Map(); // input -> 0..1 last frame
	function buttonValue(frame, input) {
		const [dev, n] = input.split(/:(.*)/s);
		if (dev === 'key') {
			if (n === 'Shift' || n === 'Control' || n === 'Alt' || n === 'Meta') return frame.keys?.has(n) || frame.keys?.has(n + 'Left') || frame.keys?.has(n + 'Right') ? 1 : 0;
			return frame.keys?.has(n) ? 1 : 0;
		}
		if (dev === 'mouse') return frame.mouse?.buttons?.has(n) ? 1 : 0;
		if (dev === 'pad') return frame.pad?.connected ? (frame.pad.inputs?.[n] || 0) : 0;
		if (dev === 'xr') {
			if (!frame.xr?.presenting) return 0;
			const hand = /^(L-|X$|Y$)/.test(n) ? 'left' : 'right';
			const h = frame.xr.hands?.[hand];
			if (!h || !h.connected) return 0;
			const v = h.inputs?.[n] || 0;
			// Ray on a VR window: a NEW press belongs to the window, but a hold that
			// started before (e.g. both grips mid-zoom) keeps going.
			const wasHeld = (prevButtons.get(input) || 0) >= 0.5;
			if (h.blocked && !wasHeld) return 0;
			if (/-Stick-(Up|Down|Left|Right)$/.test(n) && h.stickBlocked && !wasHeld) return 0;
			return v;
		}
		return 0;
	}
	function axisValue(frame, name) {
		const a = AXIS_SOURCES[name];
		if (a[0] === 'pad') return frame.pad?.connected ? (frame.pad.axes?.[a[1]] || 0) : 0;
		if (!frame.xr?.presenting) return 0;
		const h = frame.xr.hands?.[a[1]];
		if (!h || !h.connected || h.stickBlocked) return 0;
		return (h.stick || [0, 0])[a[2] === 'x' ? 0 : 1] || 0;
	}
	// Motion: the raw reading whose change is the delta (null = unavailable).
	function motionReading(frame, name) {
		if (name.startsWith('mouse:')) return null; // mouse sources are already deltas
		if (!frame.xr?.presenting) return null;
		const L = frame.xr.hands?.left, R = frame.xr.hands?.right;
		const lp = L && L.connected && L.pos, rp = R && R.connected && R.pos;
		if (name === 'xr:handDistance') return lp && rp ? Math.hypot(lp[0] - rp[0], lp[1] - rp[1], lp[2] - rp[2]) : null;
		const m = name.match(/^xr:(L|R|Hands)-(?:Hand-)?([XYZ])$/) || name.match(/^xr:(L|R)-Hand-([XYZ])$/);
		if (!m) return null;
		let p;
		if (m[1] === 'Hands') { if (!lp || !rp) return null; p = [(lp[0] + rp[0]) / 2, (lp[1] + rp[1]) / 2, (lp[2] + rp[2]) / 2]; }
		else { p = m[1] === 'L' ? lp : rp; if (!p) return null; }
		return p; // vector; projected onto the facing axes when the delta is taken
	}
	function projectDelta(frame, axis, d) {
		const yaw = frame.xr?.headYaw || 0; // rig frame: forward = (-sin(yaw), 0, -cos(yaw)), right = (cos(yaw), 0, -sin(yaw))
		if (axis === 'Y') return d[1];
		if (axis === 'X') return d[0] * Math.cos(yaw) - d[2] * Math.sin(yaw);
		return -d[0] * Math.sin(yaw) - d[2] * Math.cos(yaw);
	}
	function reset() { state.clear(); }

	function step(frame, controls) {
		const out = { camera: {}, params: {}, events: [], engaged: new Set() };
		const dt = Math.max(0, Math.min(0.1, frame.dt || 0));
		const nowButtons = new Map();
		const btn = (input) => { if (!nowButtons.has(input)) nowButtons.set(input, buttonValue(frame, input)); return nowButtons.get(input); };
		const pressedNow = (input) => btn(input) >= 0.5 && (prevButtons.get(input) || 0) < 0.5;
		if (frame.typing) { reset(); remember(); return out; }
		for (const c of controls) {
			if (!c.enabled) { for (let i = 0; i < c.def.bindings.length; i++) state.delete(`${c.id}:${i}`); continue; }
			const def = c.def;
			const condOk = def.when.every((w) => (w.is === 'held' ? btn(w.input) >= 0.5 : w.is === 'notHeld' ? btn(w.input) < 0.5 : pressedNow(w.input)));
			if (condOk && def.when.length) for (const w of def.when) out.engaged.add(w.input);
			def.bindings.forEach((b, i) => {
				const key = `${c.id}:${i}`;
				const kind = normalizeSource(b.source).kind;
				let st = state.get(key);
				if (!condOk) { state.delete(key); return; }
				if (!st) { st = { base: null, moved: 0, smooth: 0, live: false }; state.set(key, st); }
				if (def.when.length || kind !== 'button') out.engaged.add(b.source);
				if (isDiscrete(b.action)) {
					if (pressedNow(b.source)) out.events.push(b.action);
					return;
				}
				// raw: per-second rate (rates) or this frame's delta (motion)
				let raw = 0, perFrame = false;
				if (kind === 'button' || kind === 'axis') {
					let v = kind === 'button' ? btn(b.source) : axisValue(frame, b.source);
					const dz = b.deadzone || 0;
					if (Math.abs(v) <= dz) v = 0; else if (dz) v = Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
					raw = v;
				} else {
					perFrame = true;
					if (kind === 'pixel') raw = b.source === 'mouse:MoveX' ? (frame.mouse?.dx || 0) : (frame.mouse?.dy || 0);
					else if (kind === 'notch') raw = frame.mouse?.wheel || 0;
					else {
						const r = motionReading(frame, b.source);
						const diff = (x, y) => (typeof x === 'number' ? x - y : projectDelta(frame, b.source.slice(-1), [x[0] - y[0], x[1] - y[1], x[2] - y[2]]));
						if (r == null) { st.base = null; st.start = null; raw = 0; }
						else if (st.base == null) { st.base = r; st.start = r; raw = 0; }
						else {
							raw = diff(r, st.base);
							st.base = r;
							// deadzone: how far from where it was engaged before it starts (ignores jitter)
							if (!st.live) { if (Math.abs(diff(r, st.start)) > (b.deadzone || 0)) st.live = true; else raw = 0; }
						}
					}
					if (!st.live && kind !== 'metre') {
						st.moved += raw;
						if (Math.abs(st.moved) > (b.deadzone || 0)) st.live = true; else raw = 0;
					}
				}
				if (b.invert) raw = -raw;
				const actKind = isParam(b.action) ? 'param' : ACTION_KIND[b.action];
				const gain = GAIN[perFrame ? kind : 'rate'][actKind] * b.sensitivity;
				let amount = perFrame ? raw * gain : raw * gain * dt; // this frame
				// clamp: output per second (params: the value range, below)
				if (b.clamp && !isParam(b.action) && dt > 0) amount = Math.min(b.clamp[1] * dt, Math.max(b.clamp[0] * dt, amount));
				if (b.smoothing) { const k = 1 - Math.pow(b.smoothing, Math.max(dt, 1 / 240) * 60); st.smooth += (amount - st.smooth) * k; amount = st.smooth; }
				if (isParam(b.action)) {
					const name = b.action.slice(6);
					let v = b.paramMode === 'set' ? raw * b.sensitivity : (params.get(name) || 0) + amount;
					if (b.clamp) v = Math.min(b.clamp[1], Math.max(b.clamp[0], v));
					if (params.get(name) !== v) { params.set(name, v); out.params[name] = v; }
					return;
				}
				if (amount) out.camera[b.action] = (out.camera[b.action] || 0) + amount;
			});
		}
		remember();
		return out;
		function remember() {
			const seen = new Set();
			for (const c of controls) for (const i of definitionInputs(c.def)) {
				if (seen.has(i) || normalizeSource(i)?.kind !== 'button') continue;
				seen.add(i);
				prevButtons.set(i, frame.typing ? 0 : btn(i));
			}
		}
	}
	return {
		step,
		reset,
		value: (name) => params.get(name) || 0,
		setValue: (name, v) => { params.set(name, Number(v) || 0); },
		get values() { return Object.fromEntries(params); }
	};
}

/** Inputs a set of enabled controls holds on to all the time (GS's own uses step aside): xr buttons → 'hand:index'. */
export function staticXrButtonClaims(controls) {
	const out = new Set();
	const IDX = { Trigger: 0, Squeeze: 1, StickPress: 3 };
	for (const c of controls) {
		if (!c.enabled) continue;
		for (const i of definitionInputs(c.def)) {
			const m = i.match(/^xr:(?:(L|R)-(Trigger|Squeeze|StickPress)|(A|B|X|Y))$/);
			if (!m) continue;
			if (m[3]) out.add(`${m[3] === 'A' || m[3] === 'B' ? 'right' : 'left'}:${m[3] === 'A' || m[3] === 'X' ? 4 : 5}`);
			else out.add(`${m[1] === 'L' ? 'left' : 'right'}:${IDX[m[2]]}`);
		}
	}
	return out;
}

// ---- desktop / phone camera ----
const _v = { a: null, b: null };
/**
 * Apply this frame's camera amounts to the windowed camera and the active stock
 * control ({ zoom, 'pan.x', … } from step()). mode: the camera mode. Only the
 * built-in modes move; Off and scene camera modes leave the camera alone.
 */
export function applyCameraAmounts(THREE, { camera, controls, mode }, a) {
	if (!a || !camera) return false;
	const keys = Object.keys(a);
	if (!keys.length) return false;
	if (!_v.a) { _v.a = new THREE.Vector3(); _v.b = new THREE.Vector3(); }
	const zoom = a.zoom || 0, px = (a['pan.x'] || 0) + (a['move.x'] || 0), pz = (a['pan.y'] || 0) + (a['move.z'] || 0), up = a['fly.up'] || 0;
	const yaw = a['rotate.yaw'] || 0, pitch = a['rotate.pitch'] || 0;
	if (mode === 'orbit' || mode === 'map') {
		if (!controls || !controls.target) return false;
		const dist = camera.position.distanceTo(controls.target);
		const scale = Math.max(0.25, dist / 4); // pan in proportion to the view, like a drag
		if (zoom && controls._dollyIn) { const s = Math.exp(-Math.abs(zoom)); if (zoom > 0) controls._dollyIn(s); else controls._dollyOut(s); }
		if (yaw && controls._rotateLeft) controls._rotateLeft(yaw);
		if (pitch && controls._rotateUp) controls._rotateUp(-pitch);
		if (px || pz || up) {
			const right = _v.a.set(1, 0, 0).applyQuaternion(camera.quaternion); right.y = 0;
			if (right.lengthSq() < 1e-8) right.set(1, 0, 0); right.normalize();
			const fwd = _v.b.set(0, 0, -1).applyQuaternion(camera.quaternion); fwd.y = 0;
			if (fwd.lengthSq() < 1e-8) fwd.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0);
			if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1); fwd.normalize();
			const move = right.multiplyScalar(px * scale).addScaledVector(fwd, pz * scale);
			move.y += up * scale;
			camera.position.add(move);
			controls.target.add(move);
		}
		controls.update?.();
		return true;
	}
	if (mode === 'fly' || mode === 'firstperson') {
		const fwd = _v.b.set(0, 0, -1).applyQuaternion(camera.quaternion);
		if (mode === 'firstperson') { fwd.y = 0; if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1); fwd.normalize(); }
		const right = _v.a.set(1, 0, 0).applyQuaternion(camera.quaternion);
		if (mode === 'firstperson') { right.y = 0; right.normalize(); }
		camera.position.addScaledVector(fwd, pz + zoom * 2).addScaledVector(right, px);
		camera.position.y += up;
		if (yaw || pitch) {
			const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
			e.y -= yaw;
			e.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, e.x + pitch));
			camera.quaternion.setFromEuler(e);
		}
		return true;
	}
	return false;
}

// ---- manager + Controls tab panels ----
/**
 * opts: {
 *   storage, request(description, ctx) → Promise<string> (the AI reply text; throws when unavailable),
 *   contextFor(scopeKey) → { mode, modeLabel, scope, bindings, reserved, schemes },
 *   conflictContext(scopeKey) → findConflicts ctx (others are added here),
 *   modeLabel(mode), onChange() }
 * Scope keys: a camera mode ('map', 'fly', …) or 'scene' (Custom Controls).
 */
export function createAiControls(opts = {}) {
	const storage = opts.storage || globalThis.localStorage;
	let modes = readModeStore(storage);
	let scene = [];
	const runtime = createAiRuntime();
	const panels = new Set();
	const listeners = new Set();
	const emit = () => { for (const p of panels) p.refresh(); for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } opts.onChange?.(); };
	const list = (scope) => (scope === 'scene' ? scene : (modes[scope] || []));
	function setList(scope, l) {
		if (scope === 'scene') scene = l;
		else { modes = { ...modes, [scope]: l }; writeModeStore(modes, storage); }
		emit();
	}
	function othersFor(scope, exceptId) {
		const all = scope === 'scene' ? scene : [...list(scope), ...scene];
		return all.filter((c) => c.id !== exceptId && c.enabled).map((c) => ({ name: c.def.name, def: c.def }));
	}
	function conflicts(scope, def, exceptId) {
		const ctx = { ...(opts.conflictContext?.(scope) || {}), others: othersFor(scope, exceptId) };
		return findConflicts(def, ctx);
	}
	/** Ask the AI. → { ok, def, conflicts } or { ok: false, error } — never throws. */
	async function generate(scope, description, exceptId = null) {
		const text = clip(description, MAX_DESCRIPTION);
		if (!text) return { ok: false, error: 'Write what the control should do first.' };
		const ctx = { ...(opts.contextFor?.(scope) || {}), scope: scope === 'scene' ? 'scene' : 'mode', others: othersFor(scope, exceptId) };
		let reply;
		try { reply = await opts.request(text, ctx); }
		catch (e) { return { ok: false, error: `The AI is unavailable, so nothing was applied: ${(clip(e && e.message ? e.message : e, 200) || 'no reply').replace(/[.\s]+$/, '')}.` }; }
		const parsed = parseAiReply(reply);
		if (!parsed.ok) return parsed;
		const v = validateDefinition(parsed.value);
		if (!v.ok) return { ok: false, error: `${v.error} Nothing was applied.` };
		return { ok: true, def: v.def, conflicts: conflicts(scope, v.def, exceptId) };
	}
	function apply(scope, { description, def, id = null }) {
		const v = validateDefinition(def);
		if (!v.ok) return { ok: false, error: v.error };
		const l = list(scope).slice();
		if (id) {
			const i = l.findIndex((c) => c.id === id);
			if (i >= 0) { l[i] = { ...l[i], description: clip(description, MAX_DESCRIPTION), def: v.def }; setList(scope, l); return { ok: true, id }; }
		}
		if (l.length >= MAX_AI_CONTROLS) return { ok: false, error: `At most ${MAX_AI_CONTROLS} AI controls here. Delete one first.` };
		const rec = { id: newId(), description: clip(description, MAX_DESCRIPTION), enabled: true, def: v.def, createdAt: new Date().toISOString() };
		l.push(rec);
		setList(scope, l);
		return { ok: true, id: rec.id };
	}
	function toggle(scope, id, on) { setList(scope, list(scope).map((c) => (c.id === id ? { ...c, enabled: on == null ? !c.enabled : !!on } : c))); }
	function remove(scope, id) { setList(scope, list(scope).filter((c) => c.id !== id)); }
	/** Enabled controls for a camera mode: that mode's, then the scene's. */
	function activeFor(mode) { return [...(modes[mode] || []), ...scene].filter((c) => c.enabled); }

	return {
		runtime,
		list: (scope) => list(scope).map((c) => ({ ...c, def: JSON.parse(JSON.stringify(c.def)) })),
		generate,
		apply,
		toggle,
		remove,
		conflicts,
		activeFor,
		onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		/** { aiControls: [...] } for the scene file when there are scene controls. */
		forScene() { return scene.length ? { aiControls: scene.map((c) => ({ id: c.id, description: c.description, enabled: c.enabled, def: c.def, createdAt: c.createdAt })) } : {}; },
		loadScene(data) { scene = sanitizeList(data && data.aiControls); runtime.reset(); emit(); },
		clearScene() { if (!scene.length) return; scene = []; runtime.reset(); emit(); },
		reload() { modes = readModeStore(storage); runtime.reset(); emit(); },
		/** Panel in a Controls section: getScope() → current scope key, or null to show a note instead. */
		mountPanel(el, { getScope, title, note } = {}) { const p = createPanel(el, { getScope, title, note }); panels.add(p); p.refresh(); return p; },
		refreshPanels() { for (const p of panels) p.refresh(); }
	};

	function createPanel(el, { getScope, title = 'AI-described controls', note = null }) {
		const uid = el.id || ('gs-ai-' + newId());
		el.classList.add('gs-ai-panel');
		el.textContent = '';
		const head = document.createElement('div');
		head.className = 'gs-ai-head';
		const lab = document.createElement('div');
		lab.className = 'dchat-section-label';
		const badge = document.createElement('span');
		badge.className = 'gs-ai-badge';
		badge.textContent = 'AI';
		lab.append(document.createTextNode(title + ' '), badge);
		head.appendChild(lab);
		const help = document.createElement('div');
		help.className = 'dchat-controls-help gs-ai-help';
		const rows = document.createElement('div');
		rows.className = 'gs-ai-rows';
		const form = document.createElement('div');
		form.className = 'gs-ai-form';
		const flabel = document.createElement('label');
		flabel.className = 'gs-ai-form-label';
		flabel.textContent = 'Describe a control';
		const input = document.createElement('textarea');
		input.className = 'gs-ai-input';
		input.id = `${uid}-input`;
		flabel.htmlFor = input.id;
		input.rows = 2;
		input.maxLength = MAX_DESCRIPTION;
		input.spellcheck = true;
		input.placeholder = 'e.g. "In VR, hold both grips and spread your hands to zoom in, pinch to zoom out" or "Gamepad: hold LB and move the right stick to orbit"';
		const actions = document.createElement('div');
		actions.className = 'gs-ai-form-actions';
		const gen = document.createElement('button');
		gen.type = 'button';
		gen.className = 'dchat-btn gs-ai-generate';
		gen.id = `${uid}-generate`;
		gen.textContent = 'Generate control';
		const cancelEdit = document.createElement('button');
		cancelEdit.type = 'button';
		cancelEdit.className = 'dchat-btn secondary gs-ai-cancel-edit';
		cancelEdit.textContent = 'Stop editing';
		cancelEdit.hidden = true;
		actions.append(gen, cancelEdit);
		const status = document.createElement('div');
		status.className = 'gs-ai-status';
		status.setAttribute('role', 'status');
		const preview = document.createElement('div');
		preview.className = 'gs-ai-preview';
		preview.id = `${uid}-preview`;
		preview.hidden = true;
		form.append(flabel, input, actions, status, preview);
		const noteEl = document.createElement('div');
		noteEl.className = 'dchat-controls-help gs-ai-note';
		el.append(head, help, rows, form, noteEl);

		let pending = null; // { scope, description, def, conflicts, id }
		let editingId = null;
		let busy = false;
		let shownScope;
		const say = (text, kind = '') => { status.textContent = text; status.dataset.kind = kind; };
		// Keys typed here stay here (the camera keys are already off while a text field has focus).
		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); gen.click(); }
			if (e.key === 'Escape') { e.preventDefault(); input.blur(); }
		});
		input.addEventListener('keyup', (e) => e.stopPropagation());
		input.addEventListener('input', () => { if (status.dataset.kind === 'error') say(''); });
		gen.addEventListener('click', async () => {
			const scope = getScope();
			if (busy || !scope) return;
			const description = input.value.trim();
			if (!description) { say('Write what the control should do first.', 'error'); return; }
			if (!editingId && list(scope).length >= MAX_AI_CONTROLS) { say(`At most ${MAX_AI_CONTROLS} AI controls here. Delete one first.`, 'error'); return; }
			busy = true; gen.disabled = true; pending = null; renderPreview();
			say('Asking the AI…', 'busy');
			const r = await generate(scope, description, editingId);
			busy = false; gen.disabled = false;
			if (getScope() !== scope) { say(''); return; }
			if (!r.ok) { say(r.error, 'error'); return; }
			say('');
			pending = { scope, description, def: r.def, conflicts: r.conflicts, id: editingId };
			renderPreview();
		});
		// Phones: keep the on-screen keyboard (and the layout) as it is while tapping Generate.
		gen.addEventListener('mousedown', (e) => { if (document.activeElement === input) e.preventDefault(); });
		cancelEdit.addEventListener('click', () => { editingId = null; input.value = ''; pending = null; say(''); renderPreview(); refresh(); });

		function renderPreview() {
			preview.textContent = '';
			preview.hidden = !pending;
			if (!pending) return;
			const d = pending.def;
			const h = document.createElement('div');
			h.className = 'gs-ai-preview-title';
			h.textContent = `${pending.id ? 'Updated' : 'New'} control: ${d.name}`;
			const sum = document.createElement('div');
			sum.className = 'gs-ai-preview-summary';
			sum.textContent = d.summary || 'The AI gave no summary.';
			const desc = describeDefinition(d);
			const how = document.createElement('div');
			how.className = 'gs-ai-preview-how';
			const w = document.createElement('div');
			w.textContent = desc.when;
			const ul = document.createElement('ul');
			for (const line of desc.lines) { const li = document.createElement('li'); li.textContent = line; ul.appendChild(li); }
			how.append(w, ul);
			const ins = document.createElement('div');
			ins.className = 'gs-ai-preview-inputs';
			ins.append(document.createTextNode('Inputs: '));
			for (const i of definitionInputs(d)) { const c = document.createElement('span'); c.className = 'gs-ai-chip'; c.dataset.input = i; c.textContent = inputLabel(i); ins.appendChild(c); }
			const conf = document.createElement('div');
			conf.className = 'gs-ai-preview-conflicts';
			if (pending.conflicts.length) {
				conf.classList.add('has-conflicts');
				conf.append(document.createTextNode('⚠ Also used by: '));
				const cl = document.createElement('ul');
				for (const c of pending.conflicts) { const li = document.createElement('li'); li.textContent = `${c.label}: ${c.with}`; cl.appendChild(li); }
				conf.appendChild(cl);
				const n = document.createElement('div');
				n.className = 'gs-ai-preview-conflict-note';
				n.textContent = 'While this control is engaged it takes those inputs; VR buttons it uses stop doing GS\'s own job while it is on.';
				conf.appendChild(n);
			} else conf.textContent = 'No conflicts with the current bindings.';
			const btns = document.createElement('div');
			btns.className = 'gs-ai-preview-actions';
			const mk = (cls, text, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.addEventListener('click', fn); return b; };
			btns.append(
				mk('dchat-btn gs-ai-apply', pending.id ? 'Apply changes' : 'Apply', () => {
					const p = pending; const r = apply(p.scope, { description: p.description, def: p.def, id: p.id });
					if (!r.ok) { say(r.error, 'error'); return; }
					pending = null; editingId = null; input.value = '';
					say(`Applied "${p.def.name}".`, 'ok');
					renderPreview(); refresh();
				}),
				mk('dchat-btn secondary gs-ai-edit', 'Edit description', () => { pending = null; renderPreview(); input.focus(); say('Change the description, then Generate again.'); }),
				mk('dchat-btn secondary gs-ai-cancel', 'Cancel', () => { pending = null; say('Nothing was applied.'); renderPreview(); })
			);
			preview.append(h, sum, how, ins, conf, btns);
		}

		function renderRows(scope) {
			rows.textContent = '';
			const l = scope ? list(scope) : [];
			rows.hidden = !l.length;
			for (const c of l) {
				const row = document.createElement('div');
				row.className = 'gs-ai-row';
				row.dataset.aiId = c.id;
				row.classList.toggle('off', !c.enabled);
				row.classList.toggle('editing', c.id === editingId);
				const top = document.createElement('div');
				top.className = 'gs-ai-row-top';
				const b = document.createElement('span');
				b.className = 'gs-ai-badge';
				b.textContent = 'AI';
				b.title = 'AI-described control';
				const name = document.createElement('b');
				name.className = 'gs-ai-row-name';
				name.textContent = c.def.name;
				const tog = document.createElement('label');
				tog.className = 'gs-ai-toggle-wrap';
				const cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.className = 'gs-ai-toggle';
				cb.checked = c.enabled;
				cb.setAttribute('aria-label', `${c.def.name}: on`);
				cb.addEventListener('change', () => toggle(scope, c.id, cb.checked));
				tog.append(cb, document.createTextNode(' On'));
				const ed = document.createElement('button');
				ed.type = 'button';
				ed.className = 'dchat-btn secondary gs-ai-row-edit';
				ed.textContent = 'Edit';
				ed.addEventListener('click', () => {
					editingId = c.id; pending = null; input.value = c.description; renderPreview(); refresh();
					say(`Editing "${c.def.name}": change the description, then Generate again.`);
					input.focus();
				});
				const del = document.createElement('button');
				del.type = 'button';
				del.className = 'dchat-btn secondary gs-ai-delete';
				del.textContent = 'Delete';
				del.addEventListener('click', () => { if (editingId === c.id) { editingId = null; input.value = ''; pending = null; renderPreview(); } remove(scope, c.id); say(`Deleted "${c.def.name}".`); });
				top.append(b, name, tog, ed, del);
				const q = document.createElement('div');
				q.className = 'gs-ai-row-desc';
				q.textContent = `“${c.description}”`;
				const desc = describeDefinition(c.def);
				const how = document.createElement('div');
				how.className = 'gs-ai-row-how';
				how.textContent = `${desc.when} ${desc.lines.join('; ')}`;
				const chips = document.createElement('div');
				chips.className = 'gs-ai-row-inputs';
				for (const i of definitionInputs(c.def)) { const ch = document.createElement('span'); ch.className = 'gs-ai-chip'; ch.dataset.input = i; ch.dataset.kind = i.split(':')[0]; ch.textContent = inputLabel(i); chips.appendChild(ch); }
				row.append(top, q, how, chips);
				const cf = conflicts(scope, c.def, c.id);
				if (cf.length && c.enabled) {
					const w = document.createElement('div');
					w.className = 'gs-ai-row-conflicts';
					w.textContent = '⚠ Shares ' + cf.map((x) => `${x.label} with ${x.with}`).join('; ');
					row.appendChild(w);
				}
				rows.appendChild(row);
			}
		}

		function refresh() {
			const scope = getScope();
			if (scope !== shownScope) {
				if (pending && pending.scope !== scope) pending = null;
				if (editingId && !list(scope || '').some((c) => c.id === editingId)) { editingId = null; }
				shownScope = scope;
				say('');
				renderPreview();
			}
			el.dataset.scope = scope || '';
			form.hidden = !scope;
			const n = typeof note === 'function' ? note(scope) : note;
			noteEl.textContent = n || '';
			noteEl.hidden = !n;
			help.textContent = scope === 'scene'
				? 'Describe a control for this scene in your own words; the AI turns it into a working control (saved with the scene). It can move the camera or set values the scene reads.'
				: scope ? `Describe a ${opts.modeLabel?.(scope) || scope} control in your own words (keyboard, mouse, game controller or VR); the AI turns it into a working control next to the bindings above. Saved in this browser.` : '';
			help.hidden = !scope;
			cancelEdit.hidden = !editingId;
			gen.textContent = editingId ? 'Regenerate control' : 'Generate control';
			renderRows(scope);
		}
		return { refresh, el, get pending() { return pending; } };
	}
}
