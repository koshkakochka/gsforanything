// Quick smoke check (not a full suite) for Technical mode on a mocked Quest 3
// that only lists the avatar camera ({exact:'environment'} → OverconstrainedError,
// the Quest Browser 150 bug). /api/* stubbed.
// BASE=https://localhost:3531 SHOT_DIR=/workspace/gs-techcheck-shots node smoke.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'https://localhost:3531';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-techcheck-shots';
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
const ui = () => p.evaluate(() => {
	const marked = [...document.querySelectorAll('[data-gs-technical]')];
	const vis = (el) => getComputedStyle(el).display !== 'none' && !!el.offsetParent;
	const item = document.querySelector('[data-tech-item="quest-passthrough-adb"]');
	const cs = item ? getComputedStyle(item) : null;
	return {
		on: gsTechnicalMode.isTechnicalMode(), stored: localStorage.getItem('gs.technicalMode'),
		tabShown: getComputedStyle(document.getElementById('dchat-tab-technical')).display !== 'none',
		checked: document.getElementById('dchat-technical-checkbox').checked,
		controlsButton: !!document.getElementById('dchat-technical-toggle'),
		marked: marked.length, markedHiddenByCss: marked.filter((el) => getComputedStyle(el).display === 'none').length,
		itemMarked: !!item && item.hasAttribute('data-gs-technical'),
		itemVisible: !!item && vis(item),
		outline: cs ? `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}` : '',
		accent: getComputedStyle(document.documentElement).getPropertyValue('--gs-technical-accent').trim(),
		panelText: document.getElementById('dchat-panel-technical').innerText.trim()
	};
});
const GREEN = '2px solid rgb(34, 197, 94)';
const dialogUp = () => p.evaluate(() => { const m = document.getElementById('gs-dialog-message'); return m && m.offsetParent !== null ? m.textContent : null; });
await load();

// 1. Unchecked (default): tab always visible, only checkbox + one line, marked UI hidden.
let u = await ui();
check('[off] 🛠 Technical tab visible by default, Controls Off/On button gone', u.tabShown && !u.controlsButton, u);
await p.evaluate(() => window.gsSelectTab('technical')); await sleep(400);
u = await ui();
check('[off] checkbox unchecked, every data-gs-technical element hidden (incl. the ADB item)', !u.checked && !u.on && u.marked >= 4 && u.markedHiddenByCss === u.marked && u.itemMarked && !u.itemVisible, u);
check('[off] tab shows only the checkbox + one-line description', /^Technical mode\s+Shows advanced setup/.test(u.panelText) && !/adb|Quest passthrough/i.test(u.panelText), u.panelText);
await p.screenshot({ path: `${SHOT_DIR}/01-2d-tab-unchecked.png` });
await p.evaluate(() => window.gsSelectTab('chat'));
await p.click('#desktop-camera-button'); await p.evaluate(() => gsPhotoCapture.ready); await sleep(1500);
let cam = await p.evaluate(() => { const pn = document.getElementById('gs-camera-panel'); return { s: gsPhotoCapture.state(), text: pn.innerText }; });
check('[off] camera works with the avatar camera; short hint, no ADB / technical buttons', /Avatar camera/.test(cam.s.status) && /^Passthrough camera needs extra setup: turn on Technical mode/.test(cam.s.hint) && !/adb|Open Technical|Try again/i.test(cam.text), { status: cam.s.status, hint: cam.s.hint, text: cam.text });
await p.screenshot({ path: `${SHOT_DIR}/02-2d-camera-hint-off.png` });

// 2. Check it: gsConfirm; Cancel keeps it off, OK turns it on + saves.
await p.evaluate(() => window.gsSelectTab('technical')); await sleep(300);
await p.click('#dchat-technical-checkbox'); await sleep(400);
let msg = await dialogUp();
check('[on] checking asks with the gsDialog note', !!msg && /advanced setup, such as permissions outside normal browser operation and developer tools/.test(msg), msg);
await p.click('[data-gs-dialog="cancel"]'); await sleep(300);
u = await ui();
check('[on] Cancel leaves it unchecked and off', !u.checked && !u.on && !u.stored, u);
await p.click('#dchat-technical-checkbox'); await sleep(400);
await p.screenshot({ path: `${SHOT_DIR}/03-2d-confirm-dialog.png` });
await p.click('[data-gs-dialog="ok"]'); await sleep(500);
u = await ui();
check('[on] OK: checked, saved under gs.technicalMode, marked items shown', u.checked && u.on && u.stored === '1' && u.markedHiddenByCss === 0 && u.itemVisible, u);
check('[on] marked items get the green accent outline (--gs-technical-accent)', u.outline === GREEN && u.accent === '#22c55e', { outline: u.outline, accent: u.accent });
await p.click('[data-tech-item="quest-passthrough-adb"] .gs-tech-copy'); await sleep(200);
check('[on] Copy puts the ADB command on the clipboard', (await p.evaluate(() => navigator.clipboard.readText())) === CMD);
await p.screenshot({ path: `${SHOT_DIR}/04-2d-tab-checked-green.png` });

