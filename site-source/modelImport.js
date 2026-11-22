// ============================================================================
// Model import: bring a 3D file into the GS scene (desktop, phone, WebXR).
//
// Formats GS can export (and therefore import here):
//   .glb / .gltf, .fbx, .obj (plus .mtl / textures, or the export .zip),
//   Blender export .zip (.glb + open_in_blender.py).
// Additional: INRIA / SuperSplat / gsplat .ply Gaussian splats (and .spz,
// .splat, .ksplat when Spark can read them). A plain point-cloud .ply
// (positions, no splat properties) falls back to THREE.Points.
//
// Persistence: each import that fits under MAX_PERSIST_BYTES becomes a
// session code block
//   await gsImportModel({ id, name, format, data, files, transform })
// so it is saved / uploaded with the scene, appears in the Code tab, and
// re-runs when the scene loads. Moving the model updates `transform` in
// that block without re-importing. Larger files (over the Cloudflare KV
// 25 MB value limit once base64-wrapped) load in-session only, with a
// non-blocking notice, and are not embedded in the scene code.
//
// Desktop: click a model to attach three.js TransformControls; W / E / R
// (or the on-screen Move / Rotate / Scale buttons) switch mode; Esc
// deselects. WebXR: point at a model and hold grip to move/rotate with the
// controller; both grips scale; a thumbstick while holding also scales.
//
// Hooks from main.js: window.gsGetWorldContentParent, window.gsSessionCode,
// window.camera / scene / renderer, window.THREE, and the init() options.
// ============================================================================

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';

// Cloudflare KV values cap at 25 MB. Base64 inflates ~4/3 plus JSON/code
// wrapping, so only embed raw payloads that stay comfortably under that.
const MAX_PERSIST_BYTES = 12 * 1024 * 1024;
const PROGRESS_MIN_BYTES = 4 * 1024 * 1024;
const SESSION_ONLY_NOTICE = 'This model is too large to save in the scene (Cloudflare KV limit is 25 MB). It will stay in this session only — re-import it after a reload.';
let lastNotice = '';
let lastError = null;
const DEFAULT_POS = [0, 1.2, -2];
const DEFAULT_TARGET_SIZE = 1.4;
const MODEL_ACCEPT = '.ply,.glb,.gltf,.fbx,.obj,.mtl,.zip,.spz,.splat,.ksplat,model/gltf-binary,model/gltf+json,application/zip';
const MODEL_EXT = /\.(ply|glb|gltf|fbx|obj|mtl|zip|spz|splat|ksplat)$/i;
const SCENE_EXT = /\.(vrscene\.json|vrscene|json)$/i;
const SPLAT_EXT = /\.(ply|spz|splat|ksplat)$/i;
const SH_C0 = 0.28209479177387814;

const models = new Map(); // id -> handle
let hooks = {};
let fileInput = null;
let toolbar = null;
let transformCtrl = null;
let selectedId = null;
let dragging = false;
let sparkMod = null;
let sparkRenderer = null;
let sparkRendererPromise = null;
// Sort at most ~30 Hz: a 1M-splat sort every XR frame is a large CPU cost,
// and 33 ms is well under noticeable popping while turning on a Quest 3.
export const SPARK_MIN_SORT_MS = 33;

const xrGrabs = { left: null, right: null }; // { id, hand, startObjPos, startObjQuat, startObjScale, startCtrlPos, startCtrlQuat, invStartCtrlQuat, offset }
let twoHand = null; // { id, startDist, startScale, startMid, startQuat }
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();
const _deltaQuat = new THREE.Quaternion();
const _ptrDown = { x: 0, y: 0, t: 0, active: false };

function notify(text, kind = '') {
	lastNotice = String(text || '');
	if (typeof hooks.notify === 'function') hooks.notify(text, kind);
	else if (typeof window.updateStatus === 'function') window.updateStatus(text, kind);
	else console.log('[gs model import]', text);
}

function ensureProgressEl() {
	let el = document.getElementById('gs-model-import-progress');
	if (el) return el;
	if (!document.getElementById('gs-model-import-progress-style')) {
		const style = document.createElement('style');
		style.id = 'gs-model-import-progress-style';
		style.textContent = [
			'#gs-model-import-progress{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10050;min-width:280px;max-width:min(520px,92vw);padding:10px 14px;border-radius:10px;background:rgba(12,16,22,0.92);color:#e8eef6;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.35);}',
			'#gs-model-import-progress[hidden]{display:none !important;}',
			'#gs-model-import-progress .gs-mip-label{margin-bottom:6px;}',
			'#gs-model-import-progress .gs-mip-bar{height:6px;border-radius:3px;background:rgba(255,255,255,0.15);overflow:hidden;}',
			'#gs-model-import-progress .gs-mip-fill{height:100%;width:0;background:#5eead4;transition:width 0.12s linear;}'
		].join('');
		document.head.appendChild(style);
	}
	el = document.createElement('div');
	el.id = 'gs-model-import-progress';
	el.setAttribute('role', 'status');
	el.hidden = true;
	el.innerHTML = '<div class="gs-mip-label"></div><div class="gs-mip-bar"><div class="gs-mip-fill"></div></div>';
	document.body.appendChild(el);
	return el;
}

function showImportProgress(label, loaded, total) {
	const el = ensureProgressEl();
	el.hidden = false;
	const pct = total > 0 ? Math.min(100, Math.round((100 * loaded) / total)) : null;
	el.querySelector('.gs-mip-label').textContent = pct == null ? label : `${label} ${pct}%`;
	el.querySelector('.gs-mip-fill').style.width = pct == null ? '20%' : `${pct}%`;
}

function hideImportProgress() {
	const el = document.getElementById('gs-model-import-progress');
	if (el) el.hidden = true;
}

async function readFileBytes(file, onProgress) {
	const size = file.size || 0;
	if (typeof file.stream === 'function' && size >= PROGRESS_MIN_BYTES) {
		const u8 = new Uint8Array(size);
		const reader = file.stream().getReader();
		let offset = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			u8.set(value, offset);
			offset += value.byteLength;
			onProgress?.('Reading file', offset, size);
		}
		return u8.subarray(0, offset);
	}
	onProgress?.('Reading file', 0, size);
	const buf = await file.arrayBuffer();
	onProgress?.('Reading file', buf.byteLength, size || buf.byteLength);
	return new Uint8Array(buf);
}

function rawSizeOf(recs) {
	return Object.values(recs || {}).reduce((s, r) => s + (r.size || r.bytes?.byteLength || 0), 0);
}

function persistableRecord(rec) {
	if (!rec) return rec;
	if (typeof rec === 'string') return rec;
	if (rec.base64) return { name: rec.name, mime: rec.mime || 'application/octet-stream', base64: rec.base64 };
	const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes || []);
	return { name: rec.name, mime: rec.mime || 'application/octet-stream', base64: bytesToBase64(bytes) };
}

