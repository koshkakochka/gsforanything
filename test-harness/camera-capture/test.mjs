// 📷 Camera capture + AR / VR toggle.
//   - Desktop: the 📷 button sits next to 📎, the live preview opens between the
//     message bubbles and the button row, Take photo attaches a JPEG exactly like
//     an upload (and it is sent with the next message), ✕ stops every track.
//   - Camera selection: several cameras (mocked enumerateDevices), switching
//     re-opens with deviceId exact and is remembered; Quest passthrough labels
//     are preferred on a Quest user agent.
//   - Errors: permission denied / no camera show an in-app message (no alert()).
//   - Phone layout: 📷 lives behind More (+), preview above the input.
//   - AR / VR toggle with a mocked navigator.xr: support detection, disabled
//     option, persistence, ENTER AR / ENTER VR label, requestSession mode.
//   - VR (IWER Meta Quest 3): ray-click 📷 in the VR menu, the live preview quad
//     shows on the menu window, ray-click Take photo attaches.
// /api/* is ALWAYS stubbed (CDP Fetch): no live AI calls, no KV writes.
//   BASE=https://localhost:3521 node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3521';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-camera-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };
const shot = (p, name) => p.screenshot({ path: `${SHOT_DIR}/${name}.png` });

const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/40.0.0.0 SamsungBrowser/4.0 Chrome/132.0.0.0 VR Safari/537.36';

async function open({ grant = true, iwer = false, viewport = { width: 1400, height: 900 }, mobile = false, ua = null, before = null } = {}) {
	const args = ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
	if (grant) args.push('--use-fake-ui-for-media-stream');
	const userDataDir = fs.mkdtempSync('/tmp/gs-cam-');
	const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args, userDataDir });
	const p = await b.newPage();
	const errors = [], chats = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
	p.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.dismiss().catch(() => {}); });
	if (ua) await p.setUserAgent(ua);
	await p.setViewport(mobile ? { ...viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : viewport);
	if (iwer) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	await p.evaluateOnNewDocument(() => {
		const T = (window.__camT = { gum: [], streams: [] });
		const md = navigator.mediaDevices; const o = md.getUserMedia.bind(md);
		md.getUserMedia = async (c) => { T.gum.push(JSON.parse(JSON.stringify(c || {}))); const s = await o(c); T.streams.push(s); return s; };
		T.liveVideo = () => T.streams.flatMap((s) => s.getVideoTracks()).filter((t) => t.readyState === 'live').length;
	});
	if (before) await before(p);
	const cdp = await p.createCDPSession();
	await cdp.send('Network.enable');
	await cdp.send('Fetch.enable', { patterns: [{ urlPattern: new URL(BASE).origin + '/api/*', requestStage: 'Request' }] });
	const json = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
	cdp.on('Fetch.requestPaused', async (ev) => {
		const u = new URL(ev.request.url);
		const reply = (o) => cdp.send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: json(o) }).catch(() => {});
		if (u.pathname === '/api/backends') return reply({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' });
		if (u.pathname === '/api/chat' || u.pathname === '/api/theme-chat') {
			let raw = ev.request.postData;
			if (!raw && ev.request.hasPostData && ev.networkId) { try { raw = (await cdp.send('Network.getRequestPostData', { requestId: ev.networkId })).postData; } catch { /* ignore */ } }
			chats.push(raw || '');
			return reply({ content: [{ type: 'text', text: 'Mock reply.' }] });
		}
		// Every other /api call gets an empty OK (never the real server / KV).
		return reply({ ok: true, scenes: [], items: [] });
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
	await sleep(1500);
	const cam = () => p.evaluate(() => ({ ...window.gsPhotoCapture.state(), hidden: document.getElementById('gs-camera-panel').hidden, pressed: document.getElementById('desktop-camera-button').getAttribute('aria-pressed'), chips: document.getElementById('desktop-attachments').textContent, liveVideo: __camT.liveVideo(), gum: __camT.gum.length }));
	const until = async (pred, ms = 10000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await cam(); if (pred(s)) return s; await sleep(150); } return s; };
	return { b, p, errors, chats, cam, until };
}
const rect = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }; }, sel);

