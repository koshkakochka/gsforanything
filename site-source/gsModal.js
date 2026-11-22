/**
 * Reusable in-app modal for desktop, phone, and immersive XR.
 *
 * One template: title, body/content slot, action buttons, close control.
 * Every GS pop-up (alerts, confirmations, Upload Current Scene, export,
 * share, rename, version changelog, p5 import, 3D model export, …) should
 * render through this module so the same card can be painted as a VR window
 * (htmlInCanvas.js / vrWindows.js) and clicked with a controller ray.
 *
 *   const handle = openGsModal({
 *     title: 'Share Scene',
 *     body: formEl,                       // Node, string, or (host) => void
 *     actions: [
 *       { id: 'share-close-btn', label: 'Done', onClick: () => {} },
 *       { id: 'share-copy-btn', label: 'Copy link', variant: 'primary', close: true }
 *     ],
 *     onClose: (reason) => { ... }        // 'close' | 'escape' | 'backdrop' | 'action' | 'replace'
 *   });
 *   handle.close();
 *
 * Desktop / phone: an accessible HTML overlay (role="dialog", aria-modal,
 * focus trap, Escape closes unless opts.closable is false). In an immersive
 * session the same card is shown as a VR window; text fields are not
 * DOM-focused (that summons the Quest system keyboard). main.js wires the
 * window through configureModals().
 */

const ROOT_ID = 'gs-modal-root';
const CARD_ID = 'gs-modal';

const hooks = {
	isImmersive: () => false,
	onShow: null,  // (card, info) => void
	onHide: null   // (card, info) => void
};

const queue = [];
let active = null; // handle
let lastFocus = null;

const CSS = `
#${ROOT_ID}, .gs-modal-root {
	position: fixed; inset: 0; z-index: 20000;
	display: flex; align-items: center; justify-content: center;
	background: rgba(0, 0, 0, 0.55);
	padding: 16px; box-sizing: border-box;
	pointer-events: auto;
}
#${ROOT_ID}[hidden], .gs-modal-root[hidden], #${ROOT_ID}:not(.visible), .gs-modal-root:not(.visible) { display: none !important; }
#${ROOT_ID}.visible, .gs-modal-root.visible { display: flex; }
/* In XR the card is painted into a VR window; the page backdrop is unused. */
#${ROOT_ID}.gs-modal-xr, .gs-modal-root.gs-modal-xr {
	background: none; pointer-events: none; inset: auto; width: 0; height: 0; padding: 0;
}
#${CARD_ID}, .gs-modal-card {
	box-sizing: border-box;
	display: flex; flex-direction: column; gap: 14px;
	width: min(440px, 100%);
	max-height: calc(100vh - 32px); overflow: auto;
	padding: 22px;
	border-radius: var(--dchat-radius, 18px);
	background: rgb(22, 22, 32);
	border: 2px solid var(--dchat-selected-border, #c7d2fe);
	box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
	color: var(--dchat-text, #fff);
	font: 15px/1.45 var(--dchat-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
	pointer-events: auto;
}
#${CARD_ID}.html-in-canvas-source, .gs-modal-card.html-in-canvas-source {
	width: 520px !important; max-height: none !important; overflow: visible !important; font-size: 18px;
}
.gs-modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.gs-modal-title { margin: 0; font-size: 1.15em; font-weight: 700; flex: 1; }
.gs-modal-close {
	flex: 0 0 auto; width: 36px; height: 36px; margin: -6px -6px 0 0;
	border: 1px solid var(--dchat-control-border, #70738c); border-radius: 10px;
	background: #2c2e3e; color: #fff; font: 700 18px/1 sans-serif; cursor: pointer;
}
.gs-modal-close[hidden] { display: none !important; }
.gs-modal-body { margin: 0; display: flex; flex-direction: column; gap: 10px; }
.gs-modal-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
.gs-modal-btn, .gs-modal-actions .gs-dialog-btn {
	min-height: 44px; min-width: 96px; padding: 0 18px;
	border-radius: 10px; border: 1px solid var(--dchat-control-border, #70738c);
	background: #2c2e3e; color: #fff; font: 600 15px/1 var(--dchat-font, -apple-system, BlinkMacSystemFont, sans-serif);
	cursor: pointer;
}
.html-in-canvas-source .gs-modal-btn, .html-in-canvas-source .gs-dialog-btn { min-height: 56px; min-width: 130px; font-size: 18px; }
.gs-modal-btn.gs-modal-primary, .gs-modal-btn.primary, .gs-dialog-ok { background: linear-gradient(135deg, #4f46e5, #6d28d9); border-color: var(--dchat-accent-border, #818cf8); }
.gs-modal-btn.gs-modal-danger, .gs-dialog-ok.gs-dialog-danger { background: #b91c1c; border-color: #fca5a5; }
.gs-modal-btn:focus-visible, .gs-modal-close:focus-visible, .gs-modal-body input:focus-visible, .gs-modal-body textarea:focus-visible, .gs-modal-body select:focus-visible {
	outline: 3px solid #facc15; outline-offset: 2px;
}
.gs-modal-btn:hover, .gs-modal-close:hover { filter: brightness(1.15); }
`;

