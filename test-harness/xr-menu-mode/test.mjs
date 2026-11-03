// AR | VR toggle in the VR / AR menu (the top bar of the menu window painted
// into the headset), on an IWER Meta Quest 3.
//   - The toggle is in the in-headset top bar next to Exit VR and shows the
//     current mode; it is the same element / setting (gs.xrMode) as desktop.
//   - Ray-click AR in a VR session: the session ends and an immersive-ar
//     session starts straight away (passthrough, no sky).
//   - Ray-click VR in an AR session: live colour sky, same session.
//   - Ray-click AR again: passthrough back. Exit: Enter label follows the choice.
//   - Fallback: the browser refuses the new session -> in-app dialog (no native
//     dialog) with one tap to Enter AR; that tap starts AR.
//   - AR not supported: the AR option is disabled in the headset menu; the Env
//     tab / API choice shows an in-app message and stays in VR.
// /api/* is ALWAYS stubbed (CDP Fetch): no live AI calls, no KV writes.
//   BASE=https://localhost:3531 SHOT_DIR=/tmp/xr-menu-shots node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3531';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-arvrmenu-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };

async function open({ before = null } = {}) {
	const args = ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
	const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args, userDataDir: fs.mkdtempSync('/tmp/gs-xrmenu-') });
	const p = await b.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
	p.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.dismiss().catch(() => {}); });
	await p.setViewport({ width: 1400, height: 900 });
	await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	// Record every requestSession; tests can make the next one fail.
	await p.evaluateOnNewDocument(() => {
		const xr = navigator.xr; const real = xr.requestSession.bind(xr);
		window.__xrReq = []; window.__xrFailNext = null;
		xr.requestSession = (m, init) => { window.__xrReq.push(m); if (window.__xrFailNext) { const n = window.__xrFailNext; window.__xrFailNext = null; return Promise.reject(new DOMException('mock refusal', n)); } return real(m, init); };
	});
	if (before) await before(p);
	const cdp = await p.createCDPSession();
	await cdp.send('Fetch.enable', { patterns: [{ urlPattern: new URL(BASE).origin + '/api/*', requestStage: 'Request' }] });
	const json = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
	cdp.on('Fetch.requestPaused', (ev) => {
		const u = new URL(ev.request.url);
		const body = u.pathname === '/api/backends' ? { backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }
			: (u.pathname === '/api/chat' || u.pathname === '/api/theme-chat') ? { content: [{ type: 'text', text: 'Mock reply.' }] }
			: { ok: true, scenes: [], items: [] };
		cdp.send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: json(body) }).catch(() => {});
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
	await sleep(1500);
	return { b, p, errors };
}

const st = (p) => p.evaluate(() => {
	const t = document.getElementById('gs-xr-mode'); const r = t.getBoundingClientRect();
	const bs = Object.fromEntries([...t.querySelectorAll('button')].map((b) => [b.dataset.xrMode, { disabled: b.disabled, checked: b.getAttribute('aria-checked') }]));
	const s = renderer.xr.getSession();
	const exit = document.getElementById('gs-exit-vr-btn').getBoundingClientRect();
	return { presenting: renderer.xr.isPresenting, session: gsXrMode.session, passthrough: gsXrMode.passthrough, pref: gsXrMode.preferred, alpha: renderer.getClearAlpha(),
		shown: !t.hidden && r.width > 0 && r.height > 0 && getComputedStyle(t).display !== 'none', inDock: t.parentElement && t.parentElement.id === 'gs-dock',
		nextToExit: Math.abs((r.top + r.bottom) / 2 - (exit.top + exit.bottom) / 2) < 8 && exit.width > 0,
		bs, active: t.dataset.active, label: document.getElementById('XRButton').textContent, sid: s ? (s.__gsId ||= Math.random().toString(36).slice(2)) : null, reqs: window.__xrReq.slice() };
});

