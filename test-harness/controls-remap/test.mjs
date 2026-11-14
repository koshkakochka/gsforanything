// Controls tab: key remapping per camera style + Custom Controls sub-tab.
//   BASE=https://localhost:3741 SHOT_DIR=/workspace/gs-controls-remap-shots node test.mjs
// /api/chat is stubbed (request interception) with a reply whose vr-exec
// block defines a custom scheme; nothing reaches an LLM, Community POSTs are
// blocked, dummy keys only.
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3741';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-controls-remap-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
	ok ? pass++ : fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`);
};
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

// The stubbed chat reply: a car driven by a custom scheme.
const SCHEME_CODE = `
const car = gsControls.defineCustomScheme({
  id: 'car', name: 'Car driving', description: 'Drive the red box around.',
  cameraMode: 'off',
  params: [
    { name: 'accelerate', label: 'Accelerate', type: 'key', default: 'W' },
    { name: 'brake', label: 'Brake / reverse', type: 'key', default: 'S' },
    { name: 'steerLeft', label: 'Steer left', type: 'key', default: 'A' },
    { name: 'steerRight', label: 'Steer right', type: 'key', default: 'D' },
    { name: 'horn', label: 'Horn', type: 'key', default: 'Space' },
    { name: 'topSpeed', label: 'Top speed', type: 'number', default: 12, min: 2, max: 40, step: 1, unit: 'm/s' },
    { name: 'autoBrake', label: 'Brake when idle', type: 'boolean', default: true },
    { name: 'view', label: 'Camera view', type: 'select', options: ['Chase', 'Hood', 'Top'], default: 'Chase' }
  ]
});
const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 1), new THREE.MeshStandardMaterial({ color: 0xff3333 }));
box.name = 'testCar'; box.position.set(0, 0.15, -3); scene.add(box);
window.__carLog = { changes: [], horns: 0 };
car.onChange((name, value) => window.__carLog.changes.push([name, value]));
car.onPress('horn', () => window.__carLog.horns++);
gs.onUpdate((dt) => { if (car.isDown('accelerate')) box.position.z -= car.values.topSpeed * 0.1 * dt; });
`;
const SCHEME_REPLY = 'Here is a drivable car. W/S drive, A/D steer, Space honks. Change keys in Controls → Custom Controls.\n```vr-exec\n' + SCHEME_CODE + '\n```';

const b = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function openPage(ctx, viewport, { mobile = false } = {}) {
	const p = await ctx.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
	if (mobile) await p.setUserAgent(PHONE_UA);
	await p.setViewport(viewport);
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const u = new URL(req.url());
		if (u.pathname.startsWith('/api/')) {
			if (u.pathname.startsWith('/api/community') && req.method() !== 'GET') return req.respond({ status: 503, body: 'blocked' });
			if (u.pathname === '/api/chat') {
				return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: SCHEME_REPLY }] }) });
			}
			if (u.pathname === '/api/prompts') return req.continue(); // local server, static prompt text
			const body = u.pathname === '/api/backends'
				? '{"backends":{"claude":{"label":"Claude","provider":"claude","available":true}},"default":"claude"}'
				: (u.pathname.startsWith('/api/community-scenes') ? '{"scenes":[]}' : '{}');
			return req.respond({ status: 200, contentType: 'application/json', body });
		}
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.renderer && window.gsControls && window.gsKeyBindings && document.getElementById('gs-menu-hamburger'));
	await sleep(600);
	p._errors = errors;
	return p;
}

async function openControls(p, section = 'camera') {
	await p.evaluate(() => {
		const chat = document.getElementById('desktop-chat');
		if (!chat?.classList.contains('gs-tab-menu-open')) document.getElementById('gs-menu-hamburger')?.click();
	});
	await sleep(200);
	await p.evaluate(() => window.gsSelectTab('controls'));
	await sleep(250);
	await p.evaluate((s) => document.querySelector(`#dchat-controls-subtabs [data-controls-section="${s}"]`)?.click(), section);
	await sleep(200);
}
async function setMode(p, m) {
	await p.evaluate((m) => document.querySelector(`#dchat-camera-mode [data-camera-mode="${m}"]`)?.click(), m);
	await sleep(250);
}
const blur = (p) => p.evaluate(() => { document.activeElement?.blur?.(); document.body.focus(); });
async function holdKey(p, code, ms = 400) {
	await blur(p);
	await sleep(60); // focus-out settles (controls re-enable)
	await p.keyboard.down(code);
	await sleep(ms);
	await p.keyboard.up(code);
	await sleep(120);
}
const camState = (p) => p.evaluate(() => {
	const c = window.gsControls.controls;
	return { mode: window.gsControls.mode, pos: window.camera.position.toArray(), target: c?.target ? c.target.toArray() : null };
});
// Map / Orbit pan one step per keydown: tap a few times.
async function tapKey(p, code, n = 6) {
	await blur(p);
	await sleep(60);
	for (let i = 0; i < n; i++) { await p.keyboard.press(code); await sleep(40); }
	await sleep(400);
}
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const stored = (p, key) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);
const remapInfo = (p) => p.evaluate(() => {
	const box = document.getElementById('dchat-key-remap');
	const rows = [...box.querySelectorAll('.gs-remap-row')].map((r) => ({
		action: r.dataset.action, label: r.querySelector('.gs-remap-label')?.textContent,
		keys: [...r.querySelectorAll('input.gs-key-input')].map((i) => i.value),
		dup: [...r.querySelectorAll('input.duplicate')].length
	}));
	const warn = document.getElementById('dchat-key-remap-warning');
	return {
		style: box.dataset.style, visible: box.offsetParent !== null, rows,
		warn: warn && !warn.hidden ? warn.textContent : '',
		fixed: box.querySelector('.gs-remap-fixed')?.textContent || '',
		resetDisabled: document.getElementById('dchat-key-remap-reset')?.disabled
	};
});
async function focusKey(p, style, action, slot = 0) {
	const sel = `#gs-remap-${style}-${action}-${slot}`;
	await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
	await p.click(sel);
	await sleep(80);
	return sel;
}


	const orderInfo = (pg) => pg.evaluate(() => {
		const keys = document.getElementById('dchat-key-remap');
		const hEl = document.getElementById('dchat-player-height');
		const rows = keys.querySelectorAll('.gs-remap-row');
		const last = rows[rows.length - 1];
		return {
			style: keys.dataset.style,
			label: keys.querySelector('.dchat-section-label')?.textContent,
			prevIsKeys: hEl.previousElementSibling === keys,
			below: !!last && hEl.getBoundingClientRect().top >= keys.getBoundingClientRect().bottom - 1,
			between: [...document.querySelectorAll('#dchat-controls .dchat-controls-section[data-controls-section="camera"] > *')]
				.filter((e) => e.offsetParent !== null).map((e) => e.id || e.className).join(' | ')
		};
	});

