// VR Map controls (IWER-emulated Meta Quest 3, puppeteer-core 24.43.1):
//  - Controls → Map lists the VR column: left stick pans (all four
//    directions), Zoom in / out rows show "VR: both grips, spread / pinch",
//    plus a "Zoom in / out (VR gesture)" row with an On switch.
//  - In VR: left stick pans level in both axes; one grip alone does nothing
//    (and the right grip alone still cycles locomotion, on release); both
//    grips spread → zoom in, pinch → zoom out, proportional to the spread
//    ratio; 1.5 cm deadzone; smoothed; clamped at Map's 0.3 m; releasing a
//    grip ends it and doesn't cycle locomotion; off switch, a scene binding
//    a grip, a Map VR row remapped to a grip and Orbit all stop it.
//   npm i && BASE=https://localhost:3791 OUT=/workspace/gs-vr-map-zoom-shots node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3791';
const OUT = process.env.OUT || '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await p.setViewport({ width: 1600, height: 900 });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p.evaluateOnNewDocument(() => { try { localStorage.removeItem('gs.vrMapGripZoom'); localStorage.removeItem('gs.controllerBindings.v1'); localStorage.removeItem('gs.cameraControlMode'); } catch {} });
await p.setRequestInterception(true);
p.on('request', (req) => { const u = new URL(req.url());
	if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
	if (u.pathname === '/api/community-scenes') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenes: [] }) });
	if (u.pathname === '/api/chat') return req.respond({ status: 200, contentType: 'text/plain', body: 'stub' });
	req.continue(); });
await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
await sleep(2000);

// ------------------------------------------------------------ Controls tab (2D)
await p.evaluate(() => { window.gsSelectTab('controls'); document.querySelector('#dchat-controls-subtabs [data-controls-section="camera"]')?.click(); document.querySelector('[data-camera-mode="map"]')?.click(); });
await sleep(500);
const ui = await p.evaluate(() => {
	const box = document.getElementById('dchat-key-remap');
	const vr = (id) => { const f = document.getElementById(`gs-remap-map-${id}-xr`); return f ? f.dataset.binding : null; };
	const gest = (id) => box.querySelector(`.gs-remap-ctl-row[data-action="${id}"] .gs-bind-gesture`)?.textContent || null;
	const row = document.getElementById('dchat-grip-zoom-row');
	const cb = document.getElementById('dchat-grip-zoom');
	return { style: box.dataset.style, pan: ['panUp', 'panDown', 'panLeft', 'panRight'].map(vr), zoomIn: gest('zoomIn'), zoomOut: gest('zoomOut'),
		zoomInField: !!document.getElementById('gs-remap-map-zoomIn-xr'), row: row ? row.textContent.replace(/\s+/g, ' ').trim() : null, checked: cb?.checked,
		help: document.getElementById('dchat-grip-zoom-help')?.textContent || '', helpText: document.querySelector('[data-camera-help="map"]')?.textContent.replace(/\s+/g, ' ') || '',
		api: gsControls.inputBindings('map') };
});
check('Controls: Map selected (default)', ui.style === 'map', ui.style);
check('Controls: Map pan keys → VR left stick ↑ ↓ ← → (full stick, both axes)', JSON.stringify(ui.pan) === JSON.stringify(['L-Stick-Up', 'L-Stick-Down', 'L-Stick-Left', 'L-Stick-Right']), ui.pan);
check('Controls: Zoom in row shows "VR: both grips, spread"', ui.zoomIn === 'VR: both grips, spread', ui.zoomIn);
check('Controls: Zoom out row shows "VR: both grips, pinch"', ui.zoomOut === 'VR: both grips, pinch', ui.zoomOut);
check('Controls: zoom has no remappable VR field (gesture), no left-stick zoom', !ui.zoomInField && !ui.api.gestures.some((g) => /^zoom/.test(g.id) && g.xr), ui.api.gestures.filter((g) => /zoom/i.test(g.id)));
check('Controls: "Zoom in / out (VR gesture)" row with an On switch, on by default', /Zoom in \/ out \(VR gesture\)/.test(ui.row || '') && /both grips, spread or pinch/.test(ui.row || '') && ui.checked === true, ui.row);
check('Controls: help explains the gesture', /apart to zoom in/.test(ui.help) && /closer together to zoom out/.test(ui.help), ui.help);
check('Map help text mentions VR left stick pan + both grips zoom', /left stick pans/.test(ui.helpText) && /both grips/.test(ui.helpText), ui.helpText);
check('gsControls.inputBindings(map): zoom rows carry xrGesture + vrGripZoom info', ui.api.gestures.find((g) => g.id === 'zoomIn')?.xrGesture === 'both grips, spread' && ui.api.vrGripZoom?.enabled === true && ui.api.vrGripZoom.blockedBy === '', ui.api.vrGripZoom);
// Screenshot of the menu window with an element scrolled to its middle.
const shotAround = async (name, sel, block = 'center') => {
	if (!OUT) return;
	await p.evaluate((q, b) => { const c = document.getElementById('desktop-chat'); c.style.height = '860px'; c.style.top = '20px'; document.querySelector(q).scrollIntoView({ block: b }); }, sel, block);
	await sleep(300);
	const r = await p.evaluate(() => { const rr = document.getElementById('desktop-chat').getBoundingClientRect(); return { x: rr.left, y: rr.top, w: rr.width, h: rr.height }; });
	await p.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: r.w + 8, height: Math.min(900 - Math.max(0, r.y - 4), r.h + 8) } });
};
const shotPads = (name) => shotAround(name, '#dchat-grip-zoom-row');
const shotKeys = (name) => shotAround(name, '#dchat-key-remap', 'start');
await shotKeys('controls-map-keys-vr-pan');
await shotPads('controls-map-vr-rows');
// Off switch reflects in the UI
await p.click('#dchat-grip-zoom'); await sleep(150);
const off = await p.evaluate(() => ({ stored: localStorage.getItem('gs.vrMapGripZoom'), dim: [...document.querySelectorAll('#dchat-key-remap .gs-bind-gesture')].every((e) => e.classList.contains('off')), help: document.getElementById('dchat-grip-zoom-help').textContent }));
check('Controls: unticking turns the grip zoom off (saved, chips dimmed)', off.stored === '0' && off.dim && /off/.test(off.help), off);
await shotPads('controls-map-vr-rows-off');
await p.click('#dchat-grip-zoom'); await sleep(150);
check('Controls: ticking turns it back on', await p.evaluate(() => localStorage.getItem('gs.vrMapGripZoom') === null && gsVrInput.gripZoom.enabled));

