/**
 * Scene creation context: the chat log and info log that produced a scene.
 *
 * While you work, this module keeps a session log of every scene-chat turn
 * (prompt, reply, backend/model, timestamps, attached files, editor settings),
 * auto-fix notes and Code-tab edits. When a scene is saved or published, the
 * log is scrubbed of obvious secrets, size-capped, gzip-compressed and
 * attached to the scene as `creationContext` (see packContext()). When a
 * scene is loaded again, the log is unpacked, shown in the chat panel as
 * history (also drawn on the VR chat panel), sent to the AI as context for
 * the next message, and can be browsed / downloaded in the "Creation
 * context" viewer (📜 button next to the chat attach buttons).
 *
 * Storage (same on Vercel and Cloudflare):
 *   scene.creationContext = {
 *     format: 'gs-creation-context', version: 1,
 *     encoding: 'gzip-base64' | 'json',   // json only if CompressionStream is missing
 *     data: '<base64 gzip of the JSON payload>' (or the payload object for 'json'),
 *     summary: { messages, files, models, bytes, encodedBytes, truncated, redactions, ... }
 *   }
 * Servers with the creation-context patch move `data` out of the scene record
 * into its own key (Vercel Blob `community-scene-context/<id>.json`,
 * Cloudflare KV `scene:<id>:context`) and leave a stub
 *   { format, version, encoding, stored: 'separate', url: '/api/community-scenes/<id>/context', summary }
 * which this module fetches lazily after the scene itself has loaded.
 * Unpatched servers keep the envelope inline, which also works.
 *
 * Nothing in here executes code from a loaded context: vr-exec blocks inside
 * restored replies are history only. Loaded context is untrusted (anyone can
 * publish), so it is only ever rendered with textContent.
 */

export const CONTEXT_FORMAT = 'gs-creation-context';
export const CONTEXT_VERSION = 1;

// Limits. The encoded context must fit in one request on both hosts: Vercel
// functions reject request bodies over 4.5 MB, Cloudflare KV values max out
// at 25 MiB. 3 MB of base64 leaves room for the scene code and thumbnail.
export const LIMITS = {
	maxEncodedChars: 3_000_000,
	fileTextChars: 400_000,      // per attached text file
	imageInlineChars: 400_000,   // base64 chars (~300 KB image); bigger images are kept as references
	messageChars: 200_000,       // per chat message
	maxChatEntries: 1500,
	maxEdits: 25,
	editCodeChars: 60_000,
	historyApiChars: 150_000     // how much restored history is sent to the AI
};

const PUBLISH_PREF_KEY = 'gs.publishCreationContext';

let host = null;
let sessionStartedAt = new Date().toISOString();
const chatLog = [];          // { id, role, kind, ts, text, display, raw, backend, model, attachments[], settings, origin }
const files = new Map();     // fileId -> { id, name, kind, mediaType, size, text?, base64?, addedAt, origin }
const edits = [];            // { ts, source, chars, code, origin }
const loadedContexts = [];   // { key, sceneName, payload, summary, loadedAt }
const restoredKeys = new Set();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

function capText(s, max) {
	const str = String(s ?? '');
	if (str.length <= max) return { text: str, truncated: false, originalLength: str.length };
	return {
		text: str.slice(0, max) + `\n\n[… truncated by GS: kept ${max.toLocaleString()} of ${str.length.toLocaleString()} characters]`,
		truncated: true,
		originalLength: str.length
	};
}

export function formatBytes(n) {
	if (!Number.isFinite(n)) return '?';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function bytesToBase64(bytes) {
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	}
	return btoa(bin);
}