// ===================================================================== desktop
const ctx = await b.createBrowserContext();
let p = await openPage(ctx, { width: 1280, height: 800 });
await p.evaluate(() => { localStorage.removeItem('gs.controlKeys.v1'); localStorage.removeItem('gs.customControls.v1'); });
await p.reload({ waitUntil: 'networkidle2' });
await p.waitForFunction(() => window.gsKeyBindings);
await sleep(600);
await openControls(p);
{
	const tabs = await p.evaluate(() => [...document.querySelectorAll('#dchat-controls-subtabs .dchat-subtab')].map((t) => [t.textContent.trim(), t.classList.contains('active')]));
	check('desktop Controls has Camera and Custom Controls sub-tabs', JSON.stringify(tabs) === JSON.stringify([['Camera', true], ['Custom Controls', false]]), tabs);
	const modes = await p.evaluate(() => [...document.querySelectorAll('#dchat-camera-mode [data-camera-mode]')].map((b) => b.dataset.cameraMode));
	check('desktop no Trackball mode (based on map-default branch)', !modes.includes('trackball'), modes);
	const info = await remapInfo(p);
	check('desktop Map remap list shown by default', info.style === 'map' && info.visible && info.rows.length === 4, info);
	check('desktop Map defaults are the arrow keys', JSON.stringify(info.rows.map((r) => r.keys[0])) === JSON.stringify(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']), info.rows);
	check('desktop mouse/touch shown read-only', /not remappable/.test(info.fixed) && /Left-drag/.test(info.fixed), info.fixed);
	check('desktop Reset disabled at defaults', info.resetDisabled === true);
	await p.evaluate(() => document.getElementById('dchat-key-remap')?.scrollIntoView({ block: 'start' }));
	await sleep(150);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-map-remap.png` });
}

// --- capture: press a key in the field
{
	const sel = await focusKey(p, 'map', 'panUp');
	const ph = await p.$eval(sel, (i) => i.placeholder);
	await p.keyboard.press('KeyI');
	await sleep(80);
	const v = await p.$eval(sel, (i) => i.value);
	await blur(p);
	await sleep(100);
	check('desktop focused key field asks for a key', ph === 'Press a key', ph);
	check('desktop pressing I in Pan forward captures "I"', v === 'I', v);
	const st = await stored(p, 'gs.controlKeys.v1');
	check('desktop remap saved to localStorage per style', JSON.stringify(st) === JSON.stringify({ map: { panUp: ['KeyI', ''] } }), st);
	// apply: I pans, ArrowUp no longer does
	let a = await camState(p);
	await tapKey(p, 'KeyI');
	let c = await camState(p);
	check('desktop remapped key I pans the Map camera', dist(a.target, c.target) > 0.15, { a: a.target, c: c.target });
	await sleep(500);
	a = await camState(p);
	await tapKey(p, 'ArrowUp');
	c = await camState(p);
	check('desktop old key ArrowUp no longer pans', dist(a.target, c.target) < 0.02, { a: a.target, c: c.target });
	// Arrow capture (non-printable) and alternate slot
	await focusKey(p, 'map', 'panUp', 1);
	await p.keyboard.press('ArrowUp');
	await sleep(60);
	await blur(p);
	const st2 = await stored(p, 'gs.controlKeys.v1');
	check('desktop ArrowUp captured into the alternate slot', JSON.stringify(st2?.map?.panUp) === JSON.stringify(['KeyI', 'ArrowUp']), st2);
}

// --- typing a key name
{
	const sel = await focusKey(p, 'map', 'panDown');
	await p.keyboard.type('Spa');
	await sleep(40);
	const mid = await p.$eval(sel, (i) => [i.value, i.classList.contains('invalid')]);
	await p.keyboard.type('ce');
	await p.keyboard.press('Enter');
	await sleep(100);
	const v = await p.$eval(sel, (i) => i.value);
	const st = await stored(p, 'gs.controlKeys.v1');
	check('desktop partial name is marked invalid while typing', mid[1] === true, mid);
	check('desktop typing "Space" binds Space', v === 'Space' && st?.map?.panDown?.[0] === 'Space', { v, st });
	await focusKey(p, 'map', 'panDown');
	await p.keyboard.type('k');
	await blur(p);
	await sleep(80);
	const v2 = await p.$eval(sel, (i) => i.value);
	check('desktop typing "k" shows "K"', v2 === 'K', v2);
	// Backspace on a fresh field clears; Esc restores
	await focusKey(p, 'map', 'panUp', 1);
	await p.keyboard.press('Backspace');
	await blur(p);
	const st3 = await stored(p, 'gs.controlKeys.v1');
	check('desktop Backspace clears the alternate key', st3?.map?.panUp?.[1] === '', st3);
	await focusKey(p, 'map', 'panDown');
	await p.keyboard.type('zz');
	await p.keyboard.press('Escape');
	await sleep(80);
	const v3 = await p.$eval(sel, (i) => i.value);
	check('desktop Esc puts the previous key back', v3 === 'K', v3);
}

// --- duplicate warning
{
	await focusKey(p, 'map', 'panLeft');
	await p.keyboard.press('KeyI');
	await blur(p);
	await sleep(120);
	const info = await remapInfo(p);
	const dupRows = info.rows.filter((r) => r.dup).map((r) => r.action);
	check('desktop duplicate warning names the key and actions', /I is used by Pan forward and Pan left/.test(info.warn), info.warn);
	check('desktop both duplicate fields are highlighted', JSON.stringify(dupRows) === JSON.stringify(['panUp', 'panLeft']), dupRows);
	await p.evaluate(() => document.getElementById('dchat-key-remap')?.scrollIntoView({ block: 'start' }));
	await sleep(120);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-duplicate-warning.png` });
	await p.click('#dchat-key-remap-reset');
	await sleep(150);
	const after = await remapInfo(p);
	check('desktop Reset to defaults restores arrows, clears warning and storage',
		JSON.stringify(after.rows.map((r) => r.keys[0])) === JSON.stringify(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) && !after.warn && (await stored(p, 'gs.controlKeys.v1')) === null,
		after);
	const a = await camState(p);
	await tapKey(p, 'ArrowUp');
	const c = await camState(p);
	check('desktop ArrowUp pans again after reset', dist(a.target, c.target) > 0.15, { a: a.target, c: c.target });
}

