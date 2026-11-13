// In-app pop-ups (site-source/gsDialog.js) instead of the browser's
// alert / confirm / prompt. Any native dialog during the run is a failure.
//   npm i && BASE=http://localhost:3611 node test.mjs     (any GS server)
//   SHOT_DIR=/some/dir  ONLY=static,desktop,phone,vr
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3611';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-modals-shots';
const ONLY = process.env.ONLY || '';
const want = (n) => !ONLY || ONLY.split(',').includes(n);
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };
const BOX = "const m = new THREE.Mesh(new THREE.BoxGeometry(0.4,0.4,0.4), new THREE.MeshStandardMaterial({color:0xff5533})); m.name='dlgBox'; m.position.set(0,1.2,-2.5); scene.add(m);";
const SRC = new URL('../../site-source/', import.meta.url);

// ---------------------------------------------------------------- static scan
if (want('static')) {
  const files = ['main.js', 'chatPrompt.js', 'vrWindows.js', 'htmlInCanvas.js', 'communityMerge.js', 'creationContext.js', 'exporter.js', 'p5Import.js', 'cameraControls.js', 'originGizmo.js', 'twinSticks.js', 'menuSystem.js', 'syntaxHighlight.js', 'sceneHdri.js', 'version.js', 'index.html'];
  const hits = [];
  for (const f of files) {
    let text = fs.readFileSync(new URL(f, SRC), 'utf8');
    // index.html: only its inline <script> code, not CSS comments or labels.
    if (f.endsWith('.html')) text = text.replace(/<script[^>]*>([\s\S]*?)<\/script>|[^]/g, (m, js) => (js != null ? js : (m === '\n' ? '\n' : '')));
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/\bprompt\(s\)/g, '');
      if (/(^|[^.\w$])(window\.|globalThis\.|self\.)?(alert|confirm|prompt)\s*\(/.test(code) && !/window\.alert = function/.test(code)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
      if (/onbeforeunload|['"]beforeunload['"]/.test(code)) hits.push(`${f}:${i + 1}: beforeunload`);
    });
  }
  ok('static: no native alert/confirm/prompt or beforeunload calls left in site-source (p5 sandbox alert shim excepted)', hits.length === 0, hits);
  const server = fs.readFileSync(new URL('server.js', SRC), 'utf8');
  const prompts = fs.readFileSync(new URL('../worker/prompts.js', SRC), 'utf8');
  ok('static: Scene prompt, required section and fix prompt tell the AI to use gsAlert/gsConfirm/gsPrompt', (server.match(/gsConfirm/g) || []).length >= 4 && /Never use the browser's \\`alert\(\)\\`/.test(server));
  ok('static: worker/prompts.js regenerated (same prompts as server.js)', (prompts.match(/gsConfirm/g) || []).length >= 4);
  ok('static: gsDialog.js shipped to the Worker and Vercel', /gsDialog\.js/.test(fs.readFileSync(new URL('../worker/sync-public.sh', SRC), 'utf8')) && /site-source\/gsDialog\.js/.test(fs.readFileSync(new URL('../vercel.json', SRC), 'utf8')));
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

async function open(vp, { xr = false, mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = []; p._native = []; p._themePosts = [];
  p.on('pageerror', (e) => p._errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ollama|11434|hdri|HDR/i.test(m.text())) p._errs.push(m.text().slice(0, 200)); });
  // Any native dialog fails the run.
  p.on('dialog', async (d) => { p._native.push(`${d.type()}: ${d.message()}`); await d.dismiss().catch(() => {}); });
  if (mobile) await p.setUserAgent(UA_PHONE);
  await p.setViewport(vp);
  if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
    if (u.pathname === '/api/community-themes' && req.method() === 'POST') { const body = JSON.parse(req.postData() || '{}'); p._themePosts.push(body.name); return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ theme: { id: 't' + p._themePosts.length, name: body.name } }) }); }
    if (u.pathname === '/api/community-themes') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ themes: [] }) });
    req.continue();
  });
  await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.gsSessionCode && window.gsDialogs && window.GSChatPrompt, { timeout: 30000 });
  await sleep(1500);
  return p;
}
const dlg = (p) => p.evaluate(() => {
  const d = window.gsDialogs.current();
  const card = document.getElementById('gs-dialog');
  const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  return d ? { kind: d.kind, mode: d.mode, message: d.message, shown: vis(card), role: card.getAttribute('role'), modal: card.getAttribute('aria-modal'), focus: document.activeElement === document.body ? 'body' : (document.activeElement.className || document.activeElement.id), okText: d.ok.textContent, cancelText: d.cancel && d.cancel.textContent, value: d.input && d.input.value, queued: window.gsDialogs.queued() } : null;
});
const hasBox = (p) => p.evaluate(() => !!scene.getObjectByName('dlgBox'));
const addBox = (p) => p.evaluate((c) => window.gsSessionCode.add(c), BOX);
const action = (p, a) => p.evaluate((x) => { window.gsChatPanel.action(x); }, a);
const tabTo = (p, tab) => p.evaluate((t) => document.querySelector(`.dchat-tab[data-tab="${t}"]`)?.click(), tab);

