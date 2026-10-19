// Phone layout + on-screen keyboard (feature/mobile-layout).
//   BASE=https://localhost:3488 node test.mjs
//   SHOTS_ONLY=1 SHOT_PREFIX=before BASE=<old build> node test.mjs   (screenshots only)
// The keyboard is simulated two ways:
//   android: the window shrinks (Chrome, interactive-widget=resizes-content)
//   ios:     only visualViewport.height shrinks (Safari); the layout viewport stays
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3488';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-mobile-shots';
const PREFIX = process.env.SHOT_PREFIX || 'after';
const SHOTS_ONLY = !!process.env.SHOTS_ONLY;
const DESKTOP_REF = process.env.DESKTOP_REF || ''; // optional: older build to compare the desktop layout with
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const ok = (n, c, e = '') => { if (SHOTS_ONLY) return; results.push(`${c ? 'PASS' : 'FAIL'} ${n} ${e}`); console.log(results.at(-1)); };
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

const KB_HOOK = `(() => {
  const d = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
  window.__kbH = 0;
  Object.defineProperty(VisualViewport.prototype, 'height', { configurable: true, get() { return Math.max(1, d.get.call(this) - window.__kbH); } });
  window.__setIosKb = (h) => { window.__kbH = h; window.visualViewport.dispatchEvent(new Event('resize')); };
  window.__sizes = [];
})();`;

async function openPhone(vp) {
  const p = await b.newPage(); p._errs = []; p._chat = 0;
  p.on('pageerror', e => p._errs.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p._errs.push(m.text().slice(0, 200)); });
  await p.setUserAgent(UA);
  await p.setViewport({ width: vp.w, height: vp.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await p.evaluateOnNewDocument(KB_HOOK);
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    if (u.includes('/api/community-scenes') && req.method() === 'POST') return req.respond({ status: 503, body: 'blocked' });
    if (u.endsWith('/api/chat')) { p._chat++; return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'Mock reply number ' + p._chat + '. ' + 'This is a longer answer so the list has to scroll. '.repeat(3) }] }) }); }
    req.continue();
  });
  await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(2500);
  // Count renderer resizes (canvas width/height attribute writes).
  await p.evaluate(() => { const c = renderer.domElement; const o = new MutationObserver(() => window.__sizes.push([c.width, c.height])); o.observe(c, { attributes: true, attributeFilter: ['width', 'height'] }); });
  return p;
}
const shot = (p, name) => p.screenshot({ path: `${SHOT_DIR}/${PREFIX}-${name}.png` });

// Visible tap targets (below 44px = fail), and whether something else covers them.
const scanTargets = (p, rootSel) => p.evaluate((rootSel) => {
  const vv = visualViewport; const vb = vv.offsetTop + vv.height;
  const roots = rootSel.map(s => document.querySelector(s)).filter(Boolean);
  const out = { small: [], covered: [], count: 0 };
  for (const root of roots) for (const e of root.querySelectorAll('button, select, input:not([type=hidden]):not([type=file]), .dchat-tab, a[href], [role=button]')) {
    const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none' || e.closest('[hidden]')) continue;
    if (r.bottom <= 0 || r.top >= vb || r.right <= 0 || r.left >= innerWidth) continue;
    // a tab row / list that scrolls: only judge the part inside its scroller
    const sc = e.closest('#desktop-chat-tabs, #desktop-chat-messages, .dchat-panel > div'); if (sc && sc !== e) { const sr = sc.getBoundingClientRect(); if (r.right <= sr.left || r.left >= sr.right || r.bottom <= sr.top || r.top >= sr.bottom) continue; }
    out.count++;
    let tw = r.width, th = r.height;
    if (e.type === 'checkbox' || e.type === 'radio') { const l = e.closest('label'); if (l) { const lr = l.getBoundingClientRect(); tw = lr.width; th = lr.height; } }
    const id = e.id || (e.dataset.tab ? 'tab:' + e.dataset.tab : '') || (e.textContent || e.type || e.tagName).trim().slice(0, 18);
    if (tw < 44 - 0.5 || th < 44 - 0.5) out.small.push(`${id} ${Math.round(tw)}x${Math.round(th)}`);
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 1), vb - 1);
    const hit = document.elementFromPoint(cx, cy);
    if (hit && !(hit === e || e.contains(hit) || hit.contains(e) || (e.tagName === 'INPUT' && hit.tagName === 'LABEL' && hit.contains(e)) || e.closest('label') === hit.closest('label') && hit.closest('label'))) out.covered.push(`${id} by ${hit.id || hit.className || hit.tagName}`);
  }
  return out;
}, rootSel);

