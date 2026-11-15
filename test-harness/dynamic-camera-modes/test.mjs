// Camera modes registered by scene code (gsControls.registerCameraMode,
// site-source/customCameraModes.js).
//   BASE=https://localhost:3761 SHOT_DIR=/workspace/gs-dyncam-shots node test.mjs
// /api/chat is stubbed with a reply whose vr-exec block is a small
// third-person shooter: a player capsule, WASD (remappable params) and a
// follow camera registered as "Custom 3rd Person Controls". Nothing reaches
// an LLM, Community POSTs are blocked, dummy keys only.
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3761';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-dyncam-shots';
const SKIP_VR = process.env.SKIP_VR === '1';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
	ok ? pass++ : fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`);
};
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const BUILT_IN = ['orbit', 'map', 'fly', 'firstperson', 'off'];

// Sample scene: "make a third person shooter where the camera follows the player".
export const TPS_CODE = `
const player = new THREE.Group(); player.name = 'tpsPlayer';
const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1, 4, 8), new THREE.MeshStandardMaterial({ color: 0x3b82f6 }));
body.position.y = 0.8; player.add(body);
const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
gun.position.set(0.35, 1.1, -0.3); player.add(gun);
scene.add(player);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x4b5563 }));
ground.rotation.x = -Math.PI / 2; ground.name = 'tpsGround'; scene.add(ground);
for (let i = 0; i < 6; i++) { const t = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ color: 0xef4444 })); t.position.set(Math.sin(i) * 8, 1, -6 - i * 2); scene.add(t); }
window.__tps = { activates: 0, deactivates: 0, updates: 0, player };
let yaw = 0;
const tps = gsControls.registerCameraMode({
  id: 'tps', label: 'Custom 3rd Person Controls',
  description: 'The camera follows the player. WASD move, drag to turn.',
  sticks: true,
  params: [
    { name: 'forward', label: 'Move forward', type: 'key', default: 'W' },
    { name: 'back', label: 'Move back', type: 'key', default: 'S' },
    { name: 'left', label: 'Strafe left', type: 'key', default: 'A' },
    { name: 'right', label: 'Strafe right', type: 'key', default: 'D' },
    { name: 'distance', label: 'Camera distance', type: 'number', default: 4, min: 2, max: 10, step: 0.5, unit: 'm' }
  ],
  activate(m) { window.__tps.activates++; },
  deactivate(m) { window.__tps.deactivates++; },
  update(dt, m) {
    window.__tps.updates++;
    const s = m.sticks();
    const f = (m.isDown('forward') ? 1 : 0) - (m.isDown('back') ? 1 : 0) - s.ly;
    const r = (m.isDown('right') ? 1 : 0) - (m.isDown('left') ? 1 : 0) + s.lx;
    yaw -= s.rx * 2 * dt;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    player.position.addScaledVector(fwd, f * 4 * dt).addScaledVector(side, r * 4 * dt);
    player.rotation.y = yaw;
    const d = m.values.distance;
    camera.position.copy(player.position).addScaledVector(fwd, -d).add(new THREE.Vector3(0, 2, 0));
    camera.lookAt(player.position.x, 1.2, player.position.z);
  }
});
window.__tps.handle = tps;
`;
const TPS_REPLY = 'Here is a third person shooter. WASD moves, the camera follows you (Controls → Camera → Custom 3rd Person Controls).\n```vr-exec\n' + TPS_CODE + '\n```';

const b = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

const EXPECTED_ERRORS = /camera mode "Broken" activate failed|boom on purpose/;
async function openPage(ctx, viewport, { mobile = false, xr = false, base = BASE } = {}) {
	const p = await ctx.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text()) && !EXPECTED_ERRORS.test(m.text())) errors.push('console: ' + m.text()); });
	if (mobile) await p.setUserAgent(PHONE_UA);
	await p.setViewport(viewport);
	if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const u = new URL(req.url());
		if (u.pathname.startsWith('/api/')) {
			if (u.pathname.startsWith('/api/community') && req.method() !== 'GET') return req.respond({ status: 503, body: 'blocked' });
			if (u.pathname === '/api/chat') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: TPS_REPLY }] }) });
			if (u.pathname === '/api/prompts') return req.continue(); // static prompt text
			if (req.method() !== 'GET') return req.respond({ status: 503, body: 'blocked' });
			const body = u.pathname === '/api/backends'
				? '{"backends":{"claude":{"label":"Claude","provider":"claude","available":true}},"default":"claude"}'
				: (u.pathname.startsWith('/api/community-scenes') ? '{"scenes":[]}' : '{}');
			return req.respond({ status: 200, contentType: 'application/json', body });
		}
		req.continue();
	});
	await p.goto(base + '/', { waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.renderer && window.gsControls && window.gsControls.registerCameraMode && document.getElementById('gs-menu-hamburger'), { timeout: 30000 });
	await sleep(600);
	p._errors = errors;
	return p;
}
async function openControls(p, section = 'camera') {
	await p.evaluate(() => {
		const chat = document.getElementById('desktop-chat');
		if (!chat?.classList.contains('gs-tab-menu-open')) document.getElementById('gs-menu-hamburger')?.click();
	});
	await sleep(200);
	await p.evaluate(() => window.gsSelectTab('controls'));
	await sleep(250);
	await p.evaluate((s) => document.querySelector(`#dchat-controls-subtabs [data-controls-section="${s}"]`)?.click(), section);
	await sleep(200);
}
const clickMode = async (p, m) => { await p.evaluate((m) => document.querySelector(`#dchat-camera-mode [data-camera-mode="${m}"]`)?.click(), m); await sleep(250); };
const blur = (p) => p.evaluate(() => { document.activeElement?.blur?.(); document.body.focus(); });
async function holdKey(p, code, ms = 500) { await blur(p); await sleep(60); await p.keyboard.down(code); await sleep(ms); await p.keyboard.up(code); await sleep(150); }
const state = (p) => p.evaluate(() => ({
	mode: gsControls.mode,
	ctrl: gsControls.controls ? gsControls.controls.constructor.name : null,
	cam: camera.position.toArray(), camParent: camera.parent?.name || camera.parent?.type || null,
	player: window.__tps ? window.__tps.player.position.toArray() : null,
	t: window.__tps ? { a: __tps.activates, d: __tps.deactivates, u: __tps.updates } : null,
	saved: localStorage.getItem('gs.cameraControlMode'),
	buttons: [...document.querySelectorAll('#dchat-camera-mode [data-camera-mode]')].map((b) => ({ m: b.dataset.cameraMode, label: b.textContent.trim(), on: b.classList.contains('active'), aria: b.getAttribute('aria-checked') })),
	sticks: gsTwinSticks.visible,
	remap: document.getElementById('dchat-key-remap').childElementCount,
	help: document.getElementById('dchat-camera-custom-help').hidden ? '' : document.getElementById('dchat-camera-custom-help').textContent
}));
const dist = (a, c) => Math.hypot(...a.map((v, i) => v - c[i]));
async function sendChat(p, text = 'make a third person shooter where the camera follows the player') {
	await p.evaluate((t) => {
		window.gsSelectTab('chat');
		const i = document.getElementById('desktop-chat-input');
		i.value = t; i.dispatchEvent(new Event('input', { bubbles: true }));
		document.getElementById('desktop-send-button').click();
	}, text);
	await p.waitForFunction(() => gsControls.cameraModes.some((m) => m.mode === 'custom:tps'), { timeout: 15000 }).catch(() => {});
	await sleep(500);
}
async function clearScene(p) {
	await p.evaluate(() => window.gsSelectTab('scenes'));
	await sleep(200);
	await p.evaluate(() => document.querySelector('[data-action="scenes:clear"]')?.click());
	await sleep(300);
	await p.evaluate(() => document.querySelector('#gs-dialog .gs-dialog-ok')?.click());
	await sleep(500);
}
async function loadSceneFile(p, codeBlocks, name = 'tps') {
	return p.evaluate(async (blocks, name) => {
		const data = { version: 1, name, codeBlocks: blocks };
		const f = new File([JSON.stringify(data)], name + '.vrscene.json', { type: 'application/json' });
		const input = document.querySelector('input[type="file"][accept*="vrscene"], #scene-file-input');
		if (!input) return 'no input';
		const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 1500));
		return 'ok';
	}, codeBlocks, name);
}

