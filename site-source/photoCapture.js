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
 * Meta Quest 3 (Quest Browser 40.1+, Horizon OS v74+): the headset's
 * passthrough cameras are ordinary getUserMedia cameras ("camera 2 1, facing
 * back" = left, "camera 2 2, facing back" = right; "facing front" is the
 * avatar / virtual camera, which never sees the room). Browser needs the
 * "Headset cameras" permission. Inside a VR / AR session the picker prefers a
 * passthrough camera, and the preview is shown on the VR menu window
 * (vrWindows.js draws the <video> on top of the painted window every frame).
 *
 * Errors (blocked, no camera, busy) are shown inside the panel, never with a
 * native dialog. Closing the panel stops every track.
 */

const STORE_KEY = 'gs.cameraDevice';      // last camera picked on this device (outside XR)
const STORE_KEY_XR = 'gs.cameraDeviceXr'; // last camera picked inside a headset session
const USED_KEY = 'gs.cameraUsed';         // set after the first photo: Enter VR asks up front
const MAX_PHOTO_SIDE = 2048;              // longest side of a captured photo, px
const JPEG_QUALITY = 0.9;

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
			if (m[3].toLowerCase() === 'front') return 'Avatar camera (virtual)';
			const n = Number(m[2] != null ? m[2] : m[1]);
			return n === 1 ? 'Left passthrough camera' : n === 2 ? 'Right passthrough camera' : `Passthrough camera ${n}`;
		}
		if (m) return m[3].toLowerCase() === 'back' ? `Back camera${index ? ' ' + (index + 1) : ''}` : `Front camera${index ? ' ' + (index + 1) : ''}`;
	}
	return raw;
}

function errorMessage(err, { xr }) {
	const name = err && err.name;
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		if (isQuestBrowser() || xr) return 'Camera access is blocked. On Quest: Settings › Privacy & safety › App permissions › Headset cameras, allow Browser. Then allow the camera for this site and try again.';
		return 'Camera access is blocked. Allow the camera for this site in your browser’s site settings (the icon next to the address), then try again.';
	}
	if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
		return xr && isQuestBrowser()
			? 'No passthrough camera was found. It needs Quest 3 / 3S with a recent Browser and the Headset cameras permission.'
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
			<video class="gs-cam-video" playsinline muted autoplay></video>
			<div class="gs-cam-msg" role="status" aria-live="polite" hidden></div>
			<div class="gs-cam-flash"></div>
		</div>
		<div class="gs-cam-controls">
			<select class="gs-cam-select" aria-label="Camera" title="Choose a camera"></select>
			<button type="button" class="gs-cam-shutter" aria-label="Take photo" title="Take photo">📸 Take photo</button>
			<button type="button" class="gs-cam-close" aria-label="Close camera" title="Close camera">✕</button>
		</div>`;
	panel.hidden = true;
	panel.setAttribute('role', 'region');
	panel.setAttribute('aria-label', 'Camera');
	const video = panel.querySelector('.gs-cam-video');
	const msgEl = panel.querySelector('.gs-cam-msg');
	const flash = panel.querySelector('.gs-cam-flash');
	const select = panel.querySelector('.gs-cam-select');
	const shutter = panel.querySelector('.gs-cam-shutter');
	const closeBtn = panel.querySelector('.gs-cam-close');

	let stream = null;
	let devices = [];
	let open = false;
	let starting = null;
	let startSeq = 0;
	let photos = 0;
	let currentId = '';

	const xr = () => { try { return !!isImmersive(); } catch { return false; } };
	const storeKey = () => (xr() ? STORE_KEY_XR : STORE_KEY);

	function setMsg(text, kind = 'info') {
		msgEl.textContent = text || '';
		msgEl.hidden = !text;
		msgEl.dataset.kind = kind;
		panel.dataset.state = kind === 'error' ? 'error' : (stream ? 'live' : 'idle');
		onLayout();
	}

	function stopTracks() {
		if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
		stream = null;
		video.srcObject = null;
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
		stopTracks();
		setMsg(xr() && isQuestBrowser() ? 'Starting the passthrough camera… (Quest may ask for Headset cameras access)' : 'Starting the camera…');
		if (devices.length === 0) devices = await listCameras();
		const want = deviceId != null ? deviceId : preferredDevice(devices);
		let s = null;
		try {
			s = await md.getUserMedia(constraintsFor(want));
		} catch (err) {
			// A saved camera that's gone (unplugged webcam): fall back to the default once.
			if (want && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
				try { s = await md.getUserMedia(constraintsFor('')); } catch (err2) { err = err2; }
			}
			if (!s) {
				if (seq !== startSeq || !open) return false;
				console.warn('Camera error:', err && err.name, err && err.message);
				devices = await listCameras();
				renderSelect();
				setMsg(errorMessage(err, { xr: xr() }), 'error');
				panel.dataset.error = (err && err.name) || 'Error';
				return false;
			}
		}
		if (seq !== startSeq || !open) { for (const t of s.getTracks()) t.stop(); return false; }
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
		video.classList.toggle('gs-cam-mirror', facing === 'front' && !isQuestBrowser());
		panel.dataset.facing = facing;
		panel.dataset.passthrough = String(isPassthroughCamera(dev));
		video.srcObject = s;
		try { await video.play(); } catch { /* autoplay: muted + playsinline is allowed */ }
		panel.dataset.live = 'true';
		shutter.disabled = false;
		if (track) track.addEventListener('ended', () => { if (stream === s) { stopTracks(); setMsg('The camera stopped. Pick a camera or close and reopen.', 'error'); } });
		setMsg(photos ? `${photos} photo${photos === 1 ? '' : 's'} attached.` : '');
		onLiveChange(video);
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
		onLayout();
		starting = start();
		await starting;
	}

	function closePanel() {
		if (!open) return;
		open = false;
		startSeq++;
		stopTracks();
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
	if (md && md.addEventListener) md.addEventListener('devicechange', async () => { devices = await listCameras(); renderSelect(); });
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
		get ready() { return starting; },
		state() {
			const track = stream && stream.getVideoTracks()[0];
			return {
				open, live: !!stream, photos, deviceId: currentId,
				label: track ? track.label : '',
				devices: devices.map((d, i) => ({ id: d.deviceId, label: cameraLabel(d, i), raw: d.label, passthrough: isPassthroughCamera(d) })),
				message: msgEl.hidden ? '' : msgEl.textContent,
				error: panel.dataset.error || '',
				tracksLive: stream ? stream.getTracks().filter((t) => t.readyState === 'live').length : 0,
				size: video.videoWidth ? [video.videoWidth, video.videoHeight] : null
			};
		},
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
	if (state !== 'prompt') return false;
	try {
		const s = await md.getUserMedia({ video: isQuestBrowser() ? { facingMode: { ideal: 'environment' } } : true, audio: false });
		for (const t of s.getTracks()) t.stop();
		return true;
	} catch { return false; }
}
