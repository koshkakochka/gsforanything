// Browser end-to-end: exactly one active scene. Loading a Community scene,
// a share link, a scene file or a merge replaces the scene in the world AND
// its chat history; nothing is layered or stacked. Exports, Share link and
// Community publish use only the active scene.
//   node ../creation-context/vercel-sim.mjs &        (SIM_PORT, default 3601)
//   HOSTS=vercel-sim=http://localhost:3601 SHOTS=/dir node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import zlib from 'zlib';
const HOSTS = (process.env.HOSTS || 'vercel-sim=http://localhost:3601').split(',').map(s => s.split('='));
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'] });
let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/${name}.png` }); } };

// Mock AI: "make <name> <shape>" -> a mesh called <name>. Optional delay so a
// reply can land after the scene changed.
async function newPage(base, path = '/', { viewport = { width: 1280, height: 900 }, chatDelay = 0 } = {}) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = []; p._chatBodies = []; p._posts = [];
  p.on('pageerror', e => p._errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ollama|11434/i.test(m.text())) p._errs.push(m.text()); });
  await p.setRequestInterception(true);
  p.on('request', async req => {
    const u = req.url();
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(req.postData()); p._chatBodies.push(body);
      const last = [...body.messages].reverse().find(m => m.role === 'user');
      const text = typeof last.content === 'string' ? last.content : (last.content.find?.(c => c.type === 'text')?.text || '');
      const name = (text.match(/make (\w+)/) || [, 'thing'])[1];
      const geo = /sphere/.test(text) ? 'SphereGeometry(0.3, 16, 8)' : 'BoxGeometry(0.4,0.4,0.4)';
      const code = `const m = new THREE.Mesh(new THREE.${geo}, new THREE.MeshStandardMaterial({color:0x44aaff})); m.name='${name}'; m.position.set(0,0.5,-2); scene.add(m);`;
      if (p._chatDelay) await sleep(p._chatDelay);
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: `Made ${name}.\n\`\`\`vr-exec\n${code}\n\`\`\`` }] }) });
    }
    if (u.endsWith('/api/backends')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { 'claude-sonnet-55': { label: 'Claude Sonnet 5.5', provider: 'claude', available: true } }, default: 'claude-sonnet-55' }) });
    if (req.method() === 'POST' && u.endsWith('/api/community-scenes')) p._posts.push(JSON.parse(req.postData()));
    req.continue();
  });
  p._chatDelay = chatDelay;
  await p.setViewport(viewport);
  await p.goto(base + path, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1800);
  return p;
}
const tab = (p, t) => p.click(`.dchat-tab[data-tab="${t}"]`).then(() => sleep(300));
async function send(p, text, { wait = true } = {}) {
  await tab(p, 'chat');
  await p.click('#desktop-chat-input', { clickCount: 3 });
  await p.type('#desktop-chat-input', text);
  const before = p._chatBodies.length;
  await p.click('#desktop-send-button');
  for (let i = 0; i < 40 && p._chatBodies.length === before; i++) await sleep(100);
  if (wait) await sleep(1200);
}
const chat = (p) => p.evaluate(() => [...document.querySelectorAll('#desktop-chat-messages .dchat-msg')].map(e => e.textContent));
const objs = (p, names) => p.evaluate((names) => Object.fromEntries(names.map(nm => [nm, !!scene.getObjectByName(nm)])), names);
const state = (p) => p.evaluate(() => ({
  card: document.getElementById('dchat-current-scene')?.textContent || '',
  code: document.getElementById('dchat-code-editor')?.value || '',
  ctx: GSContext._debugState(),
  loaded: GSContext.getLoadedContexts().map(c => c.sceneName),
  status: document.getElementById('status')?.textContent || ''
}));
async function publish(p) {
  await p.evaluate(() => localStorage.setItem('gs.publishCreationContext', JSON.stringify({ include: true, files: true })));
  await tab(p, 'community');
  const resP = p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/community-scenes'), { timeout: 20000 });
  await p.evaluate(() => document.querySelector('#dchat-community-buttons [data-action="community:upload"]').click());
  await p.waitForSelector('#gs-ctx-publish.visible', { timeout: 8000 });
  await sleep(300);
  await p.click('#gs-ctx-publish-btn');
  const res = await resP; const data = await res.json();
  await sleep(800);
  await p.evaluate(() => document.getElementById('share-close-btn')?.click());
  return data.id || data.scene?.id;
}
async function unpackCtx(base, posted) {
  let env = posted.creationContext;
  if (!env) return null;
  if (!env.data && env.url) env = await (await fetch(base + env.url)).json();
  return env.encoding === 'json' ? env.data : JSON.parse(zlib.gunzipSync(Buffer.from(env.data, 'base64')).toString());
}
async function loadFromCommunity(p, id, { wait = true } = {}) {
  await tab(p, 'community');
  // The list row's Load button for this id (the list refreshes on tab open).
  for (let i = 0; i < 40; i++) {
    const found = await p.evaluate((id) => !!document.querySelector('#dchat-community-list .dchat-scene-item'), id);
    if (found) break; await sleep(150);
  }
  const clicked = await p.evaluate((id) => {
    const rows = [...document.querySelectorAll('#dchat-community-list .dchat-scene-item')];
    const row = rows.find(r => (r.querySelector('.dchat-scene-name')?.title || '').includes(`(${id})`));
    const btn = row && [...row.querySelectorAll('button')].find(x => x.textContent.trim() === 'Load');
    if (btn) btn.click(); return !!btn;
  }, id);
  if (wait) await sleep(2500);
  return clicked;
}