async function enterXr(p, mode = 'vr') {
	await p.evaluate((m) => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); window.gsXrMode.set(m); }, mode);
	await p.click('#XRButton').catch(() => {});
	await waitPresenting(p, true);
	await installAim(p);
}
async function waitPresenting(p, want, ms = 10000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if ((await p.evaluate(() => renderer.xr.isPresenting)) === want) break; await sleep(200); }
	await sleep(1200);
}
async function installAim(p) {
	await p.evaluate(() => {
		const V = THREE.Vector3;
		window.__t = {
			win: (n) => window.__gsVrWindows.byName(n),
			pointFor(el, winName) { const w = this.win(winName); const sr = w.source.getBoundingClientRect(); const r = el.getBoundingClientRect(); const u = (r.left + r.width / 2 - sr.left) / sr.width, v = 1 - (r.top + r.height / 2 - sr.top) / sr.height; w.mesh.updateMatrixWorld(true); return w.mesh.localToWorld(new V(u - 0.5, v - 0.5, 0.0)); },
			aim(hand, target) { const c = [0, 1].map((i) => renderer.xr.getController(i)).find((x) => x.userData.handedness === hand); const xrCam = renderer.xr.getCamera(); const head = new V(); xrCam.getWorldPosition(head); const origin = head.clone().add(new V(hand === 'right' ? 0.15 : -0.15, -0.3, -0.1)); const parent = c.parent; parent.updateMatrixWorld(true); const inv = parent.matrixWorld.clone().invert(); const o = origin.clone().applyMatrix4(inv), t = target.clone().applyMatrix4(inv); const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(o, t, new V(0, 1, 0))); const dc = window.__xrDevice.controllers[hand]; dc.position.set(o.x, o.y, o.z); dc.quaternion.set(q.x, q.y, q.z, q.w); },
			trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); }
		};
	});
}
// Aim the right controller ray at an element on the menu window and pull the trigger.
const rayClick = async (p, sel, win = 'menu') => {
	await p.evaluate((s, w) => __t.aim('right', __t.pointFor(document.querySelector(s), w)), sel, win);
	await sleep(400);
	const hovered = await p.evaluate((s) => document.querySelector(s).classList.contains('gs-ray-hover'), sel);
	await p.evaluate(() => __t.trigger('right', 1)); await sleep(250); await p.evaluate(() => __t.trigger('right', 0)); await sleep(400);
	return hovered;
};
// The VR menu window's painted canvas (what the headset shows) as a PNG.
const dumpMenuCanvas = (p, file) => p.evaluate(() => {
	const w = window.__gsVrWindows.byName('menu');
	const c = w && (w.canvas || (w.texture && w.texture.image) || (w.mesh && w.mesh.material && w.mesh.material.map && w.mesh.material.map.image));
	if (!c || !c.toDataURL) return null;
	return c.toDataURL('image/png');
}).then((d) => { if (d) fs.writeFileSync(file, Buffer.from(d.split(',')[1], 'base64')); return !!d; });

