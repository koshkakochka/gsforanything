// Environment tab Background Color: Select Color bar, no HSL sliders.
// BASE=https://localhost:3588 SHOT_DIR=/workspace/gs-bg-color-shots node test.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3588';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-bg-color-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
	ok ? pass++ : fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`);
};
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

const b = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function openPage(viewport, { mobile = false } = {}) {
	const p = await b.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
	if (mobile) await p.setUserAgent(PHONE_UA);
	await p.setViewport(viewport);
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const u = new URL(req.url());
		if (u.pathname.startsWith('/api/')) {
			if (u.pathname === '/api/chat') {
				return req.respond({ status: 200, contentType: 'application/json', body: '{"content":[{"type":"text","text":"ok"}]}' });
			}
			const body = u.pathname === '/api/backends'
				? '{"backends":{"claude":{"label":"Claude","provider":"claude","available":true}},"default":"claude"}'
				: (u.pathname === '/api/community-scenes' ? '{"scenes":[]}' : '{}');
			return req.respond({ status: 200, contentType: 'application/json', body });
		}
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.renderer && document.getElementById('gs-menu-hamburger'));
	await sleep(600);
	p._errors = errors;
	return p;
}

async function openEnv(p) {
	await p.evaluate(() => {
		const chat = document.getElementById('desktop-chat');
		if (!chat?.classList.contains('gs-tab-menu-open')) document.getElementById('gs-menu-hamburger')?.click();
	});
	await sleep(200);
	await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="env"]')?.click());
	await sleep(350);
	await p.evaluate(() => document.getElementById('dchat-env-controls')?.scrollIntoView({ block: 'center' }));
	await sleep(150);
}

function inspectControls() {
	const ids = ['dchat-color-picker', 'dchat-color-preview', 'dchat-color-preview-text', 'dchat-hue', 'dchat-saturation', 'dchat-brightness'];
	const out = { missing: {}, present: {}, text: (document.getElementById('dchat-env-controls')?.innerText || '') };
	for (const id of ids) {
		const e = document.getElementById(id);
		if (!e) { out.missing[id] = true; continue; }
		const r = e.getBoundingClientRect();
		const s = getComputedStyle(e);
		out.present[id] = {
			tag: e.tagName, type: e.type || '', htmlFor: e.htmlFor || '',
			text: (e.innerText || e.textContent || '').trim(),
			bg: s.backgroundColor, color: s.color, display: s.display,
			opacity: Number(s.opacity), visibility: s.visibility,
			w: r.width, h: r.height, left: r.left, top: r.top, right: r.right
		};
	}
	const preview = document.getElementById('dchat-color-preview');
	const input = document.getElementById('dchat-color-picker');
	if (preview && input) {
		const pr = preview.getBoundingClientRect();
		const ir = input.getBoundingClientRect();
		const cx = pr.left + pr.width / 2, cy = pr.top + pr.height / 2;
		const hit = document.elementFromPoint(cx, cy);
		out.hit = hit ? { id: hit.id, tag: hit.tagName, type: hit.type || '' } : null;
		// The input fills the label's content box; a 1px border makes it a few
		// pixels smaller than the label's border box.
		out.inputCoversBar = ir.width >= pr.width - 6 && ir.height >= pr.height - 6
			&& ir.width >= 200 && ir.height >= 40
			&& Math.abs(ir.left - pr.left) < 4 && Math.abs(ir.top - pr.top) < 4;
		out.squareOnLeft = ir.width <= 48 && ir.height <= 48 && (pr.left - ir.right) > 4;
		out.previewLabel = preview.tagName === 'LABEL' && preview.htmlFor === 'dchat-color-picker';
	}
	out.sceneBg = window.scene?.background?.getHexString?.() || null;
	out.pickerValue = input?.value || null;
	return out;
}

async function runSuite(label, viewport, opts) {
	const p = await openPage(viewport, opts);
	await openEnv(p);
	let info = await p.evaluate(inspectControls);

	check(`${label} hue slider is gone`, !info.present['dchat-hue'] && !!info.missing['dchat-hue']);
	check(`${label} saturation slider is gone`, !info.present['dchat-saturation'] && !!info.missing['dchat-saturation']);
	check(`${label} brightness slider is gone`, !info.present['dchat-brightness'] && !!info.missing['dchat-brightness']);
	check(`${label} section text has no Hue/Saturation/Brightness labels`,
		!/\bHUE\b/.test(info.text) && !/\bSATURATION\b/.test(info.text) && !/\bBRIGHTNESS\b/.test(info.text),
		info.text);
	check(`${label} Select Color text is on the bar`,
		info.present['dchat-color-preview-text']?.text === 'Select Color'
			&& /\bSelect Color\b/.test(info.present['dchat-color-preview']?.text || ''),
		info.present['dchat-color-preview']);
	const preview = info.present['dchat-color-preview'];
	check(`${label} bar is a wide rectangle (no left-hand square)`,
		preview && preview.w >= 200 && preview.h >= 44 && preview.h <= 56 && !info.squareOnLeft,
		{ preview, squareOnLeft: info.squareOnLeft, input: info.present['dchat-color-picker'] });
	check(`${label} color input overlays the bar (not a visible left square)`,
		info.inputCoversBar && info.present['dchat-color-picker']?.opacity === 0,
		{ inputCoversBar: info.inputCoversBar, input: info.present['dchat-color-picker'] });
	check(`${label} preview is a label for the color input`, info.previewLabel);
	check(`${label} a click in the middle of the bar hits the color input`,
		info.hit && (info.hit.id === 'dchat-color-picker' || (info.hit.id === 'dchat-color-preview' && info.previewLabel)),
		info.hit);
	check(`${label} bar background matches the active scene color`,
		info.sceneBg && info.pickerValue && info.pickerValue.toLowerCase() === `#${info.sceneBg}`.toLowerCase(),
		{ sceneBg: info.sceneBg, picker: info.pickerValue, bg: preview?.bg });

	// Pick a bright color (white text should flip to dark) and a dark one.
	const samples = [
		{ hex: '#ffdd00', expectDarkText: true },
		{ hex: '#1a237e', expectDarkText: false }
	];
	for (const s of samples) {
		await p.evaluate((hex) => {
			const input = document.getElementById('dchat-color-picker');
			input.value = hex;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}, s.hex);
		await sleep(250);
		info = await p.evaluate(inspectControls);
		const color = info.present['dchat-color-preview']?.color || '';
		const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
		const isDark = rgb ? (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3 < 80 : false;
		const isLight = rgb ? (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3 > 200 : false;
		check(`${label} picking ${s.hex} updates the bar and the scene`,
			info.pickerValue?.toLowerCase() === s.hex && info.sceneBg?.toLowerCase() === s.hex.slice(1),
			{ picker: info.pickerValue, sceneBg: info.sceneBg });
		check(`${label} "${s.hex}" label text stays legible`,
			s.expectDarkText ? isDark : isLight,
			{ color, expectDarkText: s.expectDarkText });
	}

	// Click the bar the way vrWindows.js forwards a ray: find the element at
	// the point, then dispatch a click on the actionable input/label.
	const vrClick = await p.evaluate(() => {
		const preview = document.getElementById('dchat-color-preview');
		const r = preview.getBoundingClientRect();
		const x = r.left + r.width / 2, y = r.top + r.height / 2;
		const el = document.elementFromPoint(x, y);
		const label = el?.closest('label');
		let field = el?.closest('input, textarea, select');
		if (!field && label) field = label.control || label.querySelector('input, textarea, select');
		let opened = false;
		if (field && field.type === 'color' && typeof field.showPicker === 'function') {
			const orig = field.showPicker.bind(field);
			field.showPicker = () => { opened = true; };
			try { field.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); } catch { /* ignore */ }
			try { field.showPicker(); } catch { /* ignore */ }
			field.showPicker = orig;
		} else if (field) {
			field.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
		}
		return {
			hitId: el?.id || el?.tagName || null,
			fieldType: field?.type || null,
			fieldId: field?.id || null,
			opened
		};
	});
	check(`${label} VR-menu-style click targets the color input`,
		vrClick.fieldId === 'dchat-color-picker' && vrClick.fieldType === 'color',
		vrClick);

	await p.evaluate(() => document.getElementById('dchat-env-controls')?.scrollIntoView({ block: 'center' }));
	await sleep(150);
	const slug = label.replace(/\s+/g, '-');
	await p.screenshot({ path: `${SHOT_DIR}/test-${slug}.png` });
	const section = await p.$('#dchat-env-controls');
	if (section) await section.screenshot({ path: `${SHOT_DIR}/test-${slug}-section.png` });
	check(`${label} no page errors`, p._errors.length === 0, p._errors.slice(0, 5));
	await p.close();
}

await runSuite('desktop', { width: 1280, height: 800, deviceScaleFactor: 2 });
await runSuite('mobile 390x844', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { mobile: true });
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