// ------------------------------------------------------------ VR
// Head 1.6 m up looking 45° down (gaze meets the empty ground 2.26 m away);
// controllers at chest height pointing out sideways (rays off the menu).
const P45 = [-Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
// A map to look at in the mirror: a 40 m grid on a ground plane at y = 0 (same
// pivot as the bare ground) and a few boxes off to the sides of the gaze.
await p.evaluate(() => {
	const g = new THREE.GridHelper(40, 40, 0x6366f1, 0x94a3b8); g.name = 'zoomTestGrid'; scene.add(g);
	const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x1f2937 }));
	ground.rotation.x = -Math.PI / 2; ground.position.y = -0.001; ground.name = 'zoomTestGround'; scene.add(ground);
	[[-1.2, -2.5, 0xef4444], [1.2, -2.5, 0x22c55e], [-2.5, -5, 0xf59e0b], [2.5, -5, 0x3b82f6]].forEach(([x, z, c]) => {
		const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: c })); m.position.set(x, 0.25, z); scene.add(m);
	});
});
const mirror = async (name) => { if (OUT) await p.screenshot({ path: `${OUT}/${name}.png` }); };
await p.evaluate((q) => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(...q); }, P45);
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
await sleep(1200);
check('Enter VR (IWER Quest 3)', await p.evaluate(() => renderer.xr.isPresenting));
await p.evaluate(() => {
	window.__t = {
		hands(spread, y = 1.25, z = -0.35) {
			// Rays point out sideways (left hand left, right hand right), away from the menu windows.
			const d = window.__xrDevice; const ql = [0, Math.SQRT1_2, 0, Math.SQRT1_2], qr = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];
			d.controllers.left.position.set(-spread / 2, y, z); d.controllers.left.quaternion.set(...ql);
			d.controllers.right.position.set(spread / 2, y, z); d.controllers.right.quaternion.set(...qr);
		},
		squeeze(h, v) { window.__xrDevice.controllers[h].updateButtonValue('squeeze', v); },
		stick(h, x, y) { window.__xrDevice.controllers[h].updateAxes('thumbstick', x, y); },
		player() { let o = camera; while (o.parent && o.parent !== scene) o = o.parent; return o; },
		head() { const v = new THREE.Vector3(); camera.getWorldPosition(v); return v; },
		state() { const h = this.head(); const z = gsVrInput.gripZoom; return { head: h.toArray(), player: this.player().position.toArray(), loco: gsVrInput.locomotionMode, zoom: z, dist: z.last ? z.last.distance : null, rayOnWindow: { ...gsXrInput._rayOnWindow }, owned: gsVrInput.stickOwnedByWindow }; },
		reset() { const pl = this.player(); pl.position.set(0, 0, 0); pl.quaternion.identity(); }
	};
	const nav = document.getElementById('dchat-nav-type'); if (nav) { nav.value = 'free'; nav.dispatchEvent(new Event('change')); }
	__t.hands(0.3); __t.reset();
});
await sleep(400);
const st = () => p.evaluate(() => __t.state());

