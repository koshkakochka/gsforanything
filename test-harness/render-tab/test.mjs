// Render tab: FOV validation, SBS screenshot aspect, non-empty recording blob.
// BASE=https://localhost:3540 SHOT_DIR=/workspace/gs-render-tab-shots node test.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3540';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-render-tab-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const b = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function openPage({ viewport, ua = null, xr = false }) {
	const p = await b.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
	if (ua) await p.setUserAgent(ua);
	await p.setViewport(viewport);
	if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const u = new URL(req.url());
		if (u.pathname.startsWith('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: u.pathname === '/api/community-scenes' ? '{"scenes":[]}' : (u.pathname === '/api/backends' ? '{"backends":{"claude":{"label":"Claude","provider":"claude","available":true}},"default":"claude"}' : '{}') });
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
	await p.waitForFunction(() => typeof window.gsSelectTab === 'function' && window.gsSbsRender);
	await sleep(400);
	return { p, errors };
}

{
	const { p, errors } = await openPage({ viewport: { width: 1280, height: 900 } });
	await p.evaluate(() => window.gsSelectTab('render'));
	await sleep(200);
	const ui = await p.evaluate(() => {
		const fov = document.getElementById('dchat-render-fov');
		return {
			panel: document.getElementById('dchat-panel-render')?.classList.contains('active'),
			tab: document.querySelector('.dchat-tab.active')?.dataset.tab,
			label: document.getElementById('gs-menu-current-tab')?.textContent.trim(),
			fov: fov?.value,
			shot: !!document.getElementById('dchat-render-screenshot'),
			rec: !!document.getElementById('dchat-render-record'),
			timer: document.getElementById('dchat-render-timer')?.textContent.trim(),
		};
	});
	check('Render tab is in the hamburger and opens', ui.panel && ui.tab === 'render' && /render/i.test(ui.label || ''), ui);
	check('FOV defaults to 180° with screenshot, record, and timer controls', ui.fov === '180' && ui.shot && ui.rec && ui.timer === '00:00', ui);

	const fovCases = await p.evaluate(() => {
		const api = window.gsSbsRender;
		return {
			empty: api.parseFov(''),
			blank: api.parseFov('   '),
			nan: api.parseFov('abc'),
			low: api.parseFov(29),
			high: api.parseFov(361),
			ok180: api.parseFov(180),
			ok30: api.parseFov(30),
			ok360: api.parseFov(360),
		};
	});
	check('FOV empty is rejected', !fovCases.empty.ok && fovCases.empty.error);
	check('FOV non-numeric is rejected', !fovCases.nan.ok && fovCases.nan.error);
	check('FOV below 30 is rejected', !fovCases.low.ok && /30/.test(fovCases.low.error || ''));
	check('FOV above 360 is rejected', !fovCases.high.ok && /360/.test(fovCases.high.error || ''));
	check('FOV 180 / 30 / 360 are accepted', fovCases.ok180.ok && fovCases.ok180.value === 180 && fovCases.ok30.ok && fovCases.ok360.ok, fovCases);

	await p.evaluate(() => { const f = document.getElementById('dchat-render-fov'); f.value = '10'; f.dispatchEvent(new Event('input', { bubbles: true })); });
	const inline = await p.evaluate(() => ({ text: document.getElementById('dchat-render-fov-error')?.textContent, hidden: document.getElementById('dchat-render-fov-error')?.hidden, invalid: document.getElementById('dchat-render-fov')?.getAttribute('aria-invalid') }));
	check('Invalid FOV shows an inline error', !inline.hidden && /30/.test(inline.text || '') && inline.invalid === 'true', inline);
	await p.evaluate(() => { const f = document.getElementById('dchat-render-fov'); f.value = '180'; f.dispatchEvent(new Event('input', { bubbles: true })); });

	await p.screenshot({ path: `${SHOT_DIR}/desktop-render-tab.png`, clip: await p.evaluate(() => { const r = document.getElementById('desktop-chat').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }) });

	// Smaller eye size in tests so headless swiftshader finishes quickly.
	const shot = await p.evaluate(async () => {
		const r = await window.gsSbsRender.takeScreenshot({ fov: 180, download: false, eyeSize: 256 });
		const b64 = await new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1]); fr.readAsDataURL(r.blob); });
		return { width: r.width, height: r.height, mime: r.mime, size: r.blob.size, fov: r.fov, b64, ext: r.ext };
	});
	check('Screenshot is SBS with a 2:1 aspect ratio', shot.width === shot.height * 2 && shot.width > 0 && shot.size > 1000, { w: shot.width, h: shot.height, size: shot.size, mime: shot.mime });
	if (shot.b64) fs.writeFileSync(`${SHOT_DIR}/sample-sbs-screenshot.${shot.ext || 'png'}`, Buffer.from(shot.b64, 'base64'));

	const rec = await p.evaluate(async () => {
		window.gsSbsRender.startRecording({ fov: 180, downloadOnStop: false });
		await new Promise((r) => setTimeout(r, 1800));
		const out = await window.gsSbsRender.stopRecording();
		const b64 = await new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1]); fr.readAsDataURL(out.blob); });
		return { size: out.blob.size, mime: out.mime, ext: out.ext, duration: out.duration, width: out.width, height: out.height, b64, filename: out.filename };
	});
	check('Recording produces a non-empty blob in headless Chrome', rec.size > 1000 && rec.width === rec.height * 2, { size: rec.size, mime: rec.mime, duration: rec.duration, w: rec.width, h: rec.height });
	if (rec.b64 && rec.size < 15_000_000) fs.writeFileSync(`${SHOT_DIR}/sample-sbs-recording.${rec.ext || 'webm'}`, Buffer.from(rec.b64, 'base64'));

	check('no console errors (desktop)', errors.length === 0, errors);
	await p.close();
}

