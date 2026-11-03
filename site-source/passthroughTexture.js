/**
 * One shared camera pipeline: a single getUserMedia stream played by one
 * hidden <video> element, used by
 *   - the chat window's 📷 preview (photoCapture.js), which draws the video
 *     into a <canvas> in the panel every frame (2D page and VR window), and
 *   - scene code, through window.gsPassthroughTexture(), which returns a
 *     THREE.VideoTexture of the same video.
 *
 * Why a hidden video and a per-frame tick (the 0.993 preview was blank on a
 * real Quest 3): inside an immersive session Quest Browser stops rendering
 * the 2D page, so window.requestAnimationFrame and the video's
 * requestVideoFrameCallback (which three's VideoTexture relies on to know a
 * new frame arrived) stop firing, and a <video> that is not painted in the
 * page may never be marked as having new frames. Here the video sits in the
 * DOM, tiny and nearly transparent at the page corner (never display:none,
 * which stops decoding in some browsers), is muted + playsInline, play() is
 * retried on the next tap / controller select if the browser refused it, and
 * tick() — called from renderer.setAnimationLoop, which keeps running in XR —
 * copies frames into the preview canvas and flags every VideoTexture for
 * upload itself.
 *
 * Nothing here is ever exported: the video carries data-gs-no-export and the
 * texture userData.gsNoExport (exporter.js strips such maps from materials).
 */
import * as THREE from 'three';
import { gsAlert } from './gsDialog.js';
import { QUEST_PASSTHROUGH_HELP, isQuestBrowser, isPassthroughCamera, cameraLabel } from './photoCapture.js';

const STORE_KEY = 'gs.cameraDevice', STORE_KEY_XR = 'gs.cameraDeviceXr';
const PREVIEW_MAX_SIDE = 960;   // preview canvas longest side, px (VR upload cost)
const STALL_MS = 1500;          // no new frame for this long = "stalled"

let video = null;
let stream = null;
let streamLabel = '';
let error = '';                 // last getUserMedia / play() error name
let playBlocked = false;
let acquiring = null;
const owners = new Set();       // 'chat', 'scene'
let texture = null;
let textureRefs = 0;
const canvases = new Set();     // preview canvases drawn every tick
let lastTime = -1, lastFrameAt = 0, frames = 0;
let isXr = () => false;
let onChange = () => {};
let lastStatus = '';
let hintShown = false;

const storeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

/** The hidden <video> (created once, kept in the DOM). */
export function hiddenVideo() {
	if (video) return video;
	video = document.createElement('video');
	video.id = 'gs-hidden-camera-video';
	video.muted = true; video.defaultMuted = true;
	video.playsInline = true; video.autoplay = true;
	video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('autoplay', '');
	video.setAttribute('aria-hidden', 'true');
	video.dataset.gsNoExport = 'true';
	// In the DOM and "visible" (so it keeps decoding), but out of the way.
	video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
	(document.body || document.documentElement).appendChild(video);
	video.addEventListener('playing', () => { playBlocked = false; error = error.startsWith('play') ? '' : error; emit(); });
	video.addEventListener('pause', emit);
	video.addEventListener('loadedmetadata', emit);
	return video;
}

function emit() { const s = statusText(); if (s !== lastStatus) { lastStatus = s; try { onChange(s); } catch { /* ignore */ } } }

/** main.js wiring: XR test + status listener. */
export function configure({ isImmersive, onStatus } = {}) {
	if (isImmersive) isXr = () => { try { return !!isImmersive(); } catch { return false; } };
	if (onStatus) onChange = onStatus;
}

async function playVideo() {
	const v = hiddenVideo();
	if (!v.srcObject) return false;
	try { await v.play(); playBlocked = false; if (error.startsWith('play')) error = ''; emit(); return true; }
	catch (e) { playBlocked = true; error = 'play() ' + ((e && e.name) || 'Error'); console.warn('[gs] camera video play() refused:', e && e.name); emit(); return false; }
}

