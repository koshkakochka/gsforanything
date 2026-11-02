/**
 * In-app pop-ups: gsAlert / gsConfirm / gsPrompt.
 *
 * GS never uses the browser's alert(), confirm() or prompt(): in a headset
 * those native dialogs either don't show inside the immersive view or can't
 * be clicked with a controller ray. Every question goes through this module
 * instead, and the same dialog works everywhere:
 *
 *  - Desktop / phone / tablet: an accessible HTML modal over the page
 *    (role="dialog", aria-modal, focus trapped inside, Enter = OK,
 *    Escape = Cancel, 44 px touch targets, the theme's --dchat-* colours).
 *  - VR (an XR session is presenting): the same card element is shown as a
 *    VR window (vrWindows.js / htmlInCanvas.js) in front of the user, wired up
 *    by main.js through configureDialogs(). Controller ray + trigger click the
 *    buttons; a prompt's text field types with the in-scene VR keyboard, whose
 *    Send key is OK.
 *
 * All three return Promises and dialogs queue: a second call waits until the
 * first one is answered. Because they're async, code that guards a
 * destructive action must `await gsConfirm(...)` before doing it.
 *
 *   await gsAlert('Saved');                          // -> undefined
 *   if (await gsConfirm('Delete it?', { danger: true, okLabel: 'Delete' })) ...
 *   const name = await gsPrompt('Name?', 'My scene'); // -> string, or null on Cancel
 */

const ROOT_ID = 'gs-dialog-root';
const CARD_ID = 'gs-dialog';

const hooks = {
	isImmersive: () => false,  // true while the dialog should be a VR window
	onShow: null,              // (card, dialog) -> void   (VR only)
	onHide: null               // (card, dialog) -> void   (VR only)
};

const queue = [];
let active = null;     // { kind, message, opts, resolve, mode }
let dom = null;
let lastFocus = null;
let warnedAsync = false;

/** main.js hands in the VR hooks (see initVrDialogWindow there). */
export function configureDialogs(h = {}) {
	Object.assign(hooks, h);
	if (active) refreshDialogMode();
}

const CSS = `
#${ROOT_ID} {
	position: fixed; inset: 0; z-index: 20000;
	display: flex; align-items: center; justify-content: center;
	background: rgba(0, 0, 0, 0.55);
	padding: 16px; box-sizing: border-box;
	pointer-events: auto;
}
#${ROOT_ID}[hidden], #${CARD_ID}[hidden] { display: none; }
/* In VR the card is painted into a VR window; the page backdrop is unused. */
#${ROOT_ID}.gs-dialog-xr { background: none; pointer-events: none; inset: auto; width: 0; height: 0; padding: 0; }
#${CARD_ID} {
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
#${CARD_ID}.html-in-canvas-source { width: 520px !important; max-height: none !important; overflow: visible !important; font-size: 18px; }
#${CARD_ID} .gs-dialog-title { margin: 0; font-size: 1.15em; font-weight: 700; }
#${CARD_ID} .gs-dialog-message { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dchat-text, #fff); }
#${CARD_ID} .gs-dialog-input {
	box-sizing: border-box; width: 100%; min-height: 44px;
	padding: 10px 12px; border-radius: 10px;
	border: 1px solid var(--dchat-field-border, rgba(255, 255, 255, 0.5));
	background: #2c2e3e; color: #fff; font: inherit;
}
#${CARD_ID} .gs-dialog-buttons { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
#${CARD_ID} .gs-dialog-btn {
	min-height: 44px; min-width: 96px; padding: 0 18px;
	border-radius: 10px; border: 1px solid var(--dchat-control-border, #70738c);
	background: #2c2e3e; color: #fff; font: 600 15px/1 var(--dchat-font, -apple-system, BlinkMacSystemFont, sans-serif);
	cursor: pointer;
}
#${CARD_ID}.html-in-canvas-source .gs-dialog-btn { min-height: 56px; min-width: 130px; font-size: 18px; }
#${CARD_ID} .gs-dialog-ok { background: linear-gradient(135deg, #4f46e5, #6d28d9); border-color: var(--dchat-accent-border, #818cf8); }
#${CARD_ID} .gs-dialog-ok.gs-dialog-danger { background: #b91c1c; border-color: #fca5a5; }
#${CARD_ID} .gs-dialog-btn:focus-visible, #${CARD_ID} .gs-dialog-input:focus-visible { outline: 3px solid #facc15; outline-offset: 2px; }
#${CARD_ID} .gs-dialog-btn:hover { filter: brightness(1.15); }
`;