// Pan: full left stick, both axes
let s0 = await st();
await p.evaluate(() => __t.stick('left', 0, -1)); await sleep(1000); await p.evaluate(() => __t.stick('left', 0, 0)); await sleep(200);
let s1 = await st();
const fwd = { dx: s1.player[0] - s0.player[0], dy: s1.player[1] - s0.player[1], dz: s1.player[2] - s0.player[2] };
check('Pan: left stick up moves forward, level (−z, no height change)', fwd.dz < -0.8 && Math.abs(fwd.dx) < 0.05 && Math.abs(fwd.dy) < 1e-6, fwd);
await p.evaluate(() => __t.stick('left', 1, 0)); await sleep(1000); await p.evaluate(() => __t.stick('left', 0, 0)); await sleep(200);
let s2 = await st();
const rt = { dx: s2.player[0] - s1.player[0], dy: s2.player[1] - s1.player[1], dz: s2.player[2] - s1.player[2] };
check('Pan: left stick right strafes right (+x, level)', rt.dx > 0.8 && Math.abs(rt.dz) < 0.05 && Math.abs(rt.dy) < 1e-6, { ...rt, rayOnWindow: s2.rayOnWindow, owned: s2.owned });
await p.evaluate(() => __t.stick('left', -0.7, 0.7)); await sleep(800); await p.evaluate(() => __t.stick('left', 0, 0)); await sleep(200);
let s3 = await st();
check('Pan: diagonal (back-left) uses both axes at once', s3.player[0] < s2.player[0] - 0.3 && s3.player[2] > s2.player[2] + 0.3, { from: s2.player, to: s3.player });
check('Pan: no zoom gesture from the stick', s3.zoom.count === 0 && !s3.zoom.active, s3.zoom);
// Pan speed grows with height above the map (×head height / 1.6 m)
await p.evaluate(() => { __t.reset(); __t.player().position.y = 16; }); await sleep(200);
const h0 = await st();
await p.evaluate(() => __t.stick('left', 0, -1)); await sleep(500); await p.evaluate(() => __t.stick('left', 0, 0)); await sleep(200);
const h1 = await st();
const highMove = Math.abs(h1.player[2] - h0.player[2]);
check('Pan: 16 m up the same push pans ~11× faster (still level)', highMove > 5 * Math.abs(fwd.dz) / 2 && Math.abs(h1.player[1] - 16) < 1e-6, { highMove, lowMovePerHalfSecond: Math.abs(fwd.dz) / 2 });
await p.evaluate(() => __t.reset()); await sleep(200);

