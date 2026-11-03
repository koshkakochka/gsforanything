// Quick smoke check (not a full suite): mocked Quest 3 cameras on Chrome's fake
// camera. BASE=https://localhost:3531 SHOT_DIR=/workspace/gs-passtex-shots node smoke.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'https://localhost:3531';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-passtex-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + JSON.stringify(d) : ''}`); };
const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/150.0.0.39.30 SamsungBrowser/4.0 Chrome/150.0.7871.181 VR Safari/537.36';
const LABELS = ['camera 0, facing front', 'camera 1, facing back', 'camera 2, facing back'];

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', userDataDir: fs.mkdtempSync('/tmp/gs-ptx-'),
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('dialog', (d) => { errors.push('native dialog'); d.dismiss().catch(() => {}); });
await p.setUserAgent(QUEST_UA);
await p.setViewport({ width: 1400, height: 900 });
// Stub /api/* (never reach a real backend).
await p.setRequestInterception(true);
p.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) r.respond({ status: 200, contentType: 'application/json', body: u.pathname === '/api/backends' ? '{"backends":{}}' : '{}' }); else r.continue(); });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p.evaluateOnNewDocument((labels) => {
	const md = navigator.mediaDevices; const realGum = md.getUserMedia.bind(md); const realEnum = md.enumerateDevices.bind(md);
	window.__asked = [];
	md.enumerateDevices = async () => [...(await realEnum()).filter((d) => d.kind !== 'videoinput'), ...labels.map((label, i) => ({ kind: 'videoinput', deviceId: 'cam' + i, groupId: 'g' + i, label, toJSON() { return this; } }))];
	md.getUserMedia = async (c) => { const id = c && c.video && c.video.deviceId ? (c.video.deviceId.exact || c.video.deviceId) : (c && c.video && c.video.facingMode ? 'cam1' : 'cam0'); window.__asked.push(id); const s = await realGum({ video: { width: 1280, height: 960 } }); const t = s.getVideoTracks()[0]; const gs = t.getSettings.bind(t); t.getSettings = () => ({ ...gs(), deviceId: id }); Object.defineProperty(t, 'label', { value: labels[Number(id.replace('cam', ''))] }); return s; };
}, LABELS);
await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(1500);

// Non-black share of a canvas (fake camera = colour pattern).
const lit = (sel) => p.evaluate((sel) => { const c = typeof sel === 'string' ? document.querySelector(sel) : null; if (!c || !c.width) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, k = 0; for (let i = 0; i < d.length; i += 4 * 97) { k++; if (d[i] + d[i + 1] + d[i + 2] > 30) n++; } return n / k; }, sel);

// 1. 2D preview
await p.click('#desktop-camera-button');
await p.evaluate(() => gsPhotoCapture.ready); await sleep(1500);
const st = await p.evaluate(() => ({ cam: gsPhotoCapture.state(), pipe: gsCamPipeline.debugState(), canvasFrame: gsPhotoCapture.view._gsFrame || 0 }));
check('[2D] hidden <video> is in the DOM, not display:none, muted + playsInline', st.pipe.video && st.pipe.video.inDom && st.pipe.video.display !== 'none' && st.pipe.video.muted && st.pipe.video.playsInline, st.pipe.video);
check('[2D] hidden video is playing with frames', st.pipe.video && !st.pipe.video.paused && st.pipe.video.readyState >= 2 && st.pipe.video.w > 0, st.pipe.video);
check('[2D] Quest passthrough camera opened (left)', /facing back/.test(st.cam.label) && st.cam.deviceId === 'cam1', st.cam);
check('[2D] preview canvas is drawn from the video', st.canvasFrame > 5, st.canvasFrame);
const l2 = await lit('#gs-camera-panel .gs-cam-canvas');
check('[2D] preview canvas has non-black pixels', l2 > 0.2, l2);
check('[2D] status line reads camera / size / playing', /^camera: Quest passthrough \(left\) 1280×960 · playing/.test(st.cam.status), st.cam.status);
const diag = await p.evaluate(() => gsPhotoCapture.diagnostics());
check('[2D] diagnostics (🛠 Technical): Quest Browser version, permission state, camera list, env request result', /Browser: Quest Browser \d+/.test(diag) && /permissions\.query\(camera\): \w+/.test(diag) && /camera 1, facing back/.test(diag) && /exact: 'environment'/.test(diag), diag);
await p.screenshot({ path: `${SHOT_DIR}/01-2d-preview-status-details.png` });