function ensureDom() {
	if (dom && dom.root.isConnected) return dom;
	if (!document.getElementById('gs-dialog-style')) {
		const style = document.createElement('style');
		style.id = 'gs-dialog-style';
		style.textContent = CSS;
		document.head.appendChild(style);
	}
	const root = document.createElement('div');
	root.id = ROOT_ID;
	root.hidden = true;
	const card = document.createElement('div');
	card.id = CARD_ID;
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-modal', 'true');
	card.hidden = true;
	card.innerHTML = '<h2 class="gs-dialog-title" id="gs-dialog-title"></h2>'
		+ '<p class="gs-dialog-message" id="gs-dialog-message"></p>'
		+ '<input class="gs-dialog-input" id="gs-dialog-input" type="text" autocomplete="off" spellcheck="false" aria-labelledby="gs-dialog-message">'
		+ '<div class="gs-dialog-buttons">'
		+ '<button type="button" class="gs-dialog-btn gs-dialog-cancel" data-gs-dialog="cancel"></button>'
		+ '<button type="button" class="gs-dialog-btn gs-dialog-ok" data-gs-dialog="ok"></button>'
		+ '</div>';
	root.appendChild(card);
	document.body.appendChild(root);
	const $ = (sel) => card.querySelector(sel);
	dom = { root, card, title: $('.gs-dialog-title'), message: $('.gs-dialog-message'), input: $('.gs-dialog-input'), ok: $('.gs-dialog-ok'), cancel: $('.gs-dialog-cancel') };
	dom.ok.addEventListener('click', () => answer(true));
	dom.cancel.addEventListener('click', () => answer(false));
	// While a dialog is open on the page every key goes to it (capture phase,
	// so the camera controls and shortcuts never see them), wherever focus is.
	document.addEventListener('keydown', onKeyDown, true);
	const swallow = (e) => { if (active && (active.mode === 'page' || dom.card.contains(e.target))) e.stopPropagation(); };
	document.addEventListener('keyup', swallow, true);
	document.addEventListener('keypress', swallow, true);
	// Clicks on the backdrop do nothing (the user has to answer) and keep focus in the card.
	root.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (!dom.card.contains(e.target)) e.preventDefault(); });
	root.addEventListener('mousedown', (e) => { if (!dom.card.contains(e.target)) e.preventDefault(); });
	document.addEventListener('focusin', (e) => {
		if (!active || active.mode !== 'page' || dom.card.contains(e.target)) return;
		firstFocus()?.focus();
	});
	return dom;
}

function focusables() {
	return [dom.input, dom.cancel, dom.ok].filter((el) => !el.hidden && !el.disabled);
}
function firstFocus() {
	if (!active) return null;
	if (active.kind === 'prompt') return dom.input;
	if (active.kind === 'confirm' && active.opts.danger) return dom.cancel;
	return dom.ok;
}

function onKeyDown(e) {
	if (!active) return;
	// In VR only keys aimed at the card count (the VR keyboard's Enter).
	if (active.mode !== 'page' && !dom.card.contains(e.target)) return;
	e.stopPropagation();
	if (e.isComposing) return;
	if (e.key === 'Escape' || e.key === 'Esc') {
		e.preventDefault();
		answer(false);
	} else if (e.key === 'Enter') {
		// Enter on a focused button presses that button; anywhere else it's OK.
		if (e.target === dom.cancel) { e.preventDefault(); answer(false); return; }
		e.preventDefault();
		answer(true);
	} else if (e.key === 'Tab' && active.mode === 'page') {
		const list = focusables();
		if (!list.length) return;
		const i = list.indexOf(document.activeElement);
		const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === -1 || i === list.length - 1 ? 0 : i + 1);
		e.preventDefault();
		list[next].focus();
	}
}

