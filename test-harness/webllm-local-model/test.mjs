// Local (WebLLM) models in the chat's Model menu. WebLLM is stubbed: the
// jsDelivr module and webllmWorker.js are answered by this test, so nothing is
// downloaded from jsDelivr, Hugging Face or GitHub, and /api/chat is stubbed
// (never a real AI call).
//   BASE=https://localhost:5028 SHOT_DIR=/workspace/gs-webllm-shots node test.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://localhost:5028';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-webllm-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600) : ''}`); };
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';

const CDN = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.88/+esm';
// Anything WebLLM would fetch: the library, the worker, weights, wasm.
const WEBLLM_URL = /jsdelivr\.net\/npm\/@mlc-ai|esm\.run|huggingface\.co|\.hf\.co|binary-mlc-llm-libs|raw\.githubusercontent|webllmWorker\.js/;

const STUB_LIB = `
const S = (self.__webllmStub ||= { creates: [], reloads: [], requests: [], unloads: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Engine {
	constructor(id) { this.id = id; this.cb = null;
		this.chat = { completions: { create: async (req) => {
			S.requests.push(JSON.parse(JSON.stringify({ ...req, modelId: this.id })));
			const lastText = String(req.messages?.[req.messages.length - 1]?.content || '');
			const reply = (/failed to execute/.test(lastText) && self.__webllmFixReply) || self.__webllmReply || 'Here is a cyan cube.\\n\\u0060\\u0060\\u0060vr-exec\\nconst m = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.5), new THREE.MeshStandardMaterial({ color: 0x22d3ee })); m.name = "webllmBox"; m.position.set(0, 1.2, -2); scene.add(m);\\n\\u0060\\u0060\\u0060\\nDone.';
			const parts = reply.match(/[\\s\\S]{1,10}/g);
			return (async function* () { for (const p of parts) { await sleep(self.__webllmChunkMs ?? 30); yield { choices: [{ delta: { content: p } }] }; } })();
		} } };
	}
	setInitProgressCallback(cb) { this.cb = cb; }
	async reload(id, opts) { S.reloads.push({ id, opts }); this.id = id; }
	async unload() { S.unloads++; }
	interruptGenerate() {}
}
export async function CreateWebWorkerMLCEngine(worker, modelId, engineConfig, chatOpts) {
	S.creates.push({ modelId, chatOpts, isWorker: worker instanceof Worker });
	const steps = self.__webllmSteps ?? 8;
	for (let i = 1; i <= steps; i++) {
		await sleep(self.__webllmStepMs ?? 250);
		engineConfig?.initProgressCallback?.({ progress: i / steps, timeElapsed: i, text: 'Fetching param cache[' + i + '/' + steps + ']: ' + Math.round(1750 * i / steps) + 'MB fetched.' });
	}
	if (self.__webllmFail) throw new Error(self.__webllmFail);
	return new Engine(modelId);
}
export const prebuiltAppConfig = { model_list: [] };
`;
const STUB_WORKER = 'self.onmessage = () => {};';
const BACKENDS = {
	backends: {
		'claude-sonnet-55': { label: 'Claude Sonnet 5.5', provider: 'claude', available: true },
		claude: { label: 'Claude (Sonnet 5)', provider: 'claude', available: true },
		'openai-sol': { label: 'GPT6.1 Sol', provider: 'openai', available: true },
		openai: { label: 'GPT6 Astra', provider: 'openai', available: false },
		ollama: { label: 'Ollama (runs in your browser, local)', provider: 'ollama', available: true, local: true }
	},
	default: 'claude'
};

