// VR input suite (IWER-emulated Meta Quest 3, puppeteer-core 24.43.1):
//  1. Top bar: Enter VR and the GS version button sit side by side in the
//     window header (desktop + phone widths), nothing is left at the bottom
//     of the page, the version picker still opens, clicks there don't drag.
//  2. Exit VR: a big red button at the top of the VR menu on every tab;
//     a ray click calls XRSession.end() and the page is back in 2D.
//  3. Code tab in VR: thumbstick (with locomotion on) and trigger-drag scroll
//     the code, the highlight layer follows, the bottom of long code shows,
//     a scrollbar is painted, and the stick does not move the player.
//  4. Origin gizmo: hold grip with the ray on it and the scene's origin
//     rotation follows the controller's rotation; release stops it.
//   npm i && BASE=https://localhost:3711 OUT=/tmp/shots node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3711';
const OUT = process.env.OUT || '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function openPage({ viewport, ua = null, xr = true }) {
	const p = await b.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
	if (ua) await p.setUserAgent(ua);
	await p.setViewport(viewport);
	if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	await p.setRequestInterception(true);
	p.on('request', (req) => { const u = new URL(req.url());
		if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
		if (u.pathname === '/api/community-scenes') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenes: [] }) });
		req.continue(); });
	await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
	await sleep(2000);
	return { p, errors };
}

// Where the top-bar pieces are, relative to the window and the page.
const topBar = (p) => p.evaluate(() => {
	const R = (s) => { const e = document.querySelector(s); if (!e) return null; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0, l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, text: (e.textContent || '').trim() }; };
	const dock = document.getElementById('gs-dock');
	const xr = document.getElementById('XRButton');
	const ver = document.getElementById('gs-version-btn');
	const shown = [...dock.children].filter((e) => getComputedStyle(e).display !== 'none');
	// Anything fixed/absolute and visible in the bottom 120px of the page that is not the chat window or a modal.
	const bottomStuff = [...document.querySelectorAll('body *')].filter((e) => {
		const cs = getComputedStyle(e); if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false;
		const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false;
		if (e.closest('#desktop-chat, [id$="-modal"], #overlay-root, canvas, #gs-twin-sticks')) return false;
		return r.bottom > innerHeight - 120 && r.top < innerHeight;
	}).map((e) => e.id || e.className || e.tagName);
	return {
		dockInHeader: !!dock.closest('#desktop-chat-header'), xrInDock: xr.parentElement === dock, verInDock: ver.parentElement === dock,
		verRightAfterXr: xr.nextElementSibling === ver, order: shown.map((e) => e.id),
		header: R('#desktop-chat-header'), chat: R('#desktop-chat'), tabs: R('#desktop-chat-tabs'), dock: R('#gs-dock'), xr: R('#XRButton'), ver: R('#gs-version-btn'),
		cardboard: R('#cardboard-btn'), exit: R('#gs-exit-vr-btn'), hb: R('#desktop-chat-header-buttons'), ui: R('#ui-toggle'),
		overflow: dock.scrollWidth > dock.clientWidth + 1, bottomStuff, innerHeight
	};
});
const overlaps = (a, b) => a && b && a.shown && b.shown && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;

