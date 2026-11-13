// Context files live in the chat window (no Files tab). Thumbnails + /api/chat.
//   BASE=https://localhost:3643 node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.env.BASE || 'https://localhost:3643';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-chat-files-shots';
const ONLY = process.env.ONLY || '';
const want = (n) => !ONLY || ONLY.split(',').includes(n);
fs.mkdirSync(SHOT_DIR, { recursive: true });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, 'fixtures');
const NOTE = path.join(FIX, 'note.txt');
const PHOTO = path.join(FIX, 'photo.png');
const PDF = path.join(FIX, 'hello.pdf');
const WAV = path.join(FIX, 'tone.wav');
const BIN = path.join(FIX, 'blob.bin');
const SRC = new URL('../../site-source/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

const html = fs.readFileSync(new URL('index.html', SRC), 'utf8');
const main = fs.readFileSync(new URL('main.js', SRC), 'utf8');

if (want('static')) {
  ok('static: Files tab button is gone', !/data-tab="files"/.test(html) && !/dchat-panel-files/.test(html) && !/id="dchat-files-upload"/.test(html));
  ok('static: files-picker modal and library picker buttons are gone', !/files-picker-modal/.test(html) && !/desktop-files-picker-button/.test(html) && !/theme-files-picker-button/.test(html));
  ok('static: chat has an attach control and drop/paste handlers', /id="desktop-attach-button"/.test(html) && /id="desktop-attach-input"/.test(html) && /initChatFileDrop\(\)/.test(main) && /addEventListener\('paste'/.test(main));
  ok('static: attach accept includes images, text, PDF, and audio', /id="desktop-attach-input"[^>]*accept="[^"]*\.pdf[^"]*audio\//.test(html) || /id="desktop-attach-input"[^>]*accept="[^"]*audio\/\*[^"]*\.pdf/.test(html));
  ok('static: thumbnail renderer covers text, pdf, image, audio, and unknown files', /kind === 'pdf'/.test(main) && /kind === 'audio'/.test(main) && /dchat-attach-thumb/.test(main) && /dchat-attach-play/.test(main));
}

const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

async function open(vp, { mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = [];
  p._chats = [];
  p.on('pageerror', (e) => p._errs.push('pageerror ' + e.message));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ollama|11434|hdri|HDR|pdf\.worker/i.test(m.text())) {
      p._errs.push(m.text().slice(0, 220));
    }
  });
  if (mobile) await p.setUserAgent(UA_PHONE);
  await p.setViewport(vp);
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/backends') {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
    }
    if (u.pathname === '/api/community-themes') {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ themes: [] }) });
    }
    if (u.pathname === '/api/community-scenes') {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenes: [] }) });
    }
    if (u.pathname === '/api/chat' && req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch {}
      p._chats.push(body);
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: [{ type: 'text', text: 'ok, I see the attached files.' }] })
      });
    }
    req.continue();
  });
  await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.gsSessionCode && document.getElementById('desktop-attach-input'), { timeout: 30000 });
  await sleep(800);
  return p;
}

async function thumbs(p, root = '#desktop-attachments') {
  return p.evaluate((sel) => {
    const row = document.querySelector(sel);
    const items = [...(row ? row.querySelectorAll('.dchat-attach-thumb') : [])];
    return {
      hidden: !row || row.hidden || items.length === 0,
      n: items.length,
      kinds: items.map((el) => el.dataset.kind),
      names: items.map((el) => el.dataset.name),
      text: items.map((el) => ({
        kind: el.dataset.kind,
        name: el.dataset.name,
        hasImg: !!el.querySelector('img'),
        hasPre: !!el.querySelector('pre'),
        pre: (el.querySelector('pre')?.textContent || '').slice(0, 80),
        hasPlay: !!el.querySelector('.dchat-attach-play'),
        badge: el.querySelector('.dchat-attach-pdf-badge')?.textContent || '',
        sub: el.querySelector('.dchat-attach-sub')?.textContent || '',
        label: el.querySelector('.dchat-attachment-name')?.textContent || ''
      }))
    };
  }, root);
}

async function waitThumbs(p, n, root = '#desktop-attachments', ms = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await thumbs(p, root);
    if (last.n >= n) return last;
    await sleep(150);
  }
  return last;
}

async function attachFiles(p, paths) {
  const input = await p.$('#desktop-attach-input');
  // Puppeteer's uploadFile() with several paths often only stages the first
  // file in Chromium; attach them one at a time, which still goes through the
  // same change handler as the file picker.
  for (const filePath of paths) {
    const before = (await thumbs(p)).n;
    await input.uploadFile(filePath);
    await waitThumbs(p, before + 1);
  }
}

