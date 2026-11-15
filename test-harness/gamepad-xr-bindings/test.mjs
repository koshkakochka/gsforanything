// Game controller + VR controller bindings next to every keyboard / mouse control.
//   BASE=https://localhost:3762 SHOT_DIR=/workspace/gs-padxr-shots node test.mjs   (SKIP_VR=1 skips IWER)
// navigator.getGamepads is mocked (a standard-mapping Xbox pad whose axes /
// buttons the test sets); the headset is IWER's Meta Quest 3 (mocked XR input
// sources). /api/chat is stubbed; dummy keys; Community writes blocked.
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3762';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-padxr-shots';
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

// ======================================================= desktop: built-in styles
{
	const p = await openPage({ width: 1280, height: 800 });
	await pad(p, { press: { [B.A]: 1 } }); await sleep(150); await padClear(p); await sleep(200);
	check('mocked pad detected (gsGamepad.connected, status line)', await p.evaluate(() => gsGamepad.connected && /Xbox Wireless Controller/.test(document.getElementById('dchat-gamepad-status').textContent)));

	// every remappable action has a gamepad binding and an XR equivalent
	const tables = await p.evaluate(() => Object.fromEntries(['orbit', 'map', 'fly', 'firstperson'].map((s) => [s, gsControls.inputBindings(s)])));
	const missingPad = [], missingXr = [];
	for (const [s, t] of Object.entries(tables)) for (const a of t.actions) { if (!a.gamepad) missingPad.push(`${s}.${a.id}`); if (!a.xr) missingXr.push(`${s}.${a.id}`); }
	check('every built-in action (Orbit 4, Map 4, Fly 13, First person 4) has a default gamepad binding', missingPad.length === 0 && tables.fly.actions.length === 13, missingPad);
	check('XR equivalents for every action except Fly look / roll / slow (head-driven in VR)', missingXr.join() === 'fly.pitchUp,fly.pitchDown,fly.rollLeft,fly.rollRight,fly.slow', missingXr);
	check('mouse gestures (drag / wheel / mouse look) have controller rows in Orbit, Map and First person (Fly: all on keys); Y / View for every style',
		['orbit', 'map', 'firstperson'].every((s) => tables[s].gestures.length >= 6 && tables[s].gestures.every((g) => g.gamepad || g.xr)) && tables.fly.gestures.length === 0
		&& tables.map.gestures.find((g) => g.id === 'zoomIn').gamepad === 'RT' && tables.orbit.gestures.find((g) => g.id === 'rotateLeft').xr === 'R-Stick-Left'
		&& tables.map.global.map((g) => g.gamepad).join() === 'Y,View', Object.fromEntries(Object.entries(tables).map(([k, t]) => [k, t.gestures])));
	fs.writeFileSync(`${SHOT_DIR}/builtin-bindings.json`, JSON.stringify(tables, null, 2));

	// UI
	await setMode(p, 'map');
	await openControls(p, 'camera');
	const ui = await p.evaluate(() => ({
		rows: [...document.querySelectorAll('#dchat-key-remap .gs-remap-row:not(.gs-remap-ctl-row)')].map((r) => r.querySelector('.gs-bind-alt')?.textContent || ''),
		pad: document.getElementById('dchat-key-remap-pad')?.textContent || ''
	}));
	check('Map key rows show Gamepad D-pad and VR L stick under the key fields', ui.rows.length === 4 && ui.rows.every((t) => /Gamepad D-pad/.test(t) && /VR L stick/.test(t)), ui.rows);
	check('Map lists drag / wheel → stick / trigger rows and Y / View', /Pan forward \(left-drag\)Gamepad LS ↑/.test(ui.pad) && /Zoom in \(wheel\)Gamepad RT/.test(ui.pad) && /Gamepad Y/.test(ui.pad) && /Gamepad View/.test(ui.pad) && /In a headset/.test(ui.pad), ui.pad);
	await p.evaluate(() => document.getElementById('dchat-key-remap')?.scrollIntoView({ block: 'start' }));
	await sleep(200);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-map-bindings.png` });

	// Map: d-pad pans (like the arrow keys), left stick pans, right stick rotates, triggers zoom
	await blur(p);
	let c0 = await cam(p); await hold(p, { press: { [B.Up]: 1 } }, 500); let c1 = await cam(p);
	check('Map: d-pad ↑ pans the target (pan key equivalent)', dist(c0.target, c1.target) > 0.1, { c0: c0.target, c1: c1.target });
	c0 = c1; await hold(p, { axes: [0.9, 0, 0, 0] }, 500); c1 = await cam(p);
	check('Map: left stick pans (left-drag equivalent)', dist(c0.target, c1.target) > 0.1);
	c0 = c1; await hold(p, { axes: [0, 0, 0.9, 0] }, 500); c1 = await cam(p);
	check('Map: right stick rotates around the target (right-drag equivalent)', dist(c0.pos, c1.pos) > 0.1 && dist(c0.target, c1.target) < 0.05);
	c0 = c1; await hold(p, { press: { [B.RT]: 1 } }, 500); c1 = await cam(p);
	check('Map: RT zooms in (wheel equivalent)', dist(c1.pos, c1.target) < dist(c0.pos, c0.target) - 0.1, [dist(c0.pos, c0.target), dist(c1.pos, c1.target)]);
	// deadzone
	await sleep(1000);
	c0 = await cam(p); await hold(p, { axes: [0.1, 0.1, 0.1, -0.1] }, 500); c1 = await cam(p);
	check('deadzone: 0.1 stick deflection does nothing', dist(c0.pos, c1.pos) < 1e-3 && dist(c0.target, c1.target) < 1e-3, { pos: dist(c0.pos, c1.pos), target: dist(c0.target, c1.target) });
	// typing
	await p.evaluate(() => { window.gsSelectTab('chat'); document.getElementById('desktop-chat-input').focus(); });
	await sleep(150);
	c0 = await cam(p); await hold(p, { axes: [0.9, 0.9, 0.9, 0], press: { [B.Up]: 1, [B.RT]: 1 } }, 500); c1 = await cam(p);
	check('typing in a field: stick / d-pad / triggers do not move the camera', dist(c0.pos, c1.pos) < 1e-4, { c0: c0.pos, c1: c1.pos });
	await blur(p);

	// Orbit: d-pad pans too
	await setMode(p, 'orbit'); await blur(p);
	c0 = await cam(p); await hold(p, { press: { [B.Left]: 1 } }, 500); c1 = await cam(p);
	check('Orbit: d-pad ← pans', dist(c0.target, c1.target) > 0.1);
	// Fly: left stick forward, d-pad roll, LS press slow, RB up
	await setMode(p, 'fly'); await blur(p);
	c0 = await cam(p); await hold(p, { axes: [0, -1, 0, 0] }, 500); c1 = await cam(p);
	const flyMv = await moveInView(p, c0, c1);
	check('Fly: left stick ↑ flies forward', flyMv.fwd > 0.5 && Math.abs(flyMv.right) < 0.1, flyMv);
	c0 = c1; await hold(p, { press: { [B.Right]: 1 } }, 500); c1 = await cam(p);
	const roll = await p.evaluate(([a, b]) => { const T = THREE; const e0 = new T.Euler().setFromQuaternion(new T.Quaternion().fromArray(a), 'YXZ'); const e1 = new T.Euler().setFromQuaternion(new T.Quaternion().fromArray(b), 'YXZ'); return e1.z - e0.z; }, [c0.q, c1.q]);
	check('Fly: d-pad → rolls right (Roll right, E)', roll < -0.1, roll);
	await pad(p, { press: { [B.LS]: 1 } }); await sleep(200);
	const slowOn = (await cam(p)).mult;
	await padClear(p); await sleep(200);
	const slowOff = (await cam(p)).mult;
	check('Fly: left stick press = Slow (multiplier 0.1 while held)', slowOn === 0.1 && slowOff === 1, [slowOn, slowOff]);
	c0 = await cam(p); await hold(p, { press: { [B.RB]: 1 } }, 500); c1 = await cam(p);
	check('Fly: RB moves up', c1.pos[1] > c0.pos[1] + 0.3);
	// First person: left stick walks
	await setMode(p, 'firstperson'); await blur(p);
	c0 = await cam(p); await hold(p, { axes: [0, -1, 0, 0] }, 500); c1 = await cam(p);
	const fpMv = await moveInView(p, c0, c1);
	check('First person: left stick ↑ walks forward', fpMv.fwd > 0.5 && Math.abs(fpMv.up) < 1e-3, fpMv);
	await setMode(p, 'fly');
	await openControls(p, 'camera');
	await p.evaluate(() => document.getElementById('dchat-key-remap')?.scrollIntoView({ block: 'start' }));
	await sleep(200);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-fly-bindings.png` });

	// ================================ Custom Controls: generated + explicit bindings
	await setMode(p, 'map');
	await sendChat(p);
	const sch = await p.evaluate(() => Object.fromEntries(gsControls.customSchemes[0].params.filter((x) => x.type === 'key').map((x) => [x.name, [x.gamepad, x.xr]])));
	check('Custom Controls key params get generated bindings (W/S/A/D → left stick, ↑ → d-pad / right stick, Space → A / VR A, F → X / right trigger)',
		sch.accelerate.join() === 'LS-Up,L-Stick-Up' && sch.brake.join() === 'LS-Down,L-Stick-Down' && sch.steerLeft.join() === 'LS-Left,L-Stick-Left' && sch.steerRight.join() === 'LS-Right,L-Stick-Right'
		&& sch.lights.join() === 'DUp,R-Stick-Up' && sch.boost.join() === 'A,A' && sch.shoot.join() === 'X,R-Trigger', sch);
	check('explicit gamepad / xr bindings are kept (horn: Y / B)', sch.horn.join() === 'Y,B', sch.horn);
	await openControls(p, 'custom');
	const rows = await p.evaluate(() => [...document.querySelectorAll('.gs-cc-scheme[data-scheme-id="car"] .gs-cc-param[data-type="key"]')].map((r) => ({
		label: r.querySelector('label').textContent, key: r.querySelector('input').value,
		chips: [...r.querySelectorAll('.gs-bind-chip')].map((c) => [c.dataset.kind, c.textContent, c.dataset.auto]),
		sameLine: (() => { const k = r.querySelector('input').getBoundingClientRect(), c = r.querySelector('.gs-bind-chip').getBoundingClientRect(); return Math.abs(k.top - c.top) < 8; })()
	})));
	const rowTxt = rows.map((r) => [r.label, r.key, ...r.chips.map((c) => c[1])].join(' | '));
	check('Custom Controls rows: Label | Key | Gamepad | VR for every key param (generated defaults)', rows.length === 8 && rowTxt[0] === 'Accelerate | W | Gamepad LS ↑ | VR L stick ↑' && rowTxt[5] === 'Boost | Space | Gamepad A | VR A' && rowTxt[6] === 'Shoot | F | Gamepad X | VR R trigger' && rows[0].chips.every((c) => c[2] === '1'), rowTxt);
	check('… explicit bindings shown too (Horn | H | Gamepad Y | VR B)', rowTxt[7] === 'Horn | H | Gamepad Y | VR B' && rows[7].chips.every((c) => c[2] === '0'), rowTxt[7]);
	check('… gamepad / VR columns sit on the key\'s line on desktop', rows.every((r) => r.sameLine), rows.map((r) => r.sameLine));
	fs.writeFileSync(`${SHOT_DIR}/custom-controls-rows.txt`, rowTxt.join('\n') + '\n');
	await p.screenshot({ path: `${SHOT_DIR}/desktop-custom-controls-bindings.png` });
	await blur(p);
	// isDown / value / onPress from the pad
	await pad(p, { axes: [0, -0.8, 0, 0] }); await sleep(150);
	const dn = await p.evaluate(() => ({ d: __car.handle.isDown('accelerate'), v: __car.handle.value('accelerate'), b: __car.handle.isDown('brake') }));
	await sleep(500);
	const z1 = await p.evaluate(() => __car.box.position.z);
	await padClear(p); await sleep(150);
	check('pad left stick ↑ → isDown("accelerate"), value() analog, car drives', dn.d && dn.v > 0.6 && dn.v < 1 && !dn.b && z1 < -3.05, { dn, z1 });
	await pad(p, { axes: [0, -0.1, 0, 0] }); await sleep(150);
	check('deadzone: 0.1 does not press a stick-bound param', await p.evaluate(() => !__car.handle.isDown('accelerate') && __car.handle.value('accelerate') === 0));
	await padClear(p);
	for (let i = 0; i < 2; i++) { await pad(p, { press: { [B.Y]: 1 } }); await sleep(120); await padClear(p); await sleep(120); }
	check('pad Y fires onPress("horn") once per press', await p.evaluate(() => __car.horns) === 2, await p.evaluate(() => __car.horns));
	await p.evaluate(() => { window.gsSelectTab('chat'); document.getElementById('desktop-chat-input').focus(); });
	await sleep(100);
	await pad(p, { press: { [B.A]: 1 }, axes: [0, -1, 0, 0] }); await sleep(150);
	const typ = await p.evaluate(() => ({ boosts: __car.boosts, down: __car.handle.isDown('accelerate') }));
	await padClear(p); await sleep(150);
	check('typing in a field: pad presses do not reach the scheme', typ.boosts === 0 && !typ.down, typ);
	await blur(p);
	// the scheme claims the d-pad (lights = DUp) and the left stick → Map no longer pans with them
	const c2 = await cam(p); await hold(p, { press: { [B.Up]: 1 }, axes: [0.9, 0, 0, 0] }, 400); const c3 = await cam(p);
	check('inputs a scheme binds (d-pad, left stick) stop driving the camera; right stick still rotates', dist(c2.target, c3.target) < 1e-3, { c2: c2.target, c3: c3.target });
	c0 = await cam(p); await hold(p, { axes: [0, 0, 0.9, 0] }, 400); c1 = await cam(p);
	check('… unclaimed right stick still rotates Map', dist(c0.pos, c1.pos) > 0.1);
	const err = await p.evaluate(() => { try { gsControls.defineCustomScheme({ id: 'bad', params: [{ name: 'k', type: 'key', default: 'W', gamepad: 'Turbo' }] }); return 'no error'; } catch (e) { return e.message; } });
	check('unknown gamepad binding is rejected with a clear error', /not a controller input/.test(err), err);

	// custom camera mode: pad sticks feed m.sticks(), params get bindings
	const cm = await p.evaluate(async () => {
		const player = new THREE.Object3D(); scene.add(player);
		const m = gsControls.registerCameraMode({
			id: 'tps', label: 'Custom 3rd Person Controls',
			params: [{ name: 'fire', label: 'Fire', type: 'key', default: 'Space' }],
			update(dt, h) { const s = h.sticks(); player.position.x += s.lx * 3 * dt; player.position.z += s.ly * 3 * dt; camera.position.set(player.position.x, 2, player.position.z + 4); camera.lookAt(player.position); }
		});
		window.__tpsPlayer = player;
		return { mode: gsControls.mode, fire: m.bindings('fire') };
	});
	check('custom camera mode params get generated pad / VR bindings (Fire on Space: Gamepad A / VR A)', cm.mode === 'custom:tps' && cm.fire.gamepad === 'A' && cm.fire.xr === 'A', cm);
	await hold(p, { axes: [0.9, 0, 0, 0] }, 500);
	const px = await p.evaluate(() => __tpsPlayer.position.x);
	check('custom camera mode: pad left stick reaches m.sticks() (player moves right)', px > 0.5, px);
	await p.evaluate(() => gsControls.removeCameraMode('tps'));
	check('desktop: no console errors', p._errors.length === 0, p._errors);
	await p.close();
}

