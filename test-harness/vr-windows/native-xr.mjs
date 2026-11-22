// Immersive XR must not reparent the menu into a native HTML-in-Canvas host.
// Quest / browsers that expose drawElementImage can fail to lay out canvas
// descendants, which breaks ray hit-testing. Run with CanvasDrawElement on:
//   BASE=https://localhost:3723 node native-xr.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const BASE = process.env.BASE || 'https://localhost:3723';
const SHOT = process.env.SHOT || '/workspace/gs-xr-buttons.png';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
	ok ? pass++ : fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

const b = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: [
		'--ignore-certificate-errors', '--no-sandbox',
		'--use-angle=swiftshader', '--enable-unsafe-swiftshader',
		'--enable-blink-features=CanvasDrawElement'
	]
});
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await p.setViewport({ width: 1280, height: 800 });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p.setRequestInterception(true);
p.on('request', (req) => {
	const u = new URL(req.url());
	if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
	if (u.pathname.startsWith('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '{}' });
	req.continue();
});
await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 45000 });
await sleep(1200);

const hasApi = await p.evaluate(() => typeof document.createElement('canvas').getContext('2d').drawElementImage === 'function');
check('Chrome exposes drawElementImage (CanvasDrawElement flag)', hasApi);

await p.evaluate(() => { window.__xrDevice.position.set(0, 1.6, 0); window.__xrDevice.quaternion.set(0, 0, 0, 1); });
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => window.renderer?.xr?.isPresenting)); i++) await sleep(250);
check('Entered immersive VR (IWER Quest 3)', await p.evaluate(() => !!renderer?.xr?.isPresenting));
await sleep(1200);

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
		aimAt(hand, el, winName) { this.aim(hand, this.pointFor(el, winName)); },
		trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); }
	};
});
const frame = (ms = 400) => sleep(ms);
const click = async (hand = 'right') => {
	await p.evaluate((h) => __t.trigger(h, 1), hand); await frame(300);
	await p.evaluate((h) => __t.trigger(h, 0), hand); await frame(400);
};

const state = await p.evaluate(async () => {
	const mod = await import('./htmlInCanvas.js');
	const menu = window.__gsVrWindows.byName('menu');
	menu.tick(true);
	const r = menu.source.getBoundingClientRect();
	const parent = menu.source.parentElement;
	return {
		renderer: mod.htmlInCanvasRenderer(),
		supports: mod.supportsNativeHtmlInCanvas(),
		parentTag: parent && parent.tagName,
		parentClass: parent && String(parent.className || ''),
		insideHost: !!(parent && parent.classList && parent.classList.contains('gs-html-in-canvas-host')),
		sourceClass: menu.source.className,
		rect: { w: r.width, h: r.height, x: r.x, y: r.y },
		paints: menu.paints,
		exit: !!document.getElementById('gs-exit-vr-btn')
	};
});
check('Native API is present in this session', state.supports);
check('XR menu source is not reparented into the HTML-in-Canvas host', !state.insideHost && state.parentTag !== 'CANVAS', state);
check('XR menu uses the walker painter', state.renderer === 'walker', state.renderer);
check('Menu source has a usable layout box for hit-testing', state.rect.w >= 100 && state.rect.h >= 100, state.rect);

// Open the section list and ray-click the Controls tab
await p.evaluate(() => {
	if (!document.getElementById('desktop-chat').classList.contains('gs-tab-menu-open')) {
		document.getElementById('gs-menu-hamburger')?.click();
	}
});
await frame(300);
await p.evaluate(() => __t.aimAt('right', document.querySelector('.dchat-tab[data-tab="controls"]'), 'menu'));
await frame(500);
check('Ray hover highlights the Controls tab', await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="controls"]')?.classList.contains('gs-ray-hover')));
await click();
check('Ray click switches to the Controls tab', await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="controls"]')?.classList.contains('active')));

// Dock: Exit VR
await p.evaluate(() => __t.aimAt('right', document.getElementById('gs-exit-vr-btn'), 'menu'));
await frame(400);
await click();
check('Ray click on #gs-exit-vr-btn ends the VR session', await p.evaluate(() => !renderer.xr.isPresenting));

check('No page errors', errors.length === 0, errors);

// One screenshot: re-enter, open the section list, capture the menu texture
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer?.xr?.isPresenting)); i++) await sleep(250);
await sleep(800);
await p.evaluate(() => {
	if (!document.getElementById('desktop-chat').classList.contains('gs-tab-menu-open')) {
		document.getElementById('gs-menu-hamburger')?.click();
	}
	window.__gsVrWindows.byName('menu').tick(true);
});
await sleep(200);
const b64 = await p.evaluate(() => window.__gsVrWindows.byName('menu').canvas.toDataURL('image/png'));
fs.writeFileSync(SHOT, Buffer.from(b64.split(',')[1], 'base64'));
console.log('screenshot', SHOT);

await b.close();
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
