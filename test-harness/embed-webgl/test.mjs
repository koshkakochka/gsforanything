// Embed WebGL test: the exact Share-tab embed snippet (buildEmbedSnippet) on
// a page served by `python3 -m http.server` (another origin), like a user
// self-hosting it. Checks, inside the embed iframe:
//  - exactly one WebGL context, no webglcontextlost, scene renders (pixels)
//  - embed renderer: no preserveDrawingBuffer, pixel ratio capped at 2
//  - iframe reloads: still one context per load, no loss
//  - context lost + restored once: recovers and keeps rendering, no message
//  - lost again right after a restore: rendering stops with a Reload message
//    (no recreate loop), still one context
//  - WebGL refused (getContext -> null): friendly message, not a blank page
// BASE = GS server (local wrangler dev / vercel-sim only, never production).
// HOST_PORT = python http.server port (default 3681; never 3531).
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEmbedSnippet } from '../../site-source/embedExport.js';

const BASE = (process.env.BASE || 'http://127.0.0.1:3632').replace(/\/+$/, '');
const HOST_PORT = Number(process.env.HOST_PORT || 3681);
if (HOST_PORT === 3531) throw new Error('port 3531 is reserved');
if (/gsforanything\.com|vercel\.app|workers\.dev/.test(BASE)) throw new Error('BASE must be a local server');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A small scene with clearly visible content.
const code = `const m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xff3366 }));
m.position.set(0, 1.2, -2); m.name = 'embedWebglCube'; scene.add(m);
const l = new THREE.DirectionalLight(0xffffff, 3); l.position.set(2, 4, 3); scene.add(l);
gs.onDispose(() => { scene.remove(m); scene.remove(l); });`;
const up = await fetch(`${BASE}/api/community-scenes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Embed WebGL test', codeBlocks: [code], allowExport: true }) }).then((r) => r.json());
ok(!!up.id, `uploaded test scene to ${BASE} (${up.id})`);

const dir = mkdtempSync(join(tmpdir(), 'gs-embed-webgl-'));
const snippet = buildEmbedSnippet({ origin: BASE, id: up.id, name: 'Embed WebGL test' });
const pageHtml = (s) => `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Document</title>\n</head>\n<body>\n${s}\n</body>\n</html>\n`;
writeFileSync(join(dir, 'index.html'), pageHtml(snippet));
const py = spawn('python3', ['-m', 'http.server', String(HOST_PORT), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${HOST_PORT}/`)).ok) break; } catch { /* starting */ } await sleep(100); }