function persistableFiles(recs) {
	const out = {};
	for (const [k, rec] of Object.entries(recs || {})) out[k] = persistableRecord(rec);
	return out;
}

function worldParent() {
	return (window.gsGetWorldContentParent && window.gsGetWorldContentParent()) || window.scene;
}

function extOf(name) {
	return (String(name).match(/\.([a-z0-9]+)(?:[?#].*)?$/i) || [])[1]?.toLowerCase() || '';
}

function isTextField(el) {
	if (!el || el === document.body) return false;
	if (typeof hooks.isTextEntry === 'function') return hooks.isTextEntry(el);
	const tag = (el.tagName || '').toLowerCase();
	if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
	return !!el.isContentEditable;
}

function bytesToBase64(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = '';
	for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
	return btoa(bin);
}

function base64ToBytes(b64) {
	const bin = atob(b64);
	const u8 = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
	return u8;
}

async function fileToRecord(file) {
	const buf = await file.arrayBuffer();
	return { name: file.name || 'model', mime: file.type || 'application/octet-stream', base64: bytesToBase64(new Uint8Array(buf)) };
}

function recordToBytes(rec) {
	if (!rec) return new Uint8Array(0);
	if (rec instanceof Uint8Array) return rec;
	if (rec instanceof ArrayBuffer) return new Uint8Array(rec);
	if (rec.bytes instanceof Uint8Array) return rec.bytes;
	if (rec.bytes instanceof ArrayBuffer) return new Uint8Array(rec.bytes);
	if (rec.base64) return base64ToBytes(rec.base64);
	return new Uint8Array(0);
}

function newId() {
	return `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// PLY header: splat vs point cloud
// ---------------------------------------------------------------------------
function readPlyHeader(buffer) {
	const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const max = Math.min(u8.length, 65536);
	const header = new TextDecoder('latin1').decode(u8.subarray(0, max));
	if (!/^\s*ply\b/i.test(header)) return { ok: false, reason: 'not a PLY file' };
	const endMatch = header.match(/end_header(?:\r\n|\n|\r)/i);
	if (!endMatch) return { ok: false, reason: 'not a PLY file (missing end_header)' };
	const formatLine = (header.match(/^format\s+(\S+)/im) || [])[1] || '';
	const format = /binary_big_endian/i.test(formatLine) ? 'binary_be'
		: /binary_little_endian/i.test(formatLine) ? 'binary_le'
		: 'ascii';
	const properties = [];
	const propertyTypes = [];
	let vertexCount = 0;
	let element = '';
	for (const line of header.split(/\r?\n/)) {
		const t = line.trim();
		const em = /^element\s+(\S+)\s+(\d+)/i.exec(t);
		if (em) { element = em[1]; if (em[1] === 'vertex') vertexCount = Number(em[2]); continue; }
		const pm = /^property\s+(\S+)\s+(\S+)/i.exec(t);
		if (pm && element === 'vertex') { propertyTypes.push({ type: pm[1].toLowerCase(), name: pm[2] }); properties.push(pm[2]); }
	}
	const has = (n) => properties.includes(n);
	const isSplat = has('f_dc_0') || has('scale_0') || (has('opacity') && has('rot_0'));
	const isCompressed = /^element\s+chunk\b/im.test(header) || properties.some((p) => /^(packed_|chunk_)/.test(p));
	const headerText = header.slice(0, header.indexOf(endMatch[0]) + endMatch[0].length);
	const headerBytes = new TextEncoder().encode(headerText);
	return { ok: true, properties, propertyTypes, vertexCount, isSplat, isCompressed, header: headerText, format, headerBytes };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------
function parseAsync(loader, data, path, ...rest) {
	return new Promise((resolve, reject) => {
		try {
			const result = loader.parse(data, path || '', resolve, reject, ...rest);
			// Some loaders (PLY, OBJ, MTL) return the object synchronously.
			if (result) resolve(result);
		} catch (err) { reject(err); }
	});
}

function objectFromGltf(gltf) {
	const root = gltf.scene || gltf.scenes?.[0];
	if (!root) throw new Error('glTF file has no scene');
	if (gltf.animations?.length) root.animations = gltf.animations;
	return root;
}

async function loadGltf(bytes, path = '') {
	const loader = new GLTFLoader();
	return objectFromGltf(await parseAsync(loader, bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes, path));
}

async function loadFbx(bytes, path = '') {
	const loader = new FBXLoader();
	const buf = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
	return parseAsync(loader, buf, path);
}

async function loadObjWithSidecar(files, objName) {
	const objRec = files[objName];
	const objText = typeof objRec === 'string' ? objRec : strFromU8(recordToBytes(objRec));
	let base = objName.replace(/[^/]+$/, '');
	const mtlRef = /^\s*mtllib\s+(.+)$/im.exec(objText);
	const mtlName = mtlRef ? (base + mtlRef[1].trim().replace(/\\/g, '/').split('/').pop()) : Object.keys(files).find((n) => /\.mtl$/i.test(n));
	const manager = new THREE.LoadingManager();
	const blobUrls = [];
	manager.setURLModifier((url) => {
		const clean = url.split(/[?#]/)[0].replace(/^\.\//, '');
		const key = Object.keys(files).find((n) => n === clean || n.endsWith('/' + clean) || n.split('/').pop() === clean.split('/').pop());
		if (!key) return url;
		const rec = files[key];
		const bytes = typeof rec === 'string' ? new TextEncoder().encode(rec) : recordToBytes(rec);
		const blob = new Blob([bytes]);
		const u = URL.createObjectURL(blob);
		blobUrls.push(u);
		return u;
	});
	const objLoader = new OBJLoader(manager);
	if (mtlName && files[mtlName]) {
		const mtlText = typeof files[mtlName] === 'string' ? files[mtlName] : strFromU8(recordToBytes(files[mtlName]));
		const mtl = new MTLLoader(manager);
		mtl.setResourcePath(base);
		const materials = mtl.parse(mtlText, base);
		materials.preload();
		objLoader.setMaterials(materials);
	}
	try {
		return objLoader.parse(objText);
	} finally {
		// Keep blob URLs alive until textures finish uploading; revoke later.
		setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 30000);
	}
}

async function loadPointCloudPly(bytes) {
	const loader = new PLYLoader();
	const buf = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
	const geometry = await parseAsync(loader, buf);
	if (!geometry.getAttribute('position')) throw new Error('PLY has no vertex positions');
	if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
	const hasColor = !!geometry.getAttribute('color');
	const material = new THREE.PointsMaterial({
		size: 0.02,
		sizeAttenuation: true,
		vertexColors: hasColor,
		color: hasColor ? 0xffffff : 0x88ccff
	});
	const pts = new THREE.Points(geometry, material);
	pts.name = 'gs-ply-points';
	return pts;
}

async function ensureSpark() {
	if (sparkMod) return sparkMod;
	if (!sparkRendererPromise) {
		sparkRendererPromise = import('@sparkjsdev/spark').then((mod) => {
			sparkMod = mod;
			const scene = hooks.scene || window.scene;
			const renderer = hooks.renderer || window.renderer;
			if (!sparkRenderer && scene && renderer && mod.SparkRenderer) {
				sparkRenderer = new mod.SparkRenderer({ renderer, minSortIntervalMs: SPARK_MIN_SORT_MS });
				sparkRenderer.minSortIntervalMs = SPARK_MIN_SORT_MS;
				sparkRenderer.name = 'gsSparkRenderer';
				sparkRenderer.userData.gsNoExport = true;
				scene.add(sparkRenderer);
				if (typeof hooks.registerSystemObject === 'function') hooks.registerSystemObject(sparkRenderer);
			}
			return sparkMod;
		});
	}
	return sparkRendererPromise;
}

async function finalizeSplatMesh(mesh) {
	if (!mesh.numSplats) throw new Error('This splat file has no Gaussians');
	mesh.name = 'gs-splat';
	if (sparkRenderer && typeof sparkRenderer.update === 'function') {
		const scene = hooks.scene || window.scene;
		const camera = hooks.camera || window.camera;
		if (scene && camera) {
			try { await sparkRenderer.update({ scene, camera }); } catch (err) { console.warn('[gs import] Spark update', err); }
		}
	}
	return mesh;
}

async function loadSplat(bytes, fileName, fileType, onProgress, blob) {
	const spark = await ensureSpark();
	const opts = {};
	const ext = extOf(fileName);
	const type = fileType || ext;
	if (type) opts.fileType = type;
	if (fileName) opts.fileName = fileName;
	if (onProgress) {
		opts.onProgress = (ev) => {
			const loaded = ev?.loaded ?? 0;
			const total = ev?.total ?? 0;
			onProgress('Loading splat', loaded, total);
		};
	}
	const fileBytes = bytes instanceof Uint8Array ? bytes : (bytes ? new Uint8Array(bytes) : null);
	// Prefer a Blob / object URL so Spark can stream and decode without an extra copy.
	// After an ASCII transcode we must pass the converted fileBytes instead.
	if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
		const objectUrl = URL.createObjectURL(blob);
		try {
			const mesh = new spark.SplatMesh({ ...opts, url: objectUrl });
			await mesh.initialized;
			mesh.userData.gsSplatObjectUrl = objectUrl;
			return await finalizeSplatMesh(mesh);
		} catch (err) {
			try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
			if (!fileBytes || !fileBytes.byteLength) throw err;
			console.warn('[gs import] Spark blob URL failed, retrying with fileBytes', err);
		}
	}
	if (!fileBytes || !fileBytes.byteLength) throw new Error('No splat data to load');
	const mesh = new spark.SplatMesh({ ...opts, fileBytes });
	await mesh.initialized;
	return finalizeSplatMesh(mesh);
}

async function loadFromZip(bytes, zipName) {
	let files;
	try { files = unzipSync(bytes); }
	catch (err) { throw new Error(`Could not read zip (${zipName}): ${err.message}`); }
	const names = Object.keys(files);
	const recs = {};
	for (const n of names) {
		const u8 = files[n];
		if (/\.(obj|mtl|gltf|txt|py|md|json)$/i.test(n) || n === 'README') recs[n] = strFromU8(u8);
		else recs[n] = { name: n, mime: 'application/octet-stream', base64: bytesToBase64(u8) };
	}
	const glbName = names.find((n) => /\.glb$/i.test(n));
	const hasBlenderScript = names.some((n) => /open_in_blender\.py$/i.test(n) || /\.py$/i.test(n));
	const objName = names.find((n) => /\.obj$/i.test(n));
	const gltfName = names.find((n) => /\.gltf$/i.test(n));
	const fbxName = names.find((n) => /\.fbx$/i.test(n));
	const plyName = names.find((n) => /\.ply$/i.test(n));
	if (glbName && (hasBlenderScript || !objName)) {
		const u8 = files[glbName];
		return { object: await loadGltf(u8, ''), format: 'blender', label: zipName };
	}
	if (objName) {
		return { object: await loadObjWithSidecar(recs, objName), format: 'obj', label: objName };
	}
	if (gltfName) {
		// Rewrite relative URIs via a blob manager by packing as a Folder-like load.
		const manager = new THREE.LoadingManager();
		const blobUrls = [];
		manager.setURLModifier((url) => {
			const clean = url.split(/[?#]/)[0].replace(/^\.\//, '');
			const key = names.find((n) => n === clean || n.endsWith('/' + clean) || n.split('/').pop() === clean.split('/').pop());
			if (!key) return url;
			const blob = new Blob([files[key]]);
			const u = URL.createObjectURL(blob);
			blobUrls.push(u);
			return u;
		});
		const loader = new GLTFLoader(manager);
		const text = typeof recs[gltfName] === 'string' ? recs[gltfName] : strFromU8(files[gltfName]);
		const object = objectFromGltf(await parseAsync(loader, text, ''));
		setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 30000);
		return { object, format: 'gltf', label: gltfName };
	}
	if (fbxName) return { object: await loadFbx(files[fbxName], ''), format: 'fbx', label: fbxName };
	if (plyName) {
		const loaded = await loadPly(files[plyName], plyName);
		return { ...loaded, label: plyName };
	}
	throw new Error(`Nothing in ${zipName} could be imported (expected .glb, .gltf, .obj, .fbx or .ply)`);
}


const PLY_TYPE_SIZE = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
function writePlyValue(view, offset, type, value) {
	switch (type) {
		case 'char': case 'int8': view.setInt8(offset, value); return 1;
		case 'uchar': case 'uint8': view.setUint8(offset, value); return 1;
		case 'short': case 'int16': view.setInt16(offset, value, true); return 2;
		case 'ushort': case 'uint16': view.setUint16(offset, value, true); return 2;
		case 'int': case 'int32': view.setInt32(offset, value, true); return 4;
		case 'uint': case 'uint32': view.setUint32(offset, value, true); return 4;
		case 'double': case 'float64': view.setFloat64(offset, value, true); return 8;
		default: view.setFloat32(offset, value, true); return 4;
	}
}

/** Spark's worker only decodes binary PLY; transcode ASCII 3DGS exports so they still load. */
function asciiSplatPlyToBinary(bytes, info) {
	const text = new TextDecoder('latin1').decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
	const endMatch = text.match(/end_header(?:\r\n|\n|\r)/i);
	if (!endMatch) throw new Error('PLY missing end_header');
	const body = text.slice(text.indexOf(endMatch[0]) + endMatch[0].length);
	const props = info.propertyTypes || [];
	const rowSize = props.reduce((n, p) => n + (PLY_TYPE_SIZE[p.type] || 4), 0);
	const packed = new Uint8Array(rowSize * info.vertexCount);
	const view = new DataView(packed.buffer);
	const lines = body.split(/\r?\n/).filter((ln) => ln.trim() && !ln.startsWith('comment'));
	if (lines.length < info.vertexCount) throw new Error(`PLY has ${lines.length} vertex lines, expected ${info.vertexCount}`);
	let offset = 0;
	for (let i = 0; i < info.vertexCount; i++) {
		const parts = lines[i].trim().split(/\s+/);
		for (let p = 0; p < props.length; p++) {
			offset += writePlyValue(view, offset, props[p].type, Number(parts[p]));
		}
	}
	const rawHeader = text.slice(0, text.indexOf(endMatch[0]) + endMatch[0].length);
	const headerText = rawHeader
		.replace(/^format[^\n\r]*/im, 'format binary_little_endian 1.0')
		.replace(/end_header(?:\r\n|\n|\r)/i, 'end_header\n');
	const headerBytes = new TextEncoder().encode(headerText);
	const out = new Uint8Array(headerBytes.length + packed.length);
	out.set(headerBytes, 0);
	out.set(packed, headerBytes.length);
	return out;
}

async function loadPly(bytes, fileName, onProgress, blob) {
	const info = readPlyHeader(bytes);
	if (!info.ok) throw new Error(info.reason);
	if (info.isSplat || info.isCompressed) {
		try {
			let splatBytes = bytes;
			if (info.format === 'ascii' && info.isSplat && !info.isCompressed) {
				splatBytes = asciiSplatPlyToBinary(bytes, info);
			}
			const useBlob = blob && !(info.format === 'ascii' && info.isSplat && !info.isCompressed);
			const object = await loadSplat(splatBytes, fileName, 'ply', onProgress, useBlob ? blob : null);
			return { object, format: 'ply-splat', plyInfo: info, splat: true };
		} catch (err) {
			const msg = err && err.message ? err.message : String(err);
			if (info.isCompressed) throw new Error(`Could not read this compressed Gaussian splat PLY: ${msg}`);
			throw new Error(`Could not read this Gaussian splat PLY: ${msg}`);
		}
	}
	const object = await loadPointCloudPly(bytes);
	return { object, format: 'ply-points', plyInfo: info, splat: false };
}

async function loadByFormat(format, recs, primaryName, extra = {}) {
	const { onProgress, blob } = extra;
	const primary = recs.data || recs[primaryName] || recs[Object.keys(recs)[0]];
	const bytes = recordToBytes(primary);
	const name = primaryName || primary?.name || 'model';
	const fmt = (format || extOf(name)).toLowerCase();

	if (fmt === 'zip' || fmt === 'blender' || fmt === 'blender-zip') {
		return loadFromZip(bytes, name);
	}
	if (fmt === 'glb' || fmt === 'gltf') {
		if (fmt === 'gltf' && typeof primary === 'string') {
			return { object: await loadGltf(new TextEncoder().encode(primary), ''), format: 'gltf', label: name };
		}
		return { object: await loadGltf(bytes, ''), format: fmt, label: name };
	}
	if (fmt === 'fbx') return { object: await loadFbx(bytes, ''), format: 'fbx', label: name };
	if (fmt === 'obj') {
		const files = recs.files || recs;
		const objName = Object.keys(files).find((n) => /\.obj$/i.test(n)) || name;
		return { object: await loadObjWithSidecar(files, objName), format: 'obj', label: objName };
	}
	if (fmt === 'ply' || fmt === 'ply-splat' || fmt === 'ply-points') {
		const loaded = await loadPly(bytes, name, onProgress, blob);
		return { ...loaded, label: name };
	}
	if (fmt === 'spz' || fmt === 'splat' || fmt === 'ksplat') {
		return { object: await loadSplat(bytes, name, fmt, onProgress, blob), format: fmt, label: name, splat: true };
	}
	throw new Error(`Unsupported model format: ${fmt}`);
}

function fitAndPlace(root, transform, { splatPly = false } = {}) {
	if (transform && Array.isArray(transform.position)) {
		root.position.fromArray(transform.position);
		if (transform.quaternion) root.quaternion.fromArray(transform.quaternion);
		if (transform.scale) {
			const s = transform.scale;
			root.scale.set(s[0] ?? 1, s[1] ?? s[0] ?? 1, s[2] ?? s[0] ?? 1);
		}
		return;
	}
	// 3DGS PLY is stored Y-down in the official INRIA convention; Spark's
	// own examples apply this 180° X rotation so the model stands upright.
	if (splatPly) root.quaternion.set(1, 0, 0, 0);
	root.updateMatrixWorld(true);
	_box.setFromObject(root);
	if (_box.isEmpty()) {
		root.position.set(...DEFAULT_POS);
		return;
	}
	_box.getSize(_size);
	_box.getCenter(_center);
	const longest = Math.max(_size.x, _size.y, _size.z, 1e-6);
	if (!transform?.scale) {
		const s = DEFAULT_TARGET_SIZE / longest;
		if (Number.isFinite(s) && Math.abs(Math.log(s)) > 0.15) root.scale.multiplyScalar(s);
		root.updateMatrixWorld(true);
		_box.setFromObject(root);
		_box.getCenter(_center);
		_box.getSize(_size);
	}
	// Place so the bounding-box centre sits at the default pose.
	root.position.add(new THREE.Vector3(...DEFAULT_POS).sub(_center));
}

function currentTransform(root) {
	return {
		position: root.position.toArray(),
		quaternion: root.quaternion.toArray(),
		scale: root.scale.toArray()
	};
}

function applyTransformToObject(root, transform) {
	if (!transform) return;
	if (transform.position) root.position.fromArray(transform.position);
	if (transform.quaternion) root.quaternion.fromArray(transform.quaternion);
	if (transform.scale) {
		const s = transform.scale;
		root.scale.set(s[0] ?? 1, s[1] ?? 1, s[2] ?? 1);
	}
}

function buildCodeBlock(opts) {
	const { id, name, format, data, files, transform } = opts;
	const lines = [];
	lines.push(`// Imported model: ${String(name).replace(/[\r\n]+/g, ' ')} (${format})`);
	lines.push('// Edit transform below or use the Move / Rotate / Scale gizmo (click the model; W/E/R). In a headset, grip-grab the model (two hands or thumbstick to scale).');
	lines.push('await gsImportModel({');
	lines.push(`\tid: ${JSON.stringify(id)},`);
	lines.push(`\tname: ${JSON.stringify(String(name))},`);
	lines.push(`\tformat: ${JSON.stringify(format)},`);
	if (data) lines.push(`\tdata: ${JSON.stringify(data)},`);
	if (files) {
		lines.push('\tfiles: {');
		const entries = Object.entries(files);
		entries.forEach(([path, v], i) => {
			const comma = i < entries.length - 1 ? ',' : '';
			lines.push(`\t\t${JSON.stringify(path)}: ${JSON.stringify(v)}${comma}`);
		});
		lines.push('\t},');
	}
	lines.push(`\ttransform: ${JSON.stringify(transform)}`);
	lines.push('});');
	return lines.join('\n');
}

function replaceTransformInCode(code, transform) {
	const needle = 'transform:';
	const idx = code.lastIndexOf(needle);
	if (idx < 0) return code;
	// Replace the following JSON object.
	let i = idx + needle.length;
	while (i < code.length && /\s/.test(code[i])) i++;
	if (code[i] !== '{') return code;
	let depth = 0;
	const start = i;
	for (; i < code.length; i++) {
		const c = code[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				return code.slice(0, start) + JSON.stringify(transform) + code.slice(i + 1);
			}
		}
	}
	return code;
}

function persistHandle(handle) {
	if (!handle?.id || !handle.root) return;
	const transform = currentTransform(handle.root);
	handle.transform = transform;
	const api = window.gsSessionCode;
	if (api && typeof api.patchWhere === 'function') {
		api.patchWhere(
			(code) => typeof code === 'string' && code.includes('gsImportModel(') && code.includes(`id: ${JSON.stringify(handle.id)}`),
			(code) => replaceTransformInCode(code, transform)
		);
	}
}

function disposeObject(obj) {
	if (!obj) return;
	obj.traverse((o) => {
		if (o.userData?.gsSplatObjectUrl) {
			try { URL.revokeObjectURL(o.userData.gsSplatObjectUrl); } catch { /* ignore */ }
			o.userData.gsSplatObjectUrl = null;
		}
		if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
		const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
		for (const m of mats) {
			if (!m) continue;
			for (const k of Object.keys(m)) {
				const v = m[k];
				if (v && v.isTexture && typeof v.dispose === 'function') v.dispose();
			}
			if (typeof m.dispose === 'function') m.dispose();
		}
		if (typeof o.dispose === 'function') {
			try { o.dispose(); } catch { /* ignore */ }
		}
	});
}

function forget(id, { persist = false } = {}) {
	const handle = models.get(id);
	if (!handle) return;
	if (selectedId === id) selectModel(null);
	if (handle.root?.parent) handle.root.parent.remove(handle.root);
	disposeObject(handle.root);
	models.delete(id);
	if (persist && window.gsSessionCode?.removeWhere) {
		window.gsSessionCode.removeWhere((code) => typeof code === 'string' && code.includes('gsImportModel(') && code.includes(`id: ${JSON.stringify(id)}`));
	}
}

function groupFiles(fileList) {
	const files = [...fileList];
	const groups = [];
	const used = new Set();
	const byName = (re) => files.filter((f) => re.test(f.name) && !used.has(f));

	for (const f of files) {
		if (used.has(f)) continue;
		if (SCENE_EXT.test(f.name) && !MODEL_EXT.test(f.name)) {
			used.add(f);
			groups.push({ kind: 'scene', files: [f] });
			continue;
		}
		if (/\.zip$/i.test(f.name) || /\.(glb|fbx|spz|splat|ksplat)$/i.test(f.name)) {
			used.add(f);
			groups.push({ kind: 'solo', files: [f] });
			continue;
		}
		if (/\.ply$/i.test(f.name)) {
			used.add(f);
			groups.push({ kind: 'solo', files: [f] });
			continue;
		}
		if (/\.gltf$/i.test(f.name)) {
			used.add(f);
			const sidecars = files.filter((o) => o !== f && !used.has(o) && !SCENE_EXT.test(o.name) && !/\.(ply|glb|fbx|obj|zip)$/i.test(o.name));
			sidecars.forEach((s) => used.add(s));
			groups.push({ kind: 'gltf', files: [f, ...sidecars] });
			continue;
		}
		if (/\.obj$/i.test(f.name)) {
			used.add(f);
			const base = f.name.replace(/\.obj$/i, '');
			const sidecars = files.filter((o) => {
				if (used.has(o)) return false;
				if (/\.mtl$/i.test(o.name)) return true;
				const n = o.name;
				return n.startsWith(base) || n.startsWith(base.split('/').pop());
			});
			// Also take loose image textures sitting next to the OBJ.
			for (const o of files) {
				if (used.has(o) || sidecars.includes(o)) continue;
				if (/\.(mtl|png|jpg|jpeg|webp|bmp|tga|tif|tiff)$/i.test(o.name)) sidecars.push(o);
			}
			sidecars.forEach((s) => used.add(s));
			groups.push({ kind: 'obj', files: [f, ...sidecars] });
		}
	}
	for (const f of files) {
		if (!used.has(f) && MODEL_EXT.test(f.name)) {
			used.add(f);
			groups.push({ kind: 'solo', files: [f] });
		}
	}
	return groups;
}

function formatFromFile(file, kind) {
	const ext = extOf(file.name);
	if (kind === 'obj') return 'obj';
	if (ext === 'zip') return 'zip';
	return ext;
}

async function recordsFromGroup(group, onProgress) {
	const recs = {};
	let read = 0;
	const total = group.files.reduce((s, f) => s + (f.size || 0), 0);
	for (const f of group.files) {
		const bytes = await readFileBytes(f, (_phase, loaded) => {
			onProgress?.('Reading file', read + loaded, total);
		});
		recs[f.name] = {
			name: f.name,
			mime: f.type || 'application/octet-stream',
			bytes,
			size: bytes.byteLength,
			file: f
		};
		read += bytes.byteLength;
	}
	const primary = group.files[0];
	return { recs, primary, format: formatFromFile(primary, group.kind) };
}

// ---------------------------------------------------------------------------
// Public runtime: gsImportModel (runs inside a session code block)
// ---------------------------------------------------------------------------
async function gsImportModel(opts = {}) {
	const id = String(opts.id || newId());
	const name = String(opts.name || 'model');
	const format = String(opts.format || extOf(name) || 'glb');
	if (models.has(id)) forget(id);

	const recs = {};
	if (opts.data) recs.data = opts.data;
	if (opts.files) Object.assign(recs, opts.files);
	if (opts.bytes && !recs.data) recs.data = { name, bytes: opts.bytes instanceof Uint8Array ? opts.bytes : new Uint8Array(opts.bytes) };
	if (!opts.data && !opts.files && !opts.bytes) throw new Error('gsImportModel: no data given');

	const loaded = await loadByFormat(
		format,
		opts.files ? { ...opts.files, data: recs.data } : recs,
		name,
		{ onProgress: opts.onProgress, blob: opts.blob || opts.data?.file }
	);
	const inner = loaded.object;
	inner.name = inner.name || name;

	const root = new THREE.Group();
	root.name = `gs-import:${name}`;
	root.userData.gsImportedModel = { id, name, format: loaded.format || format };
	root.add(inner);

	fitAndPlace(root, opts.transform, { splatPly: (loaded.format || format) === 'ply-splat' });
	worldParent().add(root);

	const handle = {
		id,
		name,
		format: loaded.format || format,
		root,
		inner,
		splat: !!loaded.splat,
		pointCloud: (loaded.format || format) === 'ply-points',
		plyInfo: loaded.plyInfo || null,
		sessionOnly: !!opts.sessionOnly,
		transform: currentTransform(root)
	};
	models.set(id, handle);

	if (handle.sessionOnly) {
		notify(`${name} loaded in this session only. ${SESSION_ONLY_NOTICE}`, '');
	} else if (handle.pointCloud) {
		notify(`Imported ${name} as a point cloud (this .ply has no Gaussian splat properties).`, '');
	} else {
		const extra = handle.splat && handle.inner.numSplats ? ` · ${handle.inner.numSplats} splats` : '';
		notify(`Imported ${name}${extra}`, 'connected');
	}
	return handle;
}

gsImportModel.list = () => [...models.values()].map((h) => ({
	id: h.id,
	name: h.name,
	format: h.format,
	splat: h.splat,
	pointCloud: h.pointCloud,
	numSplats: h.inner?.numSplats || 0,
	sessionOnly: !!h.sessionOnly,
	transform: currentTransform(h.root),
	position: h.root.position.toArray(),
	quaternion: h.root.quaternion.toArray(),
	scale: h.root.scale.toArray()
}));

// ---------------------------------------------------------------------------
// Desktop TransformControls
// ---------------------------------------------------------------------------
function ensureTransformCtrl() {
	if (transformCtrl) return transformCtrl;
	const camera = hooks.camera || window.camera;
	const renderer = hooks.renderer || window.renderer;
	const scene = hooks.scene || window.scene;
	if (!camera || !renderer || !scene) return null;
	const ctrl = new TransformControls(camera, renderer.domElement);
	ctrl.setMode('translate');
	ctrl.setSize(1.1);
	ctrl.space = 'world';
	ctrl.enabled = false;
	ctrl.addEventListener('dragging-changed', (e) => {
		dragging = !!e.value;
		if (typeof hooks.onDragging === 'function') hooks.onDragging(dragging);
		if (!dragging && selectedId) persistHandle(models.get(selectedId));
	});
	ctrl.addEventListener('objectChange', () => {
		if (toolbar && selectedId) syncToolbar();
	});
	const helper = ctrl.getHelper();
	helper.name = 'gsModelTransformHelper';
	helper.userData.gsNoExport = true;
	scene.add(helper);
	if (typeof hooks.registerSystemObject === 'function') hooks.registerSystemObject(helper);
	transformCtrl = ctrl;
	return ctrl;
}

function setMode(mode) {
	const m = (mode === 'rotate' || mode === 'scale') ? mode : 'translate';
	const ctrl = ensureTransformCtrl();
	if (ctrl) ctrl.setMode(m);
	syncToolbar();
	return m;
}

function selectModel(id) {
	const ctrl = ensureTransformCtrl();
	if (id && models.has(id) && !(typeof hooks.isImmersive === 'function' && hooks.isImmersive()) && !(typeof hooks.getArGizmoActive === 'function' && hooks.getArGizmoActive())) {
		const handle = models.get(id);
		selectedId = id;
		if (ctrl) {
			ctrl.attach(handle.root);
			ctrl.enabled = true;
			ctrl.getHelper().visible = true;
		}
	} else {
		selectedId = null;
		if (ctrl) {
			ctrl.detach();
			ctrl.enabled = false;
			ctrl.getHelper().visible = false;
		}
		if (dragging) {
			dragging = false;
			if (typeof hooks.onDragging === 'function') hooks.onDragging(false);
		}
	}
	syncToolbar();
	return selectedId;
}

function applyTransform(id, transform) {
	const handle = models.get(id);
	if (!handle) return false;
	applyTransformToObject(handle.root, transform);
	persistHandle(handle);
	return true;
}

function hitImported(raycaster) {
	const roots = [...models.values()].map((h) => h.root).filter(Boolean);
	if (!roots.length) return null;
	const hits = raycaster.intersectObjects(roots, true);
	for (const hit of hits) {
		let o = hit.object;
		while (o) {
			if (o.userData && o.userData.gsImportedModel) return { handle: models.get(o.userData.gsImportedModel.id), hit };
			o = o.parent;
		}
	}
	return null;
}

function onPointerDown(e) {
	if (e.button !== 0) return;
	if (typeof hooks.isImmersive === 'function' && hooks.isImmersive()) return;
	if (typeof hooks.getArGizmoActive === 'function' && hooks.getArGizmoActive()) return;
	_ptrDown.x = e.clientX;
	_ptrDown.y = e.clientY;
	_ptrDown.t = performance.now();
	_ptrDown.active = true;
}

function onPointerUp(e) {
	if (!_ptrDown.active || e.button !== 0) return;
	_ptrDown.active = false;
	if (dragging) return;
	const dx = e.clientX - _ptrDown.x;
	const dy = e.clientY - _ptrDown.y;
	if (dx * dx + dy * dy > 36) return; // a drag, not a click
	const canvas = (hooks.renderer || window.renderer)?.domElement;
	if (!canvas) return;
	const rect = canvas.getBoundingClientRect();
	if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
	_ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
	_ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
	const camera = hooks.camera || window.camera;
	_raycaster.setFromCamera(_ndc, camera);
	const hit = hitImported(_raycaster);
	if (hit) selectModel(hit.handle.id);
	else if (transformCtrl && transformCtrl.axis) { /* clicked a gizmo handle */ }
	else selectModel(null);
}

function onKeyDown(e) {
	if (isTextField(e.target)) return;
	if (!selectedId) return;
	if (e.code === 'KeyW') { setMode('translate'); e.preventDefault(); }
	else if (e.code === 'KeyE') { setMode('rotate'); e.preventDefault(); }
	else if (e.code === 'KeyR') { setMode('scale'); e.preventDefault(); }
	else if (e.code === 'Escape') { selectModel(null); e.preventDefault(); }
}

function syncToolbar() {
	if (!toolbar) return;
	const handle = selectedId && models.get(selectedId);
	toolbar.classList.toggle('visible', !!handle);
	if (!handle) return;
	const nameEl = toolbar.querySelector('.gs-mxf-name');
	if (nameEl) nameEl.textContent = handle.name;
	const mode = transformCtrl ? transformCtrl.getMode() : 'translate';
	for (const btn of toolbar.querySelectorAll('[data-mode]')) {
		btn.classList.toggle('active', btn.dataset.mode === mode);
	}
}

function mountToolbar() {
	if (toolbar) return toolbar;
	const css = document.createElement('style');
	css.textContent = `
#gs-model-xform { display:none; position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:2400; background:rgba(24,24,36,0.92); color:#fff; border:1px solid rgba(255,255,255,0.16); border-radius:14px; padding:8px 10px; gap:8px; align-items:center; font:13px/1.3 -apple-system,BlinkMacSystemFont,sans-serif; box-shadow:0 8px 28px rgba(0,0,0,0.4); pointer-events:auto; }
#gs-model-xform.visible { display:flex; }
#gs-model-xform .gs-mxf-name { max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; padding:0 6px; }
#gs-model-xform button { appearance:none; border:0; background:rgba(255,255,255,0.1); color:#fff; border-radius:9px; padding:7px 10px; font:inherit; cursor:pointer; }
#gs-model-xform button.active { background:linear-gradient(135deg,#6366f1,#8b5cf6); }
#gs-model-xform button:hover { background:rgba(255,255,255,0.18); }
#gs-model-xform button.active:hover { background:linear-gradient(135deg,#6366f1,#8b5cf6); }
#gs-model-file { display:none; }
`;
	document.head.appendChild(css);
	toolbar = document.createElement('div');
	toolbar.id = 'gs-model-xform';
	toolbar.innerHTML = `
		<span class="gs-mxf-name">Model</span>
		<button type="button" data-mode="translate" title="Move (W)">Move</button>
		<button type="button" data-mode="rotate" title="Rotate (E)">Rotate</button>
		<button type="button" data-mode="scale" title="Scale (R)">Scale</button>
		<button type="button" data-deselect title="Deselect (Esc)">Done</button>
	`;
	toolbar.addEventListener('click', (e) => {
		const btn = e.target.closest('button');
		if (!btn) return;
		if (btn.dataset.mode) setMode(btn.dataset.mode);
		if (btn.hasAttribute('data-deselect')) selectModel(null);
	});
	(document.getElementById('overlay-root') || document.body).appendChild(toolbar);
	if (typeof hooks.registerSystemOverlay === 'function') hooks.registerSystemOverlay(toolbar);
	return toolbar;
}

function mountFileInput() {
	if (fileInput) return fileInput;
	fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.id = 'gs-model-file';
	fileInput.accept = MODEL_ACCEPT;
	fileInput.multiple = true;
	fileInput.addEventListener('change', async () => {
		const list = [...(fileInput.files || [])];
		fileInput.value = '';
		if (list.length) await importUserFiles(list);
	});
	document.body.appendChild(fileInput);
	return fileInput;
}

function isChatDropTarget(el) {
	return !!(el && el.closest && el.closest('#desktop-chat, #desktop-attachments, #dchat-theme-attachments, #chat-overlay, #gs-p5i-modal, #gs-model-export, input, textarea, select'));
}

function hasModelOrScene(dt) {
	if (!dt || !dt.files || !dt.files.length) return false;
	return [...dt.files].some((f) => MODEL_EXT.test(f.name) || SCENE_EXT.test(f.name));
}

function mountDrop() {
	const onOver = (e) => {
		if (!hasModelOrScene(e.dataTransfer) || isChatDropTarget(e.target)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
	};
	window.addEventListener('dragover', onOver);
	window.addEventListener('drop', async (e) => {
		if (!hasModelOrScene(e.dataTransfer) || isChatDropTarget(e.target)) return;
		e.preventDefault();
		await importUserFiles([...e.dataTransfer.files]);
	});
}

function embeddedRawBytes(data, files) {
	let n = 0;
	const add = (rec) => {
		if (!rec) return;
		if (typeof rec === 'string') n += rec.length;
		else if (rec.bytes) n += rec.bytes.byteLength || rec.bytes.length || 0;
		else if (rec.size) n += rec.size;
		else if (rec.base64) n += Math.floor(rec.base64.length * 0.75);
	};
	add(data);
	if (files) Object.values(files).forEach(add);
	return n;
}

async function addImportBlock({ id, name, format, data, files, transform }) {
	if (!window.gsSessionCode?.add) throw new Error('GS is still starting; try again in a moment');
	if (embeddedRawBytes(data, files) > MAX_PERSIST_BYTES) {
		throw new Error(`This model is too large to embed in the scene (limit ${MAX_PERSIST_BYTES / 1048576} MB).`);
	}
	const persistData = data ? persistableRecord(data) : undefined;
	const persistFiles = files ? persistableFiles(files) : undefined;
	const code = buildCodeBlock({ id, name, format, data: persistData, files: persistFiles, transform });
	await window.gsSessionCode.add(code);
}

async function importUserFiles(fileList) {
	const groups = groupFiles(fileList);
	if (!groups.length) {
		notify('No supported 3D file in that drop. Use .ply, .glb, .gltf, .fbx, .obj / .zip, or .vrscene.json.', 'error');
		return;
	}
	for (const group of groups) {
		try {
			if (group.kind === 'scene') {
				if (typeof hooks.importSceneFile === 'function') hooks.importSceneFile(group.files[0]);
				else notify('Use “Import .vrscene.json” on the Scenes tab for scene files.', 'error');
				continue;
			}
			const totalBytes = group.files.reduce((s, f) => s + (f.size || 0), 0);
			const showProgress = totalBytes >= PROGRESS_MIN_BYTES;
			notify(`Importing ${group.files[0].name}…`, 'connecting');
			if (showProgress) showImportProgress(`Importing ${group.files[0].name}`, 0, totalBytes);
			const { recs, primary, format } = await recordsFromGroup(group, showProgress ? showImportProgress : null);
			const id = newId();
			const rawSize = rawSizeOf(recs);
			const multi = format === 'obj' || (format === 'gltf' && group.files.length > 1);
			if (rawSize <= MAX_PERSIST_BYTES) {
				if (multi) await addImportBlock({ id, name: primary.name, format, files: recs });
				else await addImportBlock({ id, name: primary.name, format, data: recs[primary.name] });
			} else {
				const blob = !multi && group.files.length === 1 ? group.files[0] : (primary.file || null);
				await gsImportModel({
					id,
					name: primary.name,
					format,
					data: recs[primary.name],
					files: multi ? recs : undefined,
					blob,
					onProgress: showProgress ? showImportProgress : null,
					sessionOnly: true
				});
			}
		} catch (err) {
			lastError = err;
			const msg = (err && (err.message || String(err))) || 'Unknown import error';
			console.error('[gs import]', err);
			notify(`Import failed: ${msg}`, 'error');
		} finally {
			hideImportProgress();
		}
	}
}

function openPicker() {
	mountFileInput().click();
}

// ---------------------------------------------------------------------------
// XR grab
// ---------------------------------------------------------------------------
function xrBeginGrab(hand, controller, rayOrigin, rayDir) {
	if (hand !== 'left' && hand !== 'right') return false;
	if (xrGrabs[hand]) return true;
	if (typeof hooks.getArGizmoActive === 'function' && hooks.getArGizmoActive()) return false;
	_raycaster.set(rayOrigin, rayDir);
	const hit = hitImported(_raycaster);
	if (!hit) return false;
	const root = hit.handle.root;
	root.updateMatrixWorld(true);
	controller.updateMatrixWorld?.(true);
	const startCtrlPos = new THREE.Vector3();
	const startCtrlQuat = new THREE.Quaternion();
	controller.getWorldPosition(startCtrlPos);
	controller.getWorldQuaternion(startCtrlQuat);
	const startObjPos = new THREE.Vector3();
	const startObjQuat = new THREE.Quaternion();
	const startObjScale = root.scale.clone();
	root.getWorldPosition(startObjPos);
	root.getWorldQuaternion(startObjQuat);
	const offset = startObjPos.clone().sub(startCtrlPos);
	xrGrabs[hand] = {
		id: hit.handle.id,
		hand,
		root,
		startObjPos, startObjQuat, startObjScale,
		startCtrlPos, startCtrlQuat,
		invStartCtrlQuat: startCtrlQuat.clone().invert(),
		offset
	};
	selectModel(hit.handle.id);
	maybeStartTwoHand();
	return true;
}

function maybeStartTwoHand() {
	const a = xrGrabs.left, b = xrGrabs.right;
	if (a && b && a.id === b.id) {
		const dist = a.startCtrlPos.distanceTo(b.startCtrlPos) || 1e-4;
		twoHand = {
			id: a.id,
			startDist: dist,
			startScale: a.startObjScale.clone(),
			startMid: a.startObjPos.clone()
		};
	} else twoHand = null;
}

function xrEndGrab(hand) {
	const g = xrGrabs[hand];
	xrGrabs[hand] = null;
	twoHand = null;
	if (g) persistHandle(models.get(g.id));
	// If the other hand is still holding, rebuild the one-hand start pose
	// from the current transform so motion stays continuous.
	const other = hand === 'left' ? xrGrabs.right : xrGrabs.left;
	if (other) {
		other.root.updateMatrixWorld(true);
		other.root.getWorldPosition(other.startObjPos);
		other.root.getWorldQuaternion(other.startObjQuat);
		other.startObjScale.copy(other.root.scale);
		// startCtrl* stays as the live controller; update on next frame via offset reset in update.
	}
}

function applyWorldPoseToRoot(root, worldPos, worldQuat) {
	const parent = root.parent;
	if (parent) {
		parent.updateMatrixWorld(true);
		parent.worldToLocal(root.position.copy(worldPos));
		parent.getWorldQuaternion(_invQuat).invert();
		root.quaternion.copy(_invQuat).multiply(worldQuat);
	} else {
		root.position.copy(worldPos);
		root.quaternion.copy(worldQuat);
	}
}

function xrUpdate(getController, getStickY, dt) {
	const left = xrGrabs.left, right = xrGrabs.right;
	if (!left && !right) return;

	const poseOf = (g) => {
		const found = getController(g.hand);
		if (!found) return null;
		const c = found.controller || found;
		c.updateMatrixWorld?.(true);
		c.getWorldPosition(_tmpPos);
		c.getWorldQuaternion(_tmpQuat);
		return { pos: _tmpPos.clone(), quat: _tmpQuat.clone() };
	};

	if (left && right && left.id === right.id && twoHand) {
		const pa = poseOf(left), pb = poseOf(right);
		if (!pa || !pb) return;
		const dist = pa.pos.distanceTo(pb.pos) || 1e-4;
		const scaleMul = dist / twoHand.startDist;
		const handle = models.get(left.id);
		if (!handle) return;
		handle.root.scale.copy(twoHand.startScale).multiplyScalar(scaleMul);
		const mid = pa.pos.clone().add(pb.pos).multiplyScalar(0.5);
		const startMid = left.startCtrlPos.clone().add(right.startCtrlPos).multiplyScalar(0.5);
		const worldPos = twoHand.startMid.clone().add(mid.sub(startMid));
		// Average the two controllers' rotation deltas.
		const dqA = pa.quat.clone().multiply(left.invStartCtrlQuat);
		const dqB = pb.quat.clone().multiply(right.invStartCtrlQuat);
		dqA.slerp(dqB, 0.5);
		const worldQuat = dqA.multiply(left.startObjQuat);
		applyWorldPoseToRoot(handle.root, worldPos, worldQuat);
		return;
	}

	const g = left || right;
	const pose = poseOf(g);
	if (!pose) { xrEndGrab(g.hand); return; }
	_deltaQuat.copy(pose.quat).multiply(g.invStartCtrlQuat);
	const worldPos = pose.pos.clone().add(g.offset.clone().applyQuaternion(_deltaQuat));
	const worldQuat = _deltaQuat.multiply(g.startObjQuat.clone());
	applyWorldPoseToRoot(g.root, worldPos, worldQuat);

	const stickY = typeof getStickY === 'function' ? getStickY(g.hand) : 0;
	if (stickY && Math.abs(stickY) > 0.15) {
		const factor = Math.pow(2, -stickY * (dt || 0.016) * 1.8);
		g.root.scale.multiplyScalar(factor);
	}
}

function xrIsGrabbing() {
	return !!(xrGrabs.left || xrGrabs.right);
}

// ---------------------------------------------------------------------------
// Init + window API
// ---------------------------------------------------------------------------
export function initModelImport(opts = {}) {
	hooks = opts || {};
	mountFileInput();
	mountToolbar();
	mountDrop();
	ensureTransformCtrl();
	const canvas = (hooks.renderer || window.renderer)?.domElement;
	if (canvas) {
		canvas.addEventListener('pointerdown', onPointerDown);
		canvas.addEventListener('pointerup', onPointerUp);
	}
	window.addEventListener('keydown', onKeyDown);
	return api();
}

function api() {
	return {
		openPicker,
		importFiles: importUserFiles,
		list: gsImportModel.list,
		MAX_PERSIST_BYTES,
		get lastNotice() { return lastNotice; },
		get lastError() { return lastError ? String(lastError.message || lastError) : ''; },
		select: selectModel,
		get selectedId() { return selectedId; },
		setMode,
		getMode: () => (transformCtrl ? transformCtrl.getMode() : 'translate'),
		applyTransform,
		persist: (id) => persistHandle(models.get(id)),
		isDragging: () => dragging,
		spark: {
			get renderer() { return sparkRenderer; },
			minSortIntervalMs: SPARK_MIN_SORT_MS
		},
		xr: {
			beginGrab: xrBeginGrab,
			endGrab: xrEndGrab,
			update: xrUpdate,
			isGrabbing: xrIsGrabbing,
			get state() {
				return {
					left: xrGrabs.left ? { id: xrGrabs.left.id } : null,
					right: xrGrabs.right ? { id: xrGrabs.right.id } : null
				};
			}
		}
	};
}

window.gsImportModel = gsImportModel;
window.gsModelImport = api();

export { gsImportModel, MODEL_ACCEPT };
