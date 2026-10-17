/**
 * GS scene export + Share tab.
 *
 * Formats (all built in the browser, no server or native binary, so they
 * behave the same on the Cloudflare Worker, Vercel and locally):
 *   - GLB   binary glTF 2.0 (three's GLTFExporter), with lights.
 *   - glTF  .gltf JSON with buffers and images embedded as data: URIs, so it
 *           is one self-contained file that is still human-readable, with lights.
 *   - FBX   binary FBX 7.4 (writer in this file).
 *   - OBJ   .zip with .obj (three's OBJExporter, world transforms baked),
 *           a generated .mtl and the colour textures.
 *   - Blender .zip with the scene as .glb plus open_in_blender.py, which
 *           imports it and saves a .blend (there is no reliable JavaScript
 *           .blend writer; Blender's own glTF importer is the robust path).
 *
 * main.js only wires it up (initSceneExport, menu actions and a
 * shareCurrentScene callback that reuses the Community share flow); the
 * dialog, the Share tab content, object collection and the writers live here
 * so this module can be merged independently of other main.js work.
 *
 * What gets exported: the user's scene content (chat-generated objects and
 * active loaded scenes). main.js supplies getRoots(), which already skips the
 * app's own objects (UI panels, VR windows, HUD, reticles, camera rig and the
 * default light rig that existed at startup). Here we also skip cameras and
 * helpers that scene code may have added.
 *
 * Lights (glTF / GLB / Blender): Directional, Point and Spot lights that the
 * scene's code creates are written with KHR_lights_punctual (colour,
 * intensity, range from distance, spot cone from angle/penumbra; direction
 * from the light's target). Ambient and hemisphere lights have no glTF
 * equivalent and are left out. GS's default rig lights are not exported: they
 * are the editor's viewing light, the same for every scene, not part of what
 * the scene's code builds (importing them would double-light the model in
 * Blender/Unity, which add their own).
 *
 * FBX limits (stated in the UI too): meshes with transforms and hierarchy,
 * normals, one UV set, vertex colours and basic Phong material
 * colours/opacity. No textures, lights, cameras, skinning or animation; lines,
 * points and sprites are skipped. Skinned meshes are written in bind pose and
 * InstancedMesh instances as separate meshes.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';

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

const isPunctual = (o) => !!(o && (o.isDirectionalLight || o.isPointLight || o.isSpotLight));
const _lp = new THREE.Vector3(), _lt = new THREE.Vector3(), _pq = new THREE.Quaternion();
const _negZ = new THREE.Vector3(0, 0, -1);

/**
 * glTF lights shine down the node's -Z axis, while three aims Directional /
 * Spot lights at light.target (often a detached Object3D). Rotate the copy so
 * -Z points at the original target in world space, and give it a target at
 * (0,0,-1) parented to it (not added as a child, so no extra node is written).
 */
function aimLightCopy(orig, copy, parentWorldQuat) {
	if (!(orig.isDirectionalLight || orig.isSpotLight)) return;
	orig.getWorldPosition(_lp);
	const target = orig.target;
	if (target) {
		if (!target.parent) target.updateMatrixWorld(true);
		target.getWorldPosition(_lt);
	} else {
		_lt.set(0, 0, 0);
	}
	const dir = _lt.sub(_lp);
	if (dir.lengthSq() < 1e-12) dir.set(0, -1, 0);
	dir.normalize();
	const worldQ = new THREE.Quaternion().setFromUnitVectors(_negZ, dir);
	copy.quaternion.copy(_pq.copy(parentWorldQuat).invert().multiply(worldQ));
	const t = new THREE.Object3D();
	t.position.set(0, 0, -1);
	t.parent = copy;
	copy.target = t;
}

/**
 * Clones the roots into a temporary export group so filtering (cameras,
 * helpers, invisible objects, lights) never touches the live scene.
 * lights: true keeps Directional / Point / Spot lights (aimed for glTF),
 * false drops every light.
 */