const layout = (p) => p.evaluate(() => {
  const R = sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return (r.width && s.display !== 'none' && s.visibility !== 'hidden') ? { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) } : null; };
  const vv = visualViewport;
  const list = document.getElementById('desktop-chat-messages');
  const last = list ? [...list.children].filter(c => c.getBoundingClientRect().height > 0).at(-1) : null;
  const lr = last ? last.getBoundingClientRect() : null; const listR = list.getBoundingClientRect();
  return { vv: { top: vv.offsetTop, h: vv.height, w: vv.width }, iw: innerWidth, ih: innerHeight, cls: document.documentElement.className, active: document.activeElement?.id || document.activeElement?.tagName,
    panel: R('#desktop-chat'), header: R('#desktop-chat-header'), tabs: R('#desktop-chat-tabs'), input: R('#desktop-chat-input'), send: R('#desktop-send-button'), more: R('#desktop-chat-more'), list: R('#desktop-chat-messages'), dock: R('#gs-dock'), toggle: R('#ui-toggle'),
    themeInput: R('#dchat-theme-chat-input'), code: R('#dchat-code-editor'), apply: R('#dchat-code-apply'),
    lastMsgVisible: !!lr && lr.bottom <= listR.bottom + 1 && lr.bottom > listR.top, lastMsgText: last?.textContent.slice(0, 40), canvas: [renderer.domElement.width, renderer.domElement.height], dpr: renderer.getPixelRatio() };
});
const inside = (r, L) => r && r.t >= L.vv.top - 0.5 && r.b <= L.vv.top + L.vv.h + 0.5 && r.l >= -0.5 && r.r <= L.iw + 0.5;
const covers = (p, sel) => p.evaluate(sel => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === e || e.contains(h) ? '' : (h?.id || h?.className || h?.tagName || 'nothing'); }, sel);