{
	const { p, errors } = await openPage({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: PHONE_UA });
	await p.evaluate(() => window.gsSelectTab('render'));
	await sleep(250);
	const ui = await p.evaluate(() => {
		const shot = document.getElementById('dchat-render-screenshot').getBoundingClientRect();
		const rec = document.getElementById('dchat-render-record').getBoundingClientRect();
		const fov = document.getElementById('dchat-render-fov').getBoundingClientRect();
		return { panel: document.getElementById('dchat-panel-render')?.classList.contains('active'), shotH: Math.round(shot.height), recH: Math.round(rec.height), fovH: Math.round(fov.height) };
	});
	check('Phone: Render tab opens with ≥ 44px controls', ui.panel && ui.shotH >= 44 && ui.recH >= 44 && ui.fovH >= 44, ui);
	const r = await p.evaluate(() => { const r = document.getElementById('desktop-chat').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
	await p.screenshot({ path: `${SHOT_DIR}/phone-render-tab.png`, clip: r });
	check('no console errors (phone)', errors.length === 0, errors);
	await p.close();
}

{
	const { p, errors } = await openPage({ viewport: { width: 1400, height: 900 }, xr: true });
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); window.gsXrMode.set('vr'); });
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => window.renderer?.xr?.isPresenting)); i++) await sleep(250);
	const presenting = await p.evaluate(() => !!window.renderer?.xr?.isPresenting);
	check('[VR] in an IWER Quest 3 VR session', presenting);
	if (presenting) {
		await sleep(800);
		await p.evaluate(() => window.gsSelectTab('render'));
		await sleep(400);
		const st = await p.evaluate(() => ({
			tab: document.querySelector('.dchat-tab.active')?.dataset.tab,
			panel: document.getElementById('dchat-panel-render')?.classList.contains('active'),
			presenting: renderer.xr.isPresenting,
		}));
		check('[VR] Render tab opens without ending the XR session', st.tab === 'render' && st.panel && st.presenting, st);
		const shot = await p.evaluate(async () => {
			const still = renderer.xr.isPresenting;
			const r = await window.gsSbsRender.takeScreenshot({ fov: 180, download: false, eyeSize: 128 });
			return { stillAfter: renderer.xr.isPresenting, width: r.width, height: r.height, size: r.blob.size, stillBefore: still };
		});
		check('[VR] SBS screenshot works and the XR session stays up', shot.stillBefore && shot.stillAfter && shot.width === shot.height * 2 && shot.size > 200, shot);
		await p.evaluate(() => window.__gsVrWindows.byName('menu').tick(true));
		const png = await p.evaluate(() => {
			const src = window.__gsVrWindows.byName('menu').mesh.material.map.image;
			const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
			c.getContext('2d').drawImage(src, 0, 0); return c.toDataURL('image/png');
		});
		fs.writeFileSync(`${SHOT_DIR}/vr-render-tab.png`, Buffer.from(png.split(',')[1], 'base64'));
	}
	check('[VR] no console errors', errors.length === 0, errors);
	await p.close();
}

await b.close();
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