// ───────────── 1. VR session → AR session → live VR sky → AR → exit ─────────────
{
	const { b, p, errors } = await open();
	const sup = await p.evaluate(() => gsXrMode.support);
	check('IWER Quest 3 reports VR and AR support', sup.vr && sup.ar, sup);
	await enterXr(p, 'vr');
	let s = await st(p);
	check('[vr] In an immersive-vr session', s.presenting && s.session === 'immersive-vr', s);
	check('[vr] AR | VR toggle is shown in the headset menu top bar', s.shown && s.inDock, s);
	check('[vr] …next to Exit VR', s.nextToExit, s);
	check('[vr] Toggle shows VR as the current mode', s.bs.vr.checked === 'true' && s.bs.ar.checked === 'false' && s.active === 'vr', s.bs);
	const onMenu = await p.evaluate(() => { const w = __gsVrWindows.byName('menu'); return !!w && w.mesh.visible && w.source.contains(document.getElementById('gs-xr-mode')); });
	check('[vr] Toggle is part of the menu window painted in the headset', onMenu);
	await sleep(600);
	check('[vr] Menu canvas dump written', await dumpMenuCanvas(p, `${SHOT_DIR}/01-vr-menu-canvas.png`));
	await p.screenshot({ path: `${SHOT_DIR}/01-vr-session-page.png` });
	const sid1 = s.sid;

	const hov = await rayClick(p, '#gs-xr-mode [data-xr-mode="ar"]');
	check('[vr→ar] Controller ray hovers the AR button', hov);
	await waitPresenting(p, true, 8000);
	await installAim(p);
	s = await st(p);
	check('[vr→ar] Ray-click AR ends VR and starts an immersive-ar session', s.presenting && s.session === 'immersive-ar' && s.sid !== sid1, s);
	check('[vr→ar] requestSession asked for immersive-ar', s.reqs[s.reqs.length - 1] === 'immersive-ar', s.reqs);
	check('[vr→ar] Passthrough: clear alpha 0', s.passthrough && s.alpha === 0, s);
	check('[vr→ar] Toggle (still in the headset menu) shows AR; saved as gs.xrMode', s.shown && s.bs.ar.checked === 'true' && s.pref === 'ar' && (await p.evaluate(() => localStorage.getItem('gs.xrMode'))) === 'ar', s);
	await sleep(600);
	check('[ar] Menu canvas dump written', await dumpMenuCanvas(p, `${SHOT_DIR}/02-ar-menu-canvas.png`));
	await p.screenshot({ path: `${SHOT_DIR}/02-ar-session-page.png` });
	const sid2 = s.sid;

	await rayClick(p, '#gs-xr-mode [data-xr-mode="vr"]');
	await sleep(600);
	s = await st(p);
	check('[ar→vr] Ray-click VR in AR: colour sky live, same session', s.presenting && s.session === 'immersive-ar' && s.sid === sid2 && !s.passthrough, s);
	check('[ar→vr] Toggle shows VR; pref saved as vr', s.bs.vr.checked === 'true' && s.pref === 'vr', s);
	const envVr = await p.evaluate(() => { const g = document.querySelector('#dchat-env-mode [data-id="vr"]'); return g && /active/.test(g.getAttribute('class') || '') || g?.getAttribute('aria-pressed') === 'true' || g?.dataset.variant === 'active'; });
	console.log('INFO Env tab VR button active marker:', envVr);
	await sleep(600);
	await dumpMenuCanvas(p, `${SHOT_DIR}/03-ar-session-vr-sky-menu-canvas.png`);

	await rayClick(p, '#gs-xr-mode [data-xr-mode="ar"]');
	await sleep(600);
	s = await st(p);
	check('[ar] Ray-click AR again: passthrough back, same session', s.session === 'immersive-ar' && s.sid === sid2 && s.passthrough && s.bs.ar.checked === 'true', s);

	await rayClick(p, '#gs-exit-vr-btn');
	await waitPresenting(p, false);
	s = await st(p);
	check('[exit] Exit VR returns to the desktop; Enter reads ENTER AR', !s.presenting && /ENTER AR/.test(s.label) && s.bs.ar.checked === 'true', s);
	check('[exit] Desktop toggle visible again', s.shown);
	check('No page errors / native dialogs', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 2. Fallback: the browser refuses the immediate switch ─────────────
{
	const { b, p, errors } = await open();
	await enterXr(p, 'vr');
	await p.evaluate(() => { window.__xrFailNext = 'NotAllowedError'; });
	await rayClick(p, '#gs-xr-mode [data-xr-mode="ar"]');
	await waitPresenting(p, false, 6000);
	const dlg = await p.evaluate(() => { const c = document.getElementById('gs-dialog'); const r = c && c.getBoundingClientRect(); return { open: !!c && r.width > 0 && getComputedStyle(c).display !== 'none' && !c.closest('[hidden]'), text: c ? c.textContent : '' }; });
	let s = await st(p);
	check('[fallback] Refused switch: back on the page, AR kept as the choice', !s.presenting && s.pref === 'ar' && /ENTER AR/.test(s.label), s);
	check('[fallback] In-app dialog offers one tap to Enter AR', dlg.open && /one more tap/i.test(dlg.text) && /Enter AR/.test(dlg.text), dlg);
	await p.screenshot({ path: `${SHOT_DIR}/04-fallback-dialog.png` });
	const okSel = await p.evaluate(() => { const bs = [...document.querySelectorAll('#gs-dialog button')]; const ok = bs.find((x) => /Enter AR/.test(x.textContent)); if (ok) ok.id ||= 'gs-test-dlg-ok'; return ok ? '#' + ok.id : null; });
	await p.click(okSel);
	await waitPresenting(p, true, 8000);
	s = await st(p);
	check('[fallback] Tapping Enter AR starts the immersive-ar session', s.presenting && s.session === 'immersive-ar' && s.passthrough, s);
	check('[fallback] No page errors / native dialogs', errors.filter((e) => !/mock refusal/.test(e)).length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 3. Headset without immersive-ar ─────────────
{
	const { b, p, errors } = await open({ before: (p) => p.evaluateOnNewDocument(() => {
		const xr = navigator.xr; const real = xr.isSessionSupported.bind(xr);
		xr.isSessionSupported = (m) => (m === 'immersive-ar' ? Promise.resolve(false) : real(m));
	}) });
	await enterXr(p, 'vr');
	let s = await st(p);
	check('[vr-only] Toggle shown in the headset menu, AR disabled, VR current', s.shown && s.bs.ar.disabled && s.bs.vr.checked === 'true', s);
	await rayClick(p, '#gs-xr-mode [data-xr-mode="ar"]');
	s = await st(p);
	check('[vr-only] Ray-clicking the disabled AR keeps the VR session', s.presenting && s.session === 'immersive-vr', s);
	await p.evaluate(() => gsXrMode.choose('ar'));
	await sleep(500);
	const dlg = await p.evaluate(() => { const c = document.getElementById('gs-dialog'); return c ? c.textContent : ''; });
	s = await st(p);
	check('[vr-only] Choosing AR (Env tab / API) shows an in-app message and stays in VR', /isn.t supported/.test(dlg) && s.presenting && s.session === 'immersive-vr', { dlg, s });
	await sleep(400);
	await p.screenshot({ path: `${SHOT_DIR}/05-vr-only-message-page.png` });
	check('[vr-only] No page errors / native dialogs', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 4. The Env tab's AR / VR buttons do the same in a session ─────────────
{
	const { b, p, errors } = await open();
	await enterXr(p, 'vr');
	await p.evaluate(() => document.querySelector('#dchat-env-mode [data-id="ar"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
	await waitPresenting(p, true, 8000);
	let s = await st(p);
	check('[env] Env tab "AR (passthrough)" in a VR session switches to an immersive-ar session', s.session === 'immersive-ar' && s.passthrough && s.bs.ar.checked === 'true', s);
	await p.evaluate(() => document.querySelector('#dchat-env-mode [data-id="vr"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
	await sleep(600);
	s = await st(p);
	check('[env] Env tab "VR (color)" in AR: colour sky, top-bar toggle follows (VR)', s.session === 'immersive-ar' && !s.passthrough && s.bs.vr.checked === 'true', s);
	check('[env] No page errors / native dialogs', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 5. Menu light: a point light above the VR menu in dark scenes ─────────────
{
	const { b, p, errors } = await open();
	// A dark scene: black background, black fog, a lit (standard) floor and a
	// box beside the menu, one dim user light.
	await p.evaluate(() => {
		scene.background = new THREE.Color(0x000000);
		scene.fog = new THREE.Fog(0x000000, 0.5, 3);
		const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.9 }));
		floor.rotation.x = -Math.PI / 2; floor.name = 'darkFloor'; scene.add(floor);
		const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
		box.position.set(0.9, 1.4, -1.2); box.name = 'darkBox'; scene.add(box);
		const dim = new THREE.PointLight(0x3355ff, 0.05, 2); dim.position.set(5, 3, 5); dim.name = 'userDimLight'; scene.add(dim);
	});
	const before = await p.evaluate(async () => ({ inScene: !!scene.getObjectByName('gsMenuLight'), lights: (await gsSceneExport.exportGLTF()).lightCount }));
	check('[light] No menu light outside XR', !before.inScene, before);
	await enterXr(p, 'vr');
	await sleep(500);
	const L = () => p.evaluate(() => {
		const l = scene.getObjectByName('gsMenuLight'); const w = __gsVrWindows.byName('menu');
		if (!l) return { present: false, menuVisible: w.mesh.visible };
		l.updateWorldMatrix(true, false); w.mesh.updateWorldMatrix(true, false);
		const lp = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld), mp = new THREE.Vector3().setFromMatrixPosition(w.mesh.matrixWorld);
		const m = w.mesh.material;
		return { present: true, point: l.isPointLight, parent: l.parent && l.parent.name, shadow: l.castShadow, intensity: l.intensity, distance: l.distance, decay: l.decay, noExport: !!l.userData.gsNoExport,
			aboveTop: lp.y - (mp.y + w.heightM / 2), dx: lp.x - mp.x, dz: lp.z - mp.z, menuVisible: w.mesh.visible,
			mat: { basic: !!m.isMeshBasicMaterial, fog: m.fog, toneMapped: m.toneMapped } };
	});
	let l = await L();
	check('[light] In XR a PointLight sits just above the menu window (no shadows)', l.present && l.point && l.parent === 'gsPanelAnchor' && !l.shadow && l.aboveTop > 0.05 && l.aboveTop < 0.4, l);
	check('[light] Sensible range: lights the menu area, not the whole scene', l.intensity > 0.5 && l.intensity < 5 && l.distance > 1 && l.distance <= 6 && l.decay === 2, l);
	check('[light] Menu window is unlit (MeshBasicMaterial), ignores fog and tone mapping', l.mat.basic && l.mat.fog === false && l.mat.toneMapped === false, l.mat);
	// Follows the menu: move the window anchor (what Follow mode does).
	const follow = await p.evaluate(() => { const a = scene.getObjectByName('gsPanelAnchor'); a.position.set(1.5, 0, -0.7); a.rotation.set(0, 0.8, 0); a.updateMatrixWorld(true); return true; });
	await sleep(300);
	const l2 = await L();
	check('[light] Follows the menu when the window anchor moves', follow && Math.abs(l2.aboveTop - l.aboveTop) < 0.02 && Math.hypot(l2.dx, l2.dz) - Math.hypot(l.dx, l.dz) < 0.02, { l, l2 });
	await p.evaluate(() => { const a = scene.getObjectByName('gsPanelAnchor'); a.position.set(0, 0, 0); a.rotation.set(0, 0, 0); a.updateMatrixWorld(true); });
	await sleep(400);
	// It actually lights lit surfaces: the box beside the menu, rendered brightness on vs off.
	const lum = async () => { const png = await p.screenshot({ encoding: 'base64' }); return p.evaluate(async (src) => { const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; }, png); };
	await p.evaluate(() => { __gsVrWindows.byName('menu').mesh.visible = false; }); // measure the room, not the bright menu
	await sleep(400);
	const on = await lum();
	await p.evaluate(() => { gsMenuLight.intensity = 0; }); await sleep(400);
	const off = await lum();
	await p.evaluate(() => { __gsVrWindows.byName('menu').mesh.visible = true; }); await sleep(200);
	check('[light] Lit surfaces near the menu are brighter with the menu light', on > off + 1, { on, off });
	const exp = await p.evaluate(async () => (await gsSceneExport.exportGLTF()).lightCount);
	check('[light] 3D export in XR has the same lights as before (menu light not exported)', exp === before.lights, { exp, before: before.lights });
	const roots = await p.evaluate(() => { let found = false; for (const r of [...scene.children]) { if (r.name === 'gsPanelAnchor') continue; r.traverse((o) => { if (o.name === 'gsMenuLight') found = true; }); } return found; });
	check('[light] Menu light only lives under the (system) window anchor', !roots);
	// Hide UI in the headset (HUD toggle): menu hidden, light off; show again: back on.
	await p.evaluate(() => document.getElementById('gs-vr-hud-toggle').click()); await sleep(500);
	l = await L();
	check('[light] Menu hidden in XR (Hide UI): light intensity 0 (no light-count change)', l.present && !l.menuVisible && l.intensity === 0, l);
	await p.evaluate(() => document.getElementById('gs-vr-hud-toggle').click()); await sleep(500);
	l = await L();
	check('[light] Menu shown again: light back on', l.present && l.menuVisible && l.intensity > 0.5, l);
	await p.screenshot({ path: `${SHOT_DIR}/06-dark-scene-menu-light.png` });
	await p.evaluate(() => renderer.xr.getSession().end()); await waitPresenting(p, false);
	l = await L();
	check('[light] Session end removes the menu light from the scene', !l.present && (await p.evaluate(() => !gsMenuLight.parent)), l);
	check('[light] No page errors / native dialogs', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

console.log(`\nxr-menu-mode: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