function injectCss() {
	if (document.getElementById('gs-modal-style')) return;
	const style = document.createElement('style');
	style.id = 'gs-modal-style';
	style.textContent = CSS;
	document.head.appendChild(style);
}

function el(tag, attrs = {}, ...children) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v == null || v === false) continue;
		if (k === 'class' || k === 'className') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
		else n.setAttribute(k, v === true ? '' : String(v));
	}
	for (const c of children.flat()) {
		if (c == null || c === false) continue;
		n.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return n;
}

function fillBody(host, body) {
	host.replaceChildren();
	if (body == null) return;
	if (typeof body === 'function') body(host);
	else if (body instanceof Node) host.append(body);
	else if (Array.isArray(body)) body.forEach((n) => n != null && host.append(n instanceof Node ? n : document.createTextNode(String(n))));
	else host.textContent = String(body);
}

function renderActions(host, actions, close) {
	host.replaceChildren();
	for (const a of actions || []) {
		if (!a) continue;
		const variant = a.variant || (a.danger ? 'danger' : (a.primary ? 'primary' : 'secondary'));
		const cls = ['gs-modal-btn', a.className, variant === 'primary' ? 'gs-modal-primary primary' : '', variant === 'danger' ? 'gs-modal-danger' : '', variant === 'secondary' ? 'secondary' : ''].filter(Boolean).join(' ');
		const btn = el('button', { type: 'button', class: cls, id: a.id || undefined, 'data-gs-modal-action': a.id || a.label || '' }, a.label || 'OK');
		if (a.attrs) for (const [k, v] of Object.entries(a.attrs)) if (v != null) btn.setAttribute(k, v);
		if (a.disabled) btn.disabled = true;
		btn.addEventListener('click', async (e) => {
			if (a.onClick) {
				const ret = await a.onClick(e);
				if (ret === false) return;
			}
			if (a.close !== false) close('action');
		});
		host.append(btn);
	}
	host.hidden = host.childElementCount === 0;
}

