// Game controller (Gamepad API, standard mapping) and WebXR controller
// bindings next to the keyboard / mouse ones.
//
// Binding names (case-insensitive; a few aliases are accepted):
//   gamepad: 'LS-Up' 'LS-Down' 'LS-Left' 'LS-Right' (left stick directions),
//            'RS-Up' … (right stick), 'A' 'B' 'X' 'Y', 'LB' 'RB', 'LT' 'RT',
//            'DUp' 'DDown' 'DLeft' 'DRight' (d-pad), 'LS-Press' 'RS-Press',
//            'View' 'Menu'.
//   xr:      'L-Stick-Up' … 'R-Stick-Right' (thumbstick directions),
//            'L-Trigger' 'R-Trigger', 'L-Squeeze' 'R-Squeeze',
//            'A' 'B' (right controller), 'X' 'Y' (left controller),
//            'L-StickPress' 'R-StickPress'.
// '' means no binding. Stick directions read 0..1 past the deadzone.
//
// Built-in camera styles: CONTROLLER_STYLES gives every remappable
// action (controlBindings.js) and the mouse / wheel gestures their pad and
// headset equivalents. The pad drives the stock control (cameraControls.stick);
// in a headset the camera follows your head and the thumbsticks move you
// (locomotion), so the XR column lists those equivalents.
// Custom Controls key params (customControls.js) take `gamepad` / `xr`
// fields; omitted ones are generated from the key (autoBindings()).

export const PAD_INPUTS = ['LS-Up', 'LS-Down', 'LS-Left', 'LS-Right', 'RS-Up', 'RS-Down', 'RS-Left', 'RS-Right',
	'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'DUp', 'DDown', 'DLeft', 'DRight', 'LS-Press', 'RS-Press', 'View', 'Menu'];
export const XR_INPUTS = ['L-Stick-Up', 'L-Stick-Down', 'L-Stick-Left', 'L-Stick-Right', 'R-Stick-Up', 'R-Stick-Down', 'R-Stick-Left', 'R-Stick-Right',
	'L-Trigger', 'R-Trigger', 'L-Squeeze', 'R-Squeeze', 'A', 'B', 'X', 'Y', 'L-StickPress', 'R-StickPress'];

const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s_.-]+/g, '');
const PAD_ALIASES = {
	leftstickup: 'LS-Up', leftstickdown: 'LS-Down', leftstickleft: 'LS-Left', leftstickright: 'LS-Right',
	rightstickup: 'RS-Up', rightstickdown: 'RS-Down', rightstickleft: 'RS-Left', rightstickright: 'RS-Right',
	up: 'DUp', down: 'DDown', left: 'DLeft', right: 'DRight', dpadup: 'DUp', dpaddown: 'DDown', dpadleft: 'DLeft', dpadright: 'DRight',
	l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT', l3: 'LS-Press', r3: 'RS-Press', ls: 'LS-Press', rs: 'RS-Press',
	cross: 'A', circle: 'B', square: 'X', triangle: 'Y', back: 'View', select: 'View', start: 'Menu'
};
const XR_ALIASES = {
	leftstickup: 'L-Stick-Up', leftstickdown: 'L-Stick-Down', leftstickleft: 'L-Stick-Left', leftstickright: 'L-Stick-Right',
	rightstickup: 'R-Stick-Up', rightstickdown: 'R-Stick-Down', rightstickleft: 'R-Stick-Left', rightstickright: 'R-Stick-Right',
	lthumbstickup: 'L-Stick-Up', lthumbstickdown: 'L-Stick-Down', lthumbstickleft: 'L-Stick-Left', lthumbstickright: 'L-Stick-Right',
	rthumbstickup: 'R-Stick-Up', rthumbstickdown: 'R-Stick-Down', rthumbstickleft: 'R-Stick-Left', rthumbstickright: 'R-Stick-Right',
	lefttrigger: 'L-Trigger', righttrigger: 'R-Trigger', trigger: 'R-Trigger', leftsqueeze: 'L-Squeeze', rightsqueeze: 'R-Squeeze',
	lgrip: 'L-Squeeze', rgrip: 'R-Squeeze', leftgrip: 'L-Squeeze', rightgrip: 'R-Squeeze', grip: 'L-Squeeze', squeeze: 'L-Squeeze'
};
const PAD_BY_SQUASH = Object.fromEntries(PAD_INPUTS.map((n) => [squash(n), n]));
const XR_BY_SQUASH = Object.fromEntries(XR_INPUTS.map((n) => [squash(n), n]));

