// Puppeteer: Community grid at desktop and phone widths, thumbnail captured
// from the initial camera pose (not the moved view), description edit + persist.
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || '/workspace/gs-community-grid-shots';
const PORT = Number(process.env.SIM_PORT || 3621);
const BASE = process.env.BASE || `http://localhost:${PORT}`;
mkdirSync(SHOTS, { recursive: true });

const jpeg = readFileSync(join(dir, 'sample.jpg'));
const jpegUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

let fails = 0, n = 0;
const results = [];
const ok = (name, cond, extra = '') => {
  n++; if (!cond) fails++;
  const line = `${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`;
  results.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => { s.close(() => resolve(false)); });
    s.listen(port, '127.0.0.1');
  });
}
async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 501) return; } catch { /* not up */ }
    await sleep(150);
  }
  throw new Error('timeout waiting for ' + url);
}

let child = null;
if (!(await portOpen(PORT))) {
  // free — start vercel-sim ourselves
} else {
  // already in use: assume a prior sim; we'll use it and not kill it
}
if (!(await (async () => {
  try { const r = await fetch(BASE + '/api/community-scenes'); return r.ok || r.status === 501 || r.status === 200; } catch { return false; }
})())) {
  child = spawn('node', [join(dir, 'vercel-sim.mjs')], {
    env: { ...process.env, SIM_PORT: String(PORT), VERCEL: '1', BLOB_READ_WRITE_TOKEN: 'test-token', CLAUDE_API_KEY: 'dummy', OPENAI_API_KEY: 'dummy' },
    stdio: 'inherit'
  });
  await waitFor(BASE + '/api/community-scenes');
}

const post = (body) => fetch(BASE + '/api/community-scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// Seed a grid: some with thumbs, some without, one with a description.
const seeds = [];
for (let i = 1; i <= 5; i++) {
  seeds.push(await post({
    version: 1,
    name: i % 2 ? `Garden ${i}` : `Studio ${i}`,
    codeBlocks: [`/* seed ${i} */`],
    thumbnail: i <= 3 ? jpegUrl : '',
    description: i === 2 ? 'Already written.\nA second line.' : ''
  }));
}
ok('seeded scenes', seeds.every((s) => s.ok && s.id), seeds.map((s) => s.id).join(','));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function newPage(vp) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = [];
  p.on('pageerror', (e) => p._errs.push(String(e)));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ollama|11434/i.test(m.text())) p._errs.push(m.text());
  });
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const u = req.url();
    if (u.endsWith('/api/chat') || u.endsWith('/api/fix-code')) {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) });
    }
    if (u.endsWith('/api/backends')) {
      return req.respond({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ backends: { 'claude-haiku-55': { label: 'Claude Haiku 5.5', provider: 'claude', available: true } }, default: 'claude-haiku-55' })
      });
    }
    req.continue();
  });
  if (vp.isMobile) await p.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
  await p.setViewport(vp);
  await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  return p;
}

const openCommunity = async (p, { expand = false, width } = {}) => {
  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="community"]').click());
  await sleep(600);
  await p.evaluate((expand, width) => {
    const el = document.getElementById('desktop-chat');
    if (expand) el.classList.add('expanded');
    if (width) { el.style.width = width + 'px'; el.style.height = '820px'; }
  }, expand, width || 0);
  await p.waitForFunction(() => {
    const list = document.getElementById('dchat-community-list');
    return list && (list.querySelector('.dchat-community-scene') || /No community|Loading/.test(list.textContent || ''));
  }, { timeout: 15000 });
  await sleep(400);
  // Let lazy images start
  await p.evaluate(() => Promise.all([...document.querySelectorAll('#dchat-community-list img')].map((img) => img.decode?.().catch(() => {}) || Promise.resolve())));
  await sleep(200);
};

