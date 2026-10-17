/**
 * Community scene merge: pick two Community scenes (A and B), describe how to
 * combine them, and let the AI write one new merged scene.
 *
 * Flow (all client side; the AI call goes through the same backend path as
 * the scene chat, so it works on Vercel, Cloudflare and Ollama alike):
 *   1. fetch both scene records (+ their creation context from PR #4, if any)
 *   2. buildMergeRequest(): every large literal in the code (base64 images,
 *      data: URLs, p5-import asset files, very long text) is swapped for an
 *      asset token (__GS_ASSET_B3__) so the AI never sees or retypes it; very
 *      large blocks are summarised and can only be kept whole (@gs-keep).
 *   3. the AI replies with vr-exec blocks; expandMergedBlocks() replaces
 *      `// @gs-keep A2` lines with the original block and every asset token
 *      with the original literal, byte for byte
 *   4. main.js runs the blocks with the normal auto-fix and installs them as a
 *      NEW scene ("A + B (merged)"); the originals are never modified
 *   5. the chat + creation context record the merge (parents, prompt, picks),
 *      and the scene carries `mergedFrom` credits when saved or published.
 *
 * The merge picker is a desktop / phone dialog. In a headset the merged scene
 * runs and shows like any other scene; the picker itself isn't drawn in VR.
 */

export const MERGE_LIMITS = {
	assetMinBase64: 800,       // base64 / data: literals at least this long become asset tokens
	assetMinText: 40_000,      // any other literal at least this long becomes an asset token
	blockFullMax: 30_000,      // blocks longer than this (after tokens) are summarised, keep-only
	codeBudget: 120_000,       // total code characters sent for both scenes
	historyChars: 3_000,       // creation-history summary per scene
	promptChars: 4_000
};

export const PICK_ASPECTS = [
	{ id: 'gameplay', label: 'Gameplay logic' },
	{ id: 'controls', label: 'Controls / input' },
	{ id: 'assets', label: 'Assets / models' },
	{ id: 'environment', label: 'Environment / lighting' },
	{ id: 'ui', label: 'UI / HUD' }
];

