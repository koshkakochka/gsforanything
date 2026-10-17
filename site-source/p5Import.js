// ============================================================================
// p5.js sketch import: bring an existing p5.js sketch (pasted code, a .js
// file, an index.html + sketch.js project, a p5 web editor .zip download, or
// a URL) into GS and show it on a panel in the 3D scene, visible on desktop,
// phone and in a headset.
//
// How a sketch runs: each imported sketch gets its own hidden iframe
// (sandbox="allow-scripts", no allow-same-origin, built from srcdoc). The
// sketch's own index.html scripts run there unchanged, so global-mode
// sketches (top-level setup/draw/preload, mouseX, width, ...), instance-mode
// sketches (new p5(s)), WEBGL sketches, addons like p5.sound, and the p5
// version the sketch's index.html asks for all behave as they do on
// editor.p5js.org. GS drives the frame's requestAnimationFrame from its own
// render loop (which keeps running inside WebXR, where the page's rAF stops),
// the frame sends back each new canvas image as a transferred ImageBitmap,
// and it is drawn onto a gsCreateCanvasSurface panel that is re-uploaded as a
// THREE texture every frame. Clicks on the panel (desktop mouse, phone touch,
// XR controller rays) are mapped to canvas coordinates and replayed inside
// the frame as mouse/pointer events, so mouseX / mouseIsPressed /
// mousePressed() work.
//
// Persistence: an import becomes a normal code block,
//   await gsImportP5Sketch({ name, files: { 'sketch.js': `...` }, ... })
// added to the session, so it is saved with the scene, shows in the code
// window (edit the sketch there and Apply), and re-runs when the scene loads.
//
// Hooks used from main.js: window.gsCreateCanvasSurface, window.gsSessionCode,
// window.gsGetWorldContentParent, window.camera / scene / renderer, GS_DEPS.
// ============================================================================

import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';

const TEXT_EXT = /\.(m?js|cjs|html?|css|json|txt|csv|tsv|xml|svg|glsl|vert|frag|vs|fs|md|obj|mtl|geojson|ya?ml)$/i;
const MIME = {
	js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', html: 'text/html', htm: 'text/html', css: 'text/css',
	json: 'application/json', geojson: 'application/json', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', xml: 'application/xml',
	svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
	ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
	mp4: 'video/mp4', webm: 'video/webm', glsl: 'text/plain', vert: 'text/plain', frag: 'text/plain', obj: 'text/plain', mtl: 'text/plain'
};
const MAX_EMBED_BYTES = 20 * 1024 * 1024; // refuse imports whose embedded files exceed this
const WARN_EMBED_BYTES = 4 * 1024 * 1024;
const READY_TIMEOUT_MS = 30000;