// ============ sample third-person scene: its camera mode's Custom Controls card
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
	await p.evaluate((code) => new Function('THREE', 'scene', 'camera', 'gs', code)(THREE, scene, camera, { onUpdate() {}, on() {}, onDispose() {} }), TPS_CODE);
	await sleep(300);
	await openControls(p, 'custom');
	await sleep(300);
	const t = await p.evaluate(() => ({
		rows: [...document.querySelectorAll('.gs-cc-scheme[data-scheme-id="camera.tps"] .gs-cc-param[data-type="key"]')].map((r) => [r.querySelector('label').textContent, r.querySelector('input').value, ...[...r.querySelectorAll('.gs-bind-chip')].map((c) => c.textContent)].join(' | ')),
		overflow: document.documentElement.scrollWidth > innerWidth,
		rowOverflow: [...document.querySelectorAll('.gs-cc-param')].some((r) => r.scrollWidth > r.clientWidth + 1)
	}));
	check(`${name}: sample third-person scene — Custom 3rd Person Controls card lists Gamepad + VR for every control`, t.rows.length === 7
		&& t.rows[0] === 'Move forward | W | Gamepad LS ↑ | VR L stick ↑' && t.rows[4] === 'Jump | Space | Gamepad A | VR A'
		&& t.rows[5] === 'Fire | F | Gamepad RT | VR R trigger' && t.rows[6] === 'Reload | R | Gamepad Y | VR L trigger', t.rows);
	check(`${name}: Custom Controls columns fit (no horizontal overflow)`, !t.overflow && !t.rowOverflow, t);
	if (name === 'desktop') fs.writeFileSync(`${SHOT_DIR}/tps-custom-controls-rows.txt`, t.rows.join('\n') + '\n');
	await p.screenshot({ path: `${SHOT_DIR}/${name}-tps-custom-controls.png` });
	// pad A while in the mode = Jump
	await blur(p);
	await pad(p, { press: { [B.A]: 1 } }); await sleep(150);
	const jump = await p.evaluate(() => __tps.handle.isDown('jump'));
	await padClear(p);
	check(`${name}: Gamepad A presses the sample's Jump`, jump);
	check(`${name}: no console errors (sample scene)`, p._errors.length === 0, p._errors);
	await p.close();
}