const inspectGrid = (p) => p.evaluate(() => {
  const list = document.getElementById('dchat-community-list');
  const cs = getComputedStyle(list);
  const tiles = [...list.querySelectorAll('.dchat-community-scene')];
  const listBox = list.getBoundingClientRect();
  const rects = tiles.map((t) => {
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const colXs = [...new Set(rects.map((r) => r.x))].sort((a, b) => a - b);
  return {
    display: cs.display,
    gridTemplateColumns: cs.gridTemplateColumns,
    colCount: colXs.length,
    tileCount: tiles.length,
    listW: Math.round(listBox.width),
    widths: rects.map((r) => r.w),
    heights: rects.map((r) => r.h),
    thumbs: tiles.filter((t) => t.querySelector('.dchat-community-thumb')).length,
    thumbImgs: tiles.filter((t) => t.querySelector('.dchat-community-thumb img')).length,
    hasLoad: tiles.every((t) => [...t.querySelectorAll('button')].some((b) => /^Load$/i.test(b.textContent.trim()))),
    hasShare: tiles.every((t) => [...t.querySelectorAll('button')].some((b) => /^Share$/i.test(b.textContent.trim()))),
    hasMerge: tiles.filter((t) => t.querySelector('.gs-merge-row-btn')).length,
    placeholders: tiles.filter((t) => t.querySelector('.dchat-community-thumb') && !t.querySelector('.dchat-community-thumb img')).length,
    descs: tiles.map((t) => {
      const ta = t.querySelector('.dchat-community-desc');
      return ta ? { value: ta.value, readonly: ta.readOnly, placeholder: ta.placeholder } : null;
    })
  };
});

async function avgColorFromDataUrl(p, dataUrl) {
  return p.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    // Center 50% crop — where the colored box sits.
    const x0 = Math.floor(width * 0.25), x1 = Math.floor(width * 0.75);
    const y0 = Math.floor(height * 0.25), y1 = Math.floor(height * 0.75);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return { r: r / n, g: g / n, b: b / n, w: width, h: height };
  }, dataUrl);
}

function moreRedThanBlue(c) { return c.r > c.b + 25 && c.r > 40; }
function moreBlueThanRed(c) { return c.b > c.r + 25 && c.b > 40; }

// ------------- desktop grid -------------
{
  const p = await newPage({ width: 1280, height: 860 });
  await openCommunity(p, { expand: true });
  const g = await inspectGrid(p);
  ok('[desktop] list is a CSS grid', g.display === 'grid', JSON.stringify(g));
  ok('[desktop] several tiles', g.tileCount >= 5, String(g.tileCount));
  ok('[desktop] more than one column when wide', g.colCount >= 2, `cols=${g.colCount} listW=${g.listW} tmpl=${g.gridTemplateColumns}`);
  ok('[desktop] large tiles (~240px+)', g.widths.every((w) => w >= 220), JSON.stringify(g.widths));
  ok('[desktop] tiles are tall (thumb + body)', g.heights.every((h) => h >= 180), JSON.stringify(g.heights));
  ok('[desktop] every tile has a thumb box', g.thumbs === g.tileCount);
  ok('[desktop] seeded thumbs appear as images', g.thumbImgs >= 3, String(g.thumbImgs));
  ok('[desktop] scenes without thumbs keep a placeholder', g.placeholders >= 1, String(g.placeholders));
  ok('[desktop] Load / Share / Merge still present', g.hasLoad && g.hasShare && g.hasMerge >= 2, JSON.stringify({ load: g.hasLoad, share: g.hasShare, merge: g.hasMerge }));
  // Every tile has a description section, including scenes with no description.
  const written = g.descs.find((d) => d && d.value.includes('Already written'));
  ok('[desktop] existing description shown', !!(written && written.value.includes('second line')), JSON.stringify(written));
  ok('[desktop] every tile has a description section', g.descs.length === g.tileCount && g.descs.every((d) => d), JSON.stringify(g.descs));
  const emptyDescs = g.descs.filter((d) => d && d.value === '');
  ok('[desktop] empty descriptions show a placeholder', emptyDescs.length >= 1 && emptyDescs.every((d) => /no description yet/i.test(d.placeholder || '')), JSON.stringify(emptyDescs));
  const editButtons = await p.evaluate(() => document.querySelectorAll('#dchat-community-list .dchat-community-desc-edit').length);
  ok('[desktop] every tile has an Edit affordance', editButtons === g.tileCount, String(editButtons));
  await p.screenshot({ path: join(SHOTS, 'desktop-grid.png'), fullPage: false });
  // Placeholder + edit-state shots (an empty tile).
  const editShot = await p.evaluate(() => {
    const tiles = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')];
    const empty = tiles.find((t) => {
      const ta = t.querySelector('.dchat-community-desc');
      return ta && ta.value === '';
    });
    if (!empty) return { ok: false };
    empty.querySelector('.dchat-community-desc-edit')?.click();
    const ta = empty.querySelector('.dchat-community-desc');
    return {
      ok: true,
      editing: empty.querySelector('.dchat-community-desc-wrap')?.classList.contains('is-editing'),
      readonly: !!(ta && ta.readOnly),
      placeholder: ta?.placeholder || '',
      hasSave: !!empty.querySelector('.dchat-community-desc-save:not([hidden])'),
      hasCancel: !!empty.querySelector('.dchat-community-desc-cancel:not([hidden])')
    };
  });
  ok('[desktop] Edit opens save/cancel on an empty description', !!(editShot.ok && editShot.editing && !editShot.readonly && editShot.hasSave && editShot.hasCancel && /no description yet/i.test(editShot.placeholder)), JSON.stringify(editShot));
  await p.screenshot({ path: join(SHOTS, 'desktop-edit-empty.png'), fullPage: false });
  await p.evaluate(() => {
    document.querySelector('#dchat-community-list .dchat-community-desc-cancel:not([hidden])')?.click();
  });
  // VR-menu-sized paint (600×700, same DOM htmlInCanvas draws).
  const vrPaint = await p.evaluate(() => {
    const src = document.getElementById('desktop-chat');
    const prev = { w: src.style.width, h: src.style.height };
    src.classList.remove('expanded');
    src.style.width = '600px';
    src.style.height = '700px';
    src.offsetWidth;
    const canvas = document.createElement('canvas');
    window.__gsPaintElementToCanvas(src, canvas, { maxSize: 1600, opaque: true, pixelScale: 1.5 });
    const url = canvas.toDataURL('image/png');
    src.style.width = prev.w;
    src.style.height = prev.h;
    src.classList.add('expanded');
    return { url, w: canvas.width, h: canvas.height };
  });
  if (vrPaint?.url) {
    writeFileSync(join(SHOTS, 'vr-menu-community.png'), Buffer.from(vrPaint.url.split(',')[1], 'base64'));
    ok('[desktop] VR menu paint produced an image', vrPaint.w > 200 && vrPaint.h > 200, JSON.stringify({ w: vrPaint.w, h: vrPaint.h }));
  } else {
    ok('[desktop] VR menu paint produced an image', false, 'no data');
  }
  await p.browserContext().close();
}

