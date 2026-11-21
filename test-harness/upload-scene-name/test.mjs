// Browser checks for the scene name field in Community → Upload Current Scene.
//   BASE=http://localhost:3671 SHOTS=/dir node test.mjs
// /api/chat is stubbed; uploads go to whatever BASE points at (a local sim or dev).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3671';
const SHOTS = process.env.SHOTS || '';
const KEEP = process.env.KEEP_IDS_FILE || '';
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'] });
let fails = 0, n = 0; const ids = [];
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/${name}.png` }); } };
const CODE = "const m = new THREE.Mesh(new THREE.TorusKnotGeometry(0.4,0.12,96,16), new THREE.MeshStandardMaterial({color:0xf97316})); m.name='nameKnot'; m.position.set(0,1.2,-2); scene.add(m);";

async function newPage(phone) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = [];
  p.on('pageerror', e => p._errs.push(String(e)));
  await p.setRequestInterception(true);
  p.on('request', req => {
    if (req.url().endsWith('/api/chat')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) });
    req.continue();
  });
  await p.setViewport(phone ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 860 });
  await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  await p.evaluate((c) => window.gsSessionCode.add(c), CODE);
  await sleep(600);
  return p;
}
const openUpload = async (p) => {
  await p.evaluate(() => window.gsSelectTab('community')); await sleep(300);
  await p.evaluate(() => document.querySelector('#dchat-community-buttons [data-action="community:upload"]').click());
  await p.waitForSelector('#gs-ctx-publish.visible', { timeout: 8000 }); await sleep(300);
};
const posted = (p) => p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/community-scenes'), { timeout: 20000 });

// ---- desktop ----
const p = await newPage(false);
await openUpload(p);
let st = await p.evaluate(() => {
  const i = document.getElementById('gs-ctx-publish-name');
  const lbl = i?.closest('label')?.querySelector('.gs-ctx-name-label')?.textContent;
  return { exists: !!i, focused: document.activeElement === i, max: i?.maxLength, lbl, value: i?.value, ph: i?.placeholder };
});
ok('name field exists with label', st.exists && st.lbl === 'Scene name', JSON.stringify(st));
ok('name field is focused', st.focused);
ok('maxlength 80, placeholder is the default', st.max === 80 && st.ph === 'My Scene');
const allow = await p.evaluate(() => {
  const inModal = document.querySelector('#gs-ctx-publish #dchat-upload-allow-export');
  const onTab = document.querySelector('#dchat-community-buttons #dchat-upload-allow-export');
  const lbl = inModal?.closest('label')?.textContent?.replace(/\s+/g, ' ').trim();
  return { inModal: !!inModal, checked: inModal?.checked, onTab: !!onTab, lbl };
});
ok('allow-export checkbox is in the publish modal, not the Community tab', allow.inModal && !allow.onTab && allow.checked === true && /Allow others to export uploads/.test(allow.lbl || ''), JSON.stringify(allow));
const genreUi = await p.evaluate(() => {
  const g = document.getElementById('gs-ctx-publish-genre');
  const sub = document.getElementById('gs-ctx-publish-subgenre');
  return { genre: g?.value, sub: sub?.value, hasPicker: !!document.querySelector('#gs-ctx-publish .gs-genre-picker'), opts: g ? [...g.options].map((o) => o.textContent) : [] };
});
ok('publish modal has Genre / Sub-genre picker, default Uncategorized', genreUi.hasPicker && genreUi.genre === '' && (genreUi.sub === '' || genreUi.sub == null) && genreUi.opts.includes('Games') && genreUi.opts.includes('Interactive Experiences') && genreUi.opts.includes('Uncategorized'), JSON.stringify(genreUi));
const cam0 = await p.evaluate(() => camera.position.toArray().join(','));
await p.keyboard.type('wasd WASD qe');
await p.keyboard.down('ArrowLeft'); await sleep(300); await p.keyboard.up('ArrowLeft');
await sleep(300);
const cam1 = await p.evaluate(() => camera.position.toArray().join(','));
ok('typing in the field does not move the camera', cam0 === cam1, `${cam0} -> ${cam1}`);
ok('typed text lands in the field', (await p.$eval('#gs-ctx-publish-name', i => i.value)).startsWith('wasd WASD qe'));
const NAME = `Orange Knot ${Date.now()}`;
await p.evaluate(() => { const i = document.getElementById('gs-ctx-publish-name'); i.value = ''; });
await p.type('#gs-ctx-publish-name', `   ${NAME}   `);
await shot(p, 'desktop-modal');
const resP = posted(p);
await p.keyboard.press('Enter');
const res = await resP; const body = JSON.parse(res.request().postData()); const data = await res.json();
ids.push(data.id);
ok('Enter submits; name is trimmed in the request', body.name === NAME, body.name);
ok('default allow-export stays on', body.allowExport !== false, String(body.allowExport));
ok('default genre is uncategorized', (body.genre || '') === '' && (body.subGenre || '') === '', JSON.stringify({ genre: body.genre, subGenre: body.subGenre }));
ok('server stored the name', data.scene?.name === NAME, data.scene?.name);
await p.waitForSelector('#share-modal.visible', { timeout: 15000 });
await p.click('#share-close-btn').catch(() => {});
await sleep(1500);
await p.evaluate(() => window.gsSelectTab('community')); await sleep(1500);
const tile = await p.evaluate((name) => [...document.querySelectorAll('#dchat-community-list .dchat-scene-name')].some(e => e.textContent === name), NAME);
ok('Community tile shows the name', tile);
if (SHOTS) {
  await p.evaluate((name) => [...document.querySelectorAll('#dchat-community-list .dchat-scene-name')].find(e => e.textContent === name)?.closest('.dchat-community-scene')?.scrollIntoView({ block: 'center' }), NAME);
  await sleep(1200); await shot(p, 'desktop-tile');
}
// Re-open: prefilled with the current scene title
await openUpload(p);
const pre = await p.$eval('#gs-ctx-publish-name', i => i.value);
ok('prefilled with the current scene title after upload', pre === NAME, pre);
// Escape cancels, nothing posted
let cancelPosted = false; const watch = r => { if (r.method() === 'POST' && r.url().endsWith('/api/community-scenes')) cancelPosted = true; };
p.on('request', watch);
await p.keyboard.press('Escape'); await sleep(500);
ok('Escape closes without uploading', !cancelPosted && !(await p.$('#gs-ctx-publish.visible')));
// Empty -> default
await openUpload(p);
await p.evaluate(() => { document.getElementById('gs-ctx-publish-name').value = '   '; });
p.off('request', watch);
const r2P = posted(p);
await p.click('#gs-ctx-publish-btn');
const r2 = await r2P; const b2 = JSON.parse(r2.request().postData()); ids.push((await r2.json()).id);
ok('empty name falls back to "My Scene"', b2.name === 'My Scene', b2.name);
await p.click('#share-close-btn').catch(() => {});
// Uncheck Allow others to export uploads in the modal; the upload must send false
await openUpload(p);
await p.evaluate(() => { document.getElementById('gs-ctx-publish-name').value = 'Exports Off Knot'; });
await p.click('#gs-ctx-publish #dchat-upload-allow-export');
await p.evaluate(() => {
  const g = document.getElementById('gs-ctx-publish-genre');
  const sub = document.getElementById('gs-ctx-publish-subgenre');
  g.value = 'games';
  g.dispatchEvent(new Event('change', { bubbles: true }));
  sub.value = 'action';
  sub.dispatchEvent(new Event('change', { bubbles: true }));
});
const rOffP = posted(p);
await p.click('#gs-ctx-publish-btn');
const rOff = await rOffP; const bOff = JSON.parse(rOff.request().postData()); ids.push((await rOff.json()).id);
ok('unchecking Allow others to export uploads sends allowExport:false', bOff.allowExport === false, JSON.stringify(bOff.allowExport));
ok('publish modal sends selected Games / Action', bOff.genre === 'games' && bOff.subGenre === 'action', JSON.stringify({ genre: bOff.genre, subGenre: bOff.subGenre }));
await p.click('#share-close-btn').catch(() => {});
// VR: the publish card is painted in the dialog VR window
const vr = await p.evaluate(async () => {
  window.renderer.xr.isPresenting = true;
  return true;
}).catch(() => false);
ok('no page errors (desktop)', p._errs.length === 0, p._errs.slice(0, 3).join(' | '));
await p.browserContext().close();

// ---- phone ----
const q = await newPage(true);
await openUpload(q);
const ph = await q.evaluate(() => {
  const i = document.getElementById('gs-ctx-publish-name'); const r = i.getBoundingClientRect();
  const card = document.querySelector('#gs-ctx-publish .gs-ctx-inner').getBoundingClientRect();
  const btn = document.getElementById('gs-ctx-publish-btn').getBoundingClientRect();
  return { inView: r.left >= 0 && r.right <= innerWidth && card.right <= innerWidth + 1, h: r.height, fontSize: parseFloat(getComputedStyle(i).fontSize), btnH: btn.height, btnVisible: btn.bottom <= innerHeight };
});
ok('phone: field fits the screen, 44px tall, 16px font (no iOS zoom)', ph.inView && ph.h >= 44 && ph.fontSize >= 16, JSON.stringify(ph));
ok('phone: Publish button reachable', ph.btnH >= 44 && ph.btnVisible, JSON.stringify(ph));
const PNAME = `Phone Knot ${Date.now()}`;
await q.type('#gs-ctx-publish-name', PNAME);
await shot(q, 'phone-modal');
const r3P = posted(q);
await q.tap('#gs-ctx-publish-btn');
const r3 = await r3P; const d3 = await r3.json(); ids.push(d3.id);
ok('phone: tap Publish uploads with the name', d3.scene?.name === PNAME, d3.scene?.name);
ok('no page errors (phone)', q._errs.length === 0, q._errs.slice(0, 3).join(' | '));
await q.browserContext().close();

// ---- VR window (publish card painted via htmlInCanvas) ----
const v = await newPage(false);
await v.evaluate(() => { window.__gsForceXr = true; });
const vrRes = await v.evaluate(async () => {
  const mod = await import('./creationContext.js');
  let shown = null, hidden = 0;
  mod.configurePublishDialog({ isImmersive: () => true, onShow: (card, d) => { shown = { card: card?.className, input: d?.input?.id }; }, onHide: () => { hidden++; } });
  window.gsSelectTab('community');
  document.querySelector('#dchat-community-buttons [data-action="community:upload"]').click();
  await new Promise(r => setTimeout(r, 600));
  const root = document.getElementById('gs-ctx-publish');
  const xrClass = root.classList.contains('gs-ctx-modal-xr');
  const focused = document.activeElement?.id === 'gs-ctx-publish-name';
  const box = document.getElementById('dchat-upload-allow-export');
  const card = document.querySelector('#gs-ctx-publish .gs-ctx-inner');
  const allowOnCard = !!(box && card && card.contains(box) && box.checked === true);
  const genreSel = document.getElementById('gs-ctx-publish-genre');
  const genreOnCard = !!(genreSel && card && card.contains(genreSel));
  box.click();
  const allowOff = box.checked === false;
  // Simulate the VR keyboard: type then Send (Enter keydown on the field)
  const i = document.getElementById('gs-ctx-publish-name');
  i.value = 'VR Named';
  const posted = new Promise(res => { const of = window.fetch; window.fetch = (u, o) => { if (String(u).endsWith('/api/community-scenes') && o?.method === 'POST') { res(JSON.parse(o.body)); window.fetch = of; return Promise.resolve(new Response(JSON.stringify({ error: 'test stop' }), { status: 400 })); } return of(u, o); }; });
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const body = await Promise.race([posted, new Promise(r => setTimeout(() => r(null), 3000))]);
  return { shown, xrClass, focused, name: body?.name, allowExport: body?.allowExport, hidden, allowOnCard, allowOff, genreOnCard };
});
ok('VR: publish card handed to the VR window with the name field for the VR keyboard', vrRes.shown?.input === 'gs-ctx-publish-name' && /gs-ctx-inner/.test(vrRes.shown.card || ''), JSON.stringify(vrRes));
ok('VR: field not DOM-focused (no Quest system keyboard)', vrRes.xrClass && !vrRes.focused);
ok('VR: allow-export checkbox is on the same card and is toggleable', vrRes.allowOnCard && vrRes.allowOff, JSON.stringify(vrRes));
ok('VR: genre picker is on the same shared card', vrRes.genreOnCard, JSON.stringify(vrRes));
ok('VR: keyboard Send (Enter) publishes with the name', vrRes.name === 'VR Named' && vrRes.hidden === 1);
ok('VR: toggling the shared checkbox sends allowExport:false', vrRes.allowExport === false, JSON.stringify(vrRes));
// Paint the publish card with htmlInCanvas as the VR window would
const painted = await v.evaluate(async () => {
  const { paintElementToCanvas, htmlInCanvasRenderer, supportsNativeHtmlInCanvas } = await import('./htmlInCanvas.js');
  window.gsSelectTab('community');
  document.querySelector('#dchat-community-buttons [data-action="community:upload"]').click();
  await new Promise(r => setTimeout(r, 600));
  const card = document.querySelector('#gs-ctx-publish .gs-ctx-inner');
  card.classList.add('html-in-canvas-source');
  const c = document.createElement('canvas');
  const m = paintElementToCanvas(card, c, { pixelScale: 1, opaque: true });
  window.__vrShot = c.toDataURL('image/png');
  return { w: m.width, h: m.height, renderer: m.renderer || htmlInCanvasRenderer(), nativeApi: supportsNativeHtmlInCanvas(), sameName: !!document.getElementById('gs-ctx-publish-name'), title: document.getElementById('gs-ctx-publish-title')?.textContent };
});
ok('VR: publish card paints into a canvas', painted.w >= 400 && painted.h > 100, JSON.stringify(painted));
ok('VR: walker paints the same Publish to Community card when it is not a canvas child', painted.renderer === 'walker' && painted.sameName && painted.title === 'Publish to Community', JSON.stringify(painted));
if (SHOTS) { const png = await v.evaluate(() => window.__vrShot.split(',')[1]); fs.writeFileSync(`${SHOTS}/vr-window-paint.png`, Buffer.from(png, 'base64')); }
await v.browserContext().close();

// ---- VR window, native HTML-in-Canvas renderer (same DOM/CSS) ----
const nb = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors', '--enable-blink-features=CanvasDrawElement'] });
const nctx = await nb.createBrowserContext();
const np = await nctx.newPage();
np._errs = [];
np.on('pageerror', e => np._errs.push(String(e)));
await np.setRequestInterception(true);
np.on('request', req => {
  if (req.url().endsWith('/api/chat')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) });
  req.continue();
});
await np.setViewport({ width: 1280, height: 860 });
await np.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(1500);
await np.evaluate((c) => window.gsSessionCode.add(c), CODE);
await sleep(600);
const nativePaint = await np.evaluate(async () => {
  const { paintElementToCanvas, htmlInCanvasRenderer, supportsNativeHtmlInCanvas, enableNativeHtmlInCanvasHost } = await import('./htmlInCanvas.js');
  const api = supportsNativeHtmlInCanvas();
  window.gsSelectTab('community');
  document.querySelector('#dchat-community-buttons [data-action="community:upload"]').click();
  await new Promise(r => setTimeout(r, 600));
  const root = document.getElementById('gs-ctx-publish');
  const card = root.querySelector('.gs-ctx-inner');
  const canvas = document.createElement('canvas');
  enableNativeHtmlInCanvasHost(canvas);
  canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;pointer-events:none;';
  const homeParent = card.parentNode;
  homeParent.insertBefore(canvas, card);
  card.setAttribute('drawable', '');
  card.classList.add('html-in-canvas-source');
  canvas.appendChild(card);
  const why = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 1500);
    canvas.addEventListener('paint', () => { clearTimeout(t); resolve('paint'); }, { once: true });
  });
  const m = paintElementToCanvas(card, canvas, { pixelScale: 1, opaque: true });
  const name = document.getElementById('gs-ctx-publish-name');
  const btn = document.getElementById('gs-ctx-publish-btn');
  name.value = 'Native Named';
  const posted = new Promise(res => { const of = window.fetch; window.fetch = (u, o) => { if (String(u).endsWith('/api/community-scenes') && o?.method === 'POST') { res(JSON.parse(o.body).name); window.fetch = of; return Promise.resolve(new Response(JSON.stringify({ error: 'test stop' }), { status: 400 })); } return of(u, o); }; });
  btn.click();
  const uploaded = await Promise.race([posted, new Promise(r => setTimeout(() => r(null), 3000))]);
  return {
    api, why, renderer: m.renderer || htmlInCanvasRenderer(), w: m.width, h: m.height,
    title: document.getElementById('gs-ctx-publish-title')?.textContent,
    sameName: name?.id === 'gs-ctx-publish-name',
    uploaded,
    stillOneCard: document.querySelectorAll('#gs-ctx-publish-name').length === 1
  };
});
ok('VR native: browser exposes drawElementImage', nativePaint.api === true, JSON.stringify(nativePaint));
ok('VR native: same Publish to Community card paints via drawElementImage', nativePaint.renderer === 'native' && nativePaint.why === 'paint' && nativePaint.w >= 400 && nativePaint.h > 100 && nativePaint.title === 'Publish to Community' && nativePaint.sameName && nativePaint.stillOneCard, JSON.stringify(nativePaint));
ok('VR native: Publish button on that shared card still submits the name', nativePaint.uploaded === 'Native Named', JSON.stringify(nativePaint));
ok('no page errors (VR native)', np._errs.length === 0, np._errs.slice(0, 3).join(' | '));
await nctx.close();
await nb.close();

if (KEEP) fs.writeFileSync(KEEP, ids.filter(Boolean).join('\n'));
console.log(`\n${n - fails}/${n} passed; uploaded ids: ${ids.filter(Boolean).join(', ')}`);
await b.close();
process.exit(fails ? 1 : 0);
