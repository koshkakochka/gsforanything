// Browser end-to-end for the per-scene export setting, plus checks that the
// removed Embed feature is gone (no Share tab section, no Community row button,
// no embed view; old /embed/:id iframes/links land on the /s/:id share page).
//   HOSTS=vercel-sim=http://localhost:3631,cf=http://127.0.0.1:3632 SHOTS=/dir node test.mjs
// /api/chat and /api/backends are always stubbed (no AI calls). Uploads go to
// the local sims only. CHROME = Chrome binary.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import http from 'http';
const HOSTS = (process.env.HOSTS || 'vercel-sim=http://localhost:3631').split(',').map(s => s.split('='));
const SHOTS = process.env.SHOTS || '';
const HOST_PORT = Number(process.env.HOST_PORT || 3639); // the "other site" page
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'] });
let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/${name}.png` }); } };
const sceneFile = (name, color) => {
  const f = `/tmp/perm-${name.replace(/\W+/g, '-')}.vrscene`;
  fs.writeFileSync(f, JSON.stringify({ version: 1, name, codeBlocks: [
    `const m = new THREE.Mesh(new THREE.TorusKnotGeometry(0.4, 0.14, 128, 16), new THREE.MeshStandardMaterial({ color: ${color}, roughness: 0.35 })); m.name = 'permKnot'; m.position.set(0, 1.4, -2); scene.add(m); scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));`
  ] }));
  return f;
};

async function newPage(base, path = '/', { mobile = false, fakeXr = false, ctx = null } = {}) {
  ctx = ctx || await b.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = []; p._posts = []; p._chat = 0;
  p.on('pageerror', e => p._errs.push(String(e)));
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = new URL(req.url());
    if (u.pathname === '/api/chat') { p._chat++; return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'stubbed' }] }) }); }
    if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: {}, default: null }) });
    if (req.method() === 'POST' && u.pathname === '/api/community-scenes') p._posts.push(JSON.parse(req.postData() || '{}'));
    req.continue();
  });
  if (fakeXr) await p.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'xr', { value: { isSessionSupported: async (m) => m === 'immersive-vr', requestSession: async () => { throw new Error('test'); }, addEventListener() {}, removeEventListener() {} }, configurable: true });
  });
  if (mobile) await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  else await p.setViewport({ width: 1280, height: 860 });
  await p.goto(base + path, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  return p;
}
const tab = (p, t) => p.evaluate((t) => document.querySelector(`.dchat-tab[data-tab="${t}"]`)?.click(), t).then(() => sleep(350));
const clickText = (p, root, text) => p.evaluate((root, text) => {
  const el = [...document.querySelectorAll(`${root} button`)].find(x => x.textContent.trim() === text && x.offsetParent);
  if (el) el.click(); return !!el;
}, root, text);
const dlg = (p) => p.evaluate(() => { const d = window.gsDialogs?.current(); return d ? { kind: d.kind, message: d.message, shown: !document.getElementById('gs-dialog')?.hidden } : null; });
const closeDlg = (p) => p.evaluate(() => document.querySelector('#gs-dialog [data-gs-dialog="ok"]')?.click()).then(() => sleep(250));
const shareTab = (p) => p.evaluate(() => ({
  embedButton: !!document.querySelector('[data-share="embed"]'),
  embedText: /embed/i.test(document.getElementById('dchat-share')?.innerText || ''),
  formatsDisabled: [...document.querySelectorAll('[data-share-format]')].map(b => b.disabled),
  lockedNote: getComputedStyle(document.querySelector('[data-share="locked"]')).display !== 'none',
  allow: document.querySelector('[data-share="allow-export"]')?.checked
}));
const row = (p, id) => p.evaluate((id) => {
  const r = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')].find(x => x.querySelector(`[data-scene-id="${id}"], [data-community-embed="${id}"], [data-community-export-toggle="${id}"]`) || x.querySelector('.dchat-scene-name')?.title.includes(`(${id})`));
  if (!r) return null;
  return { embed: !!r.querySelector('[data-community-embed]'), merge: !!r.querySelector('.gs-merge-row-btn'), badge: !!r.querySelector('.dchat-noexport-badge'), toggle: r.querySelector('[data-community-export-toggle]')?.textContent || null };
}, id);
const noEmbedGlobals = (p) => p.evaluate(() => !window.gsEmbed && !document.getElementById('gs-embed-modal') && !document.getElementById('gs-embed-badge') && !document.body.classList.contains('gs-embed'));
const formatsOn = (st) => st.formatsDisabled.length === 5 && st.formatsDisabled.every(x => x === false);

async function uploadVia(p, { allow }) {
  await tab(p, 'community');
  const box = await p.$('#dchat-upload-allow-export');
  const cur = await p.$eval('#dchat-upload-allow-export', x => x.checked);
  if (cur !== allow) await box.click();
  const resP = p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/community-scenes'), { timeout: 20000 });
  ok('  upload clicked', await clickText(p, '#dchat-community-buttons', 'Upload Current Scene'));
  const data = await (await resP).json();
  await p.waitForSelector('#share-modal.visible', { timeout: 20000 });
  await sleep(400);
  await p.click('#share-close-btn').catch(() => {});
  return data;
}

for (const [H, base] of HOSTS) {
  console.log(`\n== ${H} ${base}`);
  const stamp = Date.now();
  // ---- Creator: one scene with exports allowed, one without ----
  const ctxA = await b.createBrowserContext();
  const a = await newPage(base, '/', { ctx: ctxA });
  await tab(a, 'share');
  let st = await shareTab(a);
  ok(`${H} Share tab: no Embed section, Allow exports (default on), link + formats`, !st.embedButton && !st.embedText && st.allow === true && !st.lockedNote && formatsOn(st) && await a.evaluate(() => !!document.querySelector('[data-share="link"]')), JSON.stringify(st));
  ok(`${H} no embed modal / globals`, await noEmbedGlobals(a));
  await shot(a, `${H}-1-share-tab`);
  await (await a.$('#scene-file-input')).uploadFile(sceneFile(`Open knot ${H} ${stamp}`, '0x6366f1'));
  await a.waitForFunction(() => !!scene.getObjectByName('permKnot'), { timeout: 15000 });
  await sleep(500);
  const allowed = await uploadVia(a, { allow: true });
  const allowedId = allowed.id;
  ok(`${H} upload with exports allowed`, !!allowedId && a._posts.at(-1).allowExport === true && allowed.allowExport === true && !('embedUrl' in allowed), JSON.stringify(Object.keys(allowed)));
  const owned = await a.evaluate(() => JSON.parse(localStorage.getItem('gs.ownedScenes') || '{}'));
  ok(`${H} owner key kept in this browser`, !!owned[allowedId]);

  // Second scene, uploaded with "Don't allow exports"
  await (await a.$('#scene-file-input')).uploadFile(sceneFile(`Locked knot ${H} ${stamp}`, '0xf59e0b'));
  await a.waitForFunction(() => !!scene.getObjectByName('permKnot'), { timeout: 15000 });
  await sleep(500);
  const denied = await uploadVia(a, { allow: false });
  const deniedId = denied.id;
  ok(`${H} upload sends allowExport:false`, a._posts.at(-1).allowExport === false && denied.allowExport === false);
  await tab(a, 'share');
  st = await shareTab(a);
  ok(`${H} Share tab checkbox mirrors the Community choice`, st.allow === false, JSON.stringify(st));
  ok(`${H} creator keeps exports on their own scene`, formatsOn(st) && !st.lockedNote, JSON.stringify(st));
  const persisted = await (await fetch(`${base}/api/community-scenes/${deniedId}`)).json();
  ok(`${H} flag persisted server-side`, persisted.allowExport === false && !('ownerKeyHash' in persisted) && !('embedUrl' in persisted));
  // Community list: badge + creator toggle, never an Embed button
  await tab(a, 'community');
  await a.waitForFunction((id) => document.querySelector(`[data-community-export-toggle="${id}"]`), { timeout: 15000 }, deniedId);
  let r = await row(a, deniedId);
  ok(`${H} creator's no-export row: badge + "Allow exports" toggle, no Embed`, r && r.badge && r.toggle === 'Allow exports' && !r.embed, JSON.stringify(r));
  r = await row(a, allowedId);
  ok(`${H} creator's allowed row: "Block exports" toggle, no Embed`, r && !r.embed && r.toggle === 'Block exports' && !r.badge, JSON.stringify(r));
  ok(`${H} no Community row has an Embed button`, await a.evaluate(() => ![...document.querySelectorAll('#dchat-community-list button')].some(x => /^embed$/i.test(x.textContent.trim()) || x.dataset.communityEmbed)));
  await shot(a, `${H}-2-community-list-owner`);
  ok(`${H} creator: no page errors / no AI calls`, a._errs.length === 0 && a._chat === 0, a._errs.join(' | '));
  await a.browserContext().close();

  // ---- Another person opens the no-export scene ----
  const v = await newPage(base, `/e/${deniedId}`);
  await v.waitForFunction(() => !!scene.getObjectByName('permKnot'), { timeout: 15000 });
  ok(`${H} viewer can still view the scene`, true);
  await tab(v, 'share');
  st = await shareTab(v);
  ok(`${H} viewer: model exports disabled, note shown, no Embed`, st.formatsDisabled.every(Boolean) && st.lockedNote && !st.embedButton && !st.embedText, JSON.stringify(st));
  await shot(v, `${H}-3-viewer-share-tab-exports-off`);
  const exp = await v.evaluate(async () => { const r = await window.gsSceneExport.open('glb'); return { r, modal: document.getElementById('gs-model-export')?.classList.contains('visible') || false }; });
  let d = await dlg(v);
  ok(`${H} viewer: GLB export blocked with an in-app message`, exp.r === null && !exp.modal && d?.kind === 'alert' && /turned off exports/i.test(d.message) && !/embed/i.test(d.message), JSON.stringify({ exp, d }));
  await closeDlg(v);
  const now = await v.evaluate(() => window.gsSceneExport.exportNow('obj'));
  ok(`${H} viewer: direct exportNow refused`, now === null);
  await closeDlg(v);
  await v.evaluate(() => window.gsChatPanel.action('scenes:export')); await sleep(300);
  const vm = await v.evaluate(() => getComputedStyle(document.getElementById('export-modal')).display);
  ok(`${H} viewer: .vrscene Export / Save to Device blocked`, vm === 'none' && (await dlg(v))?.kind === 'alert', vm);
  await closeDlg(v);
  await v.evaluate(() => window.gsChatPanel.action('scenes:embed')); await sleep(300);
  ok(`${H} old scenes:embed action does nothing`, !(await dlg(v)) && await noEmbedGlobals(v));
  // Edit (as chat would), then try to re-upload: still locked
  await v.evaluate(() => window.gsSessionCode.add("const q = new THREE.Mesh(new THREE.BoxGeometry(0.2,0.2,0.2), new THREE.MeshBasicMaterial()); q.name='addedBox'; scene.add(q);"));
  await sleep(500);
  const vPosts = v._posts.length;
  await tab(v, 'community');
  await clickText(v, '#dchat-community-buttons', 'Upload Current Scene'); await sleep(800);
  ok(`${H} viewer: edited copy can't be re-uploaded`, v._posts.length === vPosts && (await dlg(v))?.kind === 'alert');
  await closeDlg(v);
  ok(`${H} viewer: still locked after edits`, (await shareTab(v)).formatsDisabled.every(Boolean));
  await v.waitForFunction((id) => [...document.querySelectorAll('#dchat-community-list .dchat-scene-name')].some(x => x.title.includes(`(${id})`)), { timeout: 15000 }, deniedId);
  r = await row(v, deniedId);
  ok(`${H} viewer list: no-export row has badge, no Embed/Merge/toggle`, r && r.badge && !r.embed && !r.merge && !r.toggle, JSON.stringify(r));
  r = await row(v, allowedId);
  ok(`${H} viewer list: allowed row has Merge, no Embed, no toggle`, r && !r.embed && r.merge && !r.toggle, JSON.stringify(r));
  const mergeList = await v.evaluate(async (id) => { await window.GSMerge.openMergeDialog(); const ids = [...document.querySelectorAll('#gs-merge-A option')].map(o => o.value); window.GSMerge.closeMergeDialog(); return ids.includes(id); }, deniedId);
  ok(`${H} viewer: no-export scene not offered for merge`, mergeList === false);
  // Loading an allowed scene unlocks again
  await v.evaluate((id) => [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')].find(x => x.querySelector('.dchat-scene-name')?.title.includes(`(${id})`))?.querySelector('.dchat-community-scene-actions-row button')?.click(), allowedId);
  await v.waitForFunction(() => [...document.querySelectorAll('[data-share-format]')].every(b => !b.disabled), { timeout: 15000 }).catch(() => {});
  ok(`${H} loading an allowed scene re-enables exports`, formatsOn(await shareTab(v)));
  ok(`${H} viewer: no page errors / no AI calls`, v._errs.length === 0 && v._chat === 0, v._errs.join(' | '));
  await v.browserContext().close();

  // ---- Old /embed/:id links: redirected to the view-only share page ----
  const e = await newPage(base, `/embed/${allowedId}?vr=0`, { fakeXr: true });
  await e.waitForFunction(() => !!window.scene?.getObjectByName('permKnot'), { timeout: 20000 }).catch(() => {});
  const ev = await e.evaluate(() => ({ path: location.pathname, knot: !!scene.getObjectByName('permKnot'), displayOnly: document.body.classList.contains('display-only'), cls: document.body.className }));
  ok(`${H} /embed/:id lands on /s/:id and shows the scene (view-only)`, ev.path === `/s/${allowedId}` && ev.knot && ev.displayOnly, JSON.stringify(ev));
  ok(`${H} redirected page has no embed mode / badge`, await noEmbedGlobals(e) && e._errs.length === 0 && e._chat === 0, e._errs.join(' | '));
  await shot(e, `${H}-4-old-embed-link-redirected`);
  await e.browserContext().close();

  // ---- An old snippet inside a page on another site ----
  // A plain local server on another origin (request interception would break
  // the cross-origin iframe navigation). The share page never calls /api/chat.
  const hostSrv = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><body style="font-family:sans-serif;background:#f3f4f6;padding:16px"><h1>My blog post</h1><p>An old embed snippet:</p><iframe id="old" src="${base}/embed/${allowedId}" title="t" width="800" height="450" style="border:0" allow="xr-spatial-tracking; fullscreen" allowfullscreen></iframe><p>An old embed of a no-export scene:</p><iframe id="locked" src="${base}/embed/${deniedId}" width="300" height="160"></iframe></body>`); });
  await new Promise(r => hostSrv.listen(HOST_PORT, '127.0.0.1', r));
  const hctx = await b.createBrowserContext();
  const h = await hctx.newPage();
  await h.setViewport({ width: 900, height: 820 });
  await h.goto(`http://127.0.0.1:${HOST_PORT}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  const fr = h.frames().find(f => f.url().includes(`/s/${allowedId}`));
  let framed = false;
  if (fr) { await fr.waitForFunction(() => !!window.scene?.getObjectByName('permKnot'), { timeout: 20000 }).catch(() => {}); framed = await fr.evaluate(() => !!window.scene?.getObjectByName('permKnot')).catch(() => false); }
  ok(`${H} old snippet iframe follows the redirect and shows the share page`, framed, JSON.stringify(h.frames().map(f => f.url())));
  const others = h.frames().filter(f => f !== h.mainFrame() && f !== fr);
  const lockedLoaded = await Promise.all(others.map(f => f.evaluate(() => !!window.scene).catch(() => false)));
  ok(`${H} old snippet of a no-export scene stays blocked in a foreign iframe (CSP)`, others.length === 1 && others[0].url().startsWith('chrome-error://') && !lockedLoaded.some(Boolean), JSON.stringify(h.frames().map(f => f.url())));
  await shot(h, `${H}-5-old-snippet-in-another-page`);
  await hctx.close();
  await new Promise(r => hostSrv.close(r));

  // ---- Mobile: Share tab has no Embed section ----
  const m = await newPage(base, `/e/${allowedId}`, { mobile: true });
  await m.waitForFunction(() => !!scene.getObjectByName('permKnot'), { timeout: 15000 });
  await m.evaluate(() => window.gsChatPanel?.open?.());
  await tab(m, 'share');
  st = await shareTab(m);
  ok(`${H} mobile: Share tab has link + formats, no Embed`, !st.embedButton && !st.embedText && formatsOn(st) && await m.evaluate(() => !!document.querySelector('[data-share="link"]')?.getClientRects().length), JSON.stringify(st));
  await shot(m, `${H}-6-mobile-share-tab`);
  await m.browserContext().close();
}
console.log(`\n${n - fails}/${n} passed`);
await b.close();
process.exit(fails ? 1 : 0);