// One grip alone: nothing (left), right alone still cycles locomotion on release
s0 = await st();
await p.evaluate(() => __t.squeeze('left', 1)); await sleep(300);
await p.evaluate(() => __t.hands(0.7)); await sleep(500);
s1 = await st();
await p.evaluate(() => __t.squeeze('left', 0)); await p.evaluate(() => __t.hands(0.3)); await sleep(300);
check('Single left grip + moving the hands: no zoom, no movement', !s1.zoom.active && s1.zoom.count === 0 && JSON.stringify(s1.player) === JSON.stringify(s0.player), { zoom: s1.zoom.active, p0: s0.player, p1: s1.player });
check('Single left grip: locomotion unchanged', (await st()).loco === s0.loco);
await p.evaluate(() => __t.squeeze('right', 1)); await sleep(300);
const mid = await st();
await p.evaluate(() => __t.hands(0.7)); await sleep(400);
const mid2 = await st();
await p.evaluate(() => __t.squeeze('right', 0)); await p.evaluate(() => __t.hands(0.3)); await sleep(300);
const after = await st();
check('Single right grip: no zoom while held, locomotion not cycled on press', !mid2.zoom.active && mid.loco === s0.loco && JSON.stringify(mid2.player) === JSON.stringify(s0.player), { loco: mid.loco });
check('Single right grip: releasing it cycles locomotion (as before, now on release)', after.loco !== s0.loco, { before: s0.loco, after: after.loco });
// back to free (free → off → planar → free)
for (let i = 0; i < 5 && (await st()).loco !== 'free'; i++) { await p.evaluate(() => __t.squeeze('right', 1)); await sleep(200); await p.evaluate(() => __t.squeeze('right', 0)); await sleep(250); }
check('Locomotion back to free', (await st()).loco === 'free');

// Spread → zoom in
const gesture = async (from, to, { settle = 900, steps = 6 } = {}) => {
	await p.evaluate((s) => __t.hands(s), from); await sleep(200);
	await p.evaluate(() => { __t.squeeze('left', 1); }); await sleep(150);
	await p.evaluate(() => { __t.squeeze('right', 1); }); await sleep(350);
	const start = await st();
	for (let i = 1; i <= steps; i++) { await p.evaluate((s) => __t.hands(s), from + (to - from) * i / steps); await sleep(60); }
	await sleep(settle);
	const end = await st();
	return { start, end };
};
const moved = (a, b) => Math.hypot(b.player[0] - a.player[0], b.player[1] - a.player[1], b.player[2] - a.player[2]);
const release = async () => { await p.evaluate(() => __t.squeeze('right', 0)); await sleep(150); await p.evaluate(() => __t.squeeze('left', 0)); await sleep(250); };
await p.evaluate(() => __t.reset()); await sleep(300);
await mirror('vr-mirror-before-zoom');
let g = await gesture(0.3, 0.6);
const d0 = g.start.zoom.info?.startDistance;
check('Both grips start the gesture (pivot on the ground along the gaze, ~2.26 m)', g.start.zoom.active && Math.abs(d0 - 1.6 * Math.SQRT2) < 0.05 && Math.abs(g.start.zoom.info.pivot.y) < 1e-3, g.start.zoom.info);
let expect = d0 * 0.3 / (0.6 - 0.015);
check('Spread 0.30 → 0.60 m zooms IN: head–pivot distance × 0.3 / 0.585', Math.abs(g.end.dist - expect) < 0.03, { start: d0, end: g.end.dist, expect });
check('Spread: the rig moved exactly that much toward the pivot', Math.abs(moved(g.start, g.end) - (d0 - expect)) < 0.03, { moved: moved(g.start, g.end), expect: d0 - expect });
check('Zoom in moves toward the ground point (lower and forward)', g.end.head[1] < g.start.head[1] - 0.3 && g.end.head[2] < g.start.head[2] - 0.3, { start: g.start.head, end: g.end.head });
check('Spread: locomotion not cycled, gesture still active while held', g.end.loco === 'free' && g.end.zoom.active);
await release();
let r1 = await st();
check('Releasing a grip ends the gesture and does not cycle locomotion', !r1.zoom.active && r1.loco === 'free', { active: r1.zoom.active, loco: r1.loco });
await sleep(300);
const r2 = await st();
check('No drift after release', JSON.stringify(r2.player) === JSON.stringify(r1.player));
await mirror('vr-mirror-after-zoom-in');

// Rig moved and turned: the pivot is still where you look (world space)
await p.evaluate(() => { __t.reset(); const pl = __t.player(); pl.position.set(5, 0, 3); pl.rotation.set(0, Math.PI / 2, 0); }); await sleep(300);
g = await gesture(0.3, 0.6);
const pv = g.start.zoom.info?.pivot;
check('Rig at (5, 0, 3) turned 90°: pivot on the ground 1.6 m along the gaze (−x)', pv && Math.abs(pv.x - (g.start.head[0] - 1.6)) < 0.1 && Math.abs(pv.z - g.start.head[2]) < 0.1 && Math.abs(pv.y) < 1e-3 && Math.abs(g.start.head[0] - 5) < 0.1, { pivot: pv, head: g.start.head });
check('…and the zoom moves toward it (−x, lower)', g.end.player[0] < 5 - 0.5 && g.end.player[1] < -0.5 && Math.abs(g.end.player[2] - 3) < 0.1, g.end.player);
await release();

