// Live check on a deployed host (no stubs): the Local options show their sizes,
// page load and selection fetch nothing from WebLLM, and (REAL_LOAD=1) the
// smallest model actually downloads + loads with the box's WebGPU.
//   BASE=https://dev.gsforanything.com SHOT_DIR=/workspace/gs-webllm-shots REAL_LOAD=1 node dev-verify.mjs
import fs from 'fs';
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'https://dev.gsforanything.com';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-webllm-shots';
const REAL = process.env.REAL_LOAD === '1';
const PROFILE = process.env.PROFILE || `/tmp/gs-webllm-profile-${process.pid}`;
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500) : ''}`); };
const WEBLLM_URL = /jsdelivr\.net\/npm\/@mlc-ai|esm\.run|huggingface\.co|\.hf\.co|xethub|binary-mlc-llm-libs|raw\.githubusercontent|webllmWorker\.js/;
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', userDataDir: PROFILE,
	args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 900 });
const reqs = [];
const errors = [];
const cdp = await p.createCDPSession();
await cdp.send('Network.enable');
await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const track = (session, who) => session.on('Network.requestWillBeSent', (e) => reqs.push({ who, url: e.request.url, t: Date.now() }));
track(cdp, 'page');
b.on('targetcreated', async (t) => { if (t.type() === 'worker' || t.type() === 'other') { try { const s = await t.createCDPSession(); await s.send('Network.enable'); track(s, t.type()); } catch { /* ignore */ } } });
p.on('workercreated', (w) => reqs.push({ who: 'worker-created', url: w.url(), t: Date.now() }));
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const webllmReqs = () => reqs.filter(r => WEBLLM_URL.test(r.url));
await p.goto(BASE + '/?cb=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90000 });
await p.waitForFunction(() => window.__gsLocalModels && document.querySelectorAll('#desktop-model-select optgroup option').length === 4, { timeout: 30000 });
await sleep(3000);
const opts = await p.evaluate(() => [...document.querySelectorAll('#desktop-model-select option')].map(o => ({ v: o.value, t: o.textContent, d: o.disabled })));
const gpu = await p.evaluate(async () => { if (!navigator.gpu) return null; const a = await navigator.gpu.requestAdapter(); return a ? { f16: a.features.has('shader-f16'), arch: a.info?.architecture } : 'no adapter'; });
console.log('host', BASE, 'version', await p.evaluate(() => window.GS_VERSION || document.querySelector('#gs-version, .gs-version')?.textContent || ''), 'webgpu', JSON.stringify(gpu));
console.log(opts.filter(o => o.v.startsWith('webllm:')).map(o => o.t).join('\n'));
check('dev: four Local options with download size and GPU memory', opts.filter(o => o.v.startsWith('webllm:')).map(o => o.t).join('|') === 'Local: Gemma 3 1B (WebLLM) — 603 MB download, needs ~1.1 GB GPU memory|Local: Qwen2.5-Coder 1.5B (WebLLM) — 882 MB download, needs ~2.1 GB GPU memory|Local: Qwen2.5-Coder 3B (WebLLM) — 1.75 GB download, needs ~3.1 GB GPU memory|Local: Qwen2.5-Coder 7B (WebLLM) — 4.30 GB download, needs ~6.1 GB GPU memory');
check('dev: page load fetched nothing from WebLLM/jsDelivr/Hugging Face/GitHub', webllmReqs().length === 0, webllmReqs().map(r => r.url));
check('dev: server default selected', !(await p.evaluate(() => document.getElementById('desktop-model-select').value)).startsWith('webllm:'));
await p.evaluate(() => { const s = document.getElementById('desktop-model-select'); s.value = 'webllm:qwen-coder-1.5b'; s.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(4000);
const panel = await p.evaluate(() => ({ state: document.getElementById('desktop-webllm-row').dataset.state, info: document.querySelector('#desktop-webllm-row .gs-webllm-info').textContent, load: document.querySelector('#desktop-webllm-row [data-webllm="load"]').textContent }));
check('dev: selecting shows the confirmation with the size', panel.state === 'idle' && panel.load === 'Download & load (882 MB)', panel);
check('dev: selecting fetched nothing', webllmReqs().length === 0, webllmReqs().map(r => r.url));
const clip = await p.evaluate(() => { const r = document.getElementById('desktop-chat').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
await p.screenshot({ path: `${SHOT_DIR}/dev-confirmation.png`, clip });
if (REAL) {
	console.log('REAL LOAD: clicking Download & load', new Date().toISOString());
	const t0 = Date.now();
	await p.evaluate(() => {
		const fill = document.querySelector('#desktop-webllm-row .gs-webllm-fill');
		window.__fillLog = [];
		if (fill) new MutationObserver(() => { const w = parseFloat(fill.style.width) || 0; const l = window.__fillLog; if (!l.length || l[l.length - 1] !== w) l.push(w); }).observe(fill, { attributes: true, attributeFilter: ['style'] });
	});
	await p.evaluate(() => document.querySelector('#desktop-webllm-row [data-webllm="load"]').click());
	let last = '', shotMid = false;
	const LIMIT = Number(process.env.LOAD_LIMIT_MS || 25 * 60000);
	while (Date.now() - t0 < LIMIT) {
		await sleep(5000);
		const s = await p.evaluate(() => ({ state: document.getElementById('desktop-webllm-row').dataset.state, text: document.querySelector('#desktop-webllm-row .gs-webllm-progress-text').textContent, info: document.querySelector('#desktop-webllm-row .gs-webllm-info').textContent, variant: window.__gsLocalModels.panel.state().modelId }));
		if (s.text !== last) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${s.state} ${s.variant} ${s.text}`); last = s.text; }
		if (!shotMid && s.state === 'loading' && /(\d+)%/.test(s.text) && Number(s.text.match(/(\d+)%/)[1]) >= 5) { await p.screenshot({ path: `${SHOT_DIR}/dev-real-progress.png`, clip }); shotMid = true; }
		if (s.state !== 'loading') { console.log('final', JSON.stringify(s)); break; }
	}
	const fin = await p.evaluate(() => ({ state: document.getElementById('desktop-webllm-row').dataset.state, info: document.querySelector('#desktop-webllm-row .gs-webllm-info').textContent, loaded: window.__gsLocalModels.LocalLLM.loadedModelId() }));
	await p.screenshot({ path: `${SHOT_DIR}/dev-real-final.png`, clip });
	const hosts = [...new Set(webllmReqs().map(r => new URL(r.url).host))];
	console.log('WebLLM hosts fetched after the click:', hosts.join(', '), 'requests:', webllmReqs().length);
	check('dev real load: model loaded with the box WebGPU', fin.state === 'ready' && !!fin.loaded, fin);
	const widths = await p.evaluate(() => window.__fillLog);
	console.log('bar widths:', widths.map(w => Math.round(w)).join(' '));
	check('dev real load: bar never goes backwards', widths.length > 3 && widths.every((w, i) => i === 0 || w >= widths[i - 1]));
	check('dev real load: bar hits 100% exactly once, at the end', widths.filter(w => w >= 100).length === 1 && widths[widths.length - 1] === 100);
	if (fin.state === 'ready' && process.env.REAL_CHAT === '1') {
		const before = Date.now();
		await p.evaluate(() => { const i = document.getElementById('desktop-chat-input'); i.value = 'Add a red cube named redCube at (0, 1, -2).'; document.getElementById('desktop-send-button').click(); });
		const CHAT_LIMIT = Number(process.env.CHAT_LIMIT_MS || 20 * 60000);
		let lastLen = -1;
		while (Date.now() - before < CHAT_LIMIT) {
			await sleep(10000);
			const c = await p.evaluate(() => ({ loading: !!document.querySelector('#desktop-chat-messages .dchat-msg.thinking'), streaming: document.querySelector('#desktop-chat-messages .dchat-msg.streaming')?.textContent || '', last: [...document.querySelectorAll('#desktop-chat-messages .dchat-msg')].pop()?.textContent || '' }));
			if (c.streaming.length !== lastLen) { console.log(`[chat ${Math.round((Date.now() - before) / 1000)}s] streaming ${c.streaming.length} chars: ${c.streaming.slice(-80).replace(/\n/g, ' ')}`); lastLen = c.streaming.length; }
			if (!c.loading) { console.log('chat done:', c.last.slice(0, 300)); break; }
		}
		await p.screenshot({ path: `${SHOT_DIR}/dev-real-chat.png`, clip });
		check('dev real chat: reply produced', await p.evaluate(() => !document.querySelector('#desktop-chat-messages .dchat-msg.thinking')));
	}
}
console.log('errors:', errors.slice(0, 8));
await b.close();
console.log(`${pass}/${pass + fail} passed`);