const ctx = await b.createBrowserContext();

// ===================================================================== desktop
{
	const p = await openPage(ctx, { width: 1280, height: 800 });
	await p.evaluate(() => { localStorage.removeItem('gs.cameraControlMode'); localStorage.removeItem('gs.customControls.v1'); });
	await p.reload({ waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.gsControls?.registerCameraMode);
	await sleep(600);
	let s = await state(p);
	check('fresh load: five built-in buttons, Map active, no custom mode', s.buttons.map((x) => x.m).join() === 'orbit,map,fly,firstperson,off' && s.mode === 'map' && gsModesOk(s), s.buttons);
	function gsModesOk(st) { return st.buttons.filter((x) => x.on).length === 1; }

	// prompt teaches the API
	const prompts = await p.evaluate(async () => (await fetch('/api/prompts')).json());
	const req = prompts.chatPromptRequired || '';
	check('chat prompt (always-added section) documents registerCameraMode + "Custom 3rd Person Controls"', /registerCameraMode/.test(req) && /Custom 3rd Person Controls/.test(req) && /deactivate/.test(req), req.length);

	// the stubbed chat reply registers and activates the mode
	await sendChat(p);
	await openControls(p, 'camera');
	s = await state(p);
	const custom = s.buttons.find((x) => x.m === 'custom:tps');
	check('chat reply adds a "Custom 3rd Person Controls" button after the built-in ones', !!custom && custom.label === 'Custom 3rd Person Controls' && s.buttons.map((x) => x.m).join() === 'orbit,map,fly,firstperson,off,custom:tps', s.buttons);
	check('registered mode is active right away (activate called once, button checked)', s.mode === 'custom:tps' && custom?.on && custom?.aria === 'true' && s.t.a === 1 && s.t.d === 0 && gsModesOk(s), s);
	check('custom mode: no stock control, no key-remap rows, help names the mode', s.ctrl === null && s.remap === 0 && /Custom 3rd Person Controls/.test(s.help) && /Orbit, Map, Fly, First person, Off/.test(s.help), s);
	check('custom mode is not saved as the camera preference', s.saved === null || s.saved === 'map', s.saved);
	check('sticks:true shows the on-screen joysticks in the custom mode', s.sticks === true, s.sticks);
	const listed = await p.evaluate(() => gsControls.cameraModes);
	check('gsControls.cameraModes lists built-ins + the custom mode', listed.length === 6 && listed[5].label === 'Custom 3rd Person Controls' && listed[5].active && listed.slice(0, 5).every((m) => m.builtIn), listed);
	const camStatus = await p.evaluate(() => document.getElementById('status')?.textContent || '');
	await p.screenshot({ path: `${SHOT_DIR}/desktop-camera-custom-active.png` });

	// the follow camera works (update after gs.onUpdate)
	const u0 = s.t.u;
	await sleep(300);
	s = await state(p);
	check('update hook runs every frame while active', s.t.u > u0 + 3, { u0, u: s.t.u });
	const before = s.player;
	await holdKey(p, 'KeyW', 600);
	s = await state(p);
	const moved = dist(before, s.player);
	const off = [s.cam[0] - s.player[0], s.cam[1] - s.player[1], s.cam[2] - s.player[2]];
	check('W (scene param) walks the player and the camera follows 4 m behind, 2 m up', moved > 1 && Math.abs(Math.hypot(off[0], off[2]) - 4) < 0.05 && Math.abs(off[1] - 2) < 0.05, { moved, off });

	// settings link → Custom Controls card for the mode
	await p.evaluate(() => document.getElementById('dchat-camera-custom-settings')?.click());
	await sleep(250);
	const card = await p.evaluate(() => {
		const c = document.querySelector('.gs-cc-scheme[data-scheme-id="camera.tps"]');
		return { section: document.querySelector('#dchat-controls-subtabs .active')?.dataset.controlsSection, title: c?.querySelector('.gs-cc-title')?.textContent, rows: c ? c.querySelectorAll('.gs-cc-param').length : 0 };
	});
	check('"Keys and settings" opens Custom Controls with the mode\'s card (5 params)', card.section === 'custom' && card.title === 'Custom 3rd Person Controls' && card.rows === 5, card);
	await p.evaluate(() => gsControls.getCameraMode('tps').set('distance', 6));
	await sleep(200);
	s = await state(p);
	check('changing a param (distance 6 m) updates the follow camera live', Math.abs(Math.hypot(s.cam[0] - s.player[0], s.cam[2] - s.player[2]) - 6) < 0.05, s.cam);
	await p.evaluate(() => gsControls.getCameraMode('tps').set('distance', 4));
	await openControls(p, 'camera');

	// switch to every built-in mode and back
	const CTRL = { orbit: 'OrbitControls', map: 'MapControls', fly: 'FlyControls', firstperson: 'PointerLockControls', off: null };
	let allOk = true; const log = [];
	for (const m of BUILT_IN) {
		const t0 = (await state(p)).t;
		await clickMode(p, m);
		const a = await state(p);
		const uFrozen = a.t.u; await sleep(250); const a2 = await state(p);
		const okOut = a.mode === m && a.ctrl === CTRL[m] && a.t.d === t0.d + 1 && a.saved === m && a2.t.u === uFrozen && a.buttons.find((x) => x.m === m).on && !a.buttons.find((x) => x.m === 'custom:tps').on && a.help === '' && a.camParent !== 'tpsPlayer';
		await clickMode(p, 'custom:tps');
		const c = await state(p);
		const okBack = c.mode === 'custom:tps' && c.ctrl === null && c.t.a === a.t.a + 1 && c.saved === m && c.buttons.find((x) => x.m === 'custom:tps').on;
		log.push({ m, okOut, okBack, ctrl: a.ctrl, d: [t0.d, a.t.d], frozen: [uFrozen, a2.t.u] });
		if (!okOut || !okBack) allOk = false;
	}
	check('custom → each built-in (Orbit, Map, Fly, First person, Off): deactivate runs, stock control takes over, update stops, choice saved', log.every((l) => l.okOut), log);
	check('each built-in → custom again: activate runs, camera handed back to the scene', log.every((l) => l.okBack), log);

	// built-in controls really work after the hand-back
	await clickMode(p, 'map');
	const m0 = (await state(p)).cam;
	await holdKey(p, 'ArrowUp', 400);
	for (let i = 0; i < 6; i++) { await p.keyboard.press('ArrowUp'); await sleep(40); }
	await sleep(400);
	const m1 = (await state(p)).cam;
	check('after leaving the custom mode, Map keys move the camera', dist(m0, m1) > 0.05, { m0, m1 });
	const pl0 = (await state(p)).player;
	await holdKey(p, 'KeyW', 400);
	check('… and the scene no longer steers the camera (player may move, camera not reset to it)', (await state(p)).mode === 'map', pl0);
	await clickMode(p, 'custom:tps');
	await clickMode(p, 'custom:tps'); // clicking the active custom button again is a no-op
	s = await state(p);
	check('clicking the active custom button again does not re-run activate', s.t.a === log.length + 2 && s.mode === 'custom:tps', s.t);

	// hot reload (same id) while active: old hooks out, new hooks in
	const hot = await p.evaluate(() => {
		const r = { a: 0, d: 0 };
		gsControls.registerCameraMode({ id: 'tps', label: 'Custom 3rd Person Controls', activate() { r.a++; }, deactivate() { r.d++; } });
		return { r, old: { deactivates: window.__tps.deactivates, activates: window.__tps.activates }, mode: gsControls.mode, n: gsControls.cameraModes.length, scheme: !!document.querySelector('.gs-cc-scheme[data-scheme-id="camera.tps"]') };
	});
	check('re-registering the same id while active: old deactivate, new activate, still active, params card removed', hot.old.deactivates === s.t.d + 1 && hot.r.a === 1 && hot.mode === 'custom:tps' && hot.n === 6 && !hot.scheme, hot);
	// hot reload while the user picked a built-in: stays built-in
	await clickMode(p, 'orbit');
	await p.evaluate((code) => { new Function('THREE', 'scene', 'camera', 'gs', code)(THREE, scene, camera, { onUpdate() {}, on() {}, onDispose() {} }); }, TPS_CODE).catch(() => {});
	await sleep(250);
	s = await state(p);
	check('re-registering while the user is on a built-in mode keeps the built-in mode', s.mode === 'orbit' && s.buttons.filter((x) => x.m === 'custom:tps').length === 1, s.mode);
	await clickMode(p, 'custom:tps');

	// camera re-parented by the scene is put back in the rig on leave
	const rep = await p.evaluate(() => {
		const holder = new THREE.Object3D(); holder.name = 'camHolder'; holder.position.set(3, 0, 3); scene.add(holder);
		const rig = camera.parent;
		gsControls.registerCameraMode({ id: 'attached', label: 'Custom Chase Controls', activate() { holder.add(camera); camera.position.set(0, 2, 4); camera.fov = 40; camera.updateProjectionMatrix(); } });
		const during = camera.parent === holder;
		gsControls.setMode('fly');
		return { during, back: camera.parent === rig, fov: camera.fov, mode: gsControls.mode, n: gsControls.cameraModes.length };
	});
	check('second custom mode (re-parents camera, changes fov) → Fly: camera back in the rig, fov restored', rep.during && rep.back && rep.fov !== 40 && rep.mode === 'fly' && rep.n === 7, rep);
	s = await state(p);
	check('two custom modes → two extra buttons, header/tab layout intact', s.buttons.length === 7 && await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), s.buttons.map((x) => x.label));
	await p.evaluate(() => gsControls.removeCameraMode('attached'));

	// a throwing activate falls back to the saved built-in mode
	const broken = await p.evaluate(() => {
		gsControls.setMode('orbit');
		gsControls.registerCameraMode({ id: 'broken', label: 'Broken', activate() { throw new Error('boom on purpose'); } });
		const r = { mode: gsControls.mode, ctrl: gsControls.controls?.constructor.name };
		gsControls.removeCameraMode('broken');
		return r;
	});
	check('activate that throws: back to the saved built-in mode (Orbit), stock control rebuilt', broken.mode === 'orbit' && broken.ctrl === 'OrbitControls', broken);
	const bad = await p.evaluate(() => { try { gsControls.registerCameraMode({ id: 'no spaces!', label: 'x' }); return 'no error'; } catch (e) { return e.message; } });
	check('invalid id is rejected with a clear error', /id must be/.test(bad), bad);
	const unknown = await p.evaluate(() => { gsControls.setMode('custom:nope'); return gsControls.mode; });
	check('switching to an unregistered custom mode falls back to the saved built-in mode', unknown === 'orbit', unknown);

	// handle.deactivate() / activate()
	const hd = await p.evaluate(() => { const h = gsControls.getCameraMode('tps'); h.activate(); const a = gsControls.mode; h.deactivate(); return [a, gsControls.mode, h.active]; });
	check('handle.activate() / handle.deactivate() switch to the mode and back to the saved built-in', hd[0] === 'custom:tps' && hd[1] === 'orbit' && hd[2] === false, hd);

	// clearing the scene removes the mode, back to the saved built-in mode
	await clickMode(p, 'custom:tps');
	await clearScene(p);
	s = await state(p);
	check('Clear All From Scene: custom button gone, back to the saved built-in (Orbit)', s.mode === 'orbit' && s.buttons.length === 5 && s.ctrl === 'OrbitControls' && !s.buttons.some((x) => x.m.startsWith('custom:')), s);
	check('… and its Custom Controls card is gone', await p.evaluate(() => !document.querySelector('.gs-cc-scheme[data-scheme-id="camera.tps"]') && gsControls.customSchemes.length === 0));

	// importing a scene file registers it; loading another scene removes it
	await loadSceneFile(p, [TPS_CODE], 'tps');
	await p.waitForFunction(() => gsControls.mode === 'custom:tps', { timeout: 8000 }).catch(() => {});
	s = await state(p);
	check('importing a .vrscene.json whose code registers the mode activates it', s.mode === 'custom:tps' && s.buttons.length === 6, s.mode);
	await loadSceneFile(p, ['const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); m.position.set(0, 0.5, -2); scene.add(m);'], 'plain');
	s = await state(p);
	check('loading a scene without the mode removes it and returns to the saved built-in', s.mode === 'orbit' && s.buttons.length === 5, s);

	// a stale custom preference must not break a load
	await p.evaluate(() => localStorage.setItem('gs.cameraControlMode', 'custom:tps'));
	await p.reload({ waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.gsControls?.registerCameraMode);
	await sleep(600);
	s = await state(p);
	check('saved "custom:tps" preference with no such mode loads as Map (and is rewritten)', s.mode === 'map' && s.ctrl === 'MapControls' && s.saved === 'map' && s.buttons.length === 5, s);
	check('desktop: no console errors', p._errors.length === 0, p._errors);
	fs.writeFileSync(`${SHOT_DIR}/status.txt`, camStatus);
	await p.close();
}

// ================================================= desktop screenshot (clean)
{
	const p = await openPage(ctx, { width: 1280, height: 800 });
	await p.evaluate(() => localStorage.setItem('gs.cameraControlMode', 'map'));
	await sendChat(p);
	await openControls(p, 'camera');
	await holdKey(p, 'KeyW', 500);
	await sleep(300);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-camera-section.png` });
	await clickMode(p, 'orbit');
	await sleep(300);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-switched-to-orbit.png` });
	await p.close();
}

