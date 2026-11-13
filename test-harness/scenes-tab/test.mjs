// Scenes tab has only Import / Clear; Share & Export is its own menu tab with a .vrscene.json download.
// BASE=https://localhost:3588 SHOT_DIR=/workspace/gs-scenes-tab-shots node test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3588';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-scenes-tab-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
	ok ? pass++ : fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`);
};
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const EXPECTED = [
	{ action: 'scenes:importFile', label: 'Import .vrscene.json' },
	{ action: 'scenes:clear', label: 'Clear All From Scene' }
];
const FIXTURE = {
	version: 1,
	name: 'Roundtrip Cubes',
	createdAt: '2026-11-13T00:00:00.000Z',
	codeBlocks: [
		"const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: 0xff3366 })); m.name='rtCube'; scene.add(m);"
	]
};

const b = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function openPage(viewport, { ua = false } = {}) {
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
	await p.waitForFunction(() => window.gsSelectTab && window.gsChatPanel);
	await sleep(400);
	p._errors = errors;
	return p;
}

async function selectTab(p, name) {
	await p.evaluate((t) => window.gsSelectTab(t), name);
	await sleep(300);
}

function measureButtons() {
	const root = document.getElementById('dchat-scenes-buttons');
	const tab = document.getElementById('dchat-scenes') || document.getElementById('dchat-panel-scenes');
	const header = document.getElementById('desktop-chat-header');
	const btns = [...(root?.querySelectorAll('[data-action]') || [])].map((el) => {
		const r = el.getBoundingClientRect();
		const s = getComputedStyle(el);
		const tr = tab ? tab.getBoundingClientRect() : null;
		return {
			action: el.getAttribute('data-action'),
			label: (el.textContent || '').replace(/\s+/g, ' ').trim(),
			tag: el.tagName,
			w: Math.round(r.width),
			h: Math.round(r.height),
			t: Math.round(r.top),
			l: Math.round(r.left),
			r: Math.round(r.right),
			b: Math.round(r.bottom),
			wrap: s.whiteSpace,
			overflowsTab: !!(tr && (r.left < tr.left - 1 || r.right > tr.right + 1 || r.top < tr.top - 1))
		};
	});
	const headerBox = header ? header.getBoundingClientRect() : null;
	const headerKids = header ? [...header.children].filter((e) => {
		const r = e.getBoundingClientRect();
		const s = getComputedStyle(e);
		return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
	}) : [];
	const tops = headerKids.map((e) => Math.round(e.getBoundingClientRect().top));
	const sameTop = tops.length <= 1 || Math.max(...tops) - Math.min(...tops) <= 8;
	const headerH = headerBox ? Math.round(headerBox.height) : 0;
	return {
		btns,
		actions: btns.map((b) => b.action),
		labels: btns.map((b) => b.label),
		header: headerBox ? { h: headerH, w: Math.round(headerBox.width), oneRow: sameTop && headerH <= 64 } : null,
		anyOverflow: btns.some((b) => b.overflowsTab)
	};
}

async function assertScenesButtons(p, label, { minHeight = 0 } = {}) {
	const m = await p.evaluate(measureButtons);
	check(`${label}: exactly two Scenes buttons`, m.btns.length === 2 && m.actions.length === 2, m);
	check(`${label}: only Import and Clear actions`,
		m.actions.join(',') === EXPECTED.map((e) => e.action).join(',')
		&& !m.actions.includes('scenes:export') && !m.actions.includes('scenes:loadSaved')
		&& !m.actions.includes('scenes:openShareTab'), m.actions);
	check(`${label}: button labels are exact`, m.labels.join(' | ') === EXPECTED.map((e) => e.label).join(' | '), m.labels);
	check(`${label}: buttons stay inside the Scenes tab`, !m.anyOverflow, m.btns);
	if (minHeight) {
		check(`${label}: each button is at least ${minHeight}px tall`, m.btns.every((b) => b.h >= minHeight - 0.5), m.btns);
	}
	if (m.header) {
		check(`${label}: header stays on one row (no overflow)`, m.header.oneRow, m.header);
	}
	return m;
}

async function importFixture(p, data, filename) {
	const tmp = path.join(os.tmpdir(), filename);
	fs.writeFileSync(tmp, JSON.stringify(data));
	const input = await p.$('#scene-file-input');
	await input.uploadFile(tmp);
	await sleep(1200);
	return tmp;
}

async function captureDownload(p, clickFn) {
	return p.evaluate(async (clickSrc) => {
		const captured = [];
		const origCreate = document.createElement.bind(document);
		document.createElement = function (tag, ...rest) {
			const el = origCreate(tag, ...rest);
			if (String(tag).toLowerCase() === 'a') {
				const click = el.click.bind(el);
				el.click = function () {
					captured.push({ href: el.href, download: el.download });
					return click();
				};
			}
			return el;
		};
		try {
			await (new Function('return (' + clickSrc + ')')())();
			await new Promise((r) => setTimeout(r, 800));
		} finally {
			document.createElement = origCreate;
		}
		if (!captured.length) return { filename: '', json: null };
		const last = captured.at(-1);
		let json = null;
		try {
			const res = await fetch(last.href);
			json = JSON.parse(await res.text());
		} catch { /* ignore */ }
		return { filename: last.download, json };
	}, clickFn.toString());
}

function hasObj(p, name) {
	return p.evaluate((n) => {
		let found = false;
		(window.scene || { traverse() {} }).traverse((o) => { if (o.name === n) found = true; });
		return found;
	}, name);
}

const phone = (w, h, dpr = 2) => ({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: dpr });

// ---------- Desktop ----------
{
	const p = await openPage({ width: 1280, height: 800 });
	await selectTab(p, 'scenes');
	await assertScenesButtons(p, 'desktop Scenes tab');
	await p.screenshot({ path: `${SHOT_DIR}/desktop-scenes-tab.png` });

	const menu = await p.evaluate(() => {
		const btn = document.querySelector('.dchat-tab[data-tab="share"]');
		const clone = btn?.cloneNode(true);
		clone?.querySelectorAll('.dchat-tab-short').forEach((el) => el.remove());
		return {
			exists: !!btn,
			label: (clone?.textContent || '').replace(/\s+/g, ' ').trim()
		};
	});
	check('desktop: hamburger menu has a Share & Export tab', menu.exists && /Share & Export/.test(menu.label), menu);

	await selectTab(p, 'share');
	const share = await p.evaluate(() => {
		const panel = document.getElementById('dchat-panel-share');
		const btn = document.querySelector('#dchat-share [data-share="vrscene"]');
		const link = document.querySelector('#dchat-share [data-share="link"]');
		const embed = document.querySelector('#dchat-share [data-share="embed"]');
		const formats = [...document.querySelectorAll('#dchat-share [data-share-format]')].map((b) => b.dataset.shareFormat);
		const s = btn ? getComputedStyle(btn) : null;
		const header = (document.getElementById('gs-menu-current-tab')?.textContent || '').replace(/\s+/g, ' ').trim();
		return {
			shareActive: document.querySelector('.dchat-tab[data-tab="share"]')?.classList.contains('active') || false,
			panelShown: !!(panel && getComputedStyle(panel).display !== 'none'),
			header,
			btnText: (btn?.textContent || '').replace(/\s+/g, ' ').trim(),
			btnVisible: !!(btn && s && s.display !== 'none' && s.visibility !== 'hidden' && btn.getBoundingClientRect().height > 0),
			hasLink: !!(link && link.getBoundingClientRect().height > 0),
			hasEmbed: !!(embed && embed.getBoundingClientRect().height > 0),
			formats
		};
	});
	check('desktop: Share & Export tab is its own menu tab', share.shareActive && share.panelShown && /Share & Export/.test(share.header), share);
	check('desktop: Share & Export tab has share link, Save to Device / Download .vrscene.json, embed and 3D formats',
		share.btnText === 'Download .vrscene.json' && share.btnVisible && share.hasLink && share.hasEmbed
		&& ['glb', 'gltf', 'fbx', 'obj', 'blender'].every((id) => share.formats.includes(id)), share);
	const headerRow = await p.evaluate(() => {
		const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, h: r.height, r: r.right, l: r.left }; };
		const header = box('#desktop-chat-header'), burger = box('#gs-menu-hamburger'), title = box('#gs-menu-current-tab'), expand = box('#desktop-chat-expand'), mini = box('#desktop-chat-minimize');
		const buttons = [burger, expand, mini].filter(Boolean);
		const band = Math.max(...buttons.map((x) => x.b)) - Math.min(...buttons.map((x) => x.t));
		const tallest = Math.max(...buttons.map((x) => x.h));
		return {
			label: (document.getElementById('gs-menu-current-tab')?.textContent || '').trim(),
			oneRow: buttons.length >= 2 && band <= tallest + 4,
			titleOverflow: !!(title && header && (title.r > header.r + 1 || title.l < header.l - 1)),
			titleOverButtons: !!(title && expand && title.r > expand.l + 1),
			band, tallest, header, burger, title, expand, mini
		};
	});
	check('desktop: Share & Export header stays one row (hamburger, expand, minimize)', headerRow.oneRow && !headerRow.titleOverflow && !headerRow.titleOverButtons, headerRow);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-share-export-tab.png` });
	check('desktop: no page errors', p._errors.length === 0, p._errors.slice(0, 3).join(' | '));
	await p.close();
}

