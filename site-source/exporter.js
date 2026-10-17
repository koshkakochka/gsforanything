/**
 * GS scene export: GLB (three's GLTFExporter) and FBX (binary FBX 7.4 writer
 * in this file, no server or native binary needed, so it works the same on
 * the Cloudflare Worker, Vercel and locally).
 *
 * main.js only wires it up (initSceneExport + two menu actions); the export
 * dialog, object collection and both writers live here so this module can be
 * merged independently of other main.js work.
 *
 * What gets exported: the user's scene content (chat-generated objects and
 * active loaded scenes). main.js supplies getRoots(), which already skips the
 * app's own objects (UI panels, VR windows, HUD, reticles, camera rig,
 * lights/helpers that existed at startup). Here we also skip cameras and
 * helpers that scene code may have added.
 *
 * FBX limits (stated in the dialog too): meshes with transforms and
 * hierarchy, normals, one UV set, vertex colours and basic Phong material
 * colours/opacity. No textures, lights, cameras, skinning or animation; lines,
 * points and sprites are skipped. Skinned meshes are written in bind pose and
 * InstancedMesh instances as separate meshes.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// ---------------------------------------------------------------------------
// Collecting exportable content
// ---------------------------------------------------------------------------
function isExportableNode(obj) {
	if (!obj) return false;
	if (obj.isCamera || obj.isTransformControls) return false;
	if (obj.type && /Helper$/.test(obj.type)) return false;
	if (obj.userData && obj.userData.gsNoExport) return false;
	return true;
}

// glTF animates whole position / quaternion / scale vectors and morph
// weights. Tracks on a single component (e.g. "Box.position[y]") or other
// properties would produce an invalid file, so they are left out.
const GLTF_TRACK = /\.(position|quaternion|scale|morphTargetInfluences)(\[[^\]]*\])?$/;
function gltfSafeClip(clip) {
	const tracks = clip.tracks.filter((t) => {
		const m = GLTF_TRACK.exec(t.name);
		if (!m) return false;
		if (m[1] !== 'morphTargetInfluences' && m[2]) return false;
		return true;
	});
	if (tracks.length < clip.tracks.length) {
		console.warn(`[gs] export: ${clip.tracks.length - tracks.length} animation track(s) in "${clip.name}" cannot be stored in glTF and were skipped`);
	}
	if (!tracks.length) return null;
	return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Clones the roots into a temporary export group so filtering (cameras,
 * helpers, invisible objects) never touches the live scene.
 */
function buildExportGroup(roots) {
	const group = new THREE.Group();
	group.name = 'GS Scene';
	const animations = [];
	const seenClips = new Set();
	const prune = (node) => {
		for (let i = node.children.length - 1; i >= 0; i--) {
			const c = node.children[i];
			if (!isExportableNode(c) || c.visible === false) node.remove(c);
			else prune(c);
		}
	};
	for (const root of roots) {
		if (!isExportableNode(root) || root.visible === false) continue;
		root.updateWorldMatrix(true, true);
		// Keep the root's world transform (some content lives under the AR
		// placement group), so the file matches what you see.
		const copy = root.clone(true);
		root.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
		prune(copy);
		group.add(copy);
		root.traverse((o) => {
			for (const clip of o.animations || []) {
				if (!clip || seenClips.has(clip.uuid)) continue;
				seenClips.add(clip.uuid);
				const safe = gltfSafeClip(clip);
				if (safe) animations.push(safe);
			}
		});
	}
	let meshCount = 0;
	group.traverse((o) => { if (o.isMesh) meshCount++; });
	return { group, animations, meshCount };
}

// ---------------------------------------------------------------------------
// GLB
// ---------------------------------------------------------------------------
export async function exportGLB(roots) {
	const { group, animations, meshCount } = buildExportGroup(roots);
	if (meshCount === 0) throw new Error('Nothing to export yet. Add something to the scene first.');
	const exporter = new GLTFExporter();
	const result = await exporter.parseAsync(group, {
		binary: true,
		onlyVisible: true,
		animations,
		maxTextureSize: 4096
	});
	return { blob: new Blob([result], { type: 'model/gltf-binary' }), meshCount, animationCount: animations.length };
}