// ---------------------------------------------------------------- desktop
if (want('desktop')) {
  const H = 'desktop:';
  const p = await open({ width: 1280, height: 800 });
  // Clear scene: Escape cancels, keyboard + click OK clears.
  await addBox(p);
  await tabTo(p, 'scenes'); await sleep(300);
  const clearBtn = await p.$('[data-action="scenes:clear"]');
  if (clearBtn) await clearBtn.click(); else await action(p, 'scenes:clear');
  await sleep(300);
  let d = await dlg(p);
  ok(`${H} Clear scene opens the in-app confirm (role=dialog, aria-modal)`, d && d.kind === 'confirm' && d.mode === 'page' && d.shown && d.role === 'dialog' && d.modal === 'true', d);
  ok(`${H} destructive confirm focuses Cancel first and labels OK "Clear scene"`, d && /gs-dialog-cancel/.test(d.focus) && d.okText === 'Clear scene', d);
  ok(`${H} the scene is untouched while the question is open`, await hasBox(p));
  await p.screenshot({ path: `${SHOT_DIR}/desktop-confirm-clear-scene.png` });
  // Keys don't leak to the camera controls while the dialog is open.
  const cam0 = await p.evaluate(() => camera.position.toArray().join(','));
  await p.keyboard.down('w'); await sleep(250); await p.keyboard.up('w');
  ok(`${H} typing while the dialog is open doesn't move the camera`, cam0 === await p.evaluate(() => camera.position.toArray().join(',')));
  // Focus trap: Tab cycles Cancel -> OK -> Cancel; Shift+Tab back.
  const focusSeq = [];
  for (let i = 0; i < 3; i++) { await p.keyboard.press('Tab'); focusSeq.push(await p.evaluate(() => document.activeElement.dataset.gsDialog || document.activeElement.id || document.activeElement.tagName)); }
  await p.keyboard.down('Shift'); await p.keyboard.press('Tab'); await p.keyboard.up('Shift');
  focusSeq.push(await p.evaluate(() => document.activeElement.dataset.gsDialog || document.activeElement.tagName));
  ok(`${H} focus is trapped in the dialog (Tab / Shift+Tab)`, focusSeq.join(',') === 'ok,cancel,ok,cancel', focusSeq);
  await p.keyboard.press('Escape'); await sleep(250);
  ok(`${H} Escape cancels: dialog closed, scene kept`, !(await dlg(p)) && await hasBox(p));
  if (clearBtn) await clearBtn.click(); else await action(p, 'scenes:clear');
  await sleep(250);
  await p.keyboard.press('Tab'); await p.keyboard.press('Enter'); await sleep(400);
  ok(`${H} Tab to "Clear scene" + Enter clears the scene`, !(await dlg(p)) && !(await hasBox(p)));
  // Mouse: Cancel button keeps, OK clears.
  await addBox(p);
  await action(p, 'scenes:clear'); await sleep(250);
  await p.click('#gs-dialog [data-gs-dialog="cancel"]'); await sleep(250);
  ok(`${H} clicking Cancel keeps the scene`, !(await dlg(p)) && await hasBox(p));
  await action(p, 'scenes:clear'); await sleep(250);
  await p.click('#gs-dialog [data-gs-dialog="ok"]'); await sleep(400);
  ok(`${H} clicking Clear scene clears it`, !(await hasBox(p)));
  // Backdrop click does nothing.
  await addBox(p);
  await action(p, 'scenes:clear'); await sleep(250);
  await p.mouse.click(20, 780); await sleep(250);
  ok(`${H} clicking the backdrop doesn't answer the question`, !!(await dlg(p)) && await hasBox(p));
  await p.keyboard.press('Escape'); await sleep(200);

  // Theme upload: prompt with the current name, typed name + Enter uploads, Cancel doesn't.
  await action(p, 'themes:upload'); await sleep(300);
  d = await dlg(p);
  ok(`${H} Upload theme opens the in-app prompt with the theme name filled in and focused`, d && d.kind === 'prompt' && d.message === 'Theme name?' && d.value && /gs-dialog-input/.test(d.focus), d);
  await p.keyboard.press('Escape'); await sleep(400);
  ok(`${H} Escape on the prompt uploads nothing`, p._themePosts.length === 0 && !(await dlg(p)));
  await action(p, 'themes:upload'); await sleep(300);
  await p.keyboard.type('Sunset Glass'); // the default text is selected, so typing replaces it
  await p.screenshot({ path: `${SHOT_DIR}/desktop-prompt-theme-name.png` });
  await p.keyboard.press('Enter'); await sleep(800);
  ok(`${H} typing a name + Enter uploads the theme with that name`, p._themePosts.at(-1) === 'Sunset Glass' && !(await dlg(p)), p._themePosts);

  // Chat → Prompt: Reset asks (Cancel keeps, OK resets).
  const CUSTOM = 'You are a dialog-harness test prompt. Build scenes.';
  await p.evaluate((c) => window.GSChatPrompt.saveCustom(c), CUSTOM); await sleep(300);
  await tabTo(p, 'chat'); await sleep(200);
  await p.click('[data-chat-section="prompt"]'); await sleep(300);
  await p.click('#dchat-prompt-reset'); await sleep(300);
  d = await dlg(p);
  ok(`${H} Chat → Prompt → Reset opens the in-app confirm`, d && d.kind === 'confirm' && /custom prompt will be deleted/.test(d.message), d);
  await p.click('#gs-dialog [data-gs-dialog="cancel"]'); await sleep(300);
  ok(`${H} Cancel keeps the custom prompt`, await p.evaluate((c) => localStorage.getItem(window.GSChatPrompt.STORAGE_KEY)?.includes(c), CUSTOM));
  await p.click('#dchat-prompt-reset'); await sleep(300);
  await p.click('#gs-dialog [data-gs-dialog="ok"]'); await sleep(300);
  ok(`${H} Reset to default deletes the custom prompt`, await p.evaluate(() => localStorage.getItem(window.GSChatPrompt.STORAGE_KEY) === null && !window.GSChatPrompt.isCustom()));

  // Scene code: alert/confirm/prompt are routed to the in-app dialogs; queueing.
  await p.evaluate(() => { window.__res = []; window.gsSessionCode.add("alert('first'); alert('second'); window.__c = confirm('sure?'); window.__pp = gsPrompt('name?', 'Bob');"); });
  await sleep(500);
  d = await dlg(p);
  ok(`${H} scene-code alert() shows an in-app alert (no Cancel) and the rest queue behind it`, d && d.kind === 'alert' && d.message === 'first' && d.cancelText === null && d.queued === 3, d);
  await p.keyboard.press('Enter'); await sleep(200);
  d = await dlg(p);
  ok(`${H} OK shows the next queued dialog`, d && d.kind === 'alert' && d.message === 'second', d);
  await p.click('#gs-dialog [data-gs-dialog="ok"]'); await sleep(200);
  d = await dlg(p);
  ok(`${H} scene-code confirm() is an in-app confirm returning a Promise`, d && d.kind === 'confirm' && d.message === 'sure?' && await p.evaluate(() => window.__c instanceof Promise), d);
  await p.click('#gs-dialog [data-gs-dialog="ok"]'); await sleep(200);
  ok(`${H} …that resolves true on OK`, await p.evaluate(async () => (await window.__c) === true));
  await p.keyboard.press('Enter'); await sleep(200);
  ok(`${H} gsPrompt resolves the text`, await p.evaluate(async () => (await window.__pp) === 'Bob'));
  ok(`${H} focus returns to the page after the queue empties`, !(await dlg(p)));
  ok(`${H} message text is shown as text (no HTML injection)`, await p.evaluate(async () => { const pr = gsAlert('<img src=x onerror="window.__xss=1">'); const has = !!document.querySelector('#gs-dialog img'); document.querySelector('#gs-dialog [data-gs-dialog="ok"]').click(); await pr; return !has && !window.__xss; }));
  // Theme colours: the card follows --dchat-* (a theme changing the text colour shows up).
  ok(`${H} no native dialog fired`, p._native.length === 0, p._native);
  ok(`${H} no console errors`, p._errs.length === 0, p._errs);
  await p.browserContext().close();
}