function buildExportGroup(roots, { lights = false } = {}) {
	const group = new THREE.Group();
	group.name = 'GS Scene';
	const animations = [];
	const seenClips = new Set();
	const stats = { lights: 0, skippedLights: 0 };
	const keep = (o) => isExportableNode(o) && o.visible !== false && (!o.isLight || (lights && isPunctual(o)));
	// Walk original and clone together (clone keeps child order) so lights can
	// be aimed from the original's world-space target before pruning.
	const walk = (orig, copy, parentWorldQuat) => {
		if (copy.isLight) {
			if (keep(orig)) { aimLightCopy(orig, copy, parentWorldQuat); stats.lights++; }
			else if (lights) stats.skippedLights++;
		}
		const worldQ = new THREE.Quaternion();
		orig.getWorldQuaternion(worldQ);
		const pairs = orig.children.map((c, i) => [c, copy.children[i]]);
		for (const [oc, cc] of pairs) {
			if (!cc) continue;
			if (!keep(oc)) {
				if (oc.isLight && lights && !isPunctual(oc) && oc.visible !== false) stats.skippedLights++;
				copy.remove(cc);
				continue;
			}
			walk(oc, cc, worldQ);
		}
	};
	const identity = new THREE.Quaternion();
	for (const root of roots) {
		if (!keep(root)) {
			if (root && root.isLight && lights && root.visible !== false && !isPunctual(root)) stats.skippedLights++;
			continue;
		}
		root.updateWorldMatrix(true, true);
		// Keep the root's world transform (some content lives under the AR
		// placement group), so the file matches what you see.
		const copy = root.clone(true);
		root.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
		walk(root, copy, identity);
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
	return { group, animations, meshCount, ...stats };
}

const NOTHING = 'Nothing to export yet. Add something to the scene first.';

// ---------------------------------------------------------------------------
// glTF / GLB
// ---------------------------------------------------------------------------
/**
 * binary:true → GLB. binary:false → .gltf JSON; GLTFExporter then embeds
 * buffers and images as base64 data: URIs (embedImages defaults to true), so
 * the result is a single self-contained file rather than .gltf + .bin +
 * textures that would have to be zipped and kept together.
 */
export async function exportGLTF(roots, { binary = true } = {}) {
	const { group, animations, meshCount, lights, skippedLights } = buildExportGroup(roots, { lights: true });
	if (meshCount === 0 && lights === 0) throw new Error(NOTHING);
	const exporter = new GLTFExporter();
	const result = await exporter.parseAsync(group, {
		binary,
		onlyVisible: true,
		animations,
		embedImages: true,
		maxTextureSize: 4096
	});
	const blob = binary
		? new Blob([result], { type: 'model/gltf-binary' })
		: new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });
	return { blob, meshCount, lightCount: lights, skippedLights, animationCount: animations.length };
}

export const exportGLB = (roots) => exportGLTF(roots, { binary: true });
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
	if (meshCount === 0) throw new Error(NOTHING);
	group.updateMatrixWorld(true);
	const { bytes, counts } = writeFBX(group);
	return { blob: new Blob([bytes], { type: 'application/octet-stream' }), meshCount: counts.Geometry ? meshCount : 0 };
}

// ---------------------------------------------------------------------------
// OBJ + MTL (+ textures) in a .zip
// ---------------------------------------------------------------------------
const mtlSafe = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
const fmt3 = (c) => `${c.r.toFixed(6)} ${c.g.toFixed(6)} ${c.b.toFixed(6)}`;

/**
 * Flattens the export group into plain single-material meshes in world space
 * (instances expanded, multi-material groups split), which is what OBJ can
 * describe. Every material gets a unique MTL-safe name for usemtl.
 */