// --- Fly + First person lists, persistence across reload
{
	await setMode(p, 'fly');
	let info = await remapInfo(p);
	check('desktop Fly list has 13 actions incl. roll and slow', info.style === 'fly' && info.rows.length === 13 && info.rows.some((r) => r.action === 'slow' && r.keys[0] === 'Shift'), info.rows.map((r) => r.action + ':' + r.keys[0]));
	await focusKey(p, 'fly', 'forward');
	await p.keyboard.press('KeyT');
	await blur(p);
	await p.evaluate(() => document.getElementById('dchat-key-remap')?.scrollIntoView({ block: 'start' }));
	await sleep(120);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-fly-remap.png` });
	await p.reload({ waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.gsKeyBindings);
	await sleep(600);
	await openControls(p);
	info = await remapInfo(p);
	check('desktop Fly mode and remap survive a reload', info.style === 'fly' && info.rows.find((r) => r.action === 'forward')?.keys[0] === 'T', info.rows[0]);
	let a = await camState(p);
	await holdKey(p, 'KeyT', 400);
	let c = await camState(p);
	check('desktop Fly: T moves forward', dist(a.pos, c.pos) > 0.2, { a: a.pos, c: c.pos });
	a = await camState(p);
	await holdKey(p, 'KeyW', 400);
	c = await camState(p);
	check('desktop Fly: W no longer moves', dist(a.pos, c.pos) < 1e-3, { a: a.pos, c: c.pos });
	a = await camState(p);
	await holdKey(p, 'KeyR', 400);
	c = await camState(p);
	check('desktop Fly: unchanged R still moves up', c.pos[1] - a.pos[1] > 0.2, { a: a.pos, c: c.pos });

	await setMode(p, 'firstperson');
	info = await remapInfo(p);
	check('desktop First person shows WASD + arrow alternates', JSON.stringify(info.rows.map((r) => r.keys)) === JSON.stringify([['W', 'ArrowUp'], ['S', 'ArrowDown'], ['A', 'ArrowLeft'], ['D', 'ArrowRight']]), info.rows);
	await focusKey(p, 'firstperson', 'forward', 0);
	await p.keyboard.press('KeyO');
	await blur(p);
	a = await camState(p);
	await holdKey(p, 'KeyO', 400);
	await sleep(300);
	c = await camState(p);
	check('desktop First person: remapped O walks', dist(a.pos, c.pos) > 0.1, { a: a.pos, c: c.pos });
	a = await camState(p);
	await holdKey(p, 'ArrowUp', 400);
	await sleep(300);
	c = await camState(p);
	check('desktop First person: alternate ArrowUp still walks', dist(a.pos, c.pos) > 0.1);
	await p.click('#dchat-key-remap-reset');

	// --- Player height (First person)
	const hInfo = () => p.evaluate(() => ({
		visible: document.getElementById('dchat-player-height').offsetParent !== null,
		value: document.getElementById('dchat-player-height-input').value,
		invalid: document.getElementById('dchat-player-height-input').classList.contains('invalid'),
		y: window.camera.position.y, h: window.gsControls.controls && window.camera.position.y,
		stored: localStorage.getItem('gs.playerHeight'),
		upDisabled: document.getElementById('dchat-player-height-up').disabled,
		downDisabled: document.getElementById('dchat-player-height-down').disabled
	}));
	let h = await hInfo();
	check('desktop First person shows Player height 1.6 m with camera at 1.6', h.visible && h.value === '1.6' && Math.abs(h.y - 1.6) < 1e-6, h);
	await p.evaluate(() => document.getElementById('dchat-player-height')?.scrollIntoView({ block: 'center' }));
	await p.click('#dchat-player-height-input');
	await p.keyboard.type('1.85');
	await p.keyboard.press('Enter');
	await sleep(100);
	h = await hInfo();
	check('desktop typing 1.85 sets the eye height live and saves it', h.value === '1.85' && Math.abs(h.y - 1.85) < 1e-6 && h.stored === '1.85', h);
	await p.click('#dchat-player-height-up');
	await p.click('#dchat-player-height-up');
	await sleep(80);
	h = await hInfo();
	check('desktop ▲ twice → 2.05 m', h.value === '2.05' && Math.abs(h.y - 2.05) < 1e-6, h);
	await p.click('#dchat-player-height-down');
	await sleep(80);
	h = await hInfo();
	check('desktop ▼ → 1.95 m', h.value === '1.95' && Math.abs(h.y - 1.95) < 1e-6, h);
	await p.click('#dchat-player-height-input');
	await p.keyboard.type('abc');
	await sleep(50);
	const bad = await hInfo();
	await p.keyboard.press('Enter');
	await sleep(80);
	h = await hInfo();
	check('desktop invalid text is marked red and put back', bad.invalid && h.value === '1.95' && Math.abs(h.y - 1.95) < 1e-6, { bad, h });
	await p.click('#dchat-player-height-input');
	await p.keyboard.type('9');
	await p.keyboard.press('Enter');
	await sleep(80);
	h = await hInfo();
	check('desktop 9 clamps to 5 m and disables ▲', h.value === '5.0' || h.value === '5', h);
	check('desktop ▲ disabled at max', h.upDisabled && Math.abs(h.y - 5) < 1e-6, h);
	await p.click('#dchat-player-height-input');
	await p.keyboard.type('170cm');
	await p.keyboard.press('Enter');
	await sleep(80);
	h = await hInfo();
	check('desktop "170cm" is understood as 1.7 m', h.value === '1.7' && Math.abs(h.y - 1.7) < 1e-6, h);
	// hold ▼ to repeat
	const box = await (await p.$('#dchat-player-height-down')).boundingBox();
	await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await p.mouse.down();
	await sleep(900);
	await p.mouse.up();
	await sleep(80);
	h = await hInfo();
	check('desktop holding ▼ repeats', parseFloat(h.value) <= 1.3 && parseFloat(h.value) >= 0.3, h);
	await p.click('#dchat-player-height-input');
	await p.keyboard.type('0.1');
	await p.keyboard.press('Enter');
	await sleep(80);
	h = await hInfo();
	check('desktop 0.1 clamps to 0.3 m, ▼ disabled', (h.value === '0.3') && h.downDisabled && Math.abs(h.y - 0.3) < 1e-6, h);
	await p.click('#dchat-player-height-input');
	await p.keyboard.type('1.75');
	await p.keyboard.press('Enter');
	// walking keeps the height
	await holdKey(p, 'KeyW', 400);
	h = await hInfo();
	check('desktop walking keeps the eye height', Math.abs(h.y - 1.75) < 1e-6, h);
	await p.evaluate(() => document.getElementById('dchat-player-height')?.scrollIntoView({ block: 'center' }));
	await sleep(120);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-player-height.png` });
	const ord = await orderInfo(p);
	check('desktop Player height sits directly below the First person keys', ord.style === 'firstperson' && ord.label === 'First person keys' && ord.prevIsKeys && ord.below, ord);
	await p.evaluate(() => { const rows = document.querySelectorAll('#dchat-key-remap .gs-remap-row'); rows[0]?.scrollIntoView({ block: 'start' }); });
	await sleep(120);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-height-below-keys.png` });
	await p.reload({ waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.gsKeyBindings);
	await sleep(600);
	await openControls(p);
	h = await hInfo();
	check('desktop Player height survives a reload (First person at 1.75 m)', h.value === '1.75' && Math.abs(h.y - 1.75) < 1e-6, h);
	await p.evaluate(() => window.gsControls.reset());
	h = await hInfo();
	check('desktop Reset Camera View keeps the player height', Math.abs(h.y - 1.75) < 1e-6, h);
	await p.click('#dchat-player-height-reset');
	h = await hInfo();
	check('desktop height Reset → 1.6 and storage cleared', h.value === '1.6' && h.stored === null && Math.abs(h.y - 1.6) < 1e-6, h);
	await p.click('#dchat-player-height-up');
	await setMode(p, 'off');
	info = await remapInfo(p);
	check('desktop Off has no remap list', info.rows.length === 0);
	await setMode(p, 'map');
}

// --- Custom Controls: empty state, chat-defined scheme
{
	await openControls(p, 'custom');
	const empty = await p.evaluate(() => {
		const e = document.getElementById('gs-cc-empty');
		return e ? { text: e.innerText, visible: e.offsetParent !== null, btn: !!document.getElementById('gs-cc-ask') } : null;
	});
	check('desktop Custom Controls empty state explains asking the chat', empty?.visible && /Ask the chat/.test(empty.text) && empty.btn, empty);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-custom-empty.png` });
	await p.click('#gs-cc-ask');
	await sleep(250);
	const chat = await p.evaluate(() => ({ tab: document.querySelector('.dchat-tab.active')?.dataset.tab, value: document.getElementById('desktop-chat-input').value, focused: document.activeElement?.id }));
	check('desktop "Describe a scheme in chat" opens chat with a starter', chat.tab === 'chat' && /custom control scheme/.test(chat.value) && chat.focused === 'desktop-chat-input', chat);

	await p.evaluate(() => {
		const i = document.getElementById('desktop-chat-input');
		i.value = 'Make a car I can drive with a custom control scheme';
		i.dispatchEvent(new Event('input', { bubbles: true }));
		document.getElementById('desktop-send-button').click();
	});
	await p.waitForFunction(() => window.gsControls.customSchemes.length === 1, { timeout: 15000 }).catch(() => {});
	await sleep(400);
	const desc = await p.evaluate(() => window.gsControls.customSchemes);
	check('desktop stubbed chat reply defines the scheme', desc.length === 1 && desc[0].id === 'car' && desc[0].params.length === 8, desc);
	const mode = await p.evaluate(() => window.gsControls.mode);
	check('desktop scheme cameraMode "off" turns the camera controls off', mode === 'off', mode);
	await openControls(p, 'custom');
	const ui = await p.evaluate(() => {
		const card = document.querySelector('.gs-cc-scheme[data-scheme-id="car"]');
		return card ? {
			title: card.querySelector('.gs-cc-title')?.textContent,
			rows: [...card.querySelectorAll('.gs-cc-param')].map((r) => [r.dataset.param, r.dataset.type, r.querySelector('label')?.textContent]),
			keyVals: [...card.querySelectorAll('.gs-cc-param[data-type="key"] input')].map((i) => i.value),
			range: !!card.querySelector('input[type="range"]'), number: card.querySelector('input.gs-cc-number')?.value,
			toggle: card.querySelector('input.gs-cc-toggle')?.checked, select: card.querySelector('select')?.value,
			badge: document.querySelector('#dchat-controls-subtabs [data-controls-section="custom"]').classList.contains('has-custom'),
			emptyGone: !document.getElementById('gs-cc-empty')
		} : null;
	});
	check('desktop Custom Controls populated with the scheme', ui?.title === 'Car driving' && ui.rows.length === 8 && ui.emptyGone, ui);
	check('desktop key params render as key fields with defaults', JSON.stringify(ui?.keyVals) === JSON.stringify(['W', 'S', 'A', 'D', 'Space']), ui?.keyVals);
	check('desktop number → slider + number, boolean → toggle, select → list', ui?.range && ui.number === '12' && ui.toggle === true && ui.select === 'Chase', ui);
	check('desktop Custom Controls tab marked when a scheme exists', ui?.badge === true);

	const z0 = await p.evaluate(() => scene.getObjectByName('testCar').position.z);
	await holdKey(p, 'KeyW', 500);
	const z1 = await p.evaluate(() => scene.getObjectByName('testCar').position.z);
	check('desktop scheme key W drives the car', z1 < z0 - 0.1, { z0, z1 });

	// remap a custom key
	await openControls(p, 'custom');
	await p.evaluate(() => document.getElementById('gs-cc-car-accelerate').scrollIntoView({ block: 'center' }));
	await p.click('#gs-cc-car-accelerate');
	await p.keyboard.press('KeyI');
	await blur(p);
	await sleep(100);
	const z2 = await p.evaluate(() => scene.getObjectByName('testCar').position.z);
	await holdKey(p, 'KeyW', 400);
	const z3 = await p.evaluate(() => scene.getObjectByName('testCar').position.z);
	await holdKey(p, 'KeyI', 400);
	const z4 = await p.evaluate(() => scene.getObjectByName('testCar').position.z);
	check('desktop remapped custom key: W stops, I drives', Math.abs(z3 - z2) < 1e-3 && z4 < z3 - 0.1, { z2, z3, z4 });

	// slider / toggle / select live-update the handle
	await p.evaluate(() => {
		const r = document.querySelector('#gs-cc-car-topSpeed');
		r.value = '30'; r.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await p.click('#gs-cc-car-autoBrake');
	await p.select('#gs-cc-car-view', 'Top');
	await sleep(120);
	const live = await p.evaluate(() => ({ values: gsControls.getCustomScheme('car').values, log: window.__carLog.changes, num: document.querySelector('.gs-cc-number').value }));
	check('desktop slider updates the scheme value live', live.values.topSpeed === 30 && live.num === '30', live);
	check('desktop toggle and select update live', live.values.autoBrake === false && live.values.view === 'Top', live.values);
	check('desktop onChange fired for each change', JSON.stringify(live.log) === JSON.stringify([['accelerate', 'KeyI'], ['topSpeed', 30], ['autoBrake', false], ['view', 'Top']]), live.log);
	await holdKey(p, 'Space', 80);
	check('desktop onPress fires for the Horn key', (await p.evaluate(() => window.__carLog.horns)) === 1);

	// duplicate warning in custom
	await p.click('#gs-cc-car-brake');
	await p.keyboard.press('KeyI');
	await blur(p);
	await sleep(120);
	const warn = await p.evaluate(() => ({ text: document.querySelector('.gs-cc-warning')?.textContent || '', dups: document.querySelectorAll('.gs-cc-scheme input.duplicate').length }));
	check('desktop custom duplicate warning', /I is used by Accelerate and Brake \/ reverse/.test(warn.text) && warn.dups === 2, warn);
	const persisted = await stored(p, 'gs.customControls.v1');
	check('desktop custom values saved per scheme in localStorage', persisted?.car?.accelerate === 'KeyI' && persisted.car.topSpeed === 30 && persisted.car.view === 'Top', persisted);
	await p.evaluate(() => document.querySelector('.gs-cc-scheme')?.scrollIntoView({ block: 'start' }));
	await sleep(120);
	await p.screenshot({ path: `${SHOT_DIR}/desktop-custom-populated.png` });

	// hot re-define keeps values
	await p.evaluate(() => gsControls.defineCustomScheme({ id: 'car', name: 'Car driving v2', params: [{ name: 'accelerate', type: 'key', default: 'W' }, { name: 'topSpeed', type: 'number', default: 5, min: 1, max: 40 }] }));
	await sleep(100);
	const re = await p.evaluate(() => ({ v: gsControls.getCustomScheme('car').values, rows: document.querySelectorAll('.gs-cc-param').length, title: document.querySelector('.gs-cc-title').textContent }));
	check('desktop re-defining the same id keeps user values and re-renders', re.v.accelerate === 'KeyI' && re.v.topSpeed === 30 && re.rows === 2 && re.title === 'Car driving v2', re);
	// bad definitions throw clearly
	const err = await p.evaluate(() => { try { gsControls.defineCustomScheme({ id: 'x', params: [{ name: 'k', type: 'key', default: 'NotAKey' }] }); return 'no error'; } catch (e) { return e.message; } });
	check('desktop invalid key default is rejected with a clear error', /not a key name/.test(err), err);

	// reset to defaults
	await p.click('.gs-cc-reset');
	await sleep(100);
	const rv = await p.evaluate(() => gsControls.getCustomScheme('car').values);
	check('desktop custom Reset to defaults', rv.accelerate === 'KeyW' && rv.topSpeed === 5, rv);

	// clearing the scene removes the scheme and restores the camera mode
	await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="scenes"]')?.click());
	await sleep(200);
	await p.evaluate(() => document.querySelector('[data-action="scenes:clear"]')?.click());
	await sleep(300);
	await p.evaluate(() => document.querySelector('#gs-dialog .gs-dialog-ok')?.click());
	await sleep(400);
	const cleared = await p.evaluate(() => ({ n: gsControls.customSchemes.length, mode: gsControls.mode, empty: !!document.getElementById('gs-cc-empty') }));
	check('desktop Clear scene removes the scheme, restores Map, shows empty state', cleared.n === 0 && cleared.mode === 'map' && cleared.empty, cleared);
	check('desktop no console errors', p._errors.length === 0, p._errors);
}
await p.close();