// ---------- Phone 390x844 ----------
{
	const p = await openPage(phone(390, 844, 2), { ua: true });
	await selectTab(p, 'scenes');
	const m = await assertScenesButtons(p, 'phone 390x844 Scenes tab', { minHeight: 44 });
	check('phone 390x844: long labels wrap or fit without overflowing the tab', !m.anyOverflow && m.btns.every((b) => b.w > 40), m.btns);
	await p.screenshot({ path: `${SHOT_DIR}/phone-390x844-scenes-tab.png` });

	await selectTab(p, 'share');
	const share = await p.evaluate(() => {
		const btn = document.querySelector('#dchat-share [data-share="vrscene"]');
		const tab = document.getElementById('dchat-panel-share') || document.getElementById('dchat-share');
		const headerEl = document.getElementById('gs-menu-current-tab');
		const headerBox = headerEl?.getBoundingClientRect();
		const chatHeader = document.getElementById('desktop-chat-header')?.getBoundingClientRect();
		const br = btn?.getBoundingClientRect();
		const tr = tab?.getBoundingClientRect();
		return {
			header: (headerEl?.textContent || '').replace(/\s+/g, ' ').trim(),
			headerOneRow: !!(chatHeader && headerBox && headerBox.right <= chatHeader.right + 1 && chatHeader.height <= 64),
			btnText: (btn?.textContent || '').replace(/\s+/g, ' ').trim(),
			visible: !!(br && br.height > 0),
			overflows: !!(br && tr && (br.left < tr.left - 1 || br.right > tr.right + 1)),
			h: br ? Math.round(br.height) : 0
		};
	});
	check('phone 390x844: Share & Export header title fits on one row', /Share & Export/.test(share.header) && share.headerOneRow, share);
	check('phone 390x844: Share & Export tab shows Download .vrscene.json and it fits', share.btnText === 'Download .vrscene.json' && share.visible && !share.overflows && share.h >= 44 - 0.5, share);
	await p.screenshot({ path: `${SHOT_DIR}/phone-390x844-share-export-tab.png` });
	check('phone 390x844: no page errors', p._errors.length === 0, p._errors.slice(0, 3).join(' | '));
	await p.close();
}