function flattenForObj(group) {
	group.updateMatrixWorld(true);
	const out = new THREE.Group();
	const matNames = new Map();
	const used = new Set();
	const nameFor = (mat) => {
		if (matNames.has(mat)) return matNames.get(mat);
		let base = mtlSafe(mat.name) || `material_${matNames.size + 1}`;
		let n = base, i = 2;
		while (used.has(n)) n = `${base}_${i++}`;
		used.add(n);
		matNames.set(mat, n);
		return n;
	};
	const proxyFor = (mat) => {
		// OBJExporter reads material.name; use a lightweight proxy so the live
		// material's name is never changed.
		const proxy = { name: nameFor(mat), source: mat };
		return proxy;
	};
	const add = (geometry, material, matrix, name) => {
		const m = new THREE.Mesh(geometry, material ? proxyFor(material) : undefined);
		m.name = mtlSafe(name) || 'mesh';
		m.matrixAutoUpdate = false;
		m.matrix.copy(matrix);
		m.matrixWorld.copy(matrix);
		out.add(m);
	};
	const inst = new THREE.Matrix4(), world = new THREE.Matrix4();
	group.traverse((o) => {
		if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
		const mats = Array.isArray(o.material) ? o.material : [o.material];
		const pieces = [];
		const g = o.geometry;
		if (Array.isArray(o.material) && g.groups.length) {
			// One piece per material group (index range), so usemtl is right.
			for (const grp of g.groups) {
				const mat = mats[grp.materialIndex];
				if (!mat) continue;
				const part = g.clone();
				part.clearGroups();
				part.setDrawRange(0, Infinity);
				if (g.index) {
					const idx = g.index.array.slice(grp.start, grp.start + grp.count);
					part.setIndex(new THREE.BufferAttribute(idx, 1));
				} else {
					for (const key of Object.keys(part.attributes)) {
						const a = g.attributes[key];
						part.setAttribute(key, new THREE.BufferAttribute(a.array.slice(grp.start * a.itemSize, (grp.start + grp.count) * a.itemSize), a.itemSize, a.normalized));
					}
				}
				pieces.push([part, mat]);
			}
		} else {
			pieces.push([g, mats[0]]);
		}
		const count = o.isInstancedMesh ? o.count : 1;
		for (let i = 0; i < count; i++) {
			if (o.isInstancedMesh) { o.getMatrixAt(i, inst); world.multiplyMatrices(o.matrixWorld, inst); }
			else world.copy(o.matrixWorld);
			pieces.forEach(([geo, mat], k) => add(geo, mat, world, `${o.name || 'mesh'}${count > 1 ? `_${i}` : ''}${pieces.length > 1 ? `_${k}` : ''}`));
		}
	});
	return { out, matNames };
}

/** Draws a texture's image to PNG bytes (null if not drawable / tainted). */
async function textureToPng(tex) {
	const img = tex && tex.image;
	if (!img) return null;
	const w = img.width || img.videoWidth, h = img.height || img.videoHeight;
	if (!w || !h) return null;
	const canvas = document.createElement('canvas');
	canvas.width = w; canvas.height = h;
	const ctx = canvas.getContext('2d');
	try {
		if (img.data && !(img instanceof HTMLElement)) {
			const d = img.data;
			if (!(d instanceof Uint8Array || d instanceof Uint8ClampedArray) || d.length !== w * h * 4) return null;
			ctx.putImageData(new ImageData(new Uint8ClampedArray(d), w, h), 0, 0);
			// DataTexture rows start at the bottom; OBJ/MTL images are top-down.
			if (!tex.flipY) {
				const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
				const x2 = c2.getContext('2d'); x2.translate(0, h); x2.scale(1, -1); x2.drawImage(canvas, 0, 0);
				return await canvasPng(c2);
			}
		} else {
			if (tex.flipY === false) { ctx.translate(0, h); ctx.scale(1, -1); }
			ctx.drawImage(img, 0, 0, w, h);
		}
		return await canvasPng(canvas);
	} catch (err) {
		console.warn('[gs] OBJ export: texture could not be read (cross-origin?)', err);
		return null;
	}
}
function canvasPng(canvas) {
	return new Promise((resolve) => {
		try {
			canvas.toBlob(async (b) => resolve(b ? new Uint8Array(await b.arrayBuffer()) : null), 'image/png');
		} catch (err) {
			console.warn('[gs] OBJ export: texture could not be read (cross-origin?)', err);
			resolve(null);
		}
	});
}