// ============================================================ 1. top bar
for (const vp of [
	{ name: 'desktop-1600', viewport: { width: 1600, height: 900 }, xr: true },
	{ name: 'desktop-1280-nowebxr', viewport: { width: 1280, height: 800 }, xr: false },
	{ name: 'phone-390-iphone', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: PHONE_UA, xr: false },
	{ name: 'phone-360-android-webxr', viewport: { width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: ANDROID_UA, xr: true },
	{ name: 'phone-844x390-landscape', viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: ANDROID_UA, xr: true },
	{ name: 'tablet-820', viewport: { width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: PHONE_UA.replace('iPhone', 'iPad'), xr: true }
]) {
	const { p, errors } = await openPage(vp);
	const g = await topBar(p);
	const T = vp.name;
	check(`${T}: top bar lives in the window header`, g.dockInHeader && g.xrInDock && g.verInDock, { dockInHeader: g.dockInHeader, xrInDock: g.xrInDock, verInDock: g.verInDock });
	check(`${T}: version button sits right after Enter VR`, g.verRightAfterXr);
	const vrBtn = g.xr.shown ? g.xr : g.cardboard;
	check(`${T}: VR button shown (${g.xr.shown ? g.xr.text : g.cardboard.text})`, vrBtn && vrBtn.shown, g.order);
	check(`${T}: VR + version buttons at the top of the window (above the tabs)`, vrBtn.b <= g.tabs.t + 1 && g.ver.b <= g.tabs.t + 1 && vrBtn.t >= g.chat.t && g.ver.t >= g.chat.t, { vr: [vrBtn.t, vrBtn.b], ver: [g.ver.t, g.ver.b], tabsTop: g.tabs.t, chatTop: g.chat.t });
	check(`${T}: VR and version buttons are neighbours on one row`, Math.abs(vrBtn.t - g.ver.t) < 2 && g.ver.l - vrBtn.r >= 0 && g.ver.l - vrBtn.r < 14, { gap: g.ver.l - vrBtn.r });
	check(`${T}: top bar inside the window, not overflowing`, !g.overflow && g.dock.l >= g.chat.l && g.dock.r <= g.chat.r + 0.5, { dock: [g.dock.l, g.dock.r], chat: [g.chat.l, g.chat.r] });
	check(`${T}: no overlap with the expand / minimize buttons or Hide UI`, !overlaps(vrBtn, g.hb) && !overlaps(g.ver, g.hb) && !overlaps(vrBtn, g.ui) && !overlaps(g.ver, g.ui), { vr: vrBtn, ver: g.ver, hb: g.hb, ui: g.ui });
	if (vp.viewport.hasTouch) check(`${T}: 44px touch targets`, vrBtn.h >= 44 && g.ver.h >= 44, { vr: vrBtn.h, ver: g.ver.h });
	check(`${T}: Exit VR hidden outside VR`, !g.exit.shown);
	check(`${T}: nothing left at the bottom of the page`, g.bottomStuff.length === 0, g.bottomStuff);
	if (!vp.xr && !vp.viewport.isMobile) check(`${T}: "VR NOT SUPPORTED" still shown (compact status pill)`, g.xr.shown && /not supported/i.test(g.xr.text), g.xr.text);
	// Version picker still opens from the top bar; clicking there doesn't drag the window.
	const before = await p.evaluate(() => document.getElementById('desktop-chat').getBoundingClientRect().toJSON());
	await p.click('#gs-version-btn');
	await sleep(400);
	const modal = await p.evaluate(() => document.getElementById('gs-version-modal').classList.contains('visible'));
	check(`${T}: version button opens the version picker`, modal);
	if (OUT) await p.screenshot({ path: `${OUT}/${T}-version-picker.png` });
	await p.evaluate(() => document.getElementById('gs-version-close')?.click());
	await sleep(300);
	const after = await p.evaluate(() => document.getElementById('desktop-chat').getBoundingClientRect().toJSON());
	check(`${T}: clicking the top bar does not move the window`, Math.abs(after.left - before.left) < 1 && Math.abs(after.top - before.top) < 1);
	if (OUT) await p.screenshot({ path: `${OUT}/${T}-top-bar.png` });
	if (OUT) await p.screenshot({ path: `${OUT}/${T}-top-bar-zoom.png`, clip: { x: Math.max(0, g.chat.l - 8), y: Math.max(0, g.chat.t - 8), width: Math.min(vp.viewport.width - Math.max(0, g.chat.l - 8), g.chat.w + 16), height: Math.min(200, g.tabs.b - g.chat.t + 24) } });
	// The header is still a drag handle outside the top bar (desktop).
	if (!vp.viewport.isMobile) {
		const h = g.header; const sx = g.chat.l + 20, sy = h.t + h.h / 2;
		await p.mouse.move(sx, sy); await p.mouse.down(); await p.mouse.move(sx + 120, sy + 60, { steps: 6 }); await p.mouse.up(); await sleep(200);
		const moved = await p.evaluate(() => document.getElementById('desktop-chat').getBoundingClientRect().toJSON());
		check(`${T}: header still drags the window`, moved.left > after.left + 60, { from: after.left, to: moved.left });
		// Default and narrow (300px) windows: one header row, same height as before (49px).
		for (const w of [null, 300]) {
			if (w) await p.evaluate((w) => { document.getElementById('desktop-chat').style.width = w + 'px'; }, w);
			await sleep(150);
			const o = await topBar(p); const ob = o.xr.shown ? o.xr : o.cardboard;
			check(`${T}: ${w ? w + 'px' : 'default'} window: top bar on the title row, header not taller`, Math.abs(ob.t + ob.h / 2 - (o.hb.t + o.hb.h / 2)) < 3 && o.header.h <= 50 && !o.overflow && !overlaps(ob, o.hb) && !overlaps(o.ver, o.hb), { header: o.header.h, vr: [ob.l, ob.r], ver: [o.ver.l, o.ver.r], hb: [o.hb.l, o.hb.r] });
			if (OUT && w) await p.screenshot({ path: `${OUT}/${T}-${w}px-window.png`, clip: { x: Math.max(0, o.chat.l - 8), y: Math.max(0, o.chat.t - 8), width: o.chat.w + 16, height: o.tabs.b - o.chat.t + 24 } });
		}
		// Narrowest window: the top bar wraps onto its own row instead of overflowing.
		await p.evaluate(() => { const c = document.getElementById('desktop-chat'); c.style.width = '280px'; });
		await sleep(200);
		const n = await topBar(p);
		const nb = n.xr.shown ? n.xr : n.cardboard;
		check(`${T}: min-width window: top bar fits (no overflow / overlap)`, !n.overflow && n.dock.r <= n.chat.r + 0.5 && !overlaps(nb, n.hb) && !overlaps(n.ver, n.hb) && nb.b <= n.tabs.t + 1, { dock: n.dock, hb: n.hb });
		if (OUT) await p.screenshot({ path: `${OUT}/${T}-min-width-window.png`, clip: { x: Math.max(0, n.chat.l - 8), y: Math.max(0, n.chat.t - 8), width: n.chat.w + 16, height: n.tabs.b - n.chat.t + 24 } });
	}
	check(`${T}: no console errors`, errors.length === 0, errors);
	await p.close();
}

// ============================================================ VR
const { p, errors } = await openPage({ viewport: { width: 1600, height: 900 }, xr: true });
const frame = (ms = 400) => sleep(ms);
const enterVr = async () => {
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
	await sleep(1200);
	return p.evaluate(() => renderer.xr.isPresenting);
};
check('Enter VR from the top bar (IWER Quest 3)', await enterVr());
await p.evaluate(() => {
	const V = THREE.Vector3;
	window.__t = {
		win: (n) => window.__gsVrWindows.byName(n),
		pointFor(el, winName, fx = 0.5, fy = 0.5) {
			const w = this.win(winName); const sr = w.source.getBoundingClientRect(); const r = el.getBoundingClientRect();
			const u = (r.left + r.width * fx - sr.left) / sr.width, v = 1 - (r.top + r.height * fy - sr.top) / sr.height;
			w.mesh.updateMatrixWorld(true);
			return w.mesh.localToWorld(new V(u - 0.5, v - 0.5, 0.0));
		},
		ctrl(hand) { return [0, 1].map((i) => renderer.xr.getController(i)).find((x) => x.userData.handedness === hand); },
		aim(hand, target, extraQ = null) {
			const c = this.ctrl(hand);
			const xrCam = renderer.xr.getCamera(); const head = new V(); xrCam.getWorldPosition(head);
			const origin = head.clone().add(new V(hand === 'right' ? 0.15 : -0.15, -0.3, -0.1));
			const parent = c.parent; parent.updateMatrixWorld(true);
			const inv = parent.matrixWorld.clone().invert();
			const o = origin.clone().applyMatrix4(inv), t = target.clone().applyMatrix4(inv);
			const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(o, t, new V(0, 1, 0)));
			const dc = window.__xrDevice.controllers[hand];
			dc.position.set(o.x, o.y, o.z); dc.quaternion.set(q.x, q.y, q.z, q.w);
			return q;
		},
		aimAt(hand, el, winName, fx, fy) { return this.aim(hand, this.pointFor(el, winName, fx, fy)); },
		setQ(hand, q) { window.__xrDevice.controllers[hand].quaternion.set(q.x, q.y, q.z, q.w); },
		trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); },
		squeeze(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('squeeze', v); },
		stick(hand, x, y) { window.__xrDevice.controllers[hand].updateAxes('thumbstick', x, y); },
		// Painted texture pixels (canvas px) inside an element's box.
		texRegion(el, winName = 'menu') {
			const w = this.win(winName); w.tick(true);
			const sr = w.source.getBoundingClientRect(), r = el.getBoundingClientRect(); const k = w.canvas.width / sr.width;
			const x = Math.round((r.left - sr.left) * k), y = Math.round((r.top - sr.top) * k), ww = Math.max(1, Math.round(r.width * k)), hh = Math.max(1, Math.round(r.height * k));
			return { x, y, w: ww, h: hh, data: w.canvas.getContext('2d').getImageData(x, y, ww, hh).data };
		},
		saveWindow(winName = 'menu') { const w = this.win(winName); w.tick(true); return w.canvas.toDataURL('image/png'); }
	};
});
const click = async (hand = 'right') => { await p.evaluate((h) => __t.trigger(h, 1), hand); await frame(300); await p.evaluate((h) => __t.trigger(h, 0), hand); await frame(400); };
const saveTex = async (name, winName = 'menu') => { if (!OUT) return; const url = await p.evaluate((n) => __t.saveWindow(n), winName); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(',')[1], 'base64')); };