// ======================================================================= phone
{
	const p = await openPage(ctx, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { mobile: true });
	await sendChat(p);
	await openControls(p, 'camera');
	await p.evaluate(() => document.querySelector('#dchat-camera-mode [data-camera-mode="custom:tps"]')?.scrollIntoView({ block: 'center' }));
	await sleep(300);
	const ph = await p.evaluate(() => {
		const btn = document.querySelector('#dchat-camera-mode [data-camera-mode="custom:tps"]');
		const r = btn?.getBoundingClientRect();
		const group = document.getElementById('dchat-camera-mode').getBoundingClientRect();
		const header = document.querySelector('#desktop-chat .dchat-tabs, #dchat-tabs, .dchat-header');
		const hb = header ? header.getBoundingClientRect() : null;
		const builtins = [...document.querySelectorAll('#dchat-camera-mode [data-camera-mode]:not(.gs-custom-camera-mode)')].map((b) => b.getBoundingClientRect());
		return {
			phone: document.documentElement.classList.contains('gs-phone'),
			label: btn?.textContent, w: r?.width, h: r?.height, groupW: group.width, inside: r && r.left >= group.left - 1 && r.right <= group.right + 1,
			overflowX: document.documentElement.scrollWidth > innerWidth,
			builtinRows: new Set(builtins.map((x) => Math.round(x.top))).size, minBuiltinH: Math.min(...builtins.map((x) => x.height)),
			header: hb ? { h: Math.round(hb.height) } : null,
			mode: gsControls.mode, sticks: gsTwinSticks.visible
		};
	});
	check('phone: custom button full-width, ≥44 px, label fits, no horizontal overflow', ph.phone && ph.label === 'Custom 3rd Person Controls' && ph.h >= 44 && ph.inside && Math.abs(ph.w - ph.groupW) < 2 && !ph.overflowX, ph);
	check('phone: built-in buttons keep their 3-column grid (2 rows, ≥44 px)', ph.builtinRows === 2 && ph.minBuiltinH >= 44, ph);
	check('phone: mode active with on-screen joysticks', ph.mode === 'custom:tps' && ph.sticks, ph);
	await p.screenshot({ path: `${SHOT_DIR}/phone-camera-section.png` });
	// left stick walks the player
	const before = await p.evaluate(() => __tps.player.position.toArray());
	await p.evaluate(() => { const st = gsTwinSticks; window.__stickStub = st.axes; });
	const stickMoved = await p.evaluate(async () => {
		const el = document.querySelector('.gs-twin-stick-left, [data-stick="left"], .gs-stick-left');
		if (!el) return 'no stick element';
		const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
		const ev = (type, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: cx, clientY: y, isPrimary: true }));
		ev('pointerdown', cy); await new Promise((res) => setTimeout(res, 50));
		window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: cx, clientY: cy - 60 }));
		el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: cx, clientY: cy - 60 }));
		await new Promise((res) => setTimeout(res, 600));
		const ax = gsTwinSticks.axes();
		window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
		el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
		return ax;
	});
	const after = await p.evaluate(() => __tps.player.position.toArray());
	check('phone: on-screen left stick walks the player through m.sticks()', dist(before, after) > 0.3, { stickMoved, before, after });
	await clickMode(p, 'map');
	const back = await p.evaluate(() => ({ mode: gsControls.mode, sticks: gsTwinSticks.visible, ctrl: gsControls.controls?.constructor.name }));
	check('phone: tap Map → MapControls, joysticks hidden', back.mode === 'map' && back.ctrl === 'MapControls' && !back.sticks, back);
	await p.screenshot({ path: `${SHOT_DIR}/phone-switched-to-map.png` });
	check('phone: no console errors', p._errors.length === 0, p._errors);
	await p.close();
}

