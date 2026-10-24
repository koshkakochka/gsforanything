// Window drag by the header with touch (feature/touch-window-drag).
//   BASE=https://localhost:3488 node test.mjs
//   ONLY=phone-390x844 node test.mjs        (one device; prefix match)
// Touch is real CDP touch input (Input.dispatchTouchEvent), so it goes
// through Chrome's touch-action / pointer-event pipeline like a finger.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3488';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-touchdrag-shots';
const ONLY = process.env.ONLY || '';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : e}`); console.log(results.at(-1)); };
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function open(dev, { clearStorage = true } = {}) {
  const p = await b.newPage(); p._errs = [];
  p.on('pageerror', e => p._errs.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p._errs.push(m.text().slice(0, 200)); });
  if (dev.touch) await p.setUserAgent(dev.ua);
  await p.setViewport({ width: dev.w, height: dev.h, isMobile: !!dev.touch, hasTouch: !!dev.touch, deviceScaleFactor: dev.touch ? 2 : 1 });
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    if (u.includes('/api/community-scenes') && req.method() === 'POST') return req.respond({ status: 503, body: 'blocked' });
    if (u.endsWith('/api/chat')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'Mock reply.' }] }) });
    req.continue();
  });
  await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
  if (clearStorage) { await p.evaluate(() => localStorage.removeItem('carljr-chat-window')); await p.reload({ waitUntil: 'networkidle2' }); }
  await sleep(2000);
  p._cdp = await p.createCDPSession();
  return p;
}
const shot = (p, name) => p.screenshot({ path: `${SHOT_DIR}/${name}.png` });
const rect = (p, sel = '#desktop-chat') => p.evaluate(sel => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);
const vbox = p => p.evaluate(() => { const vv = visualViewport; return { w: vv.width, h: vv.height, iw: innerWidth, ih: innerHeight, cls: document.documentElement.className }; });
// A point on the header that the header itself receives (Hide UI can sit on
// top of it when the window is in the top-left corner).
const headerGrab = p => p.evaluate(() => {
  const h = document.getElementById('desktop-chat-header'); const r = h.getBoundingClientRect();
  const btns = document.getElementById('desktop-chat-header-buttons').getBoundingClientRect();
  const y = Math.round(r.top + r.height / 2);
  for (let x = Math.round(btns.left - 12); x > r.left + 4; x -= 8) {
    const e = document.elementFromPoint(x, y);
    if (e && h.contains(e) && !e.closest('#desktop-chat-header-buttons')) return { x, y, h: r.height };
  }
  return { x: Math.round(r.left + 60), y, h: r.height, covered: true };
});

async function touchDrag(p, x0, y0, x1, y1, steps = 12) {
  const c = p._cdp;
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, id: 1 }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
}
async function tap(p, x, y) {
  await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(40);
  await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function doubleTap(p, x, y) { await tap(p, x, y); await sleep(120); await tap(p, x, y); await sleep(400); }
async function tapEl(p, sel) { const r = await p.evaluate(s => { const e = document.querySelector(s); e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel); await tap(p, r[0], r[1]); await sleep(300); }
const camPose = p => p.evaluate(() => [...camera.position.toArray(), ...camera.quaternion.toArray()].map(v => +v.toFixed(4)).join(','));
const stored = p => p.evaluate(() => { try { return JSON.parse(localStorage.getItem('carljr-chat-window')); } catch { return null; } });
const insideBox = (r, B, m = 0) => r.l >= m - 0.5 && r.t >= m - 0.5 && r.r <= B.w - m + 0.5 && r.b <= B.h - m + 0.5;

// Common touch checks for one device.
async function touchSuite(dev) {
  const T = `[${dev.name}]`;
  let p = await open(dev);
  const B = await vbox(p);
  ok(`${T} phone class ${dev.phone ? 'on' : 'off'}`, /\bgs-phone\b/.test(B.cls) === dev.phone, B.cls);
  const css = await p.evaluate(() => ({ header: getComputedStyle(document.getElementById('desktop-chat-header')).touchAction, list: getComputedStyle(document.getElementById('desktop-chat-messages')).touchAction, tabs: getComputedStyle(document.getElementById('desktop-chat-tabs')).touchAction }));
  ok(`${T} touch-action:none on the header only (list keeps pan-y)`, css.header === 'none' && css.list === 'pan-y' && css.tabs !== 'none', JSON.stringify(css));
  let g = await headerGrab(p);
  ok(`${T} drag handle (header) >= 44px tall`, g.h >= 44 - 0.5, `${g.h}`);
  const r0 = await rect(p);
  await shot(p, `${dev.name}-1-default`);

  // 1. drag by a modest amount
  const dx = dev.landscapePhone ? 120 : -Math.min(150, r0.l - 20 > 0 ? 150 : -150);
  const dxUse = dev.phone && !dev.landscapePhone ? 0 : (r0.l > 200 ? -150 : 150);
  const dy = dev.landscapePhone ? 0 : 140;
  await touchDrag(p, g.x, g.y, g.x + dxUse, g.y + dy);
  let r1 = await rect(p);
  ok(`${T} finger drag on the header moves the window (${dxUse},${dy})`, near(r1.l - r0.l, dxUse, 3) && near(r1.t - r0.t, dy, 3), JSON.stringify({ r0, r1 }));
  ok(`${T} window keeps its size while dragged`, near(r1.w, r0.w, 1.5) && near(r1.h, r0.h, 1.5), JSON.stringify({ r0, r1 }));
  await shot(p, `${dev.name}-2-dragged`);
  void dx;

  // 2. far off-screen: clamped inside the visible viewport
  g = await headerGrab(p);
  await touchDrag(p, g.x, g.y, g.x + 3000, g.y + 3000, 16);
  let r2 = await rect(p);
  const B2 = await vbox(p);
  ok(`${T} dragged far right/down: clamped inside the visible viewport`, insideBox(r2, B2), JSON.stringify({ r2, B2 }));
  g = await headerGrab(p);
  await touchDrag(p, g.x, g.y, g.x - 3000, g.y - 3000, 16);
  let r3 = await rect(p);
  ok(`${T} dragged far left/up: clamped inside the visible viewport, header reachable`, insideBox(r3, B2) && r3.t >= -0.5, JSON.stringify({ r3, B2 }));
  // leave it somewhere distinctive
  g = await headerGrab(p);
  await touchDrag(p, g.x, g.y, g.x + (dev.phone && !dev.landscapePhone ? 0 : 90), g.y + (dev.landscapePhone ? 0 : 60));
  const rMoved = await rect(p);
  const st = await stored(p);
  ok(`${T} a drag is not saved`, st === null, JSON.stringify(st));

  // 3. reload: back at the default place (drags are not remembered)
  await p.reload({ waitUntil: 'networkidle2' }); await sleep(2000);
  const rLoad = await rect(p);
  ok(`${T} position NOT restored after reload (default place)`, near(rLoad.l, r0.l, 2) && near(rLoad.t, r0.t, 2) && !(near(rLoad.l, rMoved.l, 2) && near(rLoad.t, rMoved.t, 2)), JSON.stringify({ r0, rMoved, rLoad }));
  p._cdp = await p.createCDPSession();
  // move it somewhere distinctive again for the checks below
  g = await headerGrab(p);
  await touchDrag(p, g.x, g.y, g.x + (dev.phone && !dev.landscapePhone ? 0 : 90), g.y + (dev.landscapePhone ? 0 : 60));
  const rR = await rect(p);

  // 4. taps on tabs and header buttons still work and don't move the window
  await tapEl(p, '.dchat-tab[data-tab="controls"]');
  let active = await p.evaluate(() => document.querySelector('.dchat-tab.active')?.dataset.tab);
  const rT = await rect(p);
  ok(`${T} tap on a tab switches tabs`, active === 'controls', active);
  ok(`${T} tab tap doesn't move the window`, near(rT.l, rR.l) && near(rT.t, rR.t), JSON.stringify({ rR, rT }));
  await tapEl(p, '.dchat-tab[data-tab="chat"]');
  await tapEl(p, '#desktop-chat-expand');
  const exp = await p.evaluate(() => document.getElementById('desktop-chat').classList.contains('expanded'));
  ok(`${T} tap on the header's Expand button works`, exp, '');
  // header is not a drag handle while expanded
  if (exp) {
    g = await headerGrab(p); const re0 = await rect(p);
    await touchDrag(p, g.x, g.y, g.x + 80, g.y + 80);
    const re1 = await rect(p);
    ok(`${T} expanded window does not drag`, near(re0.l, re1.l) && near(re0.t, re1.t), JSON.stringify({ re0, re1 }));
    await tapEl(p, '#desktop-chat-expand');
  }
  const rU = await rect(p);
  ok(`${T} restore from expanded returns to the dragged spot`, near(rU.l, rR.l, 2) && near(rU.t, rR.t, 2), JSON.stringify({ rR, rU }));

  // 5. message list still scrolls with a finger, window stays put
  await p.evaluate(() => { const l = document.getElementById('desktop-chat-messages'); for (let i = 0; i < 40; i++) { const d = document.createElement('div'); d.className = 'message assistant'; d.textContent = 'Filler message ' + i + ' for scroll testing.'; l.appendChild(d); } l.dataset.gsPinned = '0'; l.scrollTop = 0; });
  const lr = await rect(p, '#desktop-chat-messages');
  const s0 = await p.evaluate(() => document.getElementById('desktop-chat-messages').scrollTop);
  const rL0 = await rect(p);
  await touchDrag(p, lr.l + lr.w / 2, lr.b - 20, lr.l + lr.w / 2, lr.t + 20, 10);
  await sleep(400);
  const s1 = await p.evaluate(() => document.getElementById('desktop-chat-messages').scrollTop);
  const rL1 = await rect(p);
  ok(`${T} finger drag in the message list scrolls it`, s1 > s0 + 20, `${s0} -> ${s1}`);
  ok(`${T} list scroll doesn't move the window`, near(rL0.l, rL1.l) && near(rL0.t, rL1.t), JSON.stringify({ rL0, rL1 }));

  // 6. camera: a finger drag on the scene (outside the panel) still drives the camera, not the window
  const rc = await rect(p); const Bc = await vbox(p);
  const spot = (rc.r < Bc.w - 120) ? [Math.round((rc.r + Bc.w) / 2), Math.round(Bc.h / 2)] : (rc.l > 120 ? [Math.round(rc.l / 2), Math.round(Bc.h / 2)] : [Math.round(Bc.w / 2), Math.round(Math.min(Bc.h - 120, rc.b + (Bc.h - rc.b) / 2))]);
  const onCanvas = await p.evaluate(([x, y]) => document.elementFromPoint(x, y) === renderer.domElement, spot);
  if (onCanvas) {
    const c0 = await camPose(p);
    await touchDrag(p, spot[0], spot[1], spot[0] + 80, spot[1] + 30, 10);
    await sleep(500);
    const c1 = await camPose(p);
    const rc1 = await rect(p);
    ok(`${T} finger drag on the scene still moves the camera`, c0 !== c1, `${c0} == ${c1}`);
    ok(`${T} scene drag doesn't move the window`, near(rc.l, rc1.l) && near(rc.t, rc1.t), JSON.stringify({ rc, rc1 }));
  } else ok(`${T} (no free scene area beside the window to drag the camera; skipped)`, true);

  // 7. double-tap the header: nothing special (no reset, no expand, no hide)
  const rB = await rect(p);
  g = await headerGrab(p);
  await doubleTap(p, g.x, g.y);
  const rD = await rect(p);
  const stateD = await p.evaluate(() => { const c = document.getElementById('desktop-chat'); return { expanded: c.classList.contains('expanded'), hidden: c.classList.contains('hidden') || !c.getClientRects().length }; });
  ok(`${T} double-tap on the header leaves the window where it is`, near(rD.l, rB.l, 2) && near(rD.t, rB.t, 2) && near(rD.w, rB.w, 2) && near(rD.h, rB.h, 2), JSON.stringify({ rB, rD }));
  ok(`${T} double-tap doesn't expand or hide the window`, !stateD.expanded && !stateD.hidden, JSON.stringify(stateD));
  await shot(p, `${dev.name}-3-after-double-tap`);
  ok(`${T} no console errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 3)));
  await p.close();
}

// Phones: the keyboard layout still wins after a drag.
async function phoneKeyboard(dev) {
  const T = `[${dev.name} keyboard]`;
  const p = await open(dev);
  let g = await headerGrab(p);
  await touchDrag(p, g.x, g.y, g.x, g.y + 2000, 14); // all the way down
  const rDown = await rect(p);
  await tapEl(p, '#desktop-chat-input');
  // Android-style keyboard: the window shrinks over a few frames.
  const kb = Math.round(dev.h * 0.4);
  for (const f of [0.2, 0.45, 0.7, 0.9, 1]) { await p.setViewport({ width: dev.w, height: dev.h - Math.round(kb * f), isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await sleep(40); }
  await sleep(600);
  await p.keyboard.type('a long prompt about a red cube');
  const L = await p.evaluate(() => { const vv = visualViewport; const i = document.getElementById('desktop-chat-input').getBoundingClientRect(); const s = document.getElementById('desktop-send-button').getBoundingClientRect(); return { cls: document.documentElement.className, vvTop: vv.offsetTop, vvH: vv.height, input: { t: i.top, b: i.bottom }, send: { t: s.top, b: s.bottom } }; });
  ok(`${T} keyboard layout on after the window was dragged`, /\bgs-kb-chat\b/.test(L.cls), L.cls);
  ok(`${T} input and Send fully visible above the keyboard`, L.input.t >= L.vvTop - 0.5 && L.input.b <= L.vvTop + L.vvH + 0.5 && L.send.b <= L.vvTop + L.vvH + 0.5, JSON.stringify(L));
  await shot(p, `${dev.name}-4-keyboard-after-drag`);
  // the header is hidden in this layout; a drag attempt where it was does nothing
  await p.setViewport({ width: dev.w, height: dev.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await sleep(1200);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(600);
  const rAfter = await rect(p); const B = await vbox(p);
  ok(`${T} keyboard closed: window back where it was dragged, inside the visible area`, insideBox(rAfter, B) && near(rAfter.t, rDown.t, 3), JSON.stringify({ rDown, rAfter, B }));
  ok(`${T} no console errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 3)));
  await p.close();
}