// Pinch → zoom out
await p.evaluate(() => __t.reset()); await sleep(200);
g = await gesture(0.6, 0.3);
expect = g.start.zoom.info.startDistance * 0.6 / (0.3 + 0.015);
check('Pinch 0.60 → 0.30 m zooms OUT: distance × 0.6 / 0.315', Math.abs(g.end.dist - expect) < 0.05, { start: g.start.zoom.info.startDistance, end: g.end.dist, expect });
check('Pinch: the rig moved exactly that much away from the pivot', Math.abs(moved(g.start, g.end) - (expect - g.start.zoom.info.startDistance)) < 0.05, { moved: moved(g.start, g.end), expect: expect - g.start.zoom.info.startDistance });
await mirror('vr-mirror-after-zoom-out');
check('Zoom out moves away from the ground point (higher and back)', g.end.head[1] > g.start.head[1] + 0.5 && g.end.head[2] > g.start.head[2] + 0.5, { start: g.start.head, end: g.end.head });
await release();

// Deadzone
await p.evaluate(() => __t.reset()); await sleep(200);
g = await gesture(0.4, 0.41, { steps: 2, settle: 500 });
check('Deadzone: 1 cm hand movement does not zoom', g.start.zoom.active && Math.abs(g.end.dist - g.start.zoom.info.startDistance) < 1e-6 && JSON.stringify(g.end.player) === JSON.stringify(g.start.player), { start: g.start.zoom.info.startDistance, end: g.end.dist });
await release();

// Smoothing: right after a jump the distance is between start and target
await p.evaluate(() => __t.reset()); await sleep(200);
await p.evaluate(() => __t.hands(0.2)); await sleep(150);
await p.evaluate(() => __t.squeeze('left', 1)); await sleep(100); await p.evaluate(() => __t.squeeze('right', 1)); await sleep(300);
const sm0 = await st();
const smooth = await p.evaluate(async () => {
	__t.hands(0.8);
	const samples = [];
	const t0 = performance.now();
	while (performance.now() - t0 < 600) { await new Promise((r) => setTimeout(r, 16)); const z = gsVrInput.gripZoom.info; if (z) samples.push([z.smoothed, z.target]); }
	return samples;
});
const firstMoved = smooth.find(([s, t]) => t < 0.99);
check('Smoothing: the zoom eases toward the target (an in-between value is seen)', smooth.some(([s, t]) => t < 0.99 && s > t + 0.02 && s < 0.99), { first: firstMoved, last: smooth[smooth.length - 1], n: smooth.length });
await release();

// Clamp at Map's minimum (0.3 m from the pivot)
await p.evaluate(() => __t.reset()); await sleep(200);
g = await gesture(0.08, 1.0, { settle: 1200 });
check('Clamp: spreading far zooms in only to Map\'s 0.3 m minimum', Math.abs(g.end.dist - 0.3) < 0.02 && g.end.zoom.min === 0.3 && Math.abs(moved(g.start, g.end) - (g.start.zoom.info.startDistance - 0.3)) < 0.03, { end: g.end.dist, moved: moved(g.start, g.end), target: g.end.zoom.last?.target });
await release();
// and from there pinching zooms back out
g = await gesture(0.8, 0.4, { settle: 900 });
check('Clamp: from the minimum, pinching zooms back out', g.end.dist > g.start.zoom.info.startDistance + 0.1, { start: g.start.zoom.info.startDistance, end: g.end.dist });
await release();

// Off switch: both grips do nothing (right grip cycles on press as before)
await p.evaluate(() => { gsControls.setVrGripZoom(false); __t.reset(); }); await sleep(200);
const offBefore = await st();
g = await gesture(0.3, 0.6, { settle: 400 });
check('Grip zoom off: both grips do nothing', !g.end.zoom.active && JSON.stringify(g.end.player) === JSON.stringify(offBefore.player), { zoom: g.end.zoom.active });
check('Grip zoom off: right grip cycles locomotion right away (on press)', g.start.loco !== offBefore.loco, { before: offBefore.loco, after: g.start.loco });
await release();
await p.evaluate(() => gsControls.setVrGripZoom(true));
for (let i = 0; i < 5 && (await st()).loco !== 'free'; i++) { await p.evaluate(() => __t.squeeze('right', 1)); await sleep(200); await p.evaluate(() => __t.squeeze('right', 0)); await sleep(250); }