function materialToMtl(name, mat, texFile) {
	const c = new THREE.Color(1, 1, 1);
	if (mat.color) c.copy(mat.color);
	THREE.ColorManagement.workingToColorSpace(c, THREE.SRGBColorSpace);
	const ks = new THREE.Color(0, 0, 0);
	let ns = 10;
	if (mat.specular) { ks.copy(mat.specular); THREE.ColorManagement.workingToColorSpace(ks, THREE.SRGBColorSpace); ns = mat.shininess ?? 30; }
	else if (mat.roughness !== undefined) { const s = 0.5 * (1 - mat.roughness); ks.setRGB(s, s, s); ns = Math.round(2 + (1 - mat.roughness) ** 2 * 400); }
	const lines = [
		`newmtl ${name}`,
		`Ka 0.000000 0.000000 0.000000`,
		`Kd ${fmt3(c)}`,
		`Ks ${fmt3(ks)}`,
		`Ns ${Number(ns).toFixed(1)}`
	];
	if (mat.emissive && (mat.emissive.r || mat.emissive.g || mat.emissive.b)) {
		const e = mat.emissive.clone().multiplyScalar(mat.emissiveIntensity ?? 1);
		THREE.ColorManagement.workingToColorSpace(e, THREE.SRGBColorSpace);
		lines.push(`Ke ${fmt3(e)}`);
	}
	const opacity = mat.transparent || mat.opacity < 1 ? mat.opacity : 1;
	lines.push(`d ${Number(opacity).toFixed(4)}`);
	lines.push(`illum 2`);
	if (texFile) lines.push(`map_Kd ${texFile}`);
	return lines.join('\n');
}

export async function exportOBJ(roots, baseName = 'scene') {
	const { group, meshCount } = buildExportGroup(roots);
	if (meshCount === 0) throw new Error(NOTHING);
	const { out, matNames } = flattenForObj(group);
	const base = mtlSafe(baseName) || 'scene';
	const files = {};
	const mtl = [`# GS scene materials (${matNames.size})`];
	const texFiles = new Map();
	let textureCount = 0;
	for (const [mat, name] of matNames) {
		let texFile = null;
		const map = mat.map;
		if (map && map.isTexture) {
			if (texFiles.has(map)) texFile = texFiles.get(map);
			else {
				const png = await textureToPng(map);
				if (png) {
					texFile = `textures/${name}.png`;
					files[texFile] = [png, { level: 0 }];
					textureCount++;
				}
				texFiles.set(map, texFile);
			}
		}
		mtl.push('', materialToMtl(name, mat, texFile));
	}
	const objText = `# GS scene, world transforms baked (Y-up, metres)\nmtllib ${base}.mtl\n` + new OBJExporter().parse(out);
	files[`${base}.obj`] = strToU8(objText);
	files[`${base}.mtl`] = strToU8(mtl.join('\n') + '\n');
	const zipped = zipSync(files, { level: 6 });
	return { blob: new Blob([zipped], { type: 'application/zip' }), meshCount: out.children.length, materialCount: matNames.size, textureCount };
}

// ---------------------------------------------------------------------------
// Blender: .glb + open_in_blender.py in a .zip
// ---------------------------------------------------------------------------
export function blenderScript(glbName) {
	return `"""Open a GS scene in Blender and save it as a .blend.

Headless:   blender -b -P open_in_blender.py -- ${glbName} ${glbName.replace(/\.glb$/i, '.blend')}
In Blender: Scripting workspace > Open > open_in_blender.py > Run Script
            (uses the .glb next to this script and saves the .blend beside it)

Works with Blender 3.6 and 4.x (uses the built-in glTF importer).
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
DEFAULT_GLB = ${JSON.stringify(glbName)}


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    src = os.path.abspath(args[0]) if args else os.path.join(HERE, DEFAULT_GLB)
    dst = os.path.abspath(args[1]) if len(args) > 1 else os.path.splitext(src)[0] + ".blend"
    if not os.path.isfile(src):
        raise SystemExit("GS: scene file not found: " + src)

    # Start from an empty scene (no default cube, camera or light).
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # three.js light intensities look right in Blender with the importer's
    # "non-physical" lighting conversion (the default physical conversion makes
    # a three.js sun of intensity 2 almost black). Older Blender: no option.
    try:
        bpy.ops.import_scene.gltf(filepath=src, export_import_convert_lighting_mode="COMPAT")
    except TypeError:
        bpy.ops.import_scene.gltf(filepath=src)

    # Keep textures inside the .blend so it can be moved on its own.
    try:
        bpy.ops.file.pack_all()
    except Exception as exc:  # nothing to pack
        print("GS: pack_all skipped:", exc)

    bpy.ops.wm.save_as_mainfile(filepath=dst)
    meshes = sum(1 for o in bpy.data.objects if o.type == "MESH")
    lights = sum(1 for o in bpy.data.objects if o.type == "LIGHT")
    print("GS: saved %s (%d meshes, %d lights)" % (dst, meshes, lights))


main()
`;
}