/** Retry play() from a user gesture (any tap, key or XR controller select). */
export function kick() { if (video && video.srcObject && (video.paused || playBlocked)) playVideo(); }
if (typeof document !== 'undefined') for (const t of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(t, kick, { capture: true, passive: true });

/** Use `s` as the shared stream (stops a different previous one). */
export async function adoptStream(s, owner, label = '') {
	const v = hiddenVideo();
	if (stream && stream !== s) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
	stream = s; streamLabel = label || (s.getVideoTracks()[0] || {}).label || '';
	error = '';
	owners.add(owner);
	lastTime = -1; lastFrameAt = 0;
	if (v.srcObject !== s) v.srcObject = s;
	const track = s.getVideoTracks()[0];
	if (track) track.addEventListener('ended', () => { if (stream === s) { stream = null; v.srcObject = null; error = 'ended'; emit(); } });
	await playVideo();
	return v;
}

/** Stop the stream now (switching cameras: Quest allows one at a time). Owners stay. */
export function stopStream() {
	if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
	stream = null;
	if (video) video.srcObject = null;
	emit();
}

/** `owner` no longer needs the camera; the last one out stops it. */
export function release(owner) {
	owners.delete(owner);
	if (!owners.size) stopStream();
}

export const getStream = () => stream;
export const setLabel = (l) => { streamLabel = l || streamLabel; emit(); };
export function setError(name) { error = name || ''; emit(); }

/** Preview canvases get every new frame drawn into them by tick(). */
export function addCanvas(c) { canvases.add(c); }
export function removeCanvas(c) { canvases.delete(c); }

function friendly(label) {
	if (!label) return '';
	const l = cameraLabel({ label }, 0);
	return l;
}

/** One-line state for the preview, e.g. "camera: Quest passthrough (left) 1280×960 · playing". */
export function statusText() {
	const v = video;
	const name = friendly(streamLabel) || (stream ? 'camera' : '');
	if (!stream || !v || !v.srcObject) return error ? `camera: ${error}` : (acquiring ? 'camera: starting…' : 'camera: off');
	const size = v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '0×0';
	let state;
	if (playBlocked) state = `${error || 'play() blocked'} · tap or pull the trigger to start`;
	else if (v.paused) state = 'paused';
	else if (v.readyState < 2 || !v.videoWidth) state = 'waiting for frames';
	else if (lastFrameAt && performance.now() - lastFrameAt > STALL_MS) state = 'stalled (no new frames)';
	else state = 'playing';
	const track = stream.getVideoTracks()[0];
	if (track && track.readyState !== 'live') state = 'track ' + track.readyState;
	return `camera: ${name} ${size} · ${state}${isXr() ? ' · in XR' : ''}`;
}

/** Called every frame from renderer.setAnimationLoop (runs in XR too). */
export function tick(now = performance.now()) {
	const v = video;
	if (!v || !v.srcObject) { emit(); return; }
	if (v.readyState >= 2 && v.videoWidth) {
		const t = v.currentTime;
		const fresh = t !== lastTime;
		if (fresh) { lastTime = t; lastFrameAt = now; frames++; }
		// Upload even when currentTime looks unchanged in XR (some builds don't
		// advance it while the page isn't painted), at most every ~33 ms.
		if (fresh || now - (tick._at || 0) > 33) {
			tick._at = now;
			if (texture) texture.needsUpdate = true;
			for (const c of canvases) drawInto(c, v);
		}
	}
	if (now - (tick._st || 0) > 400) { tick._st = now; emit(); }
}

function drawInto(c, v) {
	const k = Math.min(1, PREVIEW_MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
	const w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k);
	if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
	try { c.getContext('2d').drawImage(v, 0, 0, w, h); c._gsFrame = (c._gsFrame || 0) + 1; } catch { /* not ready */ }
}

/** Quest passthrough first (the camera picked in the chat picker if any). */
async function openPreferred(md) {
	let list = [];
	try { list = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { /* ignore */ }
	const saved = storeGet(isXr() ? STORE_KEY_XR : STORE_KEY) || storeGet(STORE_KEY_XR) || storeGet(STORE_KEY);
	const savedDev = saved && list.find((d) => d.deviceId === saved);
	const pt = list.filter(isPassthroughCamera);
	const want = (savedDev && (!isQuestBrowser() || isPassthroughCamera(savedDev)) ? savedDev : pt[0]) || null;
	const tries = [];
	if (want) tries.push({ audio: false, video: { deviceId: { exact: want.deviceId } } });
	if (isQuestBrowser()) tries.push({ audio: false, video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } } });
	tries.push({ audio: false, video: { facingMode: { ideal: 'environment' } } });
	let last = null;
	for (const c of tries) {
		try { return await md.getUserMedia(c); } catch (e) { last = e; if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break; }
	}
	throw last || new Error('No camera');
}