function answer(ok) {
	const d = active;
	if (!d) return;
	let value;
	if (d.kind === 'alert') value = undefined;
	else if (d.kind === 'confirm') value = !!ok;
	else value = ok ? dom.input.value : null;
	hideView(d);
	active = null;
	d.resolve(value);
	next();
}

function fill(d) {
	const { opts } = d;
	const title = opts.title != null ? String(opts.title) : '';
	dom.title.textContent = title;
	dom.title.hidden = !title;
	dom.message.textContent = d.message;
	dom.card.setAttribute('aria-labelledby', title ? 'gs-dialog-title' : 'gs-dialog-message');
	dom.card.setAttribute('aria-describedby', 'gs-dialog-message');
	dom.card.dataset.kind = d.kind;
	dom.input.hidden = d.kind !== 'prompt';
	if (d.kind === 'prompt') {
		dom.input.value = opts.defaultValue == null ? '' : String(opts.defaultValue);
		dom.input.placeholder = opts.placeholder || '';
	}
	dom.cancel.hidden = d.kind === 'alert';
	dom.cancel.textContent = opts.cancelLabel || 'Cancel';
	dom.ok.textContent = opts.okLabel || 'OK';
	dom.ok.classList.toggle('gs-dialog-danger', !!opts.danger);
}

function showView(d) {
	ensureDom();
	fill(d);
	const xr = !!hooks.isImmersive?.();
	d.mode = xr ? 'xr' : 'page';
	dom.root.classList.toggle('gs-dialog-xr', xr);
	dom.root.hidden = false;
	dom.card.hidden = false;
	if (xr) {
		// Never DOM-focus in XR (a focused text field summons the Quest system
		// keyboard); main.js shows the card as a VR window instead.
		hooks.onShow?.(dom.card, publicView(d));
	} else {
		if (!lastFocus) lastFocus = document.activeElement;
		const f = firstFocus();
		f?.focus({ preventScroll: true });
		if (f === dom.input) { try { dom.input.select(); } catch { /* ignore */ } }
	}
}

function hideView(d) {
	if (!dom) return;
	if (d.mode === 'xr') hooks.onHide?.(dom.card, publicView(d));
	dom.root.hidden = true;
	dom.card.hidden = true;
	dom.root.classList.remove('gs-dialog-xr');
	if (d.mode === 'page' && dom.card.contains(document.activeElement)) document.activeElement.blur();
}

function next() {
	if (active) return;
	const d = queue.shift();
	if (!d) {
		const f = lastFocus;
		lastFocus = null;
		if (f && f.isConnected && typeof f.focus === 'function' && f !== document.body) {
			try { f.focus({ preventScroll: true }); } catch { /* ignore */ }
		}
		return;
	}
	active = d;
	showView(d);
}

function open(kind, message, opts) {
	return new Promise((resolve) => {
		queue.push({ kind, message: message == null ? '' : String(message), opts: opts || {}, resolve, mode: null });
		next();
	});
}

function publicView(d) {
	if (!d || !dom) return null;
	return { kind: d.kind, message: d.message, mode: d.mode, card: dom.card, input: d.kind === 'prompt' ? dom.input : null, ok: dom.ok, cancel: d.kind === 'alert' ? null : dom.cancel };
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
export function queuedDialogs() { return queue.length; }

/** The card element (the VR window's source). Created on first use. */
export function dialogCard() { return ensureDom().card; }

/** Re-show the current dialog in the right mode (XR session started/ended). */
export function refreshDialogMode() {
	if (!active) return;
	const want = hooks.isImmersive?.() ? 'xr' : 'page';
	if (active.mode === want) return;
	hideView(active);
	showView(active);
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
	win.alert = function alert(message) { return gsAlert(message); };
	win.confirm = function confirm(message) { warnAsync('confirm'); return gsConfirm(message); };
	win.prompt = function prompt(message, defaultValue) { warnAsync('prompt'); return gsPrompt(message, defaultValue ?? ''); };
}