// Desktop mouse: unchanged behaviour (drag not saved, double-click does nothing).
async function desktopSuite(dev) {
  const T = `[${dev.name} mouse]`;
  const p = await open(dev);
  const B = await vbox(p);
  ok(`${T} no phone class`, !/\bgs-phone\b/.test(B.cls), B.cls);
  const r0 = await rect(p);
  let g = await headerGrab(p);
  await p.mouse.move(g.x, g.y); await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(g.x + 30 * i, g.y + 15 * i); await sleep(10); }
  // leave the header mid-drag (capture keeps tracking)
  const mid = await rect(p);
  ok(`${T} mouse drag moves the window by the cursor delta`, near(mid.l - r0.l, 300) && near(mid.t - r0.t, 150), JSON.stringify({ r0, mid }));
  await p.mouse.up(); await sleep(200);
  ok(`${T} window keeps its size`, near(mid.w, r0.w) && near(mid.h, r0.h));
  // drag far off: clamped at 0 margin, as before
  g = await headerGrab(p);
  await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(g.x + 5000, g.y + 5000, { steps: 8 }); await p.mouse.up(); await sleep(200);
  const rFar = await rect(p);
  ok(`${T} clamped to the right/bottom edge`, near(rFar.r, B.iw, 1) && near(rFar.b, B.ih, 1), JSON.stringify({ rFar, B }));
  g = await headerGrab(p);
  await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(g.x - 5000, g.y - 5000, { steps: 8 }); await p.mouse.up(); await sleep(200);
  const rNear = await rect(p);
  ok(`${T} clamped to the left/top edge`, near(rNear.l, 0, 1) && near(rNear.t, 0, 1), JSON.stringify(rNear));
  // right button doesn't drag
  g = await headerGrab(p);
  await p.mouse.move(g.x, g.y); await p.mouse.down({ button: 'right' }); await p.mouse.move(g.x + 100, g.y + 100, { steps: 4 }); await p.mouse.up({ button: 'right' }); await sleep(150);
  const rRb = await rect(p);
  ok(`${T} right-button drag doesn't move it`, near(rRb.l, rNear.l) && near(rRb.t, rNear.t), JSON.stringify(rRb));
  // header buttons: pressing Expand doesn't start a drag; click still works
  const eb = await rect(p, '#desktop-chat-expand');
  await p.mouse.move(eb.l + eb.w / 2, eb.t + eb.h / 2); await p.mouse.down(); await p.mouse.move(eb.l + 60, eb.t + 60, { steps: 4 }); await p.mouse.up(); await sleep(150);
  const rBtn = await rect(p);
  ok(`${T} press-and-move on a header button doesn't drag`, near(rBtn.l, rNear.l) && near(rBtn.t, rNear.t) || await p.evaluate(() => document.getElementById('desktop-chat').classList.contains('expanded')), JSON.stringify(rBtn));
  if (await p.evaluate(() => document.getElementById('desktop-chat').classList.contains('expanded'))) await p.evaluate(() => document.getElementById('desktop-chat-expand').click());
  await sleep(150);
  // move to a spot, reload: not remembered (no storage clearing needed).
  g = await headerGrab(p);
  await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(g.x + 200, g.y + 120, { steps: 6 }); await p.mouse.up(); await sleep(200);
  const rS = await rect(p);
  await p.reload({ waitUntil: 'networkidle2' }); await sleep(1800);
  const rR = await rect(p);
  ok(`${T} dragged position NOT restored after reload (default place)`, near(rR.l, r0.l, 2) && near(rR.t, r0.t, 2) && !(near(rR.l, rS.l, 2) && near(rR.t, rS.t, 2)), JSON.stringify({ r0, rS, rR }));
  // resize still works (SE corner)
  const se = await rect(p, '.dchat-resize.corner-se');
  await p.mouse.move(se.l + se.w / 2, se.t + se.h / 2); await p.mouse.down(); await p.mouse.move(se.l + se.w / 2 + 60, se.t + se.h / 2 + 40, { steps: 6 }); await p.mouse.up(); await sleep(200);
  const rZ = await rect(p);
  ok(`${T} corner resize still works`, near(rZ.w - rR.w, 60, 3) && near(rZ.h - rR.h, 40, 3), JSON.stringify({ rR, rZ }));
  // text in the window is still selectable/clickable: clicking a tab works
  await p.click('.dchat-tab[data-tab="env"]'); await sleep(150);
  const act = await p.evaluate(() => document.querySelector('.dchat-tab.active')?.dataset.tab);
  ok(`${T} clicking a tab works`, act === 'env', act);
  await p.click('.dchat-tab[data-tab="chat"]');
  // camera: mouse drag on the scene still orbits
  const rc = await rect(p);
  const sx = rc.l > 300 ? 150 : Math.round((rc.r + B.iw) / 2);
  const c0 = await camPose(p);
  await p.mouse.move(sx, 400); await p.mouse.down(); await p.mouse.move(sx + 120, 440, { steps: 8 }); await p.mouse.up(); await sleep(400);
  const c1 = await camPose(p); const rc1 = await rect(p);
  ok(`${T} mouse drag on the scene still moves the camera, not the window`, c0 !== c1 && near(rc.l, rc1.l) && near(rc.t, rc1.t), `${c0} | ${c1}`);
  await shot(p, `${dev.name}-1-dragged`);
  // double-click the header: nothing special
  const rB = await rect(p);
  g = await headerGrab(p);
  await p.mouse.click(g.x, g.y, { clickCount: 1 }); await sleep(80); await p.mouse.click(g.x, g.y, { clickCount: 2 }); await sleep(300);
  const rD = await rect(p);
  const stateD = await p.evaluate(() => { const c = document.getElementById('desktop-chat'); return { expanded: c.classList.contains('expanded'), hidden: c.classList.contains('hidden') }; });
  ok(`${T} double-click on the header leaves the window as it was`, near(rD.l, rB.l, 2) && near(rD.t, rB.t, 2) && near(rD.w, rB.w, 2) && near(rD.h, rB.h, 2) && !stateD.expanded && !stateD.hidden, JSON.stringify({ rB, rD, stateD }));
  // VR mirror: the parked html-in-canvas source never drags
  const vr = await p.evaluate(() => {
    const c = document.getElementById('desktop-chat'); const h = document.getElementById('desktop-chat-header');
    c.classList.add('html-in-canvas-source');
    const before = c.style.left + '|' + c.style.top;
    const hr = h.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: hr.left + 20, clientY: hr.top + 10 };
    h.dispatchEvent(new PointerEvent('pointerdown', o));
    h.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + 100, clientY: o.clientY + 100 }));
    h.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    const after = c.style.left + '|' + c.style.top;
    c.classList.remove('html-in-canvas-source');
    return { before, after };
  });
  ok(`${T} VR mirror source (html-in-canvas-source) never drags`, vr.before === vr.after, JSON.stringify(vr));
  ok(`${T} no console errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 3)));
  await p.close();
}

// Reload always opens at the default spot; only the size from resize (and
// expand/restore) is kept. Works with touch or mouse.
async function persistSuite(dev) {
  const touch = !!dev.touch;
  const T = `[${dev.name} reload]`;
  const p = await open(dev);
  const r0 = await rect(p);
  const drag = async (x0, y0, x1, y1) => {
    if (touch) return touchDrag(p, x0, y0, x1, y1);
    await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move(x1, y1, { steps: 8 }); await p.mouse.up(); await sleep(200);
  };
  const moveAway = async () => {
    const g = await headerGrab(p);
    const dx = dev.phone && !dev.landscapePhone ? 0 : (r0.l > 200 ? -120 : 120);
    const dy = dev.landscapePhone ? 0 : 90;
    await drag(g.x, g.y, g.x + dx, g.y + dy);
    return rect(p);
  };
  const reload = async () => { await p.reload({ waitUntil: 'networkidle2' }); await sleep(2000); if (touch) p._cdp = await p.createCDPSession(); return rect(p); };
  const fullH = !!dev.landscapePhone; // phone landscape column: height is fixed by CSS

  // 1. drag, then resize (SE corner): reload -> default spot, resized size
  const rm = await moveAway();
  const se = await rect(p, '.dchat-resize.corner-se');
  await drag(se.l + se.w / 2, se.t + se.h / 2, se.l + se.w / 2 - 40, se.t + se.h / 2 - 50);
  const rz = await rect(p);
  ok(`${T} corner resize after a drag changes the size`, near(rz.w, rm.w - 40, 3) && (fullH || near(rz.h, rm.h - 50, 3)), JSON.stringify({ rm, rz }));
  const st1 = await stored(p);
  ok(`${T} resize saves the size only (no position)`, st1 && st1.width && st1.height && !('left' in st1) && !('top' in st1), JSON.stringify(st1));
  const rl1 = await reload();
  ok(`${T} drag + resize, reload: window at the default spot`, near(rl1.l, r0.l, 2) && near(rl1.t, r0.t, 2), JSON.stringify({ r0, rz, rl1 }));
  ok(`${T} drag + resize, reload: resized size kept`, near(rl1.w, rz.w, 2) && (fullH || near(rl1.h, rz.h, 2)), JSON.stringify({ rz, rl1 }));
  await shot(p, `${dev.name}-5-reload-after-resize`);

  // 2. drag, then expand / restore: back at the dragged spot this session; reload -> default spot, size kept
  const rm2 = await moveAway();
  await p.evaluate(() => document.getElementById('desktop-chat-expand').click()); await sleep(250);
  await p.evaluate(() => document.getElementById('desktop-chat-expand').click()); await sleep(250);
  const ru = await rect(p);
  ok(`${T} expand / restore returns to the dragged spot (same session)`, near(ru.l, rm2.l, 2) && near(ru.t, rm2.t, 2), JSON.stringify({ rm2, ru }));
  const st2 = await stored(p);
  ok(`${T} expand / restore saves no position`, !st2 || (!('left' in st2) && !('top' in st2)), JSON.stringify(st2));
  const rl2 = await reload();
  ok(`${T} drag + expand / restore, reload: window at the default spot`, near(rl2.l, r0.l, 2) && near(rl2.t, r0.t, 2), JSON.stringify({ r0, ru, rl2 }));
  ok(`${T} drag + expand / restore, reload: size kept`, near(rl2.w, ru.w, 2) && (fullH || near(rl2.h, ru.h, 2)), JSON.stringify({ ru, rl2 }));

  // 3. a position stored by an older version is ignored and dropped
  const legacy = { left: Math.round(r0.l + 60), top: Math.round(r0.t + 70), width: Math.round(r0.w - 20), height: Math.round(r0.h - 30) };
  await p.evaluate(v => localStorage.setItem('carljr-chat-window', JSON.stringify(v)), legacy);
  const rl3 = await reload();
  const st3 = await stored(p);
  ok(`${T} old stored left/top ignored: default spot`, near(rl3.l, r0.l, 2) && near(rl3.t, r0.t, 2), JSON.stringify({ r0, legacy, rl3 }));
  ok(`${T} old stored size still used`, near(rl3.w, legacy.width, 2) && (fullH || near(rl3.h, legacy.height, 2)), JSON.stringify({ legacy, rl3 }));
  ok(`${T} old stored left/top cleared from storage`, st3 && !('left' in st3) && !('top' in st3) && near(st3.width, legacy.width, 1), JSON.stringify(st3));
  ok(`${T} no console errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 3)));
  await p.close();
}

