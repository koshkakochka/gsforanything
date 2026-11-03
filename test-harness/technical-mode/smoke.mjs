// Quick smoke check (not a full suite) for Technical mode on a mocked Quest 3
// that only lists the avatar camera ({exact:'environment'} → OverconstrainedError,
// the Quest Browser 150 bug). /api/* stubbed.
// BASE=https://localhost:3531 SHOT_DIR=/workspace/gs-techmode-shots node smoke.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'https://localhost:3531';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-techmode-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + JSON.stringify(d) : ''}`); };
const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/150.0.0.39.30 SamsungBrowser/4.0 Chrome/150.0.7871.181 VR Safari/537.36';
const CMD = 'adb shell pm grant com.oculus.browser horizonos.permission.HEADSET_CAMERA';

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', userDataDir: fs.mkdtempSync('/tmp/gs-tech-'),
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
await b.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('dialog', (d) => { errors.push('native dialog'); d.dismiss().catch(() => {}); });
await p.setUserAgent(QUEST_UA);
await p.setViewport({ width: 1400, height: 900 });
await p.setRequestInterception(true);
p.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) r.respond({ status: 200, contentType: 'application/json', body: u.pathname === '/api/backends' ? '{"backends":{}}' : '{}' }); else r.continue(); });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p.evaluateOnNewDocument(() => {
	const md = navigator.mediaDevices; const realGum = md.getUserMedia.bind(md); const realEnum = md.enumerateDevices.bind(md);
	window.__envAsks = 0;
	md.enumerateDevices = async () => [...(await realEnum()).filter((d) => d.kind !== 'videoinput'), { kind: 'videoinput', deviceId: 'cam0', groupId: 'g0', label: 'camera 0, facing front', toJSON() { return this; } }];
	md.getUserMedia = async (c) => { const fm = c && c.video && c.video.facingMode; if (fm && fm.exact === 'environment') { window.__envAsks++; throw new DOMException('Cannot satisfy constraints', 'OverconstrainedError'); } const s = await realGum({ video: { width: 1280, height: 960 } }); const t = s.getVideoTracks()[0]; Object.defineProperty(t, 'label', { value: 'camera 0, facing front' }); const gs = t.getSettings.bind(t); t.getSettings = () => ({ ...gs(), deviceId: 'cam0' }); return s; };
});
const load = async () => { await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 }); await sleep(1200); };
const ui = () => p.evaluate(() => ({
	on: gsTechnicalMode.isTechnicalMode(), stored: localStorage.getItem('gs.technicalMode'),
	tabShown: !document.getElementById('dchat-tab-technical').hidden && getComputedStyle(document.getElementById('dchat-tab-technical')).display !== 'none',
	toggle: document.getElementById('dchat-technical-toggle').textContent
}));
await load();

// 1. Off by default; camera works with the avatar camera; short hint, no ADB.
let u = await ui();
check('[off] Technical mode off by default, tab hidden, toggle reads Off', !u.on && !u.stored && !u.tabShown && /Off/.test(u.toggle), u);
await p.click('#desktop-camera-button');
await p.evaluate(() => gsPhotoCapture.ready); await sleep(1500);
let cam = await p.evaluate(() => { const pn = document.getElementById('gs-camera-panel'); return { s: gsPhotoCapture.state(), text: pn.innerText, help: pn.querySelector('.gs-cam-hint-help').hidden, retry: pn.querySelector('.gs-cam-hint-retry').hidden, hintShown: !pn.querySelector('.gs-cam-hint').hidden }; });
check('[off] camera still opens the avatar camera and plays', /Avatar camera/.test(cam.s.status) && /playing/.test(cam.s.status), cam.s.status);
check('[off] hint: "Passthrough camera needs extra setup: turn on Technical mode in Settings"', cam.hintShown && /^Passthrough camera needs extra setup: turn on Technical mode in Settings/.test(cam.s.hint), cam.s.hint);
check('[off] camera panel has no ADB / Details talk and no extra buttons', !/adb|Details/i.test(cam.text) && cam.help && cam.retry, cam.text);
const tx = await p.evaluate(async () => { const t = gsPassthroughTexture(); return { ok: await t.userData.ready, status: t.userData.status && t.userData.status() }; });
check('[off] gsPassthroughTexture() falls back to the available camera', tx.ok === true, tx);
await p.screenshot({ path: `${SHOT_DIR}/01-off-mode-camera-hint.png` });