async function importScene(p, name, objName) {
  const file = `/tmp/gs-single-${objName}.vrscene`;
  fs.writeFileSync(file, JSON.stringify({ version: 1, name, codeBlocks: [`const g = new THREE.Mesh(new THREE.BoxGeometry(0.2,0.2,0.2), new THREE.MeshStandardMaterial()); g.name='${objName}'; g.position.set(1,0.1,-2); scene.add(g);`] }));
  await (await p.$('#scene-file-input')).uploadFile(file);
  await sleep(1200);
}

for (const [hostName, base] of HOSTS) {
  const H = `[${hostName}]`;
  // ---------- Two authors publish scene A and scene B ----------
  const a = await newPage(base);
  await importScene(a, 'Scene Alpha', 'alphaBase');
  await send(a, 'make alphaBox please');
  const idA = await publish(a);
  const b1 = await newPage(base);
  await importScene(b1, 'Scene Beta', 'betaBase');
  await send(b1, 'make betaSphere sphere please');
  const idB = await publish(b1);
  ok(`${H} published scene A and B`, !!idA && !!idB, `${idA} ${idB}`);
  await a.browserContext().close(); await b1.browserContext().close();

  // ---------- Viewer: no layer UI ----------
  const v = await newPage(base);
  await tab(v, 'scenes');
  const ui = await v.evaluate(() => ({
    loadMode: !!document.getElementById('dchat-community-loadmode'),
    layerBtn: [...document.querySelectorAll('button')].some(x => /^(Layer|Clear first|Export Combined|Import Folder)$/.test(x.textContent.trim())),
    layerActions: !!document.querySelector('[data-action^="community:loadMode"],[data-action="scenes:exportCombined"],[data-action="scenes:importFolder"]'),
    folderInput: !!document.getElementById('scene-folder-input'),
    multiFile: document.getElementById('scene-file-input')?.multiple,
    oldList: !!document.getElementById('dchat-scene-list'),
    combinedMount: !!document.getElementById('dchat-export-combined-mount'),
    checkboxes: document.querySelectorAll('#dchat-current-scene input[type=checkbox]').length,
    removeBtns: document.querySelectorAll('.dchat-scene-remove').length,
    card: document.getElementById('dchat-current-scene')?.textContent || '',
    globals: ['loadedScenes', 'communityLoadMode'].filter(k => k in window)
  }));
  ok(`${H} no layer UI (load mode, Layer/Clear first, Export Combined, Import Folder, checkboxes, ×)`,
    !ui.loadMode && !ui.layerBtn && !ui.layerActions && !ui.folderInput && ui.multiFile === false && !ui.oldList && !ui.combinedMount && ui.checkboxes === 0 && ui.removeBtns === 0, JSON.stringify(ui));
  ok(`${H} Scenes tab shows an empty current scene`, /Empty scene/.test(ui.card), ui.card);
  await shot(v, `${hostName}-1-empty-scenes-tab`);
  await tab(v, 'community'); await sleep(800);
  await shot(v, `${hostName}-2-community-tab`);

  // ---------- Load A then B ----------
  ok(`${H} Load A clicked`, await loadFromCommunity(v, idA));
  let o = await objs(v, ['alphaBox', 'alphaBase', 'betaSphere', 'betaBase']); let c = await chat(v); let s = await state(v);
  ok(`${H} after A: only A's objects`, o.alphaBox && o.alphaBase && !o.betaSphere && !o.betaBase, JSON.stringify(o));
  ok(`${H} after A: A's chat history`, c.some(t => /make alphaBox/.test(t)) && !c.some(t => /betaSphere/.test(t)), c.join(' | ').slice(0, 300));
  await tab(v, 'chat'); await shot(v, `${hostName}-3-after-A-chat`);

  ok(`${H} Load B clicked`, await loadFromCommunity(v, idB));
  o = await objs(v, ['alphaBox', 'alphaBase', 'betaSphere', 'betaBase']); c = await chat(v); s = await state(v);
  ok(`${H} after B: only B's objects (A's removed)`, !o.alphaBox && !o.alphaBase && o.betaSphere && o.betaBase, JSON.stringify(o));
  ok(`${H} after B: only B's chat history (no A, not stacked)`, c.some(t => /make betaSphere/.test(t)) && !c.some(t => /alpha/i.test(t)) && c.filter(t => /Creation history for/.test(t)).length === 1 && c.some(t => /Creation history for "Scene Beta"/.test(t)), c.join(' | ').slice(0, 400));
  ok(`${H} after B: one loaded context, session log is B's`, s.loaded.length === 1 && s.loaded[0] === 'Scene Beta' && s.ctx.loaded.length === 1 && s.ctx.chatLog === 2, JSON.stringify({ loaded: s.loaded, ctx: s.ctx }));
  ok(`${H} after B: Code tab has only B's code`, /betaSphere/.test(s.code) && /betaBase/.test(s.code) && !/alpha/.test(s.code), s.code.slice(0, 200));
  ok(`${H} after B: Scenes card names B only`, /^Scene Beta/.test(s.card) && /Current scene · 2 blocks/.test(s.card) && !/Alpha/.test(s.card), s.card);
  const rowActive = await v.evaluate(() => [...document.querySelectorAll('#dchat-community-list .dchat-scene-item.active')].map(r => r.querySelector('.dchat-scene-name')?.title || ''));
  ok(`${H} only B's Community row is marked active`, rowActive.length === 1 && rowActive[0].includes(idB), JSON.stringify(rowActive));
  await tab(v, 'chat'); await shot(v, `${hostName}-4-after-B-chat`);
  await tab(v, 'scenes'); await shot(v, `${hostName}-5-after-B-scenes-tab`);

  // Next chat continues B only.
  await send(v, 'make gammaCube please');
  const body = v._chatBodies.at(-1);
  const sent = JSON.stringify(body.messages);
  ok(`${H} next chat request carries only B's history`, /betaSphere/.test(sent) && !/alphaBox/.test(sent), sent.slice(0, 200));
  o = await objs(v, ['alphaBox', 'betaSphere', 'gammaCube']);
  ok(`${H} chat adds to the active scene`, o.betaSphere && o.gammaCube && !o.alphaBox, JSON.stringify(o));

  // ---------- Exports against the single active scene ----------
  const ex = await v.evaluate(async () => {
    const out = {};
    for (const f of ['glb', 'gltf', 'fbx', 'obj', 'blender']) {
      try { const r = await gsSceneExport.exportNow(f); out[f] = { name: r.filename, size: r.blob.size, meshes: r.result.meshCount }; }
      catch (e) { out[f] = { err: e.message }; }
    }
    const gltf = await gsSceneExport.exportGLTF();
    const txt = await gltf.blob.text();
    out.gltfNames = { beta: txt.includes('betaSphere'), gamma: txt.includes('gammaCube'), alpha: txt.includes('alphaBox') };
    return out;
  });
  ok(`${H} GLB/glTF/FBX/OBJ/Blender exports produce files`, ['glb', 'gltf', 'fbx', 'obj', 'blender'].every(f => ex[f].size > 100 && ex[f].meshes >= 3), JSON.stringify(ex));
  ok(`${H} export file names use the active scene's name`, ex.glb.name === 'Scene Beta.glb' && ex.blender.name === 'Scene Beta (Blender).zip', ex.glb.name);
  ok(`${H} glTF contains B + chat objects, not A`, ex.gltfNames.beta && ex.gltfNames.gamma && !ex.gltfNames.alpha, JSON.stringify(ex.gltfNames));
  // .vrscene Save to Device
  const vr = await v.evaluate(async () => {
    const blobs = []; const orig = URL.createObjectURL; URL.createObjectURL = (bl) => { blobs.push(bl); return orig.call(URL, bl); };
    document.querySelector('#dchat-scenes-buttons [data-action="scenes:export"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const name = document.getElementById('export-name').value;
    document.getElementById('export-download-btn').click();
    await new Promise(r => setTimeout(r, 1500));
    URL.createObjectURL = orig;
    const j = blobs.length ? JSON.parse(await blobs.at(-1).text()) : null;
    return { name, blocks: j?.codeBlocks?.length, hasA: JSON.stringify(j?.codeBlocks || []).includes('alphaBox'), hasB: JSON.stringify(j?.codeBlocks || []).includes('betaSphere'), ctx: !!j?.creationContext };
  });
  ok(`${H} Save to Device .vrscene = B + chat blocks only, with context`, vr.name === 'Scene Beta' && vr.blocks === 3 && vr.hasB && !vr.hasA && vr.ctx, JSON.stringify(vr));
  // Community publish of the active scene: its code + only its history.
  const idC = await publish(v);
  const post = v._posts.at(-1);
  const payload = await unpackCtx(base, post);
  const pj = JSON.stringify(payload?.chat || []);
  ok(`${H} publish: B's code + chat code only`, !!idC && post.name === 'Scene Beta' && post.codeBlocks.length === 3 && !JSON.stringify(post.codeBlocks).includes('alphaBox'), String(post.codeBlocks.length));
  ok(`${H} publish: creation context has B's + new chat, none of A's`, /betaSphere/.test(pj) && /gammaCube/.test(pj) && !/alphaBox/.test(pj) && (payload.origins || []).length === 1, JSON.stringify(payload?.origins));
  // Share link of an unchanged loaded scene reuses its id.
  await loadFromCommunity(v, idB);
  const postsBefore = v._posts.length;
  await v.evaluate(() => document.querySelector('#dchat-share [data-share="link"]').click());
  await sleep(1500);
  const shareUrl = await v.evaluate(() => document.getElementById('share-url')?.value || '');
  await v.evaluate(() => document.getElementById('share-close-btn')?.click());
  ok(`${H} Share link of the loaded B points at B (no re-upload)`, shareUrl.includes(idB) && v._posts.length === postsBefore, shareUrl);
  ok(`${H} reloading B resets chat-built code (gammaCube gone)`, !(await objs(v, ['gammaCube'])).gammaCube);

  // ---------- Race: A then B clicked back to back -> B only ----------
  await loadFromCommunity(v, idA, { wait: false });
  await loadFromCommunity(v, idB, { wait: false });
  await sleep(3500);
  o = await objs(v, ['alphaBox', 'betaSphere']); c = await chat(v);
  ok(`${H} rapid A→B: B only (objects)`, !o.alphaBox && o.betaSphere, JSON.stringify(o));
  ok(`${H} rapid A→B: B only (chat)`, !c.some(t => /alpha/i.test(t)) && c.filter(t => /Creation history for/.test(t)).length === 1, c.join(' | ').slice(0, 300));

  // ---------- A chat reply that lands after a scene change is dropped ----------
  v._chatDelay = 2500;
  await send(v, 'make lateCube please', { wait: false });
  await loadFromCommunity(v, idA, { wait: false });
  await sleep(4500);
  v._chatDelay = 0;
  o = await objs(v, ['alphaBox', 'betaSphere', 'lateCube']); c = await chat(v);
  ok(`${H} late reply for the old scene is dropped`, o.alphaBox && !o.betaSphere && !o.lateCube && !c.some(t => /lateCube|betaSphere/.test(t)), JSON.stringify(o) + ' ' + c.join(' | ').slice(0, 200));

  // ---------- Scene file import replaces too ----------
  fs.writeFileSync('/tmp/gs-single-file.vrscene', JSON.stringify({ version: 1, name: 'File Scene', codeBlocks: ["const m = new THREE.Mesh(new THREE.TorusGeometry(0.3,0.1,8,16), new THREE.MeshStandardMaterial()); m.name='fileTorus'; scene.add(m);"] }));
  const input = await v.$('#scene-file-input');
  await input.uploadFile('/tmp/gs-single-file.vrscene');
  await sleep(1500);
  o = await objs(v, ['alphaBox', 'fileTorus']); c = await chat(v); s = await state(v);
  ok(`${H} file import replaces the scene`, !o.alphaBox && o.fileTorus, JSON.stringify(o));
  ok(`${H} file import resets chat to the welcome message`, c.length === 1 && /VR Code Assistant ready/.test(c[0]) && s.ctx.chatLog === 0 && s.loaded.length === 0, c.join(' | '));
  ok(`${H} Scenes card shows the file scene`, /File Scene/.test(s.card), s.card);
  await tab(v, 'scenes'); await shot(v, `${hostName}-6-file-scene`);

  // ---------- Clear scene = blank scene + fresh chat ----------
  await send(v, 'make deltaBox please');
  await v.evaluate(() => document.querySelector('#dchat-scenes-buttons [data-action="scenes:clear"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(300);
  // Clear asks with GS's in-app confirm (gsDialog.js, 0.988), not window.confirm.
  const clearAsk = await v.evaluate(() => window.gsDialogs?.current()?.message || '');
  ok(`${H} Clear scene asks with the in-app confirm (says chat history goes too)`, /chat history/.test(clearAsk) && !/stay in the list/.test(clearAsk), clearAsk);
  await v.evaluate(() => document.querySelector('#gs-dialog [data-gs-dialog=ok]')?.click());
  await sleep(600);
  o = await objs(v, ['fileTorus', 'deltaBox']); c = await chat(v); s = await state(v);
  ok(`${H} Clear scene empties the world, chat and card`, !o.fileTorus && !o.deltaBox && c.length === 1 && /Empty scene/.test(s.card) && !s.code.trim(), JSON.stringify({ o, c: c.length, card: s.card }));
  ok(`${H} no page errors`, v._errs.length === 0, v._errs.join(' | ').slice(0, 400));
  await v.browserContext().close();

  // ---------- Share link (/e/:id) opens one scene ----------
  const e = await newPage(base, `/e/${idA}`);
  await sleep(1500);
  o = await objs(e, ['alphaBox', 'betaSphere']); c = await chat(e);
  ok(`${H} /e/A: A's scene + A's history only`, o.alphaBox && !o.betaSphere && c.some(t => /make alphaBox/.test(t)) && !c.some(t => /beta/i.test(t)), JSON.stringify(o));
  await loadFromCommunity(e, idB);
  o = await objs(e, ['alphaBox', 'betaSphere']); c = await chat(e);
  ok(`${H} /e/A then Community B: B only`, !o.alphaBox && o.betaSphere && !c.some(t => /alpha/i.test(t)), JSON.stringify(o));
  ok(`${H} share page: no page errors`, e._errs.length === 0, e._errs.join(' | ').slice(0, 400));
  await e.browserContext().close();

  // ---------- Phone viewport: same, plus screenshot ----------
  const ph = await newPage(base, '/', { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await loadFromCommunity(ph, idA); await loadFromCommunity(ph, idB);
  o = await objs(ph, ['alphaBox', 'betaSphere']); c = await chat(ph);
  ok(`${H} phone: A then B leaves only B (objects + chat)`, !o.alphaBox && o.betaSphere && !c.some(t => /alpha/i.test(t)), JSON.stringify(o));
  await tab(ph, 'scenes'); await shot(ph, `${hostName}-7-phone-scenes-tab`);
  await tab(ph, 'chat'); await shot(ph, `${hostName}-8-phone-chat`);
  await ph.browserContext().close();
}
await b.close();
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
