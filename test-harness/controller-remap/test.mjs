// Remapping game controller and VR controller bindings (controllerBindings.js):
// capture (listen → press), the picker, conflicts, per-device resets, storage,
// and runtime use (stock camera styles, VR locomotion, Custom Controls, custom
// camera mode params).
//   BASE=https://localhost:3762 SHOT_DIR=/workspace/gs-padxr-remap-shots node test.mjs   (SKIP_VR=1 skips IWER)
// navigator.getGamepads is mocked (a standard-mapping Xbox pad whose axes /
// buttons the test sets); the headset is IWER's Meta Quest 3 (mocked XR input
// sources). /api/chat is stubbed; dummy keys; Community writes blocked.
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3762';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-padxr-remap-shots';
const SKIP_VR = process.env.SKIP_VR === '1';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const dist = (a, c) => Math.hypot(...a.map((v, i) => v - c[i]));

// Mocked Gamepad API: one standard pad. __pad.set({ axes: [lx, ly, rx, ry], press: { 12: 1 } }).
const PAD_MOCK = `(() => {
  const mk = () => ({ pressed: false, touched: false, value: 0 });
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, mk), timestamp: 0, vibrationActuator: null };
  window.__pad = {
    pad, on: true,
    set({ axes, press } = {}) {
      if (axes) pad.axes = axes.slice();
      if (press) for (const [i, v] of Object.entries(press)) pad.buttons[+i] = { pressed: v > 0.5, touched: v > 0, value: v };
      pad.timestamp = performance.now();
    },
    clear() { pad.axes = [0, 0, 0, 0]; pad.buttons = Array.from({ length: 17 }, mk); }
  };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [window.__pad.on ? pad : null, null, null, null] });
})();`;
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, View: 8, Menu: 9, LS: 10, RS: 11, Up: 12, Down: 13, Left: 14, Right: 15 };

// Stubbed chat reply: a car scheme (keys only: pad / VR bindings auto-generated,
// except the horn which says gamepad 'Y' explicitly) — no cameraMode, so the
// camera stays on the built-in mode and the scheme's d-pad claim matters.
const CAR_CODE = `
const car = gsControls.defineCustomScheme({
  id: 'car', name: 'Car', description: 'Drive the red box.',
  params: [
    { name: 'accelerate', label: 'Accelerate', type: 'key', default: 'W' },
    { name: 'brake', label: 'Brake', type: 'key', default: 'S' },
    { name: 'steerLeft', label: 'Steer left', type: 'key', default: 'A' },
    { name: 'steerRight', label: 'Steer right', type: 'key', default: 'D' },
    { name: 'lights', label: 'Lights', type: 'key', default: 'ArrowUp' },
    { name: 'boost', label: 'Boost', type: 'key', default: 'Space' },
    { name: 'shoot', label: 'Shoot', type: 'key', default: 'F' },
    { name: 'horn', label: 'Horn', type: 'key', default: 'H', gamepad: 'Y', xr: 'B' },
    { name: 'topSpeed', label: 'Top speed', type: 'number', default: 8, min: 2, max: 20, step: 1 }
  ]
});
const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 1), new THREE.MeshStandardMaterial({ color: 0xff3333 }));
box.name = 'padCar'; box.position.set(0, 0.15, -3); scene.add(box);
window.__car = { box, horns: 0, boosts: 0, shots: 0, handle: car };
car.onPress('horn', () => window.__car.horns++);
car.onPress('shoot', () => window.__car.shots++);
car.onPress('boost', () => window.__car.boosts++);
gs.onUpdate((t) => { const dt = 1 / 60; box.position.z -= car.value('accelerate') * car.values.topSpeed * 0.2 * dt; });
`;
const REPLY = 'Here is a drivable car (keyboard, game controller and VR).\n```vr-exec\n' + CAR_CODE + '\n```';

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.createBrowserContext();