// ---------------------------------------------------------------------------
// Binary FBX 7.4 writer
// ---------------------------------------------------------------------------
// Node record (FBX < 7.5): u32 endOffset, u32 numProperties,
// u32 propertyListLen, u8 nameLen, name, properties, children, and a 13-byte
// null record when the node has children. Arrays are stored uncompressed.
const FBX_VERSION = 7400;
const FOOTER_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FOOTER_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];
const textEncoder = new TextEncoder();

// Property constructors
const P = {
	I: (v) => ({ t: 'I', v }),       // int32
	L: (v) => ({ t: 'L', v }),       // int64
	D: (v) => ({ t: 'D', v }),       // double
	F: (v) => ({ t: 'F', v }),       // float
	C: (v) => ({ t: 'C', v }),       // bool
	S: (v) => ({ t: 'S', v }),       // string
	R: (v) => ({ t: 'R', v }),       // raw bytes
	di: (v) => ({ t: 'd', v }),      // double array
	ii: (v) => ({ t: 'i', v })       // int32 array
};
const node = (name, props = [], children = []) => ({ name, props, children });

class ByteWriter {
	constructor() { this.buf = new Uint8Array(1 << 16); this.view = new DataView(this.buf.buffer); this.len = 0; }
	ensure(n) {
		if (this.len + n <= this.buf.length) return;
		let size = this.buf.length;
		while (size < this.len + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf.subarray(0, this.len));
		this.buf = next;
		this.view = new DataView(next.buffer);
	}
	u8(v) { this.ensure(1); this.view.setUint8(this.len, v); this.len += 1; }
	i16(v) { this.ensure(2); this.view.setInt16(this.len, v, true); this.len += 2; }
	u32(v) { this.ensure(4); this.view.setUint32(this.len, v, true); this.len += 4; }
	i32(v) { this.ensure(4); this.view.setInt32(this.len, v, true); this.len += 4; }
	i64(v) { this.ensure(8); this.view.setBigInt64(this.len, BigInt(v), true); this.len += 8; }
	f32(v) { this.ensure(4); this.view.setFloat32(this.len, v, true); this.len += 4; }
	f64(v) { this.ensure(8); this.view.setFloat64(this.len, v, true); this.len += 8; }
	bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
	setU32(at, v) { this.view.setUint32(at, v, true); }
	result() { return this.buf.slice(0, this.len); }
}

function writeProperty(w, p) {
	w.u8(p.t.charCodeAt(0));
	switch (p.t) {
		case 'C': w.u8(p.v ? 1 : 0); break;
		case 'Y': w.i16(p.v); break;
		case 'I': w.i32(p.v); break;
		case 'F': w.f32(p.v); break;
		case 'D': w.f64(p.v); break;
		case 'L': w.i64(p.v); break;
		case 'S': case 'R': {
			const bytes = p.t === 'S' ? textEncoder.encode(p.v) : p.v;
			w.u32(bytes.length); w.bytes(bytes); break;
		}
		case 'd': case 'i': {
			const arr = p.v;
			const elemSize = p.t === 'd' ? 8 : 4;
			w.u32(arr.length); w.u32(0); w.u32(arr.length * elemSize);
			for (let i = 0; i < arr.length; i++) {
				if (p.t === 'd') w.f64(arr[i]); else w.i32(arr[i]);
			}
			break;
		}
		default: throw new Error(`FBX: unsupported property type ${p.t}`);
	}
}

function writeNode(w, n) {
	const start = w.len;
	w.u32(0); w.u32(n.props.length); w.u32(0);
	const nameBytes = textEncoder.encode(n.name);
	w.u8(nameBytes.length); w.bytes(nameBytes);
	const propStart = w.len;
	for (const p of n.props) writeProperty(w, p);
	w.setU32(start + 8, w.len - propStart);
	if (n.children.length) {
		for (const c of n.children) writeNode(w, c);
		w.bytes(new Uint8Array(13)); // null record ends the child list
	}
	w.setU32(start, w.len);
}

