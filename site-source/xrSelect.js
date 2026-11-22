/**
 * Custom <select> popup for the walker-painted XR UI.
 *
 * Native option lists are OS/browser overlays, so they never appear in the
 * htmlInCanvas texture and cannot be hit by a controller ray. While an
 * immersive session is presenting, a click on a <select> opens a DOM listbox
 * inside the same painted window source. Desktop and phone keep the native
 * <select>.
 */

const POPUP_ID = 'gs-xr-select-popup';
const STYLE_ID = 'gs-xr-select-style';

const CSS = `
#${POPUP_ID} {
	position: absolute;
	z-index: 10060;
	box-sizing: border-box;
	display: flex; flex-direction: column;
	min-width: 140px;
	max-width: 100%;
	border-radius: 12px;
	background: rgb(22, 22, 32);
	border: 2px solid var(--dchat-selected-border, #c7d2fe);
	box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
	color: var(--dchat-text, #fff);
	font: 16px/1.35 var(--dchat-font, system-ui, sans-serif);
	overflow: hidden;
	pointer-events: auto;
}
#${POPUP_ID} .gs-xr-select-list {
	overflow: auto;
	max-height: inherit;
	padding: 4px;
	-webkit-overflow-scrolling: touch;
}
#${POPUP_ID} .gs-xr-select-option {
	display: block; width: 100%;
	box-sizing: border-box;
	text-align: left;
	min-height: 44px;
	padding: 8px 12px;
	margin: 0 0 2px;
	border: 0; border-radius: 8px;
	background: transparent; color: inherit;
	font: inherit; cursor: pointer;
}
#${POPUP_ID} .gs-xr-select-option:last-child { margin-bottom: 0; }
#${POPUP_ID} .gs-xr-select-option[aria-selected="true"],
#${POPUP_ID} .gs-xr-select-option.gs-xr-select-current { background: #4f46e5; }
#${POPUP_ID} .gs-xr-select-option:hover,
#${POPUP_ID} .gs-xr-select-option.gs-ray-hover { background: #6366f1; }
#${POPUP_ID} .gs-xr-select-option[disabled],
#${POPUP_ID} .gs-xr-select-option[aria-disabled="true"] { opacity: 0.45; pointer-events: none; }
#${POPUP_ID} .gs-xr-select-group {
	padding: 8px 12px 4px; font-size: 12px; font-weight: 700;
	text-transform: uppercase; letter-spacing: 0.4px;
	color: rgba(255,255,255,0.72);
}
#${POPUP_ID}-backdrop {
	position: absolute;
	inset: 0;
	z-index: 10055;
	background: rgba(0, 0, 0, 0.2);
	pointer-events: auto;
}
`;

let open = null; // { select, source, popup, backdrop }

function injectCss() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}

function paintedSource(el) {
	return el?.closest?.('.html-in-canvas-source') || null;
}

export function isXrSelectOpen() { return !!(open && open.popup?.isConnected); }

export function xrSelectTarget() { return open?.select || null; }

export function closeXrSelect() {
	if (!open) return;
	const { select, popup, backdrop, source } = open;
	open = null;
	popup?.remove();
	backdrop?.remove();
	if (select) {
		select.classList.remove('gs-xr-select-open');
		select.setAttribute('aria-expanded', 'false');
	}
	source?.dispatchEvent(new Event('scroll')); // nudge a repaint listener
}

function pick(select, index) {
	if (!select || index < 0 || index >= select.options.length) return;
	const opt = select.options[index];
	if (!opt || opt.disabled) return;
	const prev = select.selectedIndex;
	select.selectedIndex = index;
	if (select.selectedIndex !== prev) {
		select.dispatchEvent(new Event('input', { bubbles: true }));
		select.dispatchEvent(new Event('change', { bubbles: true }));
	}
	closeXrSelect();
}

