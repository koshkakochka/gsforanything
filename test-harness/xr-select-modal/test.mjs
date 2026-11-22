// XR custom <select> popups + shared gsModal template.
//   BASE=https://localhost:3488 node test.mjs
//   ONLY=static,desktop,vr  SHOT=/workspace/gs-pr59-shots/xr-select-popup.png
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3488';
const SHOT = process.env.SHOT || '/workspace/gs-pr59-shots/xr-select-popup.png';
const ONLY = process.env.ONLY || '';
const want = (n) => !ONLY || ONLY.split(',').includes(n);
const SRC = new URL('../../site-source/', import.meta.url);
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

if (want('static')) {
  const sync = fs.readFileSync(new URL('../worker/sync-public.sh', SRC), 'utf8');
  const vercel = fs.readFileSync(new URL('../vercel.json', SRC), 'utf8');
  ok('static: gsModal.js and xrSelect.js ship to the Worker and Vercel',
    /gsModal\.js/.test(sync) && /xrSelect\.js/.test(sync) && /site-source\/gsModal\.js/.test(vercel) && /site-source\/xrSelect\.js/.test(vercel));
  const files = {
    'gsDialog.js': 'openGsModal',
    'creationContext.js': "id: 'gs-ctx-publish'",
    'exporter.js': "id: 'gs-model-export'",
    'p5Import.js': "id: 'gs-p5i-modal'",
    'main.js': "id: 'export-modal'"
  };
  const missing = [];
  for (const [f, needle] of Object.entries(files)) {
    const text = fs.readFileSync(new URL(f, SRC), 'utf8');
    if (!text.includes("from './gsModal.js'") || !text.includes(needle)) missing.push(f);
  }
  ok('static: gsDialog, publish, model export, p5 import, and main export/share/rename/version open through openGsModal', missing.length === 0, missing);
  const main = fs.readFileSync(new URL('main.js', SRC), 'utf8');
  ok('static: main.js also migrates share, rename and version modals',
    /id: 'share-modal'/.test(main) && /id: 'rename-modal'/.test(main) && /id: 'gs-version-modal'/.test(main));
  const vr = fs.readFileSync(new URL('vrWindows.js', SRC), 'utf8');
  ok('static: vrWindows opens the custom XR select instead of cycling selectedIndex',
    /activateSelectInXr/.test(vr) && !/selectedIndex\s*\+=\s*1/.test(vr) && !/selectedIndex\s*=\s*\(/.test(vr));
}

const browser = (!want('desktop') && !want('vr')) ? null : await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function openPage({ xr = false, width = 1280, height = 800 } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = [];
  p.on('pageerror', (e) => p._errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ollama|11434|hdri|HDR/i.test(m.text())) p._errs.push(m.text().slice(0, 200)); });
  await p.setViewport({ width, height });
  if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
    if (u.pathname.startsWith('/api/community-')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenes: [], themes: [] }) });
    req.continue();
  });
  await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.gsModal && window.gsDialogs && window.gsXrSelect, { timeout: 30000 });
  await sleep(1200);
  return p;
}

if (want('desktop')) {
  const H = 'desktop:';
  const p = await openPage();
  const native = await p.evaluate(() => {
    const sel = document.getElementById('dchat-nav-type');
    const before = document.getElementById('gs-xr-select-popup');
    sel?.click();
    const after = document.getElementById('gs-xr-select-popup');
    return { exists: !!sel, openedNative: !before && !after && !window.gsXrSelect.isOpen() };
  });
  ok(`${H} Environment nav <select> stays native (no XR popup)`, native.exists && native.openedNative, native);

  const modal = await p.evaluate(() => {
    const h = window.gsModal.open({
      title: 'Test modal',
      titleId: 'gs-test-modal-title',
      body: 'Reusable template body',
      actions: [
        { id: 'gs-test-cancel', label: 'Cancel' },
        { id: 'gs-test-ok', label: 'OK', variant: 'primary' }
      ]
    });
    const root = h.root;
    const card = h.card;
    return {
      title: document.getElementById('gs-test-modal-title')?.textContent,
      body: h.body?.textContent?.trim(),
      visible: root.classList.contains('visible'),
      role: card.getAttribute('role'),
      modal: card.getAttribute('aria-modal'),
      ok: !!document.getElementById('gs-test-ok'),
      cancel: !!document.getElementById('gs-test-cancel'),
      open: window.gsModal.current()?.titleEl?.textContent
    };
  });
  ok(`${H} openGsModal renders title, body slot, actions, and an accessible dialog`,
    modal.title === 'Test modal' && modal.body === 'Reusable template body' && modal.visible && modal.role === 'dialog' && modal.modal === 'true' && modal.ok && modal.cancel && modal.open === 'Test modal',
    modal);
  await p.evaluate(() => window.gsModal.close('cancel'));
  ok(`${H} closeGsModal hides the card`, await p.evaluate(() => !window.gsModal.current() && !document.querySelector('.gs-modal-root.visible')));

  await p.evaluate(() => { window.gsAlert('Hello from the shared template'); return true; });
  await sleep(300);
  const dlg = await p.evaluate(() => {
    const d = window.gsDialogs.current();
    const card = document.getElementById('gs-dialog');
    return { kind: d && d.kind, message: d && d.message, id: card && card.id, visible: card && card.getClientRects().length > 0, ok: !!document.querySelector('[data-gs-dialog="ok"]') };
  });
  ok(`${H} gsAlert still uses #gs-dialog / data-gs-dialog=ok through gsModal`, dlg.kind === 'alert' && dlg.message === 'Hello from the shared template' && dlg.id === 'gs-dialog' && dlg.visible && dlg.ok, dlg);
  await p.click('[data-gs-dialog="ok"]');
  await sleep(300);
  ok(`${H} no console errors`, p._errs.length === 0, p._errs);
  await p.browserContext().close();
}