const DEVICES = [
  { name: 'phone-390x844', w: 390, h: 844, touch: true, phone: true, ua: ANDROID },
  { name: 'phone-844x390', w: 844, h: 390, touch: true, phone: true, landscapePhone: true, ua: ANDROID },
  { name: 'tablet-820x1180', w: 820, h: 1180, touch: true, phone: false, ua: IPAD },
  { name: 'tablet-1180x820', w: 1180, h: 820, touch: true, phone: false, ua: IPAD },
  { name: 'tablet-1024x1366', w: 1024, h: 1366, touch: true, phone: false, ua: IPAD },
  { name: 'tablet-1366x1024', w: 1366, h: 1024, touch: true, phone: false, ua: IPAD }
];
const want = n => !ONLY || ONLY.split(',').some(o => n.startsWith(o));
for (const dev of DEVICES) if (want(dev.name)) await touchSuite(dev);
for (const dev of DEVICES) if (want(dev.name)) await persistSuite(dev);
if (want('phone-390x844')) await phoneKeyboard(DEVICES[0]);
for (const dev of [{ name: 'desktop-1280x800', w: 1280, h: 800 }, { name: 'desktop-1920x1080', w: 1920, h: 1080 }]) if (want(dev.name)) { await desktopSuite(dev); await persistSuite(dev); }
await b.close();
const fails = results.filter(r => r.startsWith('FAIL'));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