// --- scene file carries changed custom values
{
	const p2 = await openPage(ctx, { width: 1280, height: 800 });
	await p2.evaluate(() => localStorage.removeItem('gs.customControls.v1'));
	const fileOk = await p2.evaluate(async (code) => {
		const data = { version: 1, name: 'cc', codeBlocks: [code], customControls: { car: { topSpeed: 21, view: 'Hood' } } };
		const f = new File([JSON.stringify(data)], 'cc.vrscene.json', { type: 'application/json' });
		const input = document.querySelector('input[type="file"][accept*="vrscene"], #scene-file-input');
		if (!input) return 'no input';
		const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
		for (let i = 0; i < 50 && !gsControls.getCustomScheme('car'); i++) await new Promise((r) => setTimeout(r, 100));
		const h = gsControls.getCustomScheme('car');
		return h ? h.values : 'no scheme';
	}, SCHEME_CODE);
	check('desktop loading a scene file applies its saved custom values', fileOk?.topSpeed === 21 && fileOk.view === 'Hood' && fileOk.accelerate === 'KeyW', fileOk);
	await p2.close();
}

// ======================================================================= phone
{
	const pctx = await b.createBrowserContext();
	const ph = await openPage(pctx, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, { mobile: true });
	await openControls(ph);
	await setMode(ph, 'fly');
	const lay = await ph.evaluate(() => {
		const panel = document.getElementById('dchat-controls');
		const pr = panel.getBoundingClientRect();
		const inputs = [...document.querySelectorAll('#dchat-key-remap input.gs-key-input')];
		const tabs = [...document.querySelectorAll('#dchat-controls-subtabs .dchat-subtab')].map((t) => t.getBoundingClientRect());
		const nav = document.getElementById('gs-menu-nav') || document.querySelector('.dchat-tabs');
		const navBtns = nav ? [...nav.querySelectorAll('button')].filter((x) => x.offsetParent).map((x) => Math.round(x.getBoundingClientRect().top)) : [];
		return {
			overflowX: panel.scrollWidth - panel.clientWidth,
			minH: Math.min(...inputs.map((i) => i.getBoundingClientRect().height)),
			outside: inputs.filter((i) => { const r = i.getBoundingClientRect(); return r.right > pr.right + 1 || r.left < pr.left - 1; }).length,
			tabsH: Math.min(...tabs.map((t) => t.height)), tabsRow: new Set(tabs.map((t) => Math.round(t.top))).size,
			headerRows: new Set(navBtns).size
		};
	});
	check('phone remap list has no horizontal overflow', lay.overflowX <= 1 && lay.outside === 0, lay);
	check('phone key fields and sub-tabs are ≥44px', lay.minH >= 44 && lay.tabsH >= 44, lay);
	const clipped = await ph.evaluate(() => [...document.querySelectorAll('#dchat-key-remap input.gs-key-input')].filter((i) => i.scrollWidth > i.clientWidth + 1).map((i) => i.value));
	check('phone key names fit their fields (ArrowRight not clipped)', clipped.length === 0, clipped);
	check('phone sub-tabs on one row; header buttons on one row', lay.tabsRow === 1 && lay.headerRows <= 1, lay);
	await ph.evaluate(() => document.getElementById('dchat-key-remap')?.scrollIntoView({ block: 'start' }));
	await sleep(150);
	await ph.screenshot({ path: `${SHOT_DIR}/phone-fly-remap.png` });
	await ph.evaluate(() => { gsKeyBindings.setKey('fly', 'back', 0, 'KeyW'); document.getElementById('dchat-key-remap-warning')?.scrollIntoView({ block: 'center' }); });
	await sleep(150);
	const pw = await ph.evaluate(() => document.getElementById('dchat-key-remap-warning').textContent);
	check('phone duplicate warning shows', /W is used by Move forward and Move back/.test(pw), pw);
	await ph.screenshot({ path: `${SHOT_DIR}/phone-duplicate-warning.png` });
	await ph.evaluate(() => gsKeyBindings.resetStyle('fly'));
	await setMode(ph, 'firstperson');
	await ph.evaluate(() => document.getElementById('dchat-player-height')?.scrollIntoView({ block: 'center' }));
	await sleep(150);
	const hl = await ph.evaluate(() => {
		const r = (id) => document.getElementById(id).getBoundingClientRect();
		const panel = document.getElementById('dchat-controls').getBoundingClientRect();
		const ids = ['dchat-player-height-input', 'dchat-player-height-up', 'dchat-player-height-down', 'dchat-player-height-reset'];
		return { h: ids.map((i) => Math.round(r(i).height)), w: ids.map((i) => Math.round(r(i).width)), out: ids.filter((i) => r(i).right > panel.right + 1), row: new Set(ids.map((i) => Math.round(r(i).top + r(i).height / 2))).size };
	});
	check('phone Player height controls ≥44px, one row, inside the panel', hl.h.every((x) => x >= 44) && hl.w.slice(1, 3).every((x) => x >= 44) && hl.out.length === 0 && hl.row === 1, hl);
	await ph.tap('#dchat-player-height-up');
	await sleep(80);
	const py = await ph.evaluate(() => [document.getElementById('dchat-player-height-input').value, window.camera.position.y]);
	check('phone ▲ tap raises the eye height', py[0] === '1.7' && Math.abs(py[1] - 1.7) < 1e-6, py);
	await ph.screenshot({ path: `${SHOT_DIR}/phone-player-height.png` });
	const pord = await orderInfo(ph);
	check('phone Player height sits directly below the First person keys', pord.style === 'firstperson' && pord.prevIsKeys && pord.below, pord);
	await ph.evaluate(() => { const rows = document.querySelectorAll('#dchat-key-remap .gs-remap-row'); rows[rows.length - 1]?.scrollIntoView({ block: 'start' }); });
	await sleep(150);
	await ph.screenshot({ path: `${SHOT_DIR}/phone-height-below-keys.png` });
	await setMode(ph, 'map');
	await openControls(ph, 'custom');
	await ph.screenshot({ path: `${SHOT_DIR}/phone-custom-empty.png` });
	await ph.evaluate((code) => window.gsSelectTab('chat'), SCHEME_CODE);
	await ph.evaluate(() => {
		const i = document.getElementById('desktop-chat-input');
		i.value = 'car controls'; i.dispatchEvent(new Event('input', { bubbles: true }));
		document.getElementById('desktop-send-button').click();
	});
	await ph.waitForFunction(() => window.gsControls.customSchemes.length === 1, { timeout: 15000 }).catch(() => {});
	await openControls(ph, 'custom');
	const cl = await ph.evaluate(() => {
		const panel = document.getElementById('dchat-controls');
		const pr = panel.getBoundingClientRect();
		const ctrls = [...document.querySelectorAll('.gs-cc-scheme input, .gs-cc-scheme select, .gs-cc-scheme button')].filter((e) => e.type !== 'checkbox');
		return {
			rows: document.querySelectorAll('.gs-cc-param').length,
			overflowX: panel.scrollWidth - panel.clientWidth,
			outside: ctrls.filter((e) => { const r = e.getBoundingClientRect(); return r.right > pr.right + 1; }).map((e) => e.id || e.className),
			minH: Math.min(...ctrls.map((e) => e.getBoundingClientRect().height)),
			toggleBox: document.querySelector('.gs-cc-param[data-type="boolean"] .gs-remap-keys').getBoundingClientRect().height
		};
	});
	check('phone Custom Controls populated from the stubbed chat', cl.rows === 8, cl);
	check('phone Custom Controls fits the width', cl.overflowX <= 1 && cl.outside.length === 0, cl);
	check('phone Custom Controls touch targets ≥44px', cl.minH >= 44 && cl.toggleBox >= 44, cl);
	await ph.evaluate(() => document.querySelector('.gs-cc-scheme')?.scrollIntoView({ block: 'start' }));
	await sleep(150);
	await ph.screenshot({ path: `${SHOT_DIR}/phone-custom-populated.png` });
	check('phone no console errors', ph._errors.length === 0, ph._errors);
	await pctx.close();
}

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