// ================================================================ VR menu rays
if (!SKIP_VR) {
	const p = await openPage(ctx, { width: 1600, height: 900 }, { xr: true });
	await sendChat(p);
	await openControls(p, 'camera');
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
	const inVr = await p.evaluate(() => renderer.xr.isPresenting);
	check('VR: entered immersive session (IWER Quest 3)', inVr);
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
			trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); }
		};
	});
	const click = async () => { await p.evaluate(() => __t.trigger('right', 1)); await sleep(300); await p.evaluate(() => __t.trigger('right', 0)); await sleep(400); };
	const rayClick = async (sel) => {
		await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'nearest' }), sel);
		await sleep(400);
		await p.evaluate((s) => __t.aimAt('right', document.querySelector(s), 'menu'), sel);
		await sleep(400);
		await click();
	};
	const u0 = await p.evaluate(() => __tps.updates);
	await sleep(400);
	const u1 = await p.evaluate(() => __tps.updates);
	check('VR: the custom update hook does not steer the camera during the session', u1 === u0, { u0, u1 });
	await rayClick('#dchat-camera-mode [data-camera-mode="orbit"]');
	const v1 = await p.evaluate(() => ({ mode: gsControls.mode, d: __tps.deactivates }));
	check('VR menu: ray click on Orbit leaves the custom mode (deactivate ran)', v1.mode === 'orbit' && v1.d >= 1, v1);
	await rayClick('#dchat-camera-mode [data-camera-mode="custom:tps"]');
	const v2 = await p.evaluate(() => ({ mode: gsControls.mode, a: __tps.activates, painted: window.__gsVrWindows.byName('menu').paints }));
	check('VR menu: ray click on "Custom 3rd Person Controls" switches back (activate ran)', v2.mode === 'custom:tps' && v2.a >= 2, v2);
	await p.evaluate(() => document.querySelector('#dchat-camera-mode [data-camera-mode="custom:tps"]')?.classList.add('gs-shot-mark'));
	check('VR: no console errors', p._errors.length === 0, p._errors);
	await p.close();
}

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
