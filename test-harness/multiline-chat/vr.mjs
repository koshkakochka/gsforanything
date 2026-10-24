// Multiline chat input inside the VR menu window (IWER-emulated Quest 3).
//   BASE=https://localhost:3488 node vr.mjs     (needs ../vr-windows/node_modules: iwer)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3488';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-multiline-shots';
const IWER = fs.readFileSync(new URL('../vr-windows/node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); const errors = []; const chats = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await p.setViewport({ width: 1600, height: 900 });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p.setRequestInterception(true);
p.on('request', (req) => { const u = new URL(req.url());
  if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
  if (u.pathname === '/api/community-scenes') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenes: [] }) });
  if (u.pathname === '/api/chat') { chats.push(req.postData() || ''); return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'Mock VR reply.' }] }) }); }
  req.continue(); });
await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(2000);
await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
check('Entered immersive VR (IWER Quest 3)', await p.evaluate(() => renderer.xr.isPresenting));
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
const frame = (ms = 400) => sleep(ms);
const click = async () => { await p.evaluate(() => __t.trigger('right', 1)); await frame(300); await p.evaluate(() => __t.trigger('right', 0)); await frame(400); };
const key = async (sel) => { await p.evaluate((s) => __t.aimAt('right', document.querySelector(s), 'keyboard'), sel); await frame(350); await click(); };
const H = () => p.evaluate(() => { const e = document.getElementById('desktop-chat-input'); return { h: Math.round(e.getBoundingClientRect().height), val: e.value, oy: getComputedStyle(e).overflowY, sh: e.scrollHeight, ch: e.clientHeight, st: e.scrollTop }; });
const one = (await H()).h;

await p.evaluate(() => __t.aimAt('right', document.getElementById('desktop-chat-input'), 'menu'));
await frame(400); await click();
const kb = await p.evaluate(() => ({ open: __t.win('keyboard').mesh.visible, typing: document.getElementById('desktop-chat-input').classList.contains('gs-vr-typing'), enterLabel: document.querySelector('#gs-vr-keyboard .gs-vr-key-enter')?.textContent }));
check('Ray click on the (textarea) chat input opens the VR keyboard', kb.open, kb);
check('Focus ring class on the textarea', kb.typing, kb);
check('VR keyboard Enter key reads "Send" for the chat textarea', kb.enterLabel === 'Send', kb.enterLabel);
for (const c of ['h', 'i']) await key(`#gs-vr-keyboard [data-kb-value="${c}"]`);
await key('#gs-vr-keyboard [data-kb-action="space"]');
let a = await H();
check('VR keys type into the textarea', /^hi $/.test(a.val), a.val);
// a long dictated/typed message (the VR keyboard writes .value)
const LONG = 'a sunlit stone courtyard with ivy on the walls, a bronze fountain in the middle, long late-afternoon shadows, wet cobbles that reflect the sky and a wooden bench under an olive tree';
await p.evaluate((t) => { const e = document.getElementById('desktop-chat-input'); e.value = e.value + t; e.setSelectionRange(e.value.length, e.value.length); e.dispatchEvent(new Event('input', { bubbles: true })); }, LONG);
for (const c of ['o', 'k']) await key(`#gs-vr-keyboard [data-kb-value="${c}"]`);
await frame(600);
a = await H();
check(`Textarea grows in the VR menu (${one}px → ${a.h}px)`, a.h > one + 30 && a.val.endsWith('ok'), a);
// painted texture: count text rows inside the textarea box + the cyan focus ring
const paint = await p.evaluate(() => {
  const w = __t.win('menu'); w.tick(true);
  const el = document.getElementById('desktop-chat-input');
  const sr = w.source.getBoundingClientRect(), r = el.getBoundingClientRect(); const k = w.canvas.width / sr.width;
  const ctx = w.canvas.getContext('2d');
  const x0 = Math.round((r.left - sr.left + 10) * k), y0 = Math.round((r.top - sr.top + 2) * k), ww = Math.round((r.width - 20) * k), hh = Math.round((r.height - 4) * k);
  const d = ctx.getImageData(x0, y0, ww, hh).data; let runs = 0, inRun = false;
  for (let y = 0; y < hh; y++) { let n = 0; for (let x = 0; x < ww; x++) { const i = (y * ww + x) * 4; if (d[i] > 190 && d[i + 1] > 190 && d[i + 2] > 190) n++; } if (n > 2) { if (!inRun) { runs++; inRun = true; } } else inRun = false; }
  // focus ring: #38bdf8 just outside the left edge, at mid height
  const rx = Math.round((r.left - sr.left - 2.5) * k), ry = Math.round((r.top - sr.top + r.height / 2) * k);
  const q = ctx.getImageData(rx - 2, ry, 5, 1).data; let ring = false;
  for (let i = 0; i < q.length; i += 4) if (q[i] < 110 && q[i + 1] > 150 && q[i + 2] > 200) ring = true;
  const lines = Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight));
  window.__menuPng = w.canvas.toDataURL('image/png');
  return { runs, lines, ring };
});
check(`VR texture paints the wrapped lines (${paint.runs} text rows for ${paint.lines} visible lines)`, paint.runs >= paint.lines - 1 && paint.runs >= 3, paint);
check('VR texture paints the cyan focus ring around the textarea', paint.ring, paint);
fs.writeFileSync(`${SHOT_DIR}/vr-menu-texture-multiline.png`, Buffer.from((await p.evaluate(() => window.__menuPng)).split(',')[1], 'base64'));
// caret end stays visible when capped
await p.evaluate((t) => { const e = document.getElementById('desktop-chat-input'); e.value = e.value + ' ' + t + ' ' + t; e.setSelectionRange(e.value.length, e.value.length); }, LONG);
for (const c of ['z']) await key(`#gs-vr-keyboard [data-kb-value="${c}"]`);
a = await H();
check('Capped at max height in VR, scrolled to the caret', a.oy === 'auto' && a.st + a.ch >= a.sh - 2, a);
const p2 = await p.evaluate(() => { const w = __t.win('menu'); w.tick(true); return w.canvas.toDataURL('image/png'); });
fs.writeFileSync(`${SHOT_DIR}/vr-menu-texture-capped.png`, Buffer.from(p2.split(',')[1], 'base64'));
// Send on the VR keyboard
await key('#gs-vr-keyboard .gs-vr-key-enter');
for (let i = 0; i < 20 && chats.length === 0; i++) await sleep(150);
await frame(500);
a = await H();
check('VR Send key sends the whole message', chats.length === 1 && chats[0].includes('olive tree') && chats[0].includes('hi '), chats.length);
check('After Send: cleared and back to one line', a.val === '' && a.h === one, a);
check('No console/page errors', errors.length === 0, errors.slice(0, 4));
await b.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
