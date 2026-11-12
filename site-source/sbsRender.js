// Side-by-side (SBS) VR180-style capture: each eye is an equirectangular
// projection of the chosen field of view, composed left | right. Uses a cube
// camera plus a conversion shader per eye. Recording uses a 2D canvas
// captureStream so an active XR session is never interrupted.
//
// IPD is 0.064 m, centered on the current camera (headset pose while in VR).
// Menus, controllers and anything tagged gsNoExport are hidden for the capture.

export const FOV_MIN = 30;
export const FOV_MAX = 360;
export const FOV_DEFAULT = 180;
export const IPD_METERS = 0.064;
export const SCREENSHOT_EYE = 1024;
export const RECORD_EYE = 512;
export const RECORD_FPS = 12;

export function parseFov(raw) {
	if (raw == null || String(raw).trim() === '') {
		return { ok: false, error: 'Enter a field of view in degrees.' };
	}
	const n = Number(String(raw).trim());
	if (!Number.isFinite(n)) {
		return { ok: false, error: 'Enter a field of view in degrees.' };
	}
	if (n < FOV_MIN || n > FOV_MAX) {
		return { ok: false, error: `Use a value between ${FOV_MIN}° and ${FOV_MAX}°.` };
	}
	return { ok: true, value: n };
}