if (want('vr')) {
  const H = 'vr:';
  const p = await openPage({ xr: true, width: 1600, height: 900 });
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
      aimAt(hand, sel, winName) { const w = this.win(winName); const el = typeof sel === 'string' ? (w.source.matches(sel) ? w.source : (w.source.querySelector(sel) || document.querySelector(sel))) : sel; if (!el) throw new Error('aimAt missing ' + sel + ' in ' + winName); this.aim(hand, this.pointFor(el, winName)); },
      trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); }
    };
  });
  const click = async (hand = 'right') => { await p.evaluate((h) => __t.trigger(h, 1), hand); await sleep(300); await p.evaluate((h) => __t.trigger(h, 0), hand); await sleep(450); };
  const aimClick = async (sel, win) => { await p.evaluate((s, w) => __t.aimAt('right', s, w), sel, win); await sleep(350); await click(); };

  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="env"]')?.click());
  await sleep(400);
  const selState = await p.evaluate(() => {
    const sel = document.getElementById('dchat-nav-type');
    if (sel) sel.scrollIntoView({ block: 'center' });
    return { value: sel && sel.value, options: sel && [...sel.options].map((o) => o.value) };
  });
  await sleep(300);
  await aimClick('#dchat-nav-type', 'menu');
  const opened = await p.evaluate(() => {
    const popup = document.getElementById('gs-xr-select-popup');
    const source = popup && popup.closest('.html-in-canvas-source');
    const opts = popup ? [...popup.querySelectorAll('[role="option"]')].map((o) => ({ value: o.dataset.value, text: o.textContent.trim() })) : [];
    return { open: window.gsXrSelect.isOpen(), inSource: !!(source && source.id === 'desktop-chat' || source), optionCount: opts.length, opts, target: window.gsXrSelect.target()?.id };
  });
  ok(`${H} ray on a <select> opens a painted listbox inside the html-in-canvas source`,
    opened.open && opened.inSource && opened.optionCount === 2 && opened.target === 'dchat-nav-type', opened);

  // One screenshot: the walker-painted menu with the dropdown open.
  try {
    fs.mkdirSync(new URL(SHOT, 'file:///').pathname.replace(/\/[^/]+$/, ''), { recursive: true });
  } catch { /* ignore */ }
  const dataUrl = await p.evaluate(() => {
    const w = window.__gsVrWindows.byName('menu');
    w.tick(true);
    return w.canvas.toDataURL('image/png');
  });
  const b64 = dataUrl.split(',')[1];
  fs.mkdirSync('/workspace/gs-pr59-shots', { recursive: true });
  fs.writeFileSync(SHOT, Buffer.from(b64, 'base64'));
  ok(`${H} wrote painted dropdown screenshot`, fs.existsSync(SHOT) && fs.statSync(SHOT).size > 1000, SHOT);

  await aimClick('#gs-xr-select-popup [data-index="1"]', 'menu');
  const picked = await p.evaluate(() => ({
    value: document.getElementById('dchat-nav-type').value,
    open: window.gsXrSelect.isOpen(),
    popup: !!document.getElementById('gs-xr-select-popup')
  }));
  ok(`${H} ray on an option sets the select value and closes the popup`,
    picked.value === 'planar' && !picked.open && !picked.popup, picked);

  await p.evaluate(() => { window.gsAlert('XR modal template'); return true; });
  await sleep(600);
  const vrDlg = await p.evaluate(() => {
    const w = window.__gsVrWindows.byName('dialog');
    const d = window.gsDialogs.current();
    const card = document.getElementById('gs-dialog');
    w.tick(true);
    return {
      visible: w.visible,
      kind: d && d.kind,
      mode: d && d.mode,
      message: d && d.message,
      cardClass: card && card.className,
      xr: !!(d && d.mode === 'xr' && document.getElementById('gs-dialog-root')?.classList.contains('gs-dialog-xr'))
    };
  });
  ok(`${H} gsAlert uses the shared gsModal card in the dialog VR window`,
    vrDlg.visible && vrDlg.kind === 'alert' && vrDlg.message === 'XR modal template' && /gs-modal-card/.test(vrDlg.cardClass || '') && vrDlg.xr, vrDlg);
  await aimClick('[data-gs-dialog="ok"]', 'dialog');
  ok(`${H} ray on OK closes the modal`, await p.evaluate(() => !window.gsDialogs.current() && !window.__gsVrWindows.byName('dialog').visible));
  ok(`${H} no console errors`, p._errs.length === 0, p._errs);
  await p.browserContext().close();
}

if (browser) await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