function place(popup, select, source) {
	const src = source.getBoundingClientRect();
	const sel = select.getBoundingClientRect();
	const left = Math.max(8, Math.min(sel.left - src.left, Math.max(8, src.width - 160)));
	const width = Math.min(Math.max(sel.width, 180), Math.max(120, src.width - left - 8));
	const below = src.bottom - sel.bottom;
	const above = sel.top - src.top;
	const preferBelow = below >= 120 || below >= above;
	const maxH = Math.max(88, (preferBelow ? below : above) - 8);
	popup.style.left = `${Math.round(left)}px`;
	popup.style.width = `${Math.round(width)}px`;
	popup.style.maxHeight = `${Math.round(Math.min(280, maxH))}px`;
	if (preferBelow) {
		popup.style.top = `${Math.round(sel.bottom - src.top + 4)}px`;
		popup.style.bottom = 'auto';
	} else {
		popup.style.top = 'auto';
		popup.style.bottom = `${Math.round(src.bottom - sel.top + 4)}px`;
	}
}

function fillList(list, select) {
	list.replaceChildren();
	const kids = [...select.children];
	const addOpt = (opt, index) => {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'gs-xr-select-option' + (opt.selected ? ' gs-xr-select-current' : '');
		btn.setAttribute('role', 'option');
		btn.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
		if (opt.disabled) btn.setAttribute('aria-disabled', 'true');
		btn.textContent = opt.textContent || opt.label || opt.value || '';
		btn.dataset.index = String(index);
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			pick(select, index);
		});
		list.append(btn);
	};
	if (!kids.length) {
		[...select.options].forEach((opt, i) => addOpt(opt, i));
		return;
	}
	for (const node of kids) {
		if (node instanceof HTMLOptGroupElement) {
			const lab = document.createElement('div');
			lab.className = 'gs-xr-select-group';
			lab.textContent = node.label || '';
			list.append(lab);
			for (const opt of node.children) {
				if (opt instanceof HTMLOptionElement) addOpt(opt, opt.index);
			}
		} else if (node instanceof HTMLOptionElement) {
			addOpt(node, node.index);
		}
	}
}

/**
 * Open the custom listbox for `select` inside its painted XR source.
 * @returns {boolean} true if the popup opened (or toggled closed).
 */
export function openXrSelect(select, { source } = {}) {
	if (!(select instanceof HTMLSelectElement) || select.disabled || !select.options.length) return false;
	const root = source || paintedSource(select);
	if (!root) return false;
	if (open && open.select === select) {
		closeXrSelect();
		return true;
	}
	closeXrSelect();
	injectCss();
	if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
	const backdrop = document.createElement('div');
	backdrop.id = `${POPUP_ID}-backdrop`;
	backdrop.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeXrSelect(); });
	const popup = document.createElement('div');
	popup.id = POPUP_ID;
	popup.setAttribute('role', 'listbox');
	popup.setAttribute('aria-label', select.getAttribute('aria-label') || select.name || 'Options');
	const list = document.createElement('div');
	list.className = 'gs-xr-select-list';
	fillList(list, select);
	popup.append(list);
	root.append(backdrop, popup);
	place(popup, select, root);
	select.classList.add('gs-xr-select-open');
	select.setAttribute('aria-expanded', 'true');
	open = { select, source: root, popup, backdrop, list };
	const cur = popup.querySelector('.gs-xr-select-current');
	if (cur) {
		try { cur.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
	}
	return true;
}

/** vrWindows click hook: open the popup instead of cycling options. */
export function activateSelectInXr(select, source) {
	return openXrSelect(select, { source });
}

export function isXrSelectElement(el) {
	return !!(el && (el.id === POPUP_ID || el.id === `${POPUP_ID}-backdrop` || el.closest?.(`#${POPUP_ID}, #${POPUP_ID}-backdrop`)));
}

if (typeof window !== 'undefined') {
	window.gsXrSelect = {
		open: openXrSelect,
		close: closeXrSelect,
		isOpen: isXrSelectOpen,
		target: xrSelectTarget,
		activate: activateSelectInXr,
		isElement: isXrSelectElement
	};
}
