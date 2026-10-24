// Multiline (auto-growing) chat inputs: Scene + Theme chat.
//   BASE=https://localhost:3488 node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3488';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-multiline-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : e}`); console.log(results.at(-1)); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const LONG = 'Build a cosy reading nook: a deep green velvet armchair by a tall window, warm late-afternoon sun raking across a worn oak floor, a brass floor lamp, and a stack of old books on a small walnut side table.';

async function open(vp, mobile = false) {
  const p = await b.newPage(); p._errs = []; p._chat = []; p._theme = 0;
  p.on('pageerror', e => p._errs.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p._errs.push(m.text().slice(0, 200)); });
  if (mobile) await p.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
  await p.setViewport(mobile ? { width: vp.w, height: vp.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: vp.w, height: vp.h });
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    if (u.includes('/api/community-scenes') && req.method() === 'POST') return req.respond({ status: 503, body: 'blocked' });
    if (u.endsWith('/api/theme-chat')) { p._chat.push('THEME ' + (req.postData() || '')); return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'No theme change.' }] }) }); }
    if (u.endsWith('/api/chat')) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch {}
      const msgs = body.messages || []; const last = msgs[msgs.length - 1];
      const txt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content || '');
      p._chat.push(txt);
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'Mock reply.' }] }) });
    }
    req.continue();
  });
  await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(2500);
  return p;
}
const H = (p, sel = '#desktop-chat-input') => p.evaluate(s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { h: Math.round(r.height), sh: e.scrollHeight, ch: e.clientHeight, oy: getComputedStyle(e).overflowY, tag: e.tagName, val: e.value, lh: parseFloat(getComputedStyle(e).lineHeight), w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom) }; }, sel);