// Properties70 "P" helpers
const p70 = (children) => node('Properties70', [], children);
const pInt = (name, v) => node('P', [P.S(name), P.S('int'), P.S('Integer'), P.S(''), P.I(v)]);
const pDouble = (name, v) => node('P', [P.S(name), P.S('double'), P.S('Number'), P.S(''), P.D(v)]);
const pColor = (name, c) => node('P', [P.S(name), P.S('Color'), P.S(''), P.S('A'), P.D(c[0]), P.D(c[1]), P.D(c[2])]);
const pVec = (name, v) => node('P', [P.S(name), P.S(name), P.S(''), P.S('A'), P.D(v[0]), P.D(v[1]), P.D(v[2])]);
const pEnum = (name, v) => node('P', [P.S(name), P.S('enum'), P.S(''), P.S(''), P.I(v)]);
const pString = (name, v) => node('P', [P.S(name), P.S('KString'), P.S(''), P.S(''), P.S(v)]);
const fbxName = (name, cls) => `${String(name || cls).replace(/[\x00\x01]/g, '')}\x00\x01${cls}`;

function srgb(color) {
	const out = new THREE.Color();
	color.getRGB(out, THREE.SRGBColorSpace);
	return [out.r, out.g, out.b];
}

function geometryToFbx(id, geometry, name, groupMaterialIndex) {
	const pos = geometry.getAttribute('position');
	if (!pos || pos.count === 0) return null;
	const normal = geometry.getAttribute('normal');
	const uv = geometry.getAttribute('uv');
	const color = geometry.getAttribute('color');
	const index = geometry.getIndex();
	const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
	if (triCount === 0) return null;

	const vertices = new Float64Array(pos.count * 3);
	for (let i = 0; i < pos.count; i++) {
		vertices[i * 3] = pos.getX(i); vertices[i * 3 + 1] = pos.getY(i); vertices[i * 3 + 2] = pos.getZ(i);
	}
	const vi = (k) => (index ? index.getX(k) : k);
	const pvi = new Int32Array(triCount * 3);
	for (let t = 0; t < triCount; t++) {
		pvi[t * 3] = vi(t * 3);
		pvi[t * 3 + 1] = vi(t * 3 + 1);
		pvi[t * 3 + 2] = ~vi(t * 3 + 2); // negative (bitwise not) ends a polygon
	}
	const children = [
		node('GeometryVersion', [P.I(124)]),
		node('Vertices', [P.di(vertices)]),
		node('PolygonVertexIndex', [P.ii(pvi)])
	];
	const layer = [];

	// Normals: by polygon vertex (one per corner), so hard edges survive.
	let norm = normal;
	if (!norm) {
		const tmp = geometry.clone();
		tmp.computeVertexNormals();
		norm = tmp.getAttribute('normal');
	}
	if (norm) {
		const normals = new Float64Array(triCount * 9);
		for (let k = 0; k < triCount * 3; k++) {
			const v = vi(k);
			normals[k * 3] = norm.getX(v); normals[k * 3 + 1] = norm.getY(v); normals[k * 3 + 2] = norm.getZ(v);
		}
		children.push(node('LayerElementNormal', [P.I(0)], [
			node('Version', [P.I(101)]),
			node('Name', [P.S('')]),
			node('MappingInformationType', [P.S('ByPolygonVertex')]),
			node('ReferenceInformationType', [P.S('Direct')]),
			node('Normals', [P.di(normals)])
		]));
		layer.push('LayerElementNormal');
	}
	if (color) {
		const colors = new Float64Array(color.count * 4);
		const c = new THREE.Color();
		for (let i = 0; i < color.count; i++) {
			c.setRGB(color.getX(i), color.getY(i), color.getZ(i), THREE.LinearSRGBColorSpace);
			const s = srgb(c);
			colors[i * 4] = s[0]; colors[i * 4 + 1] = s[1]; colors[i * 4 + 2] = s[2];
			colors[i * 4 + 3] = color.itemSize > 3 ? color.getW(i) : 1;
		}
		const colorIndex = new Int32Array(triCount * 3);
		for (let k = 0; k < triCount * 3; k++) colorIndex[k] = vi(k);
		children.push(node('LayerElementColor', [P.I(0)], [
			node('Version', [P.I(101)]),
			node('Name', [P.S('Col')]),
			node('MappingInformationType', [P.S('ByPolygonVertex')]),
			node('ReferenceInformationType', [P.S('IndexToDirect')]),
			node('Colors', [P.di(colors)]),
			node('ColorIndex', [P.ii(colorIndex)])
		]));
		layer.push('LayerElementColor');
	}
	if (uv) {
		const uvs = new Float64Array(uv.count * 2);
		for (let i = 0; i < uv.count; i++) { uvs[i * 2] = uv.getX(i); uvs[i * 2 + 1] = uv.getY(i); }
		const uvIndex = new Int32Array(triCount * 3);
		for (let k = 0; k < triCount * 3; k++) uvIndex[k] = vi(k);
		children.push(node('LayerElementUV', [P.I(0)], [
			node('Version', [P.I(101)]),
			node('Name', [P.S('UVMap')]),
			node('MappingInformationType', [P.S('ByPolygonVertex')]),
			node('ReferenceInformationType', [P.S('IndexToDirect')]),
			node('UV', [P.di(uvs)]),
			node('UVIndex', [P.ii(uvIndex)])
		]));
		layer.push('LayerElementUV');
	}
	// Materials: one per geometry group (multi-material meshes), else AllSame.
	const groups = geometry.groups || [];
	if (groupMaterialIndex && groups.length > 0) {
		const mats = new Int32Array(triCount);
		for (const g of groups) {
			const from = Math.floor(g.start / 3);
			const to = Math.min(triCount, Math.floor((g.start + g.count) / 3));
			for (let t = from; t < to; t++) mats[t] = groupMaterialIndex(g.materialIndex || 0);
		}
		children.push(node('LayerElementMaterial', [P.I(0)], [
			node('Version', [P.I(101)]),
			node('Name', [P.S('')]),
			node('MappingInformationType', [P.S('ByPolygon')]),
			node('ReferenceInformationType', [P.S('IndexToDirect')]),
			node('Materials', [P.ii(mats)])
		]));
	} else {
		children.push(node('LayerElementMaterial', [P.I(0)], [
			node('Version', [P.I(101)]),
			node('Name', [P.S('')]),
			node('MappingInformationType', [P.S('AllSame')]),
			node('ReferenceInformationType', [P.S('IndexToDirect')]),
			node('Materials', [P.ii(new Int32Array([0]))])
		]));
	}
	layer.push('LayerElementMaterial');
	children.push(node('Layer', [P.I(0)], [
		node('Version', [P.I(100)]),
		...layer.map((type) => node('LayerElement', [], [node('Type', [P.S(type)]), node('TypedIndex', [P.I(0)])]))
	]));
	return node('Geometry', [P.L(id), P.S(fbxName(name, 'Geometry')), P.S('Mesh')], children);
}