/** A gamepad binding name → canonical name, '' for none, null if unknown. */
export function normalizePadBinding(v) {
	if (v === '' || v == null || v === false) return '';
	const k = squash(v);
	return PAD_BY_SQUASH[k] || PAD_ALIASES[k] || null;
}
/** An XR controller binding name → canonical name, '' for none, null if unknown. */
export function normalizeXrBinding(v) {
	if (v === '' || v == null || v === false) return '';
	const k = squash(v);
	return XR_BY_SQUASH[k] || XR_ALIASES[k] || null;
}

const ARROW = { Up: '↑', Down: '↓', Left: '←', Right: '→' };
export function padLabel(b) {
	if (!b) return '—';
	let m = b.match(/^(LS|RS)-(Up|Down|Left|Right)$/);
	if (m) return `${m[1] === 'LS' ? 'Left' : 'Right'} stick ${ARROW[m[2]]}`;
	m = b.match(/^D(Up|Down|Left|Right)$/);
	if (m) return `D-pad ${ARROW[m[1]]}`;
	if (b === 'LS-Press') return 'Left stick press';
	if (b === 'RS-Press') return 'Right stick press';
	return b;
}
export function xrLabel(b) {
	if (!b) return '—';
	let m = b.match(/^(L|R)-Stick-(Up|Down|Left|Right)$/);
	if (m) return `${m[1] === 'L' ? 'Left' : 'Right'} thumbstick ${ARROW[m[2]]}`;
	m = b.match(/^(L|R)-(Trigger|Squeeze|StickPress)$/);
	if (m) return `${m[1] === 'L' ? 'Left' : 'Right'} ${m[2] === 'StickPress' ? 'thumbstick press' : m[2] === 'Squeeze' ? 'grip' : 'trigger'}`;
	return `${b} button`;
}

// Compact forms for the Custom Controls columns ("Gamepad LS ↑", "VR R trigger").
export function padShort(b) {
	if (!b) return '—';
	let m = b.match(/^(LS|RS)-(Up|Down|Left|Right)$/);
	if (m) return `${m[1]} ${ARROW[m[2]]}`;
	m = b.match(/^D(Up|Down|Left|Right)$/);
	if (m) return `D-pad ${ARROW[m[1]]}`;
	if (b === 'LS-Press') return 'LS press';
	if (b === 'RS-Press') return 'RS press';
	return b;
}
export function xrShort(b) {
	if (!b) return '—';
	let m = b.match(/^(L|R)-Stick-(Up|Down|Left|Right)$/);
	if (m) return `${m[1]} stick ${ARROW[m[2]]}`;
	m = b.match(/^(L|R)-(Trigger|Squeeze|StickPress)$/);
	if (m) return `${m[1]} ${m[2] === 'StickPress' ? 'stick press' : m[2] === 'Squeeze' ? 'grip' : 'trigger'}`;
	return b;
}

// ---- defaults generated from a key (Custom Controls key params) ----
const PAD_FROM_KEY = {
	KeyW: 'LS-Up', KeyS: 'LS-Down', KeyA: 'LS-Left', KeyD: 'LS-Right',
	ArrowUp: 'DUp', ArrowDown: 'DDown', ArrowLeft: 'DLeft', ArrowRight: 'DRight',
	KeyI: 'RS-Up', KeyK: 'RS-Down', KeyJ: 'RS-Left', KeyL: 'RS-Right',
	Space: 'A', Enter: 'A', Shift: 'LS-Press', Control: 'B', KeyC: 'B',
	KeyE: 'X', KeyF: 'X', KeyR: 'Y', KeyQ: 'LB', KeyZ: 'LB', KeyX: 'RB', Tab: 'View', KeyP: 'Menu', KeyM: 'Menu'
};
const PAD_POOL = ['A', 'X', 'B', 'Y', 'RB', 'LB', 'RT', 'LT', 'DUp', 'DDown', 'DLeft', 'DRight', 'RS-Press', 'LS-Press'];
// Headset: sticks, Space → A (jump), triggers / grips for action keys.
const XR_FROM_KEY = {
	KeyW: 'L-Stick-Up', KeyS: 'L-Stick-Down', KeyA: 'L-Stick-Left', KeyD: 'L-Stick-Right',
	ArrowUp: 'R-Stick-Up', ArrowDown: 'R-Stick-Down', ArrowLeft: 'R-Stick-Left', ArrowRight: 'R-Stick-Right',
	KeyI: 'R-Stick-Up', KeyK: 'R-Stick-Down', KeyJ: 'R-Stick-Left', KeyL: 'R-Stick-Right',
	Space: 'A', Enter: 'R-Trigger', KeyF: 'R-Trigger', KeyE: 'L-Trigger', Shift: 'L-Squeeze', Control: 'L-Squeeze'
};
// Then whatever is still free; A/B/X/Y last because GS uses them (a scheme
// that binds one takes it over from push-to-talk / the pointer rays).
const XR_POOL = ['R-Trigger', 'L-Trigger', 'L-Squeeze', 'B', 'X', 'Y', 'A'];

