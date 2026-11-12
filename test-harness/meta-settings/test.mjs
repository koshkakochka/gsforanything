// Meta Settings tab + hamburger menu (desktop, phone, IWER Quest 3).
// BASE=https://localhost:3540 SHOT_DIR=/workspace/gs-meta-settings-shots node test.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3540';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-meta-settings-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ALL_TABS = ['chat', 'env', 'scenes', 'files', 'code', 'community', 'controls', 'deps', 'share', 'technical', 'meta'];

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
		if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
		if (u.pathname.startsWith('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: u.pathname === '/api/community-scenes' ? '{"scenes":[]}' : '{}' });
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
	await p.waitForFunction(() => typeof window.gsSelectTab === 'function');
	await sleep(400);
	return { p, errors };
}

const menuState = (p) => p.evaluate(() => {
	const R = (s) => { const e = document.querySelector(s); if (!e) return null; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0, l: +r.left.toFixed(1), t: +r.top.toFixed(1), w: Math.round(r.width), h: Math.round(r.height) }; };
	const tabs = [...document.querySelectorAll('#desktop-chat-tabs .dchat-tab')].map((t) => { const r = t.getBoundingClientRect(); return { tab: t.dataset.tab, h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top) }; });
	return {
		open: document.getElementById('desktop-chat').classList.contains('gs-tab-menu-open'),
		active: document.querySelector('.dchat-tab.active')?.dataset.tab,
		label: document.getElementById('gs-menu-current-tab')?.textContent.trim(),
		aria: document.getElementById('gs-menu-hamburger')?.getAttribute('aria-expanded'),
		burger: R('#gs-menu-hamburger'),
		current: R('#gs-menu-current-tab'),
		list: R('#desktop-chat-tabs'),
		ids: tabs.map((t) => t.tab),
		tabs,
		panelMeta: document.getElementById('dchat-panel-meta')?.classList.contains('active'),
		ver: R('#gs-version-btn'),
		cardboard: R('#cardboard-btn'),
		cardHidden: document.getElementById('cardboard-btn')?.hidden,
		verParent: document.getElementById('gs-version-btn')?.closest('#dchat-meta-actions, #dchat-panel-meta') ? 'meta' : (document.getElementById('gs-version-btn')?.closest('#gs-dock') ? 'dock' : 'other'),
		cardParent: document.getElementById('cardboard-btn')?.closest('#dchat-meta-actions, #dchat-panel-meta') ? 'meta' : (document.getElementById('cardboard-btn')?.closest('#gs-dock') ? 'dock' : 'other')
	};
});

async function shot(p, name, clipChat = false) {
	const path = `${SHOT_DIR}/${name}.png`;
	if (clipChat) {
		const r = await p.evaluate(() => {
			const r = document.getElementById('desktop-chat').getBoundingClientRect();
			const x = Math.max(0, r.left), y = Math.max(0, r.top);
			return { x, y, width: Math.max(0, Math.min(r.width, innerWidth - x)), height: Math.max(0, Math.min(r.height, innerHeight - y)) };
		});
		if (r.width >= 2 && r.height >= 2) await p.screenshot({ path, clip: r });
		else await p.screenshot({ path });
	} else {
		await p.screenshot({ path });
	}
}

async function run2d({ name, viewport, ua, xr }) {
	const T = name;
	const { p, errors } = await openPage({ viewport, ua, xr });
	let s = await menuState(p);
	check(`${T}: hamburger + current tab visible, list closed`, s.burger.shown && s.current.shown && /chat/i.test(s.label) && !s.open && !s.list?.shown && s.aria === 'false', s);
	check(`${T}: version and Cardboard live in Meta Settings, not the dock`, s.verParent === 'meta' && s.cardParent === 'meta', s);
	if (viewport.hasTouch) check(`${T}: hamburger is a ≥ 44px touch target`, s.burger.w >= 44 && s.burger.h >= 44, s.burger);
	await shot(p, `${name}-hamburger-closed`, true);

	await p.click('#gs-menu-hamburger');
	await sleep(200);
	s = await menuState(p);
	const allIds = ALL_TABS.every((t) => s.ids.includes(t));
	const stacked = s.tabs.length >= 2 && s.tabs[1].top > s.tabs[0].top + 20;
	const tall = !viewport.hasTouch || s.tabs.every((t) => t.h >= 44 && t.w >= 44);
	check(`${T}: hamburger opens a vertical list of every tab (incl. Meta Settings)`, s.open && s.list.shown && s.aria === 'true' && allIds && stacked && tall && s.ids.includes('meta'), { ids: s.ids, stacked, tall, tabs: s.tabs });
	await shot(p, `${name}-hamburger-open`, true);

	await p.keyboard.press('Escape');
	await sleep(150);
	s = await menuState(p);
	check(`${T}: Esc closes the hamburger`, !s.open && !s.list?.shown, { open: s.open });

	await p.click('#gs-menu-current-tab');
	await sleep(150);
	s = await menuState(p);
	check(`${T}: clicking the current tab name reopens the list`, s.open, { open: s.open });
	await p.mouse.click(5, 5);
	await sleep(150);
	s = await menuState(p);
	check(`${T}: clicking outside closes the list`, !s.open, { open: s.open });

	for (const tab of ALL_TABS) {
		await p.evaluate((t) => window.gsSelectTab(t), tab);
		await sleep(120);
		s = await menuState(p);
		const panel = await p.evaluate((t) => document.getElementById(`dchat-panel-${t}`)?.classList.contains('active'), tab);
		check(`${T}: tab ${tab} is reachable, selected, labeled, menu closed`, s.active === tab && panel && !s.open && s.label && new RegExp(tab === 'deps' ? 'dependenc' : tab === 'env' ? 'environment|env' : tab, 'i').test(s.label), { active: s.active, label: s.label, open: s.open, panel });
	}

	s = await menuState(p);
	check(`${T}: Meta Settings shows the version button`, s.panelMeta && s.ver.shown && s.ver.h >= (viewport.hasTouch ? 44 : 28), s.ver);
	if (!xr && viewport.isMobile) check(`${T}: Cardboard VR is offered on a phone without WebXR`, s.cardboard.shown && !s.cardHidden && s.cardboard.h >= 44, s.cardboard);
	if (xr) check(`${T}: Cardboard stays hidden when WebXR is available`, !s.cardboard?.shown && s.cardHidden, { shown: s.cardboard, hidden: s.cardHidden });

	await shot(p, `${name}-meta-settings`, true);
	await p.click('#gs-version-btn');
	await sleep(300);
	const modal = await p.evaluate(() => document.getElementById('gs-version-modal')?.classList.contains('visible'));
	check(`${T}: version button still opens the picker`, modal);
	await p.evaluate(() => document.getElementById('gs-version-close')?.click());
	await sleep(200);

	check(`${T}: no console errors`, errors.length === 0, errors);
	await p.close();
}