async function keyboard(p, vp, mode, on) {
  const kb = on ? Math.round(vp.h > vp.w ? vp.h * 0.4 : vp.h * 0.52) : 0;
  if (mode === 'android') {
    // the keyboard slides up over ~6 frames
    const steps = on ? [0.2, 0.45, 0.7, 0.9, 1] : [1];
    for (const f of steps) { await p.setViewport({ width: vp.w, height: vp.h - Math.round(kb * f), isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await sleep(40); }
  } else {
    const steps = on ? [0.2, 0.45, 0.7, 0.9, 1] : [0];
    for (const f of steps) { await p.evaluate(h => window.__setIosKb(h), Math.round(kb * f)); await sleep(40); }
  }
  await sleep(500);
}
async function tapEl(p, sel) { const r = await p.evaluate(s => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel); if (!r) return; await p.touchscreen.tap(r[0], r[1]); await sleep(250); }
async function tab(p, t) { await tapEl(p, `.dchat-tab[data-tab="${t}"]`); await sleep(250); }

const PHONES = [{ name: '390x844', w: 390, h: 844 }, { name: '412x915', w: 412, h: 915 }, { name: '844x390', w: 844, h: 390 }, { name: '915x412', w: 915, h: 412 }];
const ONLY = process.env.ONLY || ''; // e.g. ONLY=390x844:android
for (const vp of PHONES) {
  const portrait = vp.h > vp.w;
  for (const mode of ['android', 'ios']) {
    if (ONLY && !ONLY.split(',').some(o => `${vp.name}:${mode}`.startsWith(o))) continue;
    const T = `[${vp.name} ${mode}]`;
    const p = await openPhone(vp);
    let L = await layout(p);
    if (mode === 'android') await shot(p, `${vp.name}`);
    ok(`${T} phone layout class on`, /\bgs-phone\b/.test(L.cls), L.cls);
    // ---- crowding (no keyboard)
    const tg = await scanTargets(p, ['#desktop-chat', '#gs-dock', '#overlay-root']);
    ok(`${T} chat tab: every visible tap target >= 44px (${tg.count} checked)`, tg.count > 8 && tg.small.length === 0, JSON.stringify(tg.small));
    ok(`${T} chat tab: nothing covers a tap target`, tg.covered.length === 0, JSON.stringify(tg.covered));
    const tabsRow = await p.evaluate(() => { const ts = [...document.querySelectorAll('.dchat-tab')]; const tops = new Set(ts.map(t => Math.round(t.getBoundingClientRect().top))); const row = document.getElementById('desktop-chat-tabs'); return { rows: tops.size, scroll: row.scrollWidth > row.clientWidth, n: ts.length }; });
    ok(`${T} tabs: one scrollable row (not squeezed)`, tabsRow.rows === 1 && tabsRow.n === 9, JSON.stringify(tabsRow));
    await tab(p, 'share');
    const sh = await p.evaluate(() => document.querySelector('.dchat-tab.active')?.dataset.tab);
    ok(`${T} the last tab (Share) is reachable by tapping`, sh === 'share', sh);
    for (const t of ['env', 'scenes', 'files', 'code', 'community', 'controls', 'deps', 'share']) {
      await tab(p, t);
      const s = await scanTargets(p, [`#dchat-panel-${t}`]);
      ok(`${T} ${t} tab: visible tap targets >= 44px (${s.count})`, s.small.length === 0, JSON.stringify(s.small.slice(0, 8)));
    }
    await tab(p, 'chat');
    await tapEl(p, '#desktop-chat-more');
    L = await layout(p);
    const tools = await p.evaluate(() => [...document.querySelectorAll('#desktop-chat-tools-row button')].filter(e => e.getBoundingClientRect().height > 0).map(e => { const r = e.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); }));
    ok(`${T} "+" opens attach / files / mic / history (44px)`, tools.length >= 3 && tools.every(x => x >= 44), JSON.stringify(tools));
    await tapEl(p, '#desktop-chat-more');
    const closed = await p.evaluate(() => getComputedStyle(document.getElementById('desktop-chat-tools-row')).display);
    ok(`${T} "+" closes them again`, closed === 'none', closed);
    const before = await layout(p);
    // ---- chat input + keyboard
    await tapEl(p, '#desktop-chat-input');
    await keyboard(p, vp, mode, true);
    await p.keyboard.type('a red cube on a table');
    L = await layout(p);
    if (mode === 'android' && portrait || mode === 'ios' && !portrait) await shot(p, `${vp.name}-keyboard-${mode}`);
    ok(`${T} keyboard: compact layout on`, /\bgs-kb-chat\b/.test(L.cls), L.cls);
    ok(`${T} keyboard: the input is fully visible above the keyboard`, inside(L.input, L), JSON.stringify({ input: L.input, vv: L.vv }));
    ok(`${T} keyboard: Send fully visible`, inside(L.send, L) && inside(L.more, L), JSON.stringify(L.send));
    ok(`${T} keyboard: input row sits at the bottom of the visible area`, L.vv.top + L.vv.h - L.input.b < 24, `gap ${Math.round(L.vv.top + L.vv.h - L.input.b)}px`);
    ok(`${T} keyboard: panel inside the visible area`, inside(L.panel, L), JSON.stringify(L.panel));
    ok(`${T} keyboard: dock, Hide UI and tabs are out of the way`, !L.dock && !L.toggle && !L.tabs && !L.header, JSON.stringify({ dock: L.dock, toggle: L.toggle, tabs: L.tabs }));
    ok(`${T} keyboard: nothing covers the input or Send`, !(await covers(p, '#desktop-chat-input')) && !(await covers(p, '#desktop-send-button')), (await covers(p, '#desktop-chat-input')) + ' ' + (await covers(p, '#desktop-send-button')));
    ok(`${T} keyboard: recent messages visible (${L.list?.h}px of chat)`, L.list && L.list.h >= (portrait ? 200 : 60) && L.lastMsgVisible, JSON.stringify(L.list));
    ok(`${T} keyboard: typed text lands in the input`, await p.evaluate(() => document.getElementById('desktop-chat-input').value) === 'a red cube on a table');
    // send with the keyboard up: input keeps focus, newest reply in view
    await tapEl(p, '#desktop-send-button');
    for (let i = 0; i < 30 && !(await p.evaluate(() => /Mock reply number 1/.test(document.getElementById('desktop-chat-messages').textContent))); i++) await sleep(200);
    await sleep(400);
    L = await layout(p);
    ok(`${T} Send with the keyboard up: message sent, input keeps focus, keyboard layout stays`, p._chat === 1 && L.active === 'desktop-chat-input' && /gs-kb-chat/.test(L.cls), JSON.stringify({ chat: p._chat, active: L.active }));
    ok(`${T} the newest reply is in view above the input`, L.lastMsgVisible && /Mock reply number 1/.test(L.lastMsgText || ''), L.lastMsgText);
    if (mode === 'android') {
      const s = await p.evaluate(() => window.__sizes.length);
      ok(`${T} canvas not resized while the keyboard animates`, s === 0, `${s} resizes`);
    }
    // keyboard dismissed without blurring (Android back / iOS keyboard hide)
    await keyboard(p, vp, mode, false); await sleep(1100);
    L = await layout(p);
    ok(`${T} keyboard hidden while the field keeps focus: full layout returns`, !/gs-kb/.test(L.cls) && L.tabs && L.dock, L.cls);
    ok(`${T} panel returns to its size from before the keyboard`, L.panel && Math.abs(L.panel.h - before.panel.h) <= 1 && Math.abs(L.panel.t - before.panel.t) <= 1, JSON.stringify({ before: before.panel, after: L.panel }));
    if (mode === 'android') { await sleep(400); const c = await layout(p); ok(`${T} canvas matches the window after the keyboard closes`, Math.abs(c.canvas[0] - Math.round(c.iw * c.dpr)) <= 1 && Math.abs(c.canvas[1] - Math.round(c.ih * c.dpr)) <= 1, JSON.stringify({ canvas: c.canvas, win: [c.iw, c.ih], dpr: c.dpr })); }
    // tap the focused field again: keyboard back
    await tapEl(p, '#desktop-chat-input'); await keyboard(p, vp, mode, true);
    // wait for the keyboard layout to settle (slow under load), as the other steps do
    for (let i = 0; i < 20 && !(await p.evaluate(() => document.documentElement.classList.contains('gs-kb-chat'))); i++) await sleep(100);
    await sleep(300);
    L = await layout(p);
    ok(`${T} tapping the field again brings the keyboard layout back`, /gs-kb-chat/.test(L.cls) && inside(L.input, L), L.cls);
    // blur (tap the scene)
    await keyboard(p, vp, mode, false);
    await p.evaluate(() => document.activeElement.blur()); await sleep(500);
    L = await layout(p);
    ok(`${T} blur restores the tabs, dock and Hide UI`, !/gs-kb/.test(L.cls) && L.tabs && L.dock && L.toggle && L.header, L.cls);
    // ---- theme chat input
    await tapEl(p, '[data-chat-section="theme"]');
    await tapEl(p, '#dchat-theme-chat-input'); await keyboard(p, vp, mode, true);
    L = await layout(p);
    ok(`${T} theme chat input visible above the keyboard`, /gs-kb-chat/.test(L.cls) && inside(L.themeInput, L) && !(await covers(p, '#dchat-theme-chat-input')), JSON.stringify(L.themeInput));
    await keyboard(p, vp, mode, false); await p.evaluate(() => document.activeElement.blur()); await sleep(400);
    await tapEl(p, '[data-chat-section="scene"]');
    // ---- code editor
    await tab(p, 'code');
    await p.evaluate(() => { const e = document.getElementById('dchat-code-editor'); e.value = Array.from({ length: 80 }, (_, i) => `// line ${i + 1}`).join('\n'); e.dispatchEvent(new Event('input')); });
    await tapEl(p, '#dchat-code-editor');
    await p.evaluate(() => { const e = document.getElementById('dchat-code-editor'); e.setSelectionRange(e.value.length, e.value.length); });
    await keyboard(p, vp, mode, true);
    await p.keyboard.type('\n// typed');
    L = await layout(p);
    if (mode === 'android' && portrait) await shot(p, `${vp.name}-keyboard-code`);
    const caret = await p.evaluate(() => { const e = document.getElementById('dchat-code-editor'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 30; });
    ok(`${T} code editor fills the visible area, caret line in view, Apply reachable`, /gs-kb-chat/.test(L.cls) && inside(L.code, L) && L.code.h >= (portrait ? 200 : 50) && caret && inside(L.apply, L), JSON.stringify({ code: L.code, apply: L.apply }));
    await keyboard(p, vp, mode, false); await p.evaluate(() => document.activeElement.blur()); await sleep(400);
    await tab(p, 'chat');
    ok(`${T} no console/page errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 4)));
    await p.close();
  }
}

// ---- Desktop: unchanged, no phone classes
if (!ONLY) for (const vp of [{ width: 1280, height: 800 }, { width: 700, height: 800 }]) {
  const T = `[desktop ${vp.width}x${vp.height}]`;
  const grab = async (base) => {
    const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await p.setViewport(vp); await p.goto(base + '/', { waitUntil: 'networkidle2' }); await sleep(2500);
    const g = await p.evaluate(() => { const R = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); }; return { cls: document.documentElement.className, rects: Object.fromEntries(['#desktop-chat', '#desktop-chat-header', '#desktop-chat-tabs', '.dchat-tab[data-tab="share"]', '#desktop-chat-input', '#desktop-send-button', '#desktop-attach-button', '#gs-dock', '#ui-toggle', '#desktop-model-select'].map(s => [s, R(s)])), more: getComputedStyle(document.getElementById('desktop-chat-more') || document.body).display }; });
    await p.focus('#desktop-chat-input'); await sleep(300); g.focusCls = await p.evaluate(() => document.documentElement.className);
    if (base === BASE) await p.screenshot({ path: `${SHOT_DIR}/${PREFIX}-desktop-${vp.width}x${vp.height}.png` });
    await p.close(); return { g, errs };
  };
  const now = await grab(BASE);
  ok(`${T} no phone / keyboard classes, even with the input focused`, !/gs-phone|gs-kb/.test(now.g.cls + now.g.focusCls) && now.g.more === 'none', now.g.cls + '|' + now.g.focusCls);
  if (DESKTOP_REF) {
    const ref = await grab(DESKTOP_REF);
    const diff = Object.keys(ref.g.rects).filter(k => ref.g.rects[k] !== now.g.rects[k]);
    ok(`${T} layout identical to ${DESKTOP_REF}`, diff.length === 0, JSON.stringify(diff.map(k => `${k}: ${ref.g.rects[k]} -> ${now.g.rects[k]}`)));
  }
  ok(`${T} no console/page errors`, now.errs.length === 0, JSON.stringify(now.errs.slice(0, 3)));
}
await b.close();
if (!SHOTS_ONLY) console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
