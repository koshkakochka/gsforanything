import puppeteer from 'puppeteer-core';
// Before / after screenshots: a fixed 50 m sky dome vs the fitted one.
// BASE=http://localhost:3611 SHOTS=/tmp/domefit-shots node shots.mjs
const BASE = process.env.BASE || 'http://localhost:3611';
const SHOTS = process.env.SHOTS || '/tmp/domefit-shots';
import fs from 'fs'; fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1280, height: 800 });
await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(3000);
await p.evaluate(() => {
  gsControls.setMode('off'); document.querySelector('#hide-ui-btn, [id*=hide-ui]')?.click();
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, '#1e3a8a'); gr.addColorStop(0.5, '#93c5fd'); gr.addColorStop(0.5, '#65a30d'); gr.addColorStop(1, '#365314'); g.fillStyle = gr; g.fillRect(0, 0, 512, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }));
  dome.name = 'skyDome'; dome.userData.gsHdriDome = false; scene.add(dome); window.__dome = dome;
  const cols = [0xef4444, 0xf59e0b, 0x22c55e, 0x3b82f6, 0xa855f7, 0xec4899];
  for (let i = 0; i < 6; i++) { const d = 25 + i * 30; const t = new THREE.Mesh(new THREE.BoxGeometry(6, 30, 6), new THREE.MeshStandardMaterial({ color: cols[i] })); t.name = 'tower' + i; t.position.set((i - 2.5) * 14, 15, -d); scene.add(t); }
  camera.position.set(0, 3, 10); camera.lookAt(0, 8, -80);
});
await sleep(800);
await p.screenshot({ path: `${SHOTS}/0a-before-fixed-50m-dome-cuts-off-towers.png` });
const info = await p.evaluate(() => { __dome.userData.gsHdriDome = true; const r = gsFitScene(); camera.position.set(0, 3, 10); camera.lookAt(0, 8, -80); return r; });
await sleep(800);
await p.screenshot({ path: `${SHOTS}/0b-after-dome-fitted-all-towers-visible.png` });
console.log(JSON.stringify(info));
await b.close();