// 3. Persists over reload; camera's technical hint/buttons shown + outlined.
await load();
u = await ui();
check('[on] still checked after reload', u.checked && u.on, u);
await p.click('#desktop-camera-button'); await p.evaluate(() => gsPhotoCapture.ready); await sleep(1500);
cam = await p.evaluate(() => { const pn = document.getElementById('gs-camera-panel'); const b = pn.querySelector('.gs-cam-hint-help'); const cs = getComputedStyle(b); return { hint: gsPhotoCapture.state().hint, btn: cs.display !== 'none', outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`, offLine: getComputedStyle(pn.querySelector('.gs-cam-hint-text')).display }; });
check('[on] camera hint: technical line + Open Technical button, green-outlined; off line hidden', /See 🛠 Technical/.test(cam.hint) && cam.btn && cam.outline === GREEN && cam.offLine === 'none', cam);
await p.screenshot({ path: `${SHOT_DIR}/05-2d-camera-hint-on.png` });

// 4. VR: ray clicks the checkbox (off, then on through the confirm).
await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); window.gsXrMode.set('vr'); });
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
await sleep(2000);
const uvOf = (sel) => p.evaluate((sel) => { const w = __gsVrWindows.byName('menu'); const src = w.source || document.getElementById('desktop-chat'); const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(), s = src.getBoundingClientRect(); return { x: (r.left + r.width / 2 - s.left) / s.width, y: 1 - (r.top + r.height / 2 - s.top) / s.height }; }, sel);
const rayClick = async (sel) => p.evaluate((uv) => { const el = __gsVrWindows.byName('menu').click(uv); return el ? (el.id || el.className || el.tagName) : null; }, await uvOf(sel));
const winShot = async (name) => { await p.evaluate(() => __gsVrWindows.byName('menu').tick(true)); const png = await p.evaluate(() => { const src = __gsVrWindows.byName('menu').mesh.material.map.image; const c = document.createElement('canvas'); c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0); return c.toDataURL('image/png'); }); fs.writeFileSync(`${SHOT_DIR}/${name}`, Buffer.from(png.split(',')[1], 'base64')); };
check('[VR] in an IWER Quest 3 VR session', await p.evaluate(() => renderer.xr.isPresenting));
await p.evaluate(() => document.getElementById('gs-menu-hamburger')?.click()); await sleep(400);
await rayClick('#dchat-tab-technical'); await sleep(500);
check('[VR] ray click opens the 🛠 Technical tab', await p.evaluate(() => document.getElementById('dchat-panel-technical').classList.contains('active')));
await winShot('06-vr-menu-checked-green.png');
const hit1 = await rayClick('#dchat-technical-checkbox'); await sleep(400);
u = await ui();
check('[VR] ray click on the checkbox unchecks it: off, marked items hidden', !u.checked && !u.on && !u.stored && u.markedHiddenByCss === u.marked, { hit1, u });
await winShot('07-vr-menu-unchecked.png');
const hit2 = await rayClick('.gs-tech-mode span'); await sleep(500);
msg = await dialogUp();
check('[VR] ray click on the label asks with the gsDialog', !!msg, { hit2, msg });
await p.evaluate(() => document.querySelector('[data-gs-dialog="ok"]').click()); await sleep(500); // VR dialog card's OK (its own window)
await winShot('08-vr-menu-rechecked-green.png');
u = await ui();
check('[VR] confirmed: checked again, items shown with the green outline', u.checked && u.on && u.itemVisible && u.outline === GREEN, u);

// 5. Uncheck persists over reload.
await rayClick('#dchat-technical-checkbox'); await sleep(300); // uncheck from VR, then reload
await load();
u = await ui();
check('[off] unchecked state persists after reload', !u.checked && !u.on && !u.stored, u);
check('[page] no page errors / native dialogs', errors.length === 0, errors.slice(0, 3));
await b.close();
console.log(`\ntechnical-mode smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