// Mocked camera list (all map onto Chrome's fake device, the constraints are recorded).
const mockCameras = (labels) => (p) => p.evaluateOnNewDocument((labels) => {
	const md = navigator.mediaDevices;
	const realGum = md.getUserMedia.bind(md); const realEnum = md.enumerateDevices.bind(md);
	window.__camAsked = [];
	md.enumerateDevices = async () => { const real = await realEnum(); return [...real.filter((d) => d.kind !== 'videoinput'), ...labels.map((label, i) => ({ kind: 'videoinput', deviceId: 'cam' + i, groupId: 'g' + i, label, toJSON() { return this; } }))]; };
	md.getUserMedia = async (c) => { window.__camAsked.push(c && c.video && c.video.deviceId ? (c.video.deviceId.exact || c.video.deviceId) : 'default'); const s = await realGum({ video: true }); const t = s.getVideoTracks()[0]; const id = c && c.video && c.video.deviceId ? (c.video.deviceId.exact || c.video.deviceId) : 'cam0'; const gs = t.getSettings.bind(t); t.getSettings = () => ({ ...gs(), deviceId: id }); Object.defineProperty(t, 'label', { value: labels[Number(String(id).replace('cam', ''))] || labels[0] }); return s; };
}, labels);

// Mocked navigator.xr (support per mode; requestSession is recorded and rejected).
const mockXr = (support) => (p) => p.evaluateOnNewDocument((support) => {
	window.__xrRequests = [];
	const xr = new EventTarget();
	xr.isSessionSupported = async (m) => !!support[m];
	xr.requestSession = async (m, init) => { window.__xrRequests.push({ mode: m, init }); throw new DOMException('mock: no headset', 'NotSupportedError'); };
	Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });
}, support);