/**
 * Fill in missing `gamepad` / `xr` bindings of key params from their default
 * key, skipping inputs another param of the same scheme already has.
 * params: normalized params ({ type, default, gamepad?, xr? } with undefined = auto).
 */
export function autoBindings(params) {
	const usedPad = new Set(), usedXr = new Set();
	for (const p of params) {
		if (p.type !== 'key') continue;
		if (p.gamepad) usedPad.add(p.gamepad);
		if (p.xr) usedXr.add(p.xr);
	}
	for (const p of params) {
		if (p.type !== 'key') continue;
		if (p.gamepad === undefined) {
			let g = PAD_FROM_KEY[p.default] || '';
			if (!g || usedPad.has(g)) g = PAD_POOL.find((x) => !usedPad.has(x)) || '';
			p.gamepad = g; p.gamepadAuto = true;
			if (g) usedPad.add(g);
		}
		if (p.xr === undefined) {
			let x = XR_FROM_KEY[p.default] || '';
			// A taken stick direction stays unbound (the stick is in use);
			// a taken button moves on to a free one.
			if (x && usedXr.has(x)) x = '';
			if (!x && !xrStickOf(XR_FROM_KEY[p.default] || '')) x = XR_POOL.find((y) => !usedXr.has(y)) || '';
			p.xr = x; p.xrAuto = true;
			if (x) usedXr.add(x);
		}
	}
	return params;
}

// ---- reading ----
const PAD_STICK = { LS: ['leftX', 'leftY'], RS: ['rightX', 'rightY'] };
const PAD_BUTTON = { DUp: 'Up', DDown: 'Down', DLeft: 'Left', DRight: 'Right', 'LS-Press': 'LS', 'RS-Press': 'RS' };
/** 0..1 for a gamepad binding. pad: gsGamepad (axis(), button(), deadzone already applied). */
export function padValue(b, pad) {
	if (!b || !pad || !pad.connected) return 0;
	const m = b.match(/^(LS|RS)-(Up|Down|Left|Right)$/);
	if (m) {
		const [ax, ay] = PAD_STICK[m[1]];
		const x = pad.axis(ax), y = pad.axis(ay);
		return Math.max(0, m[2] === 'Up' ? -y : m[2] === 'Down' ? y : m[2] === 'Left' ? -x : x);
	}
	return pad.button(PAD_BUTTON[b] || b) || 0;
}
// xr-standard gamepad: buttons 0 trigger, 1 squeeze, 3 thumbstick press,
// 4 A / X, 5 B / Y; axes 2, 3 the thumbstick.
const XR_FACE = { A: ['right', 4], B: ['right', 5], X: ['left', 4], Y: ['left', 5] };
/** Hand and xr-standard button index of a button binding, or null (sticks). */
export function xrButtonOf(b) {
	if (XR_FACE[b]) return { hand: XR_FACE[b][0], index: XR_FACE[b][1] };
	const m = b && b.match(/^(L|R)-(Trigger|Squeeze|StickPress)$/);
	if (!m) return null;
	return { hand: m[1] === 'L' ? 'left' : 'right', index: m[2] === 'Trigger' ? 0 : m[2] === 'Squeeze' ? 1 : 3 };
}
export function xrStickOf(b) {
	const m = b && b.match(/^(L|R)-Stick-(Up|Down|Left|Right)$/);
	return m ? { hand: m[1] === 'L' ? 'left' : 'right', dir: m[2] } : null;
}
/**
 * 0..1 for an XR binding. xr: gsXrInput ({ presenting, hand(h) → { x, y, buttons[], stickBlocked, buttonsBlocked } }).
 * A hand whose ray is on a VR window reads 0 for its buttons, and a stick
 * that is scrolling a window reads 0, so menu clicks and scrolling never
 * reach the scene.
 */
export function xrValue(b, xr) {
	if (!b || !xr || !xr.presenting) return 0;
	const s = xrStickOf(b);
	if (s) {
		const h = xr.hand(s.hand);
		if (!h || h.stickBlocked) return 0;
		return Math.max(0, s.dir === 'Up' ? -h.y : s.dir === 'Down' ? h.y : s.dir === 'Left' ? -h.x : h.x);
	}
	const btn = xrButtonOf(b);
	if (!btn) return 0;
	const h = xr.hand(btn.hand);
	if (!h || h.buttonsBlocked) return 0;
	return h.buttons[btn.index] || 0;
}