// ============================================================ 2. Exit VR
const exitInfo = async () => p.evaluate(() => {
	const e = document.getElementById('gs-exit-vr-btn'); const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
	const tabs = document.getElementById('desktop-chat-tabs').getBoundingClientRect();
	const src = __t.win('menu').source.getBoundingClientRect();
	// Red pixels painted into the VR menu texture inside the button.
	const reg = __t.texRegion(e); let red = 0, n = 0;
	for (let i = 0; i < reg.data.length; i += 4) { n++; const [R, G, B] = [reg.data[i], reg.data[i + 1], reg.data[i + 2]]; if (R > 170 && G < 90 && B < 90) red++; }
	return { shown: cs.display !== 'none' && r.width > 0, w: r.width, h: r.height, aboveTabs: r.bottom <= tabs.top + 1, topOfMenu: r.top - src.top, bg: cs.backgroundColor, color: cs.color, fontSize: cs.fontSize, redShare: red / Math.max(1, n),
		xrHidden: getComputedStyle(document.getElementById('XRButton')).display === 'none', verHidden: getComputedStyle(document.getElementById('gs-version-btn')).display === 'none' };
});
const ex = await exitInfo();
check('VR menu: Exit VR button shown', ex.shown, ex);
check('VR menu: Exit VR is at the top of the menu (header, above the tabs)', ex.aboveTabs && ex.topOfMenu < 60, { topOfMenu: ex.topOfMenu });
check('VR menu: Exit VR is large (≥ 40px tall, ≥ 120px wide) and bold', ex.h >= 40 && ex.w >= 120 && parseFloat(ex.fontSize) >= 15, { w: ex.w, h: ex.h, fontSize: ex.fontSize });
check('VR menu: Exit VR is red with a white label', ex.bg === 'rgb(220, 38, 38)' && ex.color === 'rgb(255, 255, 255)', { bg: ex.bg, color: ex.color });
check('VR menu: Exit VR is painted red into the headset texture', ex.redShare > 0.5, { redShare: +ex.redShare.toFixed(2) });
check('VR menu: Enter VR / version buttons give way to Exit VR', ex.xrHidden && ex.verHidden);
// Contrast of the label: white on #dc2626 is 4.83:1.
await saveTex('vr-menu-exit-vr-chat-tab');
for (const tab of ['env', 'code', 'share']) {
	await p.evaluate((t) => __t.aimAt('right', document.querySelector(`.dchat-tab[data-tab="${t}"]`), 'menu'), tab);
	await frame(300); await click();
	const e2 = await exitInfo();
	check(`VR menu: Exit VR still at the top on the ${tab} tab`, e2.shown && e2.aboveTabs && e2.redShare > 0.5, { shown: e2.shown, red: +e2.redShare.toFixed(2) });
	if (tab === 'code') await saveTex('vr-menu-exit-vr-code-tab');
}
// Hover ring + ray click ends the session.
await p.evaluate(() => {
	const s = renderer.xr.getSession(); window.__endCalls = 0;
	const orig = s.end.bind(s); s.end = () => { window.__endCalls++; return orig(); };
});
await p.evaluate(() => __t.aimAt('right', document.getElementById('gs-exit-vr-btn'), 'menu'));
await frame(500);
const hov = await p.evaluate(() => document.getElementById('gs-exit-vr-btn').classList.contains('gs-ray-hover'));
check('Ray hover highlights Exit VR', hov);
await saveTex('vr-menu-exit-vr-hover');
await click();
for (let i = 0; i < 20 && (await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(200);
await sleep(600);
const out = await p.evaluate(() => ({
	endCalls: window.__endCalls, presenting: renderer.xr.isPresenting, session: !!renderer.xr.getSession(),
	bodyXr: document.body.classList.contains('gs-xr-presenting'),
	menuVisible: __t.win('menu').mesh.visible, parked: document.getElementById('desktop-chat').classList.contains('html-in-canvas-source'),
	chatShown: getComputedStyle(document.getElementById('desktop-chat')).display !== 'none',
	xrText: document.getElementById('XRButton').textContent, xrShown: getComputedStyle(document.getElementById('XRButton')).display !== 'none',
	exitShown: getComputedStyle(document.getElementById('gs-exit-vr-btn')).display !== 'none'
}));
check('Ray click on Exit VR calls XRSession.end() once', out.endCalls === 1, out);
check('Session ended (not presenting)', !out.presenting && !out.session);
check('Back in the 2D view: VR windows hidden, desktop window back', !out.bodyXr && !out.menuVisible && !out.parked && out.chatShown, out);
check('Back in 2D: Enter VR shown again, Exit VR hidden', out.xrShown && /enter vr/i.test(out.xrText) && !out.exitShown, out);
if (OUT) await p.screenshot({ path: `${OUT}/desktop-after-exit-vr.png` });

// ============================================================ 3. Code tab scrolling
check('Re-enter VR', await enterVr());
await p.evaluate(() => { document.querySelector('.dchat-tab[data-tab="code"]').click(); });
await frame(300);
await p.evaluate(() => {
	const ta = document.getElementById('dchat-code-editor');
	ta.value = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i}; // code line ${i}`).join('\n') + '\n// THE-LAST-LINE';
	ta.dispatchEvent(new Event('input', { bubbles: true }));
	ta.scrollTop = 0; ta.dispatchEvent(new Event('scroll'));
});
await frame(800);
const codeState = () => p.evaluate(() => {
	const ta = document.getElementById('dchat-code-editor'); const pre = document.querySelector('.dchat-code-highlight');
	const wrap = document.querySelector('.dchat-code-editor-wrap').getBoundingClientRect();
	const last = [...document.querySelectorAll('#dchat-code-highlight .tok-comment')].pop();
	const lr = last ? last.getBoundingClientRect() : null;
	return { top: ta.scrollTop, max: ta.scrollHeight - ta.clientHeight, preTop: pre.scrollTop, preMax: pre.scrollHeight - pre.clientHeight,
		lastText: last ? last.textContent : '', lastVisible: !!lr && lr.top >= wrap.top && lr.bottom <= wrap.bottom + 1,
		player: window.gsVrInput.playerPosition().toArray().map((v) => +v.toFixed(3)), loco: window.gsVrInput.locomotionMode };
});
const c0 = await codeState();
check('Code tab has long code (scrollable)', c0.max > 2000, c0);
check('Locomotion is on (default free) for the stick test', c0.loco !== 'off', c0.loco);
await p.evaluate(() => __t.aimAt('right', document.getElementById('dchat-code-editor'), 'menu', 0.5, 0.5));
await frame(400);
await p.evaluate(() => __t.stick('right', 0, 1)); await frame(900);
const owned = await p.evaluate(() => window.gsVrInput.stickOwnedByWindow.right);
await p.evaluate(() => __t.stick('right', 0, 0)); await frame(300);
const c1 = await codeState();
check('Thumbstick on the code scrolls it down (locomotion on)', c1.top > c0.top + 200, { before: c0.top, after: c1.top });
check('Highlight layer follows the scroll (what is painted moves)', Math.abs(c1.preTop - Math.min(c1.top, c1.preMax)) <= 1, { textarea: c1.top, pre: c1.preTop });
check('Stick on the code window is consumed (does not move / lift the player)', owned && JSON.stringify(c1.player) === JSON.stringify(c0.player), { owned, before: c0.player, after: c1.player });
// Hold the stick to the end: clamped at the bottom, last line visible.
await p.evaluate(() => __t.stick('right', 0, 1));
for (let i = 0; i < 60; i++) { await frame(500); const s = await codeState(); if (s.top >= s.max) break; }
await frame(1000); // keep pushing at the end: must stay clamped
await p.evaluate(() => __t.stick('right', 0, 0)); await frame(500);
const c2 = await codeState();
check('Scrolling stops at the end of the code (clamped)', c2.top >= c2.max - 1 && c2.top <= c2.max, { top: c2.top, max: c2.max });
check('Bottom of long code is visible', c2.lastVisible && /THE-LAST-LINE/.test(c2.lastText), { lastText: c2.lastText, visible: c2.lastVisible });
// The painted texture shows the last line: some light text pixels in the last line's box.
const painted = await p.evaluate(() => {
	const last = [...document.querySelectorAll('#dchat-code-highlight .tok-comment')].pop();
	const reg = __t.texRegion(last); let lit = 0; for (let i = 0; i < reg.data.length; i += 4) if (reg.data[i] + reg.data[i + 1] + reg.data[i + 2] > 200) lit++;
	// Scrollbar thumb: bright pixels in the editor's right 10px at the bottom.
	const ta = document.getElementById('dchat-code-editor'); const r = ta.getBoundingClientRect();
	const w = __t.win('menu'); const sr = w.source.getBoundingClientRect(); const k = w.canvas.width / sr.width;
	const x = Math.round((r.right - sr.left - 10) * k), y = Math.round((r.bottom - sr.top - 60) * k);
	const d = w.canvas.getContext('2d').getImageData(x, y, Math.round(10 * k), Math.round(50 * k)).data; let thumb = 0;
	for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i + 1] > 120 && d[i + 2] > 120) thumb++;
	const y2 = Math.round((r.top - sr.top + 10) * k); const d2 = w.canvas.getContext('2d').getImageData(x, y2, Math.round(10 * k), Math.round(50 * k)).data; let thumbTop = 0;
	for (let i = 0; i < d2.length; i += 4) if (d2[i] > 120 && d2[i + 1] > 120 && d2[i + 2] > 120) thumbTop++;
	return { lit, thumb, thumbTop };
});
check('Headset texture shows the last line of code', painted.lit > 20, painted);
check('Scrollbar indicator painted (thumb at the bottom, not at the top)', painted.thumb > 20 && painted.thumbTop < painted.thumb / 4, painted);
await saveTex('vr-code-window-scrolled-to-bottom');
// Trigger-drag scrolls back up (content follows the ray downwards).
await p.evaluate(() => __t.aimAt('right', document.getElementById('dchat-code-editor'), 'menu', 0.5, 0.3));
await frame(300);
await p.evaluate(() => __t.trigger('right', 1)); await frame(300);
for (const fy of [0.45, 0.6, 0.75, 0.9]) { await p.evaluate((f) => __t.aimAt('right', document.getElementById('dchat-code-editor'), 'menu', 0.5, f), fy); await frame(200); }
await p.evaluate(() => __t.trigger('right', 0)); await frame(400);
const c3 = await codeState();
check('Trigger-drag on the code scrolls it (up)', c3.top < c2.top - 150, { before: c2.top, after: c3.top });
check('Highlight layer follows the drag', Math.abs(c3.preTop - Math.min(c3.top, c3.preMax)) <= 1, { textarea: c3.top, pre: c3.preTop });
const kbOpen = await p.evaluate(() => __t.win('keyboard').mesh.visible);
check('A drag does not open the keyboard', !kbOpen);
// Away from the windows the stick still moves the player.
await p.evaluate(() => __t.aim('left', new THREE.Vector3(-5, 0, 3)));
await frame(300);
const pl0 = await p.evaluate(() => window.gsVrInput.playerPosition().toArray());
await p.evaluate(() => __t.stick('left', 0, -1)); await frame(700); await p.evaluate(() => __t.stick('left', 0, 0)); await frame(200);
const pl1 = await p.evaluate(() => window.gsVrInput.playerPosition().toArray());
check('Stick with the ray off the windows still moves the player', Math.hypot(pl1[0] - pl0[0], pl1[2] - pl0[2]) > 0.2, { from: pl0, to: pl1 });