// ======================================================================== phone
{
	const p = await openPage({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { mobile: true });
	await sendChat(p);
	await setMode(p, 'fly');
	await openControls(p, 'camera');
	await p.evaluate(() => document.getElementById('dchat-key-remap')?.scrollIntoView({ block: 'start' }));
	await sleep(250);
	const ph = await p.evaluate(() => ({
		overflow: document.documentElement.scrollWidth > innerWidth,
		rowOverflow: [...document.querySelectorAll('#dchat-key-remap .gs-remap-row, #dchat-key-remap .gs-ctl-row')].some((r) => r.scrollWidth > r.clientWidth + 1),
		chips: document.querySelectorAll('#dchat-key-remap .gs-bind-alt').length
	}));
	check('phone: Fly rows with pad / VR lines fit (no horizontal overflow)', !ph.overflow && !ph.rowOverflow && ph.chips === 15, ph);
	await p.screenshot({ path: `${SHOT_DIR}/phone-fly-bindings.png` });
	await openControls(p, 'custom');
	await sleep(200);
	const ph2 = await p.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, chips: document.querySelectorAll('.gs-cc-scheme .gs-bind-chip').length }));
	check('phone: Custom Controls card with Gamepad / VR columns fits', !ph2.overflow && ph2.chips === 16, ph2);
	await p.screenshot({ path: `${SHOT_DIR}/phone-custom-controls-bindings.png` });
	check('phone: no console errors', p._errors.length === 0, p._errors);
	await p.close();
}

