/**
 * In-app pop-ups: gsAlert / gsConfirm / gsPrompt.
 *
 * Built on the shared modal template (gsModal.js). GS never uses the
 * browser's alert(), confirm() or prompt(): in a headset those native
 * dialogs either don't show inside the immersive view or can't be clicked
 * with a controller ray. Every question goes through this module instead:
 *
 *  - Desktop / phone / tablet: an accessible HTML modal over the page
 *    (role="dialog", aria-modal, focus trapped inside, Enter = OK,
 *    Escape = Cancel, 44 px touch targets, the theme's --dchat-* colours).
 *  - VR (an XR session is presenting): the same card element is shown as a
 *    VR window (vrWindows.js / htmlInCanvas.js) in front of the user, wired up
 *    by main.js through configureDialogs() / configureModals(). Controller
 *    ray + trigger click the buttons; a prompt's text field types with the
 *    in-scene VR keyboard, whose Send key is OK.
 *
 * All three return Promises and dialogs queue: a second call waits until the
 * first one is answered. Because they're async, code that guards a
 * destructive action must `await gsConfirm(...)` before doing it.
 *
 *   await gsAlert('Saved');                          // -> undefined
 *   if (await gsConfirm('Delete it?', { danger: true, okLabel: 'Delete' })) ...
 *   const name = await gsPrompt('Name?', 'My scene'); // -> string, or null on Cancel
 */

import { openGsModal, configureModals, refreshModalMode, queuedModals, ensureGsModalShell } from './gsModal.js';

export function configureDialogs(h = {}) {
	configureModals(h);
}

let warnedAsync = false;
let active = null; // { kind, message, opts, resolve, handle, settled }
const pending = [];

const EXTRA_CSS = `
#gs-dialog-root.gs-dialog-xr { background: none; pointer-events: none; inset: auto; width: 0; height: 0; padding: 0; }
#gs-dialog.html-in-canvas-source { width: 520px !important; max-height: none !important; overflow: visible !important; font-size: 18px; }
#gs-dialog .gs-dialog-message { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dchat-text, #fff); }
#gs-dialog .gs-dialog-input {
	box-sizing: border-box; width: 100%; min-height: 44px;
	padding: 10px 12px; border-radius: 10px;
	border: 1px solid var(--dchat-field-border, rgba(255, 255, 255, 0.5));
	background: #2c2e3e; color: #fff; font: inherit;
}
#gs-dialog .gs-dialog-buttons { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
#gs-dialog .gs-dialog-btn { min-height: 44px; min-width: 96px; padding: 0 18px; }
#gs-dialog.html-in-canvas-source .gs-dialog-btn { min-height: 56px; min-width: 130px; font-size: 18px; }
#gs-dialog .gs-dialog-ok { background: linear-gradient(135deg, #4f46e5, #6d28d9); border-color: var(--dchat-accent-border, #818cf8); }
#gs-dialog .gs-dialog-ok.gs-dialog-danger { background: #b91c1c; border-color: #fca5a5; }
`;

function injectExtraCss() {
	if (document.getElementById('gs-dialog-style')) return;
	const style = document.createElement('style');
	style.id = 'gs-dialog-style';
	style.textContent = EXTRA_CSS;
	document.head.appendChild(style);
}

function publicView(d) {
	if (!d || !d.handle) return null;
	const card = d.handle.card;
	const input = card.querySelector('#gs-dialog-input');
	const ok = card.querySelector('[data-gs-dialog="ok"]');
	const cancel = card.querySelector('[data-gs-dialog="cancel"]');
	return {
		kind: d.kind,
		message: d.message,
		mode: d.handle.mode,
		card,
		input: d.kind === 'prompt' ? input : null,
		ok,
		cancel: d.kind === 'alert' ? null : cancel
	};
}

function finish(d, value) {
	if (!d || d.settled) return;
	d.settled = true;
	active = null;
	if (d.handle && !d.handle.closed) d.handle.close('action');
	d.resolve(value);
	nextDialog();
}

function answer(ok) {
	const d = active;
	if (!d) return;
	let value;
	if (d.kind === 'alert') value = undefined;
	else if (d.kind === 'confirm') value = !!ok;
	else {
		const input = d.handle?.card?.querySelector('#gs-dialog-input') || document.getElementById('gs-dialog-input');
		value = ok ? (input ? input.value : '') : null;
	}
	finish(d, value);
}

function nextDialog() {
	if (active) return;
	const rec = pending.shift();
	if (!rec) return;
	showDialog(rec);
}

