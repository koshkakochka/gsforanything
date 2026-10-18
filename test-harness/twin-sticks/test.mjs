// Orbit pivot = scene origin + on-screen twin joysticks (First person; Fly is covered by
// test-harness/camera-controls). Desktop + phone. Updated for the stock three.js controls:
// Orbit has no WASD now, so the pivot is moved with OrbitControls' arrow-key pan.
// BASE=https://localhost:3488 node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3488';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const SCENE = new URL('./box.vrscene', import.meta.url).pathname;
const SHOT = process.env.SHOT || new URL('./twin-sticks-phone.png', import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n} ${e}`); console.log(results.at(-1)); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const near0 = (v, t = 1e-3) => v && v.every(x => Math.abs(x) < t);
const r3 = v => v.map(x => +x.toFixed(3));

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]) {
  const T = `[${vp.name}]`; const touch = !!vp.hasTouch;
  const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  p.on('dialog', d => d.accept());
  await p.setViewport(vp);
  if (touch) await p.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
  await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
  await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await p.evaluate(() => { localStorage.removeItem('gs.twinSticks'); localStorage.removeItem('gs.cameraControlMode'); });
  await p.reload({ waitUntil: 'networkidle2' }); await sleep(3000);
  const cdp = await p.createCDPSession();
  const tab = async (t) => { await p.click(`.dchat-tab[data-tab="${t}"]`); await sleep(250); };
  const mode = async (m) => { await tab('controls'); await p.click(`#dchat-camera-mode [data-camera-mode="${m}"]`); await sleep(400); await tab('chat'); };
  const canvasSpot = () => p.evaluate(() => { const c = renderer.domElement; const no = [...document.querySelectorAll('.gs-stick')].map(e => e.getBoundingClientRect()); for (let y = 0.8; y > 0.2; y -= 0.03) for (let x = 0.3; x < 0.95; x += 0.03) { const X = innerWidth * x, Y = innerHeight * y; if (document.elementFromPoint(X, Y) === c && !no.some(r => X > r.left - 10 && X < r.right + 10 && Y > r.top - 10 && Y < r.bottom + 10)) return [X, Y]; } return null; });
  const ray = () => p.evaluate(() => { const o = camera.getWorldPosition(new THREE.Vector3()); const d = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())); return [o.toArray(), d.toArray()]; });
  async function drag(x, y, dx, dy, steps = 8) {
    if (touch) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }); for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps, id: 1 }] }); await sleep(16); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
    else { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 1; i <= steps; i++) { await p.mouse.move(x + dx * i / steps, y + dy * i / steps); await sleep(16); } await p.mouse.up(); }
  }
  // Behavioural pivot: drag to orbit, intersect the view rays before/after.
  async function behaviouralPivot() {
    let s = await canvasSpot(); for (let i = 0; !s && i < 10; i++) { await sleep(500); s = await canvasSpot(); } if (!s) throw new Error('no free canvas spot'); const r1 = await ray();
    await drag(s[0], s[1], 110, 25); await sleep(1500);
    const r2 = await ray();
    return p.evaluate((r1, r2) => {
      const o1 = new THREE.Vector3(...r1[0]), d1 = new THREE.Vector3(...r1[1]), o2 = new THREE.Vector3(...r2[0]), d2 = new THREE.Vector3(...r2[1]);
      const w = o1.clone().sub(o2); const a = d1.dot(d1), bb = d1.dot(d2), c = d2.dot(d2), d = d1.dot(w), e = d2.dot(w); const den = a * c - bb * bb;
      if (Math.abs(den) < 1e-9) return null;
      const s = (bb * e - c * d) / den, t = (a * e - bb * d) / den;
      return o1.clone().addScaledVector(d1, s).add(o2.clone().addScaledVector(d2, t)).multiplyScalar(0.5).toArray();
    }, r1, r2);
  }
  const state = () => p.evaluate(() => {
    const cam = camera.getWorldPosition(new THREE.Vector3()); const eye = scene.getObjectByName('player').localToWorld(new THREE.Vector3(0, 1.6, 0));
    return { pivot: gsOrbit.pivot(), rig: scene.getObjectByName('player').position.toArray(), far: camera.far, expectFar: gsRenderDistance.far + cam.distanceTo(eye) };
  });
  async function pivotCase(label, { behavioural = true } = {}) {
    const s0 = await state();
    const bp = behavioural ? await behaviouralPivot() : null;
    ok(`${T} orbit pivot at the scene origin: ${label}`, near0(s0.pivot) && (!behavioural || near0(bp, 0.02)), `api=${JSON.stringify(r3(s0.pivot))} measured=${bp ? JSON.stringify(r3(bp)) : '-'} rig=${JSON.stringify(r3(s0.rig))}`);
    const s1 = await state();
    ok(`${T} desktop render distance still matches VR: ${label}`, Math.abs(s1.far - s1.expectFar) < 0.05, `far=${s1.far.toFixed(2)} expected=${s1.expectFar.toFixed(2)}`);
  }
  // Orbit: pan the target off the origin with the stock arrow keys (OrbitControls.listenToKeyEvents).
  const walk = async () => { for (let i = 0; i < 15; i++) { await p.keyboard.down('ArrowLeft'); await sleep(20); await p.keyboard.up('ArrowLeft'); } await sleep(2000); }; // let OrbitControls damping settle

  // ---- Orbit pivot
  await pivotCase('first load');
  await walk(); const moved = await state();
  ok(`${T} arrow keys in Orbit pan the pivot (rig stays at the origin)`, !near0(moved.pivot) && near0(moved.rig), JSON.stringify(r3(moved.pivot)));
  { const bp = await behaviouralPivot(); const s2 = await state(); ok(`${T} after panning, Orbit still rotates around its own pivot (camera aims at it)`, bp && s2.pivot.every((v, i) => Math.abs(v - bp[i]) < 0.03), `api=${JSON.stringify(r3(s2.pivot))} measured=${JSON.stringify(r3(bp || []))}`); }
  await tab('scenes'); await p.click('[data-action="scenes:clear"]'); await sleep(800); await tab('chat');
  await pivotCase('after Clear scene');
  await walk();
  const input = await p.$('#scene-file-input'); await input.uploadFile(SCENE); await sleep(1500);
  ok(`${T} scene file loaded`, await p.evaluate(() => !!scene.getObjectByName('pivotBox')));
  await pivotCase('after loading a scene');
  await walk();
  await p.evaluate(() => document.getElementById('dchat-reset-camera').click()); await sleep(800); await tab('chat');
  await pivotCase('after Reset Camera View');
  await walk();
  await p.evaluate(() => { const mk = () => ({ id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) }); window.fakePad = mk(); navigator.getGamepads = () => [window.fakePad, null, null, null]; const ev = new Event('gamepadconnected'); ev.gamepad = window.fakePad; window.dispatchEvent(ev); });
  await sleep(400);
  await p.evaluate(() => { fakePad.buttons[8] = { pressed: true, touched: true, value: 1 }; }); await sleep(250); await p.evaluate(() => { fakePad.buttons[8] = { pressed: false, touched: false, value: 0 }; }); await sleep(800);
  await pivotCase('after the gamepad View button');
  await p.evaluate(() => { navigator.getGamepads = () => [null, null, null, null]; const ev = new Event('gamepaddisconnected'); ev.gamepad = window.fakePad; window.dispatchEvent(ev); }); await sleep(300);
  // ---- Twin sticks
  const sticks = () => p.evaluate(() => { const r = id => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, op: +getComputedStyle(e).opacity }; }; return { visible: gsTwinSticks.visible, root: !document.getElementById('gs-twin-sticks')?.hidden, left: r('gs-stick-left'), right: r('gs-stick-right'), dock: r('gs-dock'), chat: r('desktop-chat'), tabs: r('dchat-tabs') || null }; });
  let st = await sticks();
  ok(`${T} sticks hidden in Orbit`, !st.visible && !st.root, JSON.stringify({ v: st.visible }));
  await mode('firstperson'); await sleep(300);
  st = await sticks();
  ok(`${T} sticks shown in First person (default on)`, st.visible && st.root && st.left && st.left.r - st.left.l > 60, JSON.stringify(st.left));
  const ov = (a, c) => a && c && a.l < c.r && a.r > c.l && a.t < c.b && a.b > c.t;
  ok(`${T} sticks inside the viewport, in the bottom corners, clear of the dock and the chat panel`, [st.left, st.right].every(s => s.l >= 0 && s.r <= vp.width && s.b <= vp.height && s.t > vp.height / 2 && !ov(s, st.dock) && !ov(s, st.chat)) && st.left.r < vp.width / 2 && st.right.l > vp.width / 2, JSON.stringify(st));
  ok(`${T} sticks are minimal (low opacity, ≤ 100 px)`, [st.left, st.right].every(s => s.op <= 0.5 && s.r - s.l <= 100), `${st.left.op} ${st.right.op}`);
  await sleep(2900);
  const idleOp = (await sticks()).left.op;
  ok(`${T} sticks fade when idle`, idleOp <= 0.25, String(idleOp));
  if (vp.name === 'phone') await p.screenshot({ path: SHOT });
  // centres
  const C = s => [(s.l + s.r) / 2, (s.t + s.b) / 2]; const R = s => (s.r - s.l) / 2;
  const [Lx, Ly] = C(st.left), [Rx, Ry] = C(st.right), LR = R(st.left);
  const look = () => p.evaluate(() => { const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ'); return { yaw: e.y, pitch: e.x }; });
  const fwd = () => p.evaluate(() => { const d = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())); d.y = 0; return d.normalize().toArray(); });
  // First person moves the camera itself (PointerLockControls); the rig stays at the origin.
  const rigPos = () => p.evaluate(() => camera.getWorldPosition(new THREE.Vector3()).toArray());
  async function hold(points, ms) { // points: [[x0,y0,x1,y1,id]]
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points.map(([x, y, , , id]) => ({ x, y, id })) });
      for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points.map(([x, y, x1, y1, id]) => ({ x: x + (x1 - x) * i / 6, y: y + (y1 - y) * i / 6, id })) }); await sleep(16); }
      await sleep(ms);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      const [x, y, x1, y1] = points[0];
      await p.mouse.move(x, y); await p.mouse.down(); for (let i = 1; i <= 6; i++) { await p.mouse.move(x + (x1 - x) * i / 6, y + (y1 - y) * i / 6); await sleep(16); }
      await sleep(ms); await p.mouse.up();
    }
    await sleep(250);
  }
  const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  // left stick up = forward
  let p0 = await rigPos(); const f0 = await fwd(); const lk0 = await look();
  await hold([[Lx, Ly, Lx, Ly - LR * 1.5, 1]], 1000);
  let p1 = await rigPos(); let dv = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const lk1 = await look();
  ok(`${T} left stick up moves forward (~3 m/s), no turning`, dot(dv, f0) > 2 && dot(dv, f0) < 4.2 && Math.abs(lk1.yaw - lk0.yaw) < 1e-6, `forward=${dot(dv, f0).toFixed(2)} m`);
  p0 = p1;
  await hold([[Lx, Ly, Lx, Ly + LR * 1.5, 1]], 600);
  p1 = await rigPos(); dv = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  ok(`${T} left stick down moves back`, dot(dv, f0) < -1, `forward=${dot(dv, f0).toFixed(2)} m`);
  p0 = p1;
  await hold([[Lx, Ly, Lx + LR * 0.05, Ly - LR * 0.05, 1]], 400);
  p1 = await rigPos();
  ok(`${T} left stick deadzone (tiny drag does nothing)`, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) < 1e-6);
  ok(`${T} stick released: axes back to 0`, JSON.stringify(await p.evaluate(() => gsTwinSticks.axes())) === JSON.stringify({ lx: 0, ly: 0, rx: 0, ry: 0 }));
  // right stick: right = yaw right, up = pitch up
  let a0 = await look();
  await hold([[Rx, Ry, Rx + LR * 1.5, Ry, 2]], 400);
  let a1 = await look();
  ok(`${T} right stick right turns right (yaw), position unchanged`, a1.yaw < a0.yaw - 0.3 && Math.abs(a1.pitch - a0.pitch) < 0.05, `dyaw=${(a1.yaw - a0.yaw).toFixed(2)}`);
  a0 = a1;
  await hold([[Rx, Ry, Rx, Ry - LR * 1.5, 2]], 300);
  a1 = await look();
  ok(`${T} right stick up looks up (pitch)`, a1.pitch > a0.pitch + 0.2, `dpitch=${(a1.pitch - a0.pitch).toFixed(2)}`);
  if (touch) {
    p0 = await rigPos(); a0 = await look();
    await hold([[Lx, Ly, Lx, Ly - LR * 1.5, 1], [Rx, Ry, Rx - LR * 1.5, Ry, 2]], 700);
    p1 = await rigPos(); a1 = await look();
    ok(`${T} two fingers at once: move and look together`, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 1 && a1.yaw > a0.yaw + 0.3, `moved=${Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2)} dyaw=${(a1.yaw - a0.yaw).toFixed(2)}`);
  }
  // taps / clicks outside the sticks still reach the scene and the UI
  const spot = await canvasSpot();
  const hit = await p.evaluate(([x, y]) => document.elementFromPoint(x, y) === renderer.domElement, spot);
  const besideStick = await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [st.right.l - 12, (st.right.t + st.right.b) / 2]);
  await p.evaluate(() => { window.__canvasDowns = 0; renderer.domElement.addEventListener('pointerdown', () => window.__canvasDowns++); });
  if (touch) { await p.touchscreen.tap(spot[0], spot[1]); } else { await p.mouse.click(spot[0], spot[1]); }
  await sleep(200);
  if (!touch) { await p.evaluate(() => document.exitPointerLock?.()); await sleep(200); }
  ok(`${T} tap/click outside the sticks reaches the scene canvas`, hit && besideStick === 'CANVAS' && await p.evaluate(() => window.__canvasDowns >= 1), `beside=${besideStick}`);
  if (!touch) {
    // First person (PointerLockControls): clicking the scene next to the sticks locks the mouse.
    await p.mouse.click(spot[0], spot[1]); await sleep(300);
    ok(`${T} clicking the scene next to the sticks locks the mouse (First person)`, await p.evaluate(() => document.pointerLockElement === renderer.domElement));
    await p.evaluate(() => document.exitPointerLock?.()); await sleep(200);
  }
  await p.click('.dchat-tab[data-tab="scenes"]'); await sleep(250);
  ok(`${T} UI still clickable (Scenes tab opens)`, await p.evaluate(() => document.querySelector('.dchat-tab.active')?.dataset.tab === 'scenes'));
  // WASD in First person still works
  p0 = await rigPos(); await p.keyboard.down('KeyW'); await sleep(500); await p.keyboard.up('KeyW'); await sleep(400); p1 = await rigPos();
  ok(`${T} WASD still moves in First person`, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) > 0.5);
  // option to hide, saved
  await tab('controls');
  ok(`${T} Controls tab has the joystick option (checked)`, await p.evaluate(() => document.getElementById('dchat-twin-sticks')?.checked === true));
  await p.click('#dchat-twin-sticks'); await sleep(300);
  ok(`${T} unchecking hides the sticks`, !(await sticks()).visible);
  await p.reload({ waitUntil: 'networkidle2' }); await sleep(2500);
  ok(`${T} hidden choice saved across reload (still First person)`, await p.evaluate(() => !gsTwinSticks.visible && document.getElementById('dchat-twin-sticks').checked === false && document.querySelector('#dchat-camera-mode .active')?.dataset.cameraMode === 'firstperson'));
  await tab('controls'); await p.click('#dchat-twin-sticks'); await sleep(300); await tab('chat');
  ok(`${T} re-checking shows them again`, (await sticks()).visible);
  await mode('off');
  ok(`${T} sticks hidden in Off`, !(await sticks()).visible);
  await mode('firstperson');
  // VR hides them
  await p.click('#XRButton').catch(() => {});
  for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
  await sleep(800);
  ok(`${T} sticks hidden in VR`, await p.evaluate(() => renderer.xr.isPresenting) && !(await sticks()).visible);
  await p.evaluate(() => renderer.xr.getSession().end());
  for (let i = 0; i < 40 && (await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
  await sleep(800);
  ok(`${T} sticks back after leaving VR`, (await sticks()).visible);
  // First person walk then Orbit: pivot back on the origin
  await mode('orbit');
  ok(`${T} sticks hidden again in Orbit`, !(await sticks()).visible);
  await pivotCase('First person, then back to Orbit');
  ok(`${T} no console/page errors`, errs.length === 0, JSON.stringify(errs.slice(0, 4)));
  await p.close();
}
await b.close();
console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
