// Real-input pointer-lock check for First person (PointerLockControls).
// Headless Chrome does not route Esc to pointer lock, so this runs a headful
// Chrome on an X display (Xvfb) and drives it with real xdotool clicks/keys.
//   Xvfb :99 -screen 0 1280x900x24 &   then   BASE=https://localhost:3488 node esc-real.mjs
// Checks: clicking the scene locks, real Esc unlocks, the panels are clickable
// afterwards, clicking a panel does not re-lock, clicking the scene locks again.
import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'https://localhost:3488';
const DISPLAY = process.env.DISPLAY_NUM || ':99';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const X = (cmd) => execSync(`DISPLAY=${DISPLAY} xdotool ${cmd}`);
let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' ' + info : ''}`); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: false, defaultViewport: null, args: ['--ignore-certificate-errors', '--no-sandbox', '--window-size=1280,860', '--window-position=0,0', `--user-data-dir=/tmp/gs-esc-real-${process.pid}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], env: { ...process.env, DISPLAY } });
const p = (await b.pages())[0]; const errs = [];
p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(3000);
const scr = (sel) => p.evaluate(s => { const r = typeof s === 'string' ? document.querySelector(s).getBoundingClientRect() : { x: s[0], y: s[1], width: 0, height: 0 }; return [Math.round(window.screenX + r.x + r.width / 2), Math.round(window.screenY + (outerHeight - innerHeight) + r.y + r.height / 2)]; }, sel);
const click = async (sel) => { const [x, y] = await scr(sel); X(`mousemove ${x} ${y} click 1`); await sleep(500); };
const st = () => p.evaluate(() => ({ locked: document.pointerLockElement === renderer.domElement, tab: document.querySelector('.dchat-tab.active')?.dataset.tab, mode: gsControls.mode, status: document.getElementById('dchat-controls-status').textContent }));
const SPOT = [900, 450];
await click('.dchat-tab[data-tab="controls"]'); await click('[data-camera-mode="firstperson"]');
ok('First person selected', (await st()).mode === 'firstperson');
await click(SPOT); let s = await st(); ok('clicking the scene locks the pointer', s.locked, JSON.stringify(s));
X('key Escape'); await sleep(600); s = await st(); ok('real Esc releases pointer lock', !s.locked, JSON.stringify(s));
await click('.dchat-tab[data-tab="scenes"]'); s = await st(); ok('panels are clickable after Esc (Scenes tab opens)', s.tab === 'scenes' && !s.locked, JSON.stringify(s));
await click('#desktop-chat'); s = await st(); ok('clicking the panel does not re-lock', !s.locked, JSON.stringify(s));
await sleep(1500); await click(SPOT); s = await st(); ok('clicking the scene locks again', s.locked, JSON.stringify(s));
X('key Escape'); await sleep(600); s = await st(); ok('second Esc releases again', !s.locked, JSON.stringify(s));
await click('.dchat-tab[data-tab="chat"]'); s = await st(); ok('Chat tab clickable', s.tab === 'chat' && !s.locked, JSON.stringify(s));
ok('no console errors', errs.length === 0, JSON.stringify(errs));
console.log(`${pass}/${pass + fail} passed`);
await b.close(); process.exit(fail ? 1 : 0);