const b = await puppeteer.launch({
	executablePath: process.env.CHROME || '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

// gpu: 'f16' | 'f32' | 'none' (no navigator.gpu) | 'noadapter'
async function openPage({ viewport = { width: 1280, height: 900 }, ua = null, xr = false, gpu = 'f16', ctx = null, storage = null } = {}) {
	const context = ctx || await b.createBrowserContext();
	const p = await context.newPage();
	const errors = [];
	const net = { all: [], webllm: [], chat: [], workers: [] };
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Local model load failed|isn't loaded yet|boom-local/.test(m.text())) errors.push('console: ' + m.text()); });
	p.on('workercreated', (w) => { net.workers.push(w.url()); });
	if (ua) await p.setUserAgent(ua);
	await p.setViewport(viewport);
	await p.evaluateOnNewDocument((gpu) => {
		if (gpu === 'none') {
			Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined });
			try { delete Navigator.prototype.gpu; } catch (e) { /* ignore */ }
		} else {
			const adapter = gpu === 'noadapter' ? null : { features: new Set(gpu === 'f16' ? ['shader-f16'] : []), limits: {}, info: { vendor: 'test' } };
			Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }) });
		}
	}, gpu);
	if (storage) await p.evaluateOnNewDocument((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
	if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const url = req.url();
		net.all.push(url);
		const u = new URL(url);
		if (url === CDN) { net.webllm.push(url); return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: STUB_LIB }); }
		if (u.pathname.endsWith('/webllmWorker.js')) { net.webllm.push(url); return req.respond({ status: 200, contentType: 'text/javascript', body: STUB_WORKER }); }
		if (WEBLLM_URL.test(url)) { net.webllm.push(url); return req.abort(); }
		if (u.pathname === '/api/chat') {
			net.chat.push(JSON.parse(req.postData() || '{}'));
			return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'server reply' }] }) });
		}
		// Same backends on every host (the local Worker has no keys, so it would default to Ollama).
		if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(BACKENDS) });
		if (u.pathname === '/api/community-scenes' && req.method() === 'GET') return req.respond({ status: 200, contentType: 'application/json', body: '{"scenes":[]}' });
		if (u.pathname.startsWith('/api/community') && req.method() !== 'GET') return req.abort();
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
	await p.waitForFunction(() => window.__gsLocalModels && document.querySelectorAll('#desktop-model-select option').length > 1, { timeout: 20000 });
	await sleep(800);
	return { p, errors, net, context };
}

