// AI-described controls (Controls → "Describe a control", aiControls.js):
// describe box, AI request context, preview card, apply / toggle / edit /
// delete, persistence (localStorage per mode, scene file for Custom Controls),
// conflicts, error cases, runtime (keyboard, mocked gamepad, IWER Quest 3
// two-hand grip zoom), typing never triggers controls, phone and VR menu.
//   BASE=https://localhost:4417 SHOT_DIR=/workspace/gs-ai-controls-shots node test.mjs   (SKIP_VR=1 skips IWER)
// /api/chat is stubbed with canned definitions (never a real AI); dummy keys;
// every other non-GET /api call is blocked, so nothing reaches KV / Blob.
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:4417';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-ai-controls-shots';
const SKIP_VR = process.env.SKIP_VR === '1';
const ONLY_VR = process.env.ONLY_VR === '1';
const UI_ONLY = process.env.UI_ONLY === '1'; // dev check: no stub, only the UI (generation result is reported, not asserted)
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const dist = (a, c) => Math.hypot(...a.map((v, i) => v - c[i]));

const PAD_MOCK = `(() => {
  const mk = () => ({ pressed: false, touched: false, value: 0 });
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, mk), timestamp: 0, vibrationActuator: null };
  window.__pad = {
    pad, on: true,
    set({ axes, press } = {}) {
      if (axes) pad.axes = axes.slice();
      if (press) for (const [i, v] of Object.entries(press)) pad.buttons[+i] = { pressed: v > 0.5, touched: v > 0, value: v };
      pad.timestamp = performance.now();
    },
    clear() { pad.axes = [0, 0, 0, 0]; pad.buttons = Array.from({ length: 17 }, mk); }
  };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [window.__pad.on ? pad : null, null, null, null] });
})();`;
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, View: 8, Menu: 9, LS: 10, RS: 11, Up: 12, Down: 13, Left: 14, Right: 15 };

// ---- canned AI replies (keyed by words in the description) ----
const F = 'gs-control/1';
export const DEFS = {
	grip: { format: F, name: 'Two-hand grip zoom', summary: 'Hold both grips; moving your hands apart zooms in, bringing them together zooms out.', when: [{ input: 'xr:L-Squeeze', is: 'held' }, { input: 'xr:R-Squeeze', is: 'held' }], bindings: [{ source: 'xr:handDistance', action: 'zoom', sensitivity: 1, deadzone: 0.01, smoothing: 0.3 }] },
	lb: { format: F, name: 'LB + right stick orbit', summary: 'While LB is held, the right stick orbits the camera.', when: [{ input: 'pad:LB', is: 'held' }], bindings: [{ source: 'pad:RS-X', action: 'rotate.yaw' }, { source: 'pad:RS-Y', action: 'rotate.pitch', invert: true }] },
	q: { format: F, name: 'Q / E zoom', summary: 'Hold Q to zoom in and E to zoom out.', when: [], bindings: [{ source: 'key:KeyQ', action: 'zoom' }, { source: 'key:KeyE', action: 'zoom', invert: true }] },
	q2: { format: F, name: 'Q zoom (faster)', summary: 'Hold Q to zoom in quickly.', when: [], bindings: [{ source: 'key:KeyQ', action: 'zoom', sensitivity: 2 }] },
	param: { format: F, name: 'Throttle', summary: 'The right trigger sets the scene\'s throttle value.', bindings: [{ source: 'pad:RT', action: 'param:throttle', paramMode: 'set' }] },
	unsupported: { format: F, name: 'Eye zoom', summary: 'Look to zoom.', bindings: [{ source: 'xr:EyeGaze', action: 'zoom' }] },
	impossible: { format: F, error: 'GS has no eye tracking input.' }
};
function cannedReply(desc) {
	const d = desc.toLowerCase();
	if (d.includes('unavailable')) return { status: 503, body: { error: 'Server API key not configured for claude' } };
	if (d.includes('gibberish')) return { status: 200, text: 'Sure! I made that control for you. Have fun!' };
	if (d.includes('eye gaze')) return { status: 200, text: '```json\n' + JSON.stringify(DEFS.unsupported) + '\n```' };
	if (d.includes('blink')) return { status: 200, text: JSON.stringify(DEFS.impossible) };
	const key = d.includes('grip') ? 'grip' : d.includes('lb') ? 'lb' : d.includes('faster') ? 'q2' : d.includes('hold q') ? 'q' : d.includes('throttle') ? 'param' : 'q';
	return { status: 200, text: 'Here is the control:\n```json\n' + JSON.stringify(DEFS[key], null, 1) + '\n```' };
}

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.createBrowserContext();
const requests = [];