// ============================================================== VR (IWER Quest 3)
if (!SKIP_VR) {
	const p = await openPage({ width: 1600, height: 900 }, { xr: true });
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
	// locomotion unchanged without scene bindings
	let r0 = await rig();
	await p.evaluate(() => __t.stick('left', 0, -1)); await sleep(600); await p.evaluate(() => __t.stick('left', 0, 0)); await sleep(200);
	let r1 = await rig();
	check('VR: no scene bindings → left thumbstick still moves you (locomotion)', dist(r0, r1) > 0.3, { r0, r1 });
	const xs = await p.evaluate(async () => { __t.stick('left', 0.6, 0); await new Promise((r) => setTimeout(r, 200)); const s = gsXrInput.stick('left'); __t.stick('left', 0, 0); return s; });
	check('VR: gsXrInput reads the thumbstick (deadzone-rescaled)', xs[0] > 0.4 && xs[0] < 0.6 && Math.abs(xs[1]) < 1e-6, xs);

	// scheme with VR bindings (stubbed chat reply)
	await p.evaluate(() => {
		window.gsSelectTab('chat');
		const i = document.getElementById('desktop-chat-input');
		i.value = 'make a drivable car'; i.dispatchEvent(new Event('input', { bubbles: true }));
		document.getElementById('desktop-send-button').click();
	});
	await p.waitForFunction(() => window.__car, { timeout: 15000 }).catch(() => {});
	await sleep(600);
	await p.evaluate(() => { __t.aimAway('left'); __t.aimAway('right'); });
	await sleep(300);
	r0 = await rig();
	await p.evaluate(() => __t.stick('left', 0, -1)); await sleep(300);
	const vd = await p.evaluate(() => ({ d: __car.handle.isDown('accelerate'), v: __car.handle.value('accelerate') }));
	await sleep(300);
	await p.evaluate(() => __t.stick('left', 0, 0)); await sleep(200);
	r1 = await rig();
	check('VR: left thumbstick ↑ presses "accelerate" (generated L-Stick-Up)', vd.d && vd.v > 0.8, vd);
	check('VR: the scheme took the left stick over — locomotion does not move you with it', dist(r0, r1) < 0.02, { r0, r1 });
	// "lights" (ArrowUp → R-Stick-Up) claims the right stick too: it presses lights, no turning
	await p.evaluate(() => __t.stick('right', 0, -1)); await sleep(300);
	const lights = await p.evaluate(() => __car.handle.isDown('lights'));
	await p.evaluate(() => __t.stick('right', 1, 0)); await sleep(400); await p.evaluate(() => __t.stick('right', 0, 0)); await sleep(200);
	const turned = await p.evaluate(() => gsVrInput.playerQuaternion().toArray());
	check('VR: right stick ↑ presses "lights" (generated R-Stick-Up) and the claimed stick no longer turns you', lights && Math.abs(turned[1]) < 1e-6, { lights, turned });
	// remove the scheme → locomotion gets both sticks back
	await p.evaluate(() => gsControls.removeCustomScheme('car')); await sleep(200);
	r0 = await rig();
	await p.evaluate(() => __t.stick('left', 0, -1)); await sleep(500); await p.evaluate(() => __t.stick('left', 0, 0));
	await p.evaluate(() => __t.stick('right', 1, 0)); await sleep(400); await p.evaluate(() => __t.stick('right', 0, 0)); await sleep(200);
	r1 = await rig();
	const turned2 = await p.evaluate(() => gsVrInput.playerQuaternion().toArray());
	check('VR: scheme removed → both thumbsticks move / turn you again', dist(r0, r1) > 0.3 && Math.abs(turned2[1]) > 0.05, { r0, r1, turned2 });
	await p.evaluate((code) => { new Function('THREE', 'scene', 'camera', 'gs', code)(THREE, scene, camera, { onUpdate() {}, on() {}, onDispose() {} }); }, CAR_CODE);
	await sleep(300);
	// trigger: fires the scene binding when pointing away, not when pointing at the menu
	await p.evaluate(() => __t.aimAway('right')); await sleep(300);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(250);
	const boostsAway = await p.evaluate(() => __car.shots);
	check('VR: right trigger (generated for F) fires onPress("shoot") when not pointing at a window', boostsAway === 1, boostsAway);
	await p.evaluate(() => __t.btn('right', 'a-button', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'a-button', 0)); await sleep(250);
	check('VR: A (generated for Space) fires onPress("boost")', await p.evaluate(() => __car.boosts) === 1);
	await p.evaluate(() => { window.gsSelectTab('chat'); document.getElementById('gs-menu-hamburger')?.click(); });
	await sleep(400);
	const tabBefore = await p.evaluate(() => document.querySelector('.dchat-tab.active')?.dataset.tab);
	const targetSel = '.dchat-tab[data-tab="controls"]';
	await p.evaluate((s) => { const el = document.querySelector(s); if (el) __t.aimAt('right', el, 'menu'); }, targetSel);
	await sleep(500);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(500);
	const after = await p.evaluate(() => ({ shots: __car.shots, tab: document.querySelector('.dchat-tab.active')?.dataset.tab }));
	check('VR menu: trigger on the menu still clicks it (tab switches) and does not reach the scene', after.shots === 1 && after.tab === 'controls' && tabBefore !== 'controls', { tabBefore, ...after });
	// explicit B binding: horn fires; B no longer toggles the pointer rays
	await p.evaluate(() => __t.aimAway('right')); await sleep(300);
	const raysBefore = await p.evaluate(() => [0, 1].map((i) => renderer.xr.getController(i)).map((c) => c.children.filter((x) => x.isLine).map((l) => l.visible)).flat());
	await p.evaluate(() => __t.btn('right', 'b-button', 1)); await sleep(250); await p.evaluate(() => __t.btn('right', 'b-button', 0)); await sleep(250);
	const raysAfter = await p.evaluate(() => [0, 1].map((i) => renderer.xr.getController(i)).map((c) => c.children.filter((x) => x.isLine).map((l) => l.visible)).flat());
	const horns = await p.evaluate(() => __car.horns);
	check('VR: B (explicit xr binding) fires onPress("horn") and GS\'s ray toggle steps aside', horns === 1 && JSON.stringify(raysBefore) === JSON.stringify(raysAfter), { horns, raysBefore, raysAfter });
	await p.screenshot({ path: `${SHOT_DIR}/vr-desktop-mirror.png` });
	check('VR: no console errors', p._errors.length === 0, p._errors);
	await p.close();
}

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
