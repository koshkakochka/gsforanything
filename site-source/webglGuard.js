/**
 * WebGL safety net for the app.
 *
 * - createRendererOrExplain(): builds the one WebGLRenderer. If the browser
 *   refuses a WebGL context (GPU blocked, e.g. Chrome's "Web page caused
 *   context loss and was blocked", WebGL turned off, driver blocklisted) it
 *   shows a full-page explanation instead of a half-loaded or blank page,
 *   then throws a WebGLUnavailableError so nothing else runs.
 * - watchContextLoss(): on webglcontextlost it calls preventDefault (so the
 *   browser is allowed to restore it) and waits for ONE restore. It never
 *   creates a new renderer/context. If the context stays lost, or is lost
 *   again soon after a restore, rendering stops and a message offers a
 *   reload, so a GPU that keeps resetting is not hammered in a loop (that
 *   loop is what makes Chrome block WebGL for the whole site).
 */

export class WebGLUnavailableError extends Error {
	constructor(message, cause) {
		super(message);
		this.name = 'WebGLUnavailableError';
		this.cause = cause;
	}
}

const STYLE = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;'
	+ 'background:#16161f;color:#fff;text-align:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

/** Full-page message. Returns the element. */
export function showWebglMessage({ title, body, reload = false, id = 'gs-webgl-error', doc = document } = {}) {
	let el = doc.getElementById(id);
	if (!el) {
		el = doc.createElement('div');
		el.id = id;
		el.setAttribute('role', 'alert');
		el.style.cssText = STYLE;
		(doc.body || doc.documentElement).appendChild(el);
	}
	el.innerHTML = '';
	const box = doc.createElement('div');
	box.style.cssText = 'max-width:440px;';
	const h = doc.createElement('div');
	h.style.cssText = 'font-weight:700;font-size:17px;margin-bottom:8px;';
	h.textContent = title;
	const p = doc.createElement('div');
	p.style.cssText = 'color:rgba(255,255,255,0.78);font-size:13px;';
	p.textContent = body;
	box.append(h, p);
	if (reload) {
		const b = doc.createElement('button');
		b.type = 'button';
		b.textContent = 'Reload';
		b.style.cssText = 'margin-top:14px;min-height:40px;padding:0 18px;border:0;border-radius:10px;font:700 14px sans-serif;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6);cursor:pointer;';
		b.addEventListener('click', () => location.reload());
		box.appendChild(b);
	}
	el.appendChild(box);
	el.hidden = false;
	return el;
}

export const WEBGL_UNAVAILABLE_TEXT = {
	title: '3D graphics are unavailable',
	body: 'This browser could not start WebGL, so the 3D scene can\u2019t be shown. '
		+ 'If Chrome says the page "caused context loss and was blocked", fully quit and reopen the browser. '
		+ 'Also check that hardware acceleration is on (chrome://gpu shows WebGL status) and close other tabs with 3D content.'
};

/**
 * @param {typeof import('three')} THREE
 * @param {object} params WebGLRenderer parameters
 */
export function createRendererOrExplain(THREE, params, { doc = document } = {}) {
	let reason = '';
	const probe = (e) => { reason = e?.statusMessage || reason; };
	// three creates its own canvas; listen at the document level (the
	// creation-error event doesn't bubble, so capture it on the canvas we pass).
	let canvas = params?.canvas;
	if (!canvas) { canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); canvas.style.display = 'block'; }
	canvas.addEventListener('webglcontextcreationerror', probe, { once: true });
	try {
		const renderer = new THREE.WebGLRenderer({ ...params, canvas });
		canvas.removeEventListener('webglcontextcreationerror', probe);
		return renderer;
	} catch (err) {
		const show = () => showWebglMessage({ ...WEBGL_UNAVAILABLE_TEXT, doc });
		if (doc.body) show(); else doc.addEventListener('DOMContentLoaded', show, { once: true });
		if (doc.body) doc.body.dataset.gsWebgl = 'unavailable';
		throw new WebGLUnavailableError(`WebGL unavailable${reason ? `: ${reason}` : ''}`, err);
	}
}

/**
 * Watch the renderer's canvas for context loss. three.js already calls
 * preventDefault and re-initialises its state on restore; this adds a single
 * restore attempt, a visible status and a stop if the GPU keeps resetting.
 * @returns {{ state: () => object, dispose: () => void }}
 */
export function watchContextLoss(renderer, {
	restoreTimeoutMs = 6000,
	relapseWindowMs = 30000,
	onStop = () => {},
	doc = document,
	setTimeoutFn = setTimeout,
	clearTimeoutFn = clearTimeout,
	now = () => Date.now()
} = {}) {
	const canvas = renderer.domElement;
	const st = { lost: 0, restored: 0, stopped: false, lastRestoreAt: 0 };
	let timer = 0;
	let restoreTried = false;
	const stop = (why) => {
		if (st.stopped) return;
		st.stopped = true;
		try { renderer.setAnimationLoop(null); } catch { /* ignore */ }
		showWebglMessage({
			title: 'The 3D view stopped',
			body: `${why} Reload to try again. If it keeps happening, fully quit and reopen the browser, and close other tabs with 3D content.`,
			reload: true,
			id: 'gs-webgl-lost',
			doc
		});
		if (doc.body) doc.body.dataset.gsWebgl = 'stopped';
		onStop(why);
	};
	const onLost = (e) => {
		e.preventDefault(); // allow the browser to restore this same context
		st.lost++;
		if (doc.body) doc.body.dataset.gsWebgl = 'lost';
		if (st.stopped) return;
		if (st.lastRestoreAt && now() - st.lastRestoreAt < relapseWindowMs) {
			stop('The graphics card reset again right after recovering.');
			return;
		}
		clearTimeoutFn(timer);
		timer = setTimeoutFn(() => {
			if (st.stopped || !renderer.getContext().isContextLost()) return;
			// One explicit restore request; never a new context.
			const ext = restoreTried ? null : renderer.getContext().getExtension?.('WEBGL_lose_context');
			restoreTried = true;
			if (ext && typeof ext.restoreContext === 'function') {
				try { ext.restoreContext(); } catch { /* not allowed now */ }
				timer = setTimeoutFn(() => {
					if (!st.stopped && renderer.getContext().isContextLost()) stop('The graphics card was reset and the scene could not recover.');
				}, restoreTimeoutMs);
			} else {
				stop('The graphics card was reset and the scene could not recover.');
			}
		}, restoreTimeoutMs);
	};
	const onRestored = () => {
		st.restored++;
		st.lastRestoreAt = now();
		clearTimeoutFn(timer);
		if (doc.body) doc.body.dataset.gsWebgl = 'ok';
	};
	canvas.addEventListener('webglcontextlost', onLost, false);
	canvas.addEventListener('webglcontextrestored', onRestored, false);
	return {
		state: () => ({ ...st }),
		dispose() {
			clearTimeoutFn(timer);
			canvas.removeEventListener('webglcontextlost', onLost);
			canvas.removeEventListener('webglcontextrestored', onRestored);
		}
	};
}