async function openPage(viewport, { mobile = false, xr = false, fresh = true } = {}) {
	const p = await ctx.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Speech error|\b503\b/.test(m.text())) errors.push('console: ' + m.text()); });
	if (mobile) await p.setUserAgent(PHONE_UA);
	await p.setViewport(viewport);
	await p.evaluateOnNewDocument(PAD_MOCK);
	if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	if (!UI_ONLY) {
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const u = new URL(req.url());
			if (u.pathname.startsWith('/api/')) {
				if (u.pathname === '/api/chat') {
					let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* */ }
					requests.push(body);
					const user = body.messages?.[body.messages.length - 1]?.content || '';
					const m = String(user).match(/definition: "([\s\S]*?)"\n/);
					const r = cannedReply(m ? m[1] : String(user));
					if (r.body) return req.respond({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
					return req.respond({ status: r.status, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: r.text }] }) });
				}
				if (u.pathname === '/api/prompts') return req.continue();
				if (req.method() !== 'GET') return req.respond({ status: 503, body: 'blocked' });
				const body = u.pathname === '/api/backends' ? '{"backends":{"claude":{"label":"Claude","provider":"claude","available":true}},"default":"claude"}'
					: (u.pathname.startsWith('/api/community-scenes') ? '{"scenes":[]}' : '{}');
				return req.respond({ status: 200, contentType: 'application/json', body });
			}
			req.continue();
		});
	}
	await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.renderer && window.gsAiControls && window.gsControls?.aiValue && document.getElementById('gs-menu-hamburger'), { timeout: 30000 });
	if (fresh) await p.evaluate(() => { localStorage.removeItem('gs.aiControls.v1'); window.gsAiControls.reload(); });
	await sleep(600);
	p._errors = errors;
	return p;
}
async function openControls(p, section = 'camera') {
	await p.evaluate(() => { const c = document.getElementById('desktop-chat'); if (!c?.classList.contains('gs-tab-menu-open')) document.getElementById('gs-menu-hamburger')?.click(); });
	await sleep(200);
	await p.evaluate(() => window.gsSelectTab('controls'));
	await sleep(250);
	await p.evaluate((s) => document.querySelector(`#dchat-controls-subtabs [data-controls-section="${s}"]`)?.click(), section);
	await sleep(200);
}
const setMode = async (p, m) => { await p.evaluate((m) => gsControls.setMode(m), m); await sleep(250); };
const pad = (p, o) => p.evaluate((o) => window.__pad.set(o), o);
const padClear = (p) => p.evaluate(() => window.__pad.clear());
const cam = (p) => p.evaluate(() => ({ pos: camera.position.toArray(), q: camera.quaternion.toArray(), target: gsControls.controls?.target?.toArray() || null }));
const camDist = (c) => dist(c.pos, c.target);
const P = (scope) => (scope === 'scene' ? '#dchat-ai-controls-scene' : '#dchat-ai-controls');
async function describe(p, text, scope = 'mode') {
	const root = P(scope);
	await p.evaluate((r) => document.querySelector(`${r} .gs-ai-input`).scrollIntoView({ block: 'center' }), root);
	await p.click(`${root} .gs-ai-input`, { clickCount: 3 });
	await p.keyboard.press('Backspace');
	await p.type(`${root} .gs-ai-input`, text, { delay: 2 });
	await p.click(`${root} .gs-ai-generate`);
	await p.waitForFunction((r) => { const s = document.querySelector(`${r} .gs-ai-status`); return !document.querySelector(`${r} .gs-ai-preview`).hidden || (s && s.dataset.kind && s.dataset.kind !== 'busy'); }, { timeout: 20000 }, root).catch(() => {});
	await sleep(150);
}
const panelState = (p, scope = 'mode') => p.evaluate((r) => {
	const el = document.querySelector(r);
	const pv = el.querySelector('.gs-ai-preview');
	return {
		status: el.querySelector('.gs-ai-status').textContent, kind: el.querySelector('.gs-ai-status').dataset.kind || '',
		preview: pv.hidden ? null : { title: pv.querySelector('.gs-ai-preview-title')?.textContent, summary: pv.querySelector('.gs-ai-preview-summary')?.textContent, how: pv.querySelector('.gs-ai-preview-how')?.textContent, inputs: [...pv.querySelectorAll('.gs-ai-chip')].map((c) => c.dataset.input), conflicts: pv.querySelector('.gs-ai-preview-conflicts')?.textContent, hasConflicts: pv.querySelector('.gs-ai-preview-conflicts')?.classList.contains('has-conflicts') },
		rows: [...el.querySelectorAll('.gs-ai-row')].map((r) => ({ id: r.dataset.aiId, name: r.querySelector('.gs-ai-row-name').textContent, desc: r.querySelector('.gs-ai-row-desc').textContent, on: r.querySelector('.gs-ai-toggle').checked, off: r.classList.contains('off'), badge: !!r.querySelector('.gs-ai-badge'), conflicts: r.querySelector('.gs-ai-row-conflicts')?.textContent || '' })),
		input: el.querySelector('.gs-ai-input').value, scope: el.dataset.scope, formHidden: el.querySelector('.gs-ai-form').hidden, note: el.querySelector('.gs-ai-note').hidden ? '' : el.querySelector('.gs-ai-note').textContent
	};
}, P(scope));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('gs.aiControls.v1') || 'null'));
// Screenshot of the menu window only (sharper: desktop pages use deviceScaleFactor 2).
async function shot(p, name) {
	const r = await p.evaluate(() => { const b = document.getElementById('desktop-chat').getBoundingClientRect(); return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: Math.min(innerWidth, b.width + 16), height: Math.min(innerHeight, b.height + 16) }; });
	await p.screenshot({ path: `${SHOT_DIR}/${name}.png`, clip: r });
}