// 2. gsPassthroughTexture shares the stream / video
const tx = await p.evaluate(async () => { const t = gsPassthroughTexture(); const t2 = gsPassthroughTexture(); const ok = await t.userData.ready; return { ok, same: t === t2, video: t.image === document.getElementById('gs-hidden-camera-video'), srgb: t.colorSpace === THREE.SRGBColorSpace, isVideo: !!t.isVideoTexture, noExport: !!t.userData.gsNoExport, asked: __asked.length }; });
check('[tex] gsPassthroughTexture(): sRGB VideoTexture of the shared hidden video, tagged gsNoExport, no new getUserMedia', tx.ok && tx.same && tx.video && tx.srgb && tx.isVideo && tx.noExport, tx);
const askedBefore = tx.asked;
await p.evaluate(() => { const t = gsPassthroughTexture(); const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2), new THREE.MeshBasicMaterial({ map: t, toneMapped: false })); m.name = 'cameraScreen'; m.position.set(0, 1.5, -2); scene.add(m); });
check('[tex] no extra camera request while the chat preview is live', (await p.evaluate(() => __asked.length)) === askedBefore);

// 3. VR panel preview
await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); window.gsXrMode.set('vr'); });
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
await sleep(2500);
const v0 = await p.evaluate(() => { const l = __gsVrWindows.byName('menu')._live; return { xr: renderer.xr.isPresenting, has: !!l, isCanvas: !!l && l.el === gsPhotoCapture.view, visible: !!l && l.mesh.visible, ver: l ? l.texture.version : 0, frame: gsPhotoCapture.view._gsFrame, open: gsPhotoCapture.isOpen }; });
await sleep(1500);
const v1 = await p.evaluate(() => { const l = __gsVrWindows.byName('menu')._live; return { ver: l ? l.texture.version : 0, frame: gsPhotoCapture.view._gsFrame, status: gsPhotoCapture.state().status, texVer: gsPassthroughTexture().version }; });
check('[VR] in an IWER Quest 3 VR session, camera still open', v0.xr && v0.open, v0);
check('[VR] menu window shows the preview canvas as its live quad', v0.has && v0.isCanvas && v0.visible, v0);
check('[VR] preview canvas keeps being drawn inside XR (render-loop tick)', v1.frame > v0.frame + 10, { v0: v0.frame, v1: v1.frame });
check('[VR] panel texture re-uploads every frame inside XR', v1.ver > v0.ver + 10, { v0: v0.ver, v1: v1.ver });
const lv = await lit('#gs-camera-panel .gs-cam-canvas');
check('[VR] panel preview canvas has non-black pixels', lv > 0.2, lv);
check('[VR] gsPassthroughTexture keeps updating inside XR', v1.texVer > 10, v1.texVer);
check('[VR] status says playing in XR', /playing · in XR/.test(v1.status), v1.status);
await p.screenshot({ path: `${SHOT_DIR}/02-vr-session-page.png` });
// The VR menu window's own painted canvas (DOM → canvas) with the live quad source drawn in.
await p.evaluate(() => { const w = __gsVrWindows.byName('menu'); w.tick(true); });
const winPng = await p.evaluate(() => { const w = __gsVrWindows.byName('menu'); const src = w.mesh.material.map.image; const l = w._live; const c = document.createElement('canvas'); c.width = src.width; c.height = src.height; const g = c.getContext('2d'); g.drawImage(src, 0, 0); if (l && l.mesh.visible) { const sx = l.mesh.scale.x, sy = l.mesh.scale.y; const cx = (l.mesh.position.x + 0.5) * c.width, cy = (0.5 - l.mesh.position.y) * c.height; g.drawImage(l.el, cx - Math.abs(sx) * c.width / 2, cy - sy * c.height / 2, Math.abs(sx) * c.width, sy * c.height); } return c.toDataURL('image/png'); });
const quadInfo = await p.evaluate(() => { const l = __gsVrWindows.byName('menu')._live; const w = __gsVrWindows.byName('menu'); return { visible: l.mesh.visible, aspectM: Math.abs(l.mesh.scale.x * w.widthM) / (l.mesh.scale.y * w.heightM) }; });
check('[VR] live quad keeps the camera aspect (4:3)', quadInfo.visible && Math.abs(quadInfo.aspectM - 4 / 3) < 0.05, quadInfo);
fs.writeFileSync(`${SHOT_DIR}/03-vr-menu-window-with-camera.png`, Buffer.from(winPng.split(',')[1], 'base64'));