function showHint(err) {
	if (hintShown) return;
	hintShown = true;
	const blocked = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
	if (isQuestBrowser() || blocked) gsAlert(isQuestBrowser() ? QUEST_PASSTHROUGH_HELP : 'Camera access is blocked. Allow the camera for this site in your browser’s site settings (the icon next to the address), then try again.', { title: isQuestBrowser() ? 'Use the Quest passthrough camera' : 'Camera blocked' });
}

/**
 * window.gsPassthroughTexture(): the passthrough camera (Quest 3 / 3S
 * "facing back" camera, the one picked in the chat camera picker when that
 * is one; elsewhere the back / default camera) as a THREE.VideoTexture (sRGB).
 * Returns the texture right away; frames appear once the camera starts.
 * All calls share one stream and one texture. texture.userData.ready
 * resolves to true / false; texture.userData.release() (or scene clear) lets
 * the camera go; texture.userData.status() gives the state line.
 */
export function gsPassthroughTexture() {
	const v = hiddenVideo();
	if (!texture) {
		texture = new THREE.VideoTexture(v);
		texture.name = 'gsPassthroughTexture';
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;
		texture.generateMipmaps = false;
		texture.userData.gsNoExport = true;
		texture.userData.gsSystem = true;
		texture.userData.status = statusText;
	}
	textureRefs++;
	let released = false;
	const tex = texture;
	tex.userData.release = () => { if (released) return; released = true; textureRefs = Math.max(0, textureRefs - 1); if (!textureRefs) releaseScene(); };
	owners.add('scene');
	const md = navigator.mediaDevices;
	if (stream) tex.userData.ready = Promise.resolve(true);
	else if (!md || !md.getUserMedia) { error = 'NotSupportedError'; tex.userData.ready = Promise.resolve(false); emit(); }
	else {
		acquiring ||= (async () => {
			emit();
			try { const s = await openPreferred(md); if (!owners.size) { for (const t of s.getTracks()) t.stop(); return false; } await adoptStream(s, 'scene'); return true; }
			catch (e) { error = (e && e.name) || 'Error'; console.warn('[gs] gsPassthroughTexture camera error:', error); emit(); showHint(e); return false; }
			finally { acquiring = null; }
		})();
		tex.userData.ready = acquiring;
	}
	return tex;
}

function releaseScene() {
	textureRefs = 0;
	release('scene');
}

/** Scene cleared / replaced: scene code no longer holds the camera. */
export function resetScene() {
	if (textureRefs || owners.has('scene')) releaseScene();
	hintShown = false;
}

/** Test / debug view. */
export function debugState() {
	const v = video;
	return { owners: [...owners], textureRefs, hasTexture: !!texture, error, playBlocked, frames,
		video: v ? { inDom: v.isConnected, display: getComputedStyle(v).display, paused: v.paused, readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, muted: v.muted, playsInline: v.playsInline } : null,
		tracksLive: stream ? stream.getTracks().filter((t) => t.readyState === 'live').length : 0, status: statusText() };
}
