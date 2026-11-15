/**
 * Embed export: an <iframe> snippet for putting a GS scene on another site,
 * and the embed view it points at (/embed/:id).
 *
 * The snippet points at /embed/:id on this site. That route serves the
 * normal app (index.html + main.js) which, seeing the /embed/ path, starts in
 * a stripped "embed" mode: display-only (no chat, menus, code or community
 * UI), Map camera (the desktop/phone default), an optional Enter VR button and a small
 * "Made with GS For Anything" link. The scene comes from Community (the
 * same storage as share links), so an unsaved scene is uploaded first;
 * main.js supplies that through getShare().
 *
 * Embedding counts as an export: a scene whose creator turned exports off
 * can't be embedded (the button is disabled here and the server refuses
 * /embed/:id with a 403 page).
 *
 * No self-contained HTML download: a scene is code that runs inside GS's
 * runtime (three.js + main.js helpers, ~2 MB), so a single HTML file would
 * have to bundle the whole app. The iframe stays small and always current.
 */

export const EMBED_SIZES = [
	{ id: 'responsive', label: 'Responsive (16:9)' },
	{ id: '800x450', label: '800 × 450', w: 800, h: 450 },
	{ id: '1280x720', label: '1280 × 720', w: 1280, h: 720 },
	{ id: '600x600', label: '600 × 600 (square)', w: 600, h: 600 }
];

