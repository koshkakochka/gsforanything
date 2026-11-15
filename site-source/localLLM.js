// Local in-browser models (WebLLM, https://github.com/mlc-ai/web-llm).
//
// The chat's Model dropdown lists these after the server models. Nothing is
// fetched until the user picks one AND clicks "Download & load": only then is
// the WebLLM library imported from jsDelivr, the worker (webllmWorker.js)
// started and the weights downloaded from Hugging Face (the model's WebGPU
// library comes from GitHub). The browser keeps the downloaded files in Cache
// Storage ("webllm/model", "webllm/wasm", "webllm/config"), so later loads read
// them from disk; clearCache() removes them.
//
// Sizes below are not guesses. downloadBytes = every file WebLLM 0.2.88 fetches
// for the model: the params_shard_*.bin weight shards (their sum equals the
// nbytes total in the repo's tensor-cache.json), tensor-cache.json,
// mlc-chat-config.json and tokenizer.json from huggingface.co/mlc-ai/<model>,
// plus the model's .wasm from mlc-ai/binary-mlc-llm-libs (web-llm-models/
// v0_2_87/base). Read from the Hugging Face file listing and the files'
// Content-Length on 2026-11-14. The WebLLM library itself is another ~6.2 MB.
// vram4kMB is WebLLM's own vram_required_MB (prebuiltAppConfig, 4k context).
// GS runs the models with a 16k context (the Scene chat system prompt alone is
// ~8k tokens), so gpuMemoryBytes() adds the extra KV cache:
// layers x kv_heads x head_dim x 2 (K and V) x bytes per value x 12,288 tokens.