export async function exportBlenderZip(roots, baseName = 'scene') {
	const res = await exportGLTF(roots, { binary: true });
	const base = mtlSafe(baseName) || 'scene';
	const glbName = `${base}.glb`;
	const readme = [
		'GS scene for Blender',
		'',
		`${glbName}            the scene (glTF binary: meshes, materials, textures, lights, animation)`,
		'open_in_blender.py    imports it and saves a .blend',
		'',
		'Headless:',
		`  blender -b -P open_in_blender.py -- ${glbName} ${base}.blend`,
		'',
		'Or in Blender: File > Import > glTF 2.0 and pick the .glb, or run',
		'open_in_blender.py from the Scripting workspace.',
		''
	].join('\n');
	const files = {
		[glbName]: [new Uint8Array(await res.blob.arrayBuffer()), { level: 0 }],
		'open_in_blender.py': strToU8(blenderScript(glbName)),
		'README.txt': strToU8(readme)
	};
	return { ...res, blob: new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }) };
}

// ---------------------------------------------------------------------------
// UI: export dialog (desktop / phone), Share tab, direct download (VR)
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

export const EXPORT_FORMATS = [
	{ id: 'glb', label: 'GLB', ext: 'glb', blurb: 'Binary glTF with lights',
		note: 'GLB (binary glTF 2.0): meshes, materials, textures, animation clips and the scene\'s directional, point and spot lights. Opens in Blender, Unity, Unreal, Windows 3D Viewer and most web viewers.' },
	{ id: 'gltf', label: 'glTF', ext: 'gltf', blurb: 'Readable JSON, one file, with lights',
		note: 'glTF 2.0 JSON with buffers and textures embedded, so it is one self-contained file you can open in a text editor. Same content as GLB, including lights (KHR_lights_punctual). Ambient and hemisphere lights have no glTF equivalent and are left out.' },
	{ id: 'fbx', label: 'FBX', ext: 'fbx', blurb: 'Meshes + colours for DCC tools',
		note: 'FBX (binary 7.4): meshes, transforms, normals, UVs, vertex colours and basic material colours. No textures, lights or animation.' },
	{ id: 'obj', label: 'OBJ', ext: 'zip', blurb: '.obj + .mtl + textures (.zip)',
		note: 'OBJ is geometry only: no lights, no animation, and basic MTL materials (colour, specular, opacity, colour texture). World transforms are baked into the vertices. Downloads a .zip with the .obj, .mtl and textures.' },
	{ id: 'blender', label: 'Blender', ext: 'zip', blurb: '.glb + script that saves a .blend',
		note: 'A .zip with the scene as .glb and open_in_blender.py. Run: blender -b -P open_in_blender.py -- scene.glb scene.blend (or run the script from Blender\'s Scripting tab) to get a .blend with materials, textures and lights.' }
];
const FORMAT_BY_ID = Object.fromEntries(EXPORT_FORMATS.map((f) => [f.id, f]));
const MOTION_NOTE = ' Code-driven motion (per-frame scripts) is not saved in any format.';