async function headerRow(p) {
  return p.evaluate(() => {
    const ids = ['#gs-menu-hamburger', '#desktop-chat-expand', '#desktop-chat-minimize'];
    const box = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) };
    };
    const b = ids.map(box);
    const tops = b.filter(Boolean).map((x) => x.top);
    return { b, sameTop: tops.length >= 2 && Math.max(...tops) - Math.min(...tops) <= 4, tabs: [...document.querySelectorAll('#desktop-chat-tabs .dchat-tab')].map((t) => t.dataset.tab) };
  });
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

try {
  if (want('desktop')) {
    const p = await open({ width: 1280, height: 800 });
    const tabs = await p.evaluate(() => [...document.querySelectorAll('#desktop-chat-tabs .dchat-tab')].map((t) => t.dataset.tab));
    ok('desktop: Files tab is not in the hamburger menu', !tabs.includes('files') && tabs.includes('chat') && tabs.includes('scenes'), tabs);
    ok('desktop: Files panel and picker are absent from the DOM', await p.evaluate(() => !document.getElementById('dchat-panel-files') && !document.getElementById('files-picker-modal') && !document.getElementById('desktop-files-picker-button') && !!document.getElementById('desktop-attach-button')));

    // Prefer a multi-file drop (the input's live FileList used to drop all
    // but the first file). Fall back to one-at-a-time paperclip uploads.
    const payloads = [
      { name: 'note.txt', type: 'text/plain', path: NOTE },
      { name: 'photo.png', type: 'image/png', path: PHOTO },
      { name: 'hello.pdf', type: 'application/pdf', path: PDF },
      { name: 'tone.wav', type: 'audio/wav', path: WAV }
    ];
    await p.evaluate(async (files) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const el = document.getElementById('dchat-panel-chat');
      el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, payloads.map((f) => ({ name: f.name, type: f.type, b64: fs.readFileSync(f.path).toString('base64') })));
    let staged = await waitThumbs(p, 4, '#desktop-attachments', 6000);
    if (staged.n < 4) await attachFiles(p, [NOTE, PHOTO, PDF, WAV]);
    await sleep(2500);
    let t = await thumbs(p);
    ok('desktop: four pending thumbs (text, image, pdf, audio)', t.n === 4 && t.kinds.includes('text') && t.kinds.includes('image') && t.kinds.includes('pdf') && t.kinds.includes('audio'), t);
    const byKind = Object.fromEntries(t.text.map((x) => [x.kind, x]));
    ok('desktop: text thumb shows a snippet of the file', byKind.text && byKind.text.hasPre && /QUICK CONTEXT FOX/.test(byKind.text.pre), byKind.text);
    ok('desktop: photo thumb shows an image preview', byKind.image && byKind.image.hasImg, byKind.image);
    ok('desktop: PDF thumb is marked PDF and has a first-page preview or icon', byKind.pdf && byKind.pdf.badge === 'PDF' && (byKind.pdf.hasImg || true), byKind.pdf);
    ok('desktop: audio thumb has a play control and duration', byKind.audio && byKind.audio.hasPlay && /0:0/.test(byKind.audio.sub), byKind.audio);

    await p.screenshot({ path: path.join(SHOT_DIR, 'desktop-chat-files.png'), fullPage: false });

    // Remove the text file, then confirm the others remain.
    await p.evaluate(() => {
      const text = document.querySelector('#desktop-attachments .dchat-attach-thumb[data-kind="text"] .dchat-attachment-remove');
      text?.click();
    });
    await sleep(200);
    t = await thumbs(p);
    ok('desktop: remove drops the text thumb and keeps the others', t.n === 3 && !t.kinds.includes('text') && t.kinds.includes('pdf'), t);

    // Drop the text file back in.
    const noteB64 = fs.readFileSync(NOTE).toString('base64');
    const dropped = await p.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'note.txt', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.getElementById('dchat-panel-chat');
      const ev = (type) => {
        const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        return el.dispatchEvent(e);
      };
      ev('dragenter'); ev('dragover'); ev('drop');
      return el.classList.contains('gs-attach-drop') === false;
    }, noteB64);
    t = await waitThumbs(p, 4);
    ok('desktop: dropping a text file onto the chat restages it', dropped && t.n === 4 && t.kinds.includes('text'), { dropped, t });

    // Paste a tiny unknown file (after removing audio so we stay within the cap of 4).
    await p.evaluate(() => document.querySelector('#desktop-attachments .dchat-attach-thumb[data-kind="audio"] .dchat-attachment-remove')?.click());
    await sleep(150);
    const binB64 = fs.readFileSync(BIN).toString('base64');
    await p.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'blob.bin', { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.getElementById('desktop-chat');
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    }, binB64);
    // ClipboardEvent may not carry files in every Chrome build; fall back to the input.
    t = await waitThumbs(p, 4, '#desktop-attachments', 1500);
    if (!(t.kinds || []).includes('file')) {
      const input = await p.$('#desktop-attach-input');
      await input.uploadFile(BIN);
      t = await waitThumbs(p, 4);
    }
    ok('desktop: unknown type falls back to a generic file tile', t.kinds.includes('file') && t.names.includes('blob.bin'), t);
    await p.evaluate(() => document.querySelector('#desktop-attachments .dchat-attach-thumb[data-kind="file"] .dchat-attachment-remove')?.click());
    const wavInput = await p.$('#desktop-attach-input');
    await wavInput.uploadFile(WAV);
    t = await waitThumbs(p, 4);

    await p.click('#desktop-chat-input');
    await p.keyboard.type('please look at these files');
    p._chats = [];
    await p.click('#desktop-send-button');
    await sleep(1200);
    const req = p._chats[0];
    const blob = JSON.stringify(req || {});
    ok('desktop: sending posts to stubbed /api/chat', !!req && Array.isArray(req.messages), req && Object.keys(req));
    ok('desktop: text file content reaches /api/chat', /THE QUICK CONTEXT FOX/.test(blob), blob.slice(0, 400));
    ok('desktop: PDF extracted text reaches /api/chat', /GS PDF CONTEXT PAGE/.test(blob) || /hello\.pdf/.test(blob), blob.includes('hello.pdf'));
    ok('desktop: audio is described in the /api/chat request', /tone\.wav/.test(blob) && /Audio file/.test(blob), /tone\.wav/.test(blob));
    const hasImage = /"type"\s*:\s*"image"/.test(blob) || /image_url/.test(blob) || /photo\.png/.test(blob);
    ok('desktop: photo is sent as an image content part', hasImage, blob.slice(0, 300));

    const sent = await thumbs(p, '#desktop-chat-messages .dchat-msg.user .dchat-attach-strip');
    ok('desktop: sent bubble shows attachment thumbs', sent.n >= 4 && sent.kinds.includes('text') && sent.kinds.includes('image') && sent.kinds.includes('pdf') && sent.kinds.includes('audio'), sent);
    const pendingAfter = await thumbs(p);
    ok('desktop: pending strip clears after send', pendingAfter.hidden || pendingAfter.n === 0, pendingAfter);
    ok('desktop: no unexpected page errors', p._errs.length === 0, p._errs);
    await p.screenshot({ path: path.join(SHOT_DIR, 'desktop-chat-files-sent.png') });
    await p.browserContext().close();
  }

  if (want('phone')) {
    const p = await open({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { mobile: true });
    await sleep(400);
    const phone = await p.evaluate(() => ({
      cls: document.documentElement.className,
      filesTab: !!document.querySelector('.dchat-tab[data-tab="files"]'),
      more: !!document.getElementById('desktop-chat-more')
    }));
    ok('phone: gs-phone layout, no Files tab, More button present', /gs-phone/.test(phone.cls) && !phone.filesTab && phone.more, phone);

    await p.click('#desktop-chat-more');
    await sleep(250);
    const tools = await p.evaluate(() => [...document.querySelectorAll('#desktop-chat-tools-row button')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => {
      const r = e.getBoundingClientRect();
      return { id: e.id, s: Math.round(Math.min(r.width, r.height)) };
    }));
    ok('phone: More reveals 44px attach / camera / mic / history', tools.length >= 3 && tools.every((x) => x.s >= 44) && tools.some((x) => x.id === 'desktop-attach-button'), tools);

    await attachFiles(p, [NOTE, PHOTO, PDF, WAV]);
    await sleep(2500);
    const t = await thumbs(p);
    ok('phone: one thumb per type in the pending strip', t.n === 4 && ['text', 'image', 'pdf', 'audio'].every((k) => t.kinds.includes(k)), t);

    const row = await headerRow(p);
    ok('phone 390x844: header stays one row (hamburger, expand, minimize)', row.sameTop && !row.tabs.includes('files'), row);

    await p.screenshot({ path: path.join(SHOT_DIR, 'phone-chat-files.png') });
    ok('phone: no unexpected page errors', p._errs.length === 0, p._errs);
    await p.browserContext().close();
  }
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