// A scene binding a grip takes priority while its controls exist
await p.evaluate(() => { window.__grab = gsControls.defineCustomScheme({ id: 'grabber', name: 'Grabber', params: [{ name: 'grab', label: 'Grab', type: 'key', default: 'G', xr: 'L-Squeeze' }] }); __t.reset(); });
await sleep(300);
const scBefore = await st();
g = await gesture(0.3, 0.6, { settle: 400 });
const grabSeen = await p.evaluate(() => window.__grab.isDown('grab'));
check('Scene binds the left grip: no zoom, the scene gets the grip', !g.end.zoom.active && g.end.zoom.count === g.start.zoom.count && JSON.stringify(g.end.player) === JSON.stringify(scBefore.player) && grabSeen === true, { active: g.end.zoom.active, grab: grabSeen });
await release();
await p.evaluate(() => gsControls.removeCustomScheme('grabber')); await sleep(300);
for (let i = 0; i < 5 && (await st()).loco !== 'free'; i++) { await p.evaluate(() => __t.squeeze('right', 1)); await sleep(200); await p.evaluate(() => __t.squeeze('right', 0)); await sleep(250); }
await p.evaluate(() => __t.reset()); await sleep(200);
g = await gesture(0.3, 0.6, { settle: 600 });
check('Scheme removed: the grip zoom works again', g.end.zoom.active && g.end.dist < g.start.zoom.info.startDistance * 0.7 && moved(g.start, g.end) > 0.5, { start: g.start.zoom.info?.startDistance, end: g.end.dist });
await release();

// A Map VR row remapped to a grip pauses it
const remapOk = await p.evaluate(() => gsControls.setControllerBinding('map', 'xr', 'rise', 'R-Squeeze'));
const blocked = await p.evaluate(() => gsVrInput.gripZoom.blockedBy);
check('Remapping a Map VR row to a grip pauses the zoom (blockedBy remapped:rise)', remapOk && blocked === 'remapped:rise', { remapOk, blocked });
await p.evaluate(() => __t.reset()); await sleep(200);
g = await gesture(0.3, 0.6, { settle: 400 });
check('…and both grips then do not zoom', !g.end.zoom.active);
await release();
await p.evaluate(() => gsControllerBindings.resetStock('map', 'xr'));
check('Reset VR: zoom available again', await p.evaluate(() => gsVrInput.gripZoom.blockedBy === ''));
for (let i = 0; i < 5 && (await st()).loco !== 'free'; i++) { await p.evaluate(() => __t.squeeze('right', 1)); await sleep(200); await p.evaluate(() => __t.squeeze('right', 0)); await sleep(250); }

// Orbit: no grip zoom
await p.evaluate(() => { document.querySelector('[data-camera-mode="orbit"]')?.click(); __t.reset(); }); await sleep(300);
const obBefore = await st();
g = await gesture(0.3, 0.6, { settle: 400 });
check('Orbit: both grips do not zoom (Map only)', !g.end.zoom.active && JSON.stringify(g.end.player) === JSON.stringify(obBefore.player));
await release();
await p.evaluate(() => document.querySelector('[data-camera-mode="map"]')?.click()); await sleep(300);

// VR menu texture of the Controls tab (what the headset shows)
if (OUT) {
	await p.evaluate(() => { window.gsSelectTab('controls'); document.querySelector('#dchat-controls-subtabs [data-controls-section="camera"]')?.click(); });
	await sleep(400);
	await p.evaluate(() => { const e = document.getElementById('dchat-grip-zoom-row'); e.scrollIntoView({ block: 'center' }); });
	await sleep(800);
	const url = await p.evaluate(() => { const w = window.__gsVrWindows.byName('menu'); w.tick(true); return w.canvas.toDataURL('image/png'); });
	fs.writeFileSync(`${OUT}/vr-menu-controls-map-rows.png`, Buffer.from(url.split(',')[1], 'base64'));
}
check('No console errors', errors.length === 0, errors);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exitCode = fail ? 1 : 0;