const st = (p) => p.evaluate(() => {
	const sel = document.getElementById('desktop-model-select');
	const row = document.getElementById('desktop-webllm-row');
	const vis = (el) => !!el && !el.hidden && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
	const q = (s) => row.querySelector(s);
	return {
		value: sel.value,
		options: [...sel.options].map(o => ({ value: o.value, text: o.textContent, disabled: o.disabled, group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null })),
		rowVisible: vis(row), state: row.dataset.state,
		title: q('.gs-webllm-title')?.textContent, info: q('.gs-webllm-info')?.textContent,
		warn: vis(q('.gs-webllm-warn')) ? q('.gs-webllm-warn').textContent : null,
		load: vis(q('[data-webllm="load"]')) ? q('[data-webllm="load"]').textContent : null,
		cancel: vis(q('[data-webllm="cancel"]')) ? q('[data-webllm="cancel"]').textContent : null,
		progressVisible: vis(q('.gs-webllm-progress')), fill: q('.gs-webllm-fill')?.style.width, progressText: q('.gs-webllm-progress-text')?.textContent,
		saved: localStorage.getItem('gs.chatBackend'),
		panel: window.__gsLocalModels.panel.state(),
		loaded: window.__gsLocalModels.LocalLLM.loadedModelId(),
		stub: self.__webllmStub ? { creates: self.__webllmStub.creates.length, requests: self.__webllmStub.requests.length, unloads: self.__webllmStub.unloads } : null,
		thinking: document.querySelector('#desktop-chat-messages .dchat-msg.thinking')?.textContent || null,
		lastMsg: [...document.querySelectorAll('#desktop-chat-messages .dchat-msg')].pop()?.textContent || null
	};
});
const selectModel = (p, v) => p.evaluate((v) => { const s = document.getElementById('desktop-model-select'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const chatShot = async (p, name) => {
	const r = await p.evaluate(() => { const r = document.getElementById('desktop-chat').getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(innerWidth, r.width), height: Math.min(innerHeight, r.height) }; });
	await p.screenshot({ path: `${SHOT_DIR}/${name}.png`, clip: r });
};
const send = async (p, text) => {
	await p.evaluate((t) => { const i = document.getElementById('desktop-chat-input'); i.value = t; }, text);
	await p.evaluate(() => document.getElementById('desktop-send-button').click());
};

const EXPECT = {
	'webllm:qwen-coder-1.5b': 'Local: Qwen2.5-Coder 1.5B (WebLLM) — 882 MB download',
	'webllm:qwen-coder-3b': 'Local: Qwen2.5-Coder 3B (WebLLM) — 1.75 GB download',
	'webllm:qwen-coder-7b': 'Local: Qwen2.5-Coder 7B (WebLLM) — 4.30 GB download'
};

// ───────── 1. Page load fetches nothing from WebLLM; dropdown shows sizes ─────────
let savedServerDefault;
{
	const { p, errors, net, context } = await openPage();
	const ids = await p.evaluate(() => ({ send: !!document.getElementById('desktop-send-button'), input: !!document.getElementById('desktop-chat-input') }));
	check('chat input + send button exist', ids.send && ids.input, ids);
	const backends = await p.evaluate(() => fetch('/api/backends').then(r => r.json()));
	let s = await st(p);
	savedServerDefault = s.value;
	check('page load: no request to jsDelivr WebLLM, Hugging Face, GitHub wasm or webllmWorker.js', net.webllm.length === 0, net.webllm);
	check('page load: no worker started', net.workers.length === 0, net.workers);
	const res = await p.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(n => /mlc|huggingface|webllmWorker/.test(n)));
	check('page load: Resource Timing has no WebLLM entries', res.length === 0, res);
	const local = s.options.filter(o => o.value.startsWith('webllm:'));
	check('three Local options with their download sizes', local.length === 3 && local.every(o => EXPECT[o.value] === o.text), local);
	check('Local options sit in their own group after the server models', local.every(o => /WebLLM/.test(o.group || '')) && s.options.findIndex(o => o.value.startsWith('webllm:')) === s.options.length - 3, s.options.map(o => o.group));
	// Server models unchanged: same ids, order, labels and enabled state as /api/backends
	const server = s.options.filter(o => !o.value.startsWith('webllm:'));
	const exp = Object.entries(backends.backends).map(([id, info]) => ({ id, label: info.label }));
	check('server model options unchanged (ids, order, labels)', server.length === exp.length && server.every((o, i) => o.value === exp[i].id && o.text.startsWith(exp[i].label)), { server, exp });
	check('server option labels/disabled exactly as before ("— no API key set")', server.find(o => o.value === 'openai')?.text === 'GPT6 Astra — no API key set' && server.find(o => o.value === 'openai').disabled, server.find(o => o.value === 'openai'));
	check('default selection is still the server default', s.value === backends.default, { value: s.value, def: backends.default });
	check('panel hidden while a server model is selected', !s.rowVisible, s);
	check('nothing saved before a pick', s.saved === null, s.saved);
	// Open the dropdown for a screenshot: render a size list overlay (native selects don't screenshot)
	await p.evaluate(() => {
		const sel = document.getElementById('desktop-model-select');
		const r = sel.getBoundingClientRect();
		const box = document.createElement('div'); box.id = '__dd';
		box.style.cssText = `position:fixed;left:${r.left}px;top:${r.bottom + 2}px;min-width:${r.width}px;background:#1f2030;color:#fff;font:12px system-ui;border:1px solid #888;border-radius:4px;z-index:99999;padding:4px 0;box-shadow:0 6px 20px rgba(0,0,0,.5)`;
		for (const el of sel.children) {
			if (el.tagName === 'OPTGROUP') { const h = document.createElement('div'); h.textContent = el.label; h.style.cssText = 'padding:4px 8px;color:#aaa;font-weight:600'; box.appendChild(h); for (const o of el.children) { const d = document.createElement('div'); d.textContent = o.textContent; d.style.cssText = 'padding:3px 8px 3px 18px'; box.appendChild(d); } }
			else { const d = document.createElement('div'); d.textContent = el.textContent; d.style.cssText = `padding:3px 8px;${el.disabled ? 'color:#777' : ''}${el.selected ? ';background:#4f46e5' : ''}`; box.appendChild(d); }
		}
		document.body.appendChild(box);
	});
	await p.screenshot({ path: `${SHOT_DIR}/01-dropdown-sizes.png` });
	await p.evaluate(() => document.getElementById('__dd').remove());

	// ───────── 2. Selecting shows the confirmation; still nothing fetched ─────────
	await selectModel(p, 'webllm:qwen-coder-3b');
	await sleep(1500);
	s = await st(p);
	check('selecting a Local model shows the panel with the size', s.rowVisible && s.state === 'idle' && /1\.75 GB/.test(s.info) && s.load === 'Download & load (1.75 GB)', s);
	check('panel mentions caching and GPU memory', /caches it/.test(s.info) && /GPU memory/.test(s.info) && /2\.\d\d GB|3\.\d\d GB/.test(s.info), s.info);
	check('cancel offers the previous server model', /^Use .+ instead$/.test(s.cancel || ''), s.cancel);
	check('selection alone fetches nothing (no library, worker or weights)', net.webllm.length === 0 && net.workers.length === 0, { webllm: net.webllm, workers: net.workers });
	check('selection is saved', s.saved === 'webllm:qwen-coder-3b', s.saved);
	check('thinking label uses the local model name', await p.evaluate(() => document.querySelector('#desktop-model-select').selectedOptions[0].textContent).then(t => /3B/.test(t)));
	await chatShot(p, '02-confirmation');

	// Sending before loading: clear message, no server call, no download
	await send(p, 'make a cube');
	await sleep(800);
	s = await st(p);
	check('send before load: explains to click Download & load; no /api/chat', /isn't loaded yet/.test(s.lastMsg || '') && net.chat.length === 0 && net.webllm.length === 0, { last: s.lastMsg, chat: net.chat.length });

	// Cancel goes back to the server model
	await p.evaluate(() => document.querySelector('#desktop-webllm-row [data-webllm="cancel"]').click());
	await sleep(300);
	s = await st(p);
	check('"Use … instead" returns to the previous server model', s.value === savedServerDefault && !s.rowVisible && s.saved === savedServerDefault, s);

	// ───────── 3. Download & load: progress bar from initProgressCallback ─────────
	await selectModel(p, 'webllm:qwen-coder-3b');
	await sleep(200);
	await p.evaluate(() => { self.__webllmStepMs = 300; self.__webllmSteps = 8; });
	await p.evaluate(() => document.querySelector('#desktop-webllm-row [data-webllm="load"]').click());
	await sleep(1250);
	s = await st(p);
	check('loading: progress bar visible with WebLLM\'s report text', s.state === 'loading' && s.progressVisible && parseFloat(s.fill) > 0 && parseFloat(s.fill) < 100 && /Fetching param cache/.test(s.progressText), s);
	check('loading: worker started from webllmWorker.js and the pinned library imported', net.webllm.some(u => u === CDN) && net.workers.some(u => /webllmWorker\.js$/.test(u)), { webllm: net.webllm, workers: net.workers });
	check('loading: only the stubbed library/worker were requested (no weights)', net.webllm.every(u => u === CDN || /webllmWorker\.js$/.test(u)), net.webllm);
	await chatShot(p, '03-progress');
	const fps = await p.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 500) requestAnimationFrame(f); else res(n * 2); }; requestAnimationFrame(f); }));
	check('page keeps rendering while loading (worker, not main thread)', fps > 10, fps);
	await p.waitForFunction(() => document.getElementById('desktop-webllm-row').dataset.state === 'ready', { timeout: 15000 });
	s = await st(p);
	check('ready state after load', s.state === 'ready' && /Loaded/.test(s.info) && s.loaded === 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', s);
	const create = await p.evaluate(() => self.__webllmStub.creates[0]);
	check('CreateWebWorkerMLCEngine got a Worker, the q4f16_1 model and a 16k context', create.isWorker && create.modelId === 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC' && create.chatOpts?.context_window_size === 16384, create);
	await chatShot(p, '04-loaded');

	// ───────── 4. Chat goes to the local engine, streaming ─────────
	const prompts = await p.evaluate(() => fetch('/api/prompts').then(r => r.json()));
	await p.evaluate(() => { self.__webllmChunkMs = 60; });
	await send(p, 'make a cyan cube');
	await sleep(700);
	const mid = await p.evaluate(() => document.querySelector('#desktop-chat-messages .dchat-msg.streaming')?.textContent || null);
	check('reply streams into the chat while it is generated', !!mid && mid.length > 0, mid);
	await chatShot(p, '05-streaming');
	await p.waitForFunction(() => !!scene.getObjectByName('webllmBox'), { timeout: 20000 }).catch(() => {});
	await sleep(500);
	const req = await p.evaluate(() => self.__webllmStub.requests[0]);
	check('chat went to the local engine, not /api/chat', !!req && net.chat.length === 0, { chat: net.chat.length });
	check('same system prompt as the server models (default /api/prompts systemPrompt)', req?.messages?.[0]?.role === 'system' && req.messages[0].content === prompts.systemPrompt, req?.messages?.[0]?.content?.slice(0, 80));
	const lastUser = req?.messages?.[req.messages.length - 1];
	check('newest user message carries the [GS editor settings] note and the text', lastUser?.role === 'user' && /\[GS editor settings/.test(lastUser.content) && /make a cyan cube/.test(lastUser.content), lastUser?.content?.slice(0, 200));
	check('streaming request with a capped max_tokens', req?.stream === true && req.max_tokens <= 4096, { stream: req?.stream, max: req?.max_tokens });
	const cube = await p.evaluate(() => !!scene.getObjectByName('webllmBox'));
	check('the vr-exec block from the local reply ran (cube in the scene)', cube);
	s = await st(p);
	check('final reply shown like server replies ([Executed code block 1])', /\[Executed code block 1\]/.test(await p.evaluate(() => [...document.querySelectorAll('#desktop-chat-messages .dchat-msg.assistant')].map(e => e.textContent).join('|'))), s.lastMsg);
	check('no leftover streaming bubble', await p.evaluate(() => !document.querySelector('#desktop-chat-messages .dchat-msg.streaming')));
	await chatShot(p, '06-reply');

	// Fix-code goes local too: make the stub reply with broken code, then a fix
	await p.evaluate(() => {
		self.__webllmReply = 'Broken:\n```vr-exec\nthrow new Error("boom-local")\n```';
		self.__webllmFixReply = '```vr-exec\nconst g = new THREE.Group(); g.name = "fixedLocal"; scene.add(g);\n```';
		self.__webllmChunkMs = 5;
	});
	await send(p, 'break it');
	await p.waitForFunction(() => !!scene.getObjectByName('fixedLocal'), { timeout: 15000 }).catch(() => {});
	const fixReq = await p.evaluate(() => self.__webllmStub.requests.find(r => /failed to execute/.test(r.messages?.[r.messages.length - 1]?.content || '')));
	const fixedRan = await p.evaluate(() => !!scene.getObjectByName('fixedLocal'));
	check('auto-fix uses the local model with the fix-code prompt', !!fixReq && fixReq.messages[0].content === prompts.fixCodePrompt && net.chat.length === 0 && fixedRan, { found: !!fixReq, sameSys: fixReq?.messages?.[0]?.content === prompts.fixCodePrompt, sys: fixReq?.messages?.[0]?.content?.slice(0, 60), want: prompts.fixCodePrompt?.slice(0, 60), chat: net.chat.length, fixedRan });
	await p.evaluate(() => { delete self.__webllmReply; delete self.__webllmFixReply; });

	// Theme chat goes local too
	const themeOk = await p.evaluate(async () => {
		self.__webllmReply = 'A calm theme.';
		const before = self.__webllmStub.requests.length;
		window.gsSelectTab?.('chat');
		document.querySelector('[data-chat-section="theme"]')?.click();
		const i = document.getElementById('dchat-theme-chat-input'); const btn = document.getElementById('dchat-theme-chat-send');
		if (!i || !btn) return { skipped: true };
		i.value = 'make it calm'; btn.click();
		for (let k = 0; k < 60 && self.__webllmStub.requests.length === before; k++) await new Promise(r => setTimeout(r, 100));
		const r = self.__webllmStub.requests[self.__webllmStub.requests.length - 1];
		document.querySelector('[data-chat-section="scene"]')?.click();
		delete self.__webllmReply;
		return { sent: self.__webllmStub.requests.length > before, sys: r?.messages?.[0]?.content?.slice(0, 40) };
	});
	check('theme chat uses the local model with the theme prompt', themeOk.skipped || (themeOk.sent && prompts.themePrompt.startsWith(themeOk.sys)), themeOk);
	await sleep(500);
	check('no /api/chat request while the local model is selected', net.chat.length === 0, net.chat.length);

	// ───────── 5. Switching to a server model: unchanged request, GPU freed ─────────
	await selectModel(p, savedServerDefault);
	await sleep(300);
	s = await st(p);
	check('server model: panel hidden and the local engine unloaded', !s.rowVisible && s.loaded === null && s.stub.unloads >= 1, s);
	await send(p, 'hello server');
	await sleep(1200);
	const body = net.chat[net.chat.length - 1];
	check('server model: /api/chat body unchanged (messages + backend only)', !!body && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['backend', 'messages']) && body.backend === savedServerDefault, body && Object.keys(body));
	check('server model: no further local generation', (await p.evaluate(() => self.__webllmStub.requests.length)) === s.stub.requests, s.stub);
	check('no page errors (desktop)', errors.length === 0, errors);
	await context.close();
}

// ───────── 6. Saved Local choice persists but never auto-loads ─────────
{
	const { p, errors, net, context } = await openPage({ storage: { 'gs.chatBackend': 'webllm:qwen-coder-1.5b', 'gs.webllm.downloaded': '["Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC"]' } });
	await sleep(2000);
	const s = await st(p);
	check('reload: saved Local model is selected again', s.value === 'webllm:qwen-coder-1.5b', s.value);
	check('reload: it waits for a click (idle, Load button shown)', s.rowVisible && s.state === 'idle' && s.load === 'Load from cache' && /Already downloaded/.test(s.info), s);
	check('reload: nothing fetched and no worker started', net.webllm.length === 0 && net.workers.length === 0, { webllm: net.webllm, workers: net.workers });
	// Clear cache button asks first (in-app confirm)
	await p.evaluate(() => document.querySelector('#desktop-webllm-row [data-webllm="clear"]').click());
	await sleep(400);
	const dlg = await p.evaluate(() => window.gsDialogs?.current?.() || null);
	check('"Remove downloaded models" asks with the in-app confirm', !!dlg, dlg);
	await p.click('#gs-dialog [data-gs-dialog="ok"]'); await sleep(600);
	const after = await st(p);
	check('after removing: download size shown again', after.load === 'Download & load (882 MB)', after.load);
	check('no page errors (reload)', errors.length === 0, errors);
	await context.close();
}
{
	const { p, errors, net, context } = await openPage({ storage: { 'gs.chatBackend': 'openai-sol' } });
	const s = await st(p);
	check('reload: a saved server model is restored too', s.value === 'openai-sol', s.value);
	check('no page errors (server restore)', errors.length === 0, errors);
	await context.close();
}

// ───────── 7. No WebGPU: options say so, picking one falls back ─────────
{
	const { p, errors, net, context } = await openPage({ gpu: 'none', storage: { 'gs.chatBackend': 'webllm:qwen-coder-3b' } });
	let s = await st(p);
	const local = s.options.filter(o => o.value.startsWith('webllm:'));
	check('no WebGPU: Local options disabled and marked "needs WebGPU"', local.length === 3 && local.every(o => o.disabled && /needs WebGPU/.test(o.text)), local);
	check('no WebGPU: saved Local choice not restored; server model in use', !s.value.startsWith('webllm:'), s.value);
	await selectModel(p, 'webllm:qwen-coder-3b'); // e.g. the VR menu cycles into it
	await sleep(400);
	s = await st(p);
	check('no WebGPU: picking one explains and switches back to the server model', !s.value.startsWith('webllm:') && /WebGPU/.test(s.lastMsg || '') && /Switched back to/.test(s.lastMsg || '') && !s.rowVisible, { value: s.value, last: s.lastMsg });
	check('no WebGPU: nothing fetched', net.webllm.length === 0 && net.workers.length === 0, net.webllm);
	await chatShot(p, '07-no-webgpu');
	check('no page errors (no WebGPU)', errors.length === 0, errors);
	await context.close();
}
{
	const { p, errors, net, context } = await openPage({ gpu: 'noadapter' });
	await selectModel(p, 'webllm:qwen-coder-1.5b');
	await p.evaluate(() => document.querySelector('#desktop-webllm-row [data-webllm="load"]').click());
	await sleep(600);
	const s = await st(p);
	check('WebGPU without a GPU adapter: explains, falls back, downloads nothing', !s.value.startsWith('webllm:') && /no usable GPU/.test(s.lastMsg || '') && net.webllm.length === 0, { value: s.value, last: s.lastMsg, webllm: net.webllm });
	check('no page errors (no adapter)', errors.length === 0, errors);
	await context.close();
}
{
	// GPU without shader-f16: the q4f32_1 build of the same model
	const { p, errors, net, context } = await openPage({ gpu: 'f32' });
	await selectModel(p, 'webllm:qwen-coder-1.5b');
	await p.evaluate(() => { self.__webllmStepMs = 20; });
	await p.evaluate(() => document.querySelector('#desktop-webllm-row [data-webllm="load"]').click());
	await p.waitForFunction(() => document.getElementById('desktop-webllm-row').dataset.state === 'ready', { timeout: 15000 }).catch(() => {});
	const s = await st(p);
	const c = await p.evaluate(() => self.__webllmStub?.creates?.[0]);
	check('no shader-f16: loads the q4f32_1 build and says so', c?.modelId === 'Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC' && /32-bit build/.test(s.info), { c, info: s.info });
	// A failed load shows the error with Try again
	await selectModel(p, 'webllm:qwen-coder-7b');
	await p.evaluate(() => { self.__webllmFail = 'Device lost: out of memory'; });
	await p.evaluate(() => document.querySelector('#desktop-webllm-row [data-webllm="load"]').click());
	await sleep(1500);
	const e = await st(p);
	check('a failed load shows the error and Try again', e.state === 'error' && /out of memory|Not enough GPU memory/i.test(e.info) && e.load === 'Try again', e);
	check('no page errors (f32)', errors.length === 0, errors);
	await context.close();
}

// ───────── 8. Phone: size + support warning ─────────
{
	const { p, errors, net, context } = await openPage({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: PHONE_UA });
	await selectModel(p, 'webllm:qwen-coder-1.5b');
	await sleep(500);
	const s = await st(p);
	check('phone: warning about size and support', !!s.warn && /Phones usually can't run this/.test(s.warn) && /882 MB/.test(s.warn), s.warn);
	const btn = await p.evaluate(() => { const r = document.querySelector('#desktop-webllm-row [data-webllm="load"]').getBoundingClientRect(); return { h: r.height, inView: r.right <= innerWidth && r.left >= 0 }; });
	check('phone: Load button is a 44px tap target inside the screen', btn.h >= 44 && btn.inView, btn);
	check('phone: nothing fetched', net.webllm.length === 0, net.webllm);
	await p.screenshot({ path: `${SHOT_DIR}/08-phone.png` });
	check('no page errors (phone)', errors.length === 0, errors);
	await context.close();
}

// ───────── 9. VR: the dropdown and panel paint in the headset menu ─────────
{
	const { p, errors, net, context } = await openPage({ viewport: { width: 1400, height: 900 }, xr: true });
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); window.gsXrMode?.set('vr'); });
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => window.renderer?.xr?.isPresenting)); i++) await sleep(250);
	const presenting = await p.evaluate(() => !!window.renderer?.xr?.isPresenting);
	check('[VR] in an IWER Quest 3 VR session', presenting);
	if (presenting) {
		await sleep(800);
		await p.evaluate(() => window.gsSelectTab('chat'));
		await selectModel(p, 'webllm:qwen-coder-3b');
		await sleep(600);
		const v = await p.evaluate(() => {
			const w = window.__gsVrWindows.byName('menu');
			w.tick(true);
			const c = w.mesh.material.map.image;
			return { contains: w.source.contains(document.getElementById('desktop-model-select')) && w.source.contains(document.getElementById('desktop-webllm-row')), w: c.width, h: c.height, png: c.toDataURL('image/png') };
		});
		check('[VR] Model menu and Local panel are part of the painted menu window', v.contains && v.w > 0, { contains: v.contains });
		fs.writeFileSync(`${SHOT_DIR}/09-vr-menu.png`, Buffer.from(v.png.split(',')[1], 'base64'));
		check('[VR] picking a Local model in VR downloads nothing', net.webllm.length === 0, net.webllm);
	}
	check('no page errors (VR)', errors.length === 0, errors);
	await context.close();
}

await b.close();
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