function materialToFbx(id, material) {
	const color = material.color ? srgb(material.color) : [0.8, 0.8, 0.8];
	const emissive = material.emissive ? srgb(material.emissive) : [0, 0, 0];
	const opacity = material.transparent ? (material.opacity ?? 1) : 1;
	const shininess = material.shininess ?? (material.roughness != null ? Math.max(2, (1 - material.roughness) * 100) : 20);
	return node('Material', [P.L(id), P.S(fbxName(material.name || `Material${id}`, 'Material')), P.S('')], [
		node('Version', [P.I(102)]),
		node('ShadingModel', [P.S('phong')]),
		node('MultiLayer', [P.I(0)]),
		p70([
			pColor('DiffuseColor', color),
			pDouble('DiffuseFactor', 1),
			pColor('EmissiveColor', emissive),
			pDouble('EmissiveFactor', material.emissiveIntensity ?? 1),
			pColor('AmbientColor', [0, 0, 0]),
			pColor('SpecularColor', [0.2, 0.2, 0.2]),
			pDouble('Shininess', shininess),
			pDouble('ShininessExponent', shininess),
			pDouble('TransparencyFactor', 1 - opacity),
			pDouble('Opacity', opacity)
		])
	]);
}

/** Builds the FBX node tree for a THREE.Object3D hierarchy and serialises it. */
export function writeFBX(root, { creator = 'GS' } = {}) {
	let nextId = 1000000;
	const newId = () => nextId++;
	const objects = [];
	const connections = [];
	const counts = { Model: 0, Geometry: 0, Material: 0 };
	const geometryIds = new Map(); // BufferGeometry -> id
	const materialIds = new Map(); // Material -> id
	const euler = new THREE.Euler();
	const RAD2DEG = 180 / Math.PI;

	const getMaterialId = (mat) => {
		if (materialIds.has(mat)) return materialIds.get(mat);
		const id = newId();
		materialIds.set(mat, id);
		objects.push(materialToFbx(id, mat));
		counts.Material++;
		return id;
	};

	const modelNode = (id, name, type, position, quaternion, scale) => {
		// FBX's default rotation order eEulerXYZ is three's 'ZYX' order.
		euler.setFromQuaternion(quaternion, 'ZYX');
		counts.Model++;
		return node('Model', [P.L(id), P.S(fbxName(name, 'Model')), P.S(type)], [
			node('Version', [P.I(232)]),
			p70([
				pEnum('RotationOrder', 0),
				pVec('Lcl Translation', [position.x, position.y, position.z]),
				pVec('Lcl Rotation', [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG]),
				pVec('Lcl Scaling', [scale.x, scale.y, scale.z]),
				pInt('DefaultAttributeIndex', 0)
			]),
			node('Shading', [P.C(true)]),
			node('Culling', [P.S('CullingOff')])
		]);
	};

	const emitMesh = (obj, parentId, position, quaternion, scale, name) => {
		const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
		const usedMaterials = materials.filter(Boolean);
		const modelId = newId();
		const matIndex = new Map(); // three material index -> FBX slot
		usedMaterials.forEach((m, slot) => matIndex.set(materials.indexOf(m), slot));
		let geomId = geometryIds.get(obj.geometry);
		if (geomId === undefined) {
			geomId = newId();
			const multi = Array.isArray(obj.material) ? (i) => matIndex.get(i) ?? 0 : null;
			const g = geometryToFbx(geomId, obj.geometry, name, multi);
			if (!g) return null;
			objects.push(g);
			counts.Geometry++;
			// Shared geometries are only shared when the material layout matches.
			if (!Array.isArray(obj.material)) geometryIds.set(obj.geometry, geomId);
		}
		objects.push(modelNode(modelId, name, 'Mesh', position, quaternion, scale));
		connections.push(node('C', [P.S('OO'), P.L(modelId), P.L(parentId)]));
		connections.push(node('C', [P.S('OO'), P.L(geomId), P.L(modelId)]));
		const mats = usedMaterials.length ? usedMaterials : [new THREE.MeshStandardMaterial()];
		for (const m of mats) connections.push(node('C', [P.S('OO'), P.L(getMaterialId(m)), P.L(modelId)]));
		return modelId;
	};

	const hasMesh = (obj) => { let found = false; obj.traverse((o) => { if (o.isMesh) found = true; }); return found; };

	const visit = (obj, parentId) => {
		if (!hasMesh(obj)) return;
		const name = obj.name || (obj.isMesh ? 'Mesh' : 'Group');
		let id;
		if (obj.isInstancedMesh) {
			// One Null for the InstancedMesh, one Mesh model per instance.
			id = newId();
			objects.push(modelNode(id, name, 'Null', obj.position, obj.quaternion, obj.scale));
			connections.push(node('C', [P.S('OO'), P.L(id), P.L(parentId)]));
			const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
			for (let i = 0; i < obj.count; i++) {
				obj.getMatrixAt(i, m);
				m.decompose(p, q, s);
				emitMesh(obj, id, p, q, s, `${name}_${i}`);
			}
		} else if (obj.isMesh) {
			id = emitMesh(obj, parentId, obj.position, obj.quaternion, obj.scale, name);
			if (id == null) return;
		} else {
			id = newId();
			objects.push(modelNode(id, name, 'Null', obj.position, obj.quaternion, obj.scale));
			connections.push(node('C', [P.S('OO'), P.L(id), P.L(parentId)]));
		}
		for (const c of obj.children) visit(c, id);
	};
	for (const c of root.children) visit(c, 0);
	if (counts.Geometry === 0) throw new Error('Nothing to export yet. Add something to the scene first.');

	const now = new Date();
	const stamp = node('CreationTimeStamp', [], [
		node('Version', [P.I(1000)]),
		node('Year', [P.I(now.getFullYear())]), node('Month', [P.I(now.getMonth() + 1)]), node('Day', [P.I(now.getDate())]),
		node('Hour', [P.I(now.getHours())]), node('Minute', [P.I(now.getMinutes())]), node('Second', [P.I(now.getSeconds())]),
		node('Millisecond', [P.I(now.getMilliseconds())])
	]);
	const pad = (n) => String(n).padStart(2, '0');
	const fileId = new Uint8Array(16);
	(globalThis.crypto?.getRandomValues ? crypto.getRandomValues(fileId) : fileId.fill(7));

	const top = [
		node('FBXHeaderExtension', [], [
			node('FBXHeaderVersion', [P.I(1003)]),
			node('FBXVersion', [P.I(FBX_VERSION)]),
			node('EncryptionType', [P.I(0)]),
			stamp,
			node('Creator', [P.S(creator)])
		]),
		node('FileId', [P.R(fileId)]),
		node('CreationTime', [P.S(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}:000`)]),
		node('Creator', [P.S(creator)]),
		node('GlobalSettings', [], [
			node('Version', [P.I(1000)]),
			p70([
				// three.js: Y up, -Z forward, right-handed, metres.
				pInt('UpAxis', 1), pInt('UpAxisSign', 1),
				pInt('FrontAxis', 2), pInt('FrontAxisSign', 1),
				pInt('CoordAxis', 0), pInt('CoordAxisSign', 1),
				pInt('OriginalUpAxis', 1), pInt('OriginalUpAxisSign', 1),
				pDouble('UnitScaleFactor', 100), pDouble('OriginalUnitScaleFactor', 100),
				pColor('AmbientColor', [0, 0, 0]),
				pString('DefaultCamera', 'Producer Perspective'),
				pEnum('TimeMode', 11)
			])
		]),
		node('Documents', [], [
			node('Count', [P.I(1)]),
			node('Document', [P.L(newId()), P.S('Scene'), P.S('Scene')], [
				p70([]),
				node('RootNode', [P.L(0)])
			])
		]),
		node('References', []),
		node('Definitions', [], [
			node('Version', [P.I(100)]),
			node('Count', [P.I(1 + counts.Model + counts.Geometry + counts.Material)]),
			node('ObjectType', [P.S('GlobalSettings')], [node('Count', [P.I(1)])]),
			node('ObjectType', [P.S('Model')], [node('Count', [P.I(counts.Model)])]),
			node('ObjectType', [P.S('Geometry')], [node('Count', [P.I(counts.Geometry)])]),
			node('ObjectType', [P.S('Material')], [node('Count', [P.I(counts.Material)])])
		]),
		node('Objects', [], objects),
		node('Connections', [], connections),
		node('Takes', [], [node('Current', [P.S('')])])
	];

	const w = new ByteWriter();
	w.bytes(textEncoder.encode('Kaydara FBX Binary  '));
	w.bytes(new Uint8Array([0x00, 0x1a, 0x00]));
	w.u32(FBX_VERSION);
	for (const n of top) writeNode(w, n);
	w.bytes(new Uint8Array(13)); // end of top-level records
	// Footer (as written by the FBX SDK / Blender); FBXLoader relies on its size.
	w.bytes(new Uint8Array(FOOTER_ID));
	const ofs = w.len;
	let padLen = ((ofs + 15) & ~15) - ofs;
	if (padLen === 0) padLen = 16;
	w.bytes(new Uint8Array(padLen));
	w.u32(FBX_VERSION);
	w.bytes(new Uint8Array(120));
	w.bytes(new Uint8Array(FOOTER_MAGIC));
	return { bytes: w.result(), counts };
}

export async function exportFBX(roots) {
	const { group, meshCount } = buildExportGroup(roots);
	if (meshCount === 0) throw new Error('Nothing to export yet. Add something to the scene first.');
	group.updateMatrixWorld(true);
	const { bytes, counts } = writeFBX(group);
	return { blob: new Blob([bytes], { type: 'application/octet-stream' }), meshCount: counts.Geometry ? meshCount : 0 };
}

// ---------------------------------------------------------------------------
// UI: export dialog (desktop / phone) + direct download (VR)
// ---------------------------------------------------------------------------
export function safeFileName(name, fallback = 'GS scene') {
	const cleaned = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
	return cleaned || fallback;
}

function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const FORMAT_NOTES = {
	glb: 'GLB (binary glTF 2.0): meshes, materials, textures and any animation clips. Opens in Blender, Unity, Unreal, Windows 3D Viewer and most web viewers.',
	fbx: 'FBX (binary 7.4): meshes, transforms, normals, UVs, vertex colours and basic material colours. No textures, lights or animation. Code-driven motion (per-frame scripts) is not saved in either format.'
};

const DIALOG_CSS = `
#gs-model-export { display:none; position:fixed; inset:0; z-index:3200; background:rgba(0,0,0,0.55); align-items:center; justify-content:center; pointer-events:auto; }
#gs-model-export.visible { display:flex; }
#gs-model-export-inner { background:rgba(30,30,40,0.98); color:#fff; border-radius:16px; padding:22px; width:min(420px, 92vw); max-height:86vh; overflow:auto; box-sizing:border-box; box-shadow:0 8px 40px rgba(0,0,0,0.5); font:14px -apple-system,BlinkMacSystemFont,sans-serif; }
#gs-model-export-inner h3 { margin:0 0 12px; font-size:18px; }
#gs-model-export-inner label.gs-mx-label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:rgba(255,255,255,0.5); font-weight:700; margin:12px 0 6px; }
.gs-mx-formats { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.gs-mx-formats button, .gs-mx-buttons button { border:none; border-radius:10px; padding:11px 8px; font-weight:700; font-size:14px; color:#fff; background:#3a3c4e; cursor:pointer; }
.gs-mx-formats button.active { background:linear-gradient(135deg,#6366f1,#8b5cf6); box-shadow:0 0 0 1px rgba(255,255,255,0.25) inset; }
.gs-mx-name { display:flex; align-items:center; gap:6px; }
.gs-mx-name input { flex:1; min-width:0; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.08); color:#fff; font-size:14px; }
.gs-mx-ext { color:rgba(255,255,255,0.6); font-weight:600; }
.gs-mx-note { font-size:12px; line-height:1.45; color:rgba(255,255,255,0.6); margin-top:10px; }
.gs-mx-status { font-size:12px; margin-top:8px; min-height:1.2em; color:rgba(255,255,255,0.7); }
.gs-mx-status.error { color:#f87171; }
.gs-mx-buttons { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
.gs-mx-buttons .primary { background:linear-gradient(135deg,#10b981,#059669); }
`;

/**
 * @param {{
 *   getRoots: () => THREE.Object3D[],
 *   getSceneName: () => string,
 *   notify?: (text: string, kind?: string) => void,
 *   isImmersive?: () => boolean
 * }} opts
 */
export function initSceneExport(opts) {
	const { getRoots, getSceneName, notify = () => {}, isImmersive = () => false } = opts;
	let format = 'glb';
	let busy = false;
	let modal = null, nameInput, extEl, noteEl, statusEl, exportBtn;

	async function run(fmt, baseName) {
		if (busy) return null;
		busy = true;
		const ext = fmt === 'fbx' ? 'fbx' : 'glb';
		const filename = `${safeFileName(baseName || getSceneName())}.${ext}`;
		notify(`Exporting ${ext.toUpperCase()}…`, '');
		try {
			const roots = getRoots();
			const res = fmt === 'fbx' ? await exportFBX(roots) : await exportGLB(roots);
			downloadBlob(res.blob, filename);
			const kb = Math.max(1, Math.round(res.blob.size / 1024));
			const msg = `Saved ${filename} (${kb} KB, ${res.meshCount} mesh${res.meshCount === 1 ? '' : 'es'})`;
			notify(msg, 'connected');
			return { filename, blob: res.blob, message: msg };
		} catch (err) {
			console.warn('[gs] model export failed:', err);
			notify(`Export failed: ${err.message}`, 'error');
			throw err;
		} finally {
			busy = false;
		}
	}

	function ensureModal() {
		if (modal) return;
		const style = document.createElement('style');
		style.textContent = DIALOG_CSS;
		document.head.appendChild(style);
		modal = document.createElement('div');
		modal.id = 'gs-model-export';
		modal.setAttribute('aria-hidden', 'true');
		modal.innerHTML = `
			<div id="gs-model-export-inner" role="dialog" aria-labelledby="gs-mx-title">
				<h3 id="gs-mx-title">Export 3D model</h3>
				<label class="gs-mx-label">Format</label>
				<div class="gs-mx-formats" role="radiogroup" aria-label="Format">
					<button type="button" data-format="glb" role="radio">GLB</button>
					<button type="button" data-format="fbx" role="radio">FBX</button>
				</div>
				<label class="gs-mx-label" for="gs-mx-name">File name</label>
				<div class="gs-mx-name"><input type="text" id="gs-mx-name" autocomplete="off" /><span class="gs-mx-ext"></span></div>
				<div class="gs-mx-note"></div>
				<div class="gs-mx-status" role="status"></div>
				<div class="gs-mx-buttons">
					<button type="button" data-mx="cancel">Cancel</button>
					<button type="button" data-mx="export" class="primary">Export</button>
				</div>
			</div>`;
		document.body.appendChild(modal);
		nameInput = modal.querySelector('#gs-mx-name');
		extEl = modal.querySelector('.gs-mx-ext');
		noteEl = modal.querySelector('.gs-mx-note');
		statusEl = modal.querySelector('.gs-mx-status');
		exportBtn = modal.querySelector('[data-mx="export"]');
		modal.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => setFormat(b.dataset.format)));
		modal.querySelector('[data-mx="cancel"]').addEventListener('click', close);
		modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
		nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doExport(); });
		window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('visible')) close(); });
		exportBtn.addEventListener('click', doExport);
	}

	function setFormat(fmt) {
		format = fmt === 'fbx' ? 'fbx' : 'glb';
		modal.querySelectorAll('[data-format]').forEach((b) => {
			const on = b.dataset.format === format;
			b.classList.toggle('active', on);
			b.setAttribute('aria-checked', on ? 'true' : 'false');
		});
		extEl.textContent = `.${format}`;
		noteEl.textContent = FORMAT_NOTES[format];
	}

	async function doExport() {
		statusEl.className = 'gs-mx-status';
		statusEl.textContent = 'Exporting…';
		exportBtn.disabled = true;
		try {
			const res = await run(format, nameInput.value);
			if (res) { statusEl.textContent = res.message; setTimeout(close, 900); }
		} catch (err) {
			statusEl.className = 'gs-mx-status error';
			statusEl.textContent = err.message;
		} finally {
			exportBtn.disabled = false;
		}
	}

	function open(fmt = format) {
		// In a headset the DOM dialog is not visible: export straight away
		// with the scene name (Quest saves it to the browser's downloads).
		if (isImmersive()) return run(fmt).catch(() => null);
		ensureModal();
		setFormat(fmt);
		nameInput.value = safeFileName(getSceneName());
		statusEl.textContent = '';
		statusEl.className = 'gs-mx-status';
		modal.classList.add('visible');
		modal.setAttribute('aria-hidden', 'false');
		nameInput.focus({ preventScroll: true });
		nameInput.select();
		return Promise.resolve(null);
	}

	function close() {
		if (!modal) return;
		modal.classList.remove('visible');
		modal.setAttribute('aria-hidden', 'true');
	}

	return { open, close, exportNow: run, exportGLB: () => exportGLB(getRoots()), exportFBX: () => exportFBX(getRoots()) };
}
