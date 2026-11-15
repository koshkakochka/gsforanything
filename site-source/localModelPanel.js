// The panel under the chat's Model menu for Local (WebLLM) models: the
// confirmation with the download size, the progress bar, the loaded state,
// and "Remove downloaded models". Picking a Local model only shows this panel;
// nothing downloads until its "Download & load" button is clicked (also after a
// reload that restored a saved Local choice). See localLLM.js.
import * as LocalLLM from './localLLM.js';

export function initLocalModelPanel({ row, confirm, isPhone = () => false, fallbackLabel = () => 'the previous model', onRevert, onChange } = {}) {
	if (!row) return null;
	row.innerHTML = `
		<div class="gs-webllm-title"></div>
		<div class="gs-webllm-info"></div>
		<div class="gs-webllm-warn" hidden></div>
		<div class="gs-webllm-progress" hidden>
			<div class="gs-webllm-bar"><div class="gs-webllm-fill"></div></div>
			<div class="gs-webllm-progress-text"></div>
		</div>
		<div class="gs-webllm-actions">
			<button type="button" class="dchat-btn gs-webllm-load" data-webllm="load"></button>
			<button type="button" class="dchat-btn gs-webllm-cancel" data-webllm="cancel"></button>
			<button type="button" class="dchat-btn gs-webllm-unload" data-webllm="unload" hidden>Unload</button>
			<button type="button" class="dchat-btn gs-webllm-clear" data-webllm="clear">Remove downloaded models</button>
		</div>`;
	const $ = (s) => row.querySelector(s);
	const titleEl = $('.gs-webllm-title');
	const infoEl = $('.gs-webllm-info');
	const warnEl = $('.gs-webllm-warn');
	const progEl = $('.gs-webllm-progress');
	const fillEl = $('.gs-webllm-fill');
	const progTextEl = $('.gs-webllm-progress-text');
	const loadBtn = $('[data-webllm="load"]');
	const cancelBtn = $('[data-webllm="cancel"]');
	const unloadBtn = $('[data-webllm="unload"]');
	const clearBtn = $('[data-webllm="clear"]');

	let backend = null;      // selected 'webllm:<key>' or null
	let state = 'hidden';    // hidden | idle | loading | ready | error
	let variant = 'f16';
	let gpu = null;          // last checkWebGPU() result
	let errorText = '';
	let tracker = LocalLLM.createProgressTracker();
	let progress = tracker.snapshot(); // one monotonic 0–1 bar for download + GPU load

	const model = () => LocalLLM.modelFor(backend);
	const modelId = () => model()?.[variant]?.id;

	function render() {
		const m = model();
		row.hidden = !m;
		row.style.display = m ? '' : 'none';
		row.dataset.state = state;
		if (!m) { onChange?.(); return; }
		if (!m[variant]) variant = 'f16'; // model without a 32-bit build (Gemma 3 1B)
		const v = m[variant];
		const size = LocalLLM.formatBytes(v.downloadBytes);
		const mem = LocalLLM.formatGpuMemory(m, variant);
		const f32Mem = variant === 'f16' ? (m.f32 ? ` (about ${LocalLLM.formatGpuMemory(m, 'f32')} on GPUs without 16-bit shader support)` : `; it ${LocalLLM.NO_F16_NOTE}`) : '';
		const cached = LocalLLM.isMarkedDownloaded(v.id);
		titleEl.textContent = `${m.name} — runs on this device (WebLLM)`;
		const f32Note = variant === 'f32' ? ' This GPU has no 16-bit shader support, so GS uses the 32-bit build of the same model.' : '';
		if (state === 'ready') {
			infoEl.textContent = `✓ Loaded. Chat replies are generated on this device; nothing is sent to a server. Uses about ${mem} of GPU memory.${f32Note}`;
		} else if (state === 'loading') {
			infoEl.textContent = cached
				? `Loading ${m.name} from this browser's cache…`
				: `Downloading ${m.name} (${size}). The browser keeps the files, so the next load won't download them again.`;
		} else if (state === 'error') {
			infoEl.textContent = errorText;
		} else {
			infoEl.textContent = cached
				? `Already downloaded on this device (${size}), so loading reads it from the browser cache. Needs about ${mem} of free GPU memory${f32Mem}.${f32Note}`
				: `First use downloads ${size} (plus the ${LocalLLM.formatBytes(LocalLLM.LIB_BYTES)} WebLLM library) from Hugging Face. Your browser caches it, so later loads don't download it again. Needs WebGPU and about ${mem} of free GPU memory${f32Mem}.${f32Note}`;
		}
		const phone = isPhone();
		warnEl.hidden = !(phone && state !== 'ready');
		warnEl.textContent = phone
			? `⚠ Phones usually can't run this: it needs WebGPU and about ${mem} of free GPU memory, and the ${size} download counts against your data plan. A desktop or laptop with a recent Chrome or Edge works best.`
			: '';
		progEl.hidden = state !== 'loading' || progress.done;
		const pct = Math.max(0, Math.min(1, Number(progress.progress) || 0));
		fillEl.style.width = `${(pct * 100).toFixed(1)}%`;
		progTextEl.textContent = `${Math.floor(pct * 100)}% · ${progress.label || 'Starting'}${progress.text ? ` — ${progress.text}` : '…'}`;
		loadBtn.hidden = state === 'loading' || state === 'ready';
		loadBtn.textContent = state === 'error' ? 'Try again' : cached ? 'Load from cache' : `Download & load (${size})`;
		cancelBtn.hidden = state === 'ready';
		cancelBtn.textContent = state === 'loading' ? 'Cancel' : `Use ${fallbackLabel()} instead`;
		unloadBtn.hidden = state !== 'ready';
		clearBtn.hidden = state === 'loading';
		onChange?.();
	}

	function setState(s) { state = s; render(); }

	async function startLoad() {
		const m = model();
		if (!m || state === 'loading') return;
		gpu = await LocalLLM.checkWebGPU();
		if (!gpu.ok) {
			unsupported(gpu.reason === 'no-adapter' ? LocalLLM.NO_ADAPTER_MSG : LocalLLM.NO_WEBGPU_MSG);
			return;
		}
		if (gpu.variant === 'f32' && !m.f32) {
			variant = 'f16';
			errorText = `This GPU has no 16-bit shader support (WebGPU shader-f16), and ${m.name} only comes as a 16-bit build in WebLLM, so it can't run here. Pick a Qwen2.5-Coder Local model instead (they have a 32-bit build).`;
			setState('error');
			return;
		}
		variant = gpu.variant;
		tracker = LocalLLM.createProgressTracker();
		progress = tracker.snapshot();
		setState('loading');
		const id = modelId();
		const forBackend = backend;
		try {
			await LocalLLM.load(id, {
				onProgress: (r) => { if (backend === forBackend) { progress = tracker.update(r); render(); } }
			});
			if (backend !== forBackend) return;
			// 100% only now, when the engine is ready (not when a phase reports 1).
			progress = tracker.complete();
			render();
			setState('ready');
		} catch (err) {
			if (backend !== forBackend || String(err?.message) === 'cancelled') return;
			console.error('Local model load failed:', err);
			const msg = String(err?.message || err);
			errorText = /shader-f16|FeatureNotSupported/i.test(msg)
				? `This GPU can't run the 16-bit build (${msg.slice(0, 160)}).`
				: /memory|OutOfMemory|device.*lost/i.test(msg)
					? `Not enough GPU memory for ${m.name}. Try a smaller Local model. (${msg.slice(0, 160)})`
					: `Couldn't load ${m.name}: ${msg.slice(0, 240)}`;
			setState('error');
		}
	}

	// No WebGPU: say why and go back to the previous (server) model.
	function unsupported(message) {
		const fb = fallbackLabel();
		backend = null;
		render();
		onRevert?.(`${message} Switched back to ${fb}.`);
	}

	loadBtn.addEventListener('click', () => { startLoad(); });
	cancelBtn.addEventListener('click', async () => {
		if (state === 'loading') {
			await LocalLLM.unload();
			setState('idle');
			return;
		}
		backend = null;
		render();
		onRevert?.('');
	});
	unloadBtn.addEventListener('click', async () => { await LocalLLM.unload(); setState('idle'); });
	clearBtn.addEventListener('click', async () => {
		const ok = await confirm?.('Remove every downloaded local model from this browser? You can download them again later.', { title: 'Remove downloaded models', okLabel: 'Remove' });
		if (!ok) return;
		await LocalLLM.clearCache();
		if (backend) setState('idle');
	});

	return {
		/** A Local option was picked (or restored on page load). Never downloads. */
		select(id) {
			backend = id;
			if (!LocalLLM.hasWebGPU()) { unsupported(LocalLLM.NO_WEBGPU_MSG); return false; }
			const m = model();
			const loadedVariant = ['f16', 'f32'].find(v => LocalLLM.isLoaded(m?.[v]?.id));
			if (loadedVariant) { variant = loadedVariant; setState('ready'); return true; }
			if (LocalLLM.loadingModelId() && ['f16', 'f32'].some(v => LocalLLM.loadingModelId() === m?.[v]?.id)) { setState('loading'); return true; }
			if (LocalLLM.loadingModelId() || LocalLLM.loadedModelId()) LocalLLM.unload();
			variant = gpu?.variant || 'f16';
			setState('idle');
			return true;
		},
		/** A server model was picked: hide the panel and free the GPU. */
		deselect() {
			const had = !!LocalLLM.loadedModelId() || !!LocalLLM.loadingModelId();
			backend = null;
			if (had) LocalLLM.unload();
			setState('hidden');
		},
		/** The model id to send chats to, or throws if it is not loaded yet. */
		requireLoadedModelId() {
			const id = modelId();
			if (!id || !LocalLLM.isLoaded(id)) {
				throw new Error(`${model()?.name || 'The local model'} isn't loaded yet. Click "${loadBtn.textContent}" under the Model menu first.`);
			}
			return id;
		},
		displayName() { const m = model(); return m ? `${m.name} (local)` : null; },
		state: () => ({ backend, state, variant, modelId: modelId(), progress: { ...progress }, errorText }),
		load: startLoad,
		render
	};
}