async function openPage(viewport, { mobile = false, xr = false } = {}) {
	const p = await ctx.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
	if (mobile) await p.setUserAgent(PHONE_UA);
	await p.setViewport(viewport);
	await p.evaluateOnNewDocument(PAD_MOCK);
	if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const u = new URL(req.url());
		if (u.pathname.startsWith('/api/')) {
			if (u.pathname === '/api/chat') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: REPLY }] }) });
			if (u.pathname === '/api/prompts') return req.continue();
			if (req.method() !== 'GET') return req.respond({ status: 503, body: 'blocked' });
			const body = u.pathname === '/api/backends' ? '{"backends":{"claude":{"label":"Claude","provider":"claude","available":true}},"default":"claude"}'
				: (u.pathname.startsWith('/api/community-scenes') ? '{"scenes":[]}' : '{}');
			return req.respond({ status: 200, contentType: 'application/json', body });
		}
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.renderer && window.gsControls?.inputBindings && window.gsXrInput && document.getElementById('gs-menu-hamburger'), { timeout: 30000 });
	await sleep(700);
	p._errors = errors;
	return p;
}
async function openControls(p, section = 'camera') {
	await p.evaluate(() => { const c = document.getElementById('desktop-chat'); if (!c?.classList.contains('gs-tab-menu-open')) document.getElementById('gs-menu-hamburger')?.click(); });
	await sleep(200);
	await p.evaluate(() => window.gsSelectTab('controls'));
	await sleep(250);
	await p.evaluate((s) => document.querySelector(`#dchat-controls-subtabs [data-controls-section="${s}"]`)?.click(), section);
	await sleep(200);
}
const setMode = async (p, m) => { await p.evaluate((m) => gsControls.setMode(m), m); await sleep(250); };
const blur = (p) => p.evaluate(() => { document.activeElement?.blur?.(); document.body.focus(); });
const pad = (p, o) => p.evaluate((o) => window.__pad.set(o), o);
const padClear = (p) => p.evaluate(() => window.__pad.clear());
const cam = (p) => p.evaluate(() => ({ pos: camera.position.toArray(), q: camera.quaternion.toArray(), target: gsControls.controls?.target?.toArray() || null, mult: gsControls.controls?.movementSpeedMultiplier }));
async function hold(p, o, ms = 500) { await pad(p, o); await sleep(ms); await padClear(p); await sleep(900); } // damping settles
// Displacement in the camera's frame at the start: { fwd, right, up }.
const moveInView = (p, c0, c1) => p.evaluate((a, b) => { const T = THREE; const d = new T.Vector3().fromArray(b.pos).sub(new T.Vector3().fromArray(a.pos)); const q = new T.Quaternion().fromArray(a.q); const f = new T.Vector3(0, 0, -1).applyQuaternion(q); f.y = 0; f.normalize(); const r = new T.Vector3(1, 0, 0).applyQuaternion(q); r.y = 0; r.normalize(); return { fwd: d.dot(f), right: d.dot(r), up: d.y }; }, c0, c1);
async function sendChat(p) {
	await p.evaluate(() => {
		window.gsSelectTab('chat');
		const i = document.getElementById('desktop-chat-input');
		i.value = 'make a drivable car'; i.dispatchEvent(new Event('input', { bubbles: true }));
		document.getElementById('desktop-send-button').click();
	});
	await p.waitForFunction(() => window.__car, { timeout: 15000 }).catch(() => {});
	await sleep(400);
}

const KEY = 'gs.controllerBindings.v1';
const stored = (p) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY);
const fieldState = (p, sel) => p.evaluate((s) => {
	const el = document.querySelector(s);
	if (!el) return null;
	return { listening: el.classList.contains('listening'), binding: el.dataset.binding, remapped: el.dataset.remapped === '1', text: el.textContent, picker: !!document.querySelector('.gs-bind-picker'), capture: window.gsControllerBindings.capture.listening };
}, sel);
async function clickField(p, sel) {
	await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
	await sleep(120);
	await p.click(sel);
	await sleep(150);
}
const pick = async (p, binding) => { await p.click(`.gs-bind-picker .gs-bind-option[data-binding="${binding}"]`); await sleep(200); };
const warnText = (p, sel = '#dchat-key-remap-warning') => p.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
async function press(p, idx, v = 1, ms = 200) { await pad(p, { press: { [idx]: v } }); await sleep(ms); await padClear(p); await sleep(200); }

