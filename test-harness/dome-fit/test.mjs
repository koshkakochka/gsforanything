// Sky / HDRI domes and render distance fit the whole scene (site-source/sceneFit.js)
// and the scene prompts tell the AI to do the same.
// BASE=http://localhost:3611 SHOTS=/tmp/domefit-shots node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3611';
const SHOTS = process.env.SHOTS || '';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : e}`); console.log(results.at(-1)); };
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// 1. Prompts (served and generated Worker copy)
const pr = await (await fetch(BASE + '/api/prompts')).json();
const worker = await import(new URL('../../worker/prompts.js', import.meta.url).href);
const sys = pr.systemPrompt;
ok('system prompt has the sky dome / render distance section', /## Sky domes, HDRI backgrounds and render distance/.test(sys));
ok('system prompt: dome tagged userData.gsHdriDome and sized from the full scene bounds (Box3, radius × 1.5)', /userData\.gsHdriDome = true/.test(sys) && /full scene bounds/.test(sys) && /Box3/.test(sys) && /× 1\.5/.test(sys));
ok('system prompt: refit when objects are added / moved', /Refit whenever objects are added, moved or removed/.test(sys));
ok('system prompt: GroundedSkybox keeps its floor at y = 0', /GroundedSkybox keeps its floor at y = 0/.test(sys));
ok('system prompt: camera.far reaches everything incl. the dome + updateProjectionMatrix', /camera\.far` must reach the far side of everything, the dome included/.test(sys) && /updateProjectionMatrix/.test(sys));
ok('system prompt: VR depthNear/depthFar note', /depthNear\/depthFar/.test(sys));
ok('system prompt: fog must not hide objects; no distance culling', /Fog must not hide objects/.test(sys) && /Don't hide, cull or drop objects by distance/.test(sys));
ok('system prompt: gsFitScene() helper + code example', /gsFitScene\(\)/.test(sys) && /```vr-exec\nconst tex = await new THREE\.TextureLoader/.test(sys));
ok('custom-prompt required section has the dome / far rule', /userData\.gsHdriDome = true/.test(pr.chatPromptRequired) && /camera\.far/.test(pr.chatPromptRequired) && /gsFitScene\(\)/.test(pr.chatPromptRequired));
ok('fix-code prompt keeps gsFitScene calls', /gsFitScene\(\)/.test(pr.fixCodePrompt));
ok('worker/prompts.js is regenerated (matches server.js)', worker.SYSTEM_PROMPT === sys && worker.CHAT_PROMPT_REQUIRED === pr.chatPromptRequired && worker.FIX_CODE_PROMPT === pr.fixCodePrompt);

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); const errs = [];
p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
await p.setViewport({ width: 1280, height: 800 });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(3000);
await p.evaluate(() => { gsControls.setMode('off'); });

// Helpers in the page
await p.evaluate(() => {
  window.__t = {
    sky(name, radius, { tag = false, side = THREE.BackSide } = {}) {
      const c = document.createElement('canvas'); c.width = 512; c.height = 256; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, '#1e3a8a'); gr.addColorStop(0.5, '#60a5fa'); gr.addColorStop(0.52, '#a16207'); gr.addColorStop(1, '#3f2a0b');
      g.fillStyle = gr; g.fillRect(0, 0, 512, 256); g.strokeStyle = 'rgba(255,255,255,0.35)';
      for (let x = 0; x <= 512; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke(); }
      for (let y = 0; y <= 256; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), new THREE.MeshBasicMaterial({ map: tex, side, depthWrite: false }));
      m.name = name; if (tag) m.userData.gsHdriDome = true; scene.add(m); return m;
    },
    box(name, x, y, z, size = 8, color = 0xff00ff) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial({ color })); m.name = name; m.position.set(x, y, z); scene.add(m); return m;
    },
    // every bbox corner of `names` inside dome's world sphere?
    inside(domeName, names) {
      const d = scene.getObjectByName(domeName); d.updateWorldMatrix(true, false);
      const g = d.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center.clone().applyMatrix4(d.matrixWorld); const r = g.boundingSphere.radius * d.matrixWorld.getMaxScaleOnAxis();
      let worst = 0;
      for (const n of names) { const o = scene.getObjectByName(n); const bb = new THREE.Box3().setFromObject(o);
        for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) worst = Math.max(worst, c.distanceTo(new THREE.Vector3(x, y, z))); }
      return { r, worst, inside: worst < r, center: c.toArray() };
    },
    // camera far covers the far side of the dome and of every object?
    farCovers(names, domeName) {
      const cp = camera.getWorldPosition(new THREE.Vector3()); let need = 0;
      for (const n of names) { const bb = new THREE.Box3().setFromObject(scene.getObjectByName(n)); const s = bb.getBoundingSphere(new THREE.Sphere()); need = Math.max(need, cp.distanceTo(s.center) + s.radius); }
      if (domeName) { const t = __t.inside(domeName, []); need = Math.max(need, cp.distanceTo(new THREE.Vector3(...t.center)) + t.r); }
      return { far: camera.far, need, ok: camera.far >= need };
    },
    // rendered pixel at an object's centre is its colour (magenta) after a real render
    drawn(name) {
      const o = scene.getObjectByName(name); const c = o.getWorldPosition(new THREE.Vector3());
      camera.lookAt(c); camera.updateMatrixWorld(); renderer.render(scene, camera);
      const ndc = c.clone().project(camera); const gl = renderer.getContext(); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(4); gl.readPixels(Math.round((ndc.x + 1) / 2 * w), Math.round((ndc.y + 1) / 2 * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { px: [...px], ok: px[0] > 180 && px[1] < 90 && px[2] > 180, dist: c.distanceTo(camera.position) };
    },
    clear(names) { for (const n of names) { const o = scene.getObjectByName(n); if (o) o.parent.remove(o); } }
  };
});
const shot = async (file) => { if (SHOTS) { await sleep(500); await p.screenshot({ path: `${SHOTS}/${file}` }); } };

// 2. Fresh page: nothing user-made, the app's VR skybox keeps 50 m, far stays the 0.975 default
const f0 = await p.evaluate(() => gsFitScene());
ok('fresh page: no content counted (menus / rig / skybox excluded), far = default 100 + orbit offset', f0.count === 0 && f0.far >= 100 && f0.far < 110, JSON.stringify(f0));
ok('fresh page: app VR skybox stays 50 m', f0.domes.some(d => Math.abs(d.radius - 50) < 0.01), JSON.stringify(f0.domes));

// 3. Fixed-size 50 m HDRI dome (auto-detected: BackSide + texture), objects far beyond it
await p.evaluate(() => { __t.sky('skyDome', 50); __t.box('near', 0, 4, -20, 4); __t.box('far300', 300, 10, -300, 12); __t.box('far600', -600, 20, 100, 16); camera.position.set(0, 1.6, 4); });
const before = await p.evaluate(() => { const d = scene.getObjectByName('skyDome'); return d.scale.x; });
const f1 = await p.evaluate(() => gsFitScene());
const in1 = await p.evaluate(() => __t.inside('skyDome', ['near', 'far300', 'far600']));
ok('auto-detected 50 m dome grows to enclose objects 600 m out', before === 1 && in1.inside && in1.r >= in1.worst * 1.2, JSON.stringify({ in1, f1: { radius: f1.radius, domes: f1.domes } }));
ok('dome radius ≈ (centre distance + content radius) × 1.5', Math.abs(in1.r - f1.domes.find(d => d.name === 'skyDome').radius) < 1e-6 && in1.r > f1.radius * 1.5 - 1);
const c1 = await p.evaluate(() => __t.farCovers(['near', 'far300', 'far600'], 'skyDome'));
ok('camera.far reaches all objects and the whole dome', c1.ok, JSON.stringify(c1));
const dr = await p.evaluate(() => ({ a: __t.drawn('far300'), b: __t.drawn('far600') }));
ok('objects 420 m and 610 m away are actually rendered (pixel check)', dr.a.ok && dr.b.ok, JSON.stringify(dr));
const domeDrawn = await p.evaluate(() => { camera.position.set(0, 1.6, 4); camera.lookAt(0, 30, -100); camera.updateMatrixWorld(); renderer.render(scene, camera); const gl = renderer.getContext(); const px = new Uint8Array(4); gl.readPixels(gl.drawingBufferWidth >> 1, Math.round(gl.drawingBufferHeight * 0.7), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [...px]; });
ok('the dome itself still renders (sky texture, not clear colour)', domeDrawn[2] > 120 && domeDrawn[2] > domeDrawn[0], JSON.stringify(domeDrawn));
await p.evaluate(() => { camera.position.set(0, 120, 520); camera.lookAt(0, 0, -100); });
await shot('1-dome-fit-50m-dome-grown-to-600m-scene.png');
await p.evaluate(() => { camera.position.set(-1500, 900, 1500); camera.lookAt(0, 0, 0); });
const outside = await p.evaluate(() => { gsFitScene(); return __t.inside('skyDome', []); });
const camIn = await p.evaluate(() => camera.position.distanceTo(new THREE.Vector3(...__t.inside('skyDome', []).center)) < __t.inside('skyDome', []).r);
ok('camera zoomed far out stays inside the dome', camIn, JSON.stringify(outside));
await shot('2-dome-fit-camera-far-out-still-inside.png');
await p.evaluate(() => { camera.position.set(0, 1.6, 4); camera.lookAt(0, 1.6, -10); });

// 4. Automatic refit (no gsFitScene call): object added / moved later
await p.evaluate(() => { __t.box('late', 0, 50, -1500, 20); });
await sleep(1200);
const in2 = await p.evaluate(() => __t.inside('skyDome', ['near', 'far300', 'far600', 'late']));
const c2 = await p.evaluate(() => __t.farCovers(['late'], 'skyDome'));
ok('object added 1.5 km away later: dome refits by itself within ~0.5 s', in2.inside, JSON.stringify(in2));
ok('... and camera.far follows (also drawn)', c2.ok && (await p.evaluate(() => __t.drawn('late'))).ok, JSON.stringify(c2));
await p.evaluate(() => { scene.getObjectByName('late').position.set(2500, 0, 0); }); await sleep(1200);
ok('object moved to 2.5 km: dome refits', (await p.evaluate(() => __t.inside('skyDome', ['late']))).inside);
// shrink back
await p.evaluate(() => __t.clear(['far300', 'far600', 'late'])); await sleep(1200);
const s3 = await p.evaluate(() => ({ r: __t.inside('skyDome', []).r, far: camera.far }));
ok('far objects removed: dome back to its authored 50 m, far back near 100', Math.abs(s3.r - 50) < 1e-3 && s3.far < 120, JSON.stringify(s3));

// 5. Scene code sets its own (larger) dome size: becomes the new authored size
await p.evaluate(() => { scene.getObjectByName('skyDome').scale.setScalar(4); }); await sleep(900);
ok('scene code scaling the dome to 200 m is kept as its minimum', Math.abs((await p.evaluate(() => __t.inside('skyDome', []).r)) - 200) < 1e-3);
await p.evaluate(() => __t.clear(['skyDome']));

// 6. Tagged dome with a radius-1 sphere (prompt example style) + GroundedSkybox
await p.evaluate(() => { __t.sky('taggedSky', 1, { tag: true, side: THREE.FrontSide }); __t.box('t1', 200, 5, -200, 10); });
const t6 = await p.evaluate(() => { gsFitScene(); return __t.inside('taggedSky', ['t1', 'near']); });
ok('userData.gsHdriDome sphere (FrontSide, radius 1) is fitted too', t6.inside, JSON.stringify(t6));
await p.evaluate(() => __t.clear(['taggedSky', 't1']));
const g6 = await p.evaluate(async () => {
  const { GroundedSkybox } = await import('three/examples/jsm/objects/GroundedSkybox.js');
  const tex = __t.sky('tmp', 1).material.map; __t.clear(['tmp']);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const gsb = new GroundedSkybox(tex, 15, 100); gsb.name = 'grounded'; gsb.position.y = 15 - 0.01; scene.add(gsb);
  __t.box('g1', 450, 4, -300, 8); __t.box('g2', -200, 30, 400, 8);
  const r = gsFitScene();
  const bb = gsb.geometry.boundingBox; const floor = gsb.position.y + gsb.scale.y * bb.min.y;
  return { inside: __t.inside('grounded', ['g1', 'g2', 'near']), floor, scale: gsb.scale.x, far: __t.farCovers(['g1', 'g2'], 'grounded'), r };
});
ok('GroundedSkybox grows to enclose objects 540 m out', g6.inside.inside && g6.scale > 4, JSON.stringify(g6));
ok('GroundedSkybox floor stays at y ≈ 0', Math.abs(g6.floor - (-0.01)) < 1e-3, String(g6.floor));
ok('GroundedSkybox: camera.far covers it', g6.far.ok, JSON.stringify(g6.far));
await p.evaluate(() => { camera.position.set(0, 60, 700); camera.lookAt(0, 0, 0); });
await shot('3-grounded-skybox-fit.png');
await p.evaluate(() => { camera.position.set(0, 1.6, 4); __t.clear(['grounded', 'g1', 'g2']); });

// 7. Opt-out
await p.evaluate(() => { const s = __t.sky('globe', 30); s.userData.gsHdriDome = false; __t.box('o1', 400, 0, 0); });
const o7 = await p.evaluate(() => { gsFitScene(); return { r: __t.inside('globe', []).r, far: __t.farCovers(['o1', 'globe']) }; });
ok('userData.gsHdriDome = false: left at its size (counted as content, far still covers)', Math.abs(o7.r - 30) < 1e-6 && o7.far.ok, JSON.stringify(o7));
await p.evaluate(() => __t.clear(['globe', 'o1']));

// 8. Fog: linear fog far pushed past the farthest object; gsKeepFog keeps it
await p.evaluate(() => { scene.fog = new THREE.Fog(0x888888, 1, 60); __t.box('fogBox', 0, 5, -400, 12); });
await sleep(900);
const f8 = await p.evaluate(() => ({ fogFar: scene.fog.far, need: __t.farCovers(['fogBox']).need, drawn: __t.drawn('fogBox') }));
const fogAt = (f8.need - 1) / (f8.fogFar - 1);
ok('fog.far pushed out: farthest object at most half fogged and still visible', fogAt <= 0.55 && f8.drawn.px[0] - f8.drawn.px[1] > 80, JSON.stringify({ ...f8, fogAt }));
await p.evaluate(() => { scene.fog.far = 70; scene.userData.gsKeepFog = true; }); await sleep(900);
ok('scene.userData.gsKeepFog keeps the scene\'s fog', (await p.evaluate(() => scene.fog.far)) === 70);
await p.evaluate(() => { scene.fog = null; delete scene.userData.gsKeepFog; });

// 9. No dome: plain far objects are inside the render distance; huge scenes raise near only a little
await p.evaluate(() => { __t.box('km3', 0, 10, -3000, 60); }); await sleep(900);
const n9 = await p.evaluate(() => ({ cov: __t.farCovers(['km3']), near: camera.near, drawn: __t.drawn('km3') }));
ok('no dome: object 3 km away within camera.far and drawn; near stays 0.1', n9.cov.ok && n9.drawn.ok && n9.near === 0.1, JSON.stringify(n9));
await p.evaluate(() => { scene.getObjectByName('km3').position.set(0, 10, -40000); }); await sleep(900);
const n9b = await p.evaluate(() => ({ cov: __t.farCovers(['km3']), near: camera.near, drawn: __t.drawn('km3') }));
ok('object 40 km away: covered and drawn, near raised to far/100000 (≤ 0.5)', n9b.cov.ok && n9b.drawn.ok && n9b.near > 0.1 && n9b.near <= 0.5, JSON.stringify(n9b));
await p.evaluate(() => __t.clear(['km3'])); await sleep(900);
ok('back to near 0.1 when the big object is gone', (await p.evaluate(() => camera.near)) === 0.1);

// 10. VR (IWER Quest 3): dome + depthFar fit the scene
await p.evaluate(() => { __t.sky('vrSky', 50); __t.box('vr800', 0, 10, -800, 30); camera.position.set(0, 1.6, 4); });
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
await sleep(1500);
const v10 = await p.evaluate(() => {
  const s = renderer.xr.getSession(); const xc = renderer.xr.getCamera();
  const head = xc.getWorldPosition(new THREE.Vector3()); const t = __t.inside('vrSky', ['vr800', 'near']);
  const need = head.distanceTo(new THREE.Vector3(...t.center)) + t.r;
  const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(xc.cameras[0].projectionMatrix, xc.cameras[0].matrixWorldInverse));
  return { xr: renderer.xr.isPresenting, depthFar: s.renderState.depthFar, depthNear: s.renderState.depthNear, need, inside: t.inside, headInside: head.distanceTo(new THREE.Vector3(...t.center)) < t.r, frustum800: f.containsPoint(scene.getObjectByName('vr800').getWorldPosition(new THREE.Vector3())) };
});
ok('VR: dome encloses the 800 m object and the headset', v10.xr && v10.inside && v10.headInside, JSON.stringify(v10));
ok('VR: session depthFar reaches the whole dome, depthNear 0.1, 800 m object in the eye frustum', v10.depthFar >= v10.need && v10.depthNear === 0.1 && v10.frustum800, JSON.stringify(v10));
await p.evaluate(() => renderer.xr.getSession().end());
for (let i = 0; i < 40 && (await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
await sleep(500);

ok('no console errors', errs.length === 0, JSON.stringify(errs.slice(0, 5)));
await b.close();
const fails = results.filter(r => r.startsWith('FAIL'));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
