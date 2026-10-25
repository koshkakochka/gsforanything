// A page refresh resets the whole view; user content and preferences survive.
//   BASE=http://localhost:3601 node test.mjs        (vercel-sim, for the share-link part)
//   SHOT_DIR=/workspace/gs-viewreset-shots ONLY=desktop|phone|share node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3601';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-viewreset-shots';
const ONLY = process.env.ONLY || '';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n}${c || !e ? '' : ' — ' + e}`); console.log(results.at(-1)); };
const near = (a, b, eps = 2) => Math.abs(a - b) <= eps;
const want = (n) => !ONLY || ONLY.split(',').includes(n);
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const BOX_CODE = "const m = new THREE.Mesh(new THREE.BoxGeometry(0.4,0.4,0.4), new THREE.MeshStandardMaterial({color:0xff5533})); m.name='box'; m.position.set(0,0.25,-2); scene.add(m);";
const CUSTOM_PROMPT = 'You are a test prompt for the view-reset harness. Build scenes.';
const THEME = { name: 'Test Theme', cssVars: { '--dchat-bg': 'rgba(10, 60, 30, 0.9)' }, customCSS: '/* view-reset */' };
const TXT = '/tmp/gs-viewreset-file.txt';
fs.writeFileSync(TXT, 'hello from the view-reset harness');

async function open(vp, { ctx, path = '/', mobile = false } = {}) {
  const p = await ctx.newPage(); p._errs = [];
  p.on('pageerror', (e) => p._errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ollama|11434|hdri|HDR|example\.invalid/i.test(m.text())) p._errs.push(m.text().slice(0, 200)); });
  if (mobile) await p.setUserAgent(UA_PHONE);
  await p.setViewport(vp);
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const u = new URL(req.url());
    if (u.hostname === 'example.invalid') return req.respond({ status: 404, body: '' });
    if (u.pathname === '/api/chat') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'Mock reply.' }] }) });
    req.continue();
  });
  await p.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.gsSessionCode && window.gsOrigin && window.gsControls, { timeout: 30000 });
  await sleep(2000);
  return p;
}
const reload = async (p) => { await p.reload({ waitUntil: 'networkidle2', timeout: 60000 }); await p.waitForFunction(() => window.gsSessionCode && window.gsOrigin && window.gsControls, { timeout: 30000 }); await sleep(2000); };

// Everything a reload should put back to its default, as one snapshot.
const viewState = (p) => p.evaluate(() => {
  const dc = document.getElementById('desktop-chat');
  const r = dc.getBoundingClientRect();
  const val = (id) => { const e = document.getElementById(id); return e ? (e.type === 'checkbox' ? e.checked : e.value) : null; };
  const scrollers = [...dc.querySelectorAll('*')].filter((e) => e.scrollTop > 0).map((e) => e.id || e.className);
  return {
    rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    expanded: dc.classList.contains('expanded'),
    hidden: dc.classList.contains('hidden'),
    tab: document.querySelector('.dchat-tab.active')?.dataset.tab,
    chatSection: document.querySelector('[data-chat-section].active')?.dataset.chatSection,
    communitySection: document.querySelector('[data-community-section].active')?.dataset.communitySection,
    cam: [...camera.position.toArray(), ...camera.quaternion.toArray()].map((v) => +v.toFixed(3)),
    zoom: +camera.zoom.toFixed(3), fov: +camera.fov.toFixed(3),
    target: gsControls.controls && gsControls.controls.target ? gsControls.controls.target.toArray().map((v) => +v.toFixed(3)) : null,
    origin: gsOrigin.rotation,
    originFields: ['yaw', 'pitch', 'roll'].map((k) => val('dchat-origin-' + k)).join(),
    snap: val('dchat-origin-snap'), live: val('dchat-code-live'),
    hue: val('dchat-hue'), sat: val('dchat-saturation'), bright: val('dchat-brightness'),
    scrollers, pageScroll: [window.scrollX, window.scrollY],
    stored: { size: localStorage.getItem('carljr-chat-window'), origin: localStorage.getItem('gs.originRotation') }
  };
});
const contentState = (p) => p.evaluate(async () => {
  const files = await new Promise((res) => { const rq = indexedDB.open('carljr-context-files', 1); rq.onsuccess = () => { try { const g = rq.result.transaction('files', 'readonly').objectStore('files').getAll(); g.onsuccess = () => res(g.result.map((f) => f.name)); g.onerror = () => res(null); } catch { res(null); } }; rq.onerror = () => res(null); });
  return {
    prompt: localStorage.getItem('gs.customChatPrompt.v1'), promptActive: window.GSChatPrompt?.isCustom?.(),
    themeRemember: localStorage.getItem('carljr-theme-remember'), theme: localStorage.getItem('carljr-theme'),
    themeBg: document.getElementById('desktop-chat').style.getPropertyValue('--dchat-bg').trim(),
    cameraMode: gsControls.mode, cameraStored: localStorage.getItem('gs.cameraControlMode'),
    twinSticks: localStorage.getItem('gs.twinSticks'), twinChecked: document.getElementById('dchat-twin-sticks').checked,
    anchor: localStorage.getItem('gs.windowAnchor'), anchorUi: document.querySelector('#dchat-window-anchor [data-window-anchor].active')?.dataset.windowAnchor,
    env: localStorage.getItem('gs.sceneEnvironment'), dimUi: document.querySelector('#dchat-dim-mode [data-dim].active')?.dataset.dim,
    deps: localStorage.getItem('gs.dependencies'), p5: window.GS_DEPS?.isEnabled('p5'),
    publish: localStorage.getItem('gs.publishCreationContext'), hdri: localStorage.getItem('gs-hdri-url'),
    files
  };
});

async function mouseDrag(p, x0, y0, x1, y1) { await p.mouse.move(x0, y0); await p.mouse.down(); for (let i = 1; i <= 12; i++) { await p.mouse.move(x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12); await sleep(16); } await p.mouse.up(); await sleep(250); }
async function touchDrag(p, cdp, x0, y0, x1, y1) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] }); for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 12, y: y0 + (y1 - y0) * i / 12, id: 1 }] }); await sleep(16); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250); }
const elRect = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const headerGrab = (p) => p.evaluate(() => {
  const h = document.getElementById('desktop-chat-header'); const r = h.getBoundingClientRect();
  const btns = document.getElementById('desktop-chat-header-buttons').getBoundingClientRect();
  const y = Math.round(r.top + r.height / 2);
  for (let x = Math.round(btns.left - 12); x > r.left + 4; x -= 8) { const e = document.elementFromPoint(x, y); if (e && h.contains(e) && !e.closest('#desktop-chat-header-buttons')) return { x, y }; }
  return { x: Math.round(r.left + 60), y };
});

async function suite(name, vp, { mobile = false } = {}) {
  const H = `[${name}]`;
  const ctx = await b.createBrowserContext(); // one profile: storage survives reloads
  const p = await open(vp, { ctx, mobile });
  const cdp = mobile ? await p.createCDPSession() : null;
  const D = await viewState(p); // defaults on a fresh profile
  await p.screenshot({ path: `${SHOT_DIR}/${name}-1-default.png` });

  // ---- content / preferences the user chose (kept)
  await p.evaluate((t, th) => {
    window.GSChatPrompt.saveCustom(t);
    localStorage.setItem('carljr-theme-remember', '1');
    localStorage.setItem('carljr-theme', JSON.stringify(th));
    localStorage.setItem('gs-hdri-url', 'https://example.invalid/env.hdr');
    localStorage.setItem('gs.publishCreationContext', JSON.stringify({ include: false, files: false }));
  }, CUSTOM_PROMPT, THEME);
  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="controls"]').click()); await sleep(200);
  await p.evaluate(() => { const t = document.getElementById('dchat-twin-sticks'); t.checked = false; t.dispatchEvent(new Event('change')); });
  await p.evaluate(() => document.querySelector('#dchat-window-anchor [data-window-anchor="follow"]')?.click()); await sleep(100);
  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="env"]').click()); await sleep(200);
  await p.evaluate(() => document.querySelector('#dchat-dim-mode [data-dim="2d"]').click()); await sleep(300);
  await p.evaluate(() => document.querySelector('#dchat-dim-mode [data-dim="3d"]').click()); await sleep(100);
  await p.evaluate(() => window.GS_DEPS.setEnabled('p5', true));
  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="files"]').click()); await sleep(200);
  const fi = await p.$('#dchat-files-input'); await fi.uploadFile(TXT); await sleep(800);
  await p.evaluate(() => gsControls.setMode('map')); await sleep(200);
  const C0 = await contentState(p);

  // ---- view state (reset)
  await p.evaluate((c) => gsSessionCode.add(c), BOX_CODE); await sleep(300);
  // camera: zoom / move / turn
  await p.evaluate(() => { camera.position.set(3.2, 4.1, -5.5); camera.lookAt(0.5, 0, 0.5); camera.zoom = 1.7; camera.updateProjectionMatrix(); const c = gsControls.controls; if (c && c.target) { c.target.set(0.5, 0, 0.5); c.update?.(); } });
  // origin rotation, snap, live code, background sliders
  await p.evaluate(() => gsOrigin.set({ yaw: 45, pitch: 20, roll: -30 }));
  await p.evaluate(() => { for (const [id, v] of [['dchat-hue', '40'], ['dchat-saturation', '80'], ['dchat-brightness', '20']]) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } for (const id of ['dchat-origin-snap', 'dchat-code-live']) { const e = document.getElementById(id); e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); } });
  // window: drag by the header, then resize from the SE corner
  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="chat"]').click()); await sleep(200);
  const g = await headerGrab(p);
  const dx = mobile ? 0 : (D.rect.l > 300 ? -150 : 150), dy = mobile ? 120 : 90;
  if (mobile) await touchDrag(p, cdp, g.x, g.y, g.x + dx, g.y + dy); else await mouseDrag(p, g.x, g.y, g.x + dx, g.y + dy);
  const se = await elRect(p, '.dchat-resize.corner-se');
  if (mobile) await touchDrag(p, cdp, se.cx, se.cy, se.cx - 40, se.cy - 60); else await mouseDrag(p, se.cx, se.cy, se.cx - 60, se.cy - 70);
  const moved = await viewState(p);
  ok(`${H} setup: window moved`, !near(moved.rect.l, D.rect.l) || !near(moved.rect.t, D.rect.t), JSON.stringify({ D: D.rect, m: moved.rect }));
  ok(`${H} setup: window resized`, !near(moved.rect.w, D.rect.w) || !near(moved.rect.h, D.rect.h), JSON.stringify({ D: D.rect, m: moved.rect }));
  ok(`${H} setup: resize / drag stores nothing`, moved.stored.size === null && moved.stored.origin === null, JSON.stringify(moved.stored));
  // tabs, sub-tabs, scroll
  await p.evaluate(() => { const m = document.getElementById('desktop-chat-messages'); for (let i = 0; i < 40; i++) { const d = document.createElement('div'); d.textContent = 'filler line ' + i; m.appendChild(d); } m.scrollTop = 200; });
  await p.evaluate(() => document.querySelector('[data-chat-section="prompt"]').click()); await sleep(200);
  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="community"]').click()); await sleep(200);
  await p.evaluate(() => document.querySelector('[data-community-section="themes"]').click()); await sleep(200);
  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="env"]').click()); await sleep(200);
  await p.evaluate(() => { const c = document.querySelector('#desktop-chat .dchat-panel.active, #desktop-chat [data-panel="env"], #dchat-env'); const s = [...document.querySelectorAll('#desktop-chat *')].find((e) => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible' && e.offsetParent); if (s) s.scrollTop = 150; });
  // expand
  await p.evaluate(() => document.getElementById('desktop-chat-expand').click()); await sleep(300);
  const changed = await viewState(p);
  ok(`${H} setup: view changed (tab, camera, origin, sliders, expanded)`, changed.tab === 'env' && changed.expanded && changed.origin.yaw === 45 && JSON.stringify(changed.cam) !== JSON.stringify(D.cam) && changed.hue === '40' && changed.snap === true, JSON.stringify(changed));
  await p.screenshot({ path: `${SHOT_DIR}/${name}-2-changed.png` });

  // ---- reload #1 (expanded)
  await reload(p);
  let R = await viewState(p);
  const check = (R, when) => {
    ok(`${H} ${when}: window at its default spot`, near(R.rect.l, D.rect.l) && near(R.rect.t, D.rect.t), JSON.stringify({ D: D.rect, R: R.rect }));
    ok(`${H} ${when}: window at its default size`, near(R.rect.w, D.rect.w) && near(R.rect.h, D.rect.h), JSON.stringify({ D: D.rect, R: R.rect }));
    ok(`${H} ${when}: not expanded, not hidden`, !R.expanded && R.hidden === D.hidden, JSON.stringify(R));
    ok(`${H} ${when}: default tab and sub-tabs`, R.tab === D.tab && R.chatSection === D.chatSection && R.communitySection === D.communitySection, JSON.stringify([R.tab, R.chatSection, R.communitySection]));
    ok(`${H} ${when}: camera position / rotation / zoom at defaults`, JSON.stringify(R.cam) === JSON.stringify(D.cam) && R.zoom === D.zoom && R.fov === D.fov && JSON.stringify(R.target) === JSON.stringify(D.target), JSON.stringify({ D: [D.cam, D.zoom, D.target], R: [R.cam, R.zoom, R.target] }));
    ok(`${H} ${when}: origin unrotated (gizmo fields too)`, R.origin.yaw === 0 && R.origin.pitch === 0 && R.origin.roll === 0 && R.originFields === '0,0,0', JSON.stringify([R.origin, R.originFields]));
    ok(`${H} ${when}: snap / live / background sliders at defaults`, R.snap === D.snap && R.live === D.live && R.hue === D.hue && R.sat === D.sat && R.bright === D.bright, JSON.stringify(R));
    ok(`${H} ${when}: nothing scrolled`, R.scrollers.length === 0 && R.pageScroll.join() === '0,0', JSON.stringify([R.scrollers, R.pageScroll]));
    ok(`${H} ${when}: no view state in storage`, R.stored.size === null && R.stored.origin === null, JSON.stringify(R.stored));
  };
  // Map is the user's kept camera mode, so the default camera to compare against is Map's default.
  check(R, 'reload (was expanded)');
  await p.screenshot({ path: `${SHOT_DIR}/${name}-3-after-reload.png` });

  // ---- content survives
  const C1 = await contentState(p);
  ok(`${H} custom chat prompt kept (and active)`, C1.prompt === CUSTOM_PROMPT && C1.promptActive === true, JSON.stringify([C1.prompt, C1.promptActive]));
  ok(`${H} theme kept (Remember theme on)`, C1.themeRemember === '1' && !!C1.theme && C1.themeBg.replace(/\s/g, '') === 'rgba(10,60,30,0.9)', JSON.stringify([C1.themeRemember, C1.themeBg]));
  ok(`${H} camera mode kept (Map)`, C1.cameraMode === 'map' && C1.cameraStored === 'map', JSON.stringify([C1.cameraMode, C1.cameraStored]));
  ok(`${H} twin sticks off kept`, C1.twinSticks === 'off' && C1.twinChecked === false);
  ok(`${H} VR window anchor (Follow head) kept`, C1.anchor === 'follow' && C1.anchorUi === 'follow', JSON.stringify([C1.anchor, C1.anchorUi]));
  ok(`${H} 2D/3D environment choice kept`, C1.env === C0.env && C1.dimUi === '3d', JSON.stringify([C0.env, C1.env, C1.dimUi]));
  ok(`${H} dependencies kept (p5 on)`, C1.deps === C0.deps && C1.p5 === true, JSON.stringify([C1.deps, C1.p5]));
  ok(`${H} publish-context preference kept`, C1.publish === C0.publish && !!C1.publish);
  ok(`${H} saved HDRI URL kept`, C1.hdri === 'https://example.invalid/env.hdr');
  ok(`${H} Files library (IndexedDB) kept`, Array.isArray(C1.files) && C1.files.includes('gs-viewreset-file.txt'), JSON.stringify(C1.files));

  // ---- reload #2: hidden UI and a window that was only dragged / resized (not expanded)
  const g2 = await headerGrab(p);
  if (mobile) await touchDrag(p, cdp, g2.x, g2.y, g2.x, g2.y + 100); else await mouseDrag(p, g2.x, g2.y, g2.x + dx, g2.y + dy);
  const se2 = await elRect(p, '.dchat-resize.corner-se');
  if (!mobile) await mouseDrag(p, se2.cx, se2.cy, se2.cx - 80, se2.cy - 40);
  await p.evaluate(() => gsOrigin.set({ yaw: -90, pitch: 0, roll: 0 }));
  await p.evaluate(() => { camera.position.set(-6, 2, 6); camera.zoom = 0.6; camera.updateProjectionMatrix(); });
  await p.evaluate(() => document.getElementById('ui-toggle').click()); await sleep(300);
  const h = await viewState(p);
  ok(`${H} setup: UI hidden`, h.hidden, JSON.stringify(h));
  await reload(p);
  R = await viewState(p);
  check(R, 'reload (was hidden)');
  ok(`${H} no console / page errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 5)));
  // ---- an old build's stored view state is ignored and cleared
  await p.evaluate(() => { localStorage.setItem('carljr-chat-window', JSON.stringify({ left: 40, top: 60, width: 333, height: 444 })); localStorage.setItem('gs.originRotation', JSON.stringify({ yaw: 30, pitch: 10, roll: 5 })); });
  await reload(p);
  R = await viewState(p);
  check(R, 'reload (old stored size / origin)');
  await ctx.close();
}