// ======================================================= desktop: stock styles
{
	const p = await openPage({ width: 1280, height: 800 });
	await pad(p, { press: { [B.A]: 1 } }); await sleep(150); await padClear(p); await sleep(200);
	check('no controller bindings stored at first (new key gs.controllerBindings.v1)', (await stored(p)) === null);
	await setMode(p, 'map');
	await openControls(p, 'camera');
	const F = (id, d) => `#gs-remap-map-${id}-${d}`;
	const ui = await p.evaluate(() => ({
		pad: document.querySelectorAll('#dchat-key-remap button.gs-bind-field[data-kind="gamepad"]').length,
		xr: document.querySelectorAll('#dchat-key-remap button.gs-bind-field[data-kind="xr"]').length,
		resets: ['dchat-pad-remap-reset', 'dchat-xr-remap-reset'].map((id) => document.getElementById(id)?.disabled)
	}));
	check('Map: every row has a clickable Gamepad field (16 incl. Y / View) and VR field (8), per-device resets (disabled at defaults)', ui.pad === 16 && ui.xr === 8 && ui.resets.join() === 'true,true', ui);

	// capture: click → listening + picker; Esc cancels
	await clickField(p, F('panUp', 'gamepad'));
	let st = await fieldState(p, F('panUp', 'gamepad'));
	check('click a Gamepad field → listening ("Press…") with the picker under the row', st.listening && st.picker && st.capture === 'gamepad' && /Press…/.test(st.text), st);
	await p.evaluate(() => document.querySelector('.gs-bind-picker')?.scrollIntoView({ block: 'center' }));
	await sleep(150);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-controls-listening.png` });
	await p.keyboard.press('Escape'); await sleep(150);
	st = await fieldState(p, F('panUp', 'gamepad'));
	check('Esc cancels (binding unchanged, picker gone)', !st.listening && !st.picker && st.binding === 'DUp' && !st.capture, st);
	// click elsewhere cancels
	await clickField(p, F('panUp', 'gamepad'));
	await p.click('#dchat-key-remap .gs-remap-head .dchat-section-label'); await sleep(150);
	st = await fieldState(p, F('panUp', 'gamepad'));
	check('a click elsewhere cancels', !st.listening && !st.picker && st.binding === 'DUp', st);

	// a button already held when listening starts must be let go first
	await pad(p, { press: { [B.A]: 1 } }); await sleep(100);
	await clickField(p, F('panUp', 'gamepad'));
	await sleep(400);
	st = await fieldState(p, F('panUp', 'gamepad'));
	check('a button held before listening is not taken (must be released first)', st.listening && st.binding === 'DUp', st);
	await padClear(p); await sleep(150);
	await press(p, B.RB);
	st = await fieldState(p, F('panUp', 'gamepad'));
	check('pressing RB on the pad assigns it (Pan forward = RB)', !st.listening && st.binding === 'RB' && st.remapped && /Gamepad RB/.test(st.text), st);
	check('… stored in gs.controllerBindings.v1', (await stored(p))?.styles?.map?.gamepad?.panUp === 'RB', await stored(p));
	check('… reported by gsControls.inputBindings', await p.evaluate(() => gsControls.inputBindings('map').actions.find((a) => a.id === 'panUp').gamepad) === 'RB');
	await blur(p);
	// runtime: RB pans now, d-pad ↑ no longer
	let c0 = await cam(p); await hold(p, { press: { [B.RB]: 1 } }); let c1 = await cam(p);
	check('runtime: RB now pans the Map view (remapped Pan forward)', dist(c0.target, c1.target) > 0.1, { c0: c0.target, c1: c1.target });
	await sleep(1500); // Map damping settles
	c0 = await cam(p); await hold(p, { press: { [B.Up]: 1 } }); c1 = await cam(p);
	check('runtime: d-pad ↑ (old binding) does nothing now', dist(c0.target, c1.target) < 0.01, { c0: c0.target, c1: c1.target });

	// stick capture + conflict refused
	await clickField(p, F('panDown', 'gamepad'));
	await pad(p, { axes: [0, 0, 0, 0.5] }); await sleep(250);
	st = await fieldState(p, F('panDown', 'gamepad'));
	check('a small stick push (½) is not taken (threshold ¾)', st.listening, st);
	await pad(p, { axes: [0, 0, 0, 0.95] }); await sleep(250); await padClear(p); await sleep(150);
	st = await fieldState(p, F('panDown', 'gamepad'));
	const w1 = await warnText(p);
	check('pushing the right stick ↓ is captured but refused: Rotate down already uses it', !st.listening && st.binding === 'DDown' && /RS ↓ is already Rotate down/.test(w1), { st, w1 });
	// picker (no device needed)
	await clickField(p, F('panDown', 'gamepad'));
	await pick(p, 'Menu');
	st = await fieldState(p, F('panDown', 'gamepad'));
	check('picker: choosing "Menu" from the list assigns it', st.binding === 'Menu' && !st.listening && !st.picker, st);
	await clickField(p, F('panLeft', 'gamepad'));
	await pick(p, 'RB');
	st = await fieldState(p, F('panLeft', 'gamepad'));
	check('picker: an input another row uses is refused too (RB = Pan forward)', st.binding === 'DLeft' && /RB is already Pan forward/.test(await warnText(p)), { st, w: await warnText(p) });
	await clickField(p, F('zoomOut', 'gamepad'));
	await pick(p, '');
	st = await fieldState(p, F('zoomOut', 'gamepad'));
	check('picker: None clears a binding', st.binding === '' && /Gamepad —/.test(st.text), st);
	// global button: Switch Orbit / First person → RS press
	await clickField(p, '#gs-remap-global-switchMode-gamepad');
	await press(p, B.RS);
	st = await fieldState(p, '#gs-remap-global-switchMode-gamepad');
	check('global button remapped by pressing it (Switch Orbit / First person = RS press)', st.binding === 'RS-Press', st);
	await blur(p);
	await setMode(p, 'orbit');
	await press(p, B.Y, 1, 250);
	const afterY = await p.evaluate(() => gsControls.mode);
	await press(p, B.RS, 1, 250);
	const afterRS = await p.evaluate(() => gsControls.mode);
	check('runtime: Y no longer switches; RS press switches Orbit → First person', afterY === 'orbit' && afterRS === 'firstperson', { afterY, afterRS });
	await setMode(p, 'map');
	await openControls(p, 'camera');
	// VR column via picker
	await clickField(p, F('panUp', 'xr'));
	st = await fieldState(p, F('panUp', 'xr'));
	check('VR field listens too (desktop: picker lists VR inputs)', st.listening && st.capture === 'xr' && await p.evaluate(() => document.querySelectorAll('.gs-bind-picker[data-kind="xr"] .gs-bind-option').length) === 20, st);
	await pick(p, 'R-Trigger');
	check('VR binding picked (Pan forward VR = R trigger)', (await fieldState(p, F('panUp', 'xr'))).binding === 'R-Trigger' && (await stored(p))?.styles?.map?.xr?.panUp === 'R-Trigger');
	await clickField(p, F('panDown', 'xr'));
	await pick(p, 'R-Trigger');
	check('VR conflict refused (R trigger = Pan forward)', (await fieldState(p, F('panDown', 'xr'))).binding === 'L-Stick-Down' && /VR R trigger is already Pan forward/.test(await warnText(p)), await warnText(p));
	// persists across a reload
	await p.reload({ waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.renderer && window.gsControls?.inputBindings && document.getElementById('gs-menu-hamburger'), { timeout: 30000 });
	await sleep(600);
	await setMode(p, 'map');
	await openControls(p, 'camera');
	const re = await p.evaluate(() => ({ g: document.querySelector('#gs-remap-map-panUp-gamepad')?.dataset.binding, x: document.querySelector('#gs-remap-map-panUp-xr')?.dataset.binding, r: document.querySelector('#gs-remap-map-panUp-gamepad')?.dataset.remapped, pr: document.getElementById('dchat-pad-remap-reset').disabled, xr: document.getElementById('dchat-xr-remap-reset').disabled }));
	check('after reload: remapped bindings come back from storage (marked remapped, resets enabled)', re.g === 'RB' && re.x === 'R-Trigger' && re.r === '1' && !re.pr && !re.xr, re);
	await p.evaluate(() => document.getElementById('dchat-key-remap').scrollIntoView({ block: 'start' }));
	await sleep(150);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-controls-remapped.png` });
	// Reset gamepad: gamepad back, VR kept
	await p.click('#dchat-pad-remap-reset'); await sleep(200);
	const rs = await p.evaluate(() => ({ g: document.querySelector('#gs-remap-map-panUp-gamepad').dataset.binding, x: document.querySelector('#gs-remap-map-panUp-xr').dataset.binding, sw: document.querySelector('#gs-remap-global-switchMode-gamepad').dataset.binding }));
	const s2 = await stored(p);
	check('Reset gamepad: gamepad defaults back (incl. Y), VR remap kept', rs.g === 'DUp' && rs.sw === 'Y' && rs.x === 'R-Trigger' && !s2.styles.map.gamepad && !s2.styles.global && s2.styles.map.xr.panUp === 'R-Trigger', { rs, s2 });
	await p.click('#dchat-xr-remap-reset'); await sleep(200);
	check('Reset VR: VR defaults back; nothing left stored', (await fieldState(p, F('panUp', 'xr'))).binding === 'L-Stick-Up' && (await stored(p)) === null, await stored(p));

	// Fly: capture by trigger; runtime uses it at once
	await setMode(p, 'fly');
	await openControls(p, 'camera');
	await clickField(p, '#gs-remap-fly-up-gamepad');
	await press(p, B.RT, 0.8);
	check('Fly: pushing RT past half assigns it to Move up', (await fieldState(p, '#gs-remap-fly-up-gamepad')).binding === 'RT');
	await blur(p);
	c0 = await cam(p); await hold(p, { press: { [B.RT]: 1 } }); c1 = await cam(p);
	const upRT = c1.pos[1] - c0.pos[1];
	c0 = await cam(p); await hold(p, { press: { [B.RB]: 1 } }); c1 = await cam(p);
	const upRB = c1.pos[1] - c0.pos[1];
	check('runtime: RT moves up in Fly right away; RB no longer does', upRT > 0.3 && Math.abs(upRB) < 1e-3, { upRT, upRB });
	// typing pauses capture? listening also pauses the camera
	await clickField(p, '#gs-remap-fly-forward-gamepad');
	c0 = await cam(p);
	await pad(p, { axes: [0, -0.5, 0, 0] }); await sleep(400); await padClear(p); await sleep(300);
	c1 = await cam(p);
	check('while listening the pad does not move the camera', dist(c0.pos, c1.pos) < 1e-3, { c0: c0.pos, c1: c1.pos });
	await p.keyboard.press('Escape'); await sleep(100);
	await p.evaluate(() => gsControls.setControllerBinding('fly', 'gamepad', 'up', 'RB'));
	check('desktop (stock): no console errors', p._errors.length === 0, p._errors);
	await p.close();
}