// ---- built-in camera styles ----
// Every row a style has on a game controller / in a headset, with its default.
// key: true rows are the remappable key actions (controlBindings.js, label
// from there); the others stand for a mouse / wheel gesture. pad / xr: the
// default binding; null = that device has no such control (xr null + head:
// your head does it in a headset). loco: what an xr row does to locomotion in a headset (the camera
// follows your head there; the thumbsticks move you). All of them can be
// remapped (controllerBindings.js); main.js reads the current bindings every
// frame (updateGamepadCamera, updateLocomotion).
const ROT = (g) => [
	{ id: 'rotateLeft', label: `Rotate left (${g})`, pad: 'RS-Left', xr: 'R-Stick-Left', loco: 'turnLeft' },
	{ id: 'rotateRight', label: `Rotate right (${g})`, pad: 'RS-Right', xr: 'R-Stick-Right', loco: 'turnRight' },
	{ id: 'rotateUp', label: `Rotate up (${g})`, pad: 'RS-Up', xr: null, head: true },
	{ id: 'rotateDown', label: `Rotate down (${g})`, pad: 'RS-Down', xr: null, head: true }
];
const PAN_KEYS = [
	{ id: 'panUp', key: true, pad: 'DUp', xr: 'L-Stick-Up', loco: 'forward' },
	{ id: 'panDown', key: true, pad: 'DDown', xr: 'L-Stick-Down', loco: 'back' },
	{ id: 'panLeft', key: true, pad: 'DLeft', xr: 'L-Stick-Left', loco: 'left' },
	{ id: 'panRight', key: true, pad: 'DRight', xr: 'L-Stick-Right', loco: 'right' }
];
const RISE = [
	{ id: 'rise', label: 'Move up (VR)', pad: null, xr: 'R-Stick-Up', loco: 'up' },
	{ id: 'sink', label: 'Move down (VR)', pad: null, xr: 'R-Stick-Down', loco: 'down' }
];
export const CONTROLLER_STYLES = {
	orbit: [
		...PAN_KEYS,
		...ROT('left-drag'),
		{ id: 'dragPanLeft', label: 'Pan left (right-drag)', pad: 'LS-Left', xr: null },
		{ id: 'dragPanRight', label: 'Pan right (right-drag)', pad: 'LS-Right', xr: null },
		{ id: 'zoomInStick', label: 'Zoom in (wheel, stick)', pad: 'LS-Up', xr: null },
		{ id: 'zoomOutStick', label: 'Zoom out (wheel, stick)', pad: 'LS-Down', xr: null },
		{ id: 'zoomIn', label: 'Zoom in (wheel, trigger)', pad: 'RT', xr: null },
		{ id: 'zoomOut', label: 'Zoom out (wheel, trigger)', pad: 'LT', xr: null },
		...RISE
	],
	map: [
		...PAN_KEYS,
		{ id: 'dragPanForward', label: 'Pan forward (left-drag)', pad: 'LS-Up', xr: null },
		{ id: 'dragPanBack', label: 'Pan back (left-drag)', pad: 'LS-Down', xr: null },
		{ id: 'dragPanLeft', label: 'Pan left (left-drag)', pad: 'LS-Left', xr: null },
		{ id: 'dragPanRight', label: 'Pan right (left-drag)', pad: 'LS-Right', xr: null },
		...ROT('right-drag'),
		{ id: 'zoomIn', label: 'Zoom in (wheel)', pad: 'RT', xr: null },
		{ id: 'zoomOut', label: 'Zoom out (wheel)', pad: 'LT', xr: null },
		...RISE
	],
	fly: [
		{ id: 'forward', key: true, pad: 'LS-Up', xr: 'L-Stick-Up', loco: 'forward' },
		{ id: 'back', key: true, pad: 'LS-Down', xr: 'L-Stick-Down', loco: 'back' },
		{ id: 'left', key: true, pad: 'LS-Left', xr: 'L-Stick-Left', loco: 'left' },
		{ id: 'right', key: true, pad: 'LS-Right', xr: 'L-Stick-Right', loco: 'right' },
		{ id: 'up', key: true, pad: 'RB', xr: 'R-Stick-Up', loco: 'up' },
		{ id: 'down', key: true, pad: 'LB', xr: 'R-Stick-Down', loco: 'down' },
		{ id: 'pitchUp', key: true, pad: 'RS-Up', xr: null, head: true },
		{ id: 'pitchDown', key: true, pad: 'RS-Down', xr: null, head: true },
		{ id: 'yawLeft', key: true, pad: 'RS-Left', xr: 'R-Stick-Left', loco: 'turnLeft' },
		{ id: 'yawRight', key: true, pad: 'RS-Right', xr: 'R-Stick-Right', loco: 'turnRight' },
		{ id: 'rollLeft', key: true, pad: 'DLeft', xr: null, head: true },
		{ id: 'rollRight', key: true, pad: 'DRight', xr: null, head: true },
		{ id: 'slow', key: true, pad: 'LS-Press', xr: null }
	],
	firstperson: [
		{ id: 'forward', key: true, pad: 'LS-Up', xr: 'L-Stick-Up', loco: 'forward' },
		{ id: 'backward', key: true, pad: 'LS-Down', xr: 'L-Stick-Down', loco: 'back' },
		{ id: 'left', key: true, pad: 'LS-Left', xr: 'L-Stick-Left', loco: 'left' },
		{ id: 'right', key: true, pad: 'LS-Right', xr: 'L-Stick-Right', loco: 'right' },
		{ id: 'lookLeft', label: 'Look left (mouse look)', pad: 'RS-Left', xr: 'R-Stick-Left', loco: 'turnLeft' },
		{ id: 'lookRight', label: 'Look right (mouse look)', pad: 'RS-Right', xr: 'R-Stick-Right', loco: 'turnRight' },
		{ id: 'lookUp', label: 'Look up (mouse look)', pad: 'RS-Up', xr: null, head: true },
		{ id: 'lookDown', label: 'Look down (mouse look)', pad: 'RS-Down', xr: null, head: true },
		...RISE
	]
};
// Game controller buttons that work in every style (gamepad only).
export const GLOBAL_PAD_ROWS = [
	{ id: 'switchMode', label: 'Switch Orbit / First person', pad: 'Y' },
	{ id: 'resetView', label: 'Reset camera view', pad: 'View' }
];
/** Locomotion in a headset when no built-in style is active (Off / a scene's mode). */
export const DEFAULT_LOCOMOTION = { forward: 'L-Stick-Up', back: 'L-Stick-Down', left: 'L-Stick-Left', right: 'L-Stick-Right', turnLeft: 'R-Stick-Left', turnRight: 'R-Stick-Right', up: 'R-Stick-Up', down: 'R-Stick-Down' };