const INSTR = `(() => { if (window.__gsCtx) return; const st = window.__gsCtx = { created: 0, lost: 0, restored: 0, failed: 0 };
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/.test(type) && window.name === 'gs-fail-webgl' || /webgl/.test(type) && /gsFailWebgl/.test(document.cookie)) { st.failed++; return null; }
    const had = this.__gsHas; const r = orig.call(this, type, attrs);
    if (/webgl/.test(type) && r && !had) { this.__gsHas = 1; st.created++;
      this.addEventListener('webglcontextlost', () => st.lost++);
      this.addEventListener('webglcontextrestored', () => st.restored++); }
    return r; }; })();`;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 3 });
  await page.evaluateOnNewDocument(INSTR);
  const embedFrame = () => page.frames().find((f) => f.url().includes(`/embed/${up.id}`));
  const waitReady = async (want = '1', ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = embedFrame();
      const v = f && await f.evaluate(() => document.body?.dataset.gsEmbedReady || document.body?.dataset.gsWebgl || '').catch(() => '');
      if (v === want) return f;
      await sleep(250);
    }
    return null;
  };
  const stats = (f) => f.evaluate(() => {
    const r = window.renderer; const gl = r.getContext();
    r.render(window.scene, window.camera || r.xr.getCamera());
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight; const px = new Uint8Array(4);
    const colors = new Set();
    for (let y = 1; y < 12; y++) for (let x = 1; x < 12; x++) { gl.readPixels(Math.floor(w * x / 12), Math.floor(h * y / 12), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); colors.add(px.join(',')); }
    const msg = document.querySelector('#gs-webgl-error:not([hidden]), #gs-webgl-lost:not([hidden])');
    return { ctx: { ...window.__gsCtx }, colors: colors.size, pr: r.getPixelRatio(), pdb: gl.getContextAttributes()?.preserveDrawingBuffer, lostNow: gl.isContextLost(), msg: msg ? msg.textContent : null, webgl: document.body.dataset.gsWebgl || '' };
  });

  // 1) The snippet as-is.
  await page.goto(`http://127.0.0.1:${HOST_PORT}/index.html`, { waitUntil: 'load' });
  let f = await waitReady();
  ok(!!f, 'embed iframe on the python http.server page loads the scene');
  let s = await stats(f);
  ok(s.ctx.created === 1, `exactly one WebGL context (${s.ctx.created})`);
  ok(s.ctx.lost === 0 && !s.lostNow, `no context loss (${s.ctx.lost})`);
  ok(s.colors > 1, `scene renders (sampled ${s.colors} distinct colours)`);
  ok(s.pdb === false, 'embed renderer has no preserveDrawingBuffer');
  ok(s.pr === 2, `embed pixel ratio capped at 2 at DPR 3 (${s.pr})`);
  ok(!s.msg, 'no error message');
  await sleep(3000);
  s = await stats(f);
  ok(s.ctx.created === 1 && s.ctx.lost === 0, `still one context, no loss after 3 s of rendering (${JSON.stringify(s.ctx)})`);

  // 2) Reload the iframe a few times: one context per load, no loss.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { const fr = document.querySelector('iframe'); fr.src = fr.src; });
    await sleep(500);
    f = await waitReady();
    s = f && await stats(f);
    ok(!!s && s.ctx.created === 1 && s.ctx.lost === 0 && s.colors > 1, `iframe reload ${i + 1}: one context, no loss, renders (${s && JSON.stringify(s.ctx)})`);
  }

  // 3) Context lost then restored once: recovers.
  await f.evaluate(() => { window.__lc = window.renderer.getContext().getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
  await sleep(800);
  s = await f.evaluate(() => ({ lost: window.__gsCtx.lost, webgl: document.body.dataset.gsWebgl }));
  ok(s.lost === 1 && s.webgl === 'lost', 'context loss seen (preventDefault, waiting for restore)');
  await f.evaluate(() => window.__lc.restoreContext());
  await sleep(2500);
  s = await stats(f);
  ok(!s.lostNow && s.ctx.restored === 1 && s.colors > 1 && !s.msg && s.ctx.created === 1, `restored once and renders again, same context, no message (${JSON.stringify(s.ctx)}, colours ${s.colors})`);

  // 4) Lost again right after the restore: stop with a message, no loop.
  await f.evaluate(() => window.__lc.loseContext());
  await sleep(1000);
  s = await f.evaluate(() => { const m = document.getElementById('gs-webgl-lost'); return { ctx: { ...window.__gsCtx }, webgl: document.body.dataset.gsWebgl, msg: m && !m.hidden ? m.textContent : null, reload: !!m?.querySelector('button') }; });
  ok(s.webgl === 'stopped' && /stopped/i.test(s.msg || '') && s.reload, `second loss soon after restore: rendering stops with a Reload message (${s.webgl})`);
  await sleep(2000);
  s = await f.evaluate(() => ({ ...window.__gsCtx }));
  ok(s.created === 1 && s.lost === 2, `no new contexts created after stopping (${JSON.stringify(s)})`);
  await page.screenshot({ path: process.env.SHOTS ? join(process.env.SHOTS, 'embed-webgl-stopped.png') : join(dir, 'stopped.png') });

  // 5) WebGL refused: a friendly message instead of a blank/half-built page.
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1100, height: 800 });
  await page2.evaluateOnNewDocument(INSTR.replace("window.name === 'gs-fail-webgl'", 'true'));
  await page2.goto(`http://127.0.0.1:${HOST_PORT}/index.html`, { waitUntil: 'load' });
  let f2 = null;
  for (let i = 0; i < 120 && !f2; i++) {
    await sleep(250);
    const fr = page2.frames().find((x) => x.url().includes(`/embed/${up.id}`));
    if (fr && await fr.evaluate(() => !!document.getElementById('gs-webgl-error')).catch(() => false)) f2 = fr;
  }
  const s2 = f2 && await f2.evaluate(() => { const m = document.getElementById('gs-webgl-error'); const r = m.getBoundingClientRect(); return { text: m.textContent, covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, z: getComputedStyle(m).zIndex, failed: window.__gsCtx.failed, webgl: document.body.dataset.gsWebgl }; });
  ok(!!s2 && /3D graphics are unavailable/.test(s2.text) && /quit and reopen/.test(s2.text) && s2.covers, `WebGL refused: full-frame friendly message (${s2 && s2.webgl})`);
  if (process.env.SHOTS) {
    await page2.screenshot({ path: join(process.env.SHOTS, 'embed-webgl-unavailable.png') });
    await page.bringToFront();
  }
} finally {
  await browser.close();
  py.kill();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