// 4. scene clear releases the scene's hold; closing the panel stops the camera
await p.evaluate(() => gsCamPipeline.resetScene());
const afterReset = await p.evaluate(() => gsCamPipeline.debugState());
check('[cleanup] scene clear drops the scene owner, chat preview keeps the camera', !afterReset.owners.includes('scene') && afterReset.tracksLive === 1, afterReset);
await p.evaluate(() => gsPhotoCapture.close()); await sleep(300);
const afterClose = await p.evaluate(() => gsCamPipeline.debugState());
check('[cleanup] closing the preview stops every track', afterClose.tracksLive === 0 && afterClose.owners.length === 0, afterClose);
check('[page] no page errors / native dialogs', errors.length === 0, errors.slice(0, 3));

// 5. Real-Quest failure case: only the avatar camera listed, the passthrough
// request rejected (Headset cameras not allowed): hint + details shown with the error.
{
	const q = await b.newPage();
	q.on('pageerror', (e) => errors.push(e.message));
	await q.setUserAgent(QUEST_UA);
	await q.setViewport({ width: 1400, height: 900 });
	await q.setRequestInterception(true);
	q.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) r.respond({ status: 200, contentType: 'application/json', body: u.pathname === '/api/backends' ? '{"backends":{}}' : '{}' }); else r.continue(); });
	await q.evaluateOnNewDocument(() => {
		const md = navigator.mediaDevices; const realGum = md.getUserMedia.bind(md); const realEnum = md.enumerateDevices.bind(md);
		md.enumerateDevices = async () => [...(await realEnum()).filter((d) => d.kind !== 'videoinput'), { kind: 'videoinput', deviceId: 'cam0', groupId: 'g0', label: 'camera 0, facing front', toJSON() { return this; } }];
		md.getUserMedia = async (c) => { const fm = c && c.video && c.video.facingMode; if (fm && fm.exact === 'environment') throw new DOMException('Cannot satisfy constraints', 'OverconstrainedError'); const s = await realGum({ video: true }); const t = s.getVideoTracks()[0]; Object.defineProperty(t, 'label', { value: 'camera 0, facing front' }); const gs = t.getSettings.bind(t); t.getSettings = () => ({ ...gs(), deviceId: 'cam0' }); return s; };
	});
	await q.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
	await sleep(1200);
	await q.click('#desktop-camera-button');
	await q.evaluate(() => gsPhotoCapture.ready); await sleep(1500);
	const r = await q.evaluate(async () => ({ s: gsPhotoCapture.state(), diag: await gsPhotoCapture.diagnostics() }));
	check('[avatar only] short hint points to Technical mode (no ADB talk off)', /turn on Technical mode/.test(r.s.hint), r.s.hint);
	check('[avatar only] diagnostics carry the exact passthrough request error', /OverconstrainedError: Cannot satisfy constraints/.test(r.diag) && /Cameras listed \(1\)/.test(r.diag), r.diag);
	await q.screenshot({ path: `${SHOT_DIR}/04-avatar-only-hint.png` });
	await q.close();
}
await b.close();
console.log(`\npassthrough-texture smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
