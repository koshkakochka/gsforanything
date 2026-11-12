// ammo.js is no longer a default-selected dependency, but stays available.
// BASE=https://localhost:3555 SHOT_DIR=/workspace/gs-ammo-shots node test.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:3555';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-ammo-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
	ok ? pass++ : fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`);
};

const browser = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function openPage({ stored = null, interceptChat = false } = {}) {
	const context = await browser.createBrowserContext();
	const p = await context.newPage();
	const errors = [];
	const chats = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => {
		if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
	});
	await p.setViewport({ width: 1280, height: 800 });
	if (stored != null) {
		await p.evaluateOnNewDocument((json) => {
			localStorage.setItem('gs.dependencies', json);
		}, typeof stored === 'string' ? stored : JSON.stringify(stored));
	}
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const u = new URL(req.url());
		if (u.pathname === '/api/backends') {
			return req.respond({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' })
			});
		}
		if (u.pathname === '/api/chat' && req.method() === 'POST') {
			const raw = req.postData() || '';
			chats.push(raw);
			return req.respond({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })
			});
		}
		if (u.pathname.startsWith('/api/')) {
			return req.respond({
				status: 200,
				contentType: 'application/json',
				body: u.pathname === '/api/community-scenes' ? '{"scenes":[]}' : '{}'
			});
		}
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
	await p.waitForFunction(() => typeof window.gsSelectTab === 'function' && window.GS_DEPS);
	await sleep(400);
	return { p, context, errors, chats };
}

async function depState(p) {
	return p.evaluate(() => {
		const row = (id) => {
			const el = document.querySelector(`.dchat-dep[data-dep="${id}"]`);
			const input = el?.querySelector('[data-dep-toggle]');
			const d = GS_DEPS.get(id);
			return {
				present: !!el,
				name: el?.querySelector('.dchat-dep-name')?.textContent || '',
				checked: !!input?.checked,
				disabled: !!input?.disabled,
				enabled: GS_DEPS.isEnabled(id),
				status: GS_DEPS.status(id),
				defaultEnabled: !!d?.defaultEnabled,
				builtIn: !!d?.builtIn
			};
		};
		return {
			stored: localStorage.getItem('gs.dependencies'),
			ids: GS_DEPS.list.map((d) => d.id),
			three: row('three'),
			ammo: row('ammo'),
			p5: row('p5')
		};
	});
}

async function openDeps(p) {
	await p.evaluate(() => window.gsSelectTab('deps'));
	await p.waitForSelector('#dchat-panel-deps.active, #dchat-panel-deps.dchat-panel.active');
	await sleep(300);
	// Some layouts keep the panel class as "active" only; also accept visible panel.
	const ready = await p.evaluate(() => {
		const panel = document.getElementById('dchat-panel-deps');
		const list = document.getElementById('dchat-deps-list');
		const r = list?.getBoundingClientRect();
		return { active: panel?.classList.contains('active'), h: Math.round(r?.height || 0), n: list?.querySelectorAll('.dchat-dep').length || 0 };
	});
	return ready;
}

// --- 1. Fresh profile: ammo off, still listed, not loaded ---
{
	const { p, context, errors } = await openPage();
	const ready = await openDeps(p);
	check('fresh: Dependencies tab opens with the three library rows', ready.n === 3 && ready.h > 80, ready);
	const s = await depState(p);
	check('fresh: ammo.js is still in the list', s.ids.includes('ammo') && s.ammo.present && s.ammo.name === 'ammo.js', s.ammo);
	check('fresh: ammo.js defaultEnabled is false and checkbox is unchecked', s.ammo.defaultEnabled === false && s.ammo.checked === false && s.ammo.enabled === false && !s.ammo.disabled, s.ammo);
	check('fresh: ammo.js is not loaded on startup', s.ammo.status === 'idle', s.ammo);
	check('fresh: THREE.js stays built-in and checked', s.three.builtIn && s.three.checked && s.three.disabled && s.three.enabled, s.three);
	check('fresh: p5.js stays unchecked', s.p5.checked === false && s.p5.enabled === false, s.p5);
	check('fresh: no gs.dependencies write until the user toggles something', s.stored == null, s.stored);
	await p.screenshot({ path: `${SHOT_DIR}/deps-ammo-unchecked.png` });
	check('fresh: no page errors', errors.length === 0, errors);
	await context.close();
}

// --- 2. Old default snapshot (mirrors persist() with no explicit choice) → off ---
{
	const { p, context } = await openPage({ stored: { ammo: true, p5: false } });
	await openDeps(p);
	const s = await depState(p);
	check('old-default snapshot {ammo:true,p5:false}: ammo treated as off, not loaded', s.ammo.checked === false && s.ammo.enabled === false && s.ammo.status === 'idle', s.ammo);
	check('old-default snapshot: p5 stays off', s.p5.enabled === false, s.p5);
	await context.close();
}

// --- 3. Old persist after the user only enabled p5 (ammo:true was the old default) → ammo off, p5 on ---
{
	const { p, context } = await openPage({ stored: { ammo: true, p5: true } });
	await openDeps(p);
	const s = await depState(p);
	check('old {ammo:true,p5:true} without explicit: ammo off (mirrored default), p5 on (real choice)', s.ammo.enabled === false && s.ammo.checked === false && s.p5.enabled === true && s.p5.checked === true, { ammo: s.ammo, p5: s.p5 });
	await context.close();
}

// --- 4. Stored explicit off stays off ---
{
	const { p, context } = await openPage({ stored: { ammo: false, p5: false } });
	await openDeps(p);
	const s = await depState(p);
	check('stored ammo:false stays off', s.ammo.enabled === false && s.ammo.checked === false, s.ammo);
	await context.close();
}

// --- 5. Explicit saved on stays on ---
{
	const { p, context } = await openPage({ stored: { ammo: true, p5: false, explicit: { ammo: true } } });
	await openDeps(p);
	const s = await depState(p);
	check('explicit.ammo + ammo:true stays on and starts loading', s.ammo.enabled === true && s.ammo.checked === true && (s.ammo.status === 'loading' || s.ammo.status === 'loaded'), s.ammo);
	await context.close();
}

// --- 6. User can still select ammo; the choice is persisted as explicit and survives reload ---
{
	const { p, context } = await openPage();
	await openDeps(p);
	await p.click('.dchat-dep[data-dep="ammo"] [data-dep-toggle]');
	await sleep(400);
	let s = await depState(p);
	let stored = {};
	try { stored = JSON.parse(s.stored || '{}'); } catch { stored = { parse: s.stored }; }
	check('toggle on: ammo becomes enabled and checked', s.ammo.enabled && s.ammo.checked, s.ammo);
	check('toggle on: persist writes ammo:true and explicit.ammo', stored.ammo === true && stored.explicit && stored.explicit.ammo === true, stored);
	await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
	await p.waitForFunction(() => typeof window.gsSelectTab === 'function' && window.GS_DEPS);
	await sleep(400);
	await openDeps(p);
	s = await depState(p);
	check('reload after explicit on: ammo stays selected', s.ammo.enabled && s.ammo.checked, s.ammo);
	await p.click('.dchat-dep[data-dep="ammo"] [data-dep-toggle]');
	await sleep(300);
	s = await depState(p);
	try { stored = JSON.parse(s.stored || '{}'); } catch { stored = { parse: s.stored }; }
	check('toggle off: ammo is unchecked and stored false (explicit flag kept)', s.ammo.enabled === false && s.ammo.checked === false && stored.ammo === false && stored.explicit?.ammo === true, { ammo: s.ammo, stored });
	await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
	await p.waitForFunction(() => typeof window.gsSelectTab === 'function' && window.GS_DEPS);
	await sleep(400);
	await openDeps(p);
	s = await depState(p);
	check('reload after explicit off: ammo stays off', s.ammo.enabled === false && s.ammo.checked === false, s.ammo);
	await context.close();
}

// --- 7. Scenes that already use ammo still load it via gsRequire, without turning the checkbox on ---
{
	const { p, context, errors } = await openPage();
	await openDeps(p);
	const result = await p.evaluate(async () => {
		const before = { enabled: GS_DEPS.isEnabled('ammo'), status: GS_DEPS.status('ammo') };
		const Ammo = await gsRequire('ammo');
		return {
			before,
			enabledAfter: GS_DEPS.isEnabled('ammo'),
			statusAfter: GS_DEPS.status('ammo'),
			isFactoryConsumed: typeof window.Ammo === 'object' && typeof window.Ammo.btVector3 === 'function',
			hasWorld: typeof Ammo?.btDiscreteDynamicsWorld === 'function',
			sameAsWindow: Ammo === window.Ammo
		};
	});
	check('gsRequire(ammo) works when the checkbox is off', result.hasWorld && result.isFactoryConsumed && result.sameAsWindow, result);
	check('gsRequire(ammo) does not flip the saved/enabled checkbox', result.before.enabled === false && result.enabledAfter === false && result.statusAfter === 'loaded', result);
	const s = await depState(p);
	check('deps UI still shows ammo unchecked after an on-demand load', s.ammo.checked === false && s.ammo.enabled === false && s.ammo.status === 'loaded', s.ammo);
	check('gsRequire(ammo): no page errors', errors.length === 0, errors);
	await context.close();
}

// --- 8. Chat settings note reports ammo off on a fresh profile ---
{
	const { p, context, chats } = await openPage({ interceptChat: true });
	await p.waitForSelector('#desktop-chat-input');
	await p.click('#desktop-chat-input');
	await p.type('#desktop-chat-input', 'hello from deps test');
	await p.click('#desktop-send-button');
	for (let i = 0; i < 40 && chats.length === 0; i++) await sleep(100);
	const raw = chats[0] || '';
	let text = raw;
	try {
		const body = JSON.parse(raw);
		const msgs = body.messages || body.outgoing || [];
		text = JSON.stringify(body);
		const joined = msgs.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
		if (joined) text = joined + '\n' + text;
	} catch { /* raw already set */ }
	check('settings note: ammo.js listed as (off) for a fresh profile', /ammo\.js \(off\)/.test(text), text.slice(0, 800));
	check('settings note: tells the model ammo is switched off unless the user asks for physics', /ammo\.js is switched off in Dependencies/.test(text), text.slice(0, 800));
	check('settings note: did send a chat request', chats.length >= 1, chats.length);
	await context.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