// ---------------- desktop
{
  const p = await open({ w: 1280, h: 800 });
  const T = '[desktop]';
  let a = await H(p);
  ok(`${T} chat input is a textarea`, a.tag === 'TEXTAREA', a.tag);
  ok(`${T} starts one line tall (${a.h}px)`, a.h >= 34 && a.h <= 42, JSON.stringify(a));
  const one = a.h;
  await p.click('#desktop-chat-input');
  await p.keyboard.type('first line');
  await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
  await p.keyboard.type('second line');
  a = await H(p);
  ok(`${T} Shift+Enter inserts a newline (no send)`, a.val === 'first line\nsecond line' && p._chat.length === 0, JSON.stringify(a.val));
  ok(`${T} grows to two lines`, a.h === one + a.lh, `${a.h} vs ${one}+${a.lh}`);
  await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
  await p.keyboard.type(LONG);
  a = await H(p);
  const sw = await p.evaluate(() => { const e = document.getElementById('desktop-chat-input'); return [e.scrollWidth, e.clientWidth]; });
  ok(`${T} long text wraps (no horizontal overflow) and grows`, a.h > one + a.lh && sw[0] <= sw[1], JSON.stringify({ a, sw }));
  await p.screenshot({ path: `${SHOT_DIR}/desktop-long-multiline.png` });
  // panel clip shot
  const box = await p.evaluate(() => { const r = document.getElementById('desktop-chat').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  await p.screenshot({ path: `${SHOT_DIR}/desktop-long-multiline-panel.png`, clip: box });
  for (let i = 0; i < 3; i++) { await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift'); await p.keyboard.type(LONG); }
  a = await H(p);
  const maxH = a.h;
  ok(`${T} capped at ~7 lines then scrolls (${a.h}px, ${Math.round((a.h - 20) / a.lh)} lines)`, Math.round((a.h - 20) / a.lh) === 7 && a.oy === 'auto' && a.sh > a.ch, JSON.stringify(a));
  const caret = await p.evaluate(() => { const e = document.getElementById('desktop-chat-input'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 2; });
  ok(`${T} caret line (end) stays in view while scrolling`, caret);
  await p.screenshot({ path: `${SHOT_DIR}/desktop-max-height-scroll.png` });
  const sent = a.val;
  await p.keyboard.press('Enter');
  for (let i = 0; i < 20 && p._chat.length === 0; i++) await sleep(150);
  await sleep(300);
  a = await H(p);
  ok(`${T} Enter sends the full multi-line text`, p._chat.length === 1 && p._chat[0].includes('first line\nsecond line') && p._chat[0].includes(LONG.slice(0, 40)), JSON.stringify(p._chat).slice(0, 200));
  ok(`${T} cleared and back to one line after send`, a.val === '' && a.h === one && a.oy === 'hidden', JSON.stringify(a));
  const bubble = await p.evaluate(() => { const m = [...document.querySelectorAll('#desktop-chat-messages .dchat-msg, #desktop-chat-messages > div')].map(e => e.textContent); return m.find(t => t.includes('first line')) || ''; });
  ok(`${T} sent message shows in the chat`, /first line/.test(bubble), bubble.slice(0, 80));
  // Send button + programmatic value (voice input / tests)
  await p.evaluate(t => { document.getElementById('desktop-chat-input').value = t; }, LONG + '\n' + LONG);
  a = await H(p);
  ok(`${T} programmatic .value write re-measures`, a.h > one + a.lh, JSON.stringify(a));
  await p.click('#desktop-send-button');
  for (let i = 0; i < 20 && p._chat.length < 2; i++) await sleep(150);
  await sleep(300);
  a = await H(p);
  ok(`${T} Send button sends + resets height`, p._chat.length === 2 && a.val === '' && a.h === one, JSON.stringify({ n: p._chat.length, a }));
  // Enter on empty does nothing
  await p.click('#desktop-chat-input'); await p.keyboard.press('Enter'); await sleep(300);
  a = await H(p);
  ok(`${T} Enter on empty input sends nothing, adds no newline`, p._chat.length === 2 && a.val === '', JSON.stringify(a.val));
  // camera controls stay off while typing (WASD in textarea)
  await p.keyboard.type('wasd'); a = await H(p);
  ok(`${T} WASD types into the textarea`, a.val === 'wasd', a.val);
  await p.evaluate(() => { document.getElementById('desktop-chat-input').value = ''; });
  // panel resize: narrower -> re-wrap
  await p.evaluate(t => { document.getElementById('desktop-chat-input').value = t; }, LONG.slice(0, 90));
  const wide = await H(p);
  await p.evaluate(() => { document.getElementById('desktop-chat').style.width = '300px'; }); await sleep(400);
  const narrow = await H(p);
  ok(`${T} narrower panel re-wraps (taller input)`, narrow.w < wide.w && narrow.h > wide.h && narrow.sh <= narrow.ch + 1, JSON.stringify({ wide, narrow }));
  await p.evaluate(() => { document.getElementById('desktop-chat').style.width = ''; document.getElementById('desktop-chat-input').value = ''; }); await sleep(300);
  // Theme chat
  await p.click('[data-chat-section="theme"]'); await sleep(300);
  let t = await H(p, '#dchat-theme-chat-input');
  ok(`[theme] textarea, one line (${t.h}px)`, t.tag === 'TEXTAREA' && t.h >= 28 && t.h <= 36, JSON.stringify(t));
  const tOne = t.h;
  await p.click('#dchat-theme-chat-input');
  await p.keyboard.type('dark emerald glass');
  await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
  await p.keyboard.type('soft rounded tabs and a very long description that should wrap onto more lines in the panel');
  t = await H(p, '#dchat-theme-chat-input');
  ok('[theme] Shift+Enter newline + grows', t.val.includes('\n') && t.h > tOne, JSON.stringify(t));
  await p.screenshot({ path: `${SHOT_DIR}/desktop-theme-multiline.png` });
  const before = p._chat.length;
  await p.keyboard.press('Enter');
  for (let i = 0; i < 20 && p._chat.length === before; i++) await sleep(150);
  await sleep(300);
  t = await H(p, '#dchat-theme-chat-input');
  ok('[theme] Enter sends (with the newline) + clears + one line', p._chat.length === before + 1 && /^THEME .*dark emerald glass\\nsoft/.test(p._chat.at(-1)) && t.val === '' && t.h === tOne, JSON.stringify({ n: p._chat.length, t }));
  await p.click('[data-chat-section="scene"]'); await sleep(200);
  // html-in-canvas paint of the panel with a multi-line value
  const painted = await p.evaluate(async (t) => {
    const mod = await import('/htmlInCanvas.js');
    const el = document.getElementById('desktop-chat-input'); el.value = t;
    const c = document.createElement('canvas');
    const root = document.getElementById('desktop-chat');
    mod.paintElementToCanvas(root, c, { maxSize: 2048 });
    const rr = root.getBoundingClientRect(); const r = el.getBoundingClientRect();
    const s = c.width / rr.width;
    const ctx = c.getContext('2d');
    // count rows with bright text pixels inside the textarea box
    const x0 = Math.round((r.left - rr.left + 8) * s), y0 = Math.round((r.top - rr.top) * s), w = Math.round((r.width - 16) * s), h = Math.round(r.height * s);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let rows = 0, inRun = false, runs = 0;
    for (let y = 0; y < h; y++) { let bright = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bright++; } if (bright > 2) { rows++; if (!inRun) { runs++; inRun = true; } } else inRun = false; }
    const lines = Math.round((r.height - 20) / parseFloat(getComputedStyle(el).lineHeight));
    window.__shotCanvas = c.toDataURL('image/png');
    return { runs, lines };
  }, 'first line\n' + LONG);
  ok(`[html-in-canvas] multi-line value is painted wrapped (${painted.runs} text rows, ${painted.lines} lines)`, painted.runs >= painted.lines && painted.lines >= 3, JSON.stringify(painted));
  const png = await p.evaluate(() => window.__shotCanvas);
  fs.writeFileSync(`${SHOT_DIR}/html-in-canvas-panel-multiline.png`, Buffer.from(png.split(',')[1], 'base64'));
  ok(`${T} no console/page errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 4)));
  await p.close();
}

// ---------------- phone
for (const vp of [{ w: 390, h: 844 }, { w: 844, h: 390 }]) {
  const T = `[phone ${vp.w}x${vp.h}]`;
  const p = await open(vp, true);
  const cls = await p.evaluate(() => document.documentElement.className);
  ok(`${T} phone layout`, /gs-phone/.test(cls), cls);
  let a = await H(p);
  ok(`${T} one line = 44px tall`, a.h === 44, JSON.stringify(a));
  const sendH = await p.evaluate(() => Math.round(document.getElementById('desktop-send-button').getBoundingClientRect().height));
  ok(`${T} Send stays 44px`, sendH >= 44, sendH);
  await p.tap('#desktop-chat-input');
  // simulate Android keyboard: shrink the window
  const kbH = vp.h > vp.w ? 330 : 200;
  await p.setViewport({ width: vp.w, height: vp.h - kbH, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await sleep(900);
  await p.keyboard.type('a red cube on a table');
  await p.keyboard.press('Enter');
  await p.keyboard.type(LONG);
  await sleep(400);
  a = await H(p);
  ok(`${T} Enter on the on-screen keyboard adds a new line (Send button sends)`, a.val.includes('\n') && p._chat.length === 0, JSON.stringify(a.val.slice(0, 40)));
  const L = await p.evaluate(() => { const vv = visualViewport; const r = s => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, h: b.height }; }; return { vvTop: vv.offsetTop, vvH: vv.height, input: r('#desktop-chat-input'), send: r('#desktop-send-button'), list: r('#desktop-chat-messages'), cls: document.documentElement.className }; });
  ok(`${T} keyboard up: input + Send fully visible`, /gs-kb-chat/.test(L.cls) && L.input.t >= L.vvTop && L.input.b <= L.vvTop + L.vvH && L.send.b <= L.vvTop + L.vvH, JSON.stringify(L));
  ok(`${T} keyboard up: input capped to about a third of the visible area`, L.input.h <= L.vvH * 0.34 + 1, `${L.input.h} of ${L.vvH}`);
  ok(`${T} keyboard up: chat list still has room (${Math.round(L.list.h)}px)`, L.list.h >= (vp.h > vp.w ? 150 : 40), JSON.stringify(L.list));
  await p.screenshot({ path: `${SHOT_DIR}/phone-${vp.w}x${vp.h}-keyboard-multiline.png` });
  await p.tap('#desktop-send-button');
  for (let i = 0; i < 20 && p._chat.length === 0; i++) await sleep(150);
  await sleep(500);
  a = await H(p);
  const active = await p.evaluate(() => document.activeElement && document.activeElement.id);
  ok(`${T} Send button sends, clears, back to 44px, keeps focus`, p._chat.length === 1 && p._chat[0].includes('\n') && a.val === '' && a.h === 44 && active === 'desktop-chat-input', JSON.stringify({ n: p._chat.length, a, active }));
  await p.setViewport({ width: vp.w, height: vp.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await sleep(600);
  ok(`${T} no console/page errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 4)));
  await p.close();
}

await b.close();
const f = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n${results.length - f}/${results.length} passed`);
process.exit(f ? 1 : 0);
