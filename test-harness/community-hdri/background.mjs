// "Use as background" works right away: scene code that sets its own
// scene.background (like the Del Amo Gazebo scenes: `scene.background = new
// THREE.Color(...)`) used to cover the HDRI until the box was toggled off and on.
// Checks, without touching the checkbox, that scene.background is the HDRI
// texture after a Community scene loads (/e/:id, /s/:id, Community list), with
// the scene's own HDRI or the viewer's saved one, also when the scene code sets
// the colour late; then that one click off / one click on works.
//   HOSTS=vercel-sim=http://localhost:3611,cf=http://127.0.0.1:3612 node background.mjs
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
const SUNSET = fs.readFileSync('/tmp/sunset.hdr');
const HDRI_URL = 'https://hdri.test/sunset.hdr';
// Like the live Del Amo Gazebo scenes: own sky colour + fog, then a reflective ball.
const COLOR_CODE = "scene.background = new THREE.Color(0xb9d0f4); scene.fog = new THREE.Fog(0xc5d4df, 35, 80); const m = new THREE.Mesh(new THREE.SphereGeometry(0.45, 64, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.08 })); m.name = 'ball'; m.position.set(0, 1.2, -2); scene.add(m);";
const LATE_CODE = "const m = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.5), new THREE.MeshStandardMaterial({ color: 0x3366ff })); m.name = 'ball'; m.position.set(0, 1, -2); scene.add(m); setTimeout(() => { scene.background = new THREE.Color(0x223344); window.__lateBg = true; }, 2000);";
const SCENE = '/tmp/hdri-color-ball.vrscene';
fs.writeFileSync(SCENE, JSON.stringify({ version: 1, name: 'Sky colour ball', codeBlocks: [COLOR_CODE] }));

async function newPage(base, path = '/', { userHdri = null } = {}) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = [];
  p.on('pageerror', e => p._errs.push(String(e)));
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://hdri.test/')) return req.respond({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: u.includes('teal') ? TEAL : SUNSET });
    if (u.endsWith('/api/backends')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: {}, default: null }) });
    req.continue();
  });
  if (userHdri) await p.evaluateOnNewDocument((u) => { if (!sessionStorage.getItem('__h')) { sessionStorage.setItem('__h', '1'); localStorage.setItem('gs-hdri-url', u); } }, userHdri);
  await p.setViewport({ width: 1280, height: 860 });
  await p.goto(base + path, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1000);
  return p;
}
const tab = (p, t) => p.click(`.dchat-tab[data-tab="${t}"]`).then(() => sleep(300));
// isHdri: the background is the equirect HDRI texture (what the checkbox promises).
const bg = (p) => p.evaluate(() => ({
  env: !!(scene.environment && scene.environment.isTexture),
  isHdri: !!(scene.background && scene.background.isTexture && scene.background.mapping === THREE.EquirectangularReflectionMapping),
  isColor: !!(scene.background && scene.background.isColor),
  box: document.getElementById('dchat-hdri-bg')?.checked,
  ball: !!scene.getObjectByName('ball'),
  late: !!window.__lateBg
}));
const waitBg = async (p, pred, ms = 15000) => { const t = Date.now(); let s; while (Date.now() - t < ms) { s = await bg(p); if (pred(s)) return s; await sleep(200); } return s; };
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/${name}.png` }); } };
const post = async (base, body) => (await fetch(`${base}/api/community-scenes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
// Loaded, then still the HDRI a few seconds later (scene code / late timers had their go).
async function expectHdriBg(p, label) {
  const s = await waitBg(p, x => x.env && x.ball);
  await sleep(3500);
  const later = await bg(p);
  ok(`${label}: HDRI is the background with no toggling (box checked)`, s.env && later.isHdri && !later.isColor && later.box === true, JSON.stringify(later));
  return later;
}