// ---- raw readings for capture (controllerBindings.js) ----
const PAD_INDEX_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS-Press', 'RS-Press', 'DUp', 'DDown', 'DLeft', 'DRight'];
const btnVal = (b) => (!b ? 0 : typeof b === 'number' ? b : (b.pressed && !b.value ? 1 : b.value || 0));
function stickDirs(prefix, x, y, out, sep = '-') {
	out[`${prefix}${sep}Up`] = Math.max(0, -y); out[`${prefix}${sep}Down`] = Math.max(0, y);
	out[`${prefix}${sep}Left`] = Math.max(0, -x); out[`${prefix}${sep}Right`] = Math.max(0, x);
}
/** Every gamepad input of a raw Gamepad → { name: 0..1 } (no deadzone). */
export function padInputsRaw(gp) {
	const out = {};
	if (!gp) return out;
	PAD_INDEX_NAMES.forEach((n, i) => { out[n] = btnVal(gp.buttons?.[i]); });
	const a = gp.axes || [];
	stickDirs('LS', a[0] || 0, a[1] || 0, out);
	stickDirs('RS', a[2] || 0, a[3] || 0, out);
	return out;
}
/** Every input of one headset controller (xr-standard gamepad) → { name: 0..1 }. */
export function xrInputsRaw(hand, gp) {
	const out = {};
	if (!gp || (hand !== 'left' && hand !== 'right')) return out;
	const H = hand === 'left' ? 'L' : 'R';
	const b = gp.buttons || [];
	out[`${H}-Trigger`] = btnVal(b[0]);
	out[`${H}-Squeeze`] = btnVal(b[1]);
	out[`${H}-StickPress`] = btnVal(b[3]);
	out[hand === 'left' ? 'X' : 'A'] = btnVal(b[4]);
	out[hand === 'left' ? 'Y' : 'B'] = btnVal(b[5]);
	const a = gp.axes || [];
	const x = a.length >= 4 ? a[2] : (a[0] || 0), y = a.length >= 4 ? a[3] : (a[1] || 0);
	stickDirs(`${H}-Stick`, x || 0, y || 0, out);
	return out;
}
export const isStickBinding = (b) => /-(Up|Down|Left|Right)$/.test(b || '') && !/^D/.test(b || '');