function focusables(card) {
	return [...card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
		.filter((n) => !n.hidden && !n.disabled && n.getAttribute('aria-hidden') !== 'true' && n.type !== 'hidden');
}

/** main.js (and tests) hand in the VR hooks. */
export function configureModals(h = {}) {
	Object.assign(hooks, h);
	if (active) refreshModalMode();
}

export function modalHooks() { return hooks; }

function publicInfo(handle) {
	if (!handle) return null;
	const input = typeof handle.opts.xrInput === 'function' ? handle.opts.xrInput() : handle.opts.xrInput || handle.card.querySelector('input, textarea');
	return { card: handle.card, root: handle.root, input: input || null, opts: handle.opts, mode: handle.mode };
}

function applyMode(handle) {
	const xr = !!hooks.isImmersive?.();
	handle.mode = xr ? 'xr' : 'page';
	handle.root.classList.toggle('gs-modal-xr', xr);
	handle.root.classList.toggle('gs-dialog-xr', xr && handle.root.id === 'gs-dialog-root');
	handle.root.classList.toggle('gs-ctx-modal-xr', xr && handle.root.id === 'gs-ctx-publish');
	if (handle.opts.xrClass) handle.root.classList.toggle(handle.opts.xrClass, xr);
	if (xr) {
		const info = publicInfo(handle);
		if (info.input && document.activeElement === info.input) info.input.blur();
		hooks.onShow?.(handle.card, info);
	} else {
		if (!lastFocus) lastFocus = document.activeElement;
		const prefer = handle.opts.initialFocus;
		const f = (typeof prefer === 'function' ? prefer() : prefer) || handle.card.querySelector('input:not([type=hidden]):not([hidden]), textarea, select') || handle.card.querySelector('[data-gs-modal-action], .gs-modal-btn, [data-gs-dialog="ok"]');
		if (f && typeof f.focus === 'function') {
			f.focus({ preventScroll: true });
			if ((f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) && typeof f.select === 'function') {
				try { f.select(); } catch { /* ignore */ }
			}
		}
	}
}

function hideView(handle, reason) {
	if (!handle || handle.closed) return;
	if (handle.mode === 'xr') hooks.onHide?.(handle.card, publicInfo(handle));
	handle.root.classList.remove('visible', 'gs-modal-xr', 'gs-ctx-modal-xr');
	handle.root.hidden = true;
	handle.root.setAttribute('aria-hidden', 'true');
	handle.closed = true;
	if (handle.mode === 'page' && handle.card.contains(document.activeElement)) document.activeElement.blur();
	try { handle.opts.onClose?.(reason || 'close'); } catch (err) { console.warn('[gs modal] onClose', err); }
}

function next() {
	if (active && !active.closed) return;
	active = null;
	const item = queue.shift();
	if (!item) {
		const f = lastFocus;
		lastFocus = null;
		if (f && f.isConnected && typeof f.focus === 'function' && f !== document.body) {
			try { f.focus({ preventScroll: true }); } catch { /* ignore */ }
		}
		return;
	}
	showHandle(item);
}

function showHandle(handle) {
	injectCss();
	active = handle;
	handle.closed = false;
	handle.root.hidden = false;
	handle.root.classList.add('visible');
	handle.root.setAttribute('aria-hidden', 'false');
	applyMode(handle);
}

function onKeyDown(e) {
	if (!active || active.closed) return;
	if (active.mode !== 'page' && !active.card.contains(e.target)) return;
	e.stopPropagation();
	if (e.isComposing) return;
	if (e.key === 'Escape' || e.key === 'Esc') {
		if (active.opts.closable === false) return;
		e.preventDefault();
		e.stopPropagation();
		active.close('escape');
	} else if (e.key === 'Tab' && active.mode === 'page') {
		const list = focusables(active.card);
		if (!list.length) return;
		const i = list.indexOf(document.activeElement);
		const nextEl = e.shiftKey ? (i <= 0 ? list[list.length - 1] : list[i - 1]) : (i === -1 || i === list.length - 1 ? list[0] : list[i + 1]);
		e.preventDefault();
		e.stopPropagation();
		nextEl.focus();
	} else if ((e.key === 'Enter' || e.key === 'NumpadEnter') && typeof active.opts.onEnter === 'function') {
		if (e.target && e.target.closest && e.target.closest('[data-gs-dialog="cancel"], [data-gs-modal="close"]')) return;
		e.preventDefault();
		e.stopPropagation();
		active.opts.onEnter(e);
	}
}

function onKeySwallow(e) {
	if (!active || active.closed) return;
	if (active.mode === 'page' || active.card.contains(e.target)) e.stopPropagation();
}

let keysBound = false;
function bindKeys() {
	if (keysBound) return;
	keysBound = true;
	document.addEventListener('keydown', onKeyDown, true);
	document.addEventListener('keydown', onKeySwallow, false);
	document.addEventListener('keyup', onKeySwallow, true);
	document.addEventListener('keypress', onKeySwallow, true);
	document.addEventListener('focusin', (e) => {
		if (!active || active.closed || active.mode !== 'page') return;
		if (!active.card.contains(e.target)) focusables(active.card)[0]?.focus();
	});
}

function buildShell(opts) {
	injectCss();
	bindKeys();
	const rootId = opts.id || ROOT_ID;
	let root = document.getElementById(rootId);
	if (!root) {
		root = el('div', { id: rootId, class: ['gs-modal-root', opts.className].filter(Boolean).join(' '), hidden: '' });
		document.body.appendChild(root);
	} else {
		root.classList.add('gs-modal-root');
		if (opts.className) opts.className.split(/\s+/).forEach((c) => c && root.classList.add(c));
	}
	root.setAttribute('aria-hidden', 'true');
	root.replaceChildren();
	const cardId = opts.cardId || (opts.id ? undefined : CARD_ID);
	const card = el('div', {
		id: cardId,
		class: ['gs-modal-card', opts.cardClass].filter(Boolean).join(' '),
		role: 'dialog',
		'aria-modal': 'true'
	});
	if (opts.width) card.style.width = opts.width;
	const titleId = opts.titleId || (cardId ? `${cardId}-title` : 'gs-modal-title');
	const titleEl = el('h2', { class: 'gs-modal-title', id: titleId });
	const closeBtn = el('button', { type: 'button', class: 'gs-modal-close', 'aria-label': 'Close', 'data-gs-modal': 'close' }, '×');
	const header = el('div', { class: 'gs-modal-header' }, titleEl, closeBtn);
	const body = el('div', { class: 'gs-modal-body' });
	if (opts.bodyId) body.id = opts.bodyId;
	const actions = el('div', { class: 'gs-modal-actions' });
	card.append(header, body, actions);
	root.append(card);
	if (opts.title) {
		titleEl.textContent = String(opts.title);
		titleEl.hidden = false;
		card.setAttribute('aria-labelledby', titleId);
	} else {
		titleEl.hidden = true;
	}
	closeBtn.hidden = opts.showClose === false || (opts.closable === false && opts.showClose !== true);
	fillBody(body, opts.body);
	return { root, card, titleEl, closeBtn, body, actionsEl: actions };
}

/** Build (or reuse) the modal shell without showing it. Used to mount the VR window source before the first open. */
export function ensureGsModalShell(opts = {}) {
	const shell = buildShell(opts);
	shell.root.hidden = true;
	shell.root.classList.remove('visible');
	shell.root.setAttribute('aria-hidden', 'true');
	return shell;
}

/**
 * Open a modal. Returns a handle with close(), setTitle(), setBody(),
 * setActions(), root, card, body. Dialogs queue: a second call waits until
 * the first is closed unless opts.replace is true.
 */
export function openGsModal(opts = {}) {
	const handle = { opts, mode: null, closed: true };
	const shell = buildShell(opts);
	Object.assign(handle, shell);
	handle.close = (reason = 'close') => {
		if (handle.closed) return;
		hideView(handle, reason);
		if (active === handle) next();
	};
	handle.setTitle = (t) => {
		handle.titleEl.textContent = t == null ? '' : String(t);
		handle.titleEl.hidden = !t;
		if (t) handle.card.setAttribute('aria-labelledby', handle.titleEl.id);
	};
	handle.setBody = (b) => fillBody(handle.body, b);
	handle.setActions = (list) => renderActions(handle.actionsEl, list, (r) => handle.close(r));
	handle.setBusy = (busy) => {
		handle.card.setAttribute('aria-busy', busy ? 'true' : 'false');
		handle.actionsEl.querySelectorAll('button').forEach((b) => { b.disabled = !!busy; });
	};
	renderActions(handle.actionsEl, opts.actions, (r) => handle.close(r));
	handle.closeBtn.addEventListener('click', () => handle.close('close'));
	handle.root.addEventListener('pointerdown', (e) => {
		e.stopPropagation();
		if (e.target === handle.root) {
			if (handle.opts.closeOnBackdrop) handle.close('backdrop');
			else e.preventDefault();
		}
	});
	handle.root.addEventListener('mousedown', (e) => {
		if (e.target === handle.root && !handle.opts.closeOnBackdrop) e.preventDefault();
	});

	const start = () => showHandle(handle);
	if (opts.replace && active && !active.closed) {
		hideView(active, 'replace');
		active = null;
		start();
	} else if (active && !active.closed) {
		queue.push(handle);
	} else {
		start();
	}
	return handle;
}

export function closeGsModal(reason = 'close') {
	if (active && !active.closed) active.close(reason);
}

export function currentModal() { return active && !active.closed ? active : null; }

export function modalCard() { return currentModal()?.card || document.getElementById(CARD_ID); }

export function isModalOpen() { return !!(active && !active.closed); }

/** Number of modals waiting behind the one on screen. */
export function queuedModals() { return queue.length; }

/** Re-show the current modal in the right mode (XR session started/ended). */
export function refreshModalMode() {
	if (!active || active.closed) return;
	const want = hooks.isImmersive?.() ? 'xr' : 'page';
	if (active.mode === want) return;
	if (active.mode === 'xr') hooks.onHide?.(active.card, publicInfo(active));
	applyMode(active);
}

export { el as modalEl };
