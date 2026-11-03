/**
 * Take a photo with the device's camera and attach it to the chat.
 *
 * The 📷 button sits next to 📎 in the chat window. It opens a live preview
 * between the chat bubbles and the button row: the camera picture, a camera
 * picker (every `videoinput` the browser lists; real names appear once the
 * camera is allowed), a shutter and a close button. The shutter draws the
 * current frame into a canvas and hands a JPEG File to `onPhoto`, which is the
 * same path an uploaded photo takes (addAttachments in main.js), so a captured
 * photo is a normal 🖼️ attachment chip on the next message.
 *
 * Meta Quest 3 / 3S (Quest Browser 40.1+, "Support for passthrough camera"):
 * the headset's passthrough cameras are ordinary getUserMedia cameras
 * ("camera 2 1, facing back" / "camera 1, facing back" = left, "… 2, facing
 * back" = right; "facing front" is the avatar / virtual camera, which never
 * sees the room). They are only listed once the site has the "Headset cameras"
 * permission; before that enumerateDevices() shows just the avatar camera and
 * facingMode {exact: 'environment'} fails with OverconstrainedError. So on
 * Quest the first request asks for {facingMode: {exact: 'environment'}} (the
 * request that asks for Headset cameras), falls back to the avatar camera when
 * that fails, re-lists the cameras after the grant / on devicechange (and a
 * few times shortly after, the list can update late), switches to a
 * passthrough camera as soon as one shows up, and otherwise shows an inline
 * hint with a "How to turn it on" dialog (gsDialog, works in VR too).
 * Inside a VR / AR session the picker prefers a passthrough camera.
 *
 * The stream plays in the one hidden <video> of passthroughTexture.js (shared
 * with window.gsPassthroughTexture()). Its tick(), run from the render loop
 * (also inside XR, where the page's own rAF / requestVideoFrameCallback stop),
 * draws each frame into the panel's <canvas>; in VR vrWindows.js shows that
 * canvas as its own texture quad on the menu window. A status line under the
 * picture says which camera, its size and whether frames are arriving.
 *
 * Errors (blocked, no camera, busy) are shown inside the panel, never with a
 * native dialog. Closing the panel stops every track.
 */

import * as cam from './passthroughTexture.js';
import { isTechnicalMode, onTechnicalModeChange, openTechnicalTab, registerTechnicalItem, copyText } from './technicalMode.js';

const STORE_KEY = 'gs.cameraDevice';      // last camera picked on this device (outside XR)
const STORE_KEY_XR = 'gs.cameraDeviceXr'; // last camera picked inside a headset session
const USED_KEY = 'gs.cameraUsed';         // set after the first photo: Enter VR asks up front
const MAX_PHOTO_SIDE = 2048;              // longest side of a captured photo, px
const JPEG_QUALITY = 0.9;
const RELIST_DELAYS_MS = [400, 1200, 3000]; // Quest can list the passthrough cameras a moment after the grant

/** Steps shown by "How to turn it on" (from Meta's Quest Help pages, see the PR). */
export const QUEST_PASSTHROUGH_HELP = [
	'Quest Browser only gives a website the passthrough cameras (the real room) when Browser has the "Headset cameras" permission. Without it only the avatar (virtual) camera is listed, which never sees the room. It needs Quest 3 or 3S.',
	'',
	'1. Exit VR / AR first.',
	'2. Quest Settings › Privacy & safety › Browser (or App permissions › Browser): turn on Headset cameras.',
	'3. Come back, reload the page and tap 📷 again. If Quest asks which cameras to allow, tick Headset cameras (Virtual cameras is ticked on its own), then Allow.',
	'4. Still only the avatar camera? Select the lock icon left of the address bar, check the camera permission is Allow, reload. Quest only asks once: allowing with just Virtual cameras ticked means it won\u2019t ask again until step 2 is done.',
	'',
	'Only one app or website can use the headset cameras at a time, so close other tabs or apps that use them.'
].join('\n');

const store = {
	get(k) { try { return localStorage.getItem(k); } catch { return null; } },
	set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } }
};

