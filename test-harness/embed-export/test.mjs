// Browser end-to-end for the Embed export and the per-scene export setting.
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
  const f = `/tmp/embed-${name.replace(/\W+/g, '-')}.vrscene`;
  fs.writeFileSync(f, JSON.stringify({ version: 1, name, codeBlocks: [
    `const m = new THREE.Mesh(new THREE.TorusKnotGeometry(0.4, 0.14, 128, 16), new THREE.MeshStandardMaterial({ color: ${color}, roughness: 0.35 })); m.name = 'embedKnot'; m.position.set(0, 1.4, -2); scene.add(m); scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));`
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
  embedDisabled: document.querySelector('[data-share="embed"]')?.disabled,
  formatsDisabled: [...document.querySelectorAll('[data-share-format]')].map(b => b.disabled),
  lockedNote: getComputedStyle(document.querySelector('[data-share="locked"]')).display !== 'none',
  allow: document.querySelector('[data-share="allow-export"]')?.checked
}));
const row = (p, id) => p.evaluate((id) => {
  const r = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')].find(x => x.querySelector(`[data-scene-id="${id}"], [data-community-embed="${id}"], [data-community-export-toggle="${id}"]`) || x.querySelector('.dchat-scene-name')?.title.includes(`(${id})`));
  if (!r) return null;
  return { embed: !!r.querySelector('[data-community-embed]'), merge: !!r.querySelector('.gs-merge-row-btn'), badge: !!r.querySelector('.dchat-noexport-badge'), toggle: r.querySelector('[data-community-export-toggle]')?.textContent || null };
}, id);
const embedModal = (p) => p.evaluate(() => {
  const m = document.getElementById('gs-embed-modal');
  if (!m || !m.classList.contains('visible')) return null;
  const r = document.getElementById('gs-embed-modal-inner').getBoundingClientRect();
  return { code: document.getElementById('gs-embed-code').value, preview: document.getElementById('gs-embed-preview').href, fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
});

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
  await ctxA.overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const a = await newPage(base, '/', { ctx: ctxA });
  await tab(a, 'share');
  let st = await shareTab(a);
  ok(`${H} Share tab has Embed + Allow exports (default on)`, st.embedDisabled === false && st.allow === true && !st.lockedNote, JSON.stringify(st));
  await (await a.$('#scene-file-input')).uploadFile(sceneFile(`Embed knot ${H} ${stamp}`, '0x6366f1'));
  await a.waitForFunction(() => !!scene.getObjectByName('embedKnot'), { timeout: 15000 });
  // Share tab Embed: uploads (exports on), then shows the snippet
  await tab(a, 'share');
  const postsBefore = a._posts.length;
  await a.click('[data-share="embed"]');
  await a.waitForSelector('#gs-embed-modal.visible', { timeout: 20000 });
  let em = await embedModal(a);
  const allowedId = (em?.code.match(/\/embed\/([A-Za-z0-9_-]+)/) || [])[1];
  ok(`${H} Embed uploaded the unsaved scene once (exports on)`, a._posts.length === postsBefore + 1 && a._posts.at(-1).allowExport === true, JSON.stringify(a._posts.map(x => x.allowExport)));
  ok(`${H} Embed snippet is an iframe to /embed/:id`, !!allowedId && em.code.startsWith(`<iframe src="${base}/embed/${allowedId}"`) && em.code.includes('allowfullscreen') && em.code.includes('xr-spatial-tracking'), em?.code);
  ok(`${H} share modal not opened by Embed`, !(await a.$('#share-modal.visible')));
  await a.select('#gs-embed-size', '800x450'); await a.click('#gs-embed-vr'); await sleep(150);
  em = await embedModal(a);
  ok(`${H} size + VR options update the snippet`, em.code.includes('width="800" height="450"') && em.code.includes('?vr=0') && em.preview.endsWith('?vr=0'), em.code);
  await a.select('#gs-embed-size', 'responsive'); await a.click('#gs-embed-vr'); await sleep(150);
  await a.click('#gs-embed-copy'); await sleep(300);
  const clip = await a.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  ok(`${H} Copy puts the snippet on the clipboard`, clip === (await embedModal(a)).code, clip.slice(0, 80));
  await shot(a, `${H}-1-share-tab-embed-dialog`);
  await a.click('#gs-embed-close'); await sleep(200);
  // Embed again: same scene, no new upload
  await a.click('[data-share="embed"]'); await sleep(800);
  ok(`${H} Embed again reuses the upload`, a._posts.length === postsBefore + 1 && (await embedModal(a))?.code.includes(allowedId));
  await a.click('#gs-embed-close'); await sleep(200);
  const owned = await a.evaluate(() => JSON.parse(localStorage.getItem('gs.ownedScenes') || '{}'));
  ok(`${H} owner key kept in this browser`, !!owned[allowedId]);

  // Second scene, uploaded with "Don't allow exports"
  await (await a.$('#scene-file-input')).uploadFile(sceneFile(`Locked knot ${H} ${stamp}`, '0xf59e0b'));
  await a.waitForFunction(() => !!scene.getObjectByName('embedKnot'), { timeout: 15000 });
  await sleep(500);
  const denied = await uploadVia(a, { allow: false });
  const deniedId = denied.id;
  ok(`${H} upload sends allowExport:false`, a._posts.at(-1).allowExport === false && denied.allowExport === false);
  await tab(a, 'share');
  st = await shareTab(a);
  ok(`${H} Share tab checkbox mirrors the Community choice`, st.allow === false, JSON.stringify(st));
  ok(`${H} creator keeps exports on their own scene`, st.embedDisabled === false && !st.lockedNote);
  const persisted = await (await fetch(`${base}/api/community-scenes/${deniedId}`)).json();
  ok(`${H} flag persisted server-side`, persisted.allowExport === false && !('ownerKeyHash' in persisted));
  // Creator embedding a no-export scene: told to turn exports on
  await a.click('[data-share="embed"]'); await sleep(500);
  let d = await dlg(a);
  ok(`${H} creator Embed of a no-export scene explains (gsDialog)`, d && d.kind === 'alert' && /turn exports on/i.test(d.message) && !(await embedModal(a)), JSON.stringify(d));
  await closeDlg(a);
  // Community list: badge + creator toggle
  await tab(a, 'community');
  await a.waitForFunction((id) => document.querySelector(`[data-community-export-toggle="${id}"]`), { timeout: 15000 }, deniedId);
  let r = await row(a, deniedId);
  ok(`${H} creator's no-export row: badge + "Allow exports" toggle, no Embed`, r && r.badge && r.toggle === 'Allow exports' && !r.embed, JSON.stringify(r));
  r = await row(a, allowedId);
  ok(`${H} creator's allowed row: Embed + "Block exports" toggle`, r && r.embed && r.toggle === 'Block exports' && !r.badge, JSON.stringify(r));
  await a.evaluate((id) => document.querySelector(`[data-scene-id="${id}"], [data-community-embed="${id}"]`)?.closest('.dchat-community-scene')?.scrollIntoView({ block: 'center' }), deniedId);
  await sleep(200);
  await shot(a, `${H}-2-community-list-owner`);
  await a.browserContext().close();

  // ---- Another person opens the no-export scene ----
  const v = await newPage(base, `/e/${deniedId}`);
  await v.waitForFunction(() => !!scene.getObjectByName('embedKnot'), { timeout: 15000 });
  ok(`${H} viewer can still view the scene`, true);
  await tab(v, 'share');
  st = await shareTab(v);
  ok(`${H} viewer: model exports + Embed disabled, note shown`, st.embedDisabled === true && st.formatsDisabled.every(Boolean) && st.lockedNote, JSON.stringify(st));
  await shot(v, `${H}-3-viewer-share-tab-exports-off`);
  const exp = await v.evaluate(async () => { const r = await window.gsSceneExport.open('glb'); return { r, modal: document.getElementById('gs-model-export')?.classList.contains('visible') || false }; });
  d = await dlg(v);
  ok(`${H} viewer: GLB export blocked with an in-app message`, exp.r === null && !exp.modal && d?.kind === 'alert' && /turned off exports/i.test(d.message), JSON.stringify({ exp, d }));
  await shot(v, `${H}-4-viewer-export-blocked-dialog`);
  await closeDlg(v);
  const now = await v.evaluate(() => window.gsSceneExport.exportNow('obj'));
  ok(`${H} viewer: direct exportNow refused`, now === null);
  await closeDlg(v);
  await v.evaluate(() => window.gsChatPanel.action('scenes:export')); await sleep(300);
  const vm = await v.evaluate(() => getComputedStyle(document.getElementById('export-modal')).display);
  ok(`${H} viewer: .vrscene Export / Save to Device blocked`, vm === 'none' && (await dlg(v))?.kind === 'alert', vm);
  await closeDlg(v);
  // Edit (as chat would), then try to re-upload: still locked
  await v.evaluate(() => window.gsSessionCode.add("const q = new THREE.Mesh(new THREE.BoxGeometry(0.2,0.2,0.2), new THREE.MeshBasicMaterial()); q.name='addedBox'; scene.add(q);"));
  await sleep(500);
  const vPosts = v._posts.length;
  await tab(v, 'community');
  await clickText(v, '#dchat-community-buttons', 'Upload Current Scene'); await sleep(800);
  ok(`${H} viewer: edited copy can't be re-uploaded`, v._posts.length === vPosts && (await dlg(v))?.kind === 'alert');
  await closeDlg(v);
  ok(`${H} viewer: still locked after edits`, (await shareTab(v)).embedDisabled === true);
  await v.waitForFunction((id) => [...document.querySelectorAll('#dchat-community-list .dchat-scene-name')].some(x => x.title.includes(`(${id})`)), { timeout: 15000 }, deniedId);
  r = await row(v, deniedId);
  ok(`${H} viewer list: no-export row has badge, no Embed/Merge/toggle`, r && r.badge && !r.embed && !r.merge && !r.toggle, JSON.stringify(r));
  r = await row(v, allowedId);
  ok(`${H} viewer list: allowed row has Embed + Merge, no toggle`, r && r.embed && r.merge && !r.toggle, JSON.stringify(r));
  const mergeList = await v.evaluate(async (id) => { await window.GSMerge.openMergeDialog(); const ids = [...document.querySelectorAll('#gs-merge-A option')].map(o => o.value); window.GSMerge.closeMergeDialog(); return ids.includes(id); }, deniedId);
  ok(`${H} viewer: no-export scene not offered for merge`, mergeList === false);
  // Community row Embed on an allowed scene
  await v.click(`[data-community-embed="${allowedId}"]`); await sleep(300);
  em = await embedModal(v);
  ok(`${H} Community row Embed shows the snippet`, em && em.code.includes(`/embed/${allowedId}"`), em?.code);
  await v.evaluate((id) => document.querySelector(`[data-community-embed="${id}"]`)?.closest('.dchat-community-scene')?.scrollIntoView({ block: 'center' }), allowedId);
  await shot(v, `${H}-5-community-row-embed-dialog`);
  await v.click('#gs-embed-close'); await sleep(200);
  // Loading an allowed scene unlocks again
  await v.evaluate((id) => document.querySelector(`[data-community-embed="${id}"]`)?.closest('.dchat-community-scene')?.querySelector('button')?.click(), allowedId);
  await v.waitForFunction(() => document.querySelector('[data-share="embed"]') && !document.querySelector('[data-share="embed"]').disabled, { timeout: 15000 }).catch(() => {});
  ok(`${H} loading an allowed scene re-enables exports`, (await shareTab(v)).embedDisabled === false);
  ok(`${H} viewer: no page errors / no AI calls`, v._errs.length === 0 && v._chat === 0, v._errs.join(' | '));
  await v.browserContext().close();

  // ---- Embed view ----
  const e = await newPage(base, `/embed/${allowedId}`, { fakeXr: true });
  await e.waitForFunction(() => document.body.dataset.gsEmbedReady, { timeout: 20000 });
  const ev = await e.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    return {
      ready: document.body.dataset.gsEmbedReady, knot: !!scene.getObjectByName('embedKnot'),
      cls: document.body.className, badge: document.getElementById('gs-embed-badge')?.textContent, badgeHref: document.getElementById('gs-embed-badge')?.href,
      chat: vis(document.getElementById('desktop-chat')), version: vis(document.getElementById('gs-version-btn')), xr: vis(document.getElementById('XRButton')), xrText: document.getElementById('XRButton')?.textContent,
      mode: window.gsControls.mode, savedMode: localStorage.getItem('gs-camera-control-mode') || localStorage.getItem('gs.cameraControlMode')
    };
  });
  ok(`${H} /embed renders the scene`, ev.ready === '1' && ev.knot, JSON.stringify(ev));
  ok(`${H} /embed: no editor UI, Made-with link`, !ev.chat && !ev.version && ev.badge === 'Made with GS For Anything' && ev.badgeHref.endsWith(`/s/${allowedId}`) && /gs-embed/.test(ev.cls), JSON.stringify(ev));
  ok(`${H} /embed: Enter VR button shown`, ev.xr && /enter vr/i.test(ev.xrText || ''), JSON.stringify(ev));
  ok(`${H} /embed: orbit camera`, ev.mode === 'orbit', ev.mode);
  ok(`${H} /embed: used ?embed=1, no list fetch, no errors`, e._errs.length === 0 && e._chat === 0, e._errs.join(' | '));
  await shot(e, `${H}-6-embed-view`);
  await e.browserContext().close();
  const e0 = await newPage(base, `/embed/${allowedId}?vr=0`, { fakeXr: true });
  await e0.waitForFunction(() => document.body.dataset.gsEmbedReady, { timeout: 20000 });
  ok(`${H} /embed?vr=0 hides Enter VR`, await e0.evaluate(() => { const x = document.getElementById('XRButton'); return !x || getComputedStyle(x).display === 'none' || !x.getClientRects().length; }));
  await e0.browserContext().close();
  // The no-export scene: server refuses
  const ed = await newPage(base, `/embed/${deniedId}`);
  const edv = await ed.evaluate(() => ({ un: document.getElementById('gs-embed-unavailable')?.dataset.status, text: document.body.innerText }));
  ok(`${H} /embed of a no-export scene shows the unavailable page`, edv.un === '403' && /turned off exports/i.test(edv.text) && /Made with GS For Anything/.test(edv.text), JSON.stringify(edv));
  await shot(ed, `${H}-7-embed-exports-off`);
  await ed.browserContext().close();

  // ---- The snippet inside a page on another site ----
  // A plain local server on another origin (request interception would break
  // the cross-origin iframe navigation; Chrome also blocks public pages from
  // framing local servers). The embed page itself never calls /api/chat.
  const snippet = `<iframe src="${base}/embed/${allowedId}" title="t" width="800" height="450" style="border:0" allow="xr-spatial-tracking; fullscreen" allowfullscreen></iframe>`;
  const hostSrv = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><body style="font-family:sans-serif;background:#f3f4f6;padding:16px"><h1>My blog post</h1><p>Here's my scene:</p>${snippet}<p>A no-export scene's share link, framed:</p><iframe id="locked" src="${base}/s/${deniedId}" width="300" height="160"></iframe></body>`); });
  await new Promise(r => hostSrv.listen(HOST_PORT, '127.0.0.1', r));
  const hctx = await b.createBrowserContext();
  const h = await hctx.newPage();
  await h.setViewport({ width: 900, height: 820 });
  await h.goto(`http://127.0.0.1:${HOST_PORT}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  const fr = h.frames().find(f => f.url().includes(`/embed/${allowedId}`));
  let framed = false;
  if (fr) { await fr.waitForFunction(() => document.body.dataset.gsEmbedReady === '1', { timeout: 20000 }).catch(() => {}); framed = await fr.evaluate(() => !!window.scene?.getObjectByName('embedKnot')).catch(() => false); }
  ok(`${H} snippet renders inside another site's page`, framed);
  await sleep(1500);
  const others = h.frames().filter(f => f !== h.mainFrame() && f !== fr);
  const lockedLoaded = await Promise.all(others.map(f => f.evaluate(() => !!window.scene).catch(() => false)));
  ok(`${H} no-export /s/:id link is blocked in a foreign iframe (CSP)`, framed && others.length === 1 && others[0].url().startsWith('chrome-error://') && !lockedLoaded.some(Boolean), JSON.stringify(h.frames().map(f => f.url())));
  await shot(h, `${H}-8-embedded-in-another-page`);
  await hctx.close();
  await new Promise(r => hostSrv.close(r));

  // ---- Mobile: Share tab Embed dialog fits ----
  const m = await newPage(base, `/e/${allowedId}`, { mobile: true });
  await m.waitForFunction(() => !!scene.getObjectByName('embedKnot'), { timeout: 15000 });
  await m.evaluate(() => window.gsChatPanel?.open?.());
  await tab(m, 'share');
  await m.evaluate(() => document.querySelector('[data-share="embed"]').click());
  await m.waitForSelector('#gs-embed-modal.visible', { timeout: 15000 }).catch(() => {});
  em = await embedModal(m);
  ok(`${H} mobile: Embed dialog opens and fits the screen`, em && em.fits && em.code.includes(`/embed/${allowedId}"`), JSON.stringify(em));
  await shot(m, `${H}-9-mobile-embed-dialog`);
  await m.browserContext().close();

  // ---- VR path: no page dialog in a headset; snippet copied + in-app card ----
  const x = await newPage(base, `/e/${allowedId}`);
  await x.waitForFunction(() => !!scene.getObjectByName('embedKnot'), { timeout: 15000 });
  const xr = await x.evaluate(async () => {
    const xrm = renderer.xr; const orig = Object.getOwnPropertyDescriptor(xrm, 'isPresenting');
    Object.defineProperty(xrm, 'isPresenting', { value: true, configurable: true, writable: true });
    try {
      const code = await window.gsEmbed.open({ id: location.pathname.split('/').pop(), name: 'VR test' });
      const d = window.gsDialogs.current();
      return { code, modal: document.getElementById('gs-embed-modal')?.classList.contains('visible') || false, dialog: d && d.kind, msg: d && d.message };
    } finally { if (orig) Object.defineProperty(xrm, 'isPresenting', orig); else delete xrm.isPresenting; xrm.isPresenting = false; }
  });
  ok(`${H} VR: Embed shows the code in an in-app card, no page modal`, xr.code?.startsWith('<iframe') && !xr.modal && xr.dialog === 'alert' && xr.msg.includes('/embed/'), JSON.stringify(xr));
  await closeDlg(x);
  await x.browserContext().close();
}
console.log(`\n${n - fails}/${n} passed`);
await b.close();
process.exit(fails ? 1 : 0);
