// Desktop vs VR render distance (IWER-emulated Meta Quest 3 for the VR side).
// BASE=https://localhost:3488 node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3488';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n} ${e}`); console.log(results.at(-1)); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
// Markers measured from the VR start eye (0, 1.6, 0), straight-ish ahead (-Z)
const MARKERS = [['m50', -12, -50], ['m98', 0, -98], ['m140', 12, -140]];
for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]) {
  const T = `[${vp.name}]`;
  const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.setViewport(vp);
  if (vp.isMobile) await p.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
  await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
  await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(3000);
  await p.evaluate((M) => { for (const [name, x, z] of M) { const m = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial({ color: 0xff00ff })); m.name = name; m.position.set(x, 1.6, z); scene.add(m); } }, MARKERS);
  // what the current view really draws: frustum test of each marker centre + a rendered pixel at its screen spot
  const view = () => p.evaluate((names) => {
    const xr = renderer.xr.isPresenting; const cam = xr ? renderer.xr.getCamera().cameras[0] : camera;
    if (!xr) { renderer.render(scene, camera); }
    const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const out = { xr, near: +cam.near.toFixed(3), far: +cam.far.toFixed(2), userFar: +camera.far.toFixed(2) };
    const s = renderer.xr.getSession?.(); if (s) { out.depthNear = s.renderState.depthNear; out.depthFar = s.renderState.depthFar; }
    const gl = renderer.getContext(); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    for (const n of names) {
      const c = scene.getObjectByName(n).getWorldPosition(new THREE.Vector3());
      const inside = f.containsPoint(c); let px = null;
      if (!xr) { const ndc = c.clone().project(camera); const d = new Uint8Array(4); gl.readPixels(Math.round((ndc.x + 1) / 2 * w), Math.round((ndc.y + 1) / 2 * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d); px = d[0] > 200 && d[1] < 60 && d[2] > 200; }
      out[n] = xr ? inside : inside && px;
    }
    return out;
  }, MARKERS.map(m => m[0]));
  const look = () => p.evaluate(() => { const t = new THREE.Vector3(0, 1.6, -100); camera.lookAt(t); });
  // 1. desktop default (Orbit, camera 4 m behind the VR eye)
  await look(); await sleep(300); await look();
  const d0 = await view();
  const api = await p.evaluate(() => window.gsRenderDistance && { near: gsRenderDistance.near, far: gsRenderDistance.far, defaults: gsRenderDistance.defaults });
  ok(`${T} shared render distance API: near 0.1, far 100`, api && api.near === 0.1 && api.far === 100 && api.defaults.far === 100, JSON.stringify(api));
  ok(`${T} Orbit desktop: near same as VR, far = 100 + camera offset from the VR eye (4 m)`, d0.near === 0.1 && Math.abs(d0.far - 104) < 0.05, JSON.stringify(d0));
  ok(`${T} Orbit desktop draws the 50 m and 98 m markers (98 m is visible in VR), not 140 m`, d0.m50 && d0.m98 && !d0.m140, JSON.stringify(d0));
  // 2. zoomed far out
  await p.evaluate(() => { camera.position.set(0, 1.6, 50); });
  await look(); await sleep(300); await look();
  const d1 = await view();
  ok(`${T} Orbit zoomed out to 50 m: still draws everything within 100 m of the VR eye`, Math.abs(d1.far - 150) < 0.1 && d1.m50 && d1.m98 && !d1.m140, JSON.stringify(d1));
  await p.evaluate(() => { camera.position.set(0, 1.6, 4); });
  // 3. First person (PointerLockControls) moves the camera; far keeps its offset from the eye
  await p.evaluate(() => document.querySelector('#dchat-camera-mode [data-camera-mode="firstperson"]').click()); await sleep(400);
  await look(); await sleep(200);
  const d2 = await view();
  const off2 = await p.evaluate(() => gsRenderDistance.desktopFar - gsRenderDistance.far);
  ok(`${T} First person: far = 100 + camera offset from the eye, draws 98 m, not 140 m`, d2.near === 0.1 && Math.abs(d2.far - (100 + off2)) < 0.05 && d2.m98 && !d2.m140, JSON.stringify(d2) + ' offset=' + off2.toFixed(2));
  await p.evaluate(() => { scene.getObjectByName('player').position.set(0, 0, -30); camera.position.set(0, 1.6, 0); }); await sleep(300); await look(); await sleep(100);
  const d2b = await view();
  ok(`${T} camera at the VR eye (rig moved 30 m): near/far exactly the VR values 0.1 / 100`, d2b.near === 0.1 && Math.abs(d2b.far - 100) < 1e-6, JSON.stringify(d2b));
  await p.evaluate(() => { scene.getObjectByName('player').position.set(0, 0, 0); });
  await p.evaluate(() => document.querySelector('#dchat-camera-mode [data-camera-mode="orbit"]').click()); await sleep(400);
  // 4. VR (emulated Quest 3)
  await p.click('#XRButton').catch(() => {});
  for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
  await sleep(1500);
  const v0 = await view();
  ok(`${T} VR unchanged: XR camera 0.1 / 100, session depthNear/depthFar 0.1 / 100`, v0.xr && v0.near === 0.1 && v0.far === 100 && v0.depthNear === 0.1 && v0.depthFar === 100, JSON.stringify(v0));
  ok(`${T} VR draws the 98 m marker, not the 140 m one`, v0.m50 && v0.m98 && !v0.m140, JSON.stringify(v0));
  // 5. scene code raises the render distance: shared by VR and desktop
  await p.evaluate(() => { camera.far = 1000; camera.updateProjectionMatrix(); }); await sleep(1200);
  const v1 = await view();
  ok(`${T} scene code camera.far = 1000 applies in VR (depthFar 1000, 140 m drawn)`, v1.far === 1000 && v1.depthFar === 1000 && v1.m140, JSON.stringify(v1));
  await p.evaluate(() => renderer.xr.getSession().end()); 
  for (let i = 0; i < 40 && (await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
  await sleep(800);
  await p.evaluate(() => { gsOrbit.recenter(); });
  await look(); await sleep(300); await look();
  const d3 = await view();
  ok(`${T} after VR: desktop keeps the scene's far (1000 + orbit offset) and draws 140 m`, d3.far > 1000 && d3.far < 1060 && d3.m140 && api.near === d3.near, JSON.stringify(d3));
  await p.evaluate(() => { camera.far = 100; camera.updateProjectionMatrix(); }); await sleep(300); await look();
  const d4 = await view();
  ok(`${T} back to the default 100: desktop far returns to 100 + offset`, d4.far > 100 && d4.far < 160 && !d4.m140, JSON.stringify(d4));
  ok(`${T} no console/page errors`, errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  await p.close();
}
await b.close();
console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