// ───────────── 1. Desktop: button, placement, capture → attachment → sent, close ─────────────
{
	const { b, p, errors, chats, cam, until } = await open();
	const ids = await p.evaluate(() => { const a = document.getElementById('desktop-attach-button'), c = document.getElementById('desktop-camera-button'); return { same: a && c && a.parentElement === c.parentElement, next: a && a.nextElementSibling === c, label: c && c.getAttribute('aria-label') }; });
	check('[desktop] 📷 button exists right after the 📎 upload button', ids.same && ids.next, ids);
	const r0 = await rect(p, '#desktop-camera-button');
	check('[desktop] 📷 button is visible', r0 && r0.visible, r0);
	check('[desktop] Camera panel starts hidden, no camera opened', (await cam()).hidden && (await cam()).gum === 0);
	await p.click('#desktop-camera-button');
	const s1 = await until((s) => s.live);
	check('[desktop] Clicking 📷 opens a live preview', s1.live && !s1.hidden && s1.pressed === 'true', s1);
	check('[desktop] Preview video is playing at camera resolution', s1.size && s1.size[0] > 0, s1.size);
	const msgs = await rect(p, '#desktop-chat-messages'), panel = await rect(p, '#gs-camera-panel'), tools = await rect(p, '#desktop-chat-tools-row'), input = await rect(p, '#desktop-chat-input-row');
	check('[desktop] Preview sits below the message bubbles', panel.top >= msgs.bottom - 1, { panel, msgs });
	check('[desktop] Preview sits above the button row and input', panel.bottom <= input.top + 1 && tools.top >= panel.bottom - 1, { panel, tools, input });
	const chatR = await rect(p, '#desktop-chat');
	check('[desktop] Buttons and input stay inside the chat window', input.bottom <= chatR.bottom + 1, { input, chatR });
	const video = await rect(p, '#gs-camera-panel .gs-cam-video');
	check('[desktop] Preview video has a real size', video.h > 60 && video.w > 100, video);
	const sel = await p.evaluate(() => [...document.querySelectorAll('#gs-camera-panel .gs-cam-select option')].map((o) => o.textContent));
	check('[desktop] Camera selector lists the device', sel.length >= 1 && sel.some((t) => /fake|camera/i.test(t)), sel);
	await shot(p, '01-desktop-preview');
	await p.click('#gs-camera-panel .gs-cam-shutter');
	const s2 = await until((s) => s.photos === 1);
	check('[desktop] Take photo counts the photo', s2.photos === 1, s2);
	check('[desktop] Photo is attached as an upload chip (camera-*.jpg)', /camera-\d{8}-\d{6}\.jpg/.test(s2.chips), s2.chips);
	check('[desktop] Preview stays open for another shot', s2.live && /attached/i.test(s2.message), s2.message);
	await shot(p, '02-desktop-captured');
	await p.type('#desktop-chat-input', 'What is in this photo?');
	await p.click('#desktop-send-button');
	for (let i = 0; i < 40 && !chats.length; i++) await sleep(200);
	const body = chats[0] || '';
	let img = null; try { const j = JSON.parse(body); const u = (j.messages || []).filter((m) => m.role === 'user').pop(); img = (Array.isArray(u.content) ? u.content : []).find((c) => c.type === 'image'); } catch { /* */ }
	check('[desktop] Sending includes the photo as an image/jpeg (stubbed /api/chat)', img && img.source && img.source.media_type === 'image/jpeg' && img.source.data.length > 1000, body.slice(0, 200));
	check('[desktop] Attachment chips clear after sending', (await cam()).chips.trim() === '', (await cam()).chips);
	await p.click('#gs-camera-panel .gs-cam-close');
	const s3 = await until((s) => !s.open);
	check('[desktop] ✕ closes the panel', s3.hidden && s3.pressed === 'false', s3);
	check('[desktop] ✕ stops every camera track', s3.liveVideo === 0, s3.liveVideo);
	await p.click('#desktop-camera-button'); await until((s) => s.live);
	await p.click('#desktop-camera-button');
	const s4 = await until((s) => !s.open);
	check('[desktop] 📷 again toggles it off and stops the tracks', s4.hidden && s4.liveVideo === 0, s4);
	check('[desktop] No page errors / native dialogs', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 2. Several cameras: selection + remembered choice ─────────────
{
	const { b, p, errors, cam, until } = await open({ before: mockCameras(['Front Camera', 'Back Camera', 'USB Webcam']) });
	await p.click('#desktop-camera-button');
	await until((s) => s.live && s.devices.length === 3);
	const opts = await p.evaluate(() => [...document.querySelectorAll('#gs-camera-panel .gs-cam-select option')].map((o) => ({ v: o.value, t: o.textContent })));
	check('[select] All three cameras are offered', opts.length === 3 && opts.map((o) => o.t).join('|').includes('USB Webcam'), opts);
	await p.select('#gs-camera-panel .gs-cam-select', 'cam2');
	const s = await until((s) => s.live && s.deviceId === 'cam2');
	const asked = await p.evaluate(() => window.__camAsked);
	check('[select] Choosing a camera re-opens with that deviceId', asked[asked.length - 1] === 'cam2' && s.deviceId === 'cam2', { asked, s: s.deviceId });
	check('[select] Old stream is stopped when switching', (await p.evaluate(() => __camT.liveVideo())) <= 1);
	check('[select] Choice is remembered', (await p.evaluate(() => localStorage.getItem('gs.cameraDevice'))) === 'cam2');
	await shot(p, '03-camera-select');
	await p.click('#gs-camera-panel .gs-cam-close'); await until((s) => !s.open);
	await p.click('#desktop-camera-button'); await until((s) => s.live);
	const asked2 = await p.evaluate(() => window.__camAsked);
	check('[select] Re-opening uses the remembered camera', asked2[asked2.length - 1] === 'cam2', asked2);
	check('[select] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 3. Quest UA: passthrough camera preferred ─────────────
{
	const { b, p, errors, cam, until } = await open({ ua: QUEST_UA, before: mockCameras(['camera 1, facing front', 'camera 2 1, facing back', 'camera 2 2, facing back']) });
	await p.click('#desktop-camera-button');
	const s = await until((s) => s.live && s.devices.length === 3);
	check('[quest] Default camera is a passthrough (facing back) camera, not the avatar camera', s.deviceId === 'cam1' || s.deviceId === 'cam2', { id: s.deviceId, label: s.label });
	check('[quest] Passthrough cameras are flagged', s.devices.filter((d) => d.passthrough).length === 2, s.devices);
	const labels = await p.evaluate(() => [...document.querySelectorAll('#gs-camera-panel .gs-cam-select option')].map((o) => o.textContent));
	check('[quest] Friendly labels for the headset cameras', labels.some((t) => /passthrough|left|right/i.test(t)), labels);
	check('[quest] Passthrough preview is not mirrored', (await p.evaluate(() => document.querySelector('#gs-camera-panel .gs-cam-video').classList.contains('gs-cam-mirror'))) === false);
	check('[quest] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 4. Errors: denied, no camera, Quest denied hint ─────────────
for (const [name, err, ua, re] of [
	['denied', 'NotAllowedError', null, /blocked|allow|permission/i],
	['no camera', 'NotFoundError', null, /no camera|not find|found/i],
	['quest denied', 'NotAllowedError', QUEST_UA, /Headset cameras/]
]) {
	const { b, p, errors, until } = await open({ ua, before: (p) => p.evaluateOnNewDocument((err) => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('mock', err); }; }, err) });
	await p.click('#desktop-camera-button');
	const s = await until((s) => !!s.error);
	check(`[error:${name}] In-app message in the camera panel`, !s.hidden && re.test(s.message), s.message);
	check(`[error:${name}] Shutter disabled while there is no stream`, await p.evaluate(() => document.querySelector('#gs-camera-panel .gs-cam-shutter').disabled));
	check(`[error:${name}] No native alert/confirm, no page errors`, errors.length === 0, errors.slice(0, 3));
	if (name === 'denied') await shot(p, '04-denied');
	if (name === 'quest denied') await shot(p, '05-quest-denied');
	await b.close();
}

// ───────────── 5. Phone layout ─────────────
{
	const { b, p, errors, cam, until } = await open({ mobile: true, viewport: { width: 390, height: 844 } });
	const isPhone = await p.evaluate(() => document.documentElement.classList.contains('gs-phone'));
	check('[phone] Phone layout active', isPhone);
	const moreBtn = await p.$('#desktop-chat-more');
	if (moreBtn) { await moreBtn.click(); await sleep(400); }
	const r = await rect(p, '#desktop-camera-button');
	check('[phone] 📷 reachable (via More) with a ≥44px target', r && r.visible && r.w >= 43 && r.h >= 43, r);
	await p.tap('#desktop-camera-button');
	const s = await until((s) => s.live);
	check('[phone] Preview opens', s.live, s);
	const back = await p.evaluate(() => __camT.gum[__camT.gum.length - 1]);
	check('[phone] Asks for the back (environment) camera by default', JSON.stringify(back).includes('environment'), back);
	const panel = await rect(p, '#gs-camera-panel'), input = await rect(p, '#desktop-chat-input-row'), msgs = await rect(p, '#desktop-chat-messages');
	check('[phone] Preview between messages and input', panel.top >= msgs.bottom - 1 && panel.bottom <= input.top + 1, { panel, msgs, input });
	check('[phone] Input stays on screen', input.bottom <= 844 + 1, input);
	await shot(p, '06-phone-preview');
	await p.tap('#gs-camera-panel .gs-cam-shutter');
	const s2 = await until((s) => s.photos === 1);
	check('[phone] Take photo attaches', /camera-.*\.jpg/.test(s2.chips), s2.chips);
	check('[phone] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 6. AR / VR toggle (mocked navigator.xr) ─────────────
const xrState = (p) => p.evaluate(() => {
	const t = document.getElementById('gs-xr-mode'); const btn = document.getElementById('XRButton');
	const bs = Object.fromEntries([...t.querySelectorAll('button')].map((b) => [b.dataset.xrMode, { disabled: b.disabled, checked: b.getAttribute('aria-checked') }]));
	const env = Object.fromEntries([...document.querySelectorAll('#dchat-env-mode [data-id]')].map((g) => [g.dataset.id, { disabled: g.getAttribute('aria-disabled') === 'true', label: g.textContent }]));
	return { hidden: t.hidden, bs, label: btn && btn.textContent, state: btn && btn.dataset.xrState, mode: window.gsXrMode.effective, pref: window.gsXrMode.preferred, env };
});
{
	const { b, p, errors } = await open({ before: mockXr({ 'immersive-vr': true, 'immersive-ar': true }) });
	let s = await xrState(p);
	check('[xr both] Toggle visible with AR and VR enabled', !s.hidden && !s.bs.ar.disabled && !s.bs.vr.disabled, s);
	check('[xr both] Defaults to VR: ENTER VR', s.bs.vr.checked === 'true' && /ENTER VR/.test(s.label), s);
	const inDock = await p.evaluate(() => { const t = document.getElementById('gs-xr-mode'); return t.nextElementSibling && t.nextElementSibling.id === 'XRButton'; });
	check('[xr both] Toggle sits right before the Enter button', inDock);
	await shot(p, '07-xr-toggle-vr');
	await p.click('#gs-xr-mode [data-xr-mode="ar"]'); await sleep(300);
	s = await xrState(p);
	check('[xr both] Choosing AR: ENTER AR, AR checked', s.bs.ar.checked === 'true' && s.bs.vr.checked === 'false' && /ENTER AR/.test(s.label) && s.state === 'enter', s);
	check('[xr both] Menu Env tab mirrors it (AR active)', s.env.ar && !s.env.ar.disabled, s.env);
	check('[xr both] Choice persisted', (await p.evaluate(() => localStorage.getItem('gs.xrMode'))) === 'ar');
	await shot(p, '08-xr-toggle-ar');
	await p.click('#XRButton'); await sleep(500);
	const req = await p.evaluate(() => window.__xrRequests.map((r) => ({ mode: r.mode, req: r.init.requiredFeatures || [], opt: r.init.optionalFeatures || [] })));
	check('[xr both] ENTER AR requests immersive-ar (no hard feature requirements)', req.length === 1 && req[0].mode === 'immersive-ar' && req[0].req.length === 0, req);
	await p.reload({ waitUntil: 'networkidle2' }); await sleep(1200);
	s = await xrState(p);
	check('[xr both] AR choice survives a reload', s.pref === 'ar' && /ENTER AR/.test(s.label), s);
	// Switch back via the menu's Env buttons.
	await p.evaluate(() => document.querySelector('#dchat-env-mode [data-id="vr"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
	await sleep(300);
	s = await xrState(p);
	check('[xr both] Env tab "VR" switches back: ENTER VR', s.pref === 'vr' && /ENTER VR/.test(s.label), s);
	await p.click('#XRButton'); await sleep(500);
	const req2 = await p.evaluate(() => window.__xrRequests.map((r) => r.mode));
	check('[xr both] ENTER VR requests immersive-vr', req2[req2.length - 1] === 'immersive-vr', req2);
	check('[xr both] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}
{
	const { b, p, errors } = await open({ before: async (p) => { await mockXr({ 'immersive-vr': true, 'immersive-ar': false })(p); await p.evaluateOnNewDocument(() => localStorage.setItem('gs.xrMode', 'ar')); } });
	const s = await xrState(p);
	check('[xr vr-only] AR option disabled', !s.hidden && s.bs.ar.disabled && !s.bs.vr.disabled, s);
	check('[xr vr-only] Saved AR falls back to ENTER VR', /ENTER VR/.test(s.label) && s.mode === 'vr', s);
	check('[xr vr-only] Env tab AR button disabled', s.env.ar && s.env.ar.disabled && /not supported/.test(s.env.ar.label), s.env);
	await p.evaluate(() => document.querySelector('#dchat-env-mode [data-id="ar"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
	await sleep(200);
	check('[xr vr-only] Clicking the disabled AR does nothing', (await xrState(p)).mode === 'vr');
	await shot(p, '09-xr-vr-only');
	check('[xr vr-only] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}
{
	const { b, p, errors } = await open({ before: mockXr({ 'immersive-vr': false, 'immersive-ar': true }) });
	const s = await xrState(p);
	check('[xr ar-only] VR disabled, AR chosen: ENTER AR', !s.hidden && s.bs.vr.disabled && s.bs.ar.checked === 'true' && /ENTER AR/.test(s.label), s);
	check('[xr ar-only] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}
{
	const { b, p, errors } = await open({ before: mockXr({}) });
	const s = await xrState(p);
	check('[xr none] Toggle hidden, VR NOT SUPPORTED', s.hidden && /NOT SUPPORTED/.test(s.label), s);
	check('[xr none] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ───────────── 7. VR on an IWER Meta Quest 3 ─────────────
async function enterVr(p) {
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
	await p.evaluate(() => window.gsXrMode.set('vr'));
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
	await sleep(1500);
	await p.evaluate(() => {
		const V = THREE.Vector3;
		window.__t = {
			win: (n) => window.__gsVrWindows.byName(n),
			pointFor(el, winName) { const w = this.win(winName); const sr = w.source.getBoundingClientRect(); const r = el.getBoundingClientRect(); const u = (r.left + r.width / 2 - sr.left) / sr.width, v = 1 - (r.top + r.height / 2 - sr.top) / sr.height; w.mesh.updateMatrixWorld(true); return w.mesh.localToWorld(new V(u - 0.5, v - 0.5, 0.0)); },
			aim(hand, target) { const c = [0, 1].map((i) => renderer.xr.getController(i)).find((x) => x.userData.handedness === hand); const xrCam = renderer.xr.getCamera(); const head = new V(); xrCam.getWorldPosition(head); const origin = head.clone().add(new V(hand === 'right' ? 0.15 : -0.15, -0.3, -0.1)); const parent = c.parent; parent.updateMatrixWorld(true); const inv = parent.matrixWorld.clone().invert(); const o = origin.clone().applyMatrix4(inv), t = target.clone().applyMatrix4(inv); const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(o, t, new V(0, 1, 0))); const dc = window.__xrDevice.controllers[hand]; dc.position.set(o.x, o.y, o.z); dc.quaternion.set(q.x, q.y, q.z, q.w); },
			aimAt(hand, el, winName) { this.aim(hand, this.pointFor(el, winName)); },
			trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); }
		};
	});
	return p.evaluate(() => renderer.xr.isPresenting);
}
const rayClick = async (p, sel, win = 'menu') => {
	await p.evaluate((s, w) => __t.aimAt('right', document.querySelector(s), w), sel, win);
	await sleep(400);
	await p.evaluate(() => __t.trigger('right', 1)); await sleep(300); await p.evaluate(() => __t.trigger('right', 0)); await sleep(500);
};
{
	const { b, p, errors, until } = await open({ iwer: true, before: mockCameras(['camera 1, facing front', 'camera 2 1, facing back', 'camera 2 2, facing back']) });
	const sup = await p.evaluate(() => window.gsXrMode.support);
	check('[vr] IWER Quest 3 reports VR support (toggle visible)', sup.vr === true && !(await p.evaluate(() => document.getElementById('gs-xr-mode').hidden)), sup);
	check('[vr] Entered immersive VR (IWER Quest 3)', await enterVr(p));
	await rayClick(p, '#desktop-camera-button');
	const s = await until((s) => s.live, 8000);
	check('[vr] Ray-clicking 📷 in the VR menu opens the camera', s.live, s);
	check('[vr] In VR it picks a passthrough camera', s.devices.find((d) => d.id === s.deviceId)?.passthrough === true, { id: s.deviceId, devices: s.devices });
	await sleep(800);
	const quad = await p.evaluate(() => { const w = __t.win('menu'); const l = w._live; if (!l) return null; const v = document.querySelector('#gs-camera-panel .gs-cam-video'); return { visible: l.mesh.visible, el: l.el === v, sx: l.mesh.scale.x, sy: l.mesh.scale.y, px: l.mesh.position.x, py: l.mesh.position.y, parentIsMenu: l.mesh.parent === w.mesh, menuVisible: w.mesh.visible }; });
	check('[vr] Live preview quad is on the VR menu window', quad && quad.visible && quad.el && quad.parentIsMenu && quad.menuVisible && Math.abs(quad.sx) > 0.05 && quad.sy > 0.02, quad);
	const order = await p.evaluate(() => { const m = document.getElementById('desktop-chat-messages').getBoundingClientRect(), c = document.getElementById('gs-camera-panel').getBoundingClientRect(), t = document.getElementById('desktop-chat-tools-row').getBoundingClientRect(); return c.top >= m.bottom - 1 && c.bottom <= t.top + 1; });
	check('[vr] Preview sits between the bubbles and the buttons in the VR menu', order);
	await shot(p, '10-vr-preview');
	await rayClick(p, '#gs-camera-panel .gs-cam-shutter');
	const s2 = await until((s) => s.photos === 1, 5000);
	check('[vr] Ray-clicking Take photo attaches the photo', s2.photos === 1 && /camera-.*\.jpg/.test(s2.chips), s2);
	await shot(p, '11-vr-captured');
	await rayClick(p, '#gs-camera-panel .gs-cam-close');
	const s3 = await until((s) => !s.open, 5000);
	check('[vr] Ray-clicking ✕ closes and removes the quad', !s3.open && (await p.evaluate(() => !__t.win('menu')._live || !__t.win('menu')._live.mesh.visible)), s3);
	check('[vr] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}
// AR session on the IWER Quest 3: passthrough (transparent, no sky), live switch to VR colour.
{
	const { b, p, errors } = await open({ iwer: true });
	const sup = await p.evaluate(() => window.gsXrMode.support);
	if (!sup.ar) { console.log('SKIP [ar] IWER build does not report immersive-ar', JSON.stringify(sup)); }
	else {
		await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); window.gsXrMode.set('ar'); });
		check('[ar] Button reads ENTER AR', /ENTER AR/.test(await p.evaluate(() => document.getElementById('XRButton').textContent)));
		await p.click('#XRButton');
		for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
		await sleep(1500);
		const st = () => p.evaluate(() => ({ session: gsXrMode.session, passthrough: gsXrMode.passthrough, alpha: renderer.getClearAlpha(), bg: !!(window.scene && window.scene.background), ar: document.body.classList.contains('gs-xr-ar'), label: document.getElementById('XRButton').textContent }));
		let s = await st();
		check('[ar] immersive-ar session with passthrough: clear alpha 0, no background', s.session === 'immersive-ar' && s.passthrough && s.alpha === 0 && !s.bg && s.ar, s);
		await shot(p, '12-ar-session');
		await p.evaluate(() => document.querySelector('#dchat-env-mode [data-id="vr"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
		await sleep(800);
		s = await st();
		check('[ar] Env "VR (color)" inside an AR session shows the colour environment (sky dome back)', !s.passthrough, s);
		await p.evaluate(() => document.querySelector('#dchat-env-mode [data-id="ar"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
		await sleep(800);
		s = await st();
		check('[ar] …and "AR (passthrough)" switches back live', s.passthrough && s.alpha === 0, s);
		await p.evaluate(() => renderer.xr.getSession().end()); await sleep(1200);
		s = await st();
		check('[ar] Ending the session restores the desktop view', !s.session && !s.ar && !s.passthrough, s);
	}
	check('[ar] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}
// Enter VR after using the camera before + permission "prompt": ask first (like the mic).
{
	const { b, p, errors } = await open({ iwer: true, before: (p) => p.evaluateOnNewDocument(() => {
		localStorage.setItem('gs.cameraUsed', '1');
		const q = navigator.permissions.query.bind(navigator.permissions);
		navigator.permissions.query = async (d) => (d && d.name === 'camera' ? { state: 'prompt', onchange: null, addEventListener() {}, removeEventListener() {} } : q(d));
	}) });
	await enterVr(p); await sleep(800);
	const gum = await p.evaluate(() => ({ n: __camT.gum.length, live: __camT.liveVideo() }));
	check('[vr hook] Used the camera before + "prompt": asked once on Enter VR, probe released', gum.n === 1 && gum.live === 0, gum);
	check('[vr hook] No page errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}
{
	const { b, p } = await open({ iwer: true });
	await enterVr(p); await sleep(500);
	check('[vr hook] Never used the camera: Enter VR does not ask for it', (await p.evaluate(() => __camT.gum.length)) === 0);
	await b.close();
}

console.log(`\ncamera-capture: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