// ---------- Round-trip: import -> download .vrscene.json -> clear -> import restores ----------
{
	const p = await openPage({ width: 1280, height: 800 });
	await selectTab(p, 'scenes');
	await importFixture(p, FIXTURE, 'roundtrip-cubes.vrscene.json');
	check('import .vrscene.json places the fixture object', await hasObj(p, 'rtCube'));
	const card = await p.evaluate(() => document.getElementById('dchat-current-scene')?.innerText || '');
	check('import shows the fixture scene name', /Roundtrip Cubes/.test(card), card);

	await selectTab(p, 'share');
	const dl = await captureDownload(p, () => document.querySelector('#dchat-share [data-share="vrscene"]').click());
	check('download filename ends with .vrscene.json', /\.vrscene\.json$/.test(dl.filename || '') && /Roundtrip_Cubes|Roundtrip Cubes/.test(dl.filename || ''), dl.filename);
	check('download is the same JSON format Import accepts',
		!!dl.json && dl.json.version === 1 && Array.isArray(dl.json.codeBlocks) && dl.json.codeBlocks.length >= 1
		&& /rtCube/.test(JSON.stringify(dl.json.codeBlocks)) && dl.json.name === 'Roundtrip Cubes',
		{ name: dl.json?.name, blocks: dl.json?.codeBlocks?.length, filename: dl.filename });

	await selectTab(p, 'scenes');
	await p.evaluate(() => document.querySelector('#dchat-scenes-buttons [data-action="scenes:clear"]').click());
	await sleep(300);
	await p.evaluate(() => document.querySelector('#gs-dialog [data-gs-dialog=ok]')?.click());
	await sleep(700);
	check('Clear All From Scene removes the imported object', !(await hasObj(p, 'rtCube')));

	const restoredName = dl.filename || 'restored.vrscene.json';
	await importFixture(p, dl.json, restoredName);
	check('re-import of the downloaded file restores the object', await hasObj(p, 'rtCube'));
	const card2 = await p.evaluate(() => document.getElementById('dchat-current-scene')?.innerText || '');
	check('re-import restores the scene name', /Roundtrip Cubes/.test(card2), card2);
	check('round-trip: no page errors', p._errors.length === 0, p._errors.slice(0, 3).join(' | '));
	await p.close();
}

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