// 2. Turn on from Controls (gsDialog confirm with the note), persists over reload.
await p.click('.dchat-tab[data-tab="controls"]'); await sleep(200);
await p.evaluate(() => document.getElementById('dchat-technical-toggle').scrollIntoView({ block: 'center' }));
await p.click('#dchat-technical-toggle'); await sleep(400);
const dlg = await p.evaluate(() => { const m = document.getElementById('gs-dialog-message'); return m && m.offsetParent !== null ? { title: document.getElementById('gs-dialog-title').textContent, msg: m.textContent } : null; });
check('[on] gsDialog confirm with the one-line advanced-setup note', dlg && /advanced setup, such as permissions outside normal browser operation and developer tools/.test(dlg.msg), dlg);
await p.screenshot({ path: `${SHOT_DIR}/02-controls-confirm-dialog.png` });
await p.click('[data-gs-dialog="ok"]'); await sleep(400);
u = await ui();
check('[on] toggle On, saved, 🛠 Technical tab shown', u.on && u.stored === '1' && u.tabShown && /On/.test(u.toggle), u);
await p.screenshot({ path: `${SHOT_DIR}/03-controls-toggle-on.png` });
await load();
u = await ui();
check('[on] still on after reload (saved per browser)', u.on && u.tabShown, u);

// 3. Technical tab (2D): ADB item, Copy, Check again, diagnostics.
await p.click('#dchat-tab-technical'); await sleep(800);
const item = await p.evaluate(() => { const el = document.querySelector('[data-tech-item="quest-passthrough-adb"]'); return el ? { title: el.querySelector('.gs-tech-item-title').textContent, cmd: el.querySelector('.gs-tech-adb-cmd').textContent, text: el.innerText, diag: el.querySelector('.gs-tech-diag').textContent, active: document.getElementById('dchat-panel-technical').classList.contains('active') } : null; });
check('[2D] Technical tab lists "Quest passthrough camera (ADB)" with steps + command', item && item.active && item.title === 'Quest passthrough camera (ADB)' && item.cmd === CMD && /Developer mode/.test(item.text) && /USB debugging/.test(item.text) && /reopen Quest Browser/.test(item.text), item && item.title);
check('[2D] live diagnostics shown (Browser, permission, camera list)', item && /Cameras listed \(1\)/.test(item.diag) && /permissions\.query\(camera\)/.test(item.diag) && /Browser: Quest Browser/.test(item.diag), item && item.diag);
await p.click('[data-tech-item="quest-passthrough-adb"] .gs-tech-copy'); await sleep(200);
const copied = await p.evaluate(async () => ({ clip: await navigator.clipboard.readText(), btn: document.querySelector('.gs-tech-copy').textContent }));
check('[2D] Copy puts the ADB command on the clipboard', copied.clip === CMD && copied.btn === 'Copied', copied);
const asks0 = await p.evaluate(() => __envAsks);
await p.click('[data-tech-item="quest-passthrough-adb"] .gs-tech-check');
await p.waitForFunction(() => !document.querySelector('.gs-tech-check').disabled && /Still|available|failed/.test(document.querySelector('.gs-tech-result').textContent), { timeout: 15000 }).catch(() => {});
const chk = await p.evaluate(() => ({ result: document.querySelector('.gs-tech-result').textContent, diag: document.querySelector('.gs-tech-diag').textContent, asks: __envAsks }));
check('[2D] Check again re-requests the passthrough camera and re-lists', chk.asks > asks0 && /Still only the avatar camera \(OverconstrainedError: Cannot satisfy constraints\)/.test(chk.result), chk.result);
check('[2D] diagnostics updated with the request error', /exact: 'environment'\}\}: OverconstrainedError: Cannot satisfy constraints/.test(chk.diag), chk.diag);
await p.screenshot({ path: `${SHOT_DIR}/04-2d-technical-tab.png` });
await p.click('.dchat-tab[data-tab="chat"]'); await sleep(300);
if (!(await p.evaluate(() => gsPhotoCapture.isOpen))) { await p.click('#desktop-camera-button'); await p.evaluate(() => gsPhotoCapture.ready); await sleep(1200); }
const hintOn = await p.evaluate(() => ({ hint: gsPhotoCapture.state().hint, help: !document.querySelector('#gs-camera-panel .gs-cam-hint-help').hidden }));
check('[on] camera hint points to 🛠 Technical with an Open Technical button', /See 🛠 Technical › Quest passthrough camera \(ADB\)/.test(hintOn.hint) && hintOn.help, hintOn);
await p.screenshot({ path: `${SHOT_DIR}/04b-on-mode-camera-hint.png` });

