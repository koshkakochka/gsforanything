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
// Built-in camera styles: BUILTIN_PAD / BUILTIN_XR give every remappable
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
// [action id → binding]. Orbit / Map pan keys: d-pad. Fly / First person:
// movement on the left stick, look on the right stick.
export const BUILTIN_PAD = {
	orbit: { panUp: 'DUp', panDown: 'DDown', panLeft: 'DLeft', panRight: 'DRight' },
	map: { panUp: 'DUp', panDown: 'DDown', panLeft: 'DLeft', panRight: 'DRight' },
	fly: {
		forward: 'LS-Up', back: 'LS-Down', left: 'LS-Left', right: 'LS-Right', up: 'RB', down: 'LB',
		pitchUp: 'RS-Up', pitchDown: 'RS-Down', yawLeft: 'RS-Left', yawRight: 'RS-Right',
		rollLeft: 'DLeft', rollRight: 'DRight', slow: 'LS-Press'
	},
	firstperson: { forward: 'LS-Up', backward: 'LS-Down', left: 'LS-Left', right: 'LS-Right' }
};
// In a headset: locomotion (Environment → Navigation; left stick moves,
// right stick turns / changes height) and your head.
export const BUILTIN_XR = {
	orbit: { panUp: 'L-Stick-Up', panDown: 'L-Stick-Down', panLeft: 'L-Stick-Left', panRight: 'L-Stick-Right' },
	map: { panUp: 'L-Stick-Up', panDown: 'L-Stick-Down', panLeft: 'L-Stick-Left', panRight: 'L-Stick-Right' },
	fly: {
		forward: 'L-Stick-Up', back: 'L-Stick-Down', left: 'L-Stick-Left', right: 'L-Stick-Right', up: 'R-Stick-Up', down: 'R-Stick-Down',
		pitchUp: '', pitchDown: '', yawLeft: 'R-Stick-Left', yawRight: 'R-Stick-Right', rollLeft: '', rollRight: '', slow: ''
	},
	firstperson: { forward: 'L-Stick-Up', backward: 'L-Stick-Down', left: 'L-Stick-Left', right: 'L-Stick-Right' }
};
// Mouse / wheel / touch gestures and their pad / headset equivalents.
export const BUILTIN_GESTURES = {
	orbit: [['Rotate (left-drag)', 'Right stick', 'Right thumbstick ←/→ turns you'], ['Pan (right-drag)', 'Left stick ←/→', 'Left thumbstick'], ['Zoom (wheel)', 'Left stick ↑/↓, LT / RT', 'Left thumbstick ↑/↓']],
	map: [['Pan (left-drag)', 'Left stick', 'Left thumbstick'], ['Rotate (right-drag)', 'Right stick', 'Right thumbstick ←/→ turns you'], ['Zoom (wheel)', 'LT / RT', 'Left thumbstick ↑/↓']],
	fly: [['Look (drag)', 'Right stick', 'Your head'], ['Up / down', 'RB / LB', 'Right thumbstick ↑/↓']],
	firstperson: [['Mouse look', 'Right stick', 'Your head; right thumbstick ←/→ turns']]
};
export const BUILTIN_GLOBAL_PAD = [['Y', 'Switch Orbit / First person'], ['View', 'Reset Camera View']];