export const WEBLLM_VERSION = '0.2.88';
export const WEBLLM_CDN = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`;
export const LIB_BYTES = 6176038; // jsDelivr +esm bundle of 0.2.88
export const CONTEXT_WINDOW = 16384;
const WEBLLM_DEFAULT_CONTEXT = 4096;
export const BACKEND_PREFIX = 'webllm:';
const CACHE_NAMES = ['webllm/model', 'webllm/wasm', 'webllm/config'];
const DOWNLOADED_KEY = 'gs.webllm.downloaded';

// f16 = q4f16_1 (needs the WebGPU 'shader-f16' feature); f32 = q4f32_1 (same
// 4-bit weights, f32 math) is used automatically on GPUs without shader-f16.
export const LOCAL_MODELS = [
	{
		// Gemma 3 1B instruct, WebLLM 0.2.88 prebuilt (q4f16_1 only: WebLLM has no
		// q4f32_1 build or wasm for it, so it needs shader-f16). Download = 15
		// shards 562,628,864 B + tensor-cache.json 187,747 + mlc-chat-config.json
		// 3,042 + tokenizer.json 33,384,568 + gemma3-1b-it-q4f16_1_cs512-webgpu.wasm
		// 6,584,805. The prebuilt record sets context 4096 and sliding_window -1
		// (every layer full attention, so the KV cache grows linearly with the
		// context; Gemma's 512-token sliding window saves nothing in WebLLM).
		// Trained to 32k tokens (max_position_embeddings 32768), so GS's 16k fits.
		key: 'gemma3-1b', name: 'Gemma 3 1B', params: '1B',
		kv: { layers: 26, kvHeads: 1, headDim: 256 },
		f16: { id: 'gemma3-1b-it-q4f16_1-MLC', downloadBytes: 602789026, weightsBytes: 562628864, vram4kMB: 711.07 },
		f32: null,
		chatOpts: { sliding_window_size: -1 },
		note: 'smallest download; general chat model, weakest at scene code'
	},
	{
		key: 'qwen-coder-1.5b', name: 'Qwen2.5-Coder 1.5B', params: '1.5B',
		kv: { layers: 28, kvHeads: 2, headDim: 128 },
		f16: { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', downloadBytes: 881931113, vram4kMB: 1629.75 },
		f32: { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC', downloadBytes: 881809525, vram4kMB: 1888.97 },
		note: 'smallest, fastest; simpler scenes'
	},
	{
		key: 'qwen-coder-3b', name: 'Qwen2.5-Coder 3B', params: '3B', recommended: true,
		kv: { layers: 36, kvHeads: 2, headDim: 128 },
		f16: { id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', downloadBytes: 1749827307, vram4kMB: 2504.76 },
		f32: { id: 'Qwen2.5-Coder-3B-Instruct-q4f32_1-MLC', downloadBytes: 1749684427, vram4kMB: 2893.64 },
		note: 'recommended balance of quality and size'
	},
	{
		key: 'qwen-coder-7b', name: 'Qwen2.5-Coder 7B', params: '7B',
		kv: { layers: 28, kvHeads: 4, headDim: 128 },
		f16: { id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC', downloadBytes: 4297794106, vram4kMB: 5106.67 },
		f32: { id: 'Qwen2.5-Coder-7B-Instruct-q4f32_1-MLC', downloadBytes: 4297672215, vram4kMB: 5900.09 },
		note: 'best code, needs a strong GPU'
	}
];
export const DEFAULT_LOCAL_KEY = 'qwen-coder-3b';

export function isLocalBackend(id) { return typeof id === 'string' && id.startsWith(BACKEND_PREFIX); }
export function backendIdFor(key) { return BACKEND_PREFIX + key; }
export function modelFor(backendOrKey) {
	const key = isLocalBackend(backendOrKey) ? backendOrKey.slice(BACKEND_PREFIX.length) : backendOrKey;
	return LOCAL_MODELS.find(m => m.key === key) || null;
}

export function formatBytes(n) {
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
	return `${Math.round(n / 1e6)} MB`;
}

/** Estimated GPU memory at GS's 16k context, in bytes. */
export function gpuMemoryBytes(model, variant = 'f16') {
	const v = model[variant];
	if (!v) return null;
	const bytesPerValue = variant === 'f16' ? 2 : 4;
	const perToken = model.kv.layers * model.kv.kvHeads * model.kv.headDim * 2 * bytesPerValue;
	return Math.round(v.vram4kMB * 1048576 + perToken * (CONTEXT_WINDOW - WEBLLM_DEFAULT_CONTEXT));
}

/** GPU memory rounded up to 0.1 GB, e.g. "3.1 GB". */
export function formatGpuMemory(model, variant = 'f16') {
	if (!model[variant]) return null;
	return `${(Math.ceil(gpuMemoryBytes(model, variant) / 1e8) / 10).toFixed(1)} GB`;
}

/** Dropdown label, e.g. "Local: Qwen2.5-Coder 3B (WebLLM) — 1.75 GB download, needs ~3.1 GB GPU memory". */
export function optionLabel(model, variant = 'f16') {
	return `Local: ${model.name} (WebLLM) — ${formatBytes(model[variant].downloadBytes)} download, needs ~${formatGpuMemory(model, variant)} GPU memory`;
}

/** Option tooltip: also the 32-bit build's GPU memory (used on GPUs without shader-f16). */
export const NO_F16_NOTE = 'needs a GPU with 16-bit shader support (shader-f16): WebLLM has no 32-bit build of it';
export function optionTitle(model) {
	return `${model.name}: ${model.note}. ${formatBytes(model.f16.downloadBytes)} download. Needs about ${formatGpuMemory(model, 'f16')} of free GPU memory` +
		(model.f32 ? ` (about ${formatGpuMemory(model, 'f32')} on GPUs without 16-bit shader support, which get the 32-bit build). ` : `. It ${NO_F16_NOTE}. `) +
		`WebLLM lists ${(model.f16.vram4kMB * 1048576 / 1e9).toFixed(1)} GB at a 4k context; GS uses a 16k context.`;
}

// ---------------------------------------------------------------------------
// WebGPU support. hasWebGPU() is synchronous and fetches nothing (used while
// building the dropdown); checkWebGPU() asks for an adapter (no network).
export function hasWebGPU() { return typeof navigator !== 'undefined' && !!navigator.gpu; }

export async function checkWebGPU() {
	if (!hasWebGPU()) return { ok: false, reason: 'no-webgpu' };
	try {
		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) return { ok: false, reason: 'no-adapter' };
		const f16 = !!adapter.features?.has?.('shader-f16');
		return { ok: true, f16, variant: f16 ? 'f16' : 'f32' };
	} catch (err) {
		return { ok: false, reason: 'error', message: String(err?.message || err) };
	}
}

export const NO_WEBGPU_MSG = 'This browser can\'t run local models: they need WebGPU, which it doesn\'t provide. ' +
	'Use a recent desktop Chrome or Edge (or Safari 26+) with hardware acceleration on.';
export const NO_ADAPTER_MSG = 'WebGPU is turned on in this browser but it found no usable GPU, so local models can\'t run here.';

// ---------------------------------------------------------------------------
// "Downloaded" marks (set after a successful load; Cache Storage holds the files).
function readDownloaded() {
	try { return JSON.parse(localStorage.getItem(DOWNLOADED_KEY) || '[]'); } catch { return []; }
}
export function isMarkedDownloaded(modelId) { return readDownloaded().includes(modelId); }
function markDownloaded(modelId) {
	const list = readDownloaded();
	if (!list.includes(modelId)) list.push(modelId);
	try { localStorage.setItem(DOWNLOADED_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

/** Removes every downloaded WebLLM file (all local models) from this browser. */
export async function clearCache() {
	await unload();
	let removed = 0;
	if (typeof caches !== 'undefined') {
		for (const name of CACHE_NAMES) { if (await caches.delete(name)) removed++; }
	}
	try { localStorage.removeItem(DOWNLOADED_KEY); } catch { /* ignore */ }
	return removed;
}

// ---------------------------------------------------------------------------
// Engine: one at a time, in a Web Worker so the page keeps rendering.
let engine = null;       // WebWorkerMLCEngine
let worker = null;
let loadedId = null;     // WebLLM model_id currently loaded
let loadPromise = null;
let loadingId = null;
let loadTicket = 0;
let libPromise = null;

export function loadedModelId() { return loadedId; }
export function loadingModelId() { return loadingId; }
export function isLoaded(modelId) { return !!engine && loadedId === modelId; }

function importLib() {
	if (!libPromise) libPromise = import(/* @vite-ignore */ WEBLLM_CDN).catch((err) => { libPromise = null; throw err; });
	return libPromise;
}

/**
 * Loads a model (downloading it the first time). onProgress({ progress 0..1,
 * text, timeElapsed }) is WebLLM's initProgressCallback report.
 */
export function load(modelId, { onProgress } = {}) {
	if (isLoaded(modelId)) return Promise.resolve();
	if (loadPromise && loadingId === modelId) return loadPromise;
	const ticket = ++loadTicket;
	loadingId = modelId;
	const p = (async () => {
		const webllm = await importLib();
		if (ticket !== loadTicket) throw new Error('cancelled');
		const m = LOCAL_MODELS.find(x => x.f16?.id === modelId || x.f32?.id === modelId);
		const chatOpts = { context_window_size: CONTEXT_WINDOW, ...(m?.chatOpts || {}) };
		const report = (r) => { if (ticket === loadTicket) onProgress?.(r); };
		if (engine) {
			loadedId = null;
			// Same worker, different model: reload swaps the weights.
			engine.setInitProgressCallback?.(report);
			await engine.reload(modelId, chatOpts);
		} else {
			worker = new Worker(new URL('./webllmWorker.js', import.meta.url), { type: 'module' });
			const created = await webllm.CreateWebWorkerMLCEngine(worker, modelId, { initProgressCallback: report }, chatOpts);
			if (ticket !== loadTicket) { try { await created.unload?.(); } catch { /* ignore */ } throw new Error('cancelled'); }
			engine = created;
		}
		if (ticket !== loadTicket) throw new Error('cancelled');
		loadedId = modelId;
		markDownloaded(modelId);
	})();
	loadPromise = p;
	p.then(() => {}, () => {
		// A failed load leaves a half-made worker behind: drop it.
		if (ticket === loadTicket && !loadedId) dropWorker();
	}).finally(() => { if (loadPromise === p) { loadPromise = null; loadingId = null; } });
	return p;
}

function dropWorker() {
	try { worker?.terminate(); } catch { /* ignore */ }
	worker = null; engine = null; loadedId = null;
}

/** Cancels a load in progress and frees the GPU memory of a loaded model. */
export async function unload() {
	loadTicket++;
	loadPromise = null; loadingId = null;
	const e = engine;
	if (e) { try { await e.unload(); } catch { /* ignore */ } }
	dropWorker();
}

export function interrupt() { try { engine?.interruptGenerate(); } catch { /* ignore */ } }

// ---------------------------------------------------------------------------
// Chat. Messages may be strings or Claude/OpenAI content arrays (restored
// history): local models get the text parts only.
export function messageText(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n');
	return content == null ? '' : String(content);
}

const estTokens = (s) => Math.ceil((s || '').length / 3); // conservative for code-heavy text

/**
 * Fits system + history into the context window: keeps the system prompt and
 * the newest messages, drops the oldest, merges same-role neighbours (chat
 * templates expect user/assistant turns) and ends on a user message.
 */
export function fitMessages(systemPrompt, chatMessages, maxTokens, contextWindow = CONTEXT_WINDOW) {
	const flat = [];
	for (const m of chatMessages) {
		const role = m.role === 'assistant' ? 'assistant' : 'user';
		const text = messageText(m.content);
		if (!text) continue;
		const prev = flat[flat.length - 1];
		if (prev && prev.role === role) prev.content += `\n\n${text}`;
		else flat.push({ role, content: text });
	}
	while (flat.length && flat[0].role !== 'user') flat.shift();
	let budget = contextWindow - maxTokens - estTokens(systemPrompt) - 64;
	const kept = [];
	for (let i = flat.length - 1; i >= 0; i--) {
		const cost = estTokens(flat[i].content) + 8;
		if (cost > budget) {
			if (kept.length === 0) {
				// The newest message alone is too long: keep its start and end.
				const room = Math.max(256, budget * 3);
				const t = flat[i].content;
				kept.unshift({ role: flat[i].role, content: t.length > room ? `${t.slice(0, room / 2)}\n…\n${t.slice(-room / 2)}` : t });
			}
			break;
		}
		budget -= cost;
		kept.unshift(flat[i]);
	}
	while (kept.length && kept[0].role !== 'user') kept.shift();
	return [{ role: 'system', content: systemPrompt || '' }, ...kept];
}

/**
 * Runs one chat completion on the loaded model, streaming. onText(fullText)
 * gets the reply so far. Returns { content: [{ text }] } like /api/chat.
 */
export async function chat(systemPrompt, chatMessages, { modelId, maxTokens = 4096, onText, temperature = 0.4 } = {}) {
	if (!engine || (modelId && loadedId !== modelId)) throw new Error('The local model is not loaded yet. Click "Download & load" under the Model menu first.');
	const max = Math.min(maxTokens, 4096);
	const messages = fitMessages(systemPrompt, chatMessages, max);
	const stream = await engine.chat.completions.create({ messages, stream: true, max_tokens: max, temperature });
	let text = '';
	for await (const chunk of stream) {
		const delta = chunk?.choices?.[0]?.delta?.content || '';
		if (delta) { text += delta; onText?.(text); }
	}
	return { content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------------------
// One progress bar for the whole load. WebLLM's initProgressCallback reports
// several phases that each run 0 → 1: "Fetching param cache" (download, only
// when not cached yet), "Loading model from cache" (cache → GPU), "Loading GPU
// shader modules", then "Finish loading". Showing its `progress` as-is filled
// the bar to 100% once for the download and again for the GPU load. The
// tracker maps each phase onto its own slice of one 0–1 bar, never moves
// backwards and stops at 99% until the engine is actually ready (complete()).
const PHASES_WITH_DOWNLOAD = { start: [0, 0], fetch: [0, 0.8], load: [0.8, 0.95], shader: [0.95, 0.99], finish: [0.99, 0.99] };
const PHASES_CACHED = { start: [0, 0], fetch: [0, 0], load: [0, 0.9], shader: [0.9, 0.99], finish: [0.99, 0.99] };
const PHASE_LABEL = { start: 'Starting', fetch: 'Downloading', load: 'Loading onto the GPU', shader: 'Preparing the GPU', finish: 'Finishing' };

export function progressPhase(text = '') {
	if (/^Fetching param cache/i.test(text)) return 'fetch';
	if (/^Loading model from cache/i.test(text)) return 'load';
	if (/shader modules/i.test(text)) return 'shader';
	if (/^Finish loading/i.test(text)) return 'finish';
	if (/^Start to fetch/i.test(text)) return 'start';
	return null;
}

export function createProgressTracker() {
	let value = 0;
	let downloading = null; // true once a Fetching report is seen; false if loading began without one (cached)
	let label = '';
	let detail = '';
	let done = false;
	return {
		update(report) {
			if (done || !report) return this.snapshot();
			const text = String(report.text || '');
			const phase = progressPhase(text);
			if (phase === 'fetch') downloading = true;
			else if ((phase === 'load' || phase === 'shader') && downloading === null) downloading = false;
			if (phase) {
				const [a, b] = (downloading === false ? PHASES_CACHED : PHASES_WITH_DOWNLOAD)[phase];
				const p = Math.max(0, Math.min(1, Number(report.progress) || 0));
				value = Math.max(value, Math.min(0.99, a + (b - a) * p));
				label = PHASE_LABEL[phase];
			}
			// WebLLM's own "N% completed" is per phase: drop it so only one % shows.
			detail = text.replace(/\s*\d+% completed,?\s*/i, ' ').replace(/\s*It can take a while[\s\S]*$/i, '').trim();
			return this.snapshot();
		},
		complete() { done = true; value = 1; label = 'Ready'; return this.snapshot(); },
		snapshot() { return { progress: value, label, text: detail, done }; }
	};
}
