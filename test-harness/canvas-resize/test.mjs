// Render canvas fills the visible page after resize, zoom, and DPR changes.
// BASE=https://localhost:3558 SHOT_DIR=/workspace/gs-canvas-resize-shots node test.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3558';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-canvas-resize-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
	ok ? pass++ : fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`);
};
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const b = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function openPage(viewport, { ua = true } = {}) {
	const p = await b.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
	if (ua) await p.setUserAgent(PHONE_UA);
	await p.setViewport(viewport);
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const u = new URL(req.url());
		if (u.pathname.startsWith('/api/')) {
			const body = u.pathname === '/api/backends'
				? '{"backends":{"claude":{"label":"Claude","provider":"claude","available":true}},"default":"claude"}'
				: (u.pathname === '/api/community-scenes' ? '{"scenes":[]}' : '{}');
			return req.respond({ status: 200, contentType: 'application/json', body });
		}
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.renderer && window.renderer.domElement);
	await sleep(400);
	p._errors = errors;
	return p;
}

async function waitFrames(p, n = 3) {
	await p.evaluate((n) => new Promise((resolve) => {
		let i = 0;
		const tick = () => { if (++i >= n) resolve(); else requestAnimationFrame(tick); };
		requestAnimationFrame(tick);
	}), n);
}

function measure() {
	const c = renderer.domElement;
	const r = c.getBoundingClientRect();
	const gl = renderer.getContext();
	const vv = window.visualViewport;
	const vw = Math.max(window.innerWidth, vv && vv.width > 0 ? vv.width : 0);
	const vh = Math.max(window.innerHeight, vv && vv.height > 0 ? vv.height : 0);
	const px = renderer.getPixelRatio();
	const coverW = Math.min(vw, document.documentElement.clientWidth || vw);
	const coverH = Math.min(vh, document.documentElement.clientHeight || vh);
	return {
		rect: { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom },
		client: { w: c.clientWidth, h: c.clientHeight },
		attr: { w: c.width, h: c.height },
		buf: { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight },
		px,
		dpr: window.devicePixelRatio,
		win: { iw: window.innerWidth, ih: window.innerHeight },
		vv: vv ? { w: vv.width, h: vv.height, scale: vv.scale } : null,
		covers: r.left <= 1 && r.top <= 1 && r.right >= vw - 1 && r.bottom >= vh - 1,
		coverTarget: { vw, vh, coverW, coverH },
		bufOk: Math.abs(gl.drawingBufferWidth - Math.round(c.clientWidth * px)) <= 1
			&& Math.abs(gl.drawingBufferHeight - Math.round(c.clientHeight * px)) <= 1
	};
}

function report(m) {
	return {
		rect: [Math.round(m.rect.w), Math.round(m.rect.h)],
		client: [m.client.w, m.client.h],
		buf: [m.buf.w, m.buf.h],
		px: m.px, dpr: m.dpr,
		win: [m.win.iw, m.win.ih],
		vv: m.vv
	};
}

const phone = (w, h, dpr = 2) => ({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: dpr });

{
	const p = await openPage(phone(390, 844, 2));
	await waitFrames(p);
	let m = await p.evaluate(measure);
	check('phone 390x844: canvas client rect covers the viewport', m.covers, report(m));
	check('phone 390x844: drawing buffer equals client size times pixel ratio', m.bufOk, report(m));
	await p.screenshot({ path: `${SHOT_DIR}/after-phone-390x844.png` });

	await p.setViewport(phone(844, 390, 2));
	await waitFrames(p, 4);
	m = await p.evaluate(measure);
	check('resize 844x390: canvas client rect covers the viewport', m.covers, report(m));
	check('resize 844x390: drawing buffer equals client size times pixel ratio', m.bufOk, report(m));
	await p.screenshot({ path: `${SHOT_DIR}/after-phone-844x390.png` });

	await p.setViewport(phone(320, 600, 2));
	await waitFrames(p, 4);
	m = await p.evaluate(measure);
	check('resize 320x600: canvas client rect covers the viewport', m.covers, report(m));
	check('resize 320x600: drawing buffer equals client size times pixel ratio', m.bufOk, report(m));
	await p.screenshot({ path: `${SHOT_DIR}/after-phone-320x600.png` });

	// Back to portrait, then a DPR / zoom-style scale change with no CSS size change.
	await p.setViewport(phone(390, 844, 3));
	await waitFrames(p, 6);
	// matchMedia(resolution) or setViewport should have updated the buffer.
	// If the media query did not fire, dispatch a resize so applyRendererSize runs.
	await p.evaluate(() => { window.dispatchEvent(new Event('resize')); });
	await waitFrames(p, 4);
	m = await p.evaluate(measure);
	check('deviceScaleFactor 3: canvas still covers the viewport', m.covers, report(m));
	check('deviceScaleFactor 3: pixel ratio updates and buffer matches client × ratio', m.bufOk && Math.abs(m.px - 3) < 0.01, report(m));
	await p.screenshot({ path: `${SHOT_DIR}/after-phone-390x844-dpr3.png` });

	// Hide UI: the canvas must still fill the page.
	await p.setViewport(phone(390, 844, 2));
	await waitFrames(p, 4);
	await p.evaluate(() => { document.getElementById('ui-toggle')?.click(); });
	await waitFrames(p, 3);
	m = await p.evaluate(measure);
	const hidden = await p.evaluate(() => document.getElementById('desktop-chat')?.classList.contains('hidden') || document.getElementById('desktop-chat')?.hidden);
	check('Hide UI: menu is hidden and canvas still covers the viewport', hidden && m.covers, { hidden, ...report(m) });
	check('Hide UI: drawing buffer equals client size times pixel ratio', m.bufOk, report(m));
	await p.screenshot({ path: `${SHOT_DIR}/after-phone-hide-ui.png` });

	check('no console/page errors on phone page', p._errors.length === 0, p._errors.slice(0, 3));
	await p.close();
}

{
	// visualViewport-only growth (iOS toolbar hide / pinch-zoom out) with no window.resize.
	const p = await openPage(phone(390, 844, 2));
	await waitFrames(p, 4);
	await p.evaluate(() => {
		const iw = 350, ih = 690;
		Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => iw });
		Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => ih });
		// Recreate the stale canvas Kross saw, then fire only a visualViewport event.
		renderer.setSize(350, 690, false);
		camera.aspect = 350 / 690;
		camera.updateProjectionMatrix();
		window.visualViewport.dispatchEvent(new Event('resize'));
	});
	await waitFrames(p, 4);
	const m = await p.evaluate(measure);
	check('visualViewport-only growth: canvas covers the visible viewport', m.covers && m.rect.w >= 389 && m.rect.h >= 843, report(m));
	check('visualViewport-only growth: drawing buffer equals client size times pixel ratio', m.bufOk, report(m));
	await p.screenshot({ path: `${SHOT_DIR}/after-phone-viewport-gap.png` });
	await p.close();
}

{
	const p = await openPage({ width: 1280, height: 800, deviceScaleFactor: 1 }, { ua: false });
	await waitFrames(p);
	let m = await p.evaluate(measure);
	check('desktop 1280x800: canvas covers the viewport', m.covers, report(m));
	check('desktop 1280x800: drawing buffer equals client size times pixel ratio', m.bufOk, report(m));
	await p.setViewport({ width: 700, height: 500, deviceScaleFactor: 1 });
	await waitFrames(p, 4);
	m = await p.evaluate(measure);
	check('desktop resize 700x500: canvas covers the viewport', m.covers, report(m));
	check('desktop resize 700x500: drawing buffer equals client size times pixel ratio', m.bufOk, report(m));
	check('no console/page errors on desktop page', p._errors.length === 0, p._errors.slice(0, 3));
	await p.close();
}

await b.close();
console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
