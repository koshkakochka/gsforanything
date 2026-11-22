// Model import: .ply Gaussian splats, every GS export format, and persisted transforms.
// BASE=https://localhost:3588 SHOT=/workspace/gs-ply-shots/imported-splat.png node test.mjs
import fs from 'fs';
import path from 'path';
import os from 'os';
import puppeteer from 'puppeteer-core';

const BASE = (process.env.BASE || 'https://localhost:3588').replace(/\/+$/, '');
const SHOT = process.env.SHOT || '/workspace/gs-ply-shots/imported-splat.png';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SH_C0 = 0.28209479177387814;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
	ok ? pass++ : fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`);
};

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '../..');
check(
	'modelImport.js shipped to the Worker and Vercel',
	/modelImport\.js/.test(fs.readFileSync(path.join(REPO, 'worker/sync-public.sh'), 'utf8')) &&
	/site-source\/modelImport\.js/.test(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'))
);

function splatPly({ n = 5 } = {}) {
	const verts = [];
	const logit = (p) => Math.log(p / (1 - p));
	const dc = (c) => (c - 0.5) / SH_C0;
	for (let z = 0; z < n; z++) {
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				const px = (x / (n - 1) - 0.5) * 0.6;
				const py = (y / (n - 1) - 0.5) * 0.6;
				const pz = (z / (n - 1) - 0.5) * 0.6;
				verts.push({
					x: px, y: py, z: pz,
					f0: dc(x / (n - 1)), f1: dc(y / (n - 1)), f2: dc(z / (n - 1)),
					op: logit(0.92),
					s0: Math.log(0.07), s1: Math.log(0.07), s2: Math.log(0.07),
					r0: 1, r1: 0, r2: 0, r3: 0
				});
			}
		}
	}
	const lines = [
		'ply', 'format ascii 1.0', `element vertex ${verts.length}`,
		'property float x', 'property float y', 'property float z',
		'property float f_dc_0', 'property float f_dc_1', 'property float f_dc_2',
		'property float opacity',
		'property float scale_0', 'property float scale_1', 'property float scale_2',
		'property float rot_0', 'property float rot_1', 'property float rot_2', 'property float rot_3',
		'end_header'
	];
	for (const v of verts) {
		lines.push([v.x, v.y, v.z, v.f0, v.f1, v.f2, v.op, v.s0, v.s1, v.s2, v.r0, v.r1, v.r2, v.r3].join(' '));
	}
	return lines.join('\n') + '\n';
}

function pointCloudPly() {
	return [
		'ply', 'format ascii 1.0', 'element vertex 4',
		'property float x', 'property float y', 'property float z',
		'property uchar red', 'property uchar green', 'property uchar blue',
		'end_header',
		'0 0 0 255 0 0',
		'0.2 0 0 0 255 0',
		'0 0.2 0 0 0 255',
		'0 0 0.2 255 255 0',
		''
	].join('\n');
}

function splatPlyBinary({ n = 5 } = {}) {
	const props = ['x','y','z','nx','ny','nz','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
	const header = Buffer.from(
		`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n` +
		props.map((pr) => `property float ${pr}\n`).join('') +
		'end_header\n'
	);
	const dc = (c) => (c - 0.5) / SH_C0;
	const opacity = Math.log(0.92 / (1 - 0.92));
	const scale = Math.log(0.07);
	const body = Buffer.alloc(n * 68);
	for (let i = 0; i < n; i++) {
		const t = n === 1 ? 0 : i / (n - 1);
		const o = i * 68;
		body.writeFloatLE((t - 0.5) * 0.6, o + 0);
		body.writeFloatLE(1.2, o + 4);
		body.writeFloatLE(-2 + (i % 2) * 0.02, o + 8);
		body.writeFloatLE(0, o + 12);
		body.writeFloatLE(1, o + 16);
		body.writeFloatLE(0, o + 20);
		body.writeFloatLE(dc(0.95), o + 24);
		body.writeFloatLE(dc(0.55), o + 28);
		body.writeFloatLE(dc(0.15), o + 32);
		body.writeFloatLE(opacity, o + 36);
		body.writeFloatLE(scale, o + 40);
		body.writeFloatLE(scale, o + 44);
		body.writeFloatLE(scale, o + 48);
		body.writeFloatLE(1, o + 52);
		body.writeFloatLE(0, o + 56);
		body.writeFloatLE(0, o + 60);
		body.writeFloatLE(0, o + 64);
	}
	return Buffer.concat([header, body]);
}

function writeTmp(name, data) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-ply-'));
	const fp = path.join(dir, name);
	fs.writeFileSync(fp, data);
	return fp;
}

const b = await puppeteer.launch({
	executablePath: CHROME,
	headless: 'new',
	args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

async function openPage() {
	const p = await b.newPage();
	const errors = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => {
		if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
	});
	await p.setViewport({ width: 1280, height: 860 });
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const u = new URL(req.url());
		if (u.pathname.startsWith('/api/')) {
			const body = u.pathname === '/api/backends'
				? '{"backends":{"claude":{"label":"Claude","provider":"claude","available":true}},"default":"claude"}'
				: (u.pathname === '/api/community-scenes' ? '{"scenes":[]}' : '{}');
			return req.respond({ status: 200, contentType: 'application/json', body });
		}
		req.continue();
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
	await p.waitForFunction(() => window.gsSelectTab && window.gsImportModel && window.gsModelImport, { timeout: 30000 });
	await sleep(400);
	p._errors = errors;
	return p;
}

function toB64(buf) {
	return Buffer.from(buf).toString('base64');
}

const p = await openPage();

// --- UI entry point ---
await p.evaluate(() => window.gsSelectTab('scenes'));
await sleep(300);
const ui = await p.evaluate(() => {
	const btn = [...document.querySelectorAll('#dchat-scenes-buttons [data-action]')].map((el) => ({
		action: el.getAttribute('data-action'),
		label: (el.textContent || '').replace(/\s+/g, ' ').trim()
	}));
	return {
		btn,
		hasImport: btn.some((b) => b.action === 'scenes:importModel' && b.label === 'Import model'),
		fileInput: !!document.getElementById('gs-model-file'),
		api: typeof window.gsImportModel === 'function' && typeof window.gsModelImport.openPicker === 'function'
	};
});
check('Scenes tab has Import model button', ui.hasImport, ui.btn);
check('hidden file input and gsImportModel API exist', ui.fileInput && ui.api, ui);

// --- Gaussian splat .ply ---
const splatPath = writeTmp('tiny-splat.ply', splatPly({ n: 5 }));
const splatInput = await p.$('#gs-model-file');
await splatInput.uploadFile(splatPath);
await p.waitForFunction(() => (window.gsImportModel.list() || []).some((h) => h.splat), { timeout: 30000 });
await sleep(800);
const splatInfo = await p.evaluate(() => {
	const h = window.gsImportModel.list().find((x) => x.splat);
	return h || null;
});
check('PLY Gaussian splat imported', !!(splatInfo && splatInfo.splat && splatInfo.numSplats >= 8), splatInfo);
check('imported splat is a selectable model', !!(splatInfo && splatInfo.id && splatInfo.transform), splatInfo);

// Frame the splat and take the one screenshot for this change.
await p.evaluate(async () => {
	const h = window.gsImportModel.list().find((x) => x.splat);
	if (!h) return;
	document.getElementById('desktop-chat-minimize')?.click();
	window.gsControls?.setMode?.('off');
	if (window.camera) {
		window.camera.position.set(0, 1.25, 0.35);
		window.camera.up.set(0, 1, 0);
		window.camera.lookAt(0, 1.2, -2);
		window.camera.updateMatrixWorld(true);
	}
	const spark = window.scene?.getObjectByName('gsSparkRenderer');
	if (spark && typeof spark.update === 'function') {
		try { await spark.update({ scene: window.scene, camera: window.camera }); } catch (e) { /* ignore */ }
	}
	if (h.id) window.gsModelImport.select(h.id);
	window.renderer?.render(window.scene, window.camera);
});
await sleep(800);
fs.mkdirSync(path.dirname(SHOT), { recursive: true });
await p.screenshot({ path: SHOT });
check('screenshot written', fs.existsSync(SHOT) && fs.statSync(SHOT).size > 1000, SHOT);
console.log('SHOT', SHOT);

// --- Point-cloud fallback ---
const pcPath = writeTmp('points.ply', pointCloudPly());
await (await p.$('#gs-model-file')).uploadFile(pcPath);
await p.waitForFunction(() => (window.gsImportModel.list() || []).some((h) => h.pointCloud), { timeout: 20000 });
const pcInfo = await p.evaluate(() => window.gsImportModel.list().find((x) => x.pointCloud) || null);
check('plain point-cloud PLY falls back to points', !!(pcInfo && pcInfo.pointCloud && pcInfo.format === 'ply-points'), pcInfo);

// --- Export then import each format ---
await p.evaluate(() => {
	const mesh = new THREE.Mesh(
		new THREE.BoxGeometry(0.35, 0.25, 0.4),
		new THREE.MeshStandardMaterial({ color: 0x33aaff, roughness: 0.4 })
	);
	mesh.name = 'exportBox';
	mesh.position.set(1.2, 1.1, -1.8);
	window.scene.add(mesh);
	window.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 0.8));
});
await sleep(200);

async function exportBytes(method, arg) {
	return p.evaluate(async (method, arg) => {
		const r = await window.gsSceneExport[method](arg);
		const buf = await r.blob.arrayBuffer();
		const u8 = Array.from(new Uint8Array(buf));
		return { bytes: u8, type: r.blob.type, meshCount: r.meshCount };
	}, method, arg);
}

async function importViaApi(name, format, bytes) {
	const b64 = toB64(Buffer.from(bytes));
	return p.evaluate(async (name, format, b64) => {
		const before = new Set(window.gsImportModel.list().map((h) => h.id));
		const id = 'imp_test_' + format.replace(/\W+/g, '_') + '_' + Math.random().toString(36).slice(2, 6);
		await window.gsSessionCode.add(
			`await gsImportModel({ id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, format: ${JSON.stringify(format)}, data: { name: ${JSON.stringify(name)}, mime: "application/octet-stream", base64: ${JSON.stringify(b64)} }, transform: { position: [0, 1.1, -2], quaternion: [0,0,0,1], scale: [1,1,1] } });`
		);
		const h = window.gsImportModel.list().find((x) => x.id === id);
		return { id, format: h?.format, name: h?.name, ok: !!h, count: window.gsImportModel.list().length, added: !before.has(id) };
	}, name, format, b64);
}

const glb = await exportBytes('exportGLB');
check('exported a GLB with at least one mesh', glb.meshCount > 0 && glb.bytes.length > 64, { meshCount: glb.meshCount, n: glb.bytes.length });
const glbImp = await importViaApi('roundtrip.glb', 'glb', glb.bytes);
check('imported GLB back into the scene', glbImp.ok, glbImp);

const gltf = await exportBytes('exportGLTF');
check('exported a glTF', gltf.bytes.length > 16, { n: gltf.bytes.length });
const gltfImp = await importViaApi('roundtrip.gltf', 'gltf', gltf.bytes);
check('imported glTF back into the scene', gltfImp.ok, gltfImp);

const fbx = await exportBytes('exportFBX');
check('exported an FBX', fbx.bytes.length > 64, { n: fbx.bytes.length });
const fbxImp = await importViaApi('roundtrip.fbx', 'fbx', fbx.bytes);
check('imported FBX back into the scene', fbxImp.ok, fbxImp);

const objz = await exportBytes('exportOBJ', 'roundtrip');
check('exported an OBJ zip', objz.bytes.length > 32, { n: objz.bytes.length });
const objImp = await importViaApi('roundtrip-obj.zip', 'zip', objz.bytes);
check('imported OBJ zip back into the scene', objImp.ok, objImp);

const blend = await exportBytes('exportBlenderZip', 'roundtrip');
check('exported a Blender zip', blend.bytes.length > 64, { n: blend.bytes.length });
const blendImp = await importViaApi('roundtrip-blender.zip', 'zip', blend.bytes);
check('imported Blender zip (GLB inside) back into the scene', blendImp.ok, blendImp);

// --- Transform apply + persist ---
const persist = await p.evaluate(async () => {
	const h = window.gsImportModel.list().find((x) => x.format === 'glb' || x.name === 'roundtrip.glb') || window.gsImportModel.list().find((x) => !x.splat && !x.pointCloud);
	if (!h) return { error: 'no mesh import' };
	const transform = { position: [1.25, 2.5, -3.25], quaternion: [0, 0.7071, 0, 0.7071], scale: [1.5, 1.5, 1.5] };
	const okApply = window.gsModelImport.applyTransform(h.id, transform);
	const live = window.gsImportModel.list().find((x) => x.id === h.id);
	const codes = window.gsSessionCode.all();
	const block = codes.find((c) => c.includes('gsImportModel(') && c.includes(h.id));
	let saved = null;
	if (block) {
		const idx = block.lastIndexOf('transform:');
		const start = idx >= 0 ? block.indexOf('{', idx) : -1;
		if (start >= 0) {
			let depth = 0, end = -1;
			for (let i = start; i < block.length; i++) {
				if (block[i] === '{') depth++;
				else if (block[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
			}
			const raw = end >= 0 ? block.slice(start, end + 1) : '';
			try { saved = JSON.parse(raw); } catch (e) { saved = { parseError: String(e), raw }; }
		}
	}
	// Re-run the saved block: drop this import and add the patched code again.
	window.gsSessionCode.removeWhere((c) => c.includes('gsImportModel(') && c.includes(h.id));
	await window.gsSessionCode.add(block);
	const reloaded = window.gsImportModel.list().find((x) => x.id === h.id);
	const close = (a, b, eps = 1e-3) => a && b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
	return {
		okApply,
		livePos: live?.position,
		saved,
		reloadedPos: reloaded?.position,
		reloadedScale: reloaded?.scale,
		posOk: close(reloaded?.position, transform.position),
		scaleOk: close(reloaded?.scale, transform.scale),
		modes: { set: typeof window.gsModelImport.setMode === 'function', xr: typeof window.gsModelImport.xr?.beginGrab === 'function' },
		gizmoMode: (window.gsModelImport.setMode('rotate'), window.gsModelImport.getMode())
	};
});
check('applyTransform moves the live model', persist.okApply && persist.livePos && Math.abs(persist.livePos[1] - 2.5) < 0.05, persist);
check('transform is written into the scene code block', !!(persist.saved && Math.abs(persist.saved.position?.[1] - 2.5) < 0.05), persist.saved);
check('reloaded import restores the saved transform', persist.posOk && persist.scaleOk, persist);
check('desktop mode toggle and XR grab API exist', persist.modes?.set && persist.modes?.xr && persist.gizmoMode === 'rotate', persist);

// Desktop click-select + gizmo attach (synthetic click at canvas center may miss;
// select() is the same path the click handler uses after a ray hit).
const selected = await p.evaluate(() => {
	const h = window.gsImportModel.list()[0];
	window.gsModelImport.select(h.id);
	const bar = document.getElementById('gs-model-xform');
	return { id: window.gsModelImport.selectedId, toolbar: !!(bar && bar.classList.contains('visible')) };
});
check('selecting a model shows Move/Rotate/Scale toolbar', selected.toolbar && !!selected.id, selected);

// --- Small imports still persist; large ones stay in-session ---
const capInfo = await p.evaluate(() => ({
	cap: window.gsModelImport.MAX_PERSIST_BYTES,
	noticeApi: typeof window.gsModelImport.lastNotice === 'string'
}));
check('persist cap is KV-safe (12 MiB raw)', capInfo.cap === 12 * 1024 * 1024, capInfo);

const smallPersist = await p.evaluate(() => {
	const h = window.gsImportModel.list().find((x) => x.splat && !x.sessionOnly);
	const codes = window.gsSessionCode.all();
	const block = codes.find((c) => h && c.includes('gsImportModel(') && c.includes(h.id));
	return { id: h?.id, embedded: !!(block && block.includes('base64')), sessionOnly: !!h?.sessionOnly };
});
check('small splat is still embedded in the scene code', smallPersist.embedded && !smallPersist.sessionOnly, smallPersist);

const OVER_CAP_N = Math.ceil((12 * 1024 * 1024 + 2048) / 68);
const overCapPath = writeTmp('overcap-splat.ply', splatPlyBinary({ n: OVER_CAP_N }));
check('over-cap fixture is just over 12 MiB', fs.statSync(overCapPath).size > 12 * 1024 * 1024, fs.statSync(overCapPath).size);
const beforeOver = await p.evaluate(() => window.gsImportModel.list().map((h) => h.id));
await (await p.$('#gs-model-file')).uploadFile(overCapPath);
await p.waitForFunction((before) => (window.gsImportModel.list() || []).some((h) => h.splat && !before.includes(h.id)), { timeout: 180000 }, beforeOver);
const over = await p.evaluate((before) => {
	const h = window.gsImportModel.list().find((x) => x.splat && !before.includes(x.id));
	const codes = window.gsSessionCode.all();
	const block = h ? codes.find((c) => c.includes('gsImportModel(') && c.includes(h.id)) : null;
	const progressStyle = !!document.getElementById('gs-model-import-progress-style');
	return {
		ok: !!(h && h.splat),
		sessionOnly: !!h?.sessionOnly,
		embedded: !!(block && block.includes('base64')),
		notice: window.gsModelImport.lastNotice || '',
		numSplats: h?.numSplats,
		id: h?.id,
		progressStyle
	};
}, beforeOver);
check('over-cap splat imports in-session', over.ok && over.numSplats >= 8, over);
check('over-cap splat is not embedded in session code', over.sessionOnly && !over.embedded, over);
check('over-cap import shows a session-only notice', /session only|too large to save|KV/i.test(over.notice), over);
check('large-file progress indicator is mounted', over.progressStyle, over);

const LARGE = '/workspace/samples/gs-large-splat.ply';
const largeStat = fs.existsSync(LARGE) ? fs.statSync(LARGE) : null;
check('large synthetic splat sample exists and is ≥ 60 MiB', !!(largeStat && largeStat.size >= 60 * 1024 * 1024), largeStat && largeStat.size);
if (largeStat && largeStat.size >= 60 * 1024 * 1024) {
	const beforeLarge = await p.evaluate(() => window.gsImportModel.list().map((h) => h.id));
	await (await p.$('#gs-model-file')).uploadFile(LARGE);
	await p.waitForFunction((before) => (window.gsImportModel.list() || []).some((h) => h.splat && !before.includes(h.id)), { timeout: 300000 }, beforeLarge);
	const large = await p.evaluate((before) => {
		const h = window.gsImportModel.list().find((x) => x.splat && !before.includes(x.id));
		const codes = window.gsSessionCode.all();
		const block = h ? codes.find((c) => c.includes('gsImportModel(') && c.includes(h.id)) : null;
		return {
			ok: !!(h && h.splat),
			sessionOnly: !!h?.sessionOnly,
			embedded: !!(block && block.includes('base64')),
			notice: window.gsModelImport.lastNotice || '',
			numSplats: h?.numSplats,
			id: h?.id
		};
	}, beforeLarge);
	check('~65 MiB / 1M-splat PLY imports in-session', large.ok && large.numSplats >= 100000, large);
	check('~65 MiB splat is not embedded in session code', large.sessionOnly && !large.embedded, large);
	check('~65 MiB import shows a session-only notice', /session only|too large to save|KV/i.test(large.notice), large);
}

const fatal = p._errors.filter((e) => !/Failed to load|WebGL|context/i.test(e));
check('no unexpected page errors', fatal.length === 0, fatal.slice(0, 5));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