function showDialog(rec) {
	const o = rec.opts || {};
	const kind = rec.kind;
	const title = o.title != null ? String(o.title) : '';
	const msgEl = document.createElement('p');
	msgEl.className = 'gs-dialog-message';
	msgEl.id = 'gs-dialog-message';
	msgEl.textContent = rec.message;
	const input = document.createElement('input');
	input.className = 'gs-dialog-input';
	input.id = 'gs-dialog-input';
	input.type = 'text';
	input.autocomplete = 'off';
	input.spellcheck = false;
	input.setAttribute('aria-labelledby', 'gs-dialog-message');
	input.hidden = kind !== 'prompt';
	if (kind === 'prompt') {
		input.value = o.defaultValue == null ? '' : String(o.defaultValue);
		input.placeholder = o.placeholder || '';
	}
	const handle = openGsModal({
		id: 'gs-dialog-root',
		cardId: 'gs-dialog',
		titleId: 'gs-dialog-title',
		className: 'gs-dialog-root',
		cardClass: 'gs-dialog-card',
		title,
		body: [msgEl, input],
		closable: true,
		closeOnBackdrop: false,
		showClose: false,
		onEnter: () => answer(true),
		xrInput: () => (kind === 'prompt' ? document.getElementById('gs-dialog-input') : null),
		initialFocus: () => {
			if (kind === 'prompt') return document.getElementById('gs-dialog-input');
			if (kind === 'confirm' && o.danger) return document.querySelector('#gs-dialog [data-gs-dialog="cancel"]');
			return document.querySelector('#gs-dialog [data-gs-dialog="ok"]');
		},
		actions: [
			kind === 'alert' ? null : {
				label: o.cancelLabel || 'Cancel',
				className: 'gs-dialog-btn gs-dialog-cancel',
				attrs: { 'data-gs-dialog': 'cancel' },
				close: false,
				onClick: () => { answer(false); return false; }
			},
			{
				label: o.okLabel || 'OK',
				className: 'gs-dialog-btn gs-dialog-ok' + (o.danger ? ' gs-dialog-danger' : ''),
				variant: o.danger ? 'danger' : 'primary',
				attrs: { 'data-gs-dialog': 'ok' },
				close: false,
				onClick: () => { answer(true); return false; }
			}
		].filter(Boolean),
		onClose: (reason) => {
			if (rec.settled) return;
			if (reason === 'escape' || reason === 'close' || reason === 'backdrop') answer(false);
		}
	});
	handle.card.dataset.kind = kind;
	if (!title) handle.card.setAttribute('aria-labelledby', 'gs-dialog-message');
	handle.card.setAttribute('aria-describedby', 'gs-dialog-message');
	rec.handle = handle;
	active = rec;
}

function open(kind, message, opts) {
	injectExtraCss();
	return new Promise((resolve) => {
		pending.push({ kind, message: message == null ? '' : String(message), opts: opts || {}, resolve, handle: null, settled: false });
		nextDialog();
	});
}

/** Show a message with an OK button. Resolves (undefined) when dismissed. */
export function gsAlert(message, opts = {}) {
	return open('alert', message, opts);
}

/** OK / Cancel question. Resolves true for OK, false for Cancel / Escape.
 *  opts: { title, okLabel, cancelLabel, danger } */
export function gsConfirm(message, opts = {}) {
	return open('confirm', message, opts);
}

/** Text question. Resolves the typed text for OK, null for Cancel / Escape.
 *  opts: { title, okLabel, cancelLabel, placeholder } */
export function gsPrompt(message, defaultValue = '', opts = {}) {
	return open('prompt', message, { ...opts, defaultValue });
}

/** The dialog on screen now, or null (tests, VR wiring). */
export function currentDialog() { return publicView(active); }

/** Number of dialogs waiting behind the current one. */
export function queuedDialogs() {
	return pending.length;
}

/** The card element (the VR window's source). Created on first use. */
export function dialogCard() {
	if (active?.handle?.card) return active.handle.card;
	const existing = document.getElementById('gs-dialog');
	if (existing) return existing;
	const shell = ensureGsModalShell({ id: 'gs-dialog-root', cardId: 'gs-dialog', title: '', body: '', actions: [] });
	return shell.card;
}

/** Re-show the current dialog in the right mode (XR session started/ended). */
export function refreshDialogMode() {
	refreshModalMode();
}

/**
 * Route the page's alert / confirm / prompt to the in-app dialogs, so scene
 * code (and anything else on the page) can't open a native one. alert() keeps
 * its meaning (it just doesn't block). confirm() and prompt() can't be
 * synchronous any more: they return a Promise, so callers must await them.
 * The originals stay on window.gsNativeDialogs.
 */
export function installDialogGlobals(win = window) {
	if (win.gsNativeDialogs) return;
	win.gsNativeDialogs = { alert: win.alert, confirm: win.confirm, prompt: win.prompt };
	const warnAsync = (name) => {
		if (warnedAsync) return;
		warnedAsync = true;
		console.warn(`GS: ${name}() opens an in-app pop-up and returns a Promise — use \`await gsConfirm(...)\` / \`await gsPrompt(...)\`.`);
	};
	win.gsAlert = gsAlert;
	win.gsConfirm = gsConfirm;
	win.gsPrompt = gsPrompt;
	win.gsDialogs = { alert: gsAlert, confirm: gsConfirm, prompt: gsPrompt, current: currentDialog, queued: queuedDialogs };
	win.gsModal = win.gsModal || null;
	win.alert = function alert(message) { return gsAlert(message); };
	win.confirm = function confirm(message) { warnAsync('confirm'); return gsConfirm(message); };
	win.prompt = function prompt(message, defaultValue) { warnAsync('prompt'); return gsPrompt(message, defaultValue ?? ''); };
}
