// Stock three.js camera controls (Orbit, Map, Trackball, Fly, First person, Off): headless, desktop + phone.
// BASE=https://localhost:3488 node test.mjs   (npm i: iwer + puppeteer-core; needs /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3488';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const SHOT = process.env.SHOT || new URL('./controls-phone.png', import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n} ${e}`); console.log(results.at(-1)); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const V = { sub: (a, c) => a.map((v, i) => v - c[i]), len: a => Math.hypot(...a), dot: (a, c) => a.reduce((s, v, i) => s + v * c[i], 0) };
const f2 = a => JSON.stringify(a.map(v => +(+v).toFixed(2)));
const MODES = ['orbit', 'map', 'trackball', 'fly', 'firstperson', 'off'];

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
  await p.reload({ waitUntil: 'networkidle2' }); await sleep(2500);
  const cdp = await p.createCDPSession();
  const tab = async (t) => { await p.click(`.dchat-tab[data-tab="${t}"]`); await sleep(200); };
  // Real clicks on the Controls-tab buttons (focus stays on the button afterwards).
  const mode = async (m) => { await tab('controls'); await p.click(`#dchat-camera-mode [data-camera-mode="${m}"]`); await sleep(350); };
  const st = () => p.evaluate(() => {
    const cam = camera.getWorldPosition(new THREE.Vector3()); const q = camera.getWorldQuaternion(new THREE.Quaternion());
    const eye = scene.getObjectByName('player').localToWorld(new THREE.Vector3(0, 1.6, 0));
    return { mode: gsControls.mode, cam: cam.toArray(), dir: new THREE.Vector3(0, 0, -1).applyQuaternion(q).toArray(), right: new THREE.Vector3(1, 0, 0).applyQuaternion(q).toArray(), up: new THREE.Vector3(0, 1, 0).applyQuaternion(q).toArray(),
      target: gsOrbit.pivot(), enabled: !!gsControls.controls?.enabled, cls: gsControls.controls?.constructor?.name || null, same: window.controls === gsControls.controls,
      locked: document.pointerLockElement === renderer.domElement, far: camera.far, expectFar: gsRenderDistance.far + cam.distanceTo(eye), active: document.activeElement?.tagName };
  });
  const canvasSpot = () => p.evaluate(() => { const c = renderer.domElement; const no = [...document.querySelectorAll('.gs-stick')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect()); for (let y = 0.8; y > 0.2; y -= 0.03) for (let x = 0.35; x < 0.95; x += 0.03) { const X = innerWidth * x, Y = innerHeight * y; if (document.elementFromPoint(X, Y) === c && !no.some(r => X > r.left - 20 && X < r.right + 20 && Y > r.top - 20 && Y < r.bottom + 20)) return [X, Y]; } return null; });
  async function drag(dx, dy, { button = 'left', steps = 10 } = {}) {
    const [x, y] = await canvasSpot();
    if (touch && button === 'left') { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }); for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps, id: 1 }] }); await sleep(16); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
    else { await p.mouse.move(x, y); await p.mouse.down({ button }); for (let i = 1; i <= steps; i++) { await p.mouse.move(x + dx * i / steps, y + dy * i / steps); await sleep(16); } await p.mouse.up({ button }); }
    await sleep(700);
  }
  async function pinch(spread) { // two fingers apart (spread > 0) or together
    const [x, y] = await canvasSpot(); const a = 40, n = 10;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - a, y, id: 1 }, { x: x + a, y, id: 2 }] });
    for (let i = 1; i <= n; i++) { const d = a + spread * i / n; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - d, y, id: 1 }, { x: x + d, y, id: 2 }] }); await sleep(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(700);
  }
  const wheel = async (deltaY) => { const [x, y] = await canvasSpot(); await p.mouse.move(x, y); for (let i = 0; i < 5; i++) { await p.mouse.wheel({ deltaY: deltaY / 5 }); await sleep(30); } await sleep(700); };
  const hold = async (code, ms = 600) => { await p.keyboard.down(code); await sleep(ms); await p.keyboard.up(code); await sleep(400); };
  const taps = async (code, n = 15) => { for (let i = 0; i < n; i++) { await p.keyboard.down(code); await sleep(20); await p.keyboard.up(code); } await sleep(600); };
  const dist = s => V.len(V.sub(s.cam, s.target));
  const moved = (a, c) => V.len(V.sub(c.cam, a.cam));
  const turned = (a, c) => V.len(V.sub(c.dir, a.dir));
  const farOk = async (label) => { const s = await st(); ok(`${T} ${label}: desktop far = VR far + camera offset from the VR eye`, Math.abs(s.far - s.expectFar) < 0.05, `far=${s.far.toFixed(2)} expected=${s.expectFar.toFixed(2)}`); };

  // ---- defaults
  let s = await st();
  ok(`${T} default is Orbit (OrbitControls) at (0,1.6,4) around the origin`, s.mode === 'orbit' && s.cls === 'OrbitControls' && f2(s.cam) === '[0,1.6,4]' && f2(s.target) === '[0,0,0]' && s.enabled, JSON.stringify({ m: s.mode, c: s.cls, cam: f2(s.cam) }));
  ok(`${T} page load: camera.position (local) and world position both at eye height y = 1.6 (quaternion x ≈ -0.189 is the downward look at the origin, not a height)`, await p.evaluate(() => Math.abs(camera.position.y - 1.6) < 1e-6 && Math.abs(camera.getWorldPosition(new THREE.Vector3()).y - 1.6) < 1e-6 && Math.abs(camera.quaternion.x + 0.1891) < 1e-3));
  ok(`${T} window.controls and gsControls.controls are the active stock control`, s.same && await p.evaluate(() => gsControls.modes.join() === 'orbit,map,trackball,fly,firstperson,off'));
  await tab('controls');
  const btns = await p.evaluate(() => [...document.querySelectorAll('#dchat-camera-mode [data-camera-mode]')].map(e => e.dataset.cameraMode + ':' + e.textContent.trim()));
  ok(`${T} Controls tab offers Orbit, Map, Trackball, Fly, First person, Off`, btns.join() === 'orbit:Orbit,map:Map,trackball:Trackball,fly:Fly,firstperson:First person,off:Off', btns.join());
  const helpKeys = await p.evaluate(() => Object.fromEntries(['orbit', 'map', 'trackball', 'fly', 'firstperson'].map(m => [m, document.querySelector(`[data-camera-help="${m}"]`)?.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)])));
  ok(`${T} each mode has its stock key list`, Object.values(helpKeys).every(Boolean) && /OrbitControls/.test(helpKeys.orbit) && /PointerLockControls/.test(helpKeys.firstperson), JSON.stringify(helpKeys));
  // layout: buttons don't overflow the panel
  const lay = await p.evaluate(() => { const g = document.getElementById('dchat-camera-mode').getBoundingClientRect(); return [...document.querySelectorAll('#dchat-camera-mode .dchat-btn')].every(e => { const r = e.getBoundingClientRect(); return r.left >= g.left - 1 && r.right <= g.right + 1 && e.scrollWidth <= e.clientWidth + 1; }); });
  ok(`${T} mode buttons fit (no overflow)`, lay);
  if (touch) { await p.screenshot({ path: SHOT }); }

  // ---- Orbit
  await mode('orbit'); await tab('chat');
  let a = await st(); await drag(120, 0); let c = await st();
  ok(`${T} Orbit: ${touch ? 'one-finger' : 'left'} drag rotates around the target`, moved(a, c) > 0.5 && Math.abs(dist(a) - dist(c)) < 0.1 && f2(c.target) === f2(a.target), `${f2(a.cam)} -> ${f2(c.cam)}`);
  a = c;
  if (touch) { await pinch(80); c = await st(); ok(`${T} Orbit: pinch zooms`, Math.abs(dist(c) - dist(a)) > 0.3, `${dist(a).toFixed(2)} -> ${dist(c).toFixed(2)}`); }
  else {
    await wheel(-400); c = await st(); ok(`${T} Orbit: wheel zooms in`, dist(c) < dist(a) - 0.3, `${dist(a).toFixed(2)} -> ${dist(c).toFixed(2)}`);
    a = c; await taps('ArrowLeft'); c = await st(); ok(`${T} Orbit: arrow keys pan (listenToKeyEvents)`, V.len(V.sub(c.target, a.target)) > 0.1, `target ${f2(a.target)} -> ${f2(c.target)}`);
    a = c; await drag(-80, 0, { button: 'right' }); c = await st(); ok(`${T} Orbit: right-drag pans`, V.len(V.sub(c.target, a.target)) > 0.1, `target -> ${f2(c.target)}`);
  }
  await farOk('Orbit');
  await tab('env'); await p.evaluate(() => document.getElementById('dchat-reset-camera').scrollIntoView()); await p.click('#dchat-reset-camera'); await sleep(500); c = await st();
  ok(`${T} Reset Camera View: default position, target at the origin`, f2(c.cam) === '[0,1.6,4]' && f2(c.target) === '[0,0,0]' && c.mode === 'orbit', `${f2(c.cam)} ${f2(c.target)}`);

  // ---- Map
  await mode('map'); await tab('chat'); s = await st();
  ok(`${T} Map uses MapControls, target at the origin, camera kept at eye height (y = 1.6)`, s.cls === 'MapControls' && f2(s.target) === '[0,0,0]' && Math.abs(s.cam[1] - 1.6) < 1e-6, `${s.cls} cam ${f2(s.cam)}`);
  a = s; await drag(100, 60); c = await st();
  ok(`${T} Map: ${touch ? 'one-finger' : 'left'} drag pans over the ground (camera height unchanged)`, V.len(V.sub(c.target, a.target)) > 0.2 && Math.abs(c.target[1]) < 1e-6 && Math.abs(c.cam[1] - a.cam[1]) < 1e-3, `target -> ${f2(c.target)} cam y ${c.cam[1].toFixed(3)}`);
  if (!touch) {
    a = c; await drag(120, 0, { button: 'right' }); c = await st(); ok(`${T} Map: right-drag rotates`, turned(a, c) > 0.1 && Math.abs(dist(a) - dist(c)) < 0.1);
    a = c; await wheel(-400); c = await st(); ok(`${T} Map: wheel zooms`, dist(c) < dist(a) - 0.3);
    a = c; await taps('ArrowUp'); c = await st(); ok(`${T} Map: arrow keys pan`, V.len(V.sub(c.target, a.target)) > 0.1, `target -> ${f2(c.target)}`);
  } else { a = c; await pinch(80); c = await st(); ok(`${T} Map: pinch zooms`, Math.abs(dist(c) - dist(a)) > 0.3); }
  await farOk('Map');

  // ---- Trackball
  await mode('trackball'); await tab('chat'); s = await st();
  ok(`${T} Trackball uses TrackballControls`, s.cls === 'TrackballControls' && f2(s.target) === '[0,0,0]');
  a = s; await drag(120, 40); c = await st();
  ok(`${T} Trackball: ${touch ? 'one-finger' : 'left'} drag rotates`, moved(a, c) > 0.3 && Math.abs(dist(a) - dist(c)) < 0.2, `${f2(a.cam)} -> ${f2(c.cam)}`);
  if (!touch) {
    a = c; await wheel(-400); c = await st(); ok(`${T} Trackball: wheel zooms`, Math.abs(dist(c) - dist(a)) > 0.2, `${dist(a).toFixed(2)} -> ${dist(c).toFixed(2)}`);
    a = c; await drag(-80, 0, { button: 'right' }); c = await st(); ok(`${T} Trackball: right-drag pans`, V.len(V.sub(c.target, a.target)) > 0.05, `target -> ${f2(c.target)}`);
  }
  await farOk('Trackball');

  // ---- Fly
  await mode('fly'); s = await st();
  ok(`${T} Fly uses FlyControls, keys work with the mode button focused`, s.cls === 'FlyControls' && s.active === 'BUTTON', s.active);
  a = s; await hold('KeyW'); c = await st();
  ok(`${T} Fly: W flies forward`, V.dot(V.sub(c.cam, a.cam), a.dir) > 0.8, `moved ${moved(a, c).toFixed(2)}`);
  a = c; await hold('KeyD'); c = await st();
  ok(`${T} Fly: D moves right`, V.dot(V.sub(c.cam, a.cam), a.right) > 0.8, `right ${V.dot(V.sub(c.cam, a.cam), a.right).toFixed(2)}`);
  a = c; await hold('KeyA'); c = await st();
  ok(`${T} Fly: A moves left`, V.dot(V.sub(c.cam, a.cam), a.right) < -0.8);
  a = c; await hold('KeyR'); c = await st();
  ok(`${T} Fly: R moves up`, V.dot(V.sub(c.cam, a.cam), a.up) > 0.8);
  a = c; await hold('ArrowLeft', 500); c = await st();
  ok(`${T} Fly: arrow keys turn (yaw)`, turned(a, c) > 0.1);
  a = c; await hold('KeyQ', 500); c = await st();
  ok(`${T} Fly: Q rolls`, V.len(V.sub(c.up, a.up)) > 0.1);
  a = c; await tab('chat'); { const [x, y] = await canvasSpot(); if (touch) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }); for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 8 * i, y, id: 1 }] }); await sleep(40); } await sleep(300); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); } else { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 1; i <= 10; i++) { await p.mouse.move(x + 20 * i, y); await sleep(40); } await sleep(300); await p.mouse.up(); } await sleep(400); }
  c = await st(); ok(`${T} Fly: drag to look`, turned(a, c) > 0.05, turned(a, c).toFixed(3));
  // Regression (real-browser report on PR #9): a ~110 px left-drag around the canvas centre,
  // sent as raw CDP mouse events (buttons=1), left the view unchanged, because stock
  // FlyControls turns at a rate set by the pointer's offset from the canvas centre.
  const yawOf = d => Math.atan2(-d[0], -d[2]);
  async function rawDrag(x0, y0, dx, dy, { steps = 8, gap = 0 } = {}) {
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 7 }] });
      for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx * i / steps, y: y0 + dy * i / steps, id: 7 }] }); if (gap) await sleep(gap); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + dx * i / steps, y: y0 + dy * i / steps, button: 'left', buttons: 1 }); if (gap) await sleep(gap); }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button: 'left', buttons: 0, clickCount: 1 });
    }
    await sleep(300);
  }
  {
    await p.evaluate(() => gsControls.reset()); await sleep(200);
    // A free canvas row near the vertical centre, drag centred on the canvas centre.
    const cy = await p.evaluate(() => { const c = renderer.domElement, r = c.getBoundingClientRect(), x = r.left + r.width / 2; for (let d = 0; d < r.height / 2; d += 10) for (const y of [r.top + r.height / 2 - d, r.top + r.height / 2 + d]) if ([-60, 0, 60].every(o => document.elementFromPoint(x + o, y) === c)) return [x, y]; return null; });
    if (!cy) ok(`${T} Fly: free canvas centre for the raw drag`, false);
    else {
      a = await st(); await rawDrag(cy[0] - 55, cy[1], 110, 0, { gap: 16 }); c = await st();
      const dyaw = yawOf(c.dir) - yawOf(a.dir);
      ok(`${T} Fly: raw ${touch ? 'touch' : 'CDP mouse (buttons=1)'} 110 px drag across the centre turns the view right`, dyaw < -0.3 && Math.abs(c.cam[1] - a.cam[1]) < 1e-6, `yaw ${dyaw.toFixed(3)} rad`);
      a = c; await rawDrag(cy[0] + 55, cy[1], -110, 0); c = await st();
      ok(`${T} Fly: a quick (same-frame) drag back turns it back`, Math.abs(yawOf(c.dir) - yawOf(a.dir) - 0.44) < 0.05, `yaw ${(yawOf(c.dir) - yawOf(a.dir)).toFixed(3)}`);
      a = c; await rawDrag(cy[0], cy[1], 0, 60, { gap: 16 }); c = await st();
      ok(`${T} Fly: dragging down pitches down`, c.dir[1] < a.dir[1] - 0.15, `${a.dir[1].toFixed(2)} -> ${c.dir[1].toFixed(2)}`);
      a = c; await sleep(500); c = await st();
      ok(`${T} Fly: the view stops turning after release`, turned(a, c) < 1e-6);
      const panel = await p.evaluate(() => { const r = document.getElementById('desktop-chat').getBoundingClientRect(); return [r.left + 30, r.top + 60]; });
      a = c; await rawDrag(panel[0], panel[1], 110, 0, { gap: 16 }); c = await st();
      ok(`${T} Fly: dragging on a panel does not turn the view`, turned(a, c) < 1e-6);
    }
  }
  await farOk('Fly');

  // ---- First person
  await mode('firstperson'); s = await st();
  ok(`${T} First person uses PointerLockControls`, s.cls === 'PointerLockControls');
  const horiz = v => { const h = [v[0], 0, v[2]]; const l = V.len(h) || 1; return h.map(x => x / l); };
  a = s; await hold('KeyD'); c = await st();
  ok(`${T} First person: D moves right (with the mode button focused)`, V.dot(V.sub(c.cam, a.cam), horiz(a.right)) > 0.8 && Math.abs(c.cam[1] - a.cam[1]) < 1e-6 && a.active === 'BUTTON', `right ${V.dot(V.sub(c.cam, a.cam), horiz(a.right)).toFixed(2)}`);
  a = c; await hold('KeyW'); c = await st();
  ok(`${T} First person: W moves forward on the ground plane`, V.dot(V.sub(c.cam, a.cam), horiz(a.dir)) > 0.8 && Math.abs(c.cam[1] - a.cam[1]) < 1e-6);
  a = c; await hold('KeyS'); c = await st(); ok(`${T} First person: S moves back`, V.dot(V.sub(c.cam, a.cam), horiz(a.dir)) < -0.8);
  a = c; await hold('KeyA'); c = await st(); ok(`${T} First person: A moves left`, V.dot(V.sub(c.cam, a.cam), horiz(a.right)) < -0.8);
  a = c; await hold('ArrowRight'); c = await st(); ok(`${T} First person: arrow keys move too`, V.dot(V.sub(c.cam, a.cam), horiz(a.right)) > 0.8);
  // twin-sticks checkbox focused: keys still work
  await p.click('#dchat-twin-sticks'); await p.click('#dchat-twin-sticks'); await sleep(200);
  a = await st(); await hold('KeyD'); c = await st();
  ok(`${T} keys still work with a checkbox focused`, a.active === 'INPUT' && V.dot(V.sub(c.cam, a.cam), horiz(a.right)) > 0.8, a.active);
  await farOk('First person');
  if (!touch) {
    await tab('chat');
    const [x, y] = await canvasSpot(); await p.mouse.click(x, y); await sleep(400);
    c = await st(); ok(`${T} First person: clicking the scene locks the mouse`, c.locked);
    a = c; for (let i = 0; i < 10; i++) { await p.mouse.move(x + 15 * i, y + 3 * i); await sleep(16); } await sleep(200); c = await st();
    ok(`${T} First person: mouse look while locked`, turned(a, c) > 0.05, turned(a, c).toFixed(3));
    await p.keyboard.press('Escape'); await sleep(400);
    let unlocked = !(await st()).locked; let via = 'Esc';
    if (!unlocked) { await p.evaluate(() => document.exitPointerLock()); await sleep(300); unlocked = !(await st()).locked; via = 'exitPointerLock (headless Chrome does not route Esc to pointer lock)'; }
    ok(`${T} First person: unlock (${via})`, unlocked);
    await tab('scenes'); const scenesOpen = await p.evaluate(() => document.querySelector('.dchat-tab.active')?.dataset.tab === 'scenes');
    ok(`${T} after unlocking, the panels are clickable and clicking them does not re-lock`, scenesOpen && !(await st()).locked);
    await tab('chat'); await p.click('#desktop-chat-messages').catch(() => {}); await sleep(300);
    ok(`${T} clicking inside the chat panel does not lock`, !(await st()).locked);
    // immediate re-click on the scene: the browser may refuse; never a console error
    await p.mouse.click(x, y); await sleep(500); await p.evaluate(() => document.exitPointerLock()); await sleep(300);
  }

  // ---- typing never moves the camera
  for (const m of ['orbit', 'fly', 'firstperson']) {
    await mode(m); await tab('chat');
    await p.evaluate(() => { const i = document.getElementById('desktop-chat-input'); i.value = ''; });
    await p.click('#desktop-chat-input'); a = await st();
    await p.keyboard.type('wasd dwr'); for (const k of ['KeyD', 'KeyW', 'ArrowLeft', 'ArrowUp']) { await p.keyboard.down(k); await sleep(250); await p.keyboard.up(k); }
    await sleep(400); c = await st();
    const val = await p.evaluate(() => document.getElementById('desktop-chat-input').value);
    ok(`${T} ${m}: typing in chat (WASD, arrows) does not move the camera`, moved(a, c) < 1e-6 && turned(a, c) < 1e-6 && val.startsWith('wasd dwr') && !c.enabled, `moved=${moved(a, c).toFixed(4)} val=${JSON.stringify(val)}`);
    await p.evaluate(() => { const i = document.getElementById('desktop-chat-input'); i.value = ''; i.blur(); }); await sleep(100);
    ok(`${T} ${m}: controls back on after leaving the text field`, (await st()).enabled);
  }
  // select: focus blocks keys; picking an option hands focus back
  await mode('firstperson'); await tab('chat');
  await p.evaluate(() => document.getElementById('desktop-model-select').focus()); a = await st(); await hold('KeyD', 300); c = await st();
  const selBlock = moved(a, c) < 1e-6;
  await p.evaluate(() => { const s = document.getElementById('desktop-model-select'); s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(200);
  a = await st(); await hold('KeyD'); c = await st();
  ok(`${T} a focused <select> holds the keys; after a change it gives them back`, selBlock && a.active !== 'SELECT' && moved(a, c) > 0.5, JSON.stringify({ selBlock, active: a.active, moved: moved(a, c).toFixed(2) }));

  // ---- Off
  await mode('off'); await tab('chat'); s = await st(); a = s;
  await drag(120, 0); if (!touch) await wheel(-300); await hold('KeyD'); await taps('ArrowLeft', 5); c = await st();
  ok(`${T} Off: no control, nothing moves the camera`, s.cls === null && moved(a, c) < 1e-6 && turned(a, c) < 1e-6);

  // ---- listener leak
  const listenerCounts = async () => { const out = {}; for (const expr of ['window', 'document', 'renderer.domElement']) { const { result } = await cdp.send('Runtime.evaluate', { expression: expr }); const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }); out[expr] = listeners.length; } return out; };
  await p.evaluate(() => gsControls.setMode('orbit')); await sleep(100);
  const l0 = await listenerCounts();
  for (let k = 0; k < 3; k++) for (const m of MODES) { await p.evaluate(m => gsControls.setMode(m), m); await sleep(30); }
  await p.evaluate(() => gsControls.setMode('orbit')); await sleep(100);
  const l1 = await listenerCounts();
  ok(`${T} switching modes 18 times leaks no listeners`, JSON.stringify(l0) === JSON.stringify(l1), `${JSON.stringify(l0)} -> ${JSON.stringify(l1)}`);

  // ---- joysticks: only First person and Fly
  const vis = {}; for (const m of MODES) { await p.evaluate(m => gsControls.setMode(m), m); await sleep(80); vis[m] = await p.evaluate(() => gsTwinSticks.visible); }
  ok(`${T} on-screen joysticks only in Fly and First person`, JSON.stringify(vis) === JSON.stringify({ orbit: false, map: false, trackball: false, fly: true, firstperson: true, off: false }), JSON.stringify(vis));
  const stickRect = id => p.evaluate(id => { const r = document.getElementById(id).getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2, r.width / 2]; }, id);
  async function stickHold(list, ms) { // list of [stickId, dx, dy, pointerId]
    const pts = []; for (const [id, dx, dy, pid] of list) { const [x, y, r] = await stickRect(id); pts.push([x, y, x + dx * r, y + dy * r, pid]); }
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts.map(([x, y, , , id]) => ({ x, y, id })) });
      for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts.map(([x, y, x1, y1, id]) => ({ x: x + (x1 - x) * i / 6, y: y + (y1 - y) * i / 6, id })) }); await sleep(16); }
      await sleep(ms); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else { const [x, y, x1, y1] = pts[0]; await p.mouse.move(x, y); await p.mouse.down(); for (let i = 1; i <= 6; i++) { await p.mouse.move(x + (x1 - x) * i / 6, y + (y1 - y) * i / 6); await sleep(16); } await sleep(ms); await p.mouse.up(); }
    await sleep(300);
  }
  for (const m of ['firstperson', 'fly']) {
    await p.evaluate(m => { gsControls.setMode(m); gsControls.reset(); }, m); await sleep(200);
    a = await st(); await stickHold([['gs-stick-left', 0, -1.5, 1]], 800); c = await st();
    const fwd = m === 'fly' ? a.dir : horiz(a.dir);
    ok(`${T} ${m}: left joystick up moves forward`, V.dot(V.sub(c.cam, a.cam), fwd) > 1, V.dot(V.sub(c.cam, a.cam), fwd).toFixed(2));
    a = c; await stickHold([['gs-stick-left', 1.5, 0, 1]], 600); c = await st();
    ok(`${T} ${m}: left joystick right strafes right`, V.dot(V.sub(c.cam, a.cam), m === 'fly' ? a.right : horiz(a.right)) > 0.6);
    a = c; await stickHold([['gs-stick-right', 1.5, 0, 2]], 500); c = await st();
    ok(`${T} ${m}: right joystick looks around`, turned(a, c) > 0.2 && moved(a, c) < 0.05, turned(a, c).toFixed(2));
    if (touch) { a = c; await stickHold([['gs-stick-left', 0, -1.5, 1], ['gs-stick-right', -1.5, 0, 2]], 600); c = await st(); ok(`${T} ${m}: both joysticks at once`, moved(a, c) > 0.5 && turned(a, c) > 0.2); }
    a = c; await stickHold([['gs-stick-left', 0.05, -0.05, 1]], 300); c = await st();
    ok(`${T} ${m}: joystick deadzone`, moved(a, c) < 1e-6);
  }

  // ---- gamepad (fake standard pad)
  if (!touch) {
    await p.evaluate(() => { const mk = () => ({ id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) }); window.fakePad = mk(); navigator.getGamepads = () => [window.fakePad, null, null, null]; const ev = new Event('gamepadconnected'); ev.gamepad = window.fakePad; window.dispatchEvent(ev); });
    await sleep(300);
    const pad = async (fn, ms = 500) => { await p.evaluate(fn); await sleep(ms); await p.evaluate(() => { fakePad.axes = [0, 0, 0, 0]; fakePad.buttons.forEach((b, i) => fakePad.buttons[i] = { pressed: false, touched: false, value: 0 }); }); await sleep(250); };
    const btn = async (i) => { await p.evaluate(i => { fakePad.buttons[i] = { pressed: true, touched: true, value: 1 }; }, i); await sleep(200); await p.evaluate(i => { fakePad.buttons[i] = { pressed: false, touched: false, value: 0 }; }, i); await sleep(300); };
    await p.evaluate(() => { gsControls.setMode('orbit'); gsControls.reset(); }); await sleep(300);
    a = await st(); await pad(() => { fakePad.axes[2] = 1; }); c = await st();
    ok(`${T} gamepad Orbit: right stick orbits (distance kept)`, moved(a, c) > 0.3 && Math.abs(dist(a) - dist(c)) < 0.1);
    a = c; await pad(() => { fakePad.buttons[7] = { pressed: true, value: 1 }; }); c = await st();
    ok(`${T} gamepad Orbit: RT zooms in`, dist(c) < dist(a) - 0.2, `${dist(a).toFixed(2)} -> ${dist(c).toFixed(2)}`);
    await p.evaluate(() => gsControls.setMode('map')); await sleep(200);
    a = await st(); await pad(() => { fakePad.axes[0] = 1; }); c = await st();
    ok(`${T} gamepad Map: left stick pans`, V.len(V.sub(c.target, a.target)) > 0.2);
    await p.evaluate(() => gsControls.setMode('trackball')); await sleep(200);
    a = await st(); await pad(() => { fakePad.axes[0] = 1; fakePad.axes[2] = 1; }); c = await st();
    ok(`${T} gamepad Trackball: sticks not used`, moved(a, c) < 1e-3);
    await p.evaluate(() => { gsControls.setMode('fly'); gsControls.reset(); }); await sleep(200);
    a = await st(); await pad(() => { fakePad.axes[1] = -1; }); c = await st();
    ok(`${T} gamepad Fly: left stick forward`, V.dot(V.sub(c.cam, a.cam), a.dir) > 0.8);
    a = c; await pad(() => { fakePad.buttons[5] = { pressed: true, value: 1 }; }); c = await st();
    ok(`${T} gamepad Fly: RB up`, V.dot(V.sub(c.cam, a.cam), a.up) > 0.5);
    await p.evaluate(() => { gsControls.setMode('firstperson'); gsControls.reset(); }); await sleep(200);
    a = await st(); await pad(() => { fakePad.axes[0] = 1; }); c = await st();
    ok(`${T} gamepad First person: left stick right strafes right`, V.dot(V.sub(c.cam, a.cam), horiz(a.right)) > 0.8);
    a = c; await pad(() => { fakePad.axes[2] = 1; }, 400); c = await st();
    ok(`${T} gamepad First person: right stick looks (PointerLockControls look)`, turned(a, c) > 0.3);
    await btn(3); ok(`${T} gamepad Y: First person -> Orbit`, (await st()).mode === 'orbit');
    await btn(3); ok(`${T} gamepad Y: Orbit -> First person`, (await st()).mode === 'firstperson');
    await hold('KeyW'); await btn(8); c = await st();
    ok(`${T} gamepad View resets the view`, f2(c.cam) === '[0,1.6,4]');
    await p.evaluate(() => { navigator.getGamepads = () => [null, null, null, null]; const ev = new Event('gamepaddisconnected'); ev.gamepad = window.fakePad; window.dispatchEvent(ev); }); await sleep(200);
  }

  // ---- VR: controls off, sticks hidden; leaving VR = default desktop view
  await p.evaluate(() => gsControls.setMode('firstperson')); await sleep(200); await hold('KeyW');
  await p.click('#XRButton').catch(() => {});
  for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
  await sleep(800);
  s = await st();
  ok(`${T} in VR the desktop control is disabled and the joysticks hidden`, await p.evaluate(() => renderer.xr.isPresenting) && !s.enabled && !(await p.evaluate(() => gsTwinSticks.visible)));
  await p.evaluate(() => gsControls.setMode('orbit')); await sleep(200);
  await p.evaluate(() => renderer.xr.getSession().end());
  for (let i = 0; i < 40 && (await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
  await sleep(600); c = await st();
  ok(`${T} leaving VR returns to the default desktop view (Orbit at (0,1.6,4) facing the origin)`, f2(c.cam) === '[0,1.6,4]' && f2(c.target) === '[0,0,0]' && c.enabled && c.dir[2] < -0.9, `${f2(c.cam)} dir ${f2(c.dir)}`);
  await farOk('after VR');

  // ---- saved values from 0.976 and earlier
  const legacy = {};
  for (const [saved, want] of [['free', 'firstperson'], ['orbit', 'orbit'], ['off', 'off'], ['map', 'map'], ['bogus', 'orbit']]) {
    await p.evaluate(v => localStorage.setItem('gs.cameraControlMode', v), saved);
    await p.reload({ waitUntil: 'networkidle2' }); await sleep(1500);
    legacy[saved] = await p.evaluate(() => [gsControls.mode, localStorage.getItem('gs.cameraControlMode'), +camera.getWorldPosition(new THREE.Vector3()).y.toFixed(3)]);
    if (legacy[saved][2] !== 1.6) legacy[saved].push('WANT y 1.6');
    if (legacy[saved][0] !== want) legacy[saved].push('WANT ' + want);
  }
  ok(`${T} page load in every saved mode starts at eye height (y = 1.6)`, Object.values(legacy).every(v => v[2] === 1.6), JSON.stringify(legacy));
  ok(`${T} old saved modes map orbit→Orbit, free→First person, off→Off (and are rewritten)`, legacy.free.slice(0, 2).join() === 'firstperson,firstperson' && legacy.orbit[0] === 'orbit' && legacy.off[0] === 'off' && legacy.map[0] === 'map' && legacy.bogus[0] === 'orbit', JSON.stringify(legacy));
  await p.evaluate(() => localStorage.removeItem('gs.cameraControlMode'));
  ok(`${T} no console/page errors`, errs.length === 0, JSON.stringify(errs.slice(0, 4)));
  await p.close();
}
await b.close();
console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