const TOKEN_RE = /(["'`]?)__GS_ASSET_([AB]\d+)__\1/g;
const KEEP_LINE_RE = /^[ \t]*\/\/[ \t]*@gs-keep[ \t]+([AB])(\d+)[ \t]*$/gm;

// ---------------------------------------------------------------------------
// Asset extraction (pure; exported for tests)
// ---------------------------------------------------------------------------

/** Walk JS source and return string / template literals with their spans. */
export function findStringLiterals(code) {
	const out = [];
	const n = code.length;
	let i = 0;
	while (i < n) {
		const c = code[i];
		const d = code[i + 1];
		if (c === '/' && d === '/') { const e = code.indexOf('\n', i); i = e < 0 ? n : e; continue; }
		if (c === '/' && d === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
		if (c === '"' || c === "'" || c === '`') {
			const start = i;
			let j = i + 1;
			let hasInterp = false;
			let ok = false;
			while (j < n) {
				const ch = code[j];
				if (ch === '\\') { j += 2; continue; }
				if (c === '`' && ch === '$' && code[j + 1] === '{') hasInterp = true;
				if (ch === c) { ok = true; break; }
				if (c !== '`' && ch === '\n') break;
				j++;
			}
			if (!ok) { i++; continue; }
			out.push({ start, end: j + 1, quote: c, body: code.slice(start + 1, j), hasInterp });
			i = j + 1;
			continue;
		}
		i++;
	}
	return out;
}

function classifyLiteral(lit) {
	const body = lit.body;
	if (lit.hasInterp) return null;
	if (body.length >= MERGE_LIMITS.assetMinBase64) {
		if (/^data:[\w.+-]+\/[\w.+-]+(;[\w=.-]+)*;base64,/i.test(body)) return { kind: 'data-url', mime: body.slice(5, body.indexOf(';')) };
		const ws = (body.match(/\s|\\n/g) || []).length;
		if (/^[A-Za-z0-9+/=_\-\s\\]+$/.test(body) && ws < body.length / 50) return { kind: 'base64' };
	}
	if (body.length >= MERGE_LIMITS.assetMinText) return { kind: 'text' };
	return null;
}

/**
 * Replace large literals in one code block with asset tokens.
 * @returns {{ code: string, assets: Array<{ token, id, literal, kind, mime, chars, hint }> }}
 */
export function tokenizeAssets(code, prefix, counter) {
	const lits = findStringLiterals(code);
	const assets = [];
	let out = '';
	let last = 0;
	for (const lit of lits) {
		const cls = classifyLiteral(lit);
		if (!cls) continue;
		counter.n += 1;
		const id = `${prefix}${counter.n}`;
		const token = `__GS_ASSET_${id}__`;
		const literal = code.slice(lit.start, lit.end);
		const before = code.slice(Math.max(0, lit.start - 80), lit.start).replace(/\s+/g, ' ');
		const after = code.slice(lit.end, lit.end + 60).replace(/\s+/g, ' ');
		const typeHint = (after.match(/["']?type["']?\s*:\s*["']([\w.+-]+\/[\w.+-]+)["']/) || [])[1];
		assets.push({
			token, id, literal, kind: cls.kind,
			mime: cls.mime || typeHint || null,
			chars: lit.body.length,
			hint: `…${before.slice(-60)}⟨here⟩${after.slice(0, 40)}…`,
			preview: cls.kind === 'text' ? lit.body.slice(0, 200) : undefined
		});
		out += code.slice(last, lit.start) + token;
		last = lit.end;
	}
	out += code.slice(last);
	return { code: out, assets };
}

/** Short structural summary for blocks too large to send in full. */
export function summarizeBlock(code, maxChars = 3_000) {
	const lines = code.split('\n');
	const keep = [];
	const interesting = /(\bname\s*[:=]|\.name\s*=|new THREE\.|scene\.add|gsRequire|gsImportP5Sketch|gsCreateP5Surface|gsCreateCanvasSurface|gsGamepad|gs\.state|gsState|_vrAnimations|onUpdate|addEventListener|^\s*(async\s+)?function\b|^\s*(const|let|var|class)\s+\w+)/;
	for (const line of lines) if (interesting.test(line)) keep.push(line.length > 200 ? line.slice(0, 200) + '…' : line);
	let s = keep.join('\n');
	if (s.length > maxChars) s = s.slice(0, maxChars) + '\n…';
	return s;
}

function settingsLine(settings) {
	if (!settings) return 'unknown (no creation context)';
	const env = settings.environment ? `${settings.environment.dim === '2d' ? '2D' : '3D'} / ${settings.environment.lib}` : 'unknown';
	const deps = Array.isArray(settings.dependencies) ? settings.dependencies.map(d => `${d.name || d.id} ${d.enabled ? 'on' : 'off'}`).join(', ') : 'unknown';
	return `Environment: ${env}; Dependencies: ${deps}`;
}

function historySummary(payload, max = MERGE_LIMITS.historyChars) {
	if (!payload || !Array.isArray(payload.chat)) return null;
	const prompts = payload.chat.filter(e => e.role === 'user' && e.text).map(e => `- ${String(e.text).replace(/\s+/g, ' ').slice(0, 300)}`);
	const files = (payload.files || []).map(f => f.name);
	let s = `${prompts.length} prompt(s)${payload.models?.length ? ` with ${payload.models.join(', ')}` : ''}:\n${prompts.join('\n')}`;
	if (files.length) s += `\nFiles used: ${files.join(', ')}`;
	if (Array.isArray(payload.merges) && payload.merges.length) s += `\nThis scene was itself merged from: ${payload.merges.map(m => (m.parents || []).map(p => `"${p.name}"`).join(' + ')).join('; ')}`;
	if (s.length > max) s = s.slice(0, max) + '\n…';
	return s;
}

/**
 * Build everything sent to the AI plus the lookup tables used afterwards.
 * scenes: [{ label:'A'|'B', id, name, codeBlocks, context:{ payload }|null, mergedFrom }]
 */
export function buildMergeRequest({ sceneA, sceneB, prompt, picks = {} }) {
	const tables = { assets: new Map(), blocks: new Map() };
	const parts = [];
	let sentChars = 0;
	const prepared = [];
	for (const sc of [sceneA, sceneB]) {
		const counter = { n: 0 };
		const blocks = (sc.codeBlocks || []).map((code, i) => {
			const key = `${sc.label}${i + 1}`;
			const { code: tokenized, assets } = tokenizeAssets(String(code ?? ''), sc.label, counter);
			for (const a of assets) tables.assets.set(a.id, a);
			tables.blocks.set(key, String(code ?? ''));
			return { key, original: String(code ?? ''), tokenized, assets };
		});
		prepared.push({ sc, blocks });
	}
	// Decide which blocks are shown in full: everything that fits, largest summarised first.
	const all = prepared.flatMap(p => p.blocks);
	for (const b of all) b.full = b.tokenized.length <= MERGE_LIMITS.blockFullMax;
	let total = all.filter(b => b.full).reduce((n, b) => n + b.tokenized.length, 0);
	for (const b of [...all].sort((x, y) => y.tokenized.length - x.tokenized.length)) {
		if (total <= MERGE_LIMITS.codeBudget) break;
		if (b.full) { b.full = false; total -= b.tokenized.length; }
	}
	const pickLines = [];
	for (const a of PICK_ASPECTS) {
		const v = picks[a.id];
		if (v === 'A' || v === 'B') pickLines.push(`- ${a.label}: from ${v}`);
		else if (v === 'both') pickLines.push(`- ${a.label}: combine A and B`);
	}
	const userPrompt = String(prompt || '').slice(0, MERGE_LIMITS.promptChars).trim();
	parts.push(`[GS scene merge request]
Merge the two GS Community scenes below into ONE new, coherent scene. The world is empty when your code runs: neither original is loaded, and both originals stay unchanged.

How to answer:
1. Write the complete merged scene as one or more \`\`\`vr-exec blocks, in the order they should run.
2. To reuse a source block exactly as it is, write a vr-exec block (or a line inside one) that is only \`// @gs-keep A2\` (scene A, block 2). GS pastes the original block there. Prefer this for big blocks you don't need to change, then adjust their objects by name in a following block. Blocks marked "summary only" can only be reused this way.
3. Large data (base64 images, audio, models, data: URLs, imported sketch asset files, very long text) was replaced with asset tokens such as __GS_ASSET_B3__. Each token stands for a whole JavaScript literal, quotes included. Use the token as a bare expression wherever that value belongs (e.g. \`{ "base64": __GS_ASSET_B3__, "type": "image/png" }\` or \`loader.load(__GS_ASSET_A1__)\`). Never put a token in quotes, never write out base64, never invent data. GS swaps the real data back in after you answer.
4. Follow the GS conventions: unique, stable object names (rename where A and B clash, e.g. "a_floor" vs "b_floor", and keep one floor/sky/main light unless asked otherwise); keep score and game state in gs.state or window.gsState (\`gs.state.score ??= 0\`); controllers through gsGamepad (only one part of the scene sets gsGamepad.captureCamera); physics through \`await gsRequire('ammo')\` with ONE shared btDiscreteDynamicsWorld on window (merge the two worlds if both scenes have one); p5 through gsCreateP5Surface, and keep imported sketches as gsImportP5Sketch calls with their files; per-frame logic in window._vrAnimations or gs.onUpdate. Remove duplicate per-frame loops and conflicting input bindings.
5. After the code, add 2-4 short plain lines saying what came from A and what came from B.
${pickLines.length ? `\nWhat to take from each scene (quick picks):\n${pickLines.join('\n')}\n` : ''}
User's merge instructions: ${userPrompt ? `"${userPrompt}"` : '(none given: combine the best of both sensibly)'}`);
	for (const { sc, blocks } of prepared) {
		const lines = [`\n=== Scene ${sc.label}: "${sc.name || 'Untitled'}"${sc.id ? ` (id ${sc.id})` : ''} ===`];
		lines.push(`Settings: ${settingsLine(sc.context?.payload?.settings)}`);
		const hist = historySummary(sc.context?.payload);
		lines.push(hist ? `Creation history (summary):\n${hist}` : 'Creation history: none saved.');
		if (sc.mergedFrom?.length) lines.push(`Credits: merged from ${sc.mergedFrom.map(p => `"${p.name}"`).join(' + ')}`);
		const assets = blocks.flatMap(b => b.assets);
		if (assets.length) {
			lines.push('Asset tokens:');
			for (const a of assets) lines.push(`- __GS_ASSET_${a.id}__: ${a.kind === 'text' ? `long text, ${a.chars.toLocaleString()} chars, starts "${(a.preview || '').replace(/\s+/g, ' ').slice(0, 120)}"` : `${a.kind === 'data-url' ? 'data: URL' : 'base64 data'}${a.mime ? ` (${a.mime})` : ''}, ${a.chars.toLocaleString()} chars`}; found at ${a.hint}`);
		}
		lines.push(`Code blocks (${blocks.length}):`);
		for (const b of blocks) {
			if (b.full) {
				lines.push(`--- ${b.key} (${b.original.length.toLocaleString()} chars) ---\n\`\`\`js\n${b.tokenized}\n\`\`\``);
				sentChars += b.tokenized.length;
			} else {
				const sum = summarizeBlock(b.tokenized);
				lines.push(`--- ${b.key} (summary only: ${b.tokenized.length.toLocaleString()} chars is too large to show; reuse it whole with // @gs-keep ${b.key}) ---\n\`\`\`js\n${sum}\n\`\`\``);
				sentChars += sum.length;
			}
		}
		parts.push(lines.join('\n'));
	}
	const message = parts.join('\n');
	const stats = {
		assets: tables.assets.size,
		assetChars: [...tables.assets.values()].reduce((n, a) => n + a.chars, 0),
		blocks: all.length,
		summarized: all.filter(b => !b.full).map(b => b.key),
		sentCodeChars: sentChars,
		messageChars: message.length
	};
	return { message, tables, stats };
}

/**
 * Expand @gs-keep lines and asset tokens in the AI's blocks.
 * @returns {{ blocks: string[], kept: string[], restored: string[] }}
 */
export function expandMergedBlocks(codeBlocks, tables) {
	const kept = [];
	const restored = [];
	const blocks = codeBlocks.map((code) => {
		let s = String(code ?? '');
		s = s.replace(KEEP_LINE_RE, (m, label, num) => {
			const key = `${label}${num}`;
			if (!tables.blocks.has(key)) throw new Error(`The AI asked to keep block ${key}, which doesn't exist`);
			kept.push(key);
			return tables.blocks.get(key);
		});
		// Tokens left in kept blocks are impossible (originals have no tokens);
		// tokens the AI wrote are swapped for the original literal.
		s = s.replace(TOKEN_RE, (m, q, id) => {
			const a = tables.assets.get(id);
			if (!a) throw new Error(`The AI used an unknown asset token __GS_ASSET_${id}__`);
			restored.push(id);
			return a.literal;
		});
		return s;
	}).filter(b => b.trim());
	return { blocks, kept, restored };
}

/** Swap known asset literals in finished code back to their tokens (for auto-fix requests). */
export function retokenize(code, tables) {
	let s = String(code ?? '');
	const assets = [...tables.assets.values()].sort((x, y) => y.literal.length - x.literal.length);
	for (const a of assets) if (s.includes(a.literal)) s = s.split(a.literal).join(a.token);
	return s;
}

function defineAssetGlobals(tables) {
	if (typeof window === 'undefined') return;
	for (const a of tables.assets.values()) {
		try {
			// The literal is a plain string/template literal taken from scene code.
			window[a.token] = Function(`"use strict"; return (${a.literal});`)();
		} catch { /* left undefined; the expanded code doesn't need it */ }
	}
}

export function mergedSceneName(a, b) {
	return `${a?.name || 'A'} + ${b?.name || 'B'} (merged)`.slice(0, 80);
}

// ---------------------------------------------------------------------------
// UI (desktop / phone)
// ---------------------------------------------------------------------------
let host = null;
let state = { a: null, b: null, scenes: [] };
let dialog = null;
let busy = false;

const CSS = `
#gs-merge-bar { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
#gs-merge-bar .gs-merge-sel { font-size: 12px; opacity: 0.8; }
.dchat-btn.gs-merge-row-btn.picked { background: #f59e0b; color: #111; }
#gs-merge-modal { display: none; position: fixed; inset: 0; z-index: 3150; background: rgba(0,0,0,0.6); align-items: center; justify-content: center; pointer-events: auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
#gs-merge-modal.visible { display: flex; }
#gs-merge-inner { background: rgba(30,30,40,0.98); color: #fff; border-radius: 16px; padding: 18px; width: min(600px, 96vw); max-height: 92vh; overflow: auto; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); }
#gs-merge-inner h3 { margin: 0; font-size: 18px; }
.gs-merge-sub { font-size: 12px; opacity: 0.7; line-height: 1.4; }
.gs-merge-pick { display: grid; grid-template-columns: 24px 1fr; gap: 6px 8px; align-items: center; }
.gs-merge-pick b { color: #f59e0b; }
.gs-merge-pick input[type=search], #gs-merge-inner select, #gs-merge-inner textarea { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 7px; font-size: 14px; }
#gs-merge-inner select option { color: #000; }
#gs-merge-inner textarea { min-height: 90px; resize: vertical; font-family: inherit; }
.gs-merge-aspects { display: grid; grid-template-columns: 1fr repeat(3, auto); gap: 4px 10px; font-size: 13px; align-items: center; }
.gs-merge-aspects .h { font-size: 11px; opacity: 0.6; text-align: center; }
.gs-merge-aspects label { display: flex; justify-content: center; }
.gs-merge-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.gs-merge-actions button { border: none; border-radius: 10px; padding: 9px 14px; background: rgba(255,255,255,0.12); color: #fff; cursor: pointer; font-size: 14px; }
.gs-merge-actions button.primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.gs-merge-actions button:disabled { opacity: 0.5; cursor: default; }
#gs-merge-status { font-size: 13px; min-height: 18px; white-space: pre-wrap; }
#gs-merge-status.error { color: #fca5a5; }
.gs-merge-check { display: flex; gap: 8px; font-size: 13px; align-items: flex-start; }
body.display-only #gs-merge-bar, body.display-only .gs-merge-row-btn { display: none !important; }
`;

function el(tag, attrs = {}, ...kids) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') n.className = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
	return n;
}

export function initCommunityMerge(hostApi) {
	host = hostApi || {};
	if (typeof document === 'undefined' || document.getElementById('gs-merge-style')) return;
	const style = el('style', { id: 'gs-merge-style' });
	style.textContent = CSS;
	document.head.appendChild(style);
	const list = document.getElementById('dchat-community-list');
	if (list) {
		const bar = el('div', { id: 'gs-merge-bar' },
			el('button', { type: 'button', class: 'dchat-btn accent', id: 'gs-merge-open', title: 'Combine two Community scenes into a new one with the AI', onclick: () => openMergeDialog() }, '🔀 Merge scenes'),
			el('span', { class: 'gs-merge-sel', id: 'gs-merge-sel' }, 'or press Merge on two scenes below')
		);
		list.parentNode.insertBefore(bar, list);
	}
}

function sceneLabel(cs) { return cs ? `${cs.name || 'Untitled'}` : '—'; }

function updateBar() {
	const sel = document.getElementById('gs-merge-sel');
	if (sel) sel.textContent = state.a || state.b
		? `A: ${sceneLabel(state.a)} · B: ${sceneLabel(state.b)}`
		: 'or press Merge on two scenes below';
	for (const btn of document.querySelectorAll('.gs-merge-row-btn')) {
		const id = btn.dataset.sceneId;
		const tag = state.a?.id === id ? 'A' : state.b?.id === id ? 'B' : '';
		btn.classList.toggle('picked', !!tag);
		btn.textContent = tag ? `Merge ${tag} ✓` : 'Merge';
	}
}

/** Adds a "Merge" toggle to a Community row (called from renderCommunitySceneList). */
export function decorateCommunityRow(actions, cs) {
	if (!actions || !cs?.id) return;
	const btn = el('button', { type: 'button', class: 'dchat-btn gs-merge-row-btn', 'data-scene-id': cs.id, title: 'Pick this scene for a merge' }, 'Merge');
	btn.addEventListener('click', () => {
		if (state.a?.id === cs.id) state.a = null;
		else if (state.b?.id === cs.id) state.b = null;
		else if (!state.a) state.a = cs;
		else if (!state.b) state.b = cs;
		else state.b = cs;
		updateBar();
		if (state.a && state.b) openMergeDialog();
	});
	actions.appendChild(btn);
	queueMicrotask(updateBar);
}

async function loadSceneList() {
	try {
		const cached = host?.getCommunityScenes?.() || [];
		if (cached.length) return cached;
		const res = await fetch('/api/community-scenes');
		const data = await res.json();
		return data.scenes || [];
	} catch { return []; }
}

export async function openMergeDialog() {
	if (host?.isDisplayOnly?.()) return;
	state.scenes = await loadSceneList();
	if (!dialog) {
		dialog = el('div', { id: 'gs-merge-modal', role: 'dialog', 'aria-labelledby': 'gs-merge-title' });
		document.body.appendChild(dialog);
	}
	dialog.innerHTML = '';
	const pickers = {};
	const mkPicker = (slot) => {
		const search = el('input', { type: 'search', placeholder: 'Search Community scenes…', id: `gs-merge-search-${slot}`, 'aria-label': `Search for scene ${slot}` });
		const select = el('select', { id: `gs-merge-${slot}`, 'aria-label': `Scene ${slot}` });
		const fill = () => {
			const q = search.value.trim().toLowerCase();
			const cur = state[slot.toLowerCase()]?.id || select.value;
			select.innerHTML = '';
			select.appendChild(el('option', { value: '' }, `Choose scene ${slot}…`));
			for (const cs of state.scenes) {
				if (q && !`${cs.name} ${cs.id}`.toLowerCase().includes(q)) continue;
				const o = el('option', { value: cs.id }, `${cs.name}${cs.createdAt ? ` · ${new Date(cs.createdAt).toLocaleDateString()}` : ''}`);
				select.appendChild(o);
			}
			if (cur && [...select.options].some(o => o.value === cur)) select.value = cur;
		};
		search.addEventListener('input', fill);
		select.addEventListener('change', () => { state[slot.toLowerCase()] = state.scenes.find(s => s.id === select.value) || null; updateBar(); });
		fill();
		pickers[slot] = { search, select, fill };
		return el('div', { class: 'gs-merge-pick' }, el('b', {}, slot), select, el('span'), search);
	};
	const aspects = el('div', { class: 'gs-merge-aspects' }, el('span', { class: 'h' }, ''), el('span', { class: 'h' }, 'from A'), el('span', { class: 'h' }, 'from B'), el('span', { class: 'h' }, 'both'));
	for (const a of PICK_ASPECTS) {
		aspects.appendChild(el('span', {}, a.label));
		for (const v of ['A', 'B', 'both']) {
			const cb = el('input', { type: 'checkbox', 'data-aspect': a.id, 'data-from': v, 'aria-label': `${a.label} from ${v}` });
			cb.addEventListener('change', () => {
				if (cb.checked) for (const o of aspects.querySelectorAll(`[data-aspect="${a.id}"]`)) if (o !== cb) o.checked = false;
			});
			aspects.appendChild(el('label', {}, cb));
		}
	}
	const prompt = el('textarea', { id: 'gs-merge-prompt', placeholder: 'How should they be merged? e.g. "Gameplay and controls from A, assets and art style from B, keep B\'s lighting."' });
	const model = el('select', { id: 'gs-merge-model', 'aria-label': 'Model' });
	const src = host?.getModelSelect?.();
	if (src) {
		for (const o of src.options) model.appendChild(el('option', { value: o.value, ...(o.disabled ? { disabled: true } : {}) }, o.textContent));
		model.value = src.value;
		model.addEventListener('change', () => { src.value = model.value; src.dispatchEvent(new Event('change', { bubbles: true })); });
	}
	const replace = el('input', { type: 'checkbox', id: 'gs-merge-replace' });
	replace.checked = true;
	const status = el('div', { id: 'gs-merge-status' });
	const go = el('button', { type: 'button', class: 'primary', id: 'gs-merge-go' }, 'Merge');
	const cancel = el('button', { type: 'button', id: 'gs-merge-cancel', onclick: () => { if (!busy) closeMergeDialog(); } }, 'Close');
	go.addEventListener('click', async () => {
		if (busy) return;
		const a = state.scenes.find(s => s.id === pickers.A.select.value);
		const b = state.scenes.find(s => s.id === pickers.B.select.value);
		if (!a || !b) { setStatus('Pick two scenes first.', true); return; }
		if (a.id === b.id) { setStatus('Pick two different scenes.', true); return; }
		const picks = {};
		for (const cb of aspects.querySelectorAll('input:checked')) picks[cb.dataset.aspect] = cb.dataset.from;
		busy = true; go.disabled = true; cancel.disabled = true;
		try {
			await runMerge({ a, b, prompt: prompt.value, picks, replaceWorld: replace.checked, onStatus: (t) => setStatus(t) });
			closeMergeDialog();
			state.a = state.b = null;
			updateBar();
		} catch (err) {
			console.warn('merge failed:', err);
			setStatus(`Merge failed: ${err.message}`, true);
		} finally {
			busy = false; go.disabled = false; cancel.disabled = false;
		}
	});
	function setStatus(t, isErr = false) { status.textContent = t; status.classList.toggle('error', !!isErr); }
	dialog.appendChild(el('div', { id: 'gs-merge-inner' },
		el('h3', { id: 'gs-merge-title' }, '🔀 Merge two Community scenes'),
		el('div', { class: 'gs-merge-sub' }, 'The AI writes one new scene from A and B. Both originals stay as they are; the result loads as a new scene you can keep chatting about, save or publish (it credits both).'),
		mkPicker('A'), mkPicker('B'),
		el('div', { class: 'gs-merge-sub' }, 'What to take from each (optional):'),
		aspects,
		prompt,
		el('div', { class: 'gs-merge-pick' }, el('span', {}, '🤖'), model),
		el('label', { class: 'gs-merge-check' }, replace, el('span', {}, 'Replace what\'s in the world now (your current scene stays in the Scenes list)')),
		status,
		el('div', { class: 'gs-merge-actions' }, cancel, go)
	));
	dialog.classList.add('visible');
	if (state.a) { pickers.A.select.value = state.a.id; }
	if (state.b) { pickers.B.select.value = state.b.id; }
	if (state.scenes.length < 2) setStatus('There need to be at least two Community scenes to merge.', true);
}

export function closeMergeDialog() { dialog?.classList.remove('visible'); }

async function fetchSceneWithContext(cs) {
	const res = await fetch(`/api/community-scenes/${encodeURIComponent(cs.id)}`);
	const data = await res.json().catch(() => ({}));
	if (!res.ok || !Array.isArray(data.codeBlocks)) throw new Error(`Couldn't load "${cs.name}": ${data.error || res.status}`);
	let context = null;
	try { context = data.creationContext ? await host?.loadContext?.(data) : null; } catch (err) { console.warn('merge: context load failed', err); }
	return { id: data.id || cs.id, name: data.name || cs.name, codeBlocks: data.codeBlocks, context, mergedFrom: data.mergedFrom || null };
}

/** The whole merge. Exported for tests and for a future VR entry point. */
export async function runMerge({ a, b, prompt = '', picks = {}, replaceWorld = true, onStatus = () => {} }) {
	onStatus(`Loading "${a.name}" and "${b.name}"…`);
	const [sa, sb] = await Promise.all([fetchSceneWithContext(a), fetchSceneWithContext(b)]);
	sa.label = 'A'; sb.label = 'B';
	const req = buildMergeRequest({ sceneA: sa, sceneB: sb, prompt, picks });
	const modelName = host?.getModelLabel?.() || 'the AI';
	onStatus(`Merging with ${modelName}… (${req.stats.messageChars.toLocaleString()} characters sent, ${req.stats.assets} asset${req.stats.assets === 1 ? '' : 's'} kept out of the prompt)`);
	const name = mergedSceneName(sa, sb);
	const parents = [{ id: sa.id, name: sa.name }, { id: sb.id, name: sb.name }];
	const raw = await host.callChat([{ role: 'user', content: req.message }]);
	const parsed = host.parseVrExecBlocks(raw);
	const codeBlocks = parsed.codeBlocks;
	const displayText = String(parsed.displayText || '').replace(TOKEN_RE, (m, q, id) => `‹asset ${id}›`);
	if (!codeBlocks.length) throw new Error('The AI reply had no vr-exec code. Try again or rephrase the merge prompt.');
	const expanded = expandMergedBlocks(codeBlocks, req.tables);
	onStatus(`Running the merged scene (${expanded.blocks.length} blocks)…`);
	// While the merged code runs (and through any auto-fix), tokens also
	// resolve as globals, so a fix can be written against the tokenised code.
	defineAssetGlobals(req.tables);
	const result = await host.installMergedScene({
		name, codeBlocks: expanded.blocks, mergedFrom: parents, replaceWorld,
		tokenize: (code) => retokenize(code, req.tables),
		expand: (code) => expandMergedBlocks([code], req.tables).blocks[0] || ''
	});
	const pickText = PICK_ASPECTS.filter(x => picks[x.id]).map(x => `${x.label}: ${picks[x.id] === 'both' ? 'both' : `from ${picks[x.id]}`}`).join(', ');
	const summaryNote = `[Merged scene "${name}" loaded: ${expanded.blocks.length} block${expanded.blocks.length === 1 ? '' : 's'}${expanded.kept.length ? `, ${expanded.kept.length} reused as-is (${expanded.kept.join(', ')})` : ''}${expanded.restored.length ? `, ${new Set(expanded.restored).size} embedded asset${new Set(expanded.restored).size === 1 ? '' : 's'} carried over` : ''}${result?.fixed ? `, ${result.fixed} auto-fixed` : ''}${result?.failed ? `, ${result.failed} failed` : ''}. Originals unchanged.]`;
	const userDisplay = `🔀 Merge "${sa.name}" (A) + "${sb.name}" (B)${prompt.trim() ? `\n${prompt.trim()}` : ''}${pickText ? `\n${pickText}` : ''}`;
	const userApi = `[I merged two Community scenes with GS's merge tool: A = "${sa.name}" (id ${sa.id}), B = "${sb.name}" (id ${sb.id}). Instructions: ${prompt.trim() ? `"${prompt.trim()}"` : 'none'}${pickText ? `; picks: ${pickText}` : ''}. The full code of both was sent with that request. The merged scene is now loaded as "${name}".]`;
	const assistantApi = `${raw}\n\n[GS note: "// @gs-keep" lines and __GS_ASSET_*__ tokens above were expanded to the original code and data when the scene loaded; the running scene has the real code. To change it, write new vr-exec blocks that modify the existing objects by name.]`;
	host.appendChat?.(
		[{ role: 'user', content: userApi }, { role: 'assistant', content: assistantApi }],
		[{ role: 'user', content: userDisplay }, { role: 'assistant', content: `${displayText.trim()}\n\n${summaryNote}`.trim() }]
	);
	host.recordMerge?.({
		parents, prompt: prompt.trim(), picks, resultName: name,
		userText: userDisplay, raw: assistantApi, display: `${displayText.trim()}\n\n${summaryNote}`.trim(),
		stats: { ...req.stats, kept: expanded.kept, restoredAssets: [...new Set(expanded.restored)] }
	});
	host.updateStatus?.(`Merged "${sa.name}" + "${sb.name}"`, 'connected');
	return { name, parents, blocks: expanded.blocks, stats: req.stats, kept: expanded.kept, restored: expanded.restored, result };
}

/** Credits for buildSceneData(): mergedFrom of the active merged scene(s). */
export function sceneCredits(loadedScenes) {
	const parents = [];
	for (const sc of loadedScenes || []) {
		if (!sc.active || !Array.isArray(sc.mergedFrom)) continue;
		for (const p of sc.mergedFrom) if (p && !parents.some(x => x.id === p.id)) parents.push({ id: p.id || null, name: String(p.name || 'Untitled').slice(0, 80) });
	}
	if (!parents.length) return {};
	return { mergedFrom: parents, credits: `Merged from ${parents.map(p => `"${p.name}"`).join(' + ')}` };
}

export function _debugState() { return { a: state.a?.id || null, b: state.b?.id || null, scenes: state.scenes.length }; }