// 4. VR menu window: Technical tab painted and ray-clickable.
await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); window.gsXrMode.set('vr'); });
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
await sleep(2000);
const uvOf = (sel) => p.evaluate((sel) => { const w = __gsVrWindows.byName('menu'); const src = w.source || document.getElementById('desktop-chat'); const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(), s = src.getBoundingClientRect(); return { x: (r.left + r.width / 2 - s.left) / s.width, y: 1 - (r.top + r.height / 2 - s.top) / s.height }; }, sel);
const rayClick = async (sel) => p.evaluate(async (uv) => { const w = __gsVrWindows.byName('menu'); const el = w.click(uv); return el ? (el.id || el.className || el.tagName) : null; }, await uvOf(sel));
const xrOk = await p.evaluate(() => renderer.xr.isPresenting);
check('[VR] in an IWER Quest 3 VR session', xrOk);
const hitTab = await rayClick('#dchat-tab-technical'); await sleep(600);
const vrState = await p.evaluate(() => ({ active: document.getElementById('dchat-panel-technical').classList.contains('active') }));
check('[VR] ray click on 🛠 Technical opens the tab in the menu window', vrState.active, { hitTab, vrState });
const asks1 = await p.evaluate(() => __envAsks);
await p.evaluate(() => document.querySelector('.gs-tech-check').scrollIntoView({ block: 'center' })); await sleep(200);
const hitCheck = await rayClick('[data-tech-item="quest-passthrough-adb"] .gs-tech-check');
await p.waitForFunction((a) => __envAsks > a && !document.querySelector('.gs-tech-check').disabled, { timeout: 15000 }, asks1).catch(() => {});
check('[VR] ray click on Check again runs the check', (await p.evaluate(() => __envAsks)) > asks1, hitCheck);
await p.evaluate(() => document.querySelector('[data-tech-item="quest-passthrough-adb"]').scrollIntoView({ block: 'start' })); await sleep(300);
await p.evaluate(() => { const w = __gsVrWindows.byName('menu'); w.tick(true); });
const win = await p.evaluate(() => { const w = __gsVrWindows.byName('menu'); const src = w.mesh.material.map.image; const c = document.createElement('canvas'); c.width = src.width; c.height = src.height; const g = c.getContext('2d'); g.drawImage(src, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0, k = 0; for (let i = 0; i < d.length; i += 4 * 101) { k++; if (d[i] + d[i + 1] + d[i + 2] > 60) n++; } return { png: c.toDataURL('image/png'), lit: n / k }; });
check('[VR] menu window canvas painted (has content)', win.lit > 0.02, win.lit);
fs.writeFileSync(`${SHOT_DIR}/05-vr-menu-window-technical.png`, Buffer.from(win.png.split(',')[1], 'base64'));
// Toggle lives in Controls in VR too: ray-click Off.
await rayClick('.dchat-tab[data-tab="controls"]'); await sleep(300);
await p.evaluate(() => document.getElementById('dchat-technical-toggle').scrollIntoView({ block: 'center' })); await sleep(200);
await p.evaluate(() => { const w = __gsVrWindows.byName('menu'); w.tick(true); });
const winC = await p.evaluate(() => __gsVrWindows.byName('menu').mesh.material.map.image.toDataURL ? __gsVrWindows.byName('menu').mesh.material.map.image.toDataURL('image/png') : null);
if (winC) fs.writeFileSync(`${SHOT_DIR}/06-vr-menu-window-controls-toggle.png`, Buffer.from(winC.split(',')[1], 'base64'));
await rayClick('#dchat-technical-toggle'); await sleep(400);
u = await ui();
check('[VR] ray click on the Controls toggle turns Technical mode off (no confirm)', !u.on && !u.stored && !u.tabShown, u);

// 5. Off persists over reload; hint back to the short line.
await load();
u = await ui();
check('[off] still off after reload', !u.on && !u.tabShown && /Off/.test(u.toggle), u);
check('[page] no page errors / native dialogs', errors.length === 0, errors.slice(0, 3));
await b.close();
console.log(`\ntechnical-mode smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