const DIALOG_CSS = `
#gs-model-export { display:none; position:fixed; inset:0; z-index:3200; background:rgba(0,0,0,0.55); align-items:center; justify-content:center; pointer-events:auto; }
#gs-model-export.visible { display:flex; }
#gs-model-export-inner { background:rgba(30,30,40,0.98); color:#fff; border-radius:16px; padding:22px; width:min(440px, 92vw); max-height:86vh; overflow:auto; box-sizing:border-box; box-shadow:0 8px 40px rgba(0,0,0,0.5); font:14px -apple-system,BlinkMacSystemFont,sans-serif; }
#gs-model-export-inner h3 { margin:0 0 12px; font-size:18px; }
#gs-model-export-inner label.gs-mx-label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:rgba(255,255,255,0.5); font-weight:700; margin:12px 0 6px; }
.gs-mx-formats { display:grid; grid-template-columns:repeat(5, 1fr); gap:6px; }
.gs-mx-formats button, .gs-mx-buttons button { border:none; border-radius:10px; padding:11px 4px; font-weight:700; font-size:13px; color:#fff; background:#3a3c4e; cursor:pointer; }
.gs-mx-formats button.active { background:linear-gradient(135deg,#6366f1,#8b5cf6); box-shadow:0 0 0 1px rgba(255,255,255,0.25) inset; }
.gs-mx-name { display:flex; align-items:center; gap:6px; }
.gs-mx-name input { flex:1; min-width:0; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.08); color:#fff; font-size:14px; }
.gs-mx-ext { color:rgba(255,255,255,0.6); font-weight:600; }
.gs-mx-note { font-size:12px; line-height:1.45; color:rgba(255,255,255,0.6); margin-top:10px; }
.gs-mx-status { font-size:12px; margin-top:8px; min-height:1.2em; color:rgba(255,255,255,0.7); }
.gs-mx-status.error { color:#f87171; }
.gs-mx-buttons { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
.gs-mx-buttons .primary { background:linear-gradient(135deg,#10b981,#059669); }
@media (max-width:380px) { .gs-mx-formats { grid-template-columns:repeat(3, 1fr); } }
/* Share tab (desktop chat dock) */
.gs-share { display:flex; flex-direction:column; gap:14px; padding:4px 2px 8px; color:#fff; }
.gs-share-section h4 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:rgba(255,255,255,0.55); font-weight:700; }
.gs-share-hint { font-size:12px; line-height:1.45; color:rgba(255,255,255,0.6); margin:6px 0 0; }
.gs-share-link-btn { width:100%; border:none; border-radius:10px; padding:11px 10px; font-weight:700; font-size:14px; color:#fff; background:linear-gradient(135deg,#6366f1,#8b5cf6); cursor:pointer; }
.gs-share-formats { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
.gs-share-format { display:flex; flex-direction:column; align-items:flex-start; gap:2px; text-align:left; border:1px solid rgba(255,255,255,0.1); border-radius:10px; padding:10px 12px; background:rgba(255,255,255,0.06); color:#fff; cursor:pointer; font:inherit; }
.gs-share-format:hover { background:rgba(255,255,255,0.12); }
.gs-share-format b { font-size:14px; }
.gs-share-format span { font-size:11px; color:rgba(255,255,255,0.6); line-height:1.3; }
.gs-share-obj-note { font-size:11px; line-height:1.4; color:#fbbf24; margin:8px 0 0; }
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
	let cssAdded = false;
	const addCss = () => {
		if (cssAdded) return;
		cssAdded = true;
		const style = document.createElement('style');
		style.textContent = DIALOG_CSS;
		document.head.appendChild(style);
	};

	async function run(fmt, baseName) {
		if (busy) return null;
		const f = FORMAT_BY_ID[fmt] || FORMAT_BY_ID.glb;
		busy = true;
		const base = safeFileName(baseName || getSceneName());
		const filename = `${base}${f.id === 'blender' ? ' (Blender)' : f.id === 'obj' ? ' (OBJ)' : ''}.${f.ext}`;
		notify(`Exporting ${f.label}…`, '');
		try {
			const roots = getRoots();
			const res = f.id === 'fbx' ? await exportFBX(roots)
				: f.id === 'obj' ? await exportOBJ(roots, base)
				: f.id === 'blender' ? await exportBlenderZip(roots, base)
				: await exportGLTF(roots, { binary: f.id === 'glb' });
			downloadBlob(res.blob, filename);
			const kb = Math.max(1, Math.round(res.blob.size / 1024));
			const parts = [`${res.meshCount} mesh${res.meshCount === 1 ? '' : 'es'}`];
			if (res.lightCount) parts.push(`${res.lightCount} light${res.lightCount === 1 ? '' : 's'}`);
			let msg = `Saved ${filename} (${kb} KB, ${parts.join(', ')})`;
			if (res.skippedLights) msg += ` · ${res.skippedLights} ambient/hemisphere light${res.skippedLights === 1 ? '' : 's'} not supported`;
			notify(msg, 'connected');
			return { filename, blob: res.blob, message: msg, result: res };
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
		addCss();
		modal = document.createElement('div');
		modal.id = 'gs-model-export';
		modal.setAttribute('aria-hidden', 'true');
		modal.innerHTML = `
			<div id="gs-model-export-inner" role="dialog" aria-labelledby="gs-mx-title">
				<h3 id="gs-mx-title">Export 3D model</h3>
				<label class="gs-mx-label">Format</label>
				<div class="gs-mx-formats" role="radiogroup" aria-label="Format">
					${EXPORT_FORMATS.map((f) => `<button type="button" data-format="${f.id}" role="radio">${f.label}</button>`).join('')}
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
		format = FORMAT_BY_ID[fmt] ? fmt : 'glb';
		const f = FORMAT_BY_ID[format];
		modal.querySelectorAll('[data-format]').forEach((b) => {
			const on = b.dataset.format === format;
			b.classList.toggle('active', on);
			b.setAttribute('aria-checked', on ? 'true' : 'false');
		});
		extEl.textContent = `.${f.ext}`;
		noteEl.textContent = f.note + (f.id === 'glb' || f.id === 'gltf' || f.id === 'blender' ? MOTION_NOTE : '');
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

	/**
	 * Fills the desktop Share tab: the scene link (main.js passes
	 * shareCurrentScene, which reuses the Community share flow) and the five
	 * export formats, each opening the export dialog preselected.
	 */
	function mountShareTab(container, { onShareLink } = {}) {
		if (!container || container.dataset.gsShareMounted) return;
		container.dataset.gsShareMounted = '1';
		addCss();
		container.innerHTML = `
			<div class="gs-share">
				<div class="gs-share-section">
					<h4>Link</h4>
					<button type="button" class="gs-share-link-btn" data-share="link">🔗 Share link to this scene</button>
					<p class="gs-share-hint">Same link as Community → Share. A scene that isn't in Community yet is uploaded there first (public, like Upload Current Scene).</p>
				</div>
				<div class="gs-share-section">
					<h4>Export 3D model</h4>
					<div class="gs-share-formats">
						${EXPORT_FORMATS.map((f) => `<button type="button" class="gs-share-format" data-share-format="${f.id}"><b>${f.label}</b><span>${f.blurb}</span></button>`).join('')}
					</div>
					<p class="gs-share-obj-note">OBJ is geometry only: no lights, no animation, basic MTL materials.</p>
					<p class="gs-share-hint">Lights: directional, point and spot lights from the scene's code are included in GLB, glTF and Blender (not ambient/hemisphere, and not GS's default lighting). Code-driven motion is not saved.</p>
				</div>
			</div>`;
		container.querySelector('[data-share="link"]').addEventListener('click', () => { if (onShareLink) onShareLink(); });
		container.querySelectorAll('[data-share-format]').forEach((b) => b.addEventListener('click', () => open(b.dataset.shareFormat)));
	}

	return {
		open, close, mountShareTab, exportNow: run, formats: EXPORT_FORMATS,
		exportGLB: () => exportGLTF(getRoots(), { binary: true }),
		exportGLTF: () => exportGLTF(getRoots(), { binary: false }),
		exportFBX: () => exportFBX(getRoots()),
		exportOBJ: (name) => exportOBJ(getRoots(), name),
		exportBlenderZip: (name) => exportBlenderZip(getRoots(), name)
	};
}