// ------------- phone grid -------------
{
  const p = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await openCommunity(p, { expand: true });
  const g = await inspectGrid(p);
  ok('[phone] list is a CSS grid', g.display === 'grid', JSON.stringify({ display: g.display, tmpl: g.gridTemplateColumns }));
  ok('[phone] one column', g.colCount === 1, `cols=${g.colCount} listW=${g.listW} tmpl=${g.gridTemplateColumns}`);
  ok('[phone] tiles nearly full width', g.widths.every((w) => w >= g.listW * 0.8), JSON.stringify({ widths: g.widths, listW: g.listW }));
  ok('[phone] tiles are tall (not collapsed)', g.heights.every((h) => h >= 180), JSON.stringify(g.heights));
  ok('[phone] Load still present', g.hasLoad);
  ok('[phone] every tile has a description section', g.descs.length === g.tileCount && g.descs.every((d) => d), JSON.stringify(g.descs));
  ok('[phone] empty descriptions show a placeholder', g.descs.filter((d) => d && d.value === '').every((d) => /no description yet/i.test(d.placeholder || '')), JSON.stringify(g.descs));
  await p.screenshot({ path: join(SHOTS, 'phone-grid.png') });
  await p.browserContext().close();
}

// ------------- thumbnail from initial camera + description edit -------------
{
  const p = await newPage({ width: 1280, height: 860 });
  // Build a distinctive scene, then move the camera, then upload.
  const setup = await p.evaluate(async () => {
    window.gsControls?.setMode?.('off');
    await window.gsSessionCode.add(`
      scene.background = new THREE.Color(0x000000);
      const red = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.6), new THREE.MeshBasicMaterial({ color: 0xff1800 }));
      red.name = 'thumbRed';
      red.position.set(0, 1.2, 0);
      scene.add(red);
      const blue = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.6), new THREE.MeshBasicMaterial({ color: 0x0028ff }));
      blue.name = 'thumbBlue';
      blue.position.set(30, 1.2, 0);
      scene.add(blue);
    `);
    // Let a frame render at the initial pose.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const initial = window.__gsCaptureCommunityThumbnail({ initial: true });
    window.camera.position.set(30, 1.6, 4);
    window.camera.up.set(0, 1, 0);
    window.camera.lookAt(30, 1.2, 0);
    window.camera.updateMatrixWorld(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const moved = window.__gsCaptureCommunityThumbnail({ initial: false });
    const stillInitial = window.__gsCaptureCommunityThumbnail({ initial: true });
    const camAfterInitialCapture = { x: window.camera.position.x, y: window.camera.position.y, z: window.camera.position.z };
    return { initial, moved, stillInitial, camAfterInitialCapture, initialLen: (initial || '').length, movedLen: (moved || '').length };
  });
  ok('initial-pose capture produced an image', !!(setup.initial && setup.initial.startsWith('data:image/')), `len=${setup.initialLen}`);
  ok('moved-view capture produced an image', !!(setup.moved && setup.moved.startsWith('data:image/')), `len=${setup.movedLen}`);
  const cInit = await avgColorFromDataUrl(p, setup.initial);
  const cMoved = await avgColorFromDataUrl(p, setup.moved);
  const cStill = await avgColorFromDataUrl(p, setup.stillInitial);
  ok('initial view is red (the origin box)', moreRedThanBlue(cInit), JSON.stringify(cInit));
  ok('moved view is blue (the side box)', moreBlueThanRed(cMoved), JSON.stringify(cMoved));
  ok('capture({initial:true}) still matches the origin after the camera moved', moreRedThanBlue(cStill), JSON.stringify(cStill));
  ok('camera was left at the moved pose (capture restores it)', Math.abs(setup.camAfterInitialCapture.x - 30) < 0.01, JSON.stringify(setup.camAfterInitialCapture));
  // Save a sample thumbnail (the initial-pose one).
  writeFileSync(join(SHOTS, 'sample-thumbnail.webp'), Buffer.from(setup.initial.split(',')[1], 'base64'));
  // If it's jpeg the name is slightly wrong; also write a .bin-sniffed extension.
  const thumbExt = setup.initial.startsWith('data:image/webp') ? 'webp' : setup.initial.startsWith('data:image/png') ? 'png' : 'jpg';
  writeFileSync(join(SHOTS, `sample-thumbnail.${thumbExt}`), Buffer.from(setup.initial.split(',')[1], 'base64'));

  // Upload while the camera is still at the blue box.
  await openCommunity(p, { expand: true });
  await p.evaluate(() => {
    const btn = document.querySelector('#dchat-community-buttons [data-action="community:upload"], [data-action="community:upload"]');
    if (btn) btn.click();
  });
  await p.waitForFunction(() => {
    const modal = document.getElementById('share-modal');
    const status = document.body.innerText || '';
    return (modal && modal.classList.contains('visible')) || /Uploaded/.test(status) || /Upload error/.test(status);
  }, { timeout: 25000 });
  const uploadStatus = await p.evaluate(() => document.body.innerText.slice(0, 500));
  const share = await p.evaluate(() => {
    const input = document.getElementById('share-url');
    const modal = document.getElementById('share-modal');
    return { visible: !!(modal && modal.classList.contains('visible')), url: input ? input.value : '' };
  });
  ok('upload succeeded', /Uploaded/.test(uploadStatus) || share.visible, uploadStatus.slice(0, 180) + ' ' + JSON.stringify(share));
  // Close the share modal if it opened.
  await p.evaluate(() => document.getElementById('share-close-btn')?.click());
  await sleep(800);

  // Find the new scene id from the list (most recent owner tile) or share URL.
  const uploadedId = await p.evaluate(() => {
    const url = document.getElementById('share-url')?.value || '';
    const m = url.match(/\/e\/([A-Za-z0-9_-]+)/) || url.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    const toggle = document.querySelector('#dchat-community-list [data-community-export-toggle]');
    return toggle?.closest('.dchat-community-scene')?.dataset.sceneId || '';
  });
  ok('uploaded scene id', !!uploadedId, String(uploadedId));

  if (uploadedId) {
    const thumbRes = await fetch(`${BASE}/api/community-scenes/${uploadedId}/thumb`);
    const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
    const ctype = thumbRes.headers.get('content-type') || '';
    ok('thumb endpoint serves the upload', thumbRes.ok && thumbBuf.length > 200 && /image\/(webp|jpeg|png)/.test(ctype), `${thumbRes.status} ${ctype} ${thumbBuf.length}`);
    ok('thumb is compact (<60KB)', thumbBuf.length < 60 * 1024, String(thumbBuf.length));
    writeFileSync(join(SHOTS, 'served-thumbnail.bin'), thumbBuf);
    const servedUrl = `data:${ctype};base64,${thumbBuf.toString('base64')}`;
    writeFileSync(join(SHOTS, 'served-thumbnail.' + (ctype.includes('webp') ? 'webp' : ctype.includes('png') ? 'png' : 'jpg')), thumbBuf);
    const cServed = await avgColorFromDataUrl(p, servedUrl);
    ok('served thumb matches the INITIAL (red) view, not the moved (blue) one', moreRedThanBlue(cServed) && !moreBlueThanRed(cServed), JSON.stringify(cServed));
    const alias = await fetch(`${BASE}/api/scenes/${uploadedId}/thumb`);
    ok('/api/scenes/:id/thumb alias serves the same bytes', alias.ok && Buffer.from(await alias.arrayBuffer()).equals(thumbBuf), String(alias.status));

    // Description: blank by default, section present, Edit affordance visible.
    const descInfo = await p.evaluate((id) => {
      const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
      const ta = tile?.querySelector('.dchat-community-desc');
      return ta ? {
        value: ta.value,
        readonly: ta.readOnly,
        placeholder: ta.placeholder,
        hasEdit: !!tile.querySelector('.dchat-community-desc-edit:not([hidden])'),
        hasSave: !!tile.querySelector('.dchat-community-desc-save')
      } : null;
    }, uploadedId);
    ok('new scene description is blank with placeholder', descInfo && descInfo.value === '' && /no description yet/i.test(descInfo.placeholder || ''), JSON.stringify(descInfo));
    ok('Edit affordance is present on a new scene', !!(descInfo && descInfo.hasEdit));

    // Clicking / typing in the description does not load / navigate.
    const beforeClick = await p.evaluate(() => location.href);
    await p.evaluate((id) => {
      const ta = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"] .dchat-community-desc`);
      ta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, uploadedId);
    await sleep(200);
    const afterClick = await p.evaluate(() => location.href);
    ok('clicking the description does not navigate', beforeClick === afterClick);

    // Esc / Cancel restores the previous value and leaves edit mode.
    await p.evaluate((id) => {
      const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
      tile?.querySelector('.dchat-community-desc-edit')?.click();
      const ta = tile?.querySelector('.dchat-community-desc');
      ta.value = 'should not be saved';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }, uploadedId);
    const afterEsc = await p.evaluate((id) => {
      const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
      const ta = tile?.querySelector('.dchat-community-desc');
      return {
        value: ta?.value,
        editing: tile?.querySelector('.dchat-community-desc-wrap')?.classList.contains('is-editing'),
        hasEdit: !!tile?.querySelector('.dchat-community-desc-edit:not([hidden])')
      };
    }, uploadedId);
    ok('Esc cancels an unsaved description', afterEsc.value === '' && afterEsc.editing === false && afterEsc.hasEdit, JSON.stringify(afterEsc));

    // Edit + persist (Save) with multiline and HTML-looking text; UI re-renders.
    const DESC = 'Line one\n<script>alert(1)</script>\nLine three & "quotes"';
    await p.evaluate((id, text) => {
      const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
      tile?.querySelector('.dchat-community-desc-edit')?.click();
      const ta = tile?.querySelector('.dchat-community-desc');
      ta.focus();
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, uploadedId, DESC);
    await p.screenshot({ path: join(SHOTS, 'desktop-edit-filled.png'), fullPage: false });
    await p.evaluate((id) => {
      const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
      const ta = tile?.querySelector('.dchat-community-desc');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      const btn = tile?.querySelector('.dchat-community-desc-save');
      if (btn && !btn.hidden) btn.click();
    }, uploadedId);
    await p.waitForFunction((id, text) => {
      const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
      const ta = tile?.querySelector('.dchat-community-desc');
      const save = tile?.querySelector('.dchat-community-desc-save');
      const edit = tile?.querySelector('.dchat-community-desc-edit');
      return ta && ta.value === text && ta.readOnly && (!save || save.hidden) && edit && !edit.hidden;
    }, { timeout: 10000 }, uploadedId, DESC).catch(() => {});
    const savedUi = await p.evaluate((id) => {
      const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
      const ta = tile?.querySelector('.dchat-community-desc');
      return {
        value: ta?.value,
        readonly: !!(ta && ta.readOnly),
        editing: tile?.querySelector('.dchat-community-desc-wrap')?.classList.contains('is-editing'),
        hasEdit: !!tile?.querySelector('.dchat-community-desc-edit:not([hidden])'),
        scriptNodes: tile ? tile.querySelectorAll('script').length : -1,
        html: tile ? tile.innerHTML.includes('<script>alert') : false
      };
    }, uploadedId);
    ok('description saved in the UI (multiline preserved)', savedUi.value === DESC, JSON.stringify(savedUi));
    ok('save leaves view mode and re-renders the text', savedUi.readonly && savedUi.editing === false && savedUi.hasEdit, JSON.stringify(savedUi));
    ok('description is escaped (no HTML injection)', savedUi.scriptNodes === 0 && savedUi.html === false, JSON.stringify(savedUi));

    const recRes = await fetch(`${BASE}/api/community-scenes/${uploadedId}`);
    const rec = await recRes.json();
    ok('description persisted on the server', recRes.ok && rec.description === DESC, `${recRes.status} ${JSON.stringify(rec.description ?? rec)}`);

    // Reload: value comes back, still escaped.
    await p.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);
    await openCommunity(p, { expand: true });
    const reloaded = await p.evaluate((id) => {
      const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
      const ta = tile?.querySelector('.dchat-community-desc');
      return { value: ta?.value, readonly: ta?.readOnly, scripts: tile ? tile.querySelectorAll('script').length : -1 };
    }, uploadedId);
    ok('description survives reload', reloaded.value === DESC, JSON.stringify(reloaded));
    ok('reloaded description still not injected as HTML', reloaded.scripts === 0);

    await p.screenshot({ path: join(SHOTS, 'desktop-grid-after-save.png') });
  }

  // A fresh context (no owner key) still sees the description and can edit it.
  {
    const q = await newPage({ width: 1280, height: 860 });
    await openCommunity(q, { expand: true });
    if (uploadedId) {
      const guest = await q.evaluate((id) => {
        const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
        const ta = tile?.querySelector('.dchat-community-desc');
        return {
          value: ta?.value,
          readonly: !!(ta && ta.readOnly),
          hasEdit: !!tile?.querySelector('.dchat-community-desc-edit:not([hidden])'),
          exists: !!tile
        };
      }, uploadedId);
      ok('[guest] description visible with an Edit affordance', guest.exists && guest.hasEdit && guest.value.includes('Line one') && guest.value.includes('<script>'), JSON.stringify(guest));
      const GUEST_DESC = 'Guest added this description.';
      const guestSaved = await q.evaluate(async (id, text) => {
        const tile = document.querySelector(`.dchat-community-scene[data-scene-id="${id}"]`);
        tile?.querySelector('.dchat-community-desc-edit')?.click();
        const ta = tile?.querySelector('.dchat-community-desc');
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        tile?.querySelector('.dchat-community-desc-save')?.click();
        const start = Date.now();
        while (Date.now() - start < 8000) {
          const save = tile?.querySelector('.dchat-community-desc-save');
          if (ta && ta.value === text && ta.readOnly && (!save || save.hidden)) {
            return { ok: true, value: ta.value, readonly: ta.readOnly };
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        return { ok: false, value: ta?.value, readonly: ta?.readOnly };
      }, uploadedId, GUEST_DESC);
      ok('[guest] can edit and persist a description', guestSaved.ok && guestSaved.value === GUEST_DESC, JSON.stringify(guestSaved));
      const recGuest = await fetch(`${BASE}/api/community-scenes/${uploadedId}`).then((r) => r.json());
      ok('[guest] description persisted on the server', recGuest.description === GUEST_DESC, JSON.stringify(recGuest.description ?? recGuest));
    }
    await q.browserContext().close();
  }

  ok('[upload page] no unexpected console errors', p._errs.length === 0, p._errs.slice(0, 5).join(' | '));
  await p.browserContext().close();
}

await browser.close();
if (child && child.pid) {
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
}

writeFileSync(join(SHOTS, 'results.txt'), results.join('\n') + `\n\n${n - fails}/${n} passed\n`);
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
