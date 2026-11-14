// webglGuard.js in the main app (was the embed-webgl test before Embed was
// removed). BASE = local wrangler dev / vercel-sim only, never production.
import puppeteer from 'puppeteer-core';
import { join } from 'node:path';

const BASE = (process.env.BASE || 'http://127.0.0.1:3632').replace(/\/+$/, '');
if (/gsforanything\.com|vercel\.app|workers\.dev/.test(BASE)) throw new Error('BASE must be a local server');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const code = `const m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xff3366 }));
m.position.set(0, 1.2, -2); m.name = 'webglGuardCube'; scene.add(m);
const l = new THREE.DirectionalLight(0xffffff, 3); l.position.set(2, 4, 3); scene.add(l);
gs.onDispose(() => { scene.remove(m); scene.remove(l); });`;
const up = await fetch(`${BASE}/api/community-scenes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'WebGL guard test', codeBlocks: [code], allowExport: true }) }).then((r) => r.json());
ok(!!up.id, `uploaded test scene to ${BASE} (${up.id})`);

const INSTR = (fail) => `(() => { if (window.__gsCtx) return; const st = window.__gsCtx = { created: 0, lost: 0, restored: 0, failed: 0 };
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (${fail} && /webgl/.test(type)) { st.failed++; return null; }
    const had = this.__gsHas; const r = orig.call(this, type, attrs);
    if (/webgl/.test(type) && r && !had) { this.__gsHas = 1; st.created++;
      this.addEventListener('webglcontextlost', () => st.lost++);
      this.addEventListener('webglcontextrestored', () => st.restored++); }
    return r; }; })();`;

async function newPage(browser, { fail = false, dpr = 1 } = {}) {
  const p = await browser.newPage();
  p._errs = [];
  p.on('pageerror', (e) => p._errs.push(String(e)));
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/chat') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'stubbed' }] }) });
    if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: {}, default: null }) });
    req.continue();
  });
  await p.setViewport({ width: 1100, height: 800, deviceScaleFactor: dpr });
  await p.evaluateOnNewDocument(INSTR(fail));
  return p;
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await newPage(browser, { dpr: 3 });
  await page.goto(`${BASE}/s/${up.id}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.scene?.getObjectByName('webglGuardCube'), { timeout: 60000 }).catch(() => {});
  const stats = () => page.evaluate(() => {
    const r = window.renderer; const gl = r.getContext();
    r.render(window.scene, window.camera || r.xr.getCamera());
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight; const px = new Uint8Array(4);
    const colors = new Set();
    for (let y = 1; y < 12; y++) for (let x = 1; x < 12; x++) { gl.readPixels(Math.floor(w * x / 12), Math.floor(h * y / 12), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); colors.add(px.join(',')); }
    const msg = document.querySelector('#gs-webgl-error:not([hidden]), #gs-webgl-lost:not([hidden])');
    return { ctx: { ...window.__gsCtx }, colors: colors.size, pr: r.getPixelRatio(), pdb: gl.getContextAttributes()?.preserveDrawingBuffer, lostNow: gl.isContextLost(), msg: msg ? msg.textContent : null, watch: typeof window.gsContextWatch?.state === 'function' };
  });
  let s = await stats();
  ok(s.watch, 'context-loss watcher installed (window.gsContextWatch)');
  ok(s.ctx.created === 1, `exactly one WebGL context (${s.ctx.created})`);
  ok(s.ctx.lost === 0 && !s.lostNow, `no context loss (${s.ctx.lost})`);
  ok(s.colors > 1, `scene renders (sampled ${s.colors} distinct colours)`);
  ok(s.pdb === true, 'app renderer keeps preserveDrawingBuffer');
  ok(s.pr === 3, `pixel ratio capped at 3 at DPR 3 (${s.pr})`);
  ok(!s.msg, 'no error message');

  await page.evaluate(() => { window.__lc = window.renderer.getContext().getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
  await sleep(800);
  s = await page.evaluate(() => ({ lost: window.__gsCtx.lost, webgl: document.body.dataset.gsWebgl }));
  ok(s.lost === 1 && s.webgl === 'lost', 'context loss seen (preventDefault, waiting for restore)');
  await page.evaluate(() => window.__lc.restoreContext());
  await sleep(2500);
  s = await stats();
  ok(!s.lostNow && s.ctx.restored === 1 && s.colors > 1 && !s.msg && s.ctx.created === 1, `restored once and renders again, same context, no message (${JSON.stringify(s.ctx)}, colours ${s.colors})`);

  await page.evaluate(() => window.__lc.loseContext());
  await sleep(1000);
  s = await page.evaluate(() => { const m = document.getElementById('gs-webgl-lost'); return { webgl: document.body.dataset.gsWebgl, msg: m && !m.hidden ? m.textContent : null, reload: !!m?.querySelector('button') }; });
  ok(s.webgl === 'stopped' && /stopped/i.test(s.msg || '') && s.reload, `second loss soon after restore: rendering stops with a Reload message (${s.webgl})`);
  await sleep(2000);
  s = await page.evaluate(() => ({ ...window.__gsCtx }));
  ok(s.created === 1 && s.lost === 2, `no new contexts created after stopping (${JSON.stringify(s)})`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'webgl-guard-stopped.png') });
  ok(page._errs.length === 0, `no page errors before the stop (${page._errs.join(' | ')})`);

  const page2 = await newPage(browser, { fail: true });
  await page2.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60000 });
  await page2.waitForSelector('#gs-webgl-error', { timeout: 30000 }).catch(() => {});
  const s2 = await page2.evaluate(() => { const m = document.getElementById('gs-webgl-error'); if (!m) return null; const r = m.getBoundingClientRect(); return { text: m.textContent, covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, webgl: document.body.dataset.gsWebgl, failed: window.__gsCtx.failed }; });
  ok(!!s2 && /3D graphics are unavailable/.test(s2.text) && /quit and reopen/.test(s2.text) && s2.covers && s2.webgl === 'unavailable', `WebGL refused: full-page friendly message (${JSON.stringify(s2 && { webgl: s2.webgl, failed: s2.failed })})`);
  if (process.env.SHOTS) await page2.screenshot({ path: join(process.env.SHOTS, 'webgl-guard-unavailable.png') });
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