async function share() {
  const H = '[share]';
  const ctx = await b.createBrowserContext();
  const a = await open({ width: 1280, height: 860 }, { ctx });
  await a.evaluate((c) => gsSessionCode.add(c), BOX_CODE); await sleep(300);
  await a.evaluate(() => gsOrigin.set({ yaw: 30, pitch: 15, roll: -45 }));
  const posted = [];
  a.on('request', (r) => { if (r.url().endsWith('/api/community-scenes') && r.method() === 'POST') posted.push(1); });
  await a.evaluate(() => document.querySelector('.dchat-tab[data-tab="share"]').click()); await sleep(300);
  await a.evaluate(() => document.querySelector('#dchat-share [data-share="link"]').click());
  for (let i = 0; i < 40 && !posted.length; i++) await sleep(150);
  await sleep(800);
  const link = await a.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value).find((v) => /\/e\/[A-Za-z0-9_-]+/.test(v)) || null);
  const id = link ? link.split('/e/')[1] : null;
  ok(`${H} share link created`, !!id, link);
  // same browser, which also has view changes: the link opens the scene with ITS rotation
  await a.evaluate(() => { camera.position.set(5, 5, 5); gsOrigin.set({ yaw: -100, pitch: 0, roll: 0 }); });
  await a.goto(BASE + '/e/' + id, { waitUntil: 'networkidle2' }); await a.waitForFunction(() => window.gsOrigin && scene.getObjectByName('box'), { timeout: 30000 }); await sleep(1500);
  let s = await a.evaluate(() => ({ rot: gsOrigin.rotation, box: !!scene.getObjectByName('box'), cam: camera.position.toArray().map((v) => +v.toFixed(2)) }));
  ok(`${H} /e/:id opens the scene with its saved origin rotation on first load`, s.box && s.rot.yaw === 30 && s.rot.pitch === 15 && s.rot.roll === -45, JSON.stringify(s));
  ok(`${H} /e/:id camera starts at the default view (not the earlier one)`, s.cam.join() !== '5,5,5', JSON.stringify(s.cam));
  await a.screenshot({ path: `${SHOT_DIR}/share-e-link.png` });
  // and a refresh of the share link re-opens the scene the same way
  await a.reload({ waitUntil: 'networkidle2' }); await a.waitForFunction(() => window.gsOrigin && scene.getObjectByName('box'), { timeout: 30000 }); await sleep(1500);
  s = await a.evaluate(() => ({ rot: gsOrigin.rotation, box: !!scene.getObjectByName('box') }));
  ok(`${H} refreshing /e/:id re-opens the scene with its rotation`, s.box && s.rot.yaw === 30, JSON.stringify(s));
  // /s/:id display-only still works
  await a.goto(BASE + '/s/' + id, { waitUntil: 'networkidle2' }); await a.waitForFunction(() => window.gsOrigin && scene.getObjectByName('box'), { timeout: 30000 }); await sleep(1500);
  s = await a.evaluate(() => ({ rot: gsOrigin.rotation, display: document.body.classList.contains('display-only') }));
  ok(`${H} /s/:id display-only opens with the scene's rotation`, s.display && s.rot.yaw === 30, JSON.stringify(s));
  // ?scene=id
  await a.goto(BASE + '/?scene=' + id, { waitUntil: 'networkidle2' }); await a.waitForFunction(() => window.gsOrigin && scene.getObjectByName('box'), { timeout: 30000 }); await sleep(1500);
  s = await a.evaluate(() => ({ rot: gsOrigin.rotation }));
  ok(`${H} ?scene=id opens with the scene's rotation`, s.rot.yaw === 30, JSON.stringify(s));
  ok(`${H} no console / page errors`, a._errs.length === 0, JSON.stringify(a._errs.slice(0, 5)));
  await ctx.close();
}

if (want('desktop')) await suite('desktop-1280x800', { width: 1280, height: 800 });
if (want('desktop')) await suite('desktop-1920x1080', { width: 1920, height: 1080 });
if (want('phone')) await suite('phone-390x844', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { mobile: true });
if (want('tablet')) await suite('tablet-820x1180', { width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { mobile: true });
if (want('share')) await share();
await b.close();
const fails = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