await run2d({ name: 'desktop', viewport: { width: 1280, height: 800 }, xr: true });
await run2d({ name: 'phone', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: PHONE_UA, xr: false });

// ---- VR: ray-click the hamburger and the Meta Settings tab ----
{
	const { p, errors } = await openPage({ viewport: { width: 1400, height: 900 }, xr: true });
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); window.gsXrMode.set('vr'); });
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => window.renderer?.xr?.isPresenting)); i++) await sleep(250);
	const presenting = await p.evaluate(() => !!window.renderer?.xr?.isPresenting);
	check('[VR] in an IWER Quest 3 VR session', presenting);
	if (presenting) {
		await sleep(1500);
		await p.evaluate(() => {
			window.__t = {
				win(n) { return window.__gsVrWindows.byName(n); },
				uvOf(sel) {
					const w = this.win('menu'); const src = w.source || document.getElementById('desktop-chat');
					const el = document.querySelector(sel); const r = el.getBoundingClientRect(), s = src.getBoundingClientRect();
					return { x: (r.left + r.width / 2 - s.left) / s.width, y: 1 - (r.top + r.height / 2 - s.top) / s.height };
				}
			};
		});
		const frame = (ms) => sleep(ms);
		const rayClick = async (sel) => {
			const uv = await p.evaluate((sel) => window.__t.uvOf(sel), sel);
			return p.evaluate((uv) => { const el = window.__gsVrWindows.byName('menu').click(uv); return el ? (el.id || el.className || el.tagName) : null; }, uv);
		};
		const winShot = async (name) => {
			await p.evaluate(() => window.__gsVrWindows.byName('menu').tick(true));
			const png = await p.evaluate(() => {
				const src = window.__gsVrWindows.byName('menu').mesh.material.map.image;
				const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
				c.getContext('2d').drawImage(src, 0, 0); return c.toDataURL('image/png');
			});
			fs.writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(png.split(',')[1], 'base64'));
		};
		await p.evaluate(() => window.gsSelectTab('chat'));
		await frame(400);
		await winShot('vr-hamburger-closed');
		await rayClick('#gs-menu-hamburger'); await frame(400);
		const opened = await p.evaluate(() => document.getElementById('desktop-chat').classList.contains('gs-tab-menu-open'));
		check('[VR] ray click on the hamburger opens the tab list', opened);
		await winShot('vr-hamburger-open');
		await rayClick('#dchat-tab-meta'); await frame(500);
		const st = await p.evaluate(() => ({
			tab: document.querySelector('.dchat-tab.active')?.dataset.tab,
			open: document.getElementById('desktop-chat').classList.contains('gs-tab-menu-open'),
			panel: document.getElementById('dchat-panel-meta')?.classList.contains('active'),
			label: document.getElementById('gs-menu-current-tab')?.textContent.trim(),
			verShown: (() => { const r = document.getElementById('gs-version-btn').getBoundingClientRect(); return r.width > 0 && r.height > 0; })()
		}));
		check('[VR] ray click selects Meta Settings and closes the list', st.tab === 'meta' && st.panel && !st.open && /meta/i.test(st.label || '') && st.verShown, st);
		await winShot('vr-meta-settings');
	}
	check('[VR] no console errors', errors.length === 0, errors);
	await p.close();
}

await b.close();
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