export function pickRecorderMime() {
	if (typeof MediaRecorder === 'undefined') return '';
	const types = [
		'video/webm;codecs=vp9',
		'video/webm;codecs=vp8',
		'video/webm',
		'video/mp4',
	];
	return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function timestamp() {
	const d = new Date();
	return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function formatElapsed(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

function triggerDownload(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const EQUIRECT_VERT = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = vec4(position.xy, 0.0, 1.0);
	}
`;
const EQUIRECT_FRAG = /* glsl */ `
	uniform samplerCube envMap;
	uniform float fovH;
	uniform float fovV;
	uniform mat3 camMatrix;
	varying vec2 vUv;
	void main() {
		float lon = (vUv.x - 0.5) * fovH;
		float lat = (0.5 - vUv.y) * fovV;
		float clat = cos(lat);
		vec3 local = normalize(vec3(sin(lon) * clat, sin(lat), -cos(lon) * clat));
		gl_FragColor = textureCube(envMap, normalize(camMatrix * local));
	}
`;

export function createSbsRenderer({ THREE, getRenderer, getScene, getCamera, hideSystemObjects }) {
	let offscreen = null; // { renderer, canvas }
	let cubeRT = null;
	let cubeCam = null;
	let eyeRT = null;
	let equirectScene = null;
	let equirectMat = null;
	let blitCanvas = null;
	let rec = {
		running: false,
		recorder: null,
		chunks: [],
		stream: null,
		startedAt: 0,
		timer: null,
		frameTimer: null,
		fov: FOV_DEFAULT,
		mime: '',
		canvas: null,
	};
	const listeners = new Set();
	const emit = (evt) => { for (const fn of listeners) try { fn(evt); } catch {} };

	function state() {
		return {
			recording: rec.running,
			elapsedMs: rec.running ? Date.now() - rec.startedAt : 0,
			elapsed: rec.running ? formatElapsed(Date.now() - rec.startedAt) : '00:00',
			mime: rec.mime,
		};
	}
	function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

	function getOffscreenRenderer() {
		if (offscreen) return offscreen.renderer;
		const canvas = document.createElement('canvas');
		canvas.width = 4;
		canvas.height = 4;
		let renderer;
		try {
			renderer = new THREE.WebGLRenderer({
				canvas,
				antialias: false,
				alpha: false,
				preserveDrawingBuffer: false,
				powerPreference: 'high-performance',
			});
		} catch (err) {
			console.warn('SBS offscreen renderer failed:', err);
			return null;
		}
		renderer.setPixelRatio(1);
		offscreen = { renderer, canvas };
		syncRendererSettings(renderer);
		return renderer;
	}

	function syncRendererSettings(dst) {
		const src = getRenderer();
		if (!src || !dst) return;
		dst.outputColorSpace = src.outputColorSpace;
		dst.toneMapping = src.toneMapping;
		dst.toneMappingExposure = src.toneMappingExposure;
		if ('useLegacyLights' in src) dst.useLegacyLights = src.useLegacyLights;
		if (src.shadowMap && dst.shadowMap) {
			dst.shadowMap.enabled = src.shadowMap.enabled;
			dst.shadowMap.type = src.shadowMap.type;
		}
	}

	function captureRenderer(preferOffscreen) {
		if (preferOffscreen) {
			const r = getOffscreenRenderer();
			if (r) return { renderer: r, restore: null };
		}
		const main = getRenderer();
		if (main.xr?.isPresenting) {
			const r = getOffscreenRenderer();
			if (!r) throw new Error('Can’t capture SBS while a VR session is running on this device.');
			return { renderer: r, restore: null };
		}
		const saved = {
			target: main.getRenderTarget(),
			xr: main.xr ? main.xr.enabled : false,
		};
		if (main.xr) main.xr.enabled = false;
		return {
			renderer: main,
			restore() {
				main.setRenderTarget(saved.target);
				if (main.xr) main.xr.enabled = saved.xr;
			},
		};
	}

	function ensureTargets(eyeSize) {
		if (!cubeRT || cubeRT.width !== eyeSize) {
			if (cubeRT) cubeRT.dispose();
			cubeRT = new THREE.WebGLCubeRenderTarget(eyeSize, {
				format: THREE.RGBAFormat,
				generateMipmaps: false,
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
			});
			const main = getRenderer();
			if (main?.outputColorSpace && 'colorSpace' in cubeRT.texture) {
				cubeRT.texture.colorSpace = main.outputColorSpace;
			}
			cubeCam = new THREE.CubeCamera(0.1, 1000, cubeRT);
		}
		if (!eyeRT || eyeRT.width !== eyeSize) {
			if (eyeRT) eyeRT.dispose();
			eyeRT = new THREE.WebGLRenderTarget(eyeSize, eyeSize, {
				format: THREE.RGBAFormat,
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
				depthBuffer: false,
			});
			const main = getRenderer();
			if (main?.outputColorSpace && 'colorSpace' in eyeRT.texture) {
				eyeRT.texture.colorSpace = main.outputColorSpace;
			}
		}
		if (!equirectMat) {
			equirectMat = new THREE.ShaderMaterial({
				uniforms: {
					envMap: { value: null },
					fovH: { value: Math.PI },
					fovV: { value: Math.PI },
					camMatrix: { value: new THREE.Matrix3() },
				},
				vertexShader: EQUIRECT_VERT,
				fragmentShader: EQUIRECT_FRAG,
				depthTest: false,
				depthWrite: false,
				toneMapped: false,
			});
			const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), equirectMat);
			equirectScene = new THREE.Scene();
			equirectScene.add(quad);
		}
	}

	function capturePose() {
		const main = getRenderer();
		let cam = getCamera();
		if (main?.xr?.isPresenting) {
			const xrCam = main.xr.getCamera();
			if (xrCam) cam = xrCam;
		}
		cam.updateMatrixWorld(true);
		return {
			position: cam.position.clone(),
			quaternion: cam.quaternion.clone(),
			near: cam.near || 0.1,
			far: cam.far || 1000,
		};
	}

	function renderEye(renderer, scene, pose, side, fovDeg) {
		const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
		const pos = pose.position.clone().addScaledVector(right, (side === 'left' ? -0.5 : 0.5) * IPD_METERS);
		const near = Math.max(0.01, pose.near), far = Math.max(near + 1, pose.far);
		for (const c of cubeCam.children) {
			if (c.isCamera) { c.near = near; c.far = far; c.updateProjectionMatrix(); }
		}
		// World-aligned cube faces; the shader rotates sample directions by camMatrix.
		cubeCam.position.copy(pos);
		cubeCam.quaternion.identity();
		cubeCam.updateMatrixWorld(true);
		cubeCam.update(renderer, scene);

		const fov = fovDeg * Math.PI / 180;
		equirectMat.uniforms.envMap.value = cubeRT.texture;
		equirectMat.uniforms.fovH.value = fov;
		equirectMat.uniforms.fovV.value = fov;
		const mat4 = new THREE.Matrix4().makeRotationFromQuaternion(pose.quaternion);
		equirectMat.uniforms.camMatrix.value.setFromMatrix4(mat4);
		equirectMat.needsUpdate = true;

		const dummy = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		renderer.setRenderTarget(eyeRT);
		renderer.render(equirectScene, dummy);
		renderer.setRenderTarget(null);
		return eyeRT;
	}

	function blitEye(renderer, rt, ctx, dx, dy, dw, dh) {
		const w = rt.width, h = rt.height;
		const pixels = new Uint8Array(w * h * 4);
		renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
		if (!blitCanvas || blitCanvas.width !== w || blitCanvas.height !== h) {
			blitCanvas = document.createElement('canvas');
			blitCanvas.width = w;
			blitCanvas.height = h;
		}
		const img = blitCanvas.getContext('2d').createImageData(w, h);
		for (let y = 0; y < h; y++) {
			const src = (h - 1 - y) * w * 4;
			img.data.set(pixels.subarray(src, src + w * 4), y * w * 4);
		}
		blitCanvas.getContext('2d').putImageData(img, 0, 0);
		ctx.drawImage(blitCanvas, 0, 0, w, h, dx, dy, dw, dh);
	}

	function composeSbs(fovDeg, eyeSize) {
		const scene = getScene();
		if (!getRenderer() || !scene || !getCamera()) throw new Error('The scene is not ready yet.');
		const presenting = !!getRenderer().xr?.isPresenting;
		const { renderer, restore } = captureRenderer(presenting);
		syncRendererSettings(renderer);
		ensureTargets(eyeSize);
		const pose = capturePose();
		const hidden = hideSystemObjects() || [];
		const canvas = document.createElement('canvas');
		canvas.width = eyeSize * 2;
		canvas.height = eyeSize;
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		try {
			renderEye(renderer, scene, pose, 'left', fovDeg);
			blitEye(renderer, eyeRT, ctx, 0, 0, eyeSize, eyeSize);
			renderEye(renderer, scene, pose, 'right', fovDeg);
			blitEye(renderer, eyeRT, ctx, eyeSize, 0, eyeSize, eyeSize);
		} finally {
			for (const o of hidden) o.visible = true;
			if (restore) restore();
		}
		return canvas;
	}

	async function canvasToBlob(canvas) {
		const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
		// JPEG if the PNG is huge (> 12 MB) or the canvas is very large.
		if (png && png.size <= 12 * 1024 * 1024 && canvas.width * canvas.height <= 8_000_000) {
			return { blob: png, mime: 'image/png', ext: 'png' };
		}
		const jpg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
		if (jpg && (!png || jpg.size < png.size)) return { blob: jpg, mime: 'image/jpeg', ext: 'jpg' };
		if (png) return { blob: png, mime: 'image/png', ext: 'png' };
		throw new Error('Couldn’t encode the screenshot.');
	}

	async function takeScreenshot({ fov = FOV_DEFAULT, download = true, eyeSize = SCREENSHOT_EYE } = {}) {
		const parsed = parseFov(fov);
		if (!parsed.ok) throw new Error(parsed.error);
		const canvas = composeSbs(parsed.value, eyeSize);
		const { blob, mime, ext } = await canvasToBlob(canvas);
		const filename = `gs-sbs-${Math.round(parsed.value)}deg-${timestamp()}.${ext}`;
		if (download) triggerDownload(blob, filename);
		return { blob, mime, ext, filename, width: canvas.width, height: canvas.height, fov: parsed.value };
	}

	function paintFrame(fovDeg, canvas) {
		const tmp = composeSbs(fovDeg, RECORD_EYE);
		const ctx = canvas.getContext('2d');
		if (canvas.width !== tmp.width || canvas.height !== tmp.height) {
			canvas.width = tmp.width;
			canvas.height = tmp.height;
		}
		ctx.drawImage(tmp, 0, 0);
	}

	function startRecording({ fov = FOV_DEFAULT, downloadOnStop = true } = {}) {
		if (rec.running) throw new Error('Recording is already in progress.');
		const parsed = parseFov(fov);
		if (!parsed.ok) throw new Error(parsed.error);
		const mime = pickRecorderMime();
		if (!mime) throw new Error('This browser can’t record video (no MediaRecorder type is supported).');
		const canvas = document.createElement('canvas');
		canvas.width = RECORD_EYE * 2;
		canvas.height = RECORD_EYE;
		paintFrame(parsed.value, canvas);
		const stream = canvas.captureStream(RECORD_FPS);
		const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
		rec = {
			running: true,
			recorder,
			chunks: [],
			stream,
			startedAt: Date.now(),
			timer: null,
			frameTimer: null,
			fov: parsed.value,
			mime,
			canvas,
			downloadOnStop,
			stopResolve: null,
		};
		recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
		const stopped = new Promise((resolve) => { rec.stopResolve = resolve; });
		rec.stopped = stopped;
		recorder.onstop = () => {
			const blob = new Blob(rec.chunks, { type: rec.mime || 'video/webm' });
			const ext = /mp4/i.test(rec.mime) ? 'mp4' : 'webm';
			const filename = `gs-sbs-${Math.round(rec.fov)}deg-${timestamp()}.${ext}`;
			const duration = Date.now() - rec.startedAt;
			const resolve = rec.stopResolve;
			const result = { blob, mime: rec.mime, ext, filename, duration, width: rec.canvas.width, height: rec.canvas.height, fov: rec.fov };
			if (rec.downloadOnStop && blob.size > 0) triggerDownload(blob, filename);
			cleanupRecording();
			emit(state());
			if (resolve) resolve(result);
		};
		recorder.start(500);
		// Drive frames independently of the XR loop so the headset session stays untouched.
		const frameMs = Math.round(1000 / RECORD_FPS);
		rec.frameTimer = setInterval(() => {
			if (!rec.running) return;
			try { paintFrame(rec.fov, rec.canvas); } catch (err) { console.warn('SBS record frame failed:', err); }
		}, frameMs);
		rec.timer = setInterval(() => emit(state()), 250);
		emit(state());
		return state();
	}

	function cleanupRecording() {
		if (rec.frameTimer) clearInterval(rec.frameTimer);
		if (rec.timer) clearInterval(rec.timer);
		if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
		rec.running = false;
		rec.frameTimer = null;
		rec.timer = null;
		rec.stream = null;
		rec.recorder = null;
	}

	function stopRecording() {
		if (!rec.running || !rec.recorder) return Promise.reject(new Error('No recording is in progress.'));
		const done = rec.stopped || new Promise((resolve) => { rec.stopResolve = resolve; });
		if (rec.recorder.state !== 'inactive') rec.recorder.stop();
		return done;
	}

	function dispose() {
		if (rec.running) {
			try { rec.recorder?.stop(); } catch {}
			cleanupRecording();
		}
		if (cubeRT) cubeRT.dispose();
		if (eyeRT) eyeRT.dispose();
		if (equirectMat) equirectMat.dispose();
		if (offscreen) { offscreen.renderer.dispose(); offscreen = null; }
		cubeRT = eyeRT = equirectMat = equirectScene = cubeCam = blitCanvas = null;
	}

	return {
		parseFov,
		pickRecorderMime,
		takeScreenshot,
		startRecording,
		stopRecording,
		isRecording: () => rec.running,
		state,
		onChange,
		dispose,
		FOV_MIN,
		FOV_MAX,
		FOV_DEFAULT,
		IPD_METERS,
		SCREENSHOT_EYE,
		RECORD_EYE,
		RECORD_FPS,
	};
}

export function mountRenderTab(api) {
	const fov = document.getElementById('dchat-render-fov');
	const err = document.getElementById('dchat-render-fov-error');
	const shot = document.getElementById('dchat-render-screenshot');
	const recBtn = document.getElementById('dchat-render-record');
	const timer = document.getElementById('dchat-render-timer');
	const status = document.getElementById('dchat-render-status');
	if (!fov || !shot || !recBtn) return;
	const showErr = (msg) => {
		if (!err) return;
		err.hidden = !msg;
		err.textContent = msg || '';
		fov.setAttribute('aria-invalid', msg ? 'true' : 'false');
	};
	const currentFov = () => {
		const p = api.parseFov(fov.value);
		showErr(p.ok ? '' : p.error);
		return p;
	};
	fov.addEventListener('input', currentFov);
	fov.addEventListener('change', currentFov);
	shot.addEventListener('click', async () => {
		const p = currentFov();
		if (!p.ok) { fov.focus(); return; }
		shot.disabled = true;
		if (status) status.textContent = 'Rendering screenshot…';
		try {
			const r = await api.takeScreenshot({ fov: p.value, download: true });
			if (status) status.textContent = `Saved ${r.filename} (${r.width}×${r.height}).`;
		} catch (e) {
			showErr(e.message || String(e));
			if (status) status.textContent = '';
		} finally { shot.disabled = false; }
	});
	recBtn.addEventListener('click', async () => {
		if (api.isRecording()) {
			recBtn.disabled = true;
			if (status) status.textContent = 'Finishing recording…';
			try {
				const r = await api.stopRecording();
				recBtn.textContent = 'Start SBS recording';
				if (status) status.textContent = r.blob.size ? `Saved ${r.filename}.` : 'Recording was empty.';
			} catch (e) {
				showErr(e.message || String(e));
			} finally { recBtn.disabled = false; }
			return;
		}
		const p = currentFov();
		if (!p.ok) { fov.focus(); return; }
		try {
			api.startRecording({ fov: p.value, downloadOnStop: true });
			recBtn.textContent = 'Stop SBS recording';
			recBtn.setAttribute('aria-pressed', 'true');
			if (status) status.textContent = 'Recording…';
		} catch (e) {
			showErr(e.message || String(e));
		}
	});
	api.onChange((s) => {
		if (timer) timer.textContent = s.elapsed;
		recBtn.setAttribute('aria-pressed', String(!!s.recording));
		if (!s.recording) recBtn.textContent = 'Start SBS recording';
	});
}