// ---------------------------------------------------------------- phone
if (want('phone')) {
  const H = 'phone:';
  const p = await open({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { mobile: true });
  await addBox(p);
  await action(p, 'scenes:clear'); await sleep(300);
  const sizes = await p.evaluate(() => [...document.querySelectorAll('#gs-dialog button:not([hidden])')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  const fits = await p.evaluate(() => { const r = document.getElementById('gs-dialog').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
  ok(`${H} buttons are at least 44x44 px and the card fits the screen`, sizes.length === 2 && sizes.every(([w, h]) => w >= 44 && h >= 44) && fits, { sizes, fits });
  await p.screenshot({ path: `${SHOT_DIR}/phone-confirm-clear-scene.png` });
  await p.tap('#gs-dialog [data-gs-dialog="cancel"]'); await sleep(300);
  ok(`${H} tapping Cancel keeps the scene`, !(await dlg(p)) && await hasBox(p));
  await action(p, 'themes:upload'); await sleep(300);
  const inp = await p.evaluate(() => { const r = document.getElementById('gs-dialog-input').getBoundingClientRect(); return Math.round(r.height); });
  await p.screenshot({ path: `${SHOT_DIR}/phone-prompt-theme-name.png` });
  ok(`${H} prompt field is 44 px tall`, inp >= 44, inp);
  await p.tap('#gs-dialog [data-gs-dialog="ok"]'); await sleep(800);
  ok(`${H} tapping OK uploads the theme with the default name`, p._themePosts.length === 1 && !(await dlg(p)), p._themePosts);
  ok(`${H} no native dialog fired`, p._native.length === 0, p._native);
  ok(`${H} no console errors`, p._errs.length === 0, p._errs);
  await p.browserContext().close();
}

// ---------------------------------------------------------------- VR (IWER Quest 3)
if (want('vr')) {
  const H = 'vr:';
  const p = await open({ width: 1600, height: 900 }, { xr: true });
  await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
  await p.click('#XRButton').catch(() => {});
  for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
  ok(`${H} entered immersive VR (IWER Quest 3)`, await p.evaluate(() => renderer.xr.isPresenting));
  await sleep(1500);
  await p.evaluate(() => {
    const V = THREE.Vector3;
    window.__t = {
      win: (n) => window.__gsVrWindows.byName(n),
      pointFor(el, winName) {
        const w = this.win(winName); const sr = w.source.getBoundingClientRect(); const r = el.getBoundingClientRect();
        const u = (r.left + r.width / 2 - sr.left) / sr.width, v = 1 - (r.top + r.height / 2 - sr.top) / sr.height;
        w.mesh.updateMatrixWorld(true);
        return w.mesh.localToWorld(new V(u - 0.5, v - 0.5, 0.0));
      },
      aim(hand, target) {
        const c = [0, 1].map((i) => renderer.xr.getController(i)).find((x) => x.userData.handedness === hand);
        const xrCam = renderer.xr.getCamera(); const head = new V(); xrCam.getWorldPosition(head);
        const origin = head.clone().add(new V(hand === 'right' ? 0.15 : -0.15, -0.3, -0.1));
        const parent = c.parent; parent.updateMatrixWorld(true);
        const inv = parent.matrixWorld.clone().invert();
        const o = origin.clone().applyMatrix4(inv), t = target.clone().applyMatrix4(inv);
        const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(o, t, new V(0, 1, 0)));
        const dc = window.__xrDevice.controllers[hand];
        dc.position.set(o.x, o.y, o.z); dc.quaternion.set(q.x, q.y, q.z, q.w);
      },
      aimAt(hand, sel, winName) { const w = this.win(winName); const el = w.source.matches(sel) ? w.source : w.source.querySelector(sel); this.aim(hand, this.pointFor(el, winName)); },
      trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); }
    };
  });
  const click = async (hand = 'right') => { await p.evaluate((h) => __t.trigger(h, 1), hand); await sleep(300); await p.evaluate((h) => __t.trigger(h, 0), hand); await sleep(450); };
  const aimClick = async (sel, win) => { await p.evaluate((s, w) => __t.aimAt('right', s, w), sel, win); await sleep(350); await click(); };
  const vrState = () => p.evaluate(() => {
    const w = window.__gsVrWindows.byName('dialog'); const kb = window.__gsVrWindows.byName('keyboard');
    const cam = renderer.xr.getCamera(); const head = new THREE.Vector3(); cam.getWorldPosition(head);
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    const pos = new THREE.Vector3(); w.mesh.getWorldPosition(pos);
    const to = pos.clone().sub(head); const dist = to.length();
    return { visible: w.visible, paints: w.paints, widthM: +w.widthM.toFixed(3), dist: +dist.toFixed(2), facing: +(to.normalize().dot(dir)).toFixed(2), onMenuLayer: w.mesh.layers.isEnabled(1) || w.mesh.layers.mask !== 1, kbVisible: kb.visible, kbUnderDialog: kb.mesh.parent === w.mesh.parent && kb.visible };
  });
  // Turn the head 70° to the right first: the dialog must open where you look, not at the menu.
  await p.evaluate(() => { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(-70), 0, 'YXZ')); window.__xrDevice.quaternion.set(q.x, q.y, q.z, q.w); });
  await sleep(600);
  await addBox(p);
  await action(p, 'scenes:clear'); await sleep(900);
  let d = await dlg(p);
  let s = await vrState();
  ok(`${H} Clear scene shows the confirm as a VR window, not a page modal`, d && d.kind === 'confirm' && d.mode === 'xr' && s.visible && s.paints > 0, { d, s });
  ok(`${H} the VR dialog opens in front of the head where you are looking (~1.2 m)`, s.facing > 0.95 && s.dist > 1.0 && s.dist < 1.4, s);
  ok(`${H} no text field / button is DOM-focused in XR`, d && d.focus === 'body' || !/gs-dialog/.test(d.focus), d);
  const tex = await p.evaluate(() => window.__gsVrWindows.byName('dialog').canvas.toDataURL('image/png'));
  fs.writeFileSync(`${SHOT_DIR}/vr-dialog-confirm-texture.png`, Buffer.from(tex.split(',')[1], 'base64'));
  await p.screenshot({ path: `${SHOT_DIR}/vr-confirm-clear-scene.png` });
  await aimClick('[data-gs-dialog="cancel"]', 'dialog');
  ok(`${H} controller ray + trigger on Cancel keeps the scene and closes the VR dialog`, !(await dlg(p)) && await hasBox(p) && !(await vrState()).visible);
  await action(p, 'scenes:clear'); await sleep(900);
  // While it's open, pointing at the menu and pulling the trigger does nothing.
  await p.evaluate(() => { const q = new THREE.Quaternion(); window.__xrDevice.quaternion.set(q.x, q.y, q.z, q.w); }); await sleep(300);
  const tabBefore = await p.evaluate(() => document.querySelector('.dchat-tab.active')?.dataset.tab);
  await aimClick('#gs-menu-hamburger', 'menu');
  ok(`${H} the menu behind an open dialog can't be clicked (modal)`, tabBefore === await p.evaluate(() => document.querySelector('.dchat-tab.active')?.dataset.tab) && !!(await dlg(p)));
  await aimClick('[data-gs-dialog="ok"]', 'dialog');
  ok(`${H} trigger on "Clear scene" clears the scene`, !(await dlg(p)) && !(await hasBox(p)));
  // Prompt: theme upload in VR, typed with the VR keyboard under the dialog.
  await p.evaluate(() => { const w = window.__gsVrWindows.byName('dialog'); window.__dlgGpu = { size: `${w.canvas.width}x${w.canvas.height}`, tex: renderer.properties.get(w.texture).__webglTexture }; });
  await action(p, 'themes:upload'); await sleep(900);
  const gpu = await p.evaluate(() => { const w = window.__gsVrWindows.byName('dialog'); const size = `${w.canvas.width}x${w.canvas.height}`; const tex = renderer.properties.get(w.texture).__webglTexture; return { before: window.__dlgGpu.size, after: size, realloc: !!tex && tex !== window.__dlgGpu.tex }; });
  ok(`${H} a question of a different size gets a new GPU texture (no stale picture of the last one)`, gpu.before !== gpu.after && gpu.realloc, gpu);
  d = await dlg(p); s = await vrState();
  ok(`${H} Upload theme shows the prompt in VR with the VR keyboard right under it`, d && d.kind === 'prompt' && d.mode === 'xr' && s.visible && s.kbVisible && s.kbUnderDialog, { d, s });
  ok(`${H} the prompt's field is the keyboard target (not DOM-focused)`, await p.evaluate(() => document.getElementById('gs-dialog-input').classList.contains('gs-vr-typing') && document.activeElement !== document.getElementById('gs-dialog-input')));
  await p.evaluate(() => { const i = document.getElementById('gs-dialog-input'); i.setSelectionRange(i.value.length, i.value.length); });
  for (let i = 0; i < 20; i++) { await p.evaluate(() => { const i = document.getElementById('gs-dialog-input'); if (i.value) { i.value = i.value.slice(0, -1); i.dispatchEvent(new Event('input', { bubbles: true })); } }); }
  await aimClick('[data-kb-action="char"][data-kb-value="v"]', 'keyboard');
  await aimClick('[data-kb-action="char"][data-kb-value="r"]', 'keyboard');
  ok(`${H} keyboard keys pressed by ray type into the dialog's field`, (await dlg(p))?.value === 'vr', await dlg(p));
  await sleep(300);
  const tex2 = await p.evaluate(() => [window.__gsVrWindows.byName('dialog').canvas.toDataURL('image/png'), window.__gsVrWindows.byName('keyboard').canvas.toDataURL('image/png')]);
  fs.writeFileSync(`${SHOT_DIR}/vr-dialog-prompt-texture.png`, Buffer.from(tex2[0].split(',')[1], 'base64'));
  await p.screenshot({ path: `${SHOT_DIR}/vr-prompt-with-keyboard.png` });
  await aimClick('[data-kb-action="enter"]', 'keyboard');
  ok(`${H} the keyboard's Send key answers OK: theme uploaded as "vr"`, p._themePosts.at(-1) === 'vr' && !(await dlg(p)), p._themePosts);
  s = await vrState();
  ok(`${H} closing the dialog hides it and puts the keyboard away`, !s.visible && !s.kbVisible, s);
  ok(`${H} keyboard is back under the menu afterwards`, await p.evaluate(() => window.__gsVrWindows.byName('keyboard').mesh.parent.name === 'gsPanelAnchor'));
  // Prompt reset in VR (formerly the two-press workaround) is the same dialog now.
  await p.evaluate(() => window.GSChatPrompt.saveCustom('VR custom prompt for dialogs.')); await sleep(300);
  await p.evaluate(() => document.getElementById('dchat-prompt-reset').click()); await sleep(900);
  d = await dlg(p);
  ok(`${H} Chat → Prompt → Reset asks with the VR dialog`, d && d.kind === 'confirm' && d.mode === 'xr', d);
  await aimClick('[data-gs-dialog="ok"]', 'dialog');
  ok(`${H} trigger on "Reset to default" resets the prompt`, await p.evaluate(() => !window.GSChatPrompt.isCustom()));
  // Leaving VR with a dialog open moves it to the page.
  await p.evaluate(() => { window.__left = gsAlert('Still here after VR'); });
  await sleep(600);
  ok(`${H} alert from scene code opens in VR`, (await dlg(p))?.mode === 'xr');
  await p.evaluate(() => renderer.xr.getSession().end()); await sleep(1200);
  d = await dlg(p);
  ok(`${H} leaving VR moves an open dialog to the page modal`, d && d.mode === 'page' && d.shown && !(await vrState()).visible, d);
  await p.keyboard.press('Enter'); await sleep(300);
  ok(`${H} …where it can be answered`, !(await dlg(p)));
  ok(`${H} no native dialog fired`, p._native.length === 0, p._native);
  ok(`${H} no console errors`, p._errs.length === 0, p._errs);
  await p.browserContext().close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