function escapeAttr(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

/** /embed/:id URL; ?vr=0 hides the Enter VR button. */
export function embedUrlFor(origin, id, { vr = true } = {}) {
	const base = `${String(origin || '').replace(/\/+$/, '')}/embed/${encodeURIComponent(id)}`;
	return vr ? base : `${base}?vr=0`;
}

/** The copyable HTML snippet. */
export function buildEmbedSnippet({ origin, id, name = '', vr = true, size = 'responsive' } = {}) {
	if (!id) throw new Error('A scene id is required to embed');
	const src = embedUrlFor(origin, id, { vr });
	const title = `${name ? `${name} — ` : ''}GS For Anything`;
	const allow = vr ? 'xr-spatial-tracking; fullscreen; accelerometer; gyroscope' : 'fullscreen; accelerometer; gyroscope';
	const s = EMBED_SIZES.find((x) => x.id === size) || EMBED_SIZES[0];
	const dims = s.w ? `width="${s.w}" height="${s.h}" style="border:0;max-width:100%"` : 'width="100%" style="border:0;width:100%;aspect-ratio:16/9"';
	return `<iframe src="${escapeAttr(src)}" title="${escapeAttr(title)}" ${dims} allow="${allow}" allowfullscreen loading="lazy"></iframe>`;
}

/** Parse /embed/:id (+ ?vr=0). Returns null for any other path. */
export function parseEmbedRoute(loc = window.location) {
	const path = (loc.pathname || '').replace(/\/+$/, '');
	const m = path.match(/^\/embed\/([A-Za-z0-9_-]+)$/);
	if (!m) return null;
	const params = new URLSearchParams(loc.search || '');
	return { sceneId: m[1], vr: params.get('vr') !== '0' };
}

const CSS = `
#gs-embed-modal { display:none; position:fixed; inset:0; z-index:3300; background:rgba(0,0,0,0.55); align-items:center; justify-content:center; pointer-events:auto; padding:12px; box-sizing:border-box; }
#gs-embed-modal.visible { display:flex; }
#gs-embed-modal-inner { background:rgba(30,30,40,0.98); color:#fff; border-radius:16px; padding:22px; width:min(480px, 100%); max-height:calc(100vh - 24px); overflow:auto; box-sizing:border-box; box-shadow:0 8px 40px rgba(0,0,0,0.5); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
#gs-embed-modal-inner h3 { margin:0 0 6px; font-size:18px; }
#gs-embed-modal-inner .gs-embed-sub { margin:0 0 12px; font-size:12px; color:rgba(255,255,255,0.65); }
#gs-embed-modal-inner label.gs-embed-label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:rgba(255,255,255,0.55); font-weight:700; margin:12px 0 6px; }
#gs-embed-code { width:100%; box-sizing:border-box; min-height:96px; resize:vertical; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.07); color:#fff; font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
#gs-embed-size { width:100%; min-height:44px; border-radius:10px; border:1px solid rgba(255,255,255,0.18); background:#2c2e3e; color:#fff; padding:0 10px; font:inherit; }
.gs-embed-check { display:flex; align-items:center; gap:10px; margin-top:12px; min-height:32px; font-size:13px; cursor:pointer; }
.gs-embed-check input { width:20px; height:20px; flex-shrink:0; }
.gs-embed-buttons { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:16px; }
.gs-embed-buttons button, .gs-embed-buttons a { min-height:44px; min-width:96px; border:none; border-radius:10px; padding:0 16px; font:700 14px/44px -apple-system,BlinkMacSystemFont,sans-serif; color:#fff; background:#3a3c4e; cursor:pointer; text-decoration:none; text-align:center; box-sizing:border-box; }
.gs-embed-buttons .primary { background:linear-gradient(135deg,#6366f1,#8b5cf6); }
.gs-embed-status { font-size:12px; min-height:1.2em; margin-top:8px; color:rgba(255,255,255,0.7); }
/* Embed view (/embed/:id) */
#gs-embed-badge { position:fixed; right:10px; bottom:10px; z-index:2600; padding:6px 10px; border-radius:999px; background:rgba(15,15,25,0.72); color:#fff; font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; text-decoration:none; border:1px solid rgba(255,255,255,0.25); backdrop-filter:blur(4px); pointer-events:auto; }
#gs-embed-badge:hover { background:rgba(79,70,229,0.9); }
#gs-embed-message { position:fixed; inset:0; z-index:2500; display:flex; align-items:center; justify-content:center; padding:16px; text-align:center; color:#fff; background:#16161f; font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
#gs-embed-message[hidden] { display:none; }
`;

function addCss() {
	if (document.getElementById('gs-embed-style')) return;
	const style = document.createElement('style');
	style.id = 'gs-embed-style';
	style.textContent = CSS;
	document.head.appendChild(style);
}

/**
 * Share-tab / Community "Embed" dialog.
 * @param {{
 *   origin?: () => string,
 *   copyText: (text: string) => Promise<boolean>,
 *   notify?: (text: string, kind?: string) => void,
 *   isImmersive?: () => boolean,
 *   alert?: (message: string, opts?: object) => Promise<void>
 * }} opts
 */
export function initEmbedUi(opts) {
	const { origin = () => window.location.origin, copyText, notify = () => {}, isImmersive = () => false, alert = null } = opts;
	let modal = null, codeEl, sizeEl, vrEl, statusEl, copyBtn, previewLink, titleEl;
	let share = null;

	function ensureModal() {
		if (modal) return;
		addCss();
		modal = document.createElement('div');
		modal.id = 'gs-embed-modal';
		modal.setAttribute('aria-hidden', 'true');
		modal.innerHTML = `
			<div id="gs-embed-modal-inner" role="dialog" aria-modal="true" aria-labelledby="gs-embed-title">
				<h3 id="gs-embed-title">Embed scene</h3>
				<p class="gs-embed-sub">Paste this HTML into any web page to show the scene there: view only, drag to look around, with an optional Enter VR button.</p>
				<label class="gs-embed-label" for="gs-embed-size">Size</label>
				<select id="gs-embed-size">${EMBED_SIZES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select>
				<label class="gs-embed-check"><input type="checkbox" id="gs-embed-vr" checked> Show the Enter VR button</label>
				<label class="gs-embed-label" for="gs-embed-code">Embed code</label>
				<textarea id="gs-embed-code" readonly spellcheck="false"></textarea>
				<div class="gs-embed-status" role="status"></div>
				<div class="gs-embed-buttons">
					<a id="gs-embed-preview" target="_blank" rel="noopener">Preview</a>
					<button type="button" id="gs-embed-close">Done</button>
					<button type="button" id="gs-embed-copy" class="primary">Copy code</button>
				</div>
			</div>`;
		document.body.appendChild(modal);
		titleEl = modal.querySelector('#gs-embed-title');
		codeEl = modal.querySelector('#gs-embed-code');
		sizeEl = modal.querySelector('#gs-embed-size');
		vrEl = modal.querySelector('#gs-embed-vr');
		statusEl = modal.querySelector('.gs-embed-status');
		copyBtn = modal.querySelector('#gs-embed-copy');
		previewLink = modal.querySelector('#gs-embed-preview');
		sizeEl.addEventListener('change', render);
		vrEl.addEventListener('change', render);
		modal.querySelector('#gs-embed-close').addEventListener('click', close);
		modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
		window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('visible')) close(); });
		codeEl.addEventListener('focus', () => codeEl.select());
		copyBtn.addEventListener('click', async () => {
			const ok = await copyText(codeEl.value);
			statusEl.textContent = ok ? 'Copied. Paste it into your page’s HTML.' : 'Copy failed: select the code and copy it.';
			copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
			setTimeout(() => { if (copyBtn) copyBtn.textContent = 'Copy code'; }, 1500);
		});
	}

	function snippetFor(s, { vr = true, size = 'responsive' } = {}) {
		return buildEmbedSnippet({ origin: origin(), id: s.id, name: s.name, vr, size });
	}

	function render() {
		if (!share) return;
		const vr = vrEl.checked;
		codeEl.value = snippetFor(share, { vr, size: sizeEl.value });
		previewLink.href = embedUrlFor(origin(), share.id, { vr });
	}

	/** Show the dialog for a share payload { id, name }. In VR the page
	 *  dialog isn't visible: copy the default snippet and say so in an
	 *  in-app pop-up instead. */
	async function open(s) {
		if (!s || !s.id) return null;
		share = s;
		if (isImmersive()) {
			const code = snippetFor(s);
			const ok = await copyText(code);
			notify(ok ? `Embed code copied for "${s.name || 'scene'}"` : `Embed: ${embedUrlFor(origin(), s.id)}`, 'connected');
			if (alert) alert(`${ok ? 'Embed code copied to the clipboard.' : 'Copy this embed code:'}\n\n${code}`, { title: 'Embed scene' });
			return code;
		}
		ensureModal();
		titleEl.textContent = s.name ? `Embed "${s.name}"` : 'Embed scene';
		sizeEl.value = 'responsive';
		vrEl.checked = true;
		statusEl.textContent = '';
		render();
		modal.classList.add('visible');
		modal.setAttribute('aria-hidden', 'false');
		codeEl.focus({ preventScroll: true });
		codeEl.select();
		return codeEl.value;
	}

	function close() {
		if (!modal) return;
		modal.classList.remove('visible');
		modal.setAttribute('aria-hidden', 'true');
	}

	return { open, close, snippetFor, isOpen: () => !!modal?.classList.contains('visible') };
}

/** Embed view chrome: the "Made with" link, and a message for a scene that
 *  can't be shown. */
export function mountEmbedChrome({ sceneId, origin = window.location.origin } = {}) {
	addCss();
	document.body.classList.add('gs-embed');
	const a = document.createElement('a');
	a.id = 'gs-embed-badge';
	a.href = `${origin}/s/${encodeURIComponent(sceneId)}`;
	a.target = '_blank';
	a.rel = 'noopener';
	a.textContent = 'Made with GS For Anything';
	document.body.appendChild(a);
	const msg = document.createElement('div');
	msg.id = 'gs-embed-message';
	msg.hidden = true;
	document.body.appendChild(msg);
	return {
		badge: a,
		showMessage(text) { msg.textContent = text; msg.hidden = false; },
		setSceneName(name) { if (name) a.title = `${name} — open in GS For Anything`; }
	};
}
