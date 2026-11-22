// Frame-budget regressions: pixel-ratio cap, foveation, menu-layer throttle.
//   BASE=https://localhost:3493 node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3493';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };

const p = await browser.newPage();
p.setDefaultTimeout(60000);
await p.setViewport({ width: 1280, height: 800, deviceScaleFactor: 3 });
await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
await p.waitForFunction(() => window.renderer && window.gsPerf, { timeout: 30000 });
await sleep(1500);

const cfg = await p.evaluate(() => ({
  pr: renderer.getPixelRatio(),
  dpr: window.devicePixelRatio,
  fov: typeof renderer.xr.getFoveation === 'function' ? renderer.xr.getFoveation() : null
}));
ok('desktop pixel ratio is capped at 2 even when devicePixelRatio is 3', cfg.dpr >= 2.99 && Math.abs(cfg.pr - 2) < 0.01, cfg);

const trav = await p.evaluate(async () => {
  const orig = THREE.Object3D.prototype.traverse;
  let n = 0;
  THREE.Object3D.prototype.traverse = function (...a) { n++; return orig.apply(this, a); };
  window.gsPerf.reset();
  const start = renderer.info.render.frame;
  await new Promise((r) => {
    const tick = () => { if (renderer.info.render.frame - start >= 90) r(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  THREE.Object3D.prototype.traverse = orig;
  const st = window.gsPerf.stats();
  return { traverses: n, frames: st.frames, per: n / 90, cpuAvg: st.avg };
});
ok('menu-layer traverse is not run every frame when the graph is idle (< 2 per frame over 90 frames)', trav.per < 2, trav);
ok('gsPerf recorded loop CPU samples', trav.frames >= 80 && trav.cpuAvg >= 0, trav);
console.log('PERF empty-scene', JSON.stringify(trav));

const hidden = await p.evaluate(async () => {
  const frames0 = renderer.info.render.frame;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 250));
  const frames1 = renderer.info.render.frame;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const frames2 = renderer.info.render.frame;
  return { duringHidden: frames1 - frames0, after: frames2 - frames1 };
});
ok('hidden desktop tab skips renderer.render', hidden.duringHidden === 0, hidden);
ok('rendering resumes when the tab is visible again', hidden.after >= 1, hidden);

// Foveation is applied on the live XR layer at session start.
await p.evaluateOnNewDocument(() => {}); // page already loaded; inject runtime now via addScript
const p2ctx = await browser.createBrowserContext();
const p2 = await p2ctx.newPage();
await p2.setViewport({ width: 1600, height: 900 });
await p2.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p2.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
await p2.waitForFunction(() => window.renderer, { timeout: 30000 });
await sleep(800);
await p2.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
await p2.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p2.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
const xr = await p2.evaluate(() => ({ presenting: renderer.xr.isPresenting, fov: typeof renderer.xr.getFoveation === 'function' ? renderer.xr.getFoveation() : null }));
ok('entered immersive VR to check foveation', xr.presenting, xr);
ok('XR foveation is 1 (maximum) during a Quest session', xr.fov === 1, xr);
await p2ctx.close();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