if (UI_ONLY) {
	// ---------------------------------------------- dev: UI only (no stub)
	const p = await openPage({ width: 1280, height: 860, deviceScaleFactor: 2 });
	await setMode(p, 'map');
	await openControls(p, 'camera');
	const st0 = await panelState(p);
	check('dev: Map shows the AI-described controls panel with the describe box', st0.scope === 'map' && !st0.formHidden, st0);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await shot(p, "dev-describe-box");
	await describe(p, 'In VR Map, hold both grips and spread hands to zoom in, pinch to zoom out');
	const st = await panelState(p);
	console.log('INFO dev generation result:', JSON.stringify({ status: st.status, kind: st.kind, preview: st.preview }));
	check('dev: generating shows a preview or a clear error, nothing applied on error', st.preview ? true : (st.kind === 'error' && st.rows.length === 0), st);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await shot(p, "dev-generate-result");
	const ph = await openPage({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { mobile: true });
	await setMode(ph, 'map');
	await openControls(ph, 'camera');
	await ph.evaluate(() => document.querySelector('#dchat-ai-controls').scrollIntoView({ block: 'start' }));
	await sleep(300);
	await ph.screenshot({ path: `${SHOT_DIR}/dev-phone.png` });
	const fit = await ph.evaluate(() => { const r = document.querySelector('#dchat-ai-controls').getBoundingClientRect(); return { w: r.width, right: r.right, vw: innerWidth }; });
	check('dev phone: the panel fits the screen width', fit.right <= fit.vw + 1, fit);
	console.log(`\n${pass} passed, ${fail} failed`);
	await b.close();
	process.exit(fail ? 1 : 0);
}

// ======================================================= desktop
if (!ONLY_VR) {
	const p = await openPage({ width: 1280, height: 900, deviceScaleFactor: 2 });
	await setMode(p, 'map');
	await openControls(p, 'camera');
	let st = await panelState(p);
	check('Map: "Describe a control" box shown for the selected mode, no AI rows yet', st.scope === 'map' && !st.formHidden && st.rows.length === 0, st);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await shot(p, 'desktop-describe-box');

	// typing in the box never moves the camera (and its keys don't reach controls)
	await p.click('#dchat-ai-controls .gs-ai-input');
	const c0 = await cam(p);
	await p.keyboard.down('ArrowUp'); await sleep(400); await p.keyboard.up('ArrowUp');
	await p.type('#dchat-ai-controls .gs-ai-input', 'wasd qe ', { delay: 10 });
	await sleep(300);
	const c1 = await cam(p);
	check('typing in the describe box (arrows, W/A/S/D, Q/E) does not move the camera', dist(c0.pos, c1.pos) < 1e-4, { c0, c1 });

	// grip zoom description → request context → preview
	requests.length = 0;
	await describe(p, 'In VR Map, hold both grips and spread hands to zoom in, pinch to zoom out');
	const req = requests[0] || {};
	const user = req.messages?.[0]?.content || '';
	check('request goes to /api/chat with its own system prompt (format, no code), the description, the mode and its current bindings', /gs-control\/1/.test(req.systemPrompt || '') && /Do NOT write any JavaScript/.test(req.systemPrompt || '') && /spread hands to zoom in/.test(user) && /Camera mode: Map/.test(user) && /panUp/.test(user) && /R-Squeeze/.test(user) && req.backend === 'claude', { sys: (req.systemPrompt || '').slice(0, 80), user: user.slice(0, 300), backend: req.backend });
	st = await panelState(p);
	check('preview card: name, summary, what it understood, inputs', st.preview && /Two-hand grip zoom/.test(st.preview.title) && /hands apart zooms in/.test(st.preview.summary) && /While you hold VR L grip and hold VR R grip/.test(st.preview.how) && /distance between your hands: apart → zoom in, together → zoom out/.test(st.preview.how) && st.preview.inputs.join() === 'xr:L-Squeeze,xr:R-Squeeze,xr:handDistance', st.preview);
	check('preview card lists the conflict: R grip is GS\'s locomotion cycle', st.preview?.hasConflicts && /VR R grip: GS: cycles VR locomotion/.test(st.preview.conflicts), st.preview?.conflicts);
	check('nothing applied before Apply', st.rows.length === 0 && (await stored(p)) === null);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls .gs-ai-preview').scrollIntoView({ block: 'center' }));
	await sleep(200);
	await shot(p, 'desktop-preview-card');
	// Cancel → nothing; regenerate → Apply
	await p.click('#dchat-ai-controls .gs-ai-cancel'); await sleep(150);
	st = await panelState(p);
	check('Cancel closes the preview and applies nothing', !st.preview && st.rows.length === 0 && /Nothing was applied/.test(st.status), st);
	await describe(p, 'In VR Map, hold both grips and spread hands to zoom in, pinch to zoom out');
	await p.click('#dchat-ai-controls .gs-ai-apply'); await sleep(200);
	st = await panelState(p);
	const s1 = await stored(p);
	check('Apply adds an AI-described row with the original description, on', st.rows.length === 1 && st.rows[0].badge && st.rows[0].name === 'Two-hand grip zoom' && /hold both grips and spread hands/.test(st.rows[0].desc) && st.rows[0].on && !st.preview, st.rows);
	check('stored per mode in localStorage gs.aiControls.v1 (map)', s1?.modes?.map?.length === 1 && s1.modes.map[0].def.bindings[0].source === 'xr:handDistance' && !s1.modes.fly, s1);

	// hold Q / E zoom (keyboard runtime)
	await describe(p, 'hold Q to zoom in, E to zoom out');
	st = await panelState(p);
	check('Q/E preview: no conflicts with Map\'s keys', st.preview && !st.preview.hasConflicts && /No conflicts/.test(st.preview.conflicts), st.preview);
	await p.click('#dchat-ai-controls .gs-ai-apply'); await sleep(200);
	await p.evaluate(() => { document.activeElement?.blur?.(); });
	await p.mouse.move(640, 450);
	let a = await cam(p);
	await p.keyboard.down('KeyQ'); await sleep(700); await p.keyboard.up('KeyQ'); await sleep(300);
	let c = await cam(p);
	check('runtime (keyboard): holding Q zooms the Map camera in', camDist(c) < camDist(a) * 0.8, { before: camDist(a), after: camDist(c) });
	a = c;
	await p.keyboard.down('KeyE'); await sleep(700); await p.keyboard.up('KeyE'); await sleep(300);
	c = await cam(p);
	check('runtime (keyboard): holding E zooms out', camDist(c) > camDist(a) * 1.2, { before: camDist(a), after: camDist(c) });
	await p.evaluate(() => document.querySelector('#dchat-ai-controls').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await shot(p, 'desktop-applied-rows');

	// toggle off → Q does nothing; on again
	const qId = (await panelState(p)).rows[1].id;
	await p.click(`#dchat-ai-controls .gs-ai-row[data-ai-id="${qId}"] .gs-ai-toggle`); await sleep(200);
	await p.evaluate(() => document.activeElement?.blur?.());
	a = await cam(p);
	await p.keyboard.down('KeyQ'); await sleep(500); await p.keyboard.up('KeyQ'); await sleep(200);
	c = await cam(p);
	st = await panelState(p);
	check('toggle off: row greyed, stored off, Q no longer zooms', st.rows[1].off && !st.rows[1].on && (await stored(p)).modes.map[1].enabled === false && Math.abs(camDist(c) - camDist(a)) < 1e-3, { st: st.rows[1], d: [camDist(a), camDist(c)] });
	await p.click(`#dchat-ai-controls .gs-ai-row[data-ai-id="${qId}"] .gs-ai-toggle`); await sleep(150);

	// edit + regenerate replaces the same row
	await p.click(`#dchat-ai-controls .gs-ai-row[data-ai-id="${qId}"] .gs-ai-row-edit`); await sleep(150);
	st = await panelState(p);
	check('Edit puts the description back in the box (regenerate mode)', st.input === 'hold Q to zoom in, E to zoom out' && (await p.$eval('#dchat-ai-controls .gs-ai-generate', (e) => e.textContent)) === 'Regenerate control', st.input);
	await describe(p, 'hold Q to zoom in, faster');
	st = await panelState(p);
	check('regenerated preview says "Updated control"', /Updated control: Q zoom \(faster\)/.test(st.preview?.title || ''), st.preview);
	await p.click('#dchat-ai-controls .gs-ai-apply'); await sleep(200);
	st = await panelState(p);
	check('Apply changes replaces that row in place (same id, new description and definition)', st.rows.length === 2 && st.rows[1].id === qId && st.rows[1].name === 'Q zoom (faster)' && /faster/.test(st.rows[1].desc), st.rows);

	// LB + right stick (gamepad runtime) with conflicts
	await describe(p, 'Gamepad: hold LB and move right stick to orbit');
	st = await panelState(p);
	check('LB preview: right stick conflicts with Map\'s rotate rows', st.preview?.hasConflicts && /Map: Rotate left/.test(st.preview.conflicts), st.preview?.conflicts);
	await p.click('#dchat-ai-controls .gs-ai-apply'); await sleep(200);
	await p.evaluate(() => document.activeElement?.blur?.());
	await pad(p, { press: { [B.A]: 1 } }); await sleep(150); await padClear(p); await sleep(300);
	a = await cam(p);
	await pad(p, { press: { [B.LB]: 1 }, axes: [0, 0, 1, 0] }); await sleep(600);
	await padClear(p); await sleep(900);
	c = await cam(p);
	const qa = await p.evaluate((x, y) => new THREE.Quaternion().fromArray(x).angleTo(new THREE.Quaternion().fromArray(y)), a.q, c.q);
	check('runtime (gamepad): LB held + right stick orbits the Map camera', qa > 0.3, qa);

	// errors: nothing applied
	const nRows = (await panelState(p)).rows.length;
	for (const [text, re, name] of [
		['make it unavailable please', /AI is unavailable.*Server API key not configured/, 'AI unavailable (503)'],
		['gibberish control', /not valid JSON/, 'invalid JSON reply'],
		['zoom with eye gaze', /Unsupported input "xr:EyeGaze"/, 'unsupported input'],
		['blink to zoom', /could not turn that into a control: GS has no eye tracking/, 'AI says it cannot']
	]) {
		await describe(p, text);
		st = await panelState(p);
		check(`error (${name}): clear message, no preview, nothing applied`, st.kind === 'error' && re.test(st.status) && /Nothing was applied|nothing was applied/.test(st.status) && !st.preview && st.rows.length === nRows, { status: st.status, rows: st.rows.length });
	}
	await p.evaluate(() => document.querySelector('#dchat-ai-controls .gs-ai-status').scrollIntoView({ block: 'center' }));
	await sleep(150);
	await shot(p, 'desktop-error');

	// per mode: Fly has its own (empty) list; Off / custom show a note
	await setMode(p, 'fly');
	st = await panelState(p);
	check('per mode: Fly has its own empty list', st.scope === 'fly' && st.rows.length === 0, st);
	await setMode(p, 'off');
	st = await panelState(p);
	check('Off: no describe box, a note instead', st.formHidden && /Pick Orbit, Map, Fly or First person/.test(st.note), st);
	await setMode(p, 'map');

	// reload keeps them
	await p.reload({ waitUntil: 'networkidle2' });
	await p.waitForFunction(() => window.gsAiControls, { timeout: 30000 });
	await sleep(500);
	await setMode(p, 'map');
	await openControls(p, 'camera');
	st = await panelState(p);
	check('reload keeps the Map AI controls (with on/off state)', st.rows.length === 3 && st.rows.map((r) => r.name).join('|') === 'Two-hand grip zoom|Q zoom (faster)|LB + right stick orbit', st.rows);
	// delete
	await p.click(`#dchat-ai-controls .gs-ai-row[data-ai-id="${qId}"] .gs-ai-delete`); await sleep(200);
	st = await panelState(p);
	check('Delete removes the row and the stored copy', st.rows.length === 2 && !st.rows.some((r) => r.id === qId) && (await stored(p)).modes.map.length === 2, st.rows);
	// tampered storage (code in a definition) is dropped on load
	await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('gs.aiControls.v1')); s.modes.map.push({ id: 'evil1234', description: 'x', def: { bindings: [{ source: 'js:alert(1)', action: 'zoom' }] } }); localStorage.setItem('gs.aiControls.v1', JSON.stringify(s)); gsAiControls.reload(); });
	await sleep(200);
	check('invalid stored definitions are dropped (validated on load)', (await panelState(p)).rows.length === 2);

	// ------------------------------------------------ Custom Controls: per scene, in the scene file
	await openControls(p, 'custom');
	st = await panelState(p, 'scene');
	check('Custom Controls: scene describe box', st.scope === 'scene' && !st.formHidden && st.rows.length === 0, st);
	requests.length = 0;
	await describe(p, 'Gamepad right trigger sets the throttle', 'scene');
	const sreq = requests[0]?.messages?.[0]?.content || '';
	check('scene request says it is a control for this scene', /a control for this scene/.test(sreq), sreq.slice(0, 200));
	await p.click('#dchat-ai-controls-scene .gs-ai-apply'); await sleep(200);
	st = await panelState(p, 'scene');
	check('scene AI control applied (row in Custom Controls)', st.rows.length === 1 && st.rows[0].name === 'Throttle', st.rows);
	await p.evaluate(() => { window.__thr = []; gsControls.onAiValue('throttle', (v) => window.__thr.push(v)); });
	await pad(p, { press: { [B.RT]: 0.6 } }); await sleep(300); await padClear(p); await sleep(200);
	const thr = await p.evaluate(() => ({ v: gsControls.aiValue('throttle'), seen: window.__thr.slice() }));
	check('scene value: RT sets gsControls.aiValue("throttle") and onAiValue fires', thr.seen.some((x) => Math.abs(x - 0.6) < 0.02), thr);
	const sceneData = await p.evaluate(() => window.gsSceneFileForTest.build('t'));
	check('scene file (buildSceneData) gets aiControls with the validated definition', sceneData.aiControls?.length === 1 && sceneData.aiControls[0].def.bindings[0].action === 'param:throttle' && /throttle/.test(sceneData.aiControls[0].description), sceneData.aiControls);
	check('scene AI controls are not in the per-mode browser storage', !JSON.stringify(await stored(p)).includes('throttle'));
	await p.evaluate(() => document.querySelector('#dchat-ai-controls-scene').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await shot(p, 'desktop-custom-controls-scene');
	// load a scene file with aiControls (and an invalid one) → restored; loading another scene clears
	const loaded = await p.evaluate(async (grip) => {
		await window.gsSceneFileForTest.load({ version: 1, name: 'AI scene', codeBlocks: [], aiControls: [{ id: 'scn12345', description: 'grip zoom here', enabled: true, def: grip }, { id: 'bad12345', description: 'bad', def: { bindings: [{ source: 'x', action: 'y' }] } }] });
		return gsAiControls.list('scene').map((c) => c.def.name);
	}, DEFS.grip);
	check('loading a scene file restores its AI controls (invalid ones dropped)', loaded.join() === 'Two-hand grip zoom', loaded);
	await p.evaluate(async () => { await window.gsSceneFileForTest.load({ version: 1, name: 'Other', codeBlocks: [] }); });
	check('loading another scene clears the previous scene\'s AI controls; Map ones stay', (await p.evaluate(() => gsAiControls.list('scene').length)) === 0 && (await p.evaluate(() => gsAiControls.list('map').length)) === 2);
	const errs = p._errors;
	check('desktop: no console errors', errs.length === 0, errs);
	await p.close();
}