export const isQuestBrowser = () => /OculusBrowser|Quest/i.test(navigator.userAgent || '');
// Phones / tablets (UA, or the app's phone layout on a touch-only device):
// they default to the back camera.
const isPhoneUA = () => !isQuestBrowser() && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
	(document.documentElement.classList.contains('gs-phone') && !!window.matchMedia && matchMedia('(pointer: coarse)').matches));

/** Facing of a camera from its label / capabilities: 'back' | 'front' | ''. */
export function cameraFacing(device, track = null) {
	const caps = track && track.getCapabilities ? (() => { try { return track.getCapabilities(); } catch { return {}; } })() : {};
	const fm = (caps.facingMode && caps.facingMode[0]) || (track && track.getSettings ? track.getSettings().facingMode : '') || '';
	if (fm === 'environment') return 'back';
	if (fm === 'user') return 'front';
	const l = String(device && device.label || '').toLowerCase();
	if (/facing back|back|rear|environment|world/.test(l)) return 'back';
	if (/facing front|front|user|selfie|facetime|avatar/.test(l)) return 'front';
	return '';
}

/** Quest passthrough camera (a back-facing headset camera, not the avatar one). */
export function isPassthroughCamera(device) {
	const l = String(device && device.label || '').toLowerCase();
	if (!l) return false;
	if (/passthrough/.test(l)) return true;
	return isQuestBrowser() && /facing back/.test(l);
}

/** Friendly name for the picker. */
export function cameraLabel(device, index) {
	const raw = String(device && device.label || '').trim();
	if (!raw) return `Camera ${index + 1}`;
	if (isQuestBrowser() || /^camera\s*\d+(\s+\d+)?,\s*facing (back|front)$/i.test(raw)) {
		const m = raw.match(/camera\s*(\d+)(?:\s+(\d+))?,\s*facing (back|front)/i);
		if (m && isQuestBrowser()) {
			if (m[3].toLowerCase() === 'front') return 'Avatar camera (virtual, no room view)';
			const n = Number(m[2] != null ? m[2] : m[1]);
			return n === 1 ? 'Quest passthrough (left)' : n === 2 ? 'Quest passthrough (right)' : `Quest passthrough ${n}`;
		}
		if (m) return m[3].toLowerCase() === 'back' ? `Back camera${index ? ' ' + (index + 1) : ''}` : `Front camera${index ? ' ' + (index + 1) : ''}`;
	}
	return raw;
}

function errorMessage(err, { xr }) {
	const name = err && err.name;
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		if (isQuestBrowser() || xr) return 'Camera access is blocked. On Quest: Settings › Privacy & safety › Browser › turn on Headset cameras, and set the camera to Allow under the lock icon left of the address bar, then reload.';
		return 'Camera access is blocked. Allow the camera for this site in your browser’s site settings (the icon next to the address), then try again.';
	}
	if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
		return xr && isQuestBrowser()
			? 'No passthrough camera was found. It needs Quest 3 / 3S, Browser 40.1 or newer and the Headset cameras permission.'
			: 'No camera was found on this device.';
	}
	if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
		return 'The camera is busy (another app or tab may be using it). Close that and try again.';
	}
	return `Couldn’t start the camera${err && err.message ? ': ' + err.message : ''}.`;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.panel       empty container placed between the bubbles and the button row
 * @param {HTMLButtonElement} o.button the 📷 toggle
 * @param {(file: File) => (void|Promise<void>)} o.onPhoto  receives the JPEG
 * @param {() => boolean} [o.isImmersive]  true inside a WebXR session
 * @param {(video: HTMLVideoElement|null) => void} [o.onLiveChange]  preview started/stopped (VR window overlay)
 * @param {() => void} [o.onLayout]  panel shown/hidden or resized (repaint the VR window)
 */