for (const [H, base] of HOSTS) {
  console.log(`\n== ${H} ${base}`);
  // 1. Upload from the editor: scene code sets a sky colour, HDRI URL loaded with "Use as background" on.
  const a = await newPage(base);
  await (await a.$('#scene-file-input')).uploadFile(SCENE);
  await tab(a, 'env');
  await a.type('#dchat-hdri-url', HDRI_URL);
  await a.click('#dchat-hdri-url-load');
  await expectHdriBg(a, `${H} editor, HDRI loaded after the scene`);
  const resP = a.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/community-scenes'), { timeout: 20000 });
  const posted = [];
  a.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/community-scenes')) posted.push(JSON.parse(r.postData())); });
  await tab(a, 'community');
  await a.evaluate(() => [...document.querySelectorAll('#dchat-community-buttons button')].find(x => x.textContent.trim() === 'Upload Current Scene').click());
  const up = await (await resP).json();
  ok(`${H} upload carries background:true`, posted[0]?.environmentHdri?.url === HDRI_URL && posted[0].environmentHdri.background === true, JSON.stringify(posted[0]?.environmentHdri));
  await a.browserContext().close();
  const NAME = `Sky colour ball ${H} ${Date.now()}`;
  await fetch(`${base}/api/community-scenes/${up.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: NAME }) });

  // 2. Fresh browsers: editor link, view link, Community list
  const e = await newPage(base, `/e/${up.id}`);
  await expectHdriBg(e, `${H} /e/:id`);
  await tab(e, 'env');
  await e.evaluate(() => document.getElementById('dchat-hdri')?.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await shot(e, `${H}-4-scene-sets-color-hdri-background-on-load`);
  // One click off -> the solid colour; one click on -> the HDRI again.
  await e.click('#dchat-hdri-bg'); await sleep(300);
  const off = await bg(e);
  ok(`${H} one click off shows no HDRI background`, !off.isHdri && off.box === false, JSON.stringify(off));
  await sleep(800);
  ok(`${H} ... and it stays off`, !(await bg(e)).isHdri);
  await e.click('#dchat-hdri-bg'); await sleep(300);
  const on = await bg(e);
  ok(`${H} one click on shows the HDRI again`, on.isHdri && on.box === true, JSON.stringify(on));
  await e.browserContext().close();

  const s = await newPage(base, `/s/${up.id}`);
  await expectHdriBg(s, `${H} /s/:id`);
  await shot(s, `${H}-5-view-link-scene-sets-color-hdri-background`);
  await s.browserContext().close();

  const c = await newPage(base);
  await tab(c, 'community'); await sleep(1500);
  const clicked = await c.evaluate((name) => {
    const row = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')].find(r => r.textContent.includes(name));
    const btn = row && [...row.querySelectorAll('button')].find(x => /^load$/i.test(x.textContent.trim()));
    if (btn) btn.click(); return !!btn;
  }, NAME);
  ok(`${H} Community list: Load`, clicked);
  await expectHdriBg(c, `${H} Community list load`);
  await c.browserContext().close();

  // 3. Scene code that sets its colour late (after the HDRI is up)
  const late = await post(base, { version: 1, name: 'Late sky ' + H, codeBlocks: [LATE_CODE], environmentHdri: { kind: 'url', url: HDRI_URL, format: 'hdr', background: true } });
  const l = await newPage(base, `/e/${late.id}`);
  const ls = await expectHdriBg(l, `${H} scene sets its colour 2 s later`);
  ok(`${H} ... the late timer did run`, ls.late);
  await l.browserContext().close();

  // 4. A scene without its own HDRI (all live scenes today) + the viewer's saved HDRI
  const legacy = await post(base, { version: 1, name: 'Legacy sky ' + H, codeBlocks: [COLOR_CODE] });
  const v = await newPage(base, `/e/${legacy.id}`, { userHdri: 'https://hdri.test/teal.hdr' });
  await expectHdriBg(v, `${H} legacy scene with the viewer's saved HDRI`);
  await shot(v, `${H}-6-legacy-scene-viewer-hdri-background`);
  ok(`${H} no page errors`, [e, s, c, l, v].every(x => !x._errs.length), [e, s, c, l, v].flatMap(x => x._errs).join(' | '));
  await v.browserContext().close();
}
await b.close();
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