// ======================================================= phone
if (!ONLY_VR) {
	const p = await openPage({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { mobile: true });
	await setMode(p, 'map');
	await openControls(p, 'camera');
	await p.evaluate(() => document.querySelector('#dchat-ai-controls').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await p.tap('#dchat-ai-controls .gs-ai-input');
	await p.type('#dchat-ai-controls .gs-ai-input', 'In VR Map, hold both grips and spread hands to zoom in, pinch to zoom out', { delay: 1 });
	await p.tap('#dchat-ai-controls .gs-ai-generate');
	await p.waitForFunction(() => !document.querySelector('#dchat-ai-controls .gs-ai-preview').hidden, { timeout: 15000 }).catch(() => {});
	await sleep(200);
	let st = await panelState(p);
	const fit = await p.evaluate(() => { const r = document.querySelector('#dchat-ai-controls').getBoundingClientRect(); const pv = document.querySelector('#dchat-ai-controls .gs-ai-preview').getBoundingClientRect(); return { right: r.right, pvRight: pv.right, vw: innerWidth, sw: document.documentElement.scrollWidth }; });
	check('phone: tap-typed description → preview card that fits the screen', !!st.preview && fit.right <= fit.vw + 1 && fit.pvRight <= fit.vw + 1, { fit, preview: !!st.preview });
	await p.evaluate(() => document.querySelector('#dchat-ai-controls .gs-ai-preview').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await p.screenshot({ path: `${SHOT_DIR}/phone-preview-card.png` });
	await p.tap('#dchat-ai-controls .gs-ai-apply'); await sleep(250);
	st = await panelState(p);
	check('phone: Apply adds the AI row', st.rows.length === 1, st.rows);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls').scrollIntoView({ block: 'start' }));
	await sleep(200);
	await p.screenshot({ path: `${SHOT_DIR}/phone-applied-row.png` });
	check('phone: no console errors', p._errors.length === 0, p._errors);
	await p.close();
}

// ======================================================= VR (IWER Quest 3)
if (!SKIP_VR) {
	const p = await openPage({ width: 1600, height: 900 }, { xr: true });
	await setMode(p, 'map');
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
	check('VR: entered immersive session', await p.evaluate(() => renderer.xr.isPresenting));
	await sleep(1500);
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
			aim(hand, target, offset = null) {
				const c = [0, 1].map((i) => renderer.xr.getController(i)).find((x) => x.userData.handedness === hand);
				const xrCam = renderer.xr.getCamera(); const head = new V(); xrCam.getWorldPosition(head);
				const origin = head.clone().add(offset || new V(hand === 'right' ? 0.15 : -0.15, -0.3, -0.1));
				const parent = c.parent; parent.updateMatrixWorld(true);
				const inv = parent.matrixWorld.clone().invert();
				const o = origin.clone().applyMatrix4(inv), t = target.clone().applyMatrix4(inv);
				const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(o, t, new V(0, 1, 0)));
				const dc = window.__xrDevice.controllers[hand];
				dc.position.set(o.x, o.y, o.z); dc.quaternion.set(q.x, q.y, q.z, q.w);
			},
			aimAt(hand, el, winName) { this.aim(hand, this.pointFor(el, winName)); },
			// Hands pointing at the floor away from the menu, `spread` metres apart (rig-local x = ±spread/2).
			hands(spread) {
				const xrCam = renderer.xr.getCamera(); const h = new V(); xrCam.getWorldPosition(h);
				for (const hand of ['left', 'right']) {
					const sx = hand === 'right' ? spread / 2 : -spread / 2;
					this.aim(hand, h.clone().add(new V(sx * 2, -4, -0.1)), new V(sx, -0.45, -0.25)); // rays straight down at the floor, never on a VR window
				}
			},
			btn(hand, id, v) { window.__xrDevice.controllers[hand].updateButtonValue(id, v); },
			stick(hand, x, y) { window.__xrDevice.controllers[hand].updateAxes('thumbstick', x, y); }
		};
		__t.hands(0.3);
	});
	await sleep(500);
	const rig = () => p.evaluate(() => gsVrInput.playerPosition().toArray());
	const headFwd = () => p.evaluate(() => { const q = new THREE.Quaternion(); renderer.xr.getCamera().getWorldQuaternion(q); return new THREE.Vector3(0, 0, -1).applyQuaternion(q).toArray(); });
	// open Controls → Camera → AI panel in the VR menu, type with the VR keyboard
	await p.evaluate(() => { window.gsSelectTab('controls'); document.querySelector('#dchat-controls-subtabs [data-controls-section="camera"]')?.click(); });
	await sleep(500);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls .gs-ai-input').scrollIntoView({ block: 'center' }));
	await sleep(800);
	await p.evaluate(() => __t.aimAt('right', document.querySelector('#dchat-ai-controls .gs-ai-input'), 'menu'));
	await sleep(500);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(250);
	await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(700);
	const kb = await p.evaluate(() => ({ typing: document.querySelector('#dchat-ai-controls .gs-ai-input').classList.contains('gs-vr-typing'), kbVisible: !!window.__gsVrWindows.byName('keyboard')?.mesh.visible }));
	check('VR: pointing + trigger on the describe box opens the VR keyboard for it', kb.typing && kb.kbVisible, kb);
	// type "grip" by pointing at the VR keyboard keys
	for (const ch of 'grip') {
		await p.evaluate((c) => __t.aimAt('right', document.querySelector(`#gs-vr-keyboard [data-kb-action="char"][data-kb-value="${c}"]`), 'keyboard'), ch);
		await sleep(250);
		await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(150);
		await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(250);
	}
	const typed = await p.evaluate(() => document.querySelector('#dchat-ai-controls .gs-ai-input').value);
	check('VR: the VR keyboard types into the describe box', typed === 'grip', typed);
	// while the VR keyboard is open, AI controls (and so grip zoom) are paused
	await p.evaluate((g) => { gsAiControls.apply('map', { description: 'In VR Map, hold both grips and spread hands to zoom in, pinch to zoom out', def: g }); }, DEFS.grip);
	await sleep(200);
	await p.evaluate(() => __t.hands(0.3)); await sleep(300);
	let r0 = await rig();
	await p.evaluate(() => { __t.btn('left', 'squeeze', 1); __t.btn('right', 'squeeze', 1); }); await sleep(300);
	for (let s = 0.3; s <= 0.7; s += 0.05) { await p.evaluate((s) => __t.hands(s), s); await sleep(60); }
	await sleep(300);
	await p.evaluate(() => { __t.btn('left', 'squeeze', 0); __t.btn('right', 'squeeze', 0); }); await sleep(300);
	let r1 = await rig();
	check('VR: while typing with the VR keyboard, the grip zoom does not fire', dist(r0, r1) < 0.02, { moved: dist(r0, r1) });
	// finish the description programmatically, Generate with the ray, Apply with the ray
	await p.evaluate(() => { const i = document.querySelector('#dchat-ai-controls .gs-ai-input'); i.value = 'In VR Map, hold both grips and spread hands to zoom in, pinch to zoom out'; i.dispatchEvent(new Event('input', { bubbles: true })); gsAiControls.remove('map', gsAiControls.list('map')[0].id); });
	await p.evaluate(() => __t.aimAt('right', document.querySelector('#gs-vr-keyboard [data-kb-action="done"]'), 'keyboard')); await sleep(250);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(150); await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(500);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls .gs-ai-generate').scrollIntoView({ block: 'center' })); await sleep(700);
	await p.evaluate(() => __t.aimAt('right', document.querySelector('#dchat-ai-controls .gs-ai-generate'), 'menu')); await sleep(300);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(150); await p.evaluate(() => __t.btn('right', 'trigger', 0));
	await p.waitForFunction(() => !document.querySelector('#dchat-ai-controls .gs-ai-preview').hidden, { timeout: 15000 }).catch(() => {});
	await sleep(800);
	let st = await panelState(p);
	check('VR: Generate from the VR menu shows the preview card', !!st.preview && /Two-hand grip zoom/.test(st.preview.title), st);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls .gs-ai-preview').scrollIntoView({ block: 'center' })); await sleep(800);
	await p.screenshot({ path: `${SHOT_DIR}/vr-preview-mirror.png` });
	await p.evaluate(() => __t.aimAt('right', document.querySelector('#dchat-ai-controls .gs-ai-apply'), 'menu')); await sleep(300);
	await p.evaluate(() => __t.btn('right', 'trigger', 1)); await sleep(150); await p.evaluate(() => __t.btn('right', 'trigger', 0)); await sleep(500);
	st = await panelState(p);
	check('VR: Apply from the VR menu adds the AI row', st.rows.length === 1 && st.rows[0].name === 'Two-hand grip zoom', st.rows);
	await p.evaluate(() => document.querySelector('#dchat-ai-controls .gs-ai-rows').scrollIntoView({ block: 'center' })); await sleep(800);
	await p.screenshot({ path: `${SHOT_DIR}/vr-applied-row-mirror.png` });

	// the primary case: two-hand grip zoom on a Quest 3
	await p.evaluate(() => __t.hands(0.3)); await sleep(300);
	const loco0 = await p.evaluate(() => gsVrInput.locomotionMode);
	r0 = await rig(); const f0 = await headFwd();
	await p.evaluate(() => { __t.btn('left', 'squeeze', 1); __t.btn('right', 'squeeze', 1); }); await sleep(300);
	for (let s = 0.3; s <= 0.701; s += 0.04) { await p.evaluate((s) => __t.hands(s), s); await sleep(60); }
	await sleep(500);
	r1 = await rig();
	const along = [0, 1, 2].reduce((acc, i) => acc + (r1[i] - r0[i]) * f0[i], 0);
	check('VR grip zoom: both grips + hands apart (0.3 → 0.7 m) zooms in (moves you toward where you look)', along > 1.0, { along, moved: dist(r0, r1) });
	// pinch: zoom out
	if (process.env.DBG) await p.evaluate(() => { const rt = gsAiControls.runtime; const o = rt.step; window.__dbg = []; rt.step = (f, l) => { const r = o(f, l); if (window.__dbg.length < 400) window.__dbg.push({ typing: f.typing, L: f.xr.hands?.left && { b: f.xr.hands.left.blocked, sq: f.xr.hands.left.inputs?.['L-Squeeze'], pos: f.xr.hands.left.pos }, R: f.xr.hands?.right && { b: f.xr.hands.right.blocked, sq: f.xr.hands.right.inputs?.['R-Squeeze'], pos: f.xr.hands.right.pos }, z: r.camera.zoom, n: l.length }); return r; }; });
	r0 = await rig();
	for (let s = 0.7; s >= 0.299; s -= 0.04) { await p.evaluate((s) => __t.hands(s), s); await sleep(60); }
	await sleep(500);
	r1 = await rig();
	const back = [0, 1, 2].reduce((acc, i) => acc + (r1[i] - r0[i]) * f0[i], 0);
	if (process.env.DBG) console.log(JSON.stringify(await p.evaluate(() => (window.__dbg || []).filter((_, i) => i % 10 === 0))));
	check('VR grip zoom: bringing the hands together zooms out', back < -1.0, { back });
	await p.evaluate(() => { __t.btn('left', 'squeeze', 0); __t.btn('right', 'squeeze', 0); }); await sleep(300);
	const loco1 = await p.evaluate(() => gsVrInput.locomotionMode);
	check('VR: the right grip press did not cycle locomotion (the AI control holds both grips)', loco0 === loco1, { loco0, loco1 });
	// one grip only: no zoom
	r0 = await rig();
	await p.evaluate(() => __t.btn('left', 'squeeze', 1)); await sleep(200);
	for (let s = 0.3; s <= 0.701; s += 0.05) { await p.evaluate((s) => __t.hands(s), s); await sleep(50); }
	await sleep(300);
	await p.evaluate(() => __t.btn('left', 'squeeze', 0)); await sleep(200);
	r1 = await rig();
	check('VR: one grip + spreading does nothing', dist(r0, r1) < 0.02, dist(r0, r1));
	// toggled off: no zoom, right grip cycles locomotion again
	await p.evaluate(() => gsAiControls.toggle('map', gsAiControls.list('map')[0].id, false)); await sleep(200);
	await p.evaluate(() => __t.hands(0.3)); await sleep(200);
	r0 = await rig();
	await p.evaluate(() => { __t.btn('left', 'squeeze', 1); __t.btn('right', 'squeeze', 1); }); await sleep(200);
	for (let s = 0.3; s <= 0.701; s += 0.05) { await p.evaluate((s) => __t.hands(s), s); await sleep(50); }
	await sleep(300);
	await p.evaluate(() => { __t.btn('left', 'squeeze', 0); __t.btn('right', 'squeeze', 0); }); await sleep(300);
	r1 = await rig();
	const loco2 = await p.evaluate(() => gsVrInput.locomotionMode);
	check('VR: toggled off → no zoom, and the right grip cycles locomotion again', dist(r0, r1) < 0.02 && loco2 !== loco1, { moved: dist(r0, r1), loco1, loco2 });
	const errs = p._errors.filter((e) => !/Speech error: NotAllowedError/.test(e));
	check('VR: no console errors', errs.length === 0, errs);
	await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