export function createPhotoCapture({ panel, button, onPhoto, isImmersive = () => false, onLiveChange = () => {}, onLayout = () => {} }) {
	const md = navigator.mediaDevices;
	const supported = !!(md && md.getUserMedia);
	panel.innerHTML = `
		<div class="gs-cam-view">
			<canvas class="gs-cam-video gs-cam-canvas" width="4" height="3"></canvas>
			<div class="gs-cam-msg" role="status" aria-live="polite" hidden></div>
			<div class="gs-cam-flash"></div>
		</div>
		<div class="gs-cam-statusrow"><span class="gs-cam-status" aria-live="off">camera: off</span></div>
		<div class="gs-cam-hint" role="note" hidden>
			<span class="gs-cam-hint-text"></span>
			<button type="button" class="gs-cam-hint-help" hidden>Open Technical</button>
			<button type="button" class="gs-cam-hint-retry" hidden>Try again</button>
		</div>
		<div class="gs-cam-controls">
			<select class="gs-cam-select" aria-label="Camera" title="Choose a camera"></select>
			<button type="button" class="gs-cam-shutter" aria-label="Take photo" title="Take photo">📸 Take photo</button>
			<button type="button" class="gs-cam-close" aria-label="Close camera" title="Close camera">✕</button>
		</div>`;
	panel.hidden = true;
	panel.setAttribute('role', 'region');
	panel.setAttribute('aria-label', 'Camera');
	const view = panel.querySelector('.gs-cam-canvas'); // preview, drawn from the hidden video every frame
	const video = cam.hiddenVideo();
	const statusEl = panel.querySelector('.gs-cam-status');
	const msgEl = panel.querySelector('.gs-cam-msg');
	const flash = panel.querySelector('.gs-cam-flash');
	const select = panel.querySelector('.gs-cam-select');
	const shutter = panel.querySelector('.gs-cam-shutter');
	const closeBtn = panel.querySelector('.gs-cam-close');
	const hintEl = panel.querySelector('.gs-cam-hint');
	const hintText = panel.querySelector('.gs-cam-hint-text');
	const hintHelp = panel.querySelector('.gs-cam-hint-help');
	const hintRetry = panel.querySelector('.gs-cam-hint-retry');

	let stream = null;
	let devices = [];
	let open = false;
	let starting = null;
	let startSeq = 0;
	let photos = 0;
	let currentId = '';
	let ptProbe = '';        // Quest: result of the {exact: 'environment'} request ('ok' | error name)
	let ptProbeMsg = '';     // ... and its error message
	let lastErr = '';        // last getUserMedia error "Name: message" (any request)
	let relistTimers = [];
	let starting_now = false; // a start() is in flight (relist must not start another)
	const quest = () => isQuestBrowser();
	const hasPassthrough = (list = devices) => list.some(isPassthroughCamera);
	// The user picked a non-passthrough camera on purpose (don't switch away from it).
	const pickedOnPurpose = () => { const id = store.get(storeKey()); return !!id && devices.some((d) => d.deviceId === id && !isPassthroughCamera(d)); };

	const xr = () => { try { return !!isImmersive(); } catch { return false; } };
	cam.configure({ isImmersive: xr, onStatus: (text) => { statusEl.textContent = text; panel.dataset.camStatus = text; if (open) onLayout(); } });
	const storeKey = () => (xr() ? STORE_KEY_XR : STORE_KEY);

	function setMsg(text, kind = 'info') {
		msgEl.textContent = text || '';
		msgEl.hidden = !text;
		msgEl.dataset.kind = kind;
		panel.dataset.state = kind === 'error' ? 'error' : (stream ? 'live' : 'idle');
		onLayout();
	}

	/** What the browser reports (🛠 Technical › Quest passthrough camera (ADB) shows it). */
	async function diagnostics() {
		const ua = navigator.userAgent || '';
		const qb = ua.match(/OculusBrowser\/([\w.]+)/);
		const chrome = ua.match(/Chrome\/([\d.]+)/);
		let perm = 'n/a';
		try { perm = (await navigator.permissions.query({ name: 'camera' })).state; } catch (e) { perm = 'query failed: ' + ((e && e.name) || e); }
		let list = [];
		try { list = md && md.enumerateDevices ? await md.enumerateDevices() : []; } catch (e) { list = []; }
		let policy = 'n/a';
		try { const pp = document.permissionsPolicy || document.featurePolicy; if (pp && pp.allowsFeature) policy = pp.allowsFeature('camera') ? 'allowed' : 'BLOCKED'; } catch { /* ignore */ }
		const cams = list.filter((d) => d.kind === 'videoinput');
		const lines = [
			`GS camera details (${new Date().toISOString()})`,
			`Browser: ${qb ? 'Quest Browser ' + qb[1] : (isQuestBrowser() ? 'Quest (version not in UA)' : 'not Quest Browser')}${chrome ? ' · Chromium ' + chrome[1] : ''}`,
			`User agent: ${ua}`,
			`Secure page: ${window.isSecureContext} · in iframe: ${window.top !== window} · camera policy: ${policy} · in XR: ${xr()}`,
			`permissions.query(camera): ${perm}`,
			`Cameras listed (${cams.length}):`,
			...cams.map((d, i) => `  ${i + 1}. "${d.label || '(no label)'}" → ${cameraLabel(d, i)}${isPassthroughCamera(d) ? ' [passthrough]' : ''} id=${(d.deviceId || '').slice(0, 8)}`),
			`Other devices: ${list.filter((d) => d.kind !== 'videoinput').map((d) => d.kind).join(', ') || 'none'}`,
			`Passthrough request {facingMode: {exact: 'environment'}}: ${ptProbe ? (ptProbe === 'ok' ? 'ok' : `${ptProbe}${ptProbeMsg ? ': ' + ptProbeMsg : ''}`) : 'not tried'}`,
			`Last camera error: ${lastErr || 'none'}`,
			`Status: ${statusEl.textContent}`,
			`Video: ${cam.debugState().video ? JSON.stringify(cam.debugState().video) : 'none'}`
		];
		return lines.join('\n');
	}
	/**
	 * "Check again": ask for the passthrough camera once more ({exact:
	 * 'environment'}, the request behind Headset cameras), list the cameras
	 * again and, if the preview is open, switch it to a passthrough camera.
	 */
	async function probePassthrough() {
		if (!supported) return { ok: false, error: 'NotSupportedError', passthrough: 0 };
		let s = null;
		if (!(open && stream && isPassthroughCamera(devices.find((d) => d.deviceId === currentId)))) {
			if (open) { startSeq++; stopTracks(); } // Quest gives one camera at a time
			try { s = await md.getUserMedia(passthroughConstraints()); ptProbe = 'ok'; ptProbeMsg = ''; }
			catch (e) { ptProbe = (e && e.name) || 'Error'; ptProbeMsg = (e && e.message) || ''; lastErr = `${ptProbe}: ${ptProbeMsg}`; }
			if (s) for (const t of s.getTracks()) t.stop();
		}
		devices = await listCameras();
		renderSelect();
		if (open) await start(hasPassthrough() ? devices.filter(isPassthroughCamera)[0].deviceId : null);
		updateHint();
		return { ok: ptProbe === 'ok' || hasPassthrough(), error: ptProbe === 'ok' ? '' : `${ptProbe}${ptProbeMsg ? ': ' + ptProbeMsg : ''}`, passthrough: devices.filter(isPassthroughCamera).length, cameras: devices.length };
	}

	/** Quest with only the avatar camera listed: a short line (Technical mode: a pointer to the fix). */
	function updateHint() {
		const show = open && quest() && !hasPassthrough() && (!!stream || !!panel.dataset.error);
		const tech = isTechnicalMode();
		hintEl.hidden = !show;
		hintHelp.hidden = !tech;
		hintRetry.hidden = !tech;
		panel.dataset.passthroughMissing = String(show);
		if (show) {
			hintText.textContent = tech
				? 'Only the avatar camera is available. See 🛠 Technical › Quest passthrough camera (ADB).'
				: 'Passthrough camera needs extra setup: turn on Technical mode in Settings (🎮 Controls › Technical mode).';
		}
		onLayout();
	}
	onTechnicalModeChange(() => updateHint());

	function clearRelist() { for (const t of relistTimers) clearTimeout(t); relistTimers = []; }

	/** List the cameras again; on Quest switch to a passthrough camera that just appeared. */
	async function relist() {
		const list = await listCameras();
		const had = hasPassthrough();
		devices = list;
		renderSelect();
		if (open && quest() && !had && hasPassthrough() && !isPassthroughCamera(devices.find((d) => d.deviceId === currentId)) && !pickedOnPurpose() && !starting_now) {
			clearRelist();
			await start(devices.filter(isPassthroughCamera)[0].deviceId);
			return;
		}
		updateHint();
	}

	// Switching cameras stops the shared stream (Quest gives one camera at a
	// time); closing the panel only releases it (scene code may still use it).
	function stopTracks({ release = false } = {}) {
		if (release) cam.release('chat'); else cam.stopStream();
		stream = null;
		panel.dataset.live = 'false';
		shutter.disabled = true;
		onLiveChange(null);
	}

	async function listCameras() {
		if (!md || !md.enumerateDevices) return [];
		try { return (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { return []; }
	}

	function renderSelect() {
		select.innerHTML = '';
		devices.forEach((d, i) => {
			const o = document.createElement('option');
			o.value = d.deviceId || '';
			o.textContent = cameraLabel(d, i);
			o.dataset.facing = cameraFacing(d);
			if (isPassthroughCamera(d)) o.dataset.passthrough = 'true';
			select.appendChild(o);
		});
		if (currentId && devices.some((d) => d.deviceId === currentId)) select.value = currentId;
		select.disabled = devices.length < 2;
		select.dataset.passthroughCount = String(devices.filter(isPassthroughCamera).length);
		select.hidden = devices.length === 0;
	}

	// Which camera to open: the one picked last (per desktop / headset), else
	// inside a headset a passthrough camera (left first), else on phones the
	// back camera, else the browser's default.
	function preferredDevice(list) {
		const saved = store.get(storeKey());
		if (saved && list.some((d) => d.deviceId === saved)) return saved;
		if (xr() || isQuestBrowser()) {
			const pt = list.filter(isPassthroughCamera);
			if (pt.length) return pt[0].deviceId;
		}
		if (isPhoneUA()) {
			const back = list.find((d) => cameraFacing(d) === 'back');
			if (back) return back.deviceId;
		}
		return '';
	}

	// Quest: ask for a world-facing camera outright. This is the request that
	// gets the Headset cameras permission (an {ideal} facingMode quietly gives
	// the avatar camera). Quest's passthrough cameras are 1280x960.
	const passthroughConstraints = () => ({ audio: false, video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } } });

	function constraintsFor(deviceId) {
		const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
		if (deviceId) video.deviceId = { exact: deviceId };
		else if (xr() || isQuestBrowser() || isPhoneUA()) video.facingMode = { ideal: 'environment' };
		return { audio: false, video };
	}

	async function start(deviceId = null) {
		if (!supported) {
			setMsg(window.isSecureContext === false ? 'The camera needs a secure (https) page.' : 'This browser can’t use a camera.', 'error');
			shutter.disabled = true;
			return false;
		}
		const seq = ++startSeq;
		starting_now = true;
		clearRelist();
		stopTracks();
		setMsg(xr() && isQuestBrowser() ? 'Starting the passthrough camera… (Quest may ask for Headset cameras access)' : 'Starting the camera…');
		if (devices.length === 0) devices = await listCameras();
		const want = deviceId != null ? deviceId : preferredDevice(devices);
		let s = null;
		// Quest, no passthrough camera known yet (none listed, or only the
		// avatar one): ask for the world-facing camera first.
		if (quest() && deviceId == null && !hasPassthrough() && !(want && pickedOnPurpose())) {
			try { s = await md.getUserMedia(passthroughConstraints()); ptProbe = 'ok'; }
			catch (e) { ptProbe = (e && e.name) || 'Error'; ptProbeMsg = (e && e.message) || ''; console.info('Quest passthrough camera not available:', ptProbe, ptProbeMsg); }
			if (seq !== startSeq || !open) { if (s) for (const t of s.getTracks()) t.stop(); starting_now = false; return false; }
		}
		if (!s) try {
			s = await md.getUserMedia(constraintsFor(want));
		} catch (err) {
			// A saved camera that's gone (unplugged webcam): fall back to the default once.
			if (want && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
				try { s = await md.getUserMedia(constraintsFor('')); } catch (err2) { err = err2; }
			}
			if (!s) {
				if (seq !== startSeq || !open) { starting_now = false; return false; }
				console.warn('Camera error:', err && err.name, err && err.message);
				lastErr = `${(err && err.name) || 'Error'}: ${(err && err.message) || ''}`;
				devices = await listCameras();
				renderSelect();
				panel.dataset.error = (err && err.name) || 'Error';
				cam.setError(panel.dataset.error);
				setMsg(errorMessage(err, { xr: xr() }), 'error');
				starting_now = false;
				updateHint();
				return false;
			}
		}
		if (seq !== startSeq || !open) { for (const t of s.getTracks()) t.stop(); starting_now = false; return false; }
		stream = s;
		panel.dataset.error = '';
		const track = s.getVideoTracks()[0];
		const settings = track && track.getSettings ? track.getSettings() : {};
		currentId = settings.deviceId || want || '';
		// Labels only show up after permission: list again now.
		devices = await listCameras();
		if (!currentId && track) {
			const byLabel = devices.find((d) => d.label && d.label === track.label);
			if (byLabel) currentId = byLabel.deviceId;
		}
		renderSelect();
		const dev = devices.find((d) => d.deviceId === currentId) || { label: track ? track.label : '' };
		const facing = cameraFacing(dev, track);
		// Mirror only the selfie preview (the photo itself is never mirrored).
		view.classList.toggle('gs-cam-mirror', facing === 'front' && !isQuestBrowser());
		panel.dataset.facing = facing;
		panel.dataset.passthrough = String(isPassthroughCamera(dev));
		await cam.adoptStream(s, 'chat', cameraLabel(dev, Math.max(0, devices.indexOf(dev))));
		panel.dataset.live = 'true';
		shutter.disabled = false;
		if (track) track.addEventListener('ended', () => { if (stream === s) { stopTracks(); setMsg('The camera stopped. Pick a camera or close and reopen.', 'error'); } });
		setMsg(photos ? `${photos} photo${photos === 1 ? '' : 's'} attached.` : '');
		onLiveChange(view);
		starting_now = false;
		updateHint();
		// Quest lists the passthrough cameras once Headset cameras is allowed,
		// sometimes a moment later: look again a few times.
		if (quest() && !hasPassthrough()) relistTimers = RELIST_DELAYS_MS.map((ms) => setTimeout(() => { if (open && stream === s) relist(); }, ms));
		onLayout();
		return true;
	}

	async function openPanel() {
		if (open) return;
		open = true;
		panel.hidden = false;
		button.setAttribute('aria-pressed', 'true');
		button.classList.add('active');
		photos = 0;
		cam.addCanvas(view);
		onLayout();
		starting = start();
		await starting;
	}

	function closePanel() {
		if (!open) return;
		open = false;
		startSeq++;
		starting_now = false;
		clearRelist();
		stopTracks({ release: true });
		cam.removeCanvas(view);
		hintEl.hidden = true;
		panel.hidden = true;
		setMsg('');
		button.setAttribute('aria-pressed', 'false');
		button.classList.remove('active');
		onLayout();
	}

	/** Draw the current frame and hand it on as a JPEG File. */
	async function capture() {
		if (!stream || !video.videoWidth) {
			setMsg('The camera isn’t ready yet.', 'error');
			return null;
		}
		const vw = video.videoWidth, vh = video.videoHeight;
		const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(vw, vh));
		const c = document.createElement('canvas');
		c.width = Math.round(vw * k);
		c.height = Math.round(vh * k);
		c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
		const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', JPEG_QUALITY));
		if (!blob) { setMsg('Couldn’t save the photo.', 'error'); return null; }
		const d = new Date();
		const pad = (n) => String(n).padStart(2, '0');
		const name = `camera-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
		const file = new File([blob], name, { type: 'image/jpeg', lastModified: d.getTime() });
		flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
		store.set(USED_KEY, '1');
		await onPhoto(file);
		photos++;
		setMsg(`Photo attached (${photos}). It goes with your next message.`, 'ok');
		return file;
	}

	button.addEventListener('click', (e) => { e.preventDefault(); open ? closePanel() : openPanel(); });
	closeBtn.addEventListener('click', (e) => { e.preventDefault(); closePanel(); });
	shutter.addEventListener('click', (e) => { e.preventDefault(); capture(); });
	select.addEventListener('change', () => {
		const id = select.value;
		store.set(storeKey(), id || null);
		if (open) start(id);
	});
	if (md && md.addEventListener) md.addEventListener('devicechange', () => { relist(); });
	hintHelp.addEventListener('click', (e) => { e.preventDefault(); openTechnicalTab('quest-passthrough-adb'); });
	hintRetry.addEventListener('click', (e) => { e.preventDefault(); if (open) start(null); });
	// Hidden tab: release the camera (the light goes off).
	document.addEventListener('visibilitychange', () => { if (document.hidden && open) closePanel(); });
	if (!supported) {
		button.title = 'Camera not available (needs a secure https page and a browser with camera access)';
	}

	return {
		open: openPanel,
		close: closePanel,
		capture,
		/** Entering / leaving a headset session: reopen on the right camera. */
		restartForMode() { if (open) start(null); },
		get isOpen() { return open; },
		get stream() { return stream; },
		get video() { return video; },
		get view() { return view; },
		get ready() { return starting; },
		state() {
			const track = stream && stream.getVideoTracks()[0];
			return {
				open, live: !!stream, photos, deviceId: currentId,
				label: track ? track.label : '',
				devices: devices.map((d, i) => ({ id: d.deviceId, label: cameraLabel(d, i), raw: d.label, passthrough: isPassthroughCamera(d) })),
				passthroughProbe: ptProbe, passthroughProbeMessage: ptProbeMsg, lastError: lastErr,
				hint: hintEl.hidden ? '' : hintText.textContent,
				message: msgEl.hidden ? '' : msgEl.textContent,
				error: panel.dataset.error || '',
				tracksLive: stream ? stream.getTracks().filter((t) => t.readyState === 'live').length : 0,
				size: video.videoWidth ? [video.videoWidth, video.videoHeight] : null,
				status: statusEl.textContent
			};
		},
		diagnostics,
		probePassthrough,
		usedBefore: () => store.get(USED_KEY) === '1'
	};
}

/**
 * Enter VR / AR click (capture phase): someone who has taken a photo before
 * and hasn't answered the camera question yet gets asked now, outside the
 * headset session. On Quest the Headset cameras prompt can end an immersive
 * session, so asking first keeps them in VR later. The probe stream is
 * released right away.
 */
export async function askCameraBeforeXr() {
	if (store.get(USED_KEY) !== '1') return false;
	const md = navigator.mediaDevices;
	if (!md || !md.getUserMedia) return false;
	let state = 'prompt';
	try { state = (await navigator.permissions.query({ name: 'camera' })).state; } catch { /* no Permissions API for camera */ }
	if (state === 'denied') return false;
	if (state !== 'prompt') {
		// Quest: "granted" can mean only the avatar camera. If no passthrough
		// camera is listed yet, ask for Headset cameras now, outside the session.
		if (!isQuestBrowser()) return false;
		try { if ((await md.enumerateDevices()).some((d) => d.kind === 'videoinput' && isPassthroughCamera(d))) return false; } catch { return false; }
	}
	const stop = (s) => { for (const t of s.getTracks()) t.stop(); };
	if (isQuestBrowser()) {
		try { stop(await md.getUserMedia({ video: { facingMode: { exact: 'environment' } }, audio: false })); return true; }
		catch { if (state !== 'prompt') return false; }
	}
	try {
		stop(await md.getUserMedia({ video: true, audio: false }));
		return true;
	} catch { return false; }
}

// ───────────── 🛠 Technical › Quest passthrough camera (ADB) ─────────────
export const QUEST_ADB_COMMAND = 'adb shell pm grant com.oculus.browser horizonos.permission.HEADSET_CAMERA';

/**
 * Registers the Technical mode item for the Quest Browser bug where the
 * Headset cameras prompt never appears (only the avatar camera is listed and
 * {exact:'environment'} fails with OverconstrainedError; Meta investigation
 * 1557993751977106). Workaround: grant the permission over ADB.
 */
export function registerQuestPassthroughItem(capture) {
	registerTechnicalItem({
		id: 'quest-passthrough-adb', title: 'Quest passthrough camera (ADB)', order: 10,
		render(body, { onLayout }) {
			body.innerHTML = `
				<p>On some Quest Browser versions the Headset cameras prompt never appears, so GS only gets the avatar camera and the passthrough request fails with OverconstrainedError (a Quest Browser bug Meta is investigating). First try Quest Settings › Privacy & safety › Browser › Headset cameras. If that doesn’t help, grant the permission from a computer with ADB:</p>
					<div class="gs-tech-step">1. In the Meta Horizon phone app: Menu › Devices › your headset › Headset settings › Developer mode: turn it on (needs a developer account), then restart the headset.</div>
					<div class="gs-tech-step">2. Install Android platform tools (adb) on your computer.</div>
					<div class="gs-tech-step">3. Connect the headset by USB-C, put it on and choose Allow USB debugging (tick Always allow).</div>
					<div class="gs-tech-step">4. On the computer run <code>adb devices</code> (the headset should be listed), then run:</div>
				<div class="gs-tech-code"><code class="gs-tech-adb-cmd"></code><button type="button" class="dchat-btn secondary gs-tech-copy">Copy</button></div>
					<div class="gs-tech-step">5. Quit and reopen Quest Browser (close it fully), reload GS, then tap Check again or 📷.</div>
				<div class="gs-tech-row"><button type="button" class="dchat-btn gs-tech-check">Check again</button><span class="gs-tech-result" role="status"></span></div>
				<div class="gs-tech-row"><span class="dchat-section-label" style="margin:0">Camera details</span><button type="button" class="dchat-btn secondary gs-tech-diag-copy">Copy details</button></div>
				<pre class="gs-tech-diag">Open this tab or tap Check again to read the camera details.</pre>`;
			const cmd = body.querySelector('.gs-tech-adb-cmd');
			cmd.textContent = QUEST_ADB_COMMAND;
			const copy = body.querySelector('.gs-tech-copy');
			const check = body.querySelector('.gs-tech-check');
			const result = body.querySelector('.gs-tech-result');
			const diag = body.querySelector('.gs-tech-diag');
			const diagCopy = body.querySelector('.gs-tech-diag-copy');
			const flash = (btn, ok) => { btn.textContent = ok ? 'Copied' : 'Select + copy'; setTimeout(() => { btn.textContent = btn === copy ? 'Copy' : 'Copy details'; onLayout(); }, 1500); onLayout(); };
			const refresh = async () => { diag.textContent = await capture.diagnostics(); onLayout(); };
			copy.addEventListener('click', async (e) => { e.preventDefault(); flash(copy, await copyText(QUEST_ADB_COMMAND, cmd)); });
			diagCopy.addEventListener('click', async (e) => { e.preventDefault(); await refresh(); flash(diagCopy, await copyText(diag.textContent, diag)); });
			check.addEventListener('click', async (e) => {
				e.preventDefault();
				check.disabled = true; result.textContent = 'Checking…'; onLayout();
				try {
					const r = await capture.probePassthrough();
					result.textContent = r.passthrough
						? `Passthrough camera available (${r.passthrough} listed). The 📷 camera list now includes it.`
						: `Still only ${r.cameras === 1 ? 'the avatar camera' : r.cameras + ' camera(s), no passthrough'}${r.error ? ' (' + r.error + ')' : ''}. Run the ADB command, then restart Browser.`;
				} catch (err) { result.textContent = 'Check failed: ' + ((err && err.name) || err); }
				check.disabled = false;
				await refresh();
			});
			const md = navigator.mediaDevices;
			if (md && md.addEventListener) md.addEventListener('devicechange', () => { if (isTechnicalMode()) refresh(); });
			return { refresh };
		}
	});
}