// ============================================================ 4. Origin gizmo grab
await p.evaluate(() => { document.querySelector('.dchat-tab[data-tab="env"]').click(); });
await frame(300);
await p.evaluate(() => { window.gsOrigin.reset(); const g = document.getElementById('dchat-origin-gizmo'); g.scrollIntoView({ block: 'center' }); document.getElementById('dchat-env')?.dispatchEvent(new Event('scroll')); });
await frame(800);
const q0 = await p.evaluate(() => __t.aimAt('right', document.getElementById('dchat-origin-gizmo'), 'menu').toArray());
await frame(400);
const locoBefore = await p.evaluate(() => window.gsVrInput.locomotionMode);
await p.evaluate(() => __t.squeeze('right', 1)); await frame(400);
const g1 = await p.evaluate(() => ({ grab: window.gsVrInput.gizmoGrab, grabbed: window.gsOrigin._gizmo.grabbed, loco: window.gsVrInput.locomotionMode }));
check('Grip with the ray on the gizmo grabs it', g1.grab && g1.grab.hand === 'right' && g1.grabbed, g1);
check('Grip on the gizmo does not cycle locomotion', g1.loco === locoBefore, { before: locoBefore, after: g1.loco });
const halo = await p.evaluate(() => { const reg = __t.texRegion(document.getElementById('dchat-origin-gizmo')); let amber = 0; for (let i = 0; i < reg.data.length; i += 4) { const [R, G, B] = [reg.data[i], reg.data[i + 1], reg.data[i + 2]]; if (R > 200 && G > 160 && B < 90) amber++; } return amber; });
check('Grabbed gizmo is highlighted (amber halo in the headset texture)', halo > 50, { amberPixels: halo });
await saveTex('vr-origin-gizmo-grabbed');
// Turn the controller 40° about world up and 25° about its own right: the scene follows the delta.
const plq0 = await p.evaluate(() => window.gsVrInput.playerPosition().toArray());
const expectAngle = async () => p.evaluate((q0a) => {
	const c = __t.ctrl('right'); c.updateMatrixWorld(true);
	const now = c.getWorldQuaternion(new THREE.Quaternion());
	const start = window.__grabStartWorld;
	const delta = now.clone().multiply(start.clone().invert());
	const expected = delta.clone(); // base is identity (reset before the grab)
	const actual = window.gsOriginRoot.quaternion.clone();
	return { angleErrDeg: THREE.MathUtils.radToDeg(expected.angleTo(actual)), rotDeg: THREE.MathUtils.radToDeg(actual.angleTo(new THREE.Quaternion())), rotation: window.gsOrigin.rotation };
});
await p.evaluate(() => { const c = __t.ctrl('right'); c.updateMatrixWorld(true); window.__grabStartWorld = c.getWorldQuaternion(new THREE.Quaternion()); });
for (const [yaw, pitch] of [[10, 0], [20, 10], [40, 25]]) {
	await p.evaluate((q0a, y, pt) => {
		const q0 = new THREE.Quaternion().fromArray(q0a);
		const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pt), THREE.MathUtils.degToRad(y), 0, 'YXZ'));
		__t.setQ('right', turn.multiply(q0));
	}, q0, yaw, pitch);
	await frame(300);
}
const r1 = await expectAngle();
check('Origin rotation follows the controller (delta = now × start⁻¹)', r1.rotDeg > 30 && r1.angleErrDeg < 1.5, r1);
const pl2 = await p.evaluate(() => window.gsVrInput.playerPosition().toArray());
check('Player does not move while holding the gizmo', JSON.stringify(pl2) === JSON.stringify(plq0));
const inputsShow = await p.evaluate(() => ({ yaw: document.getElementById('dchat-origin-yaw').value, readout: document.getElementById('dchat-origin-readout').textContent }));
check('Gizmo readout / fields update live', /Yaw/.test(inputsShow.readout) && Number(inputsShow.yaw) !== 0, inputsShow);
await saveTex('vr-origin-gizmo-rotated');
// Release: further controller turns do nothing.
await p.evaluate(() => __t.squeeze('right', 0)); await frame(400);
const relRot = await p.evaluate(() => window.gsOriginRoot.quaternion.toArray());
await p.evaluate((q0a) => { const q0 = new THREE.Quaternion().fromArray(q0a); __t.setQ('right', new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -1.2, 0.4, 'YXZ')).multiply(q0)); }, q0);
await frame(500);
const g2 = await p.evaluate(() => ({ grab: window.gsVrInput.gizmoGrab, grabbed: window.gsOrigin._gizmo.grabbed, rot: window.gsOriginRoot.quaternion.toArray(), loco: window.gsVrInput.locomotionMode }));
check('Releasing the grip lets go (no highlight)', !g2.grab && !g2.grabbed);
check('After release the rotation no longer follows the controller', g2.rot.every((v, i) => Math.abs(v - relRot[i]) < 1e-6), { atRelease: relRot, now: g2.rot });
check('Release does not cycle locomotion either', g2.loco === locoBefore);
// Left controller works too.
await p.evaluate(() => window.gsOrigin.reset());
const ql = await p.evaluate(() => __t.aimAt('left', document.getElementById('dchat-origin-gizmo'), 'menu').toArray());
await frame(400);
await p.evaluate(() => __t.squeeze('left', 1)); await frame(300);
await p.evaluate(() => { const c = __t.ctrl('left'); c.updateMatrixWorld(true); window.__grabStartWorld = c.getWorldQuaternion(new THREE.Quaternion()); });
await p.evaluate((q) => { const q0 = new THREE.Quaternion().fromArray(q); __t.setQ('left', new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.6, 0, 'YXZ')).multiply(q0)); }, ql);
await frame(400);
const lrot = await p.evaluate(() => ({ grab: window.gsVrInput.gizmoGrab, deg: THREE.MathUtils.radToDeg(window.gsOriginRoot.quaternion.angleTo(new THREE.Quaternion())) }));
await p.evaluate(() => __t.squeeze('left', 0)); await frame(300);
check('Left controller grabs and rotates the gizmo too', lrot.grab && lrot.grab.hand === 'left' && Math.abs(lrot.deg - 34.4) < 2, lrot);
// Grip off the gizmo keeps cycling locomotion (right hand).
await p.evaluate(() => __t.aim('right', new THREE.Vector3(5, 0, 3)));
await frame(300);
const lb = await p.evaluate(() => window.gsVrInput.locomotionMode);
await p.evaluate(() => __t.squeeze('right', 1)); await frame(300); await p.evaluate(() => __t.squeeze('right', 0)); await frame(300);
const la = await p.evaluate(() => ({ loco: window.gsVrInput.locomotionMode, grab: window.gsVrInput.gizmoGrab }));
check('Right grip away from the gizmo still cycles locomotion', la.loco !== lb && !la.grab, { before: lb, after: la.loco });
await p.evaluate(() => window.gsOrigin.reset());

check('No console errors', errors.length === 0, errors);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