const extOf = (p) => (String(p).match(/\.([a-z0-9]+)(?:[?#].*)?$/i) || [])[1]?.toLowerCase() || '';
const mimeOf = (p) => MIME[extOf(p)] || 'application/octet-stream';
const isTextPath = (p) => TEXT_EXT.test(String(p).replace(/[?#].*$/, ''));

// Bootstrap that runs inside each imported p5.js sketch's sandboxed iframe.
// gsImportP5Sketch inlines this function's source (toString) into the
// iframe's srcdoc; it never runs in the GS page itself and must not use
// anything from this module's scope. The iframe is sandbox="allow-scripts"
// without allow-same-origin, so the sketch gets a real global scope of its
// own (global-mode p5 works unchanged, any p5 version) but cannot touch the
// GS page, its storage or its cookies. Everything goes through postMessage:
//   parent -> frame: load, tick, input, key, dispose
//   frame -> parent: hello, ready, frame (ImageBitmap), idle, error, log
function gsP5FrameBootstrap() {
	'use strict';
	var parentWin = window.parent;
	var post = function (msg, transfer) {
		msg.gsP5 = 1;
		try { parentWin.postMessage(msg, '*', transfer || []); } catch (e) { /* parent gone */ }
	};

	// --- Display density: p5 sizes its backing store by devicePixelRatio.
	// A phone (dpr 3) would make a 400x400 sketch 1200x1200, so it is pinned
	// (default 1) to keep the panel texture the size the sketch asked for.
	var density = 1;
	try { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: function () { return density; } }); } catch (e) { /* ignore */ }

	// --- requestAnimationFrame is driven by GS's render loop. The browser's
	// own rAF stops during an immersive WebXR session and is throttled in
	// off-screen frames, so every rAF callback in the sketch (p5's draw loop,
	// tweening libraries, ...) runs when GS sends a "tick" instead.
	var rafQueue = new Map();
	var rafId = 0;
	window.requestAnimationFrame = function (cb) { rafId += 1; rafQueue.set(rafId, cb); return rafId; };
	window.cancelAnimationFrame = function (id) { rafQueue.delete(id); };

	// --- Storage: an opaque-origin frame throws on localStorage access, which
	// p5's storeItem/getItem use. Give it a per-sketch in-memory stand-in.
	function memoryStorage() {
		var data = {};
		return {
			getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
			setItem: function (k, v) { data[k] = String(v); },
			removeItem: function (k) { delete data[k]; },
			clear: function () { data = {}; },
			key: function (i) { return Object.keys(data)[i] || null; },
			get length() { return Object.keys(data).length; }
		};
	}
	['localStorage', 'sessionStorage'].forEach(function (name) {
		try { void window[name].length; } catch (e) {
			try { Object.defineProperty(window, name, { configurable: true, value: memoryStorage() }); } catch (e2) { /* ignore */ }
		}
	});

	// --- Errors from the sketch go to GS (shown on the panel and in the dialog).
	function errText(e) {
		if (!e) return 'Unknown error';
		if (typeof e === 'string') return e;
		var text = (e.name && e.message) ? e.name + ': ' + e.message : String(e.message || e);
		// Syntax errors in an inserted script are reported against appendChild.
		return text.replace(/^(Uncaught )?(\w*Error: )?Failed to execute 'appendChild' on 'Node': /, '$2');
	}
	window.addEventListener('error', function (ev) {
		var where = ev.filename && !/^about:/.test(ev.filename) ? ' (' + String(ev.filename).split('/').pop() + ':' + ev.lineno + ')' : (ev.lineno ? ' (line ' + ev.lineno + ')' : '');
		post({ type: 'error', message: errText(ev.error || ev.message) + where });
	});
	window.addEventListener('unhandledrejection', function (ev) { post({ type: 'error', message: errText(ev.reason) }); });
	window.alert = function (m) { post({ type: 'log', message: 'alert: ' + m }); };

	// --- Local files (zip / multi-file imports) become blob: URLs, and every
	// URL the sketch asks for is passed through resolve(): fetch (loadJSON,
	// loadStrings, loadImage in p5 1.x), XMLHttpRequest (loadFont,
	// loadSound), and the src of images, audio/video, scripts and links.
	var files = {};      // normalised path -> URL (blob: or remote)
	var filesLower = {};
	var baseDir = '';    // directory of the entry file inside the project
	var remoteBase = ''; // URL unknown relative paths resolve against (URL imports)
	var docBase = (function () { try { return String(document.baseURI).replace(/[#?].*$/, '').replace(/[^/]*$/, ''); } catch (e) { return ''; } })();

	function normPath(p) {
		var parts = [];
		String(p).split('/').forEach(function (seg) {
			if (!seg || seg === '.') return;
			if (seg === '..') parts.pop(); else parts.push(seg);
		});
		return parts.join('/');
	}
	function lookup(rel) {
		var clean = rel.replace(/[?#].*$/, '');
		try { clean = decodeURIComponent(clean); } catch (e) { /* keep */ }
		var candidates = [normPath(baseDir + clean), normPath(clean)];
		for (var i = 0; i < candidates.length; i++) {
			if (files[candidates[i]]) return files[candidates[i]];
			var lower = filesLower[candidates[i].toLowerCase()];
			if (lower) return lower;
		}
		return null;
	}
	function resolve(url) {
		if (url == null) return url;
		var s = String(url);
		if (/^(blob:|data:)/i.test(s)) return s;
		var rel = null;
		if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(s)) {
			// Absolute: a relative path the browser already resolved against the
			// srcdoc base (the GS page URL) is mapped back to a project path.
			if (docBase && s.indexOf(docBase) === 0) rel = s.slice(docBase.length);
			else return s;
		} else {
			rel = s;
		}
		var hit = lookup(rel.replace(/^\/+/, ''));
		if (hit) return hit;
		if (remoteBase) { try { return new URL(rel, remoteBase).href; } catch (e) { /* fall through */ } }
		return s;
	}
	window.__gsResolve = resolve;

	var nativeFetch = window.fetch;
	window.fetch = function (input, init) {
		if (typeof input === 'string' || input instanceof URL) return nativeFetch.call(window, resolve(String(input)), init);
		if (input && input.url) {
			var r = resolve(input.url);
			if (r !== input.url) return nativeFetch.call(window, new Request(r, input), init);
		}
		return nativeFetch.call(window, input, init);
	};
	var nativeOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url) {
		var args = Array.prototype.slice.call(arguments);
		args[1] = resolve(url);
		return nativeOpen.apply(this, args);
	};
	function patchUrlProp(proto, prop) {
		var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
		if (!d || !d.set) return;
		Object.defineProperty(proto, prop, {
			configurable: true, enumerable: d.enumerable,
			get: d.get,
			set: function (v) { d.set.call(this, resolve(v)); }
		});
	}
	patchUrlProp(HTMLImageElement.prototype, 'src');
	patchUrlProp(HTMLMediaElement.prototype, 'src');
	patchUrlProp(HTMLSourceElement.prototype, 'src');
	patchUrlProp(HTMLScriptElement.prototype, 'src');
	patchUrlProp(HTMLLinkElement.prototype, 'href');
	var nativeSetAttr = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (name, value) {
		var n = String(name).toLowerCase();
		if ((n === 'src' || (n === 'href' && this instanceof HTMLLinkElement)) && typeof value === 'string') value = resolve(value);
		return nativeSetAttr.call(this, name, value);
	};

	// --- Loading the project ------------------------------------------------
	function loadScriptEl(attrs) {
		return new Promise(function (resolveP) {
			var el = document.createElement('script');
			if (attrs.type && attrs.type !== 'module') el.type = attrs.type;
			if (attrs.type === 'module') el.type = 'module';
			if (attrs.src) {
				el.async = false;
				el.onload = function () { resolveP(true); };
				el.onerror = function () { resolveP(false); };
				el.src = attrs.src;
				document.head.appendChild(el);
			} else {
				el.textContent = attrs.text + (attrs.name ? '\n//# sourceURL=' + attrs.name : '');
				document.head.appendChild(el);
				resolveP(true);
			}
		});
	}

	var isP5Src = function (src) { return /(^|\/)p5(\.min)?\.js(\?|#|$)/i.test(src) || /\/p5@[^/]+\/lib\/p5(\.min)?\.js/i.test(src) || /\/p5\.js\/[\d.]+\/p5(\.min)?\.js/i.test(src); };

	async function loadProject(msg) {
		density = msg.pixelDensity || 1;
		remoteBase = msg.baseUrl || '';
		var texts = {};
		(msg.files || []).forEach(function (f) {
			var path = normPath(f.path);
			var url;
			if (f.url) url = f.url;
			else if (f.buffer) url = URL.createObjectURL(new Blob([f.buffer], { type: f.type || 'application/octet-stream' }));
			else { texts[path] = f.text || ''; url = URL.createObjectURL(new Blob([f.text || ''], { type: f.type || 'text/plain' })); }
			files[path] = url;
			filesLower[path.toLowerCase()] = url;
		});
		var entry = normPath(msg.entry || '');
		baseDir = entry.indexOf('/') >= 0 ? entry.replace(/[^/]*$/, '') : '';

		var scripts = [];   // { src } | { text, name }
		var bundled = msg.bundledP5 || [];
		var hasP5 = false;
		if (/\.html?$/i.test(entry) && texts[entry] != null) {
			var doc = new DOMParser().parseFromString(texts[entry], 'text/html');
			doc.querySelectorAll('head style, head link[rel~="stylesheet"]').forEach(function (n) {
				var el = document.importNode(n, true);
				if (el.tagName === 'LINK') el.href = n.getAttribute('href'); // resolved by the patched setter
				document.head.appendChild(el);
			});
			doc.querySelectorAll('script').forEach(function (s) {
				var src = s.getAttribute('src');
				var type = (s.getAttribute('type') || '').toLowerCase();
				if (type && !/javascript|module/.test(type)) return;
				if (src) {
					if (isP5Src(src)) hasP5 = true;
					var localText = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src) ? null : texts[normPath(baseDir + src.replace(/[?#].*$/, ''))];
					if (localText != null && type !== 'module') scripts.push({ text: localText, name: src.split('/').pop() });
					else scripts.push({ src: resolve(src), type: type });
				} else if (s.textContent.trim()) {
					scripts.push({ text: s.textContent, name: 'index.html', type: type });
				}
				s.remove();
			});
			// Body markup (containers, DOM elements the sketch expects) minus scripts.
			Array.prototype.forEach.call(doc.body ? doc.body.childNodes : [], function (n) {
				document.body.appendChild(document.importNode(n, true));
			});
		} else {
			var jsPaths = Object.keys(texts).filter(function (p) { return /\.m?js$/i.test(p); });
			jsPaths.sort(function (a, b) { return (/sketch\.js$/i.test(a) ? 1 : 0) - (/sketch\.js$/i.test(b) ? 1 : 0) || a.localeCompare(b); });
			if (entry && texts[entry] != null) {
				jsPaths = jsPaths.filter(function (p) { return p !== entry; }).concat([entry]);
			}
			jsPaths.forEach(function (p) {
				var text = texts[p];
				// GS-style instance sketch pasted on its own: (p) => { p.setup = ... }
				if (/^\s*(\(\s*[A-Za-z_$][\w$]*\s*\)|[A-Za-z_$][\w$]*)\s*=>/.test(text) || /^\s*function\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(text)) {
					text = 'new p5(' + text.replace(/;\s*$/, '') + '\n);';
				}
				scripts.push({ text: text, name: p.split('/').pop() });
			});
		}
		if (!hasP5) {
			var ok = false;
			for (var i = 0; i < bundled.length && !ok; i++) ok = await loadScriptEl({ src: bundled[i] });
			if (!ok) throw new Error('Could not load p5.js from ' + bundled.join(' or '));
		}
		var p5Fallback = null;
		for (var j = 0; j < scripts.length; j++) {
			var sc = scripts[j];
			var loaded = await loadScriptEl(sc);
			if (!loaded && sc.src && isP5Src(sc.src)) {
				// The p5 build the sketch asked for is unreachable: use GS's copy.
				for (var k = 0; k < bundled.length && !loaded; k++) loaded = await loadScriptEl({ src: bundled[k] });
				if (loaded) p5Fallback = sc.src;
			}
			if (!loaded) throw new Error('Could not load script ' + sc.src);
		}
		// Global mode: p5 only auto-starts on the window "load" event, which
		// fired before these scripts were added, so start it here.
		if (typeof window.p5 === 'function' && !window.p5.instance &&
			(typeof window.setup === 'function' || typeof window.draw === 'function' || typeof window.preload === 'function')) {
			new window.p5(); // eslint-disable-line no-new
		}
		var version = typeof window.p5 === 'function' && window.p5.prototype && window.p5.prototype.VERSION;
		if (!version && typeof window.p5 === 'function') {
			// Old p5 builds (< 0.6) have no VERSION: read it from the script URL.
			var srcs = Array.prototype.map.call(document.querySelectorAll('script[src]'), function (e) { return e.src; });
			for (var q = 0; q < srcs.length && !version; q++) {
				var vm = isP5Src(srcs[q]) && srcs[q].match(/p5(?:\.js)?[@/]v?(\d+\.\d+\.\d+)/i);
				if (vm) version = vm[1];
			}
		}
		post({ type: 'ready', p5Version: version || (typeof window.p5 === 'function' ? 'unknown' : null), usedBundled: !hasP5 || !!p5Fallback, p5Fallback: p5Fallback });
	}

	// --- Frames -------------------------------------------------------------
	function mainCanvas() {
		var list = document.querySelectorAll('canvas');
		if (!list.length) return null;
		var best = null;
		for (var i = 0; i < list.length; i++) {
			var c = list[i];
			if (!c.width || !c.height) continue;
			if (c.classList.contains('p5Canvas') && c.style.display !== 'none') return c;
			if (!best || c.width * c.height > best.width * best.height) best = c;
		}
		return best;
	}
	var dirty = 4;       // capture the first few ticks regardless
	var lastCapture = 0;
	var lastSize = '';
	function onTick() {
		var cbs = rafQueue;
		rafQueue = new Map();
		var now = performance.now();
		cbs.forEach(function (cb) {
			try { cb(now); } catch (e) { post({ type: 'error', message: errText(e) }); }
		});
		var canvas = mainCanvas();
		if (!canvas) { post({ type: 'idle' }); return; }
		var size = canvas.width + 'x' + canvas.height;
		if (cbs.size || dirty > 0 || size !== lastSize || now - lastCapture > 500) {
			dirty = Math.max(0, dirty - 1);
			lastCapture = now;
			lastSize = size;
			createImageBitmap(canvas).then(function (bm) {
				post({ type: 'frame', bitmap: bm, width: bm.width, height: bm.height }, [bm]);
			}, function () { post({ type: 'idle' }); });
		} else {
			post({ type: 'idle' });
		}
	}

	// --- Input from GS (desktop/phone clicks and XR controller rays on the panel)
	var mouseState = { buttons: 0 };
	function onInput(msg) {
		var canvas = mainCanvas();
		if (!canvas) return;
		var rect = canvas.getBoundingClientRect();
		var x = rect.left + msg.u * (rect.width || canvas.width);
		var y = rect.top + msg.v * (rect.height || canvas.height);
		var buttons = msg.buttons != null ? msg.buttons : mouseState.buttons;
		var init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y, button: 0, buttons: buttons };
		var kind = msg.kind;
		var pmap = { mousemove: 'pointermove', mousedown: 'pointerdown', mouseup: 'pointerup' };
		if (pmap[kind]) {
			try { canvas.dispatchEvent(new PointerEvent(pmap[kind], Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: buttons ? 0.5 : 0 }, init))); } catch (e) { /* old browser */ }
		}
		if (kind === 'wheel') {
			canvas.dispatchEvent(new WheelEvent('wheel', Object.assign({ deltaY: msg.deltaY || 0 }, init)));
		} else {
			canvas.dispatchEvent(new MouseEvent(kind, init));
		}
		dirty = Math.max(dirty, 2); // noLoop() sketches redraw from event handlers
	}
	function onKey(msg) {
		var ev = new KeyboardEvent(msg.kind, { key: msg.key, code: msg.code, bubbles: true, cancelable: true, shiftKey: !!msg.shiftKey, ctrlKey: !!msg.ctrlKey, altKey: !!msg.altKey, metaKey: !!msg.metaKey, repeat: !!msg.repeat });
		Object.defineProperty(ev, 'keyCode', { get: function () { return msg.keyCode || 0; } });
		Object.defineProperty(ev, 'which', { get: function () { return msg.keyCode || 0; } });
		(document.activeElement || document.body || document).dispatchEvent(ev);
		dirty = Math.max(dirty, 2);
	}

	window.addEventListener('message', function (ev) {
		if (ev.source !== parentWin) return;
		var msg = ev.data;
		if (!msg || msg.gsP5Host !== 1) return;
		if (msg.type === 'load') {
			loadProject(msg).catch(function (e) { post({ type: 'error', fatal: true, message: errText(e) }); });
		} else if (msg.type === 'tick') {
			onTick();
		} else if (msg.type === 'input') {
			if (msg.kind === 'mousedown') mouseState.buttons = 1;
			if (msg.kind === 'mouseup') mouseState.buttons = 0;
			onInput(msg);
		} else if (msg.type === 'key') {
			onKey(msg);
		} else if (msg.type === 'dispose') {
			try { if (window.p5 && window.p5.instance) window.p5.instance.remove(); } catch (e) { /* ignore */ }
		}
	});
	post({ type: 'hello' });
}


// ---------------------------------------------------------------------------
// Running sketches
// ---------------------------------------------------------------------------
const sketches = new Set(); // live handles (one per panel)
let importSerial = 0;

function bundledP5Sources() {
	const d = window.GS_DEPS?.get?.('p5');
	const list = [];
	if (d?.src) list.push(new URL(d.src, location.href).href);
	if (d?.fallbackSrc) list.push(new URL(d.fallbackSrc, location.href).href);
	if (!list.length) list.push('https://cdn.jsdelivr.net/npm/p5@1.11.13/lib/p5.min.js');
	return list;
}
const bundledP5Version = () => window.GS_DEPS?.get?.('p5')?.version || '1.11.13';

// Make sure p5.js is switched on in Dependencies (the Dependencies tab and
// the AI's settings note then show it as in use).
function ensureP5Dependency() {
	const deps = window.GS_DEPS;
	if (deps && !deps.isEnabled('p5')) deps.setEnabled('p5', true);
}

// Normalises the `files` map of a code block into transferable entries.
function decodeFiles(files) {
	const out = [];
	for (const [path, v] of Object.entries(files || {})) {
		if (typeof v === 'string') out.push({ path, text: v, type: mimeOf(path) });
		else if (v && typeof v.url === 'string') out.push({ path, url: v.url, type: v.type || mimeOf(path) });
		else if (v && typeof v.base64 === 'string') {
			const bin = atob(v.base64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			out.push({ path, buffer: bytes.buffer, type: v.type || mimeOf(path) });
		} else if (v && typeof v.text === 'string') out.push({ path, text: v.text, type: v.type || mimeOf(path) });
	}
	return out;
}

function pickEntry(files) {
	const paths = Object.keys(files || {});
	const depth = (p) => p.split('/').length;
	const html = paths.filter((p) => /(^|\/)index\.html?$/i.test(p)).sort((a, b) => depth(a) - depth(b))[0]
		|| paths.filter((p) => /\.html?$/i.test(p)).sort((a, b) => depth(a) - depth(b))[0];
	if (html) return html;
	return paths.find((p) => /(^|\/)sketch\.js$/i.test(p)) || paths.find((p) => /\.m?js$/i.test(p)) || '';
}

// Places a new panel in front of the user (camera), fanning out sideways
// when several imported sketches are open, facing the viewer.
function placeInFront(mesh, slot, widthMeters, explicitPos) {
	const THREE = window.THREE;
	const parent = window.gsGetWorldContentParent ? window.gsGetWorldContentParent() : window.scene;
	if (explicitPos) {
		mesh.position.set(explicitPos[0] || 0, explicitPos[1] || 0, explicitPos[2] || 0);
		parent.add(mesh);
		return;
	}
	const cam = window.camera;
	cam.updateMatrixWorld(true);
	const eye = new THREE.Vector3();
	cam.getWorldPosition(eye);
	const fwd = new THREE.Vector3();
	cam.getWorldDirection(fwd);
	if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
	// Along the view direction, but never steeper than ~35 degrees up/down.
	const flat = Math.hypot(fwd.x, fwd.z) || 1;
	const pitch = Math.max(-0.6, Math.min(0.6, Math.atan2(fwd.y, flat)));
	fwd.set(fwd.x / flat, 0, fwd.z / flat);
	if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
	const dist = Math.max(1.5, widthMeters * 1.2);
	// slot 0 straight ahead, then right, left, further right, ...
	const step = Math.ceil(slot / 2) * (slot % 2 ? 1 : -1);
	const yaw = step * Math.min(0.9, (widthMeters + 0.15) / dist);
	fwd.applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
	const pos = eye.clone().addScaledVector(fwd, dist * Math.cos(pitch));
	pos.y = Math.max(0.5, eye.y + Math.sin(pitch) * dist);
	mesh.position.copy(pos);
	mesh.lookAt(eye);
	mesh.updateMatrixWorld(true);
	parent.attach(mesh);
}

function freeSlot() {
	const used = new Set([...sketches].map((s) => s.slot));
	let i = 0;
	while (used.has(i)) i++;
	return i;
}

// Draws an error banner across the bottom of the panel (visible in VR).
function drawErrorBanner(ctx, w, h, text) {
	const pad = Math.max(8, Math.round(w / 60));
	const fs = Math.max(12, Math.round(w / 36));
	ctx.save();
	ctx.font = `${fs}px system-ui, sans-serif`;
	const lines = [];
	const words = String(text).split(/\s+/);
	let line = '';
	for (const wd of words) {
		const test = line ? line + ' ' + wd : wd;
		if (ctx.measureText(test).width > w - pad * 2 && line) { lines.push(line); line = wd; } else line = test;
		if (lines.length >= 3) break;
	}
	if (line && lines.length < 4) lines.push(line);
	const bh = lines.length * fs * 1.3 + pad * 2;
	ctx.fillStyle = 'rgba(160, 20, 30, 0.88)';
	ctx.fillRect(0, h - bh, w, bh);
	ctx.fillStyle = '#fff';
	ctx.textBaseline = 'top';
	lines.forEach((l, i) => ctx.fillText(l, pad, h - bh + pad + i * fs * 1.3));
	ctx.restore();
}

/**
 * Runs a p5.js sketch on a panel in the scene. This is what imported-sketch
 * code blocks call; it can also be used directly from scene code.
 *   await gsImportP5Sketch({
 *     name: 'My sketch',
 *     files: { 'sketch.js': `function setup() { createCanvas(400, 400); } ...`,
 *              'index.html': `...`,                         // optional
 *              'assets/cat.png': { base64: '...', type: 'image/png' },
 *              'data.json': { url: 'https://...' } },        // remote file
 *     entry: 'index.html',      // optional, auto-detected
 *     baseUrl: 'https://...',   // optional: unknown relative paths resolve here
 *     widthMeters, position: [x, y, z], pixelDensity, viewport: [w, h]
 *   })
 * Resolves to a handle { name, surface, mesh, p5Version, remove() } once the
 * sketch's scripts have loaded. Remove the panel with handle.remove() (or by
 * deleting its code block and pressing Apply); that destroys the iframe and
 * with it the p5 instance, its audio and its timers.
 */
async function gsImportP5Sketch(opts = {}) {
	if (typeof window.gsCreateCanvasSurface !== 'function') throw new Error('gsImportP5Sketch: GS canvas surfaces are not ready yet');
	const files = opts.files || (opts.code ? { 'sketch.js': opts.code } : null);
	if (!files || !Object.keys(files).length) throw new Error('gsImportP5Sketch: no sketch files given');
	ensureP5Dependency();
	const name = String(opts.name || 'p5 sketch');
	const entry = opts.entry || pickEntry(files);
	const [vw, vh] = Array.isArray(opts.viewport) ? opts.viewport : [960, 720];

	const canvas = document.createElement('canvas');
	canvas.width = 400; canvas.height = 400;
	const ctx2d = canvas.getContext('2d');
	ctx2d.fillStyle = '#1b1b24'; ctx2d.fillRect(0, 0, 400, 400);
	ctx2d.fillStyle = '#bbb'; ctx2d.font = '20px system-ui, sans-serif'; ctx2d.fillText(`Loading ${name.slice(0, 28)}…`, 20, 200);

	const widthFor = (w) => opts.widthMeters || Math.min(2.4, Math.max(0.8, w / 500));
	const surface = window.gsCreateCanvasSurface({ canvas, context: null, widthMeters: widthFor(400), name: `gs-p5-import:${name}`, addToScene: false });
	surface.ctx = ctx2d;
	surface.importedSketch = true;
	const slot = freeSlot();
	placeInFront(surface.mesh, slot, surface.widthMeters, opts.position);

	const iframe = document.createElement('iframe');
	iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
	// p5 listens for device motion/orientation on start-up; allowing the
	// sensors keeps that from logging permissions-policy violations.
	iframe.setAttribute('allow', 'accelerometer; gyroscope; magnetometer');
	iframe.setAttribute('aria-hidden', 'true');
	iframe.tabIndex = -1;
	iframe.title = `p5 sketch: ${name}`;
	iframe.className = 'gs-p5-import-frame';
	iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${vw}px;height:${vh}px;border:0;opacity:0;pointer-events:none;`;
	iframe.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}</style>'
		+ `<script>(${gsP5FrameBootstrap.toString()})();<\/script></head><body></body></html>`;

	const handle = {
		id: ++importSerial,
		name, slot, surface, mesh: surface.mesh, iframe,
		p5Version: null, lastError: null, removed: false,
		width: 0, height: 0,
		remove() { surface.dispose(); }
	};
	let waiting = false;
	let waitingSince = 0;
	let readyResolve, readyReject, firstFrame;
	const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
	const gotFrame = new Promise((res) => { firstFrame = res; });
	const post = (msg) => { try { iframe.contentWindow?.postMessage({ ...msg, gsP5Host: 1 }, '*'); } catch { /* frame gone */ } };
	handle.post = post;

	const onMessage = (ev) => {
		if (ev.source !== iframe.contentWindow) return;
		const msg = ev.data;
		if (!msg || msg.gsP5 !== 1) return;
		if (msg.type === 'hello') {
			const decoded = decodeFiles(files);
			post({
				type: 'load', files: decoded, entry, baseUrl: opts.baseUrl || '',
				bundledP5: bundledP5Sources(), pixelDensity: opts.pixelDensity || 1
			});
		} else if (msg.type === 'ready') {
			handle.p5Version = msg.p5Version;
			handle.usedBundledP5 = !!msg.usedBundled;
			handle.p5Fallback = msg.p5Fallback || null;
			if (!msg.p5Version) readyReject(new Error('p5.js did not load in the sketch frame'));
			else readyResolve();
		} else if (msg.type === 'frame') {
			waiting = false;
			const bm = msg.bitmap;
			if (!bm) return;
			if (handle.removed) { bm.close?.(); return; }
			if (canvas.width !== bm.width || canvas.height !== bm.height) {
				canvas.width = bm.width; canvas.height = bm.height;
				surface.widthMeters = widthFor(bm.width);
				surface._aspect = 0; // re-fit the panel to the sketch's aspect ratio
				// three.js allocates immutable GPU storage on first upload, so a
				// new canvas size needs a fresh texture.
				surface.texture.dispose();
			}
			handle.width = bm.width; handle.height = bm.height;
			firstFrame();
			ctx2d.clearRect(0, 0, canvas.width, canvas.height);
			ctx2d.drawImage(bm, 0, 0);
			bm.close?.();
			if (handle.lastError) drawErrorBanner(ctx2d, canvas.width, canvas.height, handle.lastError);
		} else if (msg.type === 'idle') {
			waiting = false;
		} else if (msg.type === 'error') {
			if (msg.message !== handle.lastError) console.error(`[p5 import] ${name}: ${msg.message}`);
			handle.lastError = msg.message;
			drawErrorBanner(ctx2d, canvas.width, canvas.height, msg.message);
			if (msg.fatal) readyReject(new Error(msg.message));
			window.dispatchEvent(new CustomEvent('gs-p5-import-error', { detail: { name, message: msg.message } }));
		} else if (msg.type === 'log') {
			console.info(`[p5 import] ${name}: ${msg.message}`);
		}
	};
	window.addEventListener('message', onMessage);

	// Mouse events that GS dispatches on surface.canvas (the desktop/phone
	// pointer bridge below, and XR controller rays from main.js) are mapped to
	// canvas coordinates and replayed inside the sketch.
	const forward = (ev) => {
		const rect = canvas.isConnected ? canvas.getBoundingClientRect() : null;
		const w = rect && rect.width ? rect.width : canvas.width;
		const h = rect && rect.height ? rect.height : canvas.height;
		const ox = typeof ev.offsetX === 'number' ? ev.offsetX : ev.clientX;
		const oy = typeof ev.offsetY === 'number' ? ev.offsetY : ev.clientY;
		const msg = { type: 'input', kind: ev.type, u: Math.min(1, Math.max(0, ox / w)), v: Math.min(1, Math.max(0, oy / h)), buttons: ev.buttons };
		if (ev.type === 'wheel') msg.deltaY = ev.deltaY;
		post(msg);
		if (ev.type === 'mousedown') focusSketch(handle);
	};
	const FWD = ['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel'];
	for (const t of FWD) canvas.addEventListener(t, forward);

	// Frames: GS's render loop asks the sketch for one frame at a time.
	const baseTick = surface._tick;
	surface._tick = (time) => {
		const now = performance.now();
		if (!waiting || now - waitingSince > 1000) {
			waiting = true;
			waitingSince = now;
			post({ type: 'tick' });
		}
		baseTick(time);
	};
	const ti = window._vrAnimations.indexOf(baseTick);
	if (ti >= 0) window._vrAnimations[ti] = surface._tick;

	const baseDispose = surface.dispose;
	surface.dispose = () => {
		if (handle.removed) return;
		handle.removed = true;
		sketches.delete(handle);
		if (focusedSketch === handle) focusedSketch = null;
		post({ type: 'dispose' });
		window.removeEventListener('message', onMessage);
		for (const t of FWD) canvas.removeEventListener(t, forward);
		// Detaching the iframe destroys its document: the p5 instance, its
		// audio context, timers and blob URLs go with it.
		iframe.remove();
		baseDispose();
		window.dispatchEvent(new CustomEvent('gs-p5-import-change'));
	};

	sketches.add(handle);
	installPointerBridge();
	document.body.appendChild(iframe);

	let timer;
	try {
		await Promise.race([
			ready,
			new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Sketch "${name}" did not finish loading within ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS); })
		]);
		// Give setup() a moment to produce the first frame, so the panel has
		// the sketch's real size when this resolves.
		await Promise.race([gotFrame, new Promise((r) => setTimeout(r, 3000))]);
	} catch (e) {
		surface.dispose();
		throw e;
	} finally {
		clearTimeout(timer);
	}
	window.dispatchEvent(new CustomEvent('gs-p5-import-change'));
	return handle;
}
gsImportP5Sketch.list = () => [...sketches];

// ---------------------------------------------------------------------------
// Desktop / phone pointer bridge: a click or touch on an imported sketch's
// panel becomes mouse events on surface.canvas (forwarded above). Runs in the
// capture phase so orbit controls don't also drag; main.js may handle canvas
// surfaces itself, in which case it stops the event first and this is idle.
// ---------------------------------------------------------------------------
let bridgeInstalled = false;
let focusedSketch = null;
let dragSketch = null;
function focusSketch(h) { focusedSketch = h; }

function dispatchOnSurface(h, uv, type, pressed) {
	const c = h.surface.canvas;
	const offsetX = Math.min(1, Math.max(0, uv.x)) * c.width;
	const offsetY = Math.min(1, Math.max(0, 1 - uv.y)) * c.height;
	const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: offsetX, clientY: offsetY, button: 0, buttons: pressed ? 1 : 0 });
	Object.defineProperty(ev, 'offsetX', { value: offsetX });
	Object.defineProperty(ev, 'offsetY', { value: offsetY });
	c.dispatchEvent(ev);
}

function installPointerBridge() {
	if (bridgeInstalled || !window.renderer || !window.THREE) return;
	bridgeInstalled = true;
	const THREE = window.THREE;
	const el = window.renderer.domElement;
	const ray = new THREE.Raycaster();
	const ndc = new THREE.Vector2();
	const hitAt = (e) => {
		if (!sketches.size || window.renderer.xr.isPresenting) return null;
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
		ray.setFromCamera(ndc, window.camera);
		const meshes = [...sketches].map((s) => s.mesh).filter((m) => m.parent && m.visible);
		const hit = ray.intersectObjects(meshes, false).find((x) => x.uv);
		if (!hit) return null;
		const h = [...sketches].find((s) => s.mesh === hit.object);
		return h ? { h, uv: hit.uv } : null;
	};
	if (window.gsSurfacePointerInput) {
		// main.js turns mouse/touch/controller input on every canvas surface
		// (imported sketches included) into events on surface.canvas, which
		// forward() above relays. A second bridge here would double-fire, so
		// only keep "click elsewhere drops keyboard focus" (main.js stops
		// presses that land on a surface before they reach this listener).
		el.addEventListener('pointerdown', () => { focusedSketch = null; }, true);
	} else {
	el.addEventListener('pointerdown', (e) => {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		const hit = hitAt(e);
		if (!hit) { focusedSketch = null; return; }
		e.stopImmediatePropagation();
		e.preventDefault();
		dragSketch = { h: hit.h, pointerId: e.pointerId };
		try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
		dispatchOnSurface(hit.h, hit.uv, 'mousemove', false);
		dispatchOnSurface(hit.h, hit.uv, 'mousedown', true);
	}, true);
	el.addEventListener('pointermove', (e) => {
		if (dragSketch) {
			if (e.pointerId !== dragSketch.pointerId) return;
			e.stopImmediatePropagation();
			const hit = hitAt(e);
			if (hit && hit.h === dragSketch.h) dispatchOnSurface(hit.h, hit.uv, 'mousemove', true);
			return;
		}
		if (e.buttons || e.pointerType !== 'mouse') return;
		const hit = hitAt(e);
		if (hit) dispatchOnSurface(hit.h, hit.uv, 'mousemove', false);
	}, true);
	const end = (e) => {
		if (!dragSketch || e.pointerId !== dragSketch.pointerId) return;
		e.stopImmediatePropagation();
		const { h } = dragSketch;
		dragSketch = null;
		try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
		const hit = hitAt(e);
		const uv = hit && hit.h === h ? hit.uv : null;
		if (uv && e.type !== 'pointercancel') {
			dispatchOnSurface(h, uv, 'mouseup', false);
			dispatchOnSurface(h, uv, 'click', false);
		} else {
			dispatchOnSurface(h, uv || { x: 0.5, y: 0.5 }, 'mouseup', false);
		}
	};
	el.addEventListener('pointerup', end, true);
	el.addEventListener('pointercancel', end, true);
	}
	// Keys go to the sketch whose panel was clicked last (until you click elsewhere).
	const keyFwd = (e) => {
		const h = focusedSketch;
		if (!h || h.removed) return;
		const t = e.target;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		h.post({ type: 'key', kind: e.type, key: e.key, code: e.code, keyCode: e.keyCode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat });
	};
	window.addEventListener('keydown', keyFwd, true);
	window.addEventListener('keyup', keyFwd, true);
}

// ---------------------------------------------------------------------------
// Turning user input into a { name, files, entry, baseUrl } project
// ---------------------------------------------------------------------------
const u8ToBase64 = (u8) => {
	let s = '';
	const CH = 0x8000;
	for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
	return btoa(s);
};

function addFileBytes(files, path, u8) {
	if (isTextPath(path)) files[path] = strFromU8(u8);
	else files[path] = { base64: u8ToBase64(u8), type: mimeOf(path) };
}

// Strips a folder prefix shared by every path (zip downloads of a folder).
function stripCommonFolder(paths) {
	if (!paths.length) return (p) => p;
	const firstSeg = (p) => (p.includes('/') ? p.split('/')[0] + '/' : null);
	const seg = firstSeg(paths[0]);
	if (!seg || !paths.every((p) => p.startsWith(seg))) return (p) => p;
	return (p) => p.slice(seg.length);
}

function projectFromZip(u8, zipName) {
	let entries;
	try { entries = unzipSync(u8); } catch (e) { throw new Error(`Could not read the .zip (${e.message || e})`); }
	const paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !/(^|\/)(__MACOSX|\.git)\//.test(p) && !/(^|\/)\.DS_Store$/.test(p));
	if (!paths.length) throw new Error('The .zip is empty');
	const strip = stripCommonFolder(paths);
	const files = {};
	for (const p of paths) addFileBytes(files, strip(p), entries[p]);
	if (!Object.keys(files).some((p) => /\.(m?js|html?)$/i.test(p))) throw new Error('The .zip has no .js or .html file');
	const folder = strip(paths[0]) !== paths[0] ? paths[0].split('/')[0] : '';
	return { name: folder || zipName.replace(/\.zip$/i, ''), files };
}

async function projectFromFileList(fileList) {
	const list = [...fileList];
	if (!list.length) throw new Error('Choose a file first');
	if (list.length === 1 && /\.zip$/i.test(list[0].name)) {
		return projectFromZip(new Uint8Array(await list[0].arrayBuffer()), list[0].name);
	}
	const rels = list.map((f) => f.webkitRelativePath || f.name);
	const strip = stripCommonFolder(rels);
	const files = {};
	for (let i = 0; i < list.length; i++) {
		const f = list[i];
		if (/\.zip$/i.test(f.name)) throw new Error('Import a .zip on its own, not together with other files');
		addFileBytes(files, strip(rels[i]), new Uint8Array(await f.arrayBuffer()));
	}
	if (!Object.keys(files).some((p) => /\.(m?js|html?)$/i.test(p))) throw new Error('Include at least one .js or .html file');
	const main = list.find((f) => /^index\.html?$/i.test(f.name)) || list.find((f) => /^sketch\.js$/i.test(f.name)) || list.find((f) => /\.(m?js|html?)$/i.test(f.name));
	const folder = list[0].webkitRelativePath ? list[0].webkitRelativePath.split('/')[0] : '';
	return { name: folder || main.name.replace(/\.(m?js|html?)$/i, ''), files };
}

function projectFromPaste(code, name) {
	const text = String(code || '');
	if (!text.trim()) throw new Error('Paste some p5.js code first');
	if (/^\s*<(!doctype|html|head|body|script)/i.test(text)) {
		return { name: name || 'Pasted sketch', files: { 'index.html': text } };
	}
	return { name: name || 'Pasted sketch', files: { 'sketch.js': text } };
}

// --- URLs ---------------------------------------------------------------------
function githubToRaw(u) {
	// github.com/<u>/<r>/blob/<ref>/<path>  -> raw.githubusercontent.com/<u>/<r>/<ref>/<path>
	let m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i);
	if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
	// github.com/<u>/<r>/tree/<ref>/<dir>  -> <dir>/index.html
	m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+?)\/?$/i);
	if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/index.html`;
	// gist.github.com/<u>/<id> -> raw (first file)
	m = u.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?$/i);
	if (m) return `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`;
	return u;
}

async function fetchText(url) {
	let res;
	try {
		res = await fetch(url, { mode: 'cors', credentials: 'omit' });
	} catch {
		const err = new Error(`The browser was not allowed to read ${url} (the server does not send CORS headers, or the network is down)`);
		err.cors = true;
		throw err;
	}
	if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
	return res.text();
}

// Fetches the local scripts and styles an index.html references (so they
// are saved with the scene and editable); assets stay remote and resolve
// against the page's URL at run time.
async function projectFromHtmlUrl(url, html) {
	const files = { 'index.html': html };
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const refs = [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))
		.concat([...doc.querySelectorAll('link[rel~="stylesheet"][href]')].map((l) => l.getAttribute('href')))
		.filter((s) => s && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(s));
	for (const ref of refs) {
		const clean = ref.replace(/[?#].*$/, '').replace(/^\.\//, '');
		const abs = new URL(ref, url).href;
		try { files[clean] = await fetchText(abs); } catch { files[clean] = { url: abs }; }
	}
	return { files, entry: 'index.html', baseUrl: new URL('.', url).href };
}

// p5 web editor project JSON ({ files: [{ id, name, fileType, children, content, url }] })
function projectFromEditorJson(data, sourceUrl) {
	const list = Array.isArray(data?.files) ? data.files : [];
	const byId = new Map(list.map((f) => [f.id || f._id, f]));
	const root = list.find((f) => f.name === 'root' && f.fileType === 'folder');
	if (!root) throw new Error('The p5 editor response had no files');
	const files = {};
	const walk = (folder, prefix) => {
		for (const cid of folder.children || []) {
			const f = byId.get(cid);
			if (!f) continue;
			const p = prefix + f.name;
			if (f.fileType === 'folder') walk(f, p + '/');
			else if (f.url) files[p] = { url: f.url, type: mimeOf(p) };
			else files[p] = f.content || '';
		}
	};
	walk(root, '');
	return { name: data.name || 'p5 editor sketch', files, entry: pickEntry(files), source: sourceUrl };
}

const EDITOR_RE = /^https?:\/\/(?:www\.)?editor\.p5js\.org\/([A-Za-z0-9_.-]+)\/(?:sketches|full|present|embed)\/([A-Za-z0-9_-]+)/i;
const OPENPROCESSING_RE = /^https?:\/\/(?:www\.)?openprocessing\.org\/sketch\/(\d+)/i;

async function projectFromUrl(rawUrl) {
	const input = String(rawUrl || '').trim();
	if (!input) throw new Error('Enter a URL first');
	let url;
	try { url = new URL(input).href; } catch { throw new Error('That is not a valid URL'); }

	// p5.js web editor: editor.p5js.org/<user>/sketches/<id>
	let m = url.match(EDITOR_RE);
	if (m) {
		const [, user, id] = m;
		// editor.p5js.org's project JSON (/editor/<user>/projects/<id>) is
		// public but sends no CORS headers to other sites, so the browser can't
		// read it directly; GS's server relays that one endpoint.
		let data = null;
		{
			try {
				const res = await fetch(`/api/p5-editor/${encodeURIComponent(user)}/${encodeURIComponent(id)}`);
				if (res.ok) data = await res.json();
				else if (res.status === 404) {
					const body = await res.json().catch(() => null);
					if (body?.notFound) throw new Error(`The p5 editor has no public sketch ${user}/${id}`);
				}
			} catch (e) { if (/no public sketch/.test(e.message)) throw e; }
		}
		if (!data) {
			throw new Error('editor.p5js.org doesn\'t let other websites read sketches, and this GS host has no p5 editor relay. '
				+ 'In the p5 editor, use File \u2192 Download, then import the .zip here with "File".');
		}
		const proj = projectFromEditorJson(data, url);
		proj.name = data.name || `${user}/${id}`;
		return proj;
	}

	// OpenProcessing: openprocessing.org/sketch/<id> (public API sends CORS headers)
	m = url.match(OPENPROCESSING_RE);
	if (m) {
		const id = m[1];
		const meta = JSON.parse(await fetchText(`https://openprocessing.org/api/sketch/${id}`));
		if (meta.mode && meta.mode !== 'p5js') throw new Error(`OpenProcessing sketch ${id} is a "${meta.mode}" sketch, not p5.js`);
		const code = JSON.parse(await fetchText(`https://openprocessing.org/api/sketch/${id}/code`));
		const files = {};
		const tabs = (Array.isArray(code) ? code : []).map((c, i) => ({ name: `${(c.title || `tab${i}`).replace(/[^\w.-]+/g, '_')}.js`, code: c.code || '' }));
		if (!tabs.length) throw new Error(`OpenProcessing sketch ${id} has no code`);
		const libs = (meta.libraries || []).map((l) => l.url).filter(Boolean);
		const engine = meta.engineURL || bundledP5Sources()[0];
		files['index.html'] = '<!doctype html><html><head><meta charset="utf-8">'
			+ [engine, ...libs].map((s) => `<script src="${s.replace(/"/g, '&quot;')}"></script>`).join('')
			+ '</head><body>' + tabs.map((t) => `<script src="${t.name}"></script>`).join('') + '</body></html>';
		for (const t of tabs) files[t.name] = t.code;
		return { name: meta.title || `OpenProcessing ${id}`, files, entry: 'index.html', baseUrl: meta.fileBase || '', source: url };
	}

	url = githubToRaw(url);
	const text = await fetchText(url).catch((e) => {
		if (e.cors && /\.m?js(\?|$)/i.test(url)) return null; // fall back to a <script src>
		throw e;
	});
	const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'sketch.js');
	if (text == null) {
		return { name: fileName, files: { [fileName]: { url } }, entry: fileName, baseUrl: new URL('.', url).href, source: rawUrl };
	}
	if (/\.html?$/i.test(fileName) || /^\s*<(!doctype|html|head|script)/i.test(text)) {
		const proj = await projectFromHtmlUrl(url, text);
		return { name: fileName.replace(/\.html?$/i, '') === 'index' ? (new URL(url).pathname.split('/').slice(-2, -1)[0] || 'sketch') : fileName, ...proj, source: rawUrl };
	}
	const jsName = /\.m?js$/i.test(fileName) ? fileName : 'sketch.js';
	return { name: fileName, files: { [jsName]: text }, entry: jsName, baseUrl: new URL('.', url).href, source: rawUrl };
}

// ---------------------------------------------------------------------------
// The code block an import becomes
// ---------------------------------------------------------------------------
function templateLiteral(s) {
	return '`' + String(s)
		.replace(/\\/g, '\\\\')
		.replace(/`/g, '\\`')
		.replace(/\$\{/g, '\\${')
		// A line starting "// --- x ---" would split the block in the code window.
		.replace(/^\/\/ --- /gm, '\\x2F/ --- ')
		.replace(/\r\n?/g, '\n') + '`';
}

function buildImportCodeBlock(project, how) {
	const lines = [];
	const embedded = Object.values(project.files).reduce((n, v) => n + (typeof v === 'string' ? v.length : (v.base64 || '').length), 0);
	if (embedded > MAX_EMBED_BYTES) throw new Error(`This sketch is ${(embedded / 1048576).toFixed(1)} MB once embedded; the limit is ${MAX_EMBED_BYTES / 1048576} MB. Remove large assets or host them and use URLs.`);
	lines.push(`// Imported p5.js sketch: ${String(project.name).replace(/[\r\n]+/g, ' ')} (${how}${project.source ? ` from ${project.source}` : ''})`);
	lines.push('// Runs in its own sandboxed frame and shows on a panel in front of you. Edit the files below and press Apply.');
	lines.push('await gsImportP5Sketch({');
	lines.push(`\tname: ${JSON.stringify(String(project.name))},`);
	if (project.entry) lines.push(`\tentry: ${JSON.stringify(project.entry)},`);
	if (project.baseUrl) lines.push(`\tbaseUrl: ${JSON.stringify(project.baseUrl)},`);
	lines.push('\tfiles: {');
	const entries = Object.entries(project.files);
	// Code first (entry last among text files reads naturally), assets after.
	entries.sort(([a, av], [b, bv]) => (typeof av === 'string' ? 0 : 1) - (typeof bv === 'string' ? 0 : 1));
	entries.forEach(([path, v], i) => {
		const comma = i < entries.length - 1 ? ',' : '';
		if (typeof v === 'string') lines.push(`\t\t${JSON.stringify(path)}: ${templateLiteral(v)}${comma}`);
		else lines.push(`\t\t${JSON.stringify(path)}: ${JSON.stringify(v)}${comma}`);
	});
	lines.push('\t}');
	lines.push('});');
	return { code: lines.join('\n'), embeddedBytes: embedded };
}

async function importProject(project, how) {
	// Unique names, so "Remove" finds exactly this sketch's code block.
	const taken = new Set([...sketches].map((h) => h.name));
	const base = String(project.name || 'p5 sketch');
	let name = base;
	for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
	project.name = name;
	const { code, embeddedBytes } = buildImportCodeBlock(project, how);
	if (!window.gsSessionCode?.add) throw new Error('GS is still starting; try again in a moment');
	await window.gsSessionCode.add(code);
	return { embeddedBytes };
}

// ---------------------------------------------------------------------------
// UI: "Import p5 sketch" button (Environment -> 2D/3D section and the code
// window toolbar) opening a small dialog with Paste / File / URL.
// ---------------------------------------------------------------------------
const CSS = `
#gs-p5i-modal{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font-family:var(--dchat-font,system-ui,sans-serif)}
#gs-p5i-modal.open{display:flex}
#gs-p5i-box{width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;box-sizing:border-box;padding:16px;border-radius:14px;background:#1d1e2a;color:#fff;border:1px solid rgba(255,255,255,.18);box-shadow:0 12px 40px rgba(0,0,0,.5)}
#gs-p5i-box h3{margin:0 0 4px;font-size:16px}
#gs-p5i-box .gs-p5i-sub{font-size:12px;color:rgba(255,255,255,.6);margin-bottom:10px;line-height:1.4}
#gs-p5i-tabs{display:flex;gap:6px;margin-bottom:10px}
#gs-p5i-tabs button{flex:1}
#gs-p5i-tabs button[aria-selected="true"]{background:linear-gradient(135deg,#6366f1,#8b5cf6)}
.gs-p5i-pane{display:none;flex-direction:column;gap:8px}
.gs-p5i-pane.active{display:flex}
#gs-p5i-box textarea,#gs-p5i-box input[type=text],#gs-p5i-box input[type=url]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);color:#fff;font-size:13px}
#gs-p5i-box textarea{min-height:180px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;resize:vertical}
#gs-p5i-box .gs-p5i-hint{font-size:11px;color:rgba(255,255,255,.5);line-height:1.4}
#gs-p5i-box .gs-p5i-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#gs-p5i-status{min-height:18px;margin-top:10px;font-size:12px;line-height:1.4;white-space:pre-wrap;word-break:break-word}
#gs-p5i-status.error{color:#ff8a8a}
#gs-p5i-status.ok{color:#8ef0a8}
#gs-p5i-status.pending{color:#c9c9ff}
#gs-p5i-list{margin-top:10px;display:flex;flex-direction:column;gap:6px}
#gs-p5i-list .gs-p5i-item{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.06)}
#gs-p5i-list .gs-p5i-item span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gs-p5i-list .gs-p5i-item em{color:#ff8a8a;font-style:normal}
#gs-p5i-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.gs-p5i-open{margin-top:10px;width:100%}
`;

let modal = null;
let activeTab = 'paste';

function el(tag, attrs = {}, children = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'text') n.textContent = v;
		else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v);
	}
	for (const c of children) n.appendChild(c);
	return n;
}

function setStatus(text, kind = '') {
	const s = document.getElementById('gs-p5i-status');
	if (!s) return;
	s.textContent = text || '';
	s.className = kind;
}

function renderList() {
	const list = document.getElementById('gs-p5i-list');
	if (!list) return;
	list.innerHTML = '';
	const live = [...sketches];
	if (!live.length) return;
	list.appendChild(el('div', { class: 'gs-p5i-hint', text: 'Sketches in this scene:' }));
	for (const h of live) {
		const label = el('span', { title: h.name, text: `${h.name}${h.width ? ` · ${h.width}×${h.height}` : ''}${h.p5Version ? ` · p5 ${h.p5Version}` : ''}` });
		const row = el('div', { class: 'gs-p5i-item' }, [label]);
		if (h.lastError) row.appendChild(el('em', { title: h.lastError, text: 'error' }));
		row.appendChild(el('button', {
			type: 'button', class: 'dchat-btn secondary', text: 'Remove',
			onclick: () => {
				const removedBlock = window.gsSessionCode?.removeWhere?.((code) => code.includes('gsImportP5Sketch(') && code.includes(`name: ${JSON.stringify(h.name)},`));
				h.remove();
				setStatus(removedBlock ? `Removed "${h.name}" and its code block.` : `Removed "${h.name}". Its code block is still in the code window.`, 'ok');
				renderList();
			}
		}));
		list.appendChild(row);
	}
}

function buildModal() {
	if (modal) return modal;
	document.head.appendChild(el('style', { id: 'gs-p5i-style', text: CSS }));
	const tabBtn = (id, label) => el('button', { type: 'button', class: 'dchat-btn secondary', 'data-p5i-tab': id, role: 'tab', text: label, onclick: () => selectTab(id) });
	const pastePane = el('div', { class: 'gs-p5i-pane', 'data-p5i-pane': 'paste' }, [
		el('input', { type: 'text', id: 'gs-p5i-name', placeholder: 'Name (optional)', autocomplete: 'off' }),
		el('textarea', { id: 'gs-p5i-code', spellcheck: 'false', placeholder: 'function setup() {\n  createCanvas(400, 400);\n}\n\nfunction draw() {\n  background(220);\n  circle(mouseX, mouseY, 40);\n}' }),
		el('div', { class: 'gs-p5i-hint', text: 'Global mode (function setup / draw), instance mode (new p5(...)) and a whole index.html all work.' })
	]);
	const fileInput = el('input', { type: 'file', id: 'gs-p5i-file', multiple: '', accept: '.zip,.js,.mjs,.html,.htm,.css,.json,.txt,.csv,.xml,.svg,.png,.jpg,.jpeg,.gif,.webp,.bmp,.ttf,.otf,.woff,.woff2,.mp3,.wav,.ogg,.m4a,.mp4,.webm,.glsl,.vert,.frag,.obj,.mtl' });
	const folderInput = el('input', { type: 'file', id: 'gs-p5i-folder', hidden: '' });
	folderInput.webkitdirectory = true;
	const filePane = el('div', { class: 'gs-p5i-pane', 'data-p5i-pane': 'file' }, [
		fileInput,
		el('div', { class: 'gs-p5i-row' }, [
			el('button', { type: 'button', class: 'dchat-btn secondary', text: 'Choose a folder instead', onclick: () => folderInput.click() }),
			folderInput
		]),
		el('div', { class: 'gs-p5i-hint', text: 'A sketch .js file, an index.html with its sketch.js and assets (select them together), a project folder, or the .zip from the p5 editor\'s File \u2192 Download. Images, fonts, sounds and JSON load from the files you include.' })
	]);
	folderInput.addEventListener('change', () => { if (folderInput.files.length) doImport('folder'); });
	const urlPane = el('div', { class: 'gs-p5i-pane', 'data-p5i-pane': 'url' }, [
		el('input', { type: 'url', id: 'gs-p5i-url', placeholder: 'https://editor.p5js.org/user/sketches/abc123', autocomplete: 'off' }),
		el('div', { class: 'gs-p5i-hint', text: 'A p5 editor sketch link, an OpenProcessing sketch, a GitHub file (github.com/…/blob/…) or folder, a raw .js file, or an index.html page.' })
	]);
	const box = el('div', { id: 'gs-p5i-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gs-p5i-title' }, [
		el('h3', { id: 'gs-p5i-title', text: 'Import p5.js sketch' }),
		el('div', { class: 'gs-p5i-sub', text: 'The sketch runs on a panel in front of you (also in VR) and is saved with the scene as a code block.' }),
		el('div', { id: 'gs-p5i-tabs', role: 'tablist' }, [tabBtn('paste', 'Paste'), tabBtn('file', 'File'), tabBtn('url', 'URL')]),
		pastePane, filePane, urlPane,
		el('div', { id: 'gs-p5i-status', role: 'status', 'aria-live': 'polite' }),
		el('div', { id: 'gs-p5i-list' }),
		el('div', { id: 'gs-p5i-actions' }, [
			el('button', { type: 'button', class: 'dchat-btn secondary', id: 'gs-p5i-close', text: 'Close', onclick: closeModal }),
			el('button', { type: 'button', class: 'dchat-btn accent', id: 'gs-p5i-go', text: 'Import', onclick: () => doImport(activeTab) })
		])
	]);
	modal = el('div', { id: 'gs-p5i-modal' }, [box]);
	modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
	modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); e.stopPropagation(); });
	modal.addEventListener('keyup', (e) => e.stopPropagation());
	document.body.appendChild(modal);
	selectTab(activeTab);
	return modal;
}

function selectTab(id) {
	activeTab = id;
	if (!modal) return;
	modal.querySelectorAll('[data-p5i-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.p5iTab === id)));
	modal.querySelectorAll('[data-p5i-pane]').forEach((p) => p.classList.toggle('active', p.dataset.p5iPane === id));
}

function openModal(tab) {
	buildModal();
	if (tab) selectTab(tab);
	setStatus('');
	renderList();
	modal.classList.add('open');
	setTimeout(() => modal.querySelector('.gs-p5i-pane.active textarea, .gs-p5i-pane.active input')?.focus(), 0);
}
function closeModal() { modal?.classList.remove('open'); }

let importing = false;
async function doImport(kind) {
	if (importing) return;
	importing = true;
	const go = document.getElementById('gs-p5i-go');
	if (go) go.disabled = true;
	setStatus(kind === 'url' ? 'Fetching…' : 'Importing…', 'pending');
	try {
		let project, how;
		if (kind === 'paste') {
			project = projectFromPaste(document.getElementById('gs-p5i-code').value, document.getElementById('gs-p5i-name').value.trim());
			how = 'pasted';
		} else if (kind === 'file' || kind === 'folder') {
			const input = document.getElementById(kind === 'folder' ? 'gs-p5i-folder' : 'gs-p5i-file');
			project = await projectFromFileList(input.files || []);
			how = kind === 'folder' ? 'folder' : (input.files.length === 1 && /\.zip$/i.test(input.files[0].name) ? 'zip' : 'file');
			input.value = '';
		} else {
			project = await projectFromUrl(document.getElementById('gs-p5i-url').value);
			how = 'url';
		}
		if (!project.entry) project.entry = pickEntry(project.files);
		setStatus(`Starting "${project.name}"…`, 'pending');
		const { embeddedBytes } = await importProject(project, how);
		const h = [...sketches].pop();
		const notes = [];
		if (h?.p5Fallback) notes.push(`p5 ${h.p5Version}: the sketch asks for ${h.p5Fallback}, which didn't load, so GS's bundled ${bundledP5Version()} is used instead (version mismatch)`);
		else if (h?.p5Version) notes.push(`p5 ${h.p5Version}${h.usedBundledP5 ? ' (GS bundled)' : ' (the version the sketch\'s index.html asks for)'}`);
		if (h?.width) notes.push(`${h.width}×${h.height} canvas`);
		if (embeddedBytes > WARN_EMBED_BYTES) notes.push(`${(embeddedBytes / 1048576).toFixed(1)} MB of files embedded in the scene`);
		if (h?.lastError) {
			setStatus(`Added "${project.name}", but the sketch reported an error:\n${h.lastError}\nFix it in the code window and press Apply, or remove it below.`, 'error');
		} else {
			setStatus(`Imported "${project.name}"${notes.length ? ` · ${notes.join(' · ')}` : ''}. It's in the code window as a code block.`, 'ok');
		}
		renderList();
	} catch (e) {
		console.warn('[p5 import]', e);
		setStatus(`Couldn't import: ${e?.message || e}`, 'error');
	} finally {
		importing = false;
		if (go) go.disabled = false;
	}
}

function injectButtons() {
	const make = (id, extraClass) => {
		const b = el('button', { type: 'button', id, class: `dchat-btn secondary ${extraClass || ''}`.trim(), title: 'Bring an existing p5.js sketch into the scene (paste, file/zip or URL)', text: 'Import p5 sketch…', onclick: () => openModal() });
		return b;
	};
	const dim = document.getElementById('dchat-dim');
	if (dim && !document.getElementById('gs-p5i-open-env')) dim.appendChild(make('gs-p5i-open-env', 'gs-p5i-open'));
	const toolbar = document.getElementById('dchat-code-toolbar');
	const status = document.getElementById('dchat-code-status');
	if (toolbar && !document.getElementById('gs-p5i-open-code')) toolbar.insertBefore(make('gs-p5i-open-code'), status || null);
}

window.addEventListener('gs-p5-import-change', () => { if (modal?.classList.contains('open')) renderList(); });
window.addEventListener('gs-p5-import-error', () => { if (modal?.classList.contains('open')) renderList(); });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButtons);
else injectButtons();

window.gsImportP5Sketch = gsImportP5Sketch;
window.gsP5Import = {
	open: openModal,
	fromPaste: (code, name) => importProject(projectFromPaste(code, name), 'pasted'),
	fromFiles: async (fileList) => importProject(await projectFromFileList(fileList), 'file'),
	fromZip: async (u8, name = 'sketch.zip') => importProject(projectFromZip(u8, name), 'zip'),
	fromUrl: async (url) => importProject(await projectFromUrl(url), 'url'),
	projectFromUrl,
	githubToRaw,
	list: () => [...sketches]
};

export { gsImportP5Sketch, githubToRaw, projectFromUrl };
