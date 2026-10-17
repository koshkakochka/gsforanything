import puppeteer from 'puppeteer-core';
import fs from 'fs';
const HOSTS = (process.env.HOSTS || 'vercel-sim=http://localhost:3601,cf-patched=http://localhost:3602,cf-unpatched=http://localhost:3603').split(',').map(s => s.split('='));
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'] });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); console.log(results.at(-1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAKE_KEY = 'sk-ant-api03-ZZZZtestKEYdoNOTuse1234567890abcdef';
const FILE_TEXT = `Design notes for the red cube game.\nThe cube should be 0.5m and sit on the floor.\nconst apiKey = "${FAKE_KEY}";\nScore starts at 0.`;
fs.writeFileSync('/tmp/design-notes.md', FILE_TEXT);

async function newPage(base, tag) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = []; p._chatBodies = [];
  p.on('pageerror', e => p._errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ollama|11434/i.test(m.text())) p._errs.push(m.text()); });
  await p.evaluateOnNewDocument(() => {
    window.__drawn = new Set();
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t, ...r) { if (typeof t === 'string' && t.length < 200) window.__drawn.add(t); return orig.call(this, t, ...r); };
  });
  await p.setRequestInterception(true);
  let n = 0;
  p.on('request', req => {
    const u = req.url();
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(req.postData()); p._chatBodies.push(body); n++;
      const color = n === 1 ? '0xff0000' : '0x0000ff';
      const code = `const m = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.5), new THREE.MeshStandardMaterial({color:${color}})); m.name='cube${n}'; m.position.set(0,0.25,-2); scene.add(m);`;
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: `Reply ${n} from the mock AI.\n\`\`\`vr-exec\n${code}\n\`\`\`` }] }) });
    }
    if (u.endsWith('/api/backends')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { 'claude-sonnet-55': { label: 'Claude Sonnet 5.5', provider: 'claude', available: true } }, default: 'claude-sonnet-55' }) });
    req.continue();
  });
  await p.setViewport(process.env.VIEWPORT === 'phone' ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 900 });
  await p.goto(base + (tag || '/'), { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  return p;
}
async function tab(p, t) { await p.click(`.dchat-tab[data-tab="${t}"]`); await sleep(300); }
async function send(p, text) {
  await tab(p, 'chat');
  await p.click('#desktop-chat-input', { clickCount: 3 });
  await p.type('#desktop-chat-input', text);
  const before = p._chatBodies.length;
  await p.click('#desktop-send-button');
  for (let i = 0; i < 40 && p._chatBodies.length === before; i++) await sleep(150);
  await sleep(1200);
  return p._chatBodies.at(-1);
}
async function action(p, mountSel, act) {
  await p.evaluate((sel, a) => { const el = document.querySelector(`${sel} [data-action="${a}"]`); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, mountSel, act);
}
async function chatText(p) { return p.evaluate(() => [...document.querySelectorAll('#desktop-chat-messages .dchat-msg')].map(e => ({ cls: e.className, t: e.textContent }))); }

for (const [hostName, base] of HOSTS) {
  const H = `[${hostName}]`;
  // ---------- Author session ----------
  const a = await newPage(base);
  await a.evaluate(() => localStorage.removeItem('gs.publishCreationContext'));
  ok(`${H} 📜 button injected`, await a.$('#gs-ctx-history-btn') !== null);
  await tab(a, 'chat');
  const input = await a.$('#desktop-attach-input');
  await input.uploadFile('/tmp/design-notes.md');
  await sleep(500);
  const b1 = await send(a, 'make a red cube on the floor');
  ok(`${H} first chat sent with attachment`, /--- File: design-notes\.md ---/.test(JSON.stringify(b1.messages)));
  await send(a, 'now add a blue cube');
  // Code tab apply -> edit history
  // Since 0.973 Apply hot-reloads only changed blocks (an unchanged Apply is a no-op),
  // so make a real edit before applying.
  await tab(a, 'code');
  await a.evaluate(() => { const ed = document.getElementById('dchat-code-editor'); ed.value = ed.value.replace("m.name='cube2'; m.position.set(0,0.25,-2)", "m.name='cube2'; m.position.set(0.6,0.25,-2)"); ed.dispatchEvent(new Event('input', { bubbles: true })); });
  await a.click('#dchat-code-apply'); await sleep(1200);
  const dbg = await a.evaluate(() => GSContext._debugState());
  ok(`${H} session log recorded`, dbg.chatLog >= 4 && dbg.files === 1 && dbg.edits >= 1, JSON.stringify(dbg));

  // Publish (with context, default) via Community -> Upload
  await tab(a, 'community');
  await action(a, '#dchat-community-buttons', 'community:upload');
  await a.waitForSelector('#gs-ctx-publish.visible', { timeout: 5000 });
  await sleep(800);
  const dlg = await a.evaluate(() => ({ inc: document.getElementById('gs-ctx-include').checked, files: document.getElementById('gs-ctx-include-files').checked, list: document.getElementById('gs-ctx-share-list').innerText, warn: document.getElementById('gs-ctx-warn').innerText }));
  ok(`${H} publish dialog defaults to include`, dlg.inc && dlg.files, JSON.stringify(dlg).slice(0, 400));
  ok(`${H} publish dialog lists what is shared`, /Chat log: 4 messages \(2 prompts\)/.test(dlg.list) && /design-notes\.md/.test(dlg.list) && /code edit/.test(dlg.list), dlg.list.replace(/\n/g, ' | '));
  ok(`${H} publish dialog warns about redacted secret`, /1 secret-looking value \(Anthropic API key\)/.test(dlg.warn), dlg.warn);
  await a.click('#gs-ctx-preview-btn'); await sleep(400);
  const prev = await a.evaluate(() => { const v = document.getElementById('gs-ctx-viewer'); v.querySelector('[data-tab="files"]').click(); return v.innerText; });
  ok(`${H} preview viewer opens`, /Preview: creation context to publish/.test(prev) && /design-notes\.md/.test(prev));
  await a.evaluate(() => GSContext.closeViewer());
  const upResP = a.waitForResponse(r => r.url().endsWith('/api/community-scenes') && r.request().method() === 'POST');
  await a.click('#gs-ctx-publish-btn');
  const upRes = await (await upResP).json();
  const reqBody = JSON.parse((await upResP).request().postData());
  ok(`${H} upload carried compressed context`, reqBody.creationContext?.encoding === 'gzip-base64' && reqBody.creationContext.data.length > 100, `${reqBody.creationContext?.data.length} chars`);
  ok(`${H} raw upload has no plaintext key`, !JSON.stringify(reqBody).includes(FAKE_KEY));
  const id = upRes.id || upRes.scene?.id;
  await sleep(500);
  const shareVisible = await a.evaluate(() => document.getElementById('share-modal').classList.contains('visible'));
  ok(`${H} published, share modal shown`, !!id && shareVisible, id);
  await a.evaluate(() => document.getElementById('share-close-btn').click());

  // Storage shape
  const rec = await a.evaluate(async (id) => (await fetch(`/api/community-scenes/${id}`)).json(), id);
  const ctxRes = await a.evaluate(async (id) => { const r = await fetch(`/api/community-scenes/${id}/context`); return { status: r.status, body: r.ok ? await r.json() : null }; }, id);
  if (hostName === 'cf-unpatched') {
    ok(`${H} unpatched host keeps context inline`, !!rec.creationContext?.data && ctxRes.status === 404);
  } else {
    ok(`${H} scene record holds only a stub`, rec.creationContext?.stored === 'separate' && !rec.creationContext.data && rec.creationContext.url === `/api/community-scenes/${id}/context`, JSON.stringify(rec.creationContext).slice(0, 200));
    ok(`${H} context endpoint returns envelope`, ctxRes.status === 200 && ctxRes.body?.format === 'gs-creation-context' && ctxRes.body.data.length > 100);
  }
  // Decoded payload is scrubbed
  const dec = await a.evaluate(async (env) => { const bytes = Uint8Array.from(atob(env.data), c => c.charCodeAt(0)); const txt = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); return JSON.parse(txt); }, ctxRes.body || rec.creationContext);
  ok(`${H} stored payload: chat, model, timestamps, file, settings, edits`, dec.chat.filter(e => e.kind === 'message').length === 4 && dec.chat[0].model === 'Claude Sonnet 5.5' && dec.chat[0].backend === 'claude-sonnet-55' && !!dec.chat[0].ts && dec.files[0]?.name === 'design-notes.md' && /Score starts at 0/.test(dec.files[0].text) && dec.settings?.environment?.lib === 'three' && dec.settings.dependencies.some(d => d.id === 'ammo') && dec.editHistory.length >= 1 && /GS editor settings/.test(dec.settingsNote));
  ok(`${H} stored file has key redacted`, !JSON.stringify(dec).includes(FAKE_KEY) && /\[REDACTED Anthropic API key\]/.test(dec.files[0].text));

  // Opt-out publish
  await tab(a, 'community');
  await action(a, '#dchat-community-buttons', 'community:upload');
  await a.waitForSelector('#gs-ctx-publish.visible'); await sleep(500);
  await a.click('#gs-ctx-include'); await sleep(300);
  const optList = await a.evaluate(() => document.getElementById('gs-ctx-share-list').innerText);
  ok(`${H} opt-out shows only the scene is shared`, /Only the scene/.test(optList), optList);
  const optP = a.waitForResponse(r => r.url().endsWith('/api/community-scenes') && r.request().method() === 'POST');
  await a.click('#gs-ctx-publish-btn');
  const optResp = await optP; const optBody = JSON.parse(optResp.request().postData()); const optId = (await optResp.json()).id;
  ok(`${H} opt-out upload has no context`, !optBody.creationContext && optBody.creationContextOmitted === true);
  await a.evaluate(() => document.getElementById('share-close-btn').click());
  const pref = await a.evaluate(() => localStorage.getItem('gs.publishCreationContext'));
  ok(`${H} publish choice remembered`, /"include":false/.test(pref || ''), pref);

  // Save to server slot (Export)
  await tab(a, 'scenes');
  await action(a, '#dchat-scenes-buttons', 'scenes:export');
  await sleep(300);
  await a.evaluate(() => { document.getElementById('export-name').value = 'Saved Cubes'; });
  const saveP = a.waitForResponse(r => r.url().endsWith('/api/save-scene'));
  await a.click('#export-confirm-btn');
  const saveBody = JSON.parse((await saveP).request().postData());
  ok(`${H} Export (save) includes context`, saveBody.creationContext?.encoding === 'gzip-base64');
  ok(`${H} no page errors (author)`, a._errs.length === 0, a._errs.slice(0, 3).join(' | '));
  await a.browserContext().close();

  // Legacy scene (no context)
  const legacyId = await (async () => {
    const r = await fetch(base + '/api/community-scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, name: 'Legacy Scene', createdAt: '2026-10-01T00:00:00Z', thumbnail: '', codeBlocks: ["const m = new THREE.Mesh(new THREE.SphereGeometry(0.3), new THREE.MeshStandardMaterial()); m.name='legacyBall'; scene.add(m);"] }) });
    return (await r.json()).id;
  })();

  // ---------- Fresh visitor: reload, open from Community ----------
  const v = await newPage(base);
  await tab(v, 'community');
  await sleep(1500);
  const names = await v.evaluate(() => [...document.querySelectorAll('#dchat-community-list .dchat-scene-name')].map(e => e.textContent));
  ok(`${H} community list shows scenes`, names.includes('Legacy Scene'), names.join(', '));
  // Load the published scene (rows are newest first: legacy, opt-out, with-context)
  const loadRow = async (sceneId) => {
    await tab(v, 'community');
    await v.evaluate((sid) => {
      const rows = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')];
      const row = rows.find(r => r.querySelector('.dchat-scene-name').title.includes(sid));
      row.querySelector('.dchat-btn').click();
    }, sceneId);
    await sleep(2500);
  };
  await loadRow(id);
  let msgs = await chatText(v);
  const marker = msgs.find(m => /history-marker/.test(m.cls) && /Creation history for/.test(m.t));
  ok(`${H} chat restored with history marker`, !!marker && /design-notes\.md/.test(marker.t) && /Claude Sonnet 5\.5/.test(marker.t), marker?.t.slice(0, 300));
  ok(`${H} restored prompts + replies shown as history`, msgs.some(m => /history/.test(m.cls) && /make a red cube on the floor/.test(m.t)) && msgs.some(m => /history/.test(m.cls) && /Reply 2 from the mock AI/.test(m.t)));
  const scObj = await v.evaluate(() => !!(window.__drawn && true));
  const drawn = await v.evaluate(() => [...window.__drawn]);
  ok(`${H} VR chat canvas draws history`, drawn.includes('Creation history') && drawn.includes('You (history)'), drawn.filter(t => /history/i.test(t)).join(','));
  // Viewer from 📜 button
  await tab(v, 'chat'); await v.click('#gs-ctx-history-btn'); await sleep(400);
  const viewer = await v.evaluate(() => { const r = document.getElementById('gs-ctx-viewer'); const chat = r.innerText; r.querySelector('[data-tab="files"]').click(); const filesTxt = r.innerText; r.querySelector('[data-tab="settings"]').click(); const set = r.innerText; r.querySelector('[data-tab="edits"]').click(); const ed = r.innerText; return { chat, filesTxt, set, ed, opts: [...r.querySelectorAll('option')].map(o => o.textContent) }; });
  ok(`${H} viewer: chat log`, /make a red cube on the floor/.test(viewer.chat) && /Claude Sonnet 5\.5/.test(viewer.chat), viewer.opts.join(' / '));
  ok(`${H} viewer: files + settings + edits`, /design-notes\.md/.test(viewer.filesTxt) && /Download/.test(viewer.filesTxt) && /Environment: 3D \/ three/.test(viewer.set) && /ammo/.test(viewer.set) && /Apply/.test(viewer.ed));
  await v.evaluate(() => GSContext.closeViewer());
  // Continue chat -> history sent
  const cont = await send(v, 'make the red cube spin');
  const ms = cont.messages;
  const roles = ms.map(m => m.role).join(',');
  const alternates = ms.every((m, i) => i === 0 ? m.role === 'user' : m.role !== ms[i - 1].role);
  ok(`${H} continuing sends history to AI`, /GS creation history/.test(ms[0].content) && /make a red cube on the floor/.test(ms[0].content) && /--- File: design-notes\.md ---/.test(ms[0].content) && ms.some(m => m.role === 'assistant' && /Reply 1 from the mock AI[\s\S]*vr-exec/.test(m.content)) && /make the red cube spin$/.test(ms.at(-1).content), roles);
  ok(`${H} history roles alternate, start with user`, alternates, roles);
  ok(`${H} continued history keeps key redacted`, !JSON.stringify(ms).includes(FAKE_KEY));
  const cubes = await v.evaluate(() => ['cube1', 'cube2'].map(n => !!window.__gsSceneHas?.(n)));
  // Opt-out scene
  await loadRow(optId);
  msgs = await chatText(v);
  ok(`${H} opt-out scene loads with "no context" note`, msgs.some(m => /published without its creation context/.test(m.t)));
  // Legacy
  await loadRow(legacyId);
  msgs = await chatText(v);
  const legacyOk = await v.evaluate(() => { let f = false; window.__three_scene_check = 0; return true; });
  ok(`${H} legacy scene loads (no history added, no errors)`, !msgs.some(m => /Legacy Scene/.test(m.t)) && v._errs.length === 0, v._errs.slice(0, 3).join(' | '));
  ok(`${H} no page errors (visitor)`, v._errs.length === 0, v._errs.slice(0, 3).join(' | '));
  await v.browserContext().close();

  // ---------- /e/:id share link + saved-slot load ----------
  const e = await newPage(base, `/e/${id}`);
  await sleep(2500);
  msgs = await chatText(e);
  ok(`${H} /e/:id link restores history`, msgs.some(m => /Creation history for/.test(m.t)));
  await tab(e, 'scenes');
  await action(e, '#dchat-scenes-buttons', 'scenes:loadSaved');
  await sleep(2500);
  msgs = await chatText(e);
  ok(`${H} same history isn't added twice in one chat`, msgs.some(m => /creation history of "Saved Cubes" is already in this chat/.test(m.t)) && msgs.filter(m => /make a red cube on the floor/.test(m.t)).length === 1);
  const ls = await newPage(base);
  await tab(ls, 'scenes');
  await action(ls, '#dchat-scenes-buttons', 'scenes:loadSaved');
  await sleep(2500);
  msgs = await chatText(ls);
  ok(`${H} Load Saved (fresh page) restores history of saved scene`, msgs.some(m => /Creation history for "Saved Cubes"/.test(m.t)) && msgs.some(m => /make a red cube on the floor/.test(m.t)));
  const lsBody = await send(ls, 'continue the saved one');
  ok(`${H} continuing a saved scene sends its history`, /GS creation history/.test(lsBody.messages[0].content) && lsBody.messages.length >= 5);
  await ls.browserContext().close();
  const sv = await newPage(base, `/s/${id}`); await sleep(2000);
  msgs = await chatText(sv);
  ok(`${H} display-only /s/:id does not inject history`, !msgs.some(m => /Creation history/.test(m.t)));
  ok(`${H} no page errors (share links)`, e._errs.length === 0 && sv._errs.length === 0, [...e._errs, ...sv._errs].slice(0, 3).join(' | '));
  await e.browserContext().close(); await sv.browserContext().close();
}
await b.close();
const fails = results.filter(r => r.startsWith('FAIL'));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
fs.writeFileSync('results.txt', results.join('\n') + `\n${results.length - fails.length}/${results.length} passed\n`);