// ======================================================= desktop: Custom Controls
{
	const p = await openPage({ width: 1280, height: 800 });
	await pad(p, { press: { [B.A]: 1 } }); await sleep(150); await padClear(p); await sleep(200);
	await setMode(p, 'map');
	await sendChat(p);
	await openControls(p, 'custom');
	const C = (n, d) => `#gs-cc-car-${n}-${d}`;
	const n0 = await p.evaluate(() => ({ fields: document.querySelectorAll('.gs-cc-scheme[data-scheme-id="car"] button.gs-bind-field').length, resets: [...document.querySelectorAll('.gs-cc-scheme[data-scheme-id="car"] .gs-cc-reset-bind')].map((b) => b.textContent + ':' + b.disabled) }));
	check('Custom Controls: 16 clickable Gamepad / VR fields and Reset gamepad / Reset VR (disabled at defaults)', n0.fields === 16 && n0.resets.join() === 'Reset gamepad:true,Reset VR:true', n0);
	await clickField(p, C('accelerate', 'gamepad'));
	let st = await fieldState(p, C('accelerate', 'gamepad'));
	check('Custom Controls field listens on click (picker under the row)', st.listening && st.picker, st);
	await press(p, B.RT, 0.9);
	st = await fieldState(p, C('accelerate', 'gamepad'));
	check('pressing RT assigns it to Accelerate (marked remapped)', st.binding === 'RT' && st.remapped && /Gamepad RT/.test(st.text), st);
	const sv = await stored(p);
	check('… stored per scheme param (schemes.car.gamepad.accelerate)', sv?.schemes?.car?.gamepad?.accelerate === 'RT', sv);
	await blur(p);
	await pad(p, { press: { [B.RT]: 0.7 } }); await sleep(200);
	const rt = await p.evaluate(() => ({ d: __car.handle.isDown('accelerate'), v: __car.handle.value('accelerate'), b: __car.handle.bindings('accelerate') }));
	await padClear(p);
	await pad(p, { axes: [0, -1, 0, 0] }); await sleep(200);
	const ls = await p.evaluate(() => __car.handle.isDown('accelerate'));
	await padClear(p); await sleep(150);
	check('runtime: RT drives isDown / value("accelerate") at once; left stick ↑ no longer', rt.d && Math.abs(rt.v - 0.7) < 0.01 && rt.b.gamepad === 'RT' && !ls, { rt, ls });
	// onPress follows a remap
	await clickField(p, C('horn', 'gamepad'));
	await pick(p, 'LB');
	await blur(p);
	const h0 = await p.evaluate(() => __car.horns);
	await press(p, B.Y); await press(p, B.LB);
	const h1 = await p.evaluate(() => __car.horns);
	check('onPress follows the remap (Horn: LB fires, Y no longer)', h1 - h0 === 1, { h0, h1 });
	// conflict refused
	await clickField(p, C('brake', 'gamepad'));
	await pick(p, 'LB');
	st = await fieldState(p, C('brake', 'gamepad'));
	const cw = await p.evaluate(() => document.querySelector('.gs-cc-scheme[data-scheme-id="car"] .gs-cc-warning')?.textContent || '');
	check('Custom Controls refuses an input another param of the scheme uses (LB = Horn)', st.binding === 'LS-Down' && /Gamepad LB is already Horn/.test(cw), { st, cw });
	// capture presses don't reach the scheme
	const b0 = await p.evaluate(() => __car.boosts);
	await clickField(p, C('boost', 'gamepad'));
	await press(p, B.RB, 1, 400);
	const b1 = await p.evaluate(() => __car.boosts);
	await press(p, B.RB);
	const b2 = await p.evaluate(() => __car.boosts);
	check('the press that gets assigned does not also reach the scene (no onPress until the next press)', b1 === b0 && b2 === b0 + 1 && (await fieldState(p, C('boost', 'gamepad'))).binding === 'RB', { b0, b1, b2 });
	// VR column
	await clickField(p, C('horn', 'xr'));
	await pick(p, 'R-Squeeze');
	check('VR field: Horn → R grip (picked)', (await fieldState(p, C('horn', 'xr'))).binding === 'R-Squeeze' && (await stored(p)).schemes.car.xr.horn === 'R-Squeeze');
	await p.evaluate(() => document.querySelector('.gs-cc-scheme[data-scheme-id="car"]').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-custom-controls-remapped.png` });
	const rows = await p.evaluate(() => [...document.querySelectorAll('.gs-cc-scheme[data-scheme-id="car"] .gs-cc-param[data-type="key"]')].map((r) => [r.querySelector('label').textContent, r.querySelector('input').value, ...[...r.querySelectorAll('.gs-bind-chip')].map((c) => c.textContent + (c.dataset.remapped === '1' ? ' *' : ''))].join(' | ')));
	fs.writeFileSync(`${SHOT_DIR}/custom-controls-remapped-rows.txt`, rows.join('\n') + '\n');
	// redefine keeps the overrides; describe() reports them
	await p.evaluate((code) => new Function('THREE', 'scene', 'camera', 'gs', code)(THREE, scene, camera, { onUpdate() {}, on() {}, onDispose() {} }), CAR_CODE);
	await sleep(300);
	const ds = await p.evaluate(() => gsControls.customSchemes.find((s) => s.id === 'car'));
	check('re-defining the scheme keeps the remaps (describe().bindings / remapped)', ds.bindings.accelerate.gamepad === 'RT' && ds.bindings.horn.xr === 'R-Squeeze' && ds.remapped.gamepad.horn === 'LB', ds.remapped);
	// reload: stored overrides apply when the scene defines the scheme again
	await p.reload({ waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.renderer && window.gsControls?.inputBindings && document.getElementById('gs-menu-hamburger'), { timeout: 30000 });
	await sleep(600);
	await sendChat(p);
	check('after reload: the scheme picks its remaps up from storage', await p.evaluate(() => __car.handle.bindings('accelerate').gamepad === 'RT' && __car.handle.bindings('horn').xr === 'R-Squeeze'));
	await openControls(p, 'custom');
	await p.click('.gs-cc-scheme[data-scheme-id="car"] .gs-cc-reset-bind[data-kind="gamepad"]'); await sleep(200);
	const rr = await p.evaluate(() => ({ a: __car.handle.bindings('accelerate'), h: __car.handle.bindings('horn'), key: __car.handle.values.accelerate }));
	check('Reset gamepad (card): gamepad defaults back, VR remap and keys untouched', rr.a.gamepad === 'LS-Up' && rr.h.gamepad === 'Y' && rr.h.xr === 'R-Squeeze' && rr.key === 'KeyW', rr);
	await p.click('.gs-cc-scheme[data-scheme-id="car"] .gs-cc-reset-bind[data-kind="xr"]'); await sleep(200);
	check('Reset VR (card): VR defaults back, nothing stored', await p.evaluate(() => __car.handle.bindings('horn').xr === 'B') && (await stored(p)) === null, await stored(p));
	check('desktop (Custom Controls): no console errors', p._errors.length === 0, p._errors);
	await p.close();
}

// ============ custom camera mode params (sample third-person scene)
const TPS_CODE = `
const player = new THREE.Group(); player.name = 'tpsPlayer';
const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1, 4, 8), new THREE.MeshStandardMaterial({ color: 0x3b82f6 }));
body.position.y = 0.8; player.add(body); scene.add(player);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x4b5563 }));
ground.rotation.x = -Math.PI / 2; scene.add(ground);
let yaw = 0, vy = 0;
const tps = gsControls.registerCameraMode({
  id: 'tps', label: 'Custom 3rd Person Controls', description: 'The camera follows the player.', sticks: true,
  params: [
    { name: 'forward', label: 'Move forward', type: 'key', default: 'W' },
    { name: 'back', label: 'Move back', type: 'key', default: 'S' },
    { name: 'left', label: 'Strafe left', type: 'key', default: 'A' },
    { name: 'right', label: 'Strafe right', type: 'key', default: 'D' },
    { name: 'jump', label: 'Jump', type: 'key', default: 'Space' },
    { name: 'fire', label: 'Fire', type: 'key', default: 'F', gamepad: 'RT', xr: 'R-Trigger' },
    { name: 'reload', label: 'Reload', type: 'key', default: 'R' },
    { name: 'distance', label: 'Camera distance', type: 'number', default: 4, min: 2, max: 10, step: 0.5, unit: 'm' }
  ],
  update(dt, m) {
    const s = m.sticks();
    const f = m.value('forward') - m.value('back') - s.ly, r = m.value('right') - m.value('left') + s.lx;
    yaw -= s.rx * 2 * dt;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    player.position.addScaledVector(fwd, f * 4 * dt).addScaledVector(side, r * 4 * dt);
    camera.position.copy(player.position).addScaledVector(fwd, -m.values.distance).add(new THREE.Vector3(0, 2, 0));
    camera.lookAt(player.position.x, 1.2, player.position.z);
  }
});
window.__tps = { player, handle: tps };
`;
for (const [vp, opt, name] of [[{ width: 1280, height: 800 }, {}, 'desktop'], [{ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { mobile: true }, 'phone']]) {
	const p = await openPage(vp, opt);
	await pad(p, { press: { [B.A]: 1 } }); await sleep(150); await padClear(p); await sleep(200);
	await p.evaluate((code) => new Function('THREE', 'scene', 'camera', 'gs', code)(THREE, scene, camera, { onUpdate() {}, on() {}, onDispose() {} }), TPS_CODE);
	await sleep(300);
	await p.evaluate(() => gsControls.setMode('custom:tps')); await sleep(300);
	await openControls(p, 'custom');
	await sleep(200);
	const J = (d) => `#gs-cc-camera_tps-jump-${d}`;
	await clickField(p, J('gamepad'));
	if (name === 'phone') {
		const ov = await p.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, picker: !!document.querySelector('.gs-bind-picker'), opts: document.querySelectorAll('.gs-bind-picker .gs-bind-option').length }));
		check('phone: listening field + picker fit (no horizontal overflow)', !ov.overflow && ov.picker && ov.opts === 26, ov);
		await p.screenshot({ path: `${SHOT_DIR}/phone-custom-controls-listening.png` });
		await p.tap('.gs-bind-picker .gs-bind-option[data-binding="B"]'); await sleep(200);
	} else {
		await press(p, B.B);
	}
	const jb = await p.evaluate(() => __tps.handle.bindings('jump'));
	check(`${name}: custom camera mode control remapped (Jump: Gamepad B)`, jb.gamepad === 'B', jb);
	await blur(p);
	await pad(p, { press: { [B.B]: 1 } }); await sleep(150);
	const jB = await p.evaluate(() => __tps.handle.isDown('jump'));
	await padClear(p); await pad(p, { press: { [B.A]: 1 } }); await sleep(150);
	const jA = await p.evaluate(() => __tps.handle.isDown('jump'));
	await padClear(p);
	check(`${name}: Gamepad B jumps now, A no longer`, jB && !jA, { jB, jA });
	if (name === 'phone') {
		await clickField(p, J('xr'));
		await p.tap('.gs-bind-picker .gs-bind-option[data-binding="R-Squeeze"]'); await sleep(200);
		await p.evaluate(() => document.querySelector('#gs-cc-camera_tps-jump-gamepad').scrollIntoView({ block: 'center' }));
		await sleep(200);
		const ov = await p.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, rowOverflow: [...document.querySelectorAll('.gs-cc-param')].some((r) => r.scrollWidth > r.clientWidth + 1) }));
		check('phone: remapped Custom Controls card fits', !ov.overflow && !ov.rowOverflow, ov);
		await p.screenshot({ path: `${SHOT_DIR}/phone-custom-controls-remapped.png` });
		// Controls tab on the phone with a field listening
		await setMode(p, 'fly');
		await openControls(p, 'camera');
		await clickField(p, '#gs-remap-fly-up-gamepad');
		await p.evaluate(() => document.querySelector('.gs-bind-picker')?.scrollIntoView({ block: 'center' }));
		await sleep(200);
		const ov2 = await p.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, listening: document.querySelector('#gs-remap-fly-up-gamepad').classList.contains('listening') }));
		check('phone: Controls tab field listening, fits', !ov2.overflow && ov2.listening, ov2);
		await p.screenshot({ path: `${SHOT_DIR}/phone-controls-listening.png` });
		await p.tap('.gs-bind-picker .gs-bind-cancel'); await sleep(150);
		check('phone: Cancel stops listening', !(await fieldState(p, '#gs-remap-fly-up-gamepad')).listening);
	} else {
		await p.evaluate(() => document.querySelector('.gs-cc-scheme[data-scheme-id="camera.tps"]').scrollIntoView({ block: 'start' }));
		await sleep(200);
		await p.screenshot({ path: `${SHOT_DIR}/desktop-tps-remapped.png` });
	}
	check(`${name}: no console errors (sample scene)`, p._errors.length === 0, p._errors);
	await p.close();
}