function base64ToBytes(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function gzipBase64(str) {
	const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
	return bytesToBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function gunzipBase64(b64) {
	const stream = new Blob([base64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).text();
}

function canCompress() {
	return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// ---------------------------------------------------------------------------
// Secret scrubbing: obvious key / token patterns are replaced before anything
// is saved or published. Scene code itself is not rewritten (that would break
// it), but secrets found there are reported in the publish dialog.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
	['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{16,}/g],
	['OpenAI API key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
	['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
	['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
	['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
	['Stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
	['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
	['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
	['Bearer token', /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g, 1],
	['Assigned secret', /((?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*["'`])([^"'`\s]{8,})(["'`])/gi, 2]
];

export function scrubString(str, tally) {
	if (typeof str !== 'string' || str.length < 8) return str;
	let out = str;
	for (const [label, re, keepGroups] of SECRET_PATTERNS) {
		re.lastIndex = 0;
		out = out.replace(re, (...m) => {
			if (/\[REDACTED/.test(m[0])) return m[0];
			if (tally) tally[label] = (tally[label] || 0) + 1;
			if (keepGroups === 1) return `${m[1]}[REDACTED ${label}]`;
			if (keepGroups === 2) return `${m[1]}[REDACTED ${label}]${m[3]}`;
			return `[REDACTED ${label}]`;
		});
	}
	return out;
}

function scrubDeep(value, tally, skipKeys = new Set(['base64'])) {
	if (typeof value === 'string') return scrubString(value, tally);
	if (Array.isArray(value)) return value.map(v => scrubDeep(v, tally, skipKeys));
	if (value && typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = skipKeys.has(k) ? v : scrubDeep(v, tally, skipKeys);
		return out;
	}
	return value;
}

export function findSecrets(strings) {
	const tally = {};
	for (const s of strings || []) scrubString(String(s ?? ''), tally);
	return tally;
}

// ---------------------------------------------------------------------------
// Recording (called from main.js)
// ---------------------------------------------------------------------------
export function initCreationContext(hostApi) {
	host = hostApi || {};
	injectUi();
}

function settingsSnapshot() {
	try { return host?.getSettings ? host.getSettings() : null; } catch { return null; }
}

function rememberFile(att, origin = null) {
	const kind = att.kind === 'image' ? 'image' : 'text';
	const content = kind === 'image' ? (att.base64 || '') : (att.text || '');
	const id = 'f' + fnv1a(`${att.name}|${kind}|${content.length}|${content.slice(0, 4096)}|${content.slice(-4096)}`);
	if (!files.has(id)) {
		files.set(id, {
			id,
			name: String(att.name || 'file'),
			kind,
			mediaType: att.mediaType || (kind === 'image' ? 'image/*' : 'text/plain'),
			size: kind === 'image' ? Math.round(content.length * 0.75) : (att.size || new Blob([content]).size),
			...(kind === 'image' ? { base64: content } : { text: content }),
			...(att.truncated ? { truncated: true, note: att.note } : {}),
			...(att.omitted ? { omitted: true, note: att.note } : {}),
			addedAt: att.addedAt || nowIso(),
			origin
		});
	}
	return id;
}

/** A scene-chat prompt as the user sent it (attachments as staged). */
export function recordUserTurn({ text, attachments = [], backend, model } = {}) {
	const ids = attachments.map(a => rememberFile(a));
	chatLog.push({
		id: uid(), role: 'user', kind: 'message', ts: nowIso(),
		text: String(text ?? ''), attachments: ids, backend: backend || null, model: model || null,
		settings: compactSettings(settingsSnapshot())
	});
}

/** The AI reply: raw text (with vr-exec blocks) for the API, cleaned text for display. */
export function recordAssistantTurn({ raw, display, backend, model, codeBlockCount = 0, error = false } = {}) {
	chatLog.push({
		id: uid(), role: 'assistant', kind: error ? 'error' : 'message', ts: nowIso(),
		raw: String(raw ?? ''), display: String(display ?? raw ?? ''),
		backend: backend || null, model: model || null, codeBlocks: codeBlockCount
	});
}

/** Display-only notes (auto-fix progress etc.); never sent to the AI. */
export function recordNote(text) {
	chatLog.push({ id: uid(), role: 'assistant', kind: 'note', ts: nowIso(), display: String(text ?? '') });
}

/** Code tab Apply / Live apply. */
export function recordCodeEdit({ code, source = 'apply' } = {}) {
	const str = String(code ?? '');
	const last = edits[edits.length - 1];
	if (last && !last.origin && last.code === str) return;
	edits.push({ ts: nowIso(), source, chars: str.length, code: str });
	while (edits.length > LIMITS.maxEdits * 2) edits.shift();
}

function compactSettings(s) {
	if (!s) return null;
	return {
		environment: s.environment ? `${s.environment.dim}/${s.environment.lib}` : undefined,
		dependencies: Array.isArray(s.dependencies) ? s.dependencies.filter(d => d.enabled).map(d => d.id) : undefined
	};
}

export function hasSessionContent() {
	return chatLog.length > 0 || edits.length > 0;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------
function buildPayload({ sceneName, includeFileContents = true, purpose = 'save' } = {}) {
	const settings = settingsSnapshot();
	let settingsNote = '';
	try { settingsNote = host?.getSettingsNote ? host.getSettingsNote() : ''; } catch { /* optional */ }
	const notes = [];
	const usedFiles = new Set(chatLog.flatMap(e => e.attachments || []));
	const fileList = [];
	for (const f of files.values()) {
		if (!usedFiles.has(f.id)) continue;
		const out = { id: f.id, name: f.name, kind: f.kind, mediaType: f.mediaType, size: f.size, addedAt: f.addedAt };
		if (f.origin) out.origin = f.origin;
		if (f.omitted || f.truncated) { out.note = f.note; }
		if (f.omitted) out.omitted = true;
		if (!includeFileContents) {
			out.omitted = true;
			out.note = 'Contents left out by the author when publishing (name and size only).';
		} else if (f.kind === 'text' && typeof f.text === 'string') {
			const c = capText(f.text, LIMITS.fileTextChars);
			out.text = c.text;
			if (c.truncated) { out.truncated = true; out.note = `Text truncated to ${LIMITS.fileTextChars.toLocaleString()} of ${c.originalLength.toLocaleString()} characters.`; }
			else if (f.truncated) out.truncated = true;
		} else if (f.kind === 'image' && f.base64) {
			if (f.base64.length <= LIMITS.imageInlineChars) out.base64 = f.base64;
			else { out.omitted = true; out.note = `Image is ${formatBytes(f.size)}; only a reference is stored (inline limit ${formatBytes(LIMITS.imageInlineChars * 0.75)}).`; }
		}
		fileList.push(out);
	}
	let chat = chatLog.slice(-LIMITS.maxChatEntries).map(e => {
		const o = { ...e };
		for (const k of ['text', 'raw', 'display']) {
			if (typeof o[k] === 'string' && o[k].length > LIMITS.messageChars) {
				o[k] = capText(o[k], LIMITS.messageChars).text;
				o.truncated = true;
			}
		}
		return o;
	});
	if (chatLog.length > LIMITS.maxChatEntries) notes.push(`Only the newest ${LIMITS.maxChatEntries} of ${chatLog.length} chat entries were kept.`);
	const editList = edits.slice(-LIMITS.maxEdits).map(e => {
		const c = capText(e.code, LIMITS.editCodeChars);
		return { ...e, code: c.text, ...(c.truncated ? { truncated: true } : {}) };
	});
	const models = [...new Set(chat.filter(e => e.model).map(e => e.model))];
	let libraryFiles = [];
	try { libraryFiles = host?.getLibraryFiles ? host.getLibraryFiles() : []; } catch { /* optional */ }
	return {
		format: CONTEXT_FORMAT,
		version: CONTEXT_VERSION,
		scene: { name: sceneName || null },
		app: { name: 'GS', version: host?.appVersion || null, origin: location.origin },
		purpose,
		sessionStartedAt,
		savedAt: nowIso(),
		models,
		chat,
		files: fileList,
		settings: settings || null,
		settingsNote,
		libraryFiles,
		editHistory: editList,
		origins: loadedContexts.map(c => ({ sceneName: c.sceneName, key: c.key, savedAt: c.payload?.savedAt || null })),
		notes
	};
}

function shrinkPayload(p, step) {
	// Progressive size reduction; each step records what it dropped.
	switch (step) {
		case 0: {
			let n = 0;
			for (const f of p.files) if (f.base64) { delete f.base64; f.omitted = true; f.note = 'Image data dropped to fit the size limit; reference only.'; n++; }
			if (n) p.notes.push(`${n} image(s) kept as references only to fit the ${formatBytes(LIMITS.maxEncodedChars)} limit.`);
			return n > 0;
		}
		case 1: case 2: case 3: {
			const cap = [100_000, 30_000, 8_000][step - 1];
			let n = 0;
			for (const f of p.files) if (typeof f.text === 'string' && f.text.length > cap) {
				f.text = capText(f.text, cap).text; f.truncated = true; f.note = `Text truncated to ${cap.toLocaleString()} characters to fit the size limit.`; n++;
			}
			if (n) p.notes.push(`${n} file(s) truncated to ${cap.toLocaleString()} characters to fit the size limit.`);
			return n > 0;
		}
		case 4: {
			const n = p.editHistory.length;
			for (const e of p.editHistory) { e.code = ''; e.dropped = true; }
			if (n) p.notes.push('Code edit history kept as timestamps only (code dropped) to fit the size limit.');
			return n > 0;
		}
		case 5: {
			let n = 0;
			for (const e of p.chat) for (const k of ['raw', 'text', 'display']) {
				if (typeof e[k] === 'string' && e[k].length > 20_000) { e[k] = capText(e[k], 20_000).text; e.truncated = true; n++; }
			}
			if (n) p.notes.push(`${n} long chat message(s) truncated to 20,000 characters to fit the size limit.`);
			return n > 0;
		}
		case 6: {
			let n = 0;
			for (const f of p.files) if (f.text) { delete f.text; f.omitted = true; f.note = 'Contents dropped to fit the size limit.'; n++; }
			if (n) p.notes.push(`${n} file(s) kept as name/size only to fit the size limit.`);
			return n > 0;
		}
		default: {
			const drop = Math.max(1, Math.floor(p.chat.length / 4));
			if (p.chat.length <= 2) return false;
			p.chat.splice(0, drop);
			p.notes.push(`Oldest ${drop} chat entries dropped to fit the size limit.`);
			return true;
		}
	}
}

async function encode(payload) {
	const json = JSON.stringify(payload);
	if (canCompress()) {
		const data = await gzipBase64(json);
		return { encoding: 'gzip-base64', data, bytes: json.length, encodedBytes: data.length };
	}
	return { encoding: 'json', data: payload, bytes: json.length, encodedBytes: json.length };
}

/**
 * Build the envelope to store with a scene, or null when there's nothing to
 * store. Always scrubbed and size-capped.
 */
export async function packContext({ sceneName, includeFileContents = true, purpose = 'save' } = {}) {
	if (!hasSessionContent()) return null;
	const tally = {};
	let payload = scrubDeep(buildPayload({ sceneName, includeFileContents, purpose }), tally);
	let enc = await encode(payload);
	for (let step = 0; enc.encodedBytes > LIMITS.maxEncodedChars && step < 40; step++) {
		if (!shrinkPayload(payload, step) && step > 6) break;
		enc = await encode(payload);
	}
	const redactions = Object.values(tally).reduce((a, b) => a + b, 0);
	const summary = summarize(payload, { bytes: enc.bytes, encodedBytes: enc.encodedBytes, redactions, redactionKinds: tally, includeFileContents });
	return {
		envelope: { format: CONTEXT_FORMAT, version: CONTEXT_VERSION, encoding: enc.encoding, data: enc.data, summary },
		payload,
		summary
	};
}

function summarize(p, extra = {}) {
	const msgs = (p.chat || []).filter(e => e.kind !== 'note');
	return {
		messages: msgs.length,
		userMessages: msgs.filter(e => e.role === 'user').length,
		files: (p.files || []).map(f => ({ name: f.name, kind: f.kind, size: f.size, included: !f.omitted, truncated: !!f.truncated })),
		edits: (p.editHistory || []).length,
		models: p.models || [],
		savedAt: p.savedAt,
		sessionStartedAt: p.sessionStartedAt,
		truncated: (p.notes || []).length > 0 || (p.files || []).some(f => f.truncated) || (p.chat || []).some(e => e.truncated),
		notes: p.notes || [],
		...extra
	};
}

/** Attach the creation context to scene data for Export / Save to Device. */
export async function withCreationContext(sceneData) {
	try {
		const packed = await packContext({ sceneName: sceneData.name, purpose: 'save' });
		if (packed) sceneData.creationContext = packed.envelope;
	} catch (err) {
		console.warn('creation context: pack failed', err);
	}
	return sceneData;
}

// ---------------------------------------------------------------------------
// Publish dialog (privacy)
// ---------------------------------------------------------------------------
function readPublishPref() {
	try {
		const v = JSON.parse(localStorage.getItem(PUBLISH_PREF_KEY) || 'null');
		if (v && typeof v === 'object') return { include: v.include !== false, files: v.files !== false };
	} catch { /* default */ }
	return { include: true, files: true };
}

function writePublishPref(pref) {
	try { localStorage.setItem(PUBLISH_PREF_KEY, JSON.stringify(pref)); } catch { /* storage blocked */ }
}

/**
 * Ask whether to include the creation context with a Community upload.
 * Resolves with the scene data to upload, or null if the user cancelled.
 * In a headset (no DOM dialog visible) the saved choice is used and a note
 * is added to the chat saying what was shared.
 */
export async function preparePublish(sceneData) {
	const secretsInCode = findSecrets(sceneData.codeBlocks || []);
	if (!hasSessionContent()) {
		return sceneData;
	}
	const pref = readPublishPref();
	const inXr = !!host?.isXrActive?.();
	if (inXr) {
		if (pref.include) {
			const packed = await packContext({ sceneName: sceneData.name, includeFileContents: pref.files, purpose: 'publish' });
			if (packed) sceneData.creationContext = packed.envelope;
			host?.pushChatNote?.(`📜 Publishing with its creation context (${packed?.summary.messages || 0} messages, ${packed?.summary.files.length || 0} files${pref.files ? '' : ', file names only'}). Anyone with the link can read it. Change this in the desktop publish dialog.`);
		} else {
			sceneData.creationContextOmitted = true;
			host?.pushChatNote?.('📜 Publishing without the creation context (your saved choice).');
		}
		return sceneData;
	}
	return new Promise((resolve) => openPublishDialog(sceneData, pref, secretsInCode, resolve));
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------
async function unpackEnvelope(env) {
	if (!env || env.format !== CONTEXT_FORMAT) throw new Error('Not a GS creation context');
	if (env.encoding === 'json') return typeof env.data === 'string' ? JSON.parse(env.data) : env.data;
	if (env.encoding === 'gzip-base64') {
		if (!canCompress()) throw new Error('This browser cannot decompress the creation context');
		return JSON.parse(await gunzipBase64(env.data));
	}
	throw new Error(`Unknown creation context encoding "${env.encoding}"`);
}

/** Fetch (if stored separately) and unpack a scene's creation context. */
export async function loadContextForScene(data) {
	const cc = data?.creationContext;
	if (!cc) return null;
	let env = cc;
	if (!cc.data && cc.url) {
		const res = await fetch(cc.url);
		if (!res.ok) throw new Error(`Creation context unavailable (${res.status})`);
		env = await res.json();
	}
	if (!env.data) return null;
	const payload = await unpackEnvelope(env);
	return { payload, summary: env.summary || cc.summary || summarize(payload) };
}

function sceneKeyFor(data, fallbackKey) {
	return fallbackKey || (data?.id ? `id:${data.id}` : `local:${data?.name || ''}|${data?.createdAt || ''}`);
}

function fmtDate(iso) {
	const d = new Date(iso || '');
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function settingsLines(s) {
	if (!s) return [];
	const lines = [];
	if (s.environment) lines.push(`Environment: ${s.environment.dim === '2d' ? '2D' : '3D'} / ${s.environment.lib}`);
	if (Array.isArray(s.dependencies)) lines.push(`Dependencies: ${s.dependencies.map(d => `${d.name || d.id} ${d.enabled ? 'on' : 'off'}`).join(', ')}`);
	if (s.backend || s.model) lines.push(`Model: ${s.model || s.backend}`);
	return lines;
}

function userApiText(entry, payload) {
	let text = entry.text || '';
	for (const fid of entry.attachments || []) {
		const f = (payload.files || []).find(x => x.id === fid);
		if (!f) continue;
		if (f.kind === 'text' && typeof f.text === 'string') text += `\n\n--- File: ${f.name} ---\n${f.text}`;
		else text += `\n\n[Attached ${f.kind === 'image' ? 'image' : 'file'} "${f.name}" (${formatBytes(f.size)}) - not re-sent]`;
	}
	return text;
}

/**
 * Turn a context payload into chat messages: API messages (alternating
 * user/assistant, starting with a user preamble) plus display bubbles.
 */
export function historyToMessages(payload, { sceneName } = {}) {
	const turns = (payload.chat || []).filter(e => e.kind !== 'note');
	const api = [];
	for (const e of turns) {
		const role = e.role === 'user' ? 'user' : 'assistant';
		const content = role === 'user' ? userApiText(e, payload) : (e.raw || e.display || '');
		if (!content) continue;
		const prev = api[api.length - 1];
		if (prev && prev.role === role) prev.content += `\n\n${content}`;
		else api.push({ role, content });
	}
	// Budget: keep the newest turns that fit.
	let omitted = 0;
	let total = api.reduce((n, m) => n + m.content.length, 0);
	while (total > LIMITS.historyApiChars && api.length > 2) {
		const dropped = api.splice(0, 2);
		omitted += dropped.length;
		total -= dropped.reduce((n, m) => n + m.content.length, 0);
	}
	if (api[0] && api[0].role === 'assistant') api.unshift({ role: 'user', content: '' });
	const lines = [
		`[GS creation history: the messages below are the original chat that created the loaded scene "${sceneName || payload.scene?.name || 'Untitled'}"${payload.savedAt ? `, saved ${payload.savedAt}` : ''}. Its code is already running in the scene. Treat this as background so you can continue the work; vr-exec blocks in it already ran and should not be repeated unless asked.]`
	];
	const sl = settingsLines(payload.settings);
	if (sl.length) lines.push(`Original editor settings: ${sl.join('; ')}.`);
	if (omitted) lines.push(`(${omitted} earlier messages are not included here to save space.)`);
	if (api.length) {
		api[0].content = `${lines.join('\n')}\n\n${api[0].content}`.trimEnd();
		if (api[api.length - 1].role === 'user') api.push({ role: 'assistant', content: '(No reply was recorded for this message.)' });
	}
	const display = [];
	for (const e of payload.chat || []) {
		if (e.role === 'user') {
			const names = (e.attachments || []).map(fid => (payload.files || []).find(f => f.id === fid)?.name).filter(Boolean);
			display.push({ role: 'user', content: (e.text || '') + (names.length ? `\n\n📎 ${names.join(', ')}` : ''), history: true, ts: e.ts });
		} else {
			display.push({ role: 'assistant', content: e.display || e.raw || '', history: true, ts: e.ts, ...(e.kind === 'note' ? { note: true } : {}) });
		}
	}
	return { api, display, omitted };
}

function adoptIntoSession(payload, origin) {
	// Entries keep their ids, so re-opening a scene made earlier in this same
	// session (or one already layered in) doesn't duplicate its history.
	const seenChat = new Set(chatLog.map(e => e.id));
	const seenEdits = new Set(edits.map(e => `${e.ts}|${e.chars}`));
	for (const f of payload.files || []) {
		if (files.has(f.id)) continue;
		files.set(f.id, { ...f, origin: f.origin || origin });
	}
	for (const e of payload.chat || []) if (!seenChat.has(e.id)) chatLog.push({ ...e, origin: e.origin || origin });
	for (const e of payload.editHistory || []) if (!seenEdits.has(`${e.ts}|${e.chars}`)) edits.push({ ...e, origin: e.origin || origin });
}

function alreadyInSession(payload) {
	const ids = new Set(chatLog.map(e => e.id));
	const chat = payload.chat || [];
	return chat.length > 0 && chat.every(e => e.id && ids.has(e.id));
}

/**
 * Called after a saved / file / community scene has loaded. Restores its
 * creation history into the chat (once per scene per page load).
 */
export async function restoreFromScene(data, { key, source = 'file' } = {}) {
	if (!data || host?.isDisplayOnly?.()) return null;
	const sceneName = data.name || 'Untitled';
	const k = sceneKeyFor(data, key);
	if (!data.creationContext) {
		if (data.creationContextOmitted && !restoredKeys.has(k)) {
			restoredKeys.add(k);
			host?.pushChatNote?.(`📜 "${sceneName}" was published without its creation context, so there is no earlier chat to restore.`);
		}
		return null;
	}
	if (restoredKeys.has(k)) return null;
	restoredKeys.add(k);
	let loaded;
	try {
		loaded = await loadContextForScene(data);
	} catch (err) {
		console.warn('creation context: load failed', err);
		host?.pushChatNote?.(`📜 Couldn't load the creation history for "${sceneName}": ${err.message}`);
		restoredKeys.delete(k);
		return null;
	}
	if (!loaded) return null;
	const { payload, summary } = loaded;
	const origin = { sceneName, key: k, source };
	loadedContexts.push({ key: k, sceneName, payload, summary, loadedAt: nowIso(), source });
	updateHistoryButton();
	if (alreadyInSession(payload)) {
		host?.pushChatNote?.(`📜 The creation history of "${sceneName}" is already in this chat, so it wasn't added again.`);
		return { payload, summary };
	}
	adoptIntoSession(payload, origin);
	const { api, display } = historyToMessages(payload, { sceneName });
	const fileNames = (payload.files || []).map(f => `${f.name}${f.omitted ? ' (reference)' : f.truncated ? ' (truncated)' : ''}`);
	const sl = settingsLines(payload.settings);
	const head = [
		`📜 Creation history for "${sceneName}" — ${summary.messages ?? display.length} messages${payload.models?.length ? `, made with ${payload.models.join(', ')}` : ''}${payload.savedAt ? `, saved ${fmtDate(payload.savedAt)}` : ''}.`,
		fileNames.length ? `Files: ${fileNames.join(', ')}.` : 'Files: none.',
		...sl.map(l => `${l}.`),
		...(payload.notes?.length ? [`Notes: ${payload.notes.join(' ')}`] : []),
		'Your next message continues this conversation (the history is sent to the AI). Open 📜 to view or download the full chat and info log.'
	].join('\n');
	const marker = { role: 'assistant', content: head, history: true, historyMarker: true, contextKey: k };
	const end = { role: 'assistant', content: `— End of creation history for "${sceneName}" —`, history: true, historyMarker: true, contextKey: k };
	host?.appendChatHistory?.(api, [marker, ...display, end]);
	updateHistoryButton();
	host?.updateStatus?.(`Restored creation history for "${sceneName}"`, 'connected');
	return { payload, summary };
}

// ---------------------------------------------------------------------------
// Export helpers (viewer downloads)
// ---------------------------------------------------------------------------
export function payloadToMarkdown(p) {
	const out = [`# Creation context: ${p.scene?.name || 'Untitled'}`, ''];
	if (p.savedAt) out.push(`Saved: ${p.savedAt}`);
	if (p.models?.length) out.push(`Models: ${p.models.join(', ')}`);
	for (const l of settingsLines(p.settings)) out.push(l);
	out.push('', '## Chat', '');
	for (const e of p.chat || []) {
		const who = e.role === 'user' ? 'User' : e.kind === 'note' ? 'Note' : e.kind === 'error' ? 'Error' : `AI${e.model ? ` (${e.model})` : ''}`;
		out.push(`### ${who} — ${e.ts || ''}${e.origin ? ` (from "${e.origin.sceneName}")` : ''}`, '');
		if (e.role === 'user') {
			out.push(e.text || '');
			const names = (e.attachments || []).map(fid => (p.files || []).find(f => f.id === fid)?.name).filter(Boolean);
			if (names.length) out.push('', `Attached: ${names.join(', ')}`);
		} else out.push(e.raw || e.display || '');
		out.push('');
	}
	out.push('## Files', '');
	for (const f of p.files || []) {
		out.push(`- ${f.name} (${f.kind}, ${formatBytes(f.size)})${f.note ? ` — ${f.note}` : ''}`);
	}
	if (p.editHistory?.length) {
		out.push('', '## Code edits', '');
		for (const e of p.editHistory) out.push(`- ${e.ts} ${e.source}: ${e.chars} chars${e.dropped ? ' (code dropped)' : ''}`);
	}
	if (p.notes?.length) out.push('', '## Notes', '', ...p.notes.map(n => `- ${n}`));
	return out.join('\n');
}

function download(name, content, type) {
	const blob = content instanceof Blob ? content : new Blob([content], { type });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name.replace(/[\\/:*?"<>|]+/g, '_');
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The current session log as a payload (unscrubbed is never shown; we scrub for display too). */
export function currentSessionPayload() {
	return scrubDeep(buildPayload({ sceneName: host?.getSceneName?.() || 'Current session', purpose: 'view' }), {});
}

export function getLoadedContexts() { return loadedContexts.slice(); }

// ---------------------------------------------------------------------------
// DOM: 📜 button, viewer, publish dialog (all built here so index.html stays untouched)
// ---------------------------------------------------------------------------
const CSS = `
#gs-ctx-history-btn.has-history { background: #4f46e5; }
.dchat-msg.history { opacity: 0.78; border-left: 3px solid #f59e0b; }
.dchat-msg.history-marker { background: rgba(245, 158, 11, 0.14); border: 1px dashed rgba(245, 158, 11, 0.6); opacity: 1; white-space: pre-wrap; font-size: 12px; }
.dchat-msg .gs-ctx-open { display: inline-block; margin-top: 6px; border: none; border-radius: 8px; padding: 4px 10px; background: #f59e0b; color: #111; cursor: pointer; font-size: 12px; }
.gs-ctx-modal { display: none; position: fixed; inset: 0; z-index: 3100; background: rgba(0,0,0,0.6); align-items: center; justify-content: center; pointer-events: auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.gs-ctx-modal.visible { display: flex; }
.gs-ctx-inner { background: rgba(30,30,40,0.98); color: #fff; border-radius: 16px; padding: 20px; width: min(760px, 94vw); max-height: 88vh; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); box-sizing: border-box; }
.gs-ctx-inner h3 { margin: 0; font-size: 18px; }
.gs-ctx-sub { font-size: 12px; opacity: 0.7; line-height: 1.4; }
.gs-ctx-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.gs-ctx-inner select { background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 6px; max-width: 100%; }
.gs-ctx-tabs button, .gs-ctx-actions button, .gs-ctx-file button { border: none; border-radius: 8px; padding: 6px 12px; background: rgba(255,255,255,0.12); color: #fff; cursor: pointer; font-size: 13px; }
.gs-ctx-tabs button.active, .gs-ctx-actions .primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.gs-ctx-body { overflow: auto; flex: 1; min-height: 160px; background: rgba(0,0,0,0.25); border-radius: 10px; padding: 10px; font-size: 13px; line-height: 1.45; }
.gs-ctx-entry { margin-bottom: 10px; }
.gs-ctx-entry .who { font-weight: 600; font-size: 12px; color: #a5b4fc; }
.gs-ctx-entry.assistant .who { color: #6ee7b7; }
.gs-ctx-entry.note .who, .gs-ctx-entry.error .who { color: #fbbf24; }
.gs-ctx-entry pre, .gs-ctx-pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0 0; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.gs-ctx-file { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
.gs-ctx-file .meta { flex: 1; min-width: 0; }
.gs-ctx-file .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs-ctx-file .sub { font-size: 11px; opacity: 0.65; }
.gs-ctx-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.gs-ctx-check { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; line-height: 1.4; }
.gs-ctx-check input { margin-top: 3px; }
.gs-ctx-share-list { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.5; }
.gs-ctx-warn { color: #fbbf24; font-size: 12px; }
body.display-only #gs-ctx-history-btn { display: none !important; }
`;

let viewerEl = null;
let publishEl = null;

function el(tag, attrs = {}, ...children) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
	return n;
}

function injectUi() {
	if (typeof document === 'undefined' || document.getElementById('gs-ctx-style')) return;
	const style = el('style', { id: 'gs-ctx-style' });
	style.textContent = CSS;
	document.head.appendChild(style);
	const tools = document.getElementById('desktop-chat-tools-row');
	if (tools) {
		const btn = el('button', {
			type: 'button', id: 'gs-ctx-history-btn',
			title: 'Creation history: chat log and info log saved with scenes',
			'aria-label': 'Creation history',
			onclick: () => openViewer()
		}, '📜');
		// Match the look of the 📎 / 📄 buttons next to it.
		const ref = document.getElementById('desktop-files-picker-button');
		if (ref) btn.className = ref.className;
		btn.style.cssText = 'border:none;border-radius:10px;padding:8px 10px;background:#3e4154;color:#fff;cursor:pointer;font-size:15px;';
		tools.appendChild(btn);
	}
}

function updateHistoryButton() {
	const btn = document.getElementById('gs-ctx-history-btn');
	if (btn) btn.classList.toggle('has-history', loadedContexts.length > 0);
	if (btn && loadedContexts.length) btn.style.background = '#4f46e5';
}

/** Decorate a desktop chat bubble for a restored history message (called by main.js renderDomChat). */
export function decorateBubble(bubble, msg) {
	if (!msg || !msg.history) return;
	bubble.classList.add('history');
	if (msg.historyMarker) {
		bubble.classList.add('history-marker');
		if (/^📜/.test(msg.content || '')) {
			bubble.appendChild(document.createElement('br'));
			bubble.appendChild(el('button', { type: 'button', class: 'gs-ctx-open', onclick: () => openViewer(msg.contextKey) }, 'View creation context'));
		}
	} else {
		bubble.title = `From the original creation chat${msg.ts ? ` (${fmtDate(msg.ts)})` : ''}`;
	}
}

function ensureViewer() {
	if (viewerEl) return viewerEl;
	viewerEl = el('div', { class: 'gs-ctx-modal', id: 'gs-ctx-viewer', role: 'dialog', 'aria-labelledby': 'gs-ctx-viewer-title' });
	viewerEl.addEventListener('click', (e) => { if (e.target === viewerEl) closeViewer(); });
	document.body.appendChild(viewerEl);
	return viewerEl;
}

export function closeViewer() { viewerEl?.classList.remove('visible'); }

function sources() {
	const list = loadedContexts.map((c, i) => ({ id: `loaded:${i}`, key: c.key, label: `"${c.sceneName}" (loaded ${c.source === 'community' ? 'from Community' : 'scene'})`, payload: c.payload }));
	list.push({ id: 'session', label: 'This session (what Save / Publish will store)', payload: null });
	return list;
}

export function openViewer(contextKey = null, { payload: forcedPayload = null, title = null } = {}) {
	const root = ensureViewer();
	root.innerHTML = '';
	const srcs = forcedPayload ? [{ id: 'preview', label: title || 'Preview', payload: forcedPayload }] : sources();
	let current = srcs.find(s => s.key && s.key === contextKey) || srcs[0];
	let tab = 'chat';
	const inner = el('div', { class: 'gs-ctx-inner' });
	const heading = el('h3', { id: 'gs-ctx-viewer-title' }, title || 'Creation context');
	const sub = el('div', { class: 'gs-ctx-sub' });
	const select = el('select', { 'aria-label': 'Which context' });
	for (const s of srcs) select.appendChild(el('option', { value: s.id }, s.label));
	select.value = current.id;
	select.addEventListener('change', () => { current = srcs.find(s => s.id === select.value) || srcs[0]; draw(); });
	const tabs = el('div', { class: 'gs-ctx-tabs gs-ctx-row' });
	const tabDefs = [['chat', 'Chat log'], ['files', 'Files'], ['settings', 'Settings'], ['edits', 'Code edits']];
	const body = el('div', { class: 'gs-ctx-body' });
	const actions = el('div', { class: 'gs-ctx-actions' },
		el('button', { type: 'button', onclick: () => { const p = payloadOf(); download(`${p.scene?.name || 'scene'}-creation-context.json`, JSON.stringify(p, null, 2), 'application/json'); } }, 'Download JSON'),
		el('button', { type: 'button', onclick: () => { const p = payloadOf(); download(`${p.scene?.name || 'scene'}-chat.md`, payloadToMarkdown(p), 'text/markdown'); } }, 'Download chat (.md)'),
		el('button', { type: 'button', class: 'primary', onclick: closeViewer }, 'Close')
	);
	function payloadOf() { return current.payload || currentSessionPayload(); }
	for (const [id, label] of tabDefs) {
		tabs.appendChild(el('button', { type: 'button', 'data-tab': id, onclick: () => { tab = id; draw(); } }, label));
	}
	function draw() {
		const p = payloadOf();
		for (const b of tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
		const n = (p.chat || []).filter(e => e.kind !== 'note').length;
		sub.textContent = `${p.scene?.name ? `"${p.scene.name}" · ` : ''}${n} messages · ${(p.files || []).length} files · ${(p.editHistory || []).length} code edits${p.savedAt && current.payload ? ` · saved ${fmtDate(p.savedAt)}` : ''}${p.models?.length ? ` · ${p.models.join(', ')}` : ''}`;
		body.innerHTML = '';
		if (tab === 'chat') {
			if (!(p.chat || []).length) body.appendChild(el('div', { class: 'gs-ctx-sub' }, 'No chat yet.'));
			for (const e of p.chat || []) {
				const who = e.role === 'user' ? 'You' : e.kind === 'note' ? 'Note' : e.kind === 'error' ? 'Error' : (e.model || 'AI');
				const meta = [fmtDate(e.ts), e.role === 'user' && e.backend ? `to ${e.model || e.backend}` : '', e.origin ? `from "${e.origin.sceneName}"` : ''].filter(Boolean).join(' · ');
				const names = (e.attachments || []).map(fid => (p.files || []).find(f => f.id === fid)?.name).filter(Boolean);
				body.appendChild(el('div', { class: `gs-ctx-entry ${e.role} ${e.kind || ''}` },
					el('div', { class: 'who' }, `${who}${meta ? ` — ${meta}` : ''}`),
					el('pre', {}, e.role === 'user' ? (e.text || '') : (e.raw || e.display || '')),
					names.length ? el('div', { class: 'gs-ctx-sub' }, `📎 ${names.join(', ')}`) : null
				));
			}
		} else if (tab === 'files') {
			if (!(p.files || []).length) body.appendChild(el('div', { class: 'gs-ctx-sub' }, 'No files were attached in the chat.'));
			for (const f of p.files || []) {
				const canDownload = (f.kind === 'text' && typeof f.text === 'string') || (f.kind === 'image' && f.base64);
				const view = el('pre', { class: 'gs-ctx-pre', hidden: true });
				const row = el('div', { class: 'gs-ctx-file' },
					el('span', {}, f.kind === 'image' ? '🖼️' : '📄'),
					el('div', { class: 'meta' },
						el('div', { class: 'name', title: f.name }, f.name),
						el('div', { class: 'sub' }, `${f.kind === 'image' ? 'Image' : 'Text'} · ${formatBytes(f.size)}${f.omitted ? ' · reference only' : f.truncated ? ' · truncated' : ''}${f.note ? ` · ${f.note}` : ''}${f.origin ? ` · from "${f.origin.sceneName}"` : ''}`)
					),
					f.kind === 'text' && typeof f.text === 'string' ? el('button', { type: 'button', onclick: () => { view.hidden = !view.hidden; view.textContent = f.text; } }, 'View') : null,
					canDownload ? el('button', {
						type: 'button',
						onclick: () => {
							if (f.kind === 'image') download(f.name, new Blob([base64ToBytes(f.base64)], { type: f.mediaType || 'image/png' }));
							else download(f.name, f.text, f.mediaType || 'text/plain');
						}
					}, 'Download') : null
				);
				body.append(row, view);
				if (f.kind === 'image' && f.base64) {
					const img = el('img', { alt: f.name, style: 'max-width:180px;max-height:120px;border-radius:6px;margin:4px 0 8px 28px;' });
					img.src = `data:${/^image\/[a-z0-9.+-]+$/i.test(f.mediaType || '') ? f.mediaType : 'image/png'};base64,${f.base64}`;
					body.appendChild(img);
				}
			}
			if (p.libraryFiles?.length) body.appendChild(el('div', { class: 'gs-ctx-sub', style: 'margin-top:8px' }, `Files library at save time (names only): ${p.libraryFiles.map(f => f.name).join(', ')}`));
		} else if (tab === 'settings') {
			const lines = settingsLines(p.settings);
			body.appendChild(el('pre', { class: 'gs-ctx-pre' }, [
				...lines,
				p.app?.version ? `GS version: ${p.app.version}` : '',
				p.app?.origin ? `Saved on: ${p.app.origin}` : '',
				p.sessionStartedAt ? `Session started: ${p.sessionStartedAt}` : '',
				p.savedAt ? `Saved: ${p.savedAt}` : '',
				p.origins?.length ? `Continued from: ${p.origins.map(o => `"${o.sceneName}"`).join(', ')}` : '',
				...(p.notes?.length ? ['', 'Notes:', ...p.notes.map(n => `- ${n}`)] : []),
				'',
				'Editor settings note sent to the AI:',
				p.settingsNote || '(none)'
			].filter(l => l !== undefined).join('\n')));
		} else if (tab === 'edits') {
			if (!(p.editHistory || []).length) body.appendChild(el('div', { class: 'gs-ctx-sub' }, 'No Code-tab edits were recorded.'));
			for (const e of p.editHistory || []) {
				body.appendChild(el('div', { class: 'gs-ctx-entry' },
					el('div', { class: 'who' }, `${fmtDate(e.ts)} — ${e.source === 'live' ? 'Live update' : 'Apply'} · ${e.chars.toLocaleString()} chars${e.origin ? ` · from "${e.origin.sceneName}"` : ''}`),
					e.code ? el('pre', {}, e.code) : el('div', { class: 'gs-ctx-sub' }, e.dropped ? '(code dropped to fit the size limit)' : '(empty)')
				));
			}
		}
	}
	inner.append(heading, srcs.length > 1 ? el('div', { class: 'gs-ctx-row' }, select) : null, sub, tabs, body, actions);
	root.appendChild(inner);
	draw();
	root.classList.add('visible');
	return root;
}

function openPublishDialog(sceneData, pref, secretsInCode, resolve) {
	if (!publishEl) {
		publishEl = el('div', { class: 'gs-ctx-modal', id: 'gs-ctx-publish', role: 'dialog', 'aria-labelledby': 'gs-ctx-publish-title' });
		document.body.appendChild(publishEl);
	}
	publishEl.innerHTML = '';
	let packed = null;
	let busy = false;
	const include = el('input', { type: 'checkbox', id: 'gs-ctx-include' });
	include.checked = pref.include;
	const includeFiles = el('input', { type: 'checkbox', id: 'gs-ctx-include-files' });
	includeFiles.checked = pref.files;
	const list = el('ul', { class: 'gs-ctx-share-list', id: 'gs-ctx-share-list' });
	const warn = el('div', { class: 'gs-ctx-warn', id: 'gs-ctx-warn' });
	const codeWarn = Object.keys(secretsInCode).length
		? el('div', { class: 'gs-ctx-warn' }, `⚠ The scene code itself looks like it contains ${Object.entries(secretsInCode).map(([k, v]) => `${v} ${k}`).join(', ')}. Scene code is always published as-is; remove it before uploading.`)
		: null;
	const finish = (result) => {
		publishEl.classList.remove('visible');
		resolve(result);
	};
	const refresh = async () => {
		includeFiles.disabled = !include.checked;
		list.innerHTML = '';
		warn.textContent = '';
		if (!include.checked) {
			packed = null;
			list.appendChild(el('li', {}, 'Only the scene (its code, name and thumbnail). The chat and files stay on this device.'));
			return;
		}
		list.appendChild(el('li', {}, 'Working out what will be shared…'));
		busy = true;
		try {
			packed = await packContext({ sceneName: sceneData.name, includeFileContents: includeFiles.checked, purpose: 'publish' });
		} finally { busy = false; }
		list.innerHTML = '';
		if (!packed) { list.appendChild(el('li', {}, 'Nothing recorded yet in this session.')); return; }
		const s = packed.summary;
		list.appendChild(el('li', {}, `The scene (code, name, thumbnail)`));
		list.appendChild(el('li', {}, `Chat log: ${s.messages} messages (${s.userMessages} prompts)${s.models.length ? ` with ${s.models.join(', ')}` : ''}, with timestamps`));
		list.appendChild(el('li', {}, s.files.length
			? `Files: ${s.files.map(f => `${f.name} (${formatBytes(f.size)}${f.included ? (f.truncated ? ', truncated' : '') : ', name only'})`).join(', ')}`
			: 'Files: none attached'));
		list.appendChild(el('li', {}, `Info log: Environment and Dependencies settings, the editor settings note, ${s.edits} code edit${s.edits === 1 ? '' : 's'}`));
		list.appendChild(el('li', {}, `Size: ${formatBytes(s.encodedBytes)} compressed (${formatBytes(s.bytes)} uncompressed, limit ${formatBytes(LIMITS.maxEncodedChars)})`));
		if (s.redactions) warn.textContent = `🔒 ${s.redactions} secret-looking value${s.redactions === 1 ? '' : 's'} (${Object.keys(s.redactionKinds).join(', ')}) will be replaced with [REDACTED].`;
		if (s.notes.length) warn.textContent += (warn.textContent ? ' ' : '') + s.notes.join(' ');
	};
	include.addEventListener('change', refresh);
	includeFiles.addEventListener('change', refresh);
	const inner = el('div', { class: 'gs-ctx-inner', style: 'width:min(520px,94vw)' },
		el('h3', { id: 'gs-ctx-publish-title' }, `Publish "${sceneData.name || 'Untitled'}" to Community`),
		el('div', { class: 'gs-ctx-sub' }, 'Community scenes are public: anyone with the link can open them. The creation context lets you (or anyone who opens the scene) see the original chat and files and keep building from where it left off.'),
		el('label', { class: 'gs-ctx-check' }, include, el('span', {}, el('strong', {}, 'Include creation context'), ' — the chat log and info log (settings, code edits)')),
		el('label', { class: 'gs-ctx-check', style: 'margin-left:24px' }, includeFiles, el('span', {}, 'Include the contents of attached files (otherwise only their names and sizes)')),
		el('div', { class: 'gs-ctx-sub', style: 'opacity:0.9' }, 'What will be shared:'),
		list,
		warn,
		codeWarn,
		el('div', { class: 'gs-ctx-actions' },
			el('button', { type: 'button', id: 'gs-ctx-preview-btn', onclick: () => { if (packed) openViewer(null, { payload: packed.payload, title: 'Preview: creation context to publish' }); } }, 'Preview'),
			el('button', { type: 'button', id: 'gs-ctx-cancel-btn', onclick: () => finish(null) }, 'Cancel'),
			el('button', {
				type: 'button', class: 'primary', id: 'gs-ctx-publish-btn',
				onclick: async () => {
					if (busy) return;
					writePublishPref({ include: include.checked, files: includeFiles.checked });
					if (include.checked) {
						if (!packed) packed = await packContext({ sceneName: sceneData.name, includeFileContents: includeFiles.checked, purpose: 'publish' });
						if (packed) sceneData.creationContext = packed.envelope;
					} else {
						delete sceneData.creationContext;
						sceneData.creationContextOmitted = true;
					}
					finish(sceneData);
				}
			}, 'Publish')
		)
	);
	publishEl.appendChild(inner);
	publishEl.classList.add('visible');
	refresh();
}

// Test / debugging hook (read-only snapshot).
export function _debugState() {
	return { chatLog: chatLog.length, files: files.size, edits: edits.length, loaded: loadedContexts.map(c => c.key) };
}
