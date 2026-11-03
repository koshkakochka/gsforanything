/**
 * Technical mode: an opt-in setting (off by default, saved per browser) for
 * advanced setup — permissions outside normal browser operation, developer
 * tools, items outside ordinary tasks. Turning it on (Controls tab ›
 * Technical mode, also in the VR / AR menu window, which paints the same DOM)
 * asks once with a gsDialog and shows the 🛠 Technical tab: a list of
 * registered advanced items.
 *
 * Adding an item (any module, any time; order sorts the list):
 *
 *   import { registerTechnicalItem } from './technicalMode.js';
 *   registerTechnicalItem({
 *     id: 'my-item', title: 'My advanced thing', order: 20,
 *     render(body, { onLayout }) {          // build the item's DOM once
 *       body.innerHTML = '<p>…</p>';
 *       return { refresh() { … } };         // optional: called when the tab opens
 *     }
 *   });
 *
 * Plain DOM only (buttons, <pre>, <code>): the VR window painter and the
 * controller ray work on it like the rest of the menu. Copy buttons should
 * use copyText() (clipboard with a select-text fallback).
 */
import { gsConfirm } from './gsDialog.js';

const KEY = 'gs.technicalMode';
export const TECHNICAL_NOTE = 'Technical mode is for advanced setup, such as permissions outside normal browser operation and developer tools (for example ADB on Meta Quest).';

const items = [];       // { id, title, order, render, el, api }
const listeners = new Set();
let ui = null;          // { tab, panel, list, toggle, onLayout }

const store = {
	get() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } },
	set(on) { try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } }
};

export const isTechnicalMode = () => store.get();
/** fn(on) runs whenever the mode changes. Returns an unsubscribe. */
export function onTechnicalModeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function apply() {
	const on = isTechnicalMode();
	document.documentElement.classList.toggle('gs-technical', on);
	if (ui) {
		ui.tab.hidden = !on;
		ui.toggle.setAttribute('aria-checked', String(on));
		ui.toggle.dataset.on = String(on);
		ui.toggle.textContent = on ? 'Technical mode: On' : 'Technical mode: Off';
		if (!on && ui.tab.classList.contains('active')) document.querySelector('.dchat-tab[data-tab="chat"]')?.click();
		ui.onLayout();
	}
	for (const fn of listeners) { try { fn(on); } catch (e) { console.error(e); } }
}

/** Turn the mode on (asks first unless opts.confirm === false) or off. */
export async function setTechnicalMode(on, { confirm = true } = {}) {
	on = !!on;
	if (on === isTechnicalMode()) return on;
	if (on && confirm) {
		const ok = await gsConfirm(`${TECHNICAL_NOTE}\n\nIt adds a 🛠 Technical tab to the menu. You can turn it off again in Controls.`, { title: 'Turn on Technical mode?', okLabel: 'Turn on', cancelLabel: 'Cancel' });
		if (!ok) return false;
	}
	store.set(on);
	apply();
	return on;
}

function mountItem(it) {
	if (!ui || it.el) return;
	const el = document.createElement('section');
	el.className = 'gs-tech-item';
	el.dataset.techItem = it.id;
	el.innerHTML = `<div class="dchat-section-label gs-tech-item-title"></div><div class="gs-tech-item-body"></div>`;
	el.querySelector('.gs-tech-item-title').textContent = it.title;
	it.el = el;
	const next = items.filter((o) => o.el && o !== it && o.order > it.order).sort((a, b) => a.order - b.order)[0];
	ui.list.insertBefore(el, next ? next.el : null);
	try { it.api = it.render(el.querySelector('.gs-tech-item-body'), { onLayout: ui.onLayout }) || {}; }
	catch (e) { console.error(`Technical item "${it.id}" failed to render:`, e); it.api = {}; }
}

/** Register an advanced item for the 🛠 Technical tab (see the header). */
export function registerTechnicalItem({ id, title, order = 100, render }) {
	if (items.some((o) => o.id === id)) return;
	const it = { id, title, order, render, el: null, api: null };
	items.push(it);
	items.sort((a, b) => a.order - b.order);
	mountItem(it);
}

/** Re-run every item's refresh() (the tab opening, tests). */
export function refreshTechnicalItems() {
	for (const it of items) if (it.api && it.api.refresh) { try { it.api.refresh(); } catch (e) { console.error(e); } }
}

/** Open the 🛠 Technical tab (turning the mode on first if needed, with the confirm). */
export async function openTechnicalTab(itemId = null) {
	if (!isTechnicalMode() && !(await setTechnicalMode(true))) return false;
	ui?.tab.click();
	if (itemId) items.find((o) => o.id === itemId)?.el?.scrollIntoView({ block: 'nearest' });
	return true;
}

/** Copy text: clipboard API, else select `selectEl`'s text and execCommand. Resolves true when copied. */
export async function copyText(text, selectEl = null) {
	try { await navigator.clipboard.writeText(text); return true; } catch { /* no clipboard (e.g. in VR) */ }
	if (selectEl) {
		const r = document.createRange(); r.selectNodeContents(selectEl);
		const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
		try { return document.execCommand('copy'); } catch { return false; }
	}
	return false;
}

/** main.js: wire the tab button, its panel and the Controls toggle. */
export function initTechnicalMode({ tab, panel, toggle, onLayout = () => {} }) {
	const list = panel.querySelector('.gs-tech-list') || panel;
	ui = { tab, panel, list, toggle, onLayout };
	toggle.setAttribute('role', 'switch');
	toggle.addEventListener('click', (e) => { e.preventDefault(); setTechnicalMode(!isTechnicalMode()); });
	tab.addEventListener('click', () => { refreshTechnicalItems(); onLayout(); });
	for (const it of items) mountItem(it);
	apply();
	window.addEventListener('storage', (e) => { if (e.key === KEY) apply(); });
}