// ============================================================== VR (IWER Quest 3)
if (!SKIP_VR) {
	const p = await openPage({ width: 1600, height: 900 }, { xr: true });
	await p.evaluate(() => { localStorage.removeItem('gs.controllerBindings.v1'); window.gsControllerBindings.reloadControllerBindings(); });
	await setMode(p, 'map');
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
	check('VR: entered immersive session', await p.evaluate(() => renderer.xr.isPresenting));
	await sleep(1500);
	await p.evaluate(() => {
		const V = THREE.Vector3;
		window.__t = {
			win: (n) => window.__gsVrWindows.byName(n),
			pointFor(el, winName) {
				const w = this.win(winName); const sr = w.source.getBoundingClientRect(); const r = el.getBoundingClientRect();
				const u = (r.left + r.width / 2 - sr.left) / sr.width, v = 1 - (r.top + r.height / 2 - sr.top) / sr.height;
				w.mesh.updateMatrixWorld(true);
				return w.mesh.localToWorld(new V(u - 0.5, v - 0.5, 0.0));
			},
			aim(hand, target) {
				const c = [0, 1].map((i) => renderer.xr.getController(i)).find((x) => x.userData.handedness === hand);
				const xrCam = renderer.xr.getCamera(); const head = new V(); xrCam.getWorldPosition(head);
				const origin = head.clone().add(new V(hand === 'right' ? 0.15 : -0.15, -0.3, -0.1));
				const parent = c.parent; parent.updateMatrixWorld(true);
				const inv = parent.matrixWorld.clone().invert();
				const o = origin.clone().applyMatrix4(inv), t = target.clone().applyMatrix4(inv);
				const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(o, t, new V(0, 1, 0)));
				const dc = window.__xrDevice.controllers[hand];
				dc.position.set(o.x, o.y, o.z); dc.quaternion.set(q.x, q.y, q.z, q.w);
			},
			aimAt(hand, el, winName) { this.aim(hand, this.pointFor(el, winName)); },
			// Point at the floor far from the menu.
			aimAway(hand) { const xrCam = renderer.xr.getCamera(); const h = new V(); xrCam.getWorldPosition(h); this.aim(hand, h.clone().add(new V(hand === 'right' ? 3 : -3, -1.5, 2))); },
			btn(hand, id, v) { window.__xrDevice.controllers[hand].updateButtonValue(id, v); },
			stick(hand, x, y) { window.__xrDevice.controllers[hand].updateAxes('thumbstick', x, y); }
		};
		__t.aimAway('left'); __t.aimAway('right');
	});
	await sleep(500);
	const rig = () => p.evaluate(() => gsVrInput.playerPosition().toArray());
	const rays = () => p.evaluate(() => [0, 1].map((i) => renderer.xr.getController(i)).map((c) => c.children.filter((x) => x.isLine).map((l) => l.visible)).flat());
	// open Controls → Camera in the VR menu
	await p.evaluate(() => { window.gsSelectTab('controls'); document.querySelector('#dchat-controls-subtabs [data-controls-section="camera"]')?.click(); });
	await sleep(600);
	const FX = '#gs-remap-map-panUp-xr';
	await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), FX);
	await sleep(800);
	// trigger-click the VR field with the right ray
	await p.evaluate((s) => __t.aimAt('right', document.querySelector(s), 'menu'), FX);
	await sleep(500);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(250);
	await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(600);
	let st = await fieldState(p, FX);
	check('VR: trigger-click on the menu field starts listening; that trigger is not taken as the binding', st.listening && st.capture === 'xr' && st.binding === 'L-Stick-Up', st);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(300);
	await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(300);
	st = await fieldState(p, FX);
	// the second pull clicked the (listening) field again → cancel, never assigned
	check('VR: the pointing hand\'s trigger is the menu\'s — never captured (click on the field again cancels)', st.binding === 'L-Stick-Up' && !st.listening, st);
	// listen again, then press A (right controller): assigned, ray toggle / push-to-talk step aside
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(400);
	check('VR: listening again', (await fieldState(p, FX)).listening);
	await p.screenshot({ path: `${SHOT_DIR}/vr-listening-mirror.png` });
	const r0b = await rays();
	await p.evaluate(() => __t.btn('right', 'b-button', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'b-button', 0)); await sleep(250);
	st = await fieldState(p, FX);
	const r1b = await rays();
	check('VR: B pressed while listening is captured (Pan forward VR = B); the ray toggle does not fire', st.binding === 'B' && !st.listening && JSON.stringify(r0b) === JSON.stringify(r1b), { st, r0b, r1b });
	// runtime: B moves you forward, left stick ↑ no longer
	await p.evaluate(() => { __t.aimAway('left'); __t.aimAway('right'); }); await sleep(300);
	let r0 = await rig();
	await p.evaluate(() => __t.btn('right', 'b-button', 1)); await sleep(600); await p.evaluate(() => __t.btn('right', 'b-button', 0)); await sleep(200);
	let r1 = await rig();
	const byB = dist(r0, r1);
	const rv0 = await rays();
	r0 = await rig();
	await p.evaluate(() => __t.stick('left', 0, -1)); await sleep(600); await p.evaluate(() => __t.stick('left', 0, 0)); await sleep(200);
	r1 = await rig();
	const byStick = dist(r0, r1);
	check('VR runtime: holding B moves you (remapped forward) and does not toggle the rays; left stick ↑ no longer moves you', byB > 0.3 && byStick < 0.02 && JSON.stringify(rv0) === JSON.stringify(r0b), { byB, byStick });
	// capture with the hand pointing away: its trigger counts
	await p.evaluate(() => document.querySelector('#gs-remap-map-panDown-xr').click()); await sleep(450);
	await p.evaluate(() => __t.btn('left', 'trigger', 1)); await sleep(250); await p.evaluate(() => __t.btn('left', 'trigger', 0)); await sleep(250);
	check('VR: a trigger pulled while pointing away from the menu is captured (Pan back = L trigger)', (await fieldState(p, '#gs-remap-map-panDown-xr')).binding === 'L-Trigger');
	// left stick capture for a Custom Controls param
	await p.evaluate((code) => new Function('THREE', 'scene', 'camera', 'gs', code)(THREE, scene, camera, { onUpdate() {}, on() {}, onDispose() {} }), CAR_CODE);
	await sleep(300);
	await p.evaluate(() => { window.gsSelectTab('controls'); document.querySelector('#dchat-controls-subtabs [data-controls-section="custom"]')?.click(); });
	await sleep(400);
	const boosts0 = await p.evaluate(() => __car.boosts);
	await p.evaluate(() => document.querySelector('#gs-cc-car-boost-xr').click()); await sleep(450);
	await p.evaluate(() => __t.btn('right', 'squeeze', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'squeeze', 0)); await sleep(250);
	const cb = await p.evaluate(() => __car.handle.bindings('boost'));
	check('VR: Custom Controls param captured from the right grip (Boost VR = R grip)', cb.xr === 'R-Squeeze', cb);
	await p.evaluate(() => __t.btn('right', 'squeeze', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'squeeze', 0)); await sleep(250);
	await p.evaluate(() => __t.btn('right', 'a-button', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'a-button', 0)); await sleep(250);
	const boosts1 = await p.evaluate(() => __car.boosts);
	check('VR runtime: R grip fires onPress("boost"), A no longer', boosts1 - boosts0 === 1, { boosts0, boosts1 });
	// the menu still clicks while a field listens: pointing at another tab and pulling cancels (click elsewhere)
	await p.evaluate(() => document.querySelector('#gs-cc-car-horn-xr').click()); await sleep(450);
	const tabEl = '#dchat-controls-subtabs [data-controls-section="camera"]';
	await p.evaluate((s) => __t.aimAt('right', document.querySelector(s), 'menu'), tabEl);
	await sleep(500);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(500);
	const after = await p.evaluate(() => ({ section: document.querySelector('#dchat-controls-subtabs [data-controls-section="camera"]')?.classList.contains('active'), horn: __car.handle.bindings('horn').xr, listening: window.gsControllerBindings.capture.listening }));
	check('VR: while listening, a trigger on the menu still clicks it (Camera section opens) and cancels instead of binding', after.section && after.horn === 'B' && !after.listening, after);
	// (A is push-to-talk again once Boost moved off it: headless has no microphone)
	const errs = p._errors.filter((e) => !/Speech error: NotAllowedError/.test(e));
	check('VR: no console errors', errs.length === 0, errs);
	await p.close();
}

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
