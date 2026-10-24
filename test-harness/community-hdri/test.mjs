// Browser end-to-end: the Environment HDRI is saved with a Community upload
// and restored when the scene is opened fresh (Community list, /e/:id, /s/:id).
//   python3 make-hdr.py /tmp/sunset.hdr sunset && python3 make-hdr.py /tmp/teal.hdr teal
//   HOSTS=vercel-sim=http://localhost:3611,cf=http://127.0.0.1:3612 node test.mjs
// SHOTS=/dir saves screenshots. CHROME = Chrome binary.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const HOSTS = (process.env.HOSTS || 'vercel-sim=http://localhost:3611').split(',').map(s => s.split('='));
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'] });
let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TEAL = fs.readFileSync('/tmp/teal.hdr');
const SCENE = '/tmp/hdri-ball.vrscene';
fs.writeFileSync(SCENE, JSON.stringify({ version: 1, name: 'HDRI ball', codeBlocks: [
  "const m = new THREE.Mesh(new THREE.SphereGeometry(0.45, 64, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.08 })); m.name = 'ball'; m.position.set(0, 1.2, -2); scene.add(m);"
] }));

async function newPage(base, path = '/', { userHdri = null } = {}) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = []; p._reqs = [];
  p.on('pageerror', e => p._errs.push(String(e)));
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    p._reqs.push(`${req.method()} ${u}`);
    if (u.startsWith('https://hdri.test/')) return req.respond({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: TEAL });
    if (u.endsWith('/api/backends')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: {}, default: null }) });
    req.continue();
  });
  if (userHdri) await p.evaluateOnNewDocument((u) => { if (!sessionStorage.getItem('__h')) { sessionStorage.setItem('__h', '1'); localStorage.setItem('gs-hdri-url', u); } }, userHdri);
  await p.setViewport({ width: 1280, height: 860 });
  await p.goto(base + path, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  return p;
}
const tab = (p, t) => p.click(`.dchat-tab[data-tab="${t}"]`).then(() => sleep(300));
const clickText = (p, root, text) => p.evaluate((root, text) => {
  const el = [...document.querySelectorAll(`${root} button`)].find(x => x.textContent.trim() === text && x.offsetParent);
  if (el) el.click(); return !!el;
}, root, text);
const env = (p) => p.evaluate(() => ({
  env: !!(scene.environment && scene.environment.isTexture),
  bgTex: !!(scene.background && scene.background.isTexture),
  status: document.getElementById('dchat-hdri-status')?.textContent || '',
  bgBox: document.getElementById('dchat-hdri-bg')?.checked,
  urlField: document.getElementById('dchat-hdri-url')?.value || '',
  saved: localStorage.getItem('gs-hdri-url'),
  ball: !!scene.getObjectByName('ball')
}));
const waitEnv = async (p, pred, ms = 15000) => { const t = Date.now(); let s; while (Date.now() - t < ms) { s = await env(p); if (pred(s)) return s; await sleep(250); } return s; };
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/${name}.png` }); } };

async function upload(p) {
  const posted = [];
  const onReq = (req) => { if (req.method() === 'POST' && req.url().endsWith('/api/community-scenes')) posted.push(JSON.parse(req.postData())); };
  p.on('request', onReq);
  const resP = p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/community-scenes'), { timeout: 20000 });
  await tab(p, 'community');
  ok('  upload button clicked', await clickText(p, '#dchat-community-buttons', 'Upload Current Scene'));
  const res = await resP; const data = await res.json();
  await p.waitForSelector('#share-modal.visible', { timeout: 20000 });
  await sleep(500);
  await p.click('#share-close-btn').catch(() => {});
  p.off('request', onReq);
  return { id: data.id, body: posted[0] };
}

for (const [H, base] of HOSTS) {
  console.log(`\n== ${H} ${base}`);
  // 1. Upload with a custom HDRI file from this computer
  const a = await newPage(base);
  await (await a.$('#scene-file-input')).uploadFile(SCENE);
  await tab(a, 'env');
  await (await a.$('#dchat-hdri-file')).uploadFile('/tmp/sunset.hdr');
  const ae = await waitEnv(a, s => s.env && s.ball);
  ok(`${H} local HDRI file applied before upload`, ae.env && ae.bgTex && ae.ball, JSON.stringify(ae));
  await a.evaluate(() => document.getElementById('dchat-hdri')?.scrollIntoView({ block: 'center' }));
  await shot(a, `${H}-0-before-upload-local-hdri-file`);
  const putP = a.waitForResponse(r => r.request().method() === 'PUT' && /\/hdri$/.test(r.url()), { timeout: 20000 }).catch(() => null);
  const up = await upload(a);
  const put = await putP;
  ok(`${H} upload carries environmentHdri {kind:'file'}`, up.body?.environmentHdri?.kind === 'file' && up.body.environmentHdri.name === 'sunset.hdr' && up.body.environmentHdri.format === 'hdr', JSON.stringify(up.body?.environmentHdri));
  ok(`${H} HDRI bytes PUT after the scene`, put && put.status() === 200, String(put && put.status()));
  const rec = await (await fetch(`${base}/api/community-scenes/${up.id}`)).json();
  const FILE_NAME = `HDRI file ball ${H} ${Date.now()}`;
  ok(`${H} stored record points at the scene's HDRI`, rec.environmentHdri?.url === `/api/community-scenes/${up.id}/hdri`, JSON.stringify(rec.environmentHdri));
  // Share again without changes reuses the same scene (no second POST)
  let morePosts = 0; a.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/community-scenes')) morePosts++; });
  await tab(a, 'share'); await a.click('[data-share="link"]'); await sleep(1200); await a.click('#share-close-btn').catch(() => {});
  ok(`${H} unchanged scene + HDRI share reuses the upload`, morePosts === 0, String(morePosts));
  await a.browserContext().close();
  await fetch(`${base}/api/community-scenes/${up.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: FILE_NAME }) });

  // 2. Fresh browser opens the editor link: HDRI restored
  const e = await newPage(base, `/e/${up.id}`);
  const ee = await waitEnv(e, s => s.env && s.ball);
  ok(`${H} /e/:id restores the HDRI (lighting + background)`, ee.env && ee.bgTex && ee.ball, JSON.stringify(ee));
  ok(`${H} /e/:id fetched the stored HDRI`, e._reqs.some(r => r.startsWith('GET') && r.endsWith(`/api/community-scenes/${up.id}/hdri`)));
  ok(`${H} scene HDRI not saved as the viewer's default`, ee.saved === null, String(ee.saved));
  await tab(e, 'env'); await sleep(400);
  ok(`${H} Environment tab says it came from the scene`, /from the scene/i.test((await env(e)).status), (await env(e)).status);
  await e.evaluate(() => document.getElementById('dchat-hdri')?.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await shot(e, `${H}-1-editor-link-hdri-restored`);
  // Re-share of the unchanged loaded scene reuses its id
  let ePosts = 0; e.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/community-scenes')) ePosts++; });
  await tab(e, 'share'); await e.click('[data-share="link"]'); await sleep(1200);
  const shareUrl = await e.$eval('#share-url', x => x.value).catch(() => '');
  ok(`${H} share of the loaded scene reuses its id`, ePosts === 0 && shareUrl.includes(up.id), `${ePosts} ${shareUrl}`);
  await e.click('#share-close-btn').catch(() => {});
  // Turning the background off makes it a new share carrying background:false
  await tab(e, 'env'); await e.click('#dchat-hdri-bg'); await sleep(200);
  const posted2 = []; e.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/community-scenes')) posted2.push(JSON.parse(r.postData())); });
  await tab(e, 'share'); await e.click('[data-share="link"]'); await sleep(2500);
  ok(`${H} changed background -> new upload, HDRI kept by reference`, posted2.length === 1 && posted2[0].environmentHdri?.url === `/api/community-scenes/${up.id}/hdri` && posted2[0].environmentHdri.background === false, JSON.stringify(posted2[0]?.environmentHdri));
  await e.browserContext().close();

  // 3. Display-only /s/:id
  const s = await newPage(base, `/s/${up.id}`);
  const se = await waitEnv(s, x => x.env && x.ball);
  ok(`${H} /s/:id restores the HDRI`, se.env && se.bgTex, JSON.stringify(se));
  await shot(s, `${H}-2-view-link-hdri-restored`);
  await s.browserContext().close();

  // 4. URL HDRI, lighting only, and a legacy scene, through the Community list
  const legacy = await (await fetch(`${base}/api/community-scenes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, name: 'Legacy no HDRI ' + H, codeBlocks: ["const m = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.5), new THREE.MeshStandardMaterial({color:0x3366ff})); m.name='legacyBox'; m.position.set(0,1,-2); scene.add(m);"] }) })).json();
  const u = await newPage(base);
  await (await u.$('#scene-file-input')).uploadFile(SCENE);
  await tab(u, 'env');
  await u.click('#dchat-hdri-bg');
  await u.type('#dchat-hdri-url', 'https://hdri.test/teal.hdr');
  await u.click('#dchat-hdri-url-load');
  await waitEnv(u, x => x.env);
  const upU = await upload(u);
  ok(`${H} URL HDRI upload carries {kind:'url', background:false}`, upU.body?.environmentHdri?.kind === 'url' && upU.body.environmentHdri.url === 'https://hdri.test/teal.hdr' && upU.body.environmentHdri.background === false, JSON.stringify(upU.body?.environmentHdri));
  await u.browserContext().close();

  const c = await newPage(base);
  await tab(c, 'community'); await sleep(1500);
  const loadRow = (name) => c.evaluate((name) => {
    const row = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')].find(r => r.textContent.includes(name));
    const btn = row && [...row.querySelectorAll('button')].find(x => /^load$/i.test(x.textContent.trim()));
    if (btn) btn.click(); return !!btn;
  }, name);
  ok(`${H} Community list: Load the URL-HDRI scene`, await loadRow(upU.body.name));
  const ce = await waitEnv(c, x => x.env && x.ball);
  ok(`${H} URL HDRI restored as lighting only`, ce.env && !ce.bgTex && ce.bgBox === false && ce.urlField === 'https://hdri.test/teal.hdr', JSON.stringify(ce));
  await shot(c, `${H}-3-community-url-hdri-lighting-only`);
  ok(`${H} Community list: Load the legacy scene`, await loadRow('Legacy no HDRI ' + H));
  await sleep(2500);
  const cl = await env(c);
  ok(`${H} legacy scene drops the previous scene's HDRI (default environment)`, !cl.env && !cl.bgTex, JSON.stringify(cl));
  await c.browserContext().close();

  // 5. The viewer's own HDRI: kept for legacy scenes, restored after a scene HDRI
  const v = await newPage(base, `/e/${legacy.id}`, { userHdri: 'https://hdri.test/teal.hdr' });
  const ve = await waitEnv(v, x => x.env);
  ok(`${H} legacy scene keeps the viewer's own HDRI`, ve.env && ve.bgTex && ve.saved === 'https://hdri.test/teal.hdr', JSON.stringify(ve));
  await tab(v, 'community'); await sleep(1500);
  // Oldest row with that name = the original upload (step 2 re-shared it with the background off).
  await v.evaluate((name) => { const r = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')].filter(r => r.textContent.includes(name)).at(-1); [...r.querySelectorAll('button')].find(x => /^load$/i.test(x.textContent.trim())).click(); }, FILE_NAME);
  const vs = await waitEnv(v, x => x.env && /from the scene/i.test(x.status));
  ok(`${H} scene HDRI replaces it while loaded`, v._reqs.some(r => r.endsWith(`/api/community-scenes/${up.id}/hdri`)) && vs.env && vs.bgTex, JSON.stringify(vs));
  ok(`${H} viewer default still remembered`, (await env(v)).saved === 'https://hdri.test/teal.hdr');
  await v.evaluate(() => { const r = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')].find(r => r.textContent.includes('Legacy no HDRI')); [...r.querySelectorAll('button')].find(x => /^load$/i.test(x.textContent.trim())).click(); });
  const vb = await waitEnv(v, x => x.env && !/from the scene/i.test(x.status) && x.urlField === 'https://hdri.test/teal.hdr');
  ok(`${H} next legacy scene brings the viewer's own HDRI back`, vb.env && vb.bgTex && !/from the scene/i.test(vb.status), JSON.stringify(vb));
  ok(`${H} no page errors`, [a, e, s, u, c, v].every(x => !x._errs.length), [a, e, s, u, c, v].flatMap(x => x._errs).join(' | '));
  await v.browserContext().close();
}
await b.close();
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
