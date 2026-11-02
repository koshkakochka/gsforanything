// Scene fit: HDRI / sky domes and render distance follow the whole scene.
//
// Scene code (usually AI-written) often builds its own sky: an inside-out
// sphere with an HDRI / 360 photo on it, or three.js's GroundedSkybox. Those
// are made at a fixed size (say 50 m), so a bigger scene pokes through the
// dome and gets cut off; the camera's far plane can clip it the same way.
//
// This is the runtime safety net (the chat prompt also tells the AI to do it):
// - content bounds: one bounding sphere over every visible user object (not
//   domes, lights, cameras, the app's own menus/rig, or anything with
//   userData.gsIgnoreBounds), from cached geometry bounds, so it is cheap.
// - domes grow to enclose it: radius = max(authored radius, (distance from
//   the dome centre to the content sphere + its radius) × DOME_MARGIN). They
//   only get bigger than authored, never smaller, and go back to the authored
//   size when the content shrinks. A GroundedSkybox keeps its floor height.
// - requiredFar(cameraPos): far distance that reaches all content and domes
//   from the camera (× FAR_MARGIN). main.js takes max(this, its own far).
// - linear scene.fog: fog.far is pushed out so the farthest content is at most
//   half fogged (an object past fog.far is drawn as pure fog colour, i.e. it
//   vanishes). Only ever raised above the scene's own fog.far. Opt out with
//   scene.userData.gsKeepFog = true. Textured domes stop taking fog.
//
// Dome detection: userData.gsHdriDome === true (what the prompt asks for), a
// GroundedSkybox, or a sphere / box mesh that is drawn inside-out (BackSide)
// or named like a sky ("sky", "dome", "hdri", "panorama", "360", ...) and is
// textured or at least MIN_AUTO_DOME_RADIUS big. userData.gsHdriDome = false
// opts a mesh out.
import * as THREE from 'three';

export const DOME_MARGIN = 1.5;
export const FAR_MARGIN = 1.05;
export const FOG_MARGIN = 2; // linear fog: farthest content at most 50% fogged
export const MIN_AUTO_DOME_RADIUS = 10;
export const MAX_FIT_DISTANCE = 1e6; // sanity cap (metres)
const DOME_NAME_RE = /sky|dome|hdri|hdr\b|panoram|360|equirect|environment|backdrop/i;
const DOME_GEOMETRY_RE = /Sphere|Icosahedron|Octahedron|Dodecahedron|Box/;

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _s = new THREE.Sphere();

function materials(o) { return Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []); }
function geometrySphere(g) {
	if (!g) return null;
	if (!g.boundingSphere) g.computeBoundingSphere();
	return g.boundingSphere && Number.isFinite(g.boundingSphere.radius) ? g.boundingSphere : null;
}

/** World-space bounding sphere of a dome mesh (centre + radius). */
export function domeWorldSphere(dome, target = new THREE.Sphere()) {
	const bs = geometrySphere(dome.geometry);
	if (!bs) return null;
	dome.updateWorldMatrix(true, false);
	target.center.copy(bs.center).applyMatrix4(dome.matrixWorld);
	target.radius = bs.radius * dome.matrixWorld.getMaxScaleOnAxis();
	return target;
}

export function isGroundedSkybox(o) {
	return !!o && !!o.isMesh && (o.isGroundedSkybox || o.constructor?.name === 'GroundedSkybox' || o.userData?.gsGroundedDome === true);
}

/** Is this mesh a sky / HDRI dome the fit should resize (and leave out of the content bounds)? */
export function isDomeObject(o) {
	if (!o || !o.isMesh) return false;
	const u = o.userData || {};
	if (u.gsHdriDome === false) return false;
	if (u.gsHdriDome === true || isGroundedSkybox(o)) return true;
	const g = o.geometry;
	if (!g || !DOME_GEOMETRY_RE.test(g.type || '')) return false;
	const mats = materials(o);
	const backSide = mats.some((m) => m && m.side === THREE.BackSide);
	const named = DOME_NAME_RE.test(o.name || '');
	if (!backSide && !named) return false;
	const textured = mats.some((m) => m && (m.map || m.envMap));
	if (named && textured) return true;
	const s = domeWorldSphere(o, _s);
	return !!s && s.radius >= MIN_AUTO_DOME_RADIUS && (textured || backSide || named);
}

function isLightOrHelper(o) {
	// GridHelper / PolarGridHelper are often used as a visible floor: they count.
	return !!(o.isLight || o.isCamera || (/Helper$/.test(o.type || '') && !/GridHelper$/.test(o.type || '')));
}

/** Expand `box` by one object's own geometry (not its children), world space. */
function expandByOwnGeometry(box, o) {
	if (o.isInstancedMesh) {
		if (!o.boundingBox) o.computeBoundingBox();
		if (o.boundingBox && !o.boundingBox.isEmpty()) box.union(_box.copy(o.boundingBox).applyMatrix4(o.matrixWorld));
		return true;
	}
	if (o.isSprite) {
		o.getWorldPosition(_v);
		const half = Math.max(Math.abs(o.matrixWorld.elements[0]), Math.abs(o.matrixWorld.elements[5])) * 0.75 + 1e-3;
		_c.setScalar(half);
		box.expandByPoint(_box.min.copy(_v).sub(_c)).expandByPoint(_box.max.copy(_v).add(_c));
		return true;
	}
	const g = o.geometry;
	if (!g || !(o.isMesh || o.isPoints || o.isLine)) return false;
	if (!g.boundingBox) g.computeBoundingBox();
	if (!g.boundingBox || g.boundingBox.isEmpty()) return false;
	_box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
	if (![_box.min.x, _box.min.y, _box.min.z, _box.max.x, _box.max.y, _box.max.z].every(Number.isFinite)) return false;
	box.union(_box);
	return true;
}

/**
 * Bounds of the scene content under `roots` (visible objects only), skipping
 * domes, lights/cameras/helpers, `exclude(obj)` and userData.gsIgnoreBounds.
 * Returns { box, sphere, count, domes } (domes found on the way).
 */
export function computeContentBounds(roots, { exclude = () => false } = {}) {
	const box = new THREE.Box3();
	const domes = [];
	let count = 0;
	const visit = (o) => {
		if (!o.visible || exclude(o) || o.userData?.gsIgnoreBounds) return;
		if (isDomeObject(o)) { domes.push(o); return; }
		if (!isLightOrHelper(o) && expandByOwnGeometry(box, o)) count++;
		for (const c of o.children) visit(c);
	};
	for (const r of roots) { if (r) { r.updateWorldMatrix(true, true); visit(r); } }
	const sphere = new THREE.Sphere();
	if (count) box.getBoundingSphere(sphere);
	else sphere.makeEmpty();
	if (sphere.radius > MAX_FIT_DISTANCE) sphere.radius = MAX_FIT_DISTANCE;
	return { box, sphere, count, domes };
}

/** Distance from `p` to the far side of sphere `s` (0 for an empty sphere). */
function reach(p, s) { return s && s.radius >= 0 && !s.isEmpty?.() ? p.distanceTo(s.center) + s.radius : 0; }

/**
 * Grow `dome` so it encloses `content` (a THREE.Sphere) with `margin`, never
 * smaller than its authored size. Returns the dome's world radius.
 */
export function fitDome(dome, content, { margin = DOME_MARGIN, viewer = null } = {}) {
	const u = dome.userData || (dome.userData = {});
	const bs = geometrySphere(dome.geometry);
	if (!bs || bs.radius <= 0) return 0;
	// Authored size: the scale it had when first seen, or after scene code changed it.
	if (!u.gsDomeFit || !dome.scale.equals(u.gsDomeFit.applied)) {
		const bb = dome.geometry.boundingBox || (dome.geometry.computeBoundingBox(), dome.geometry.boundingBox);
		u.gsDomeFit = {
			baseScale: dome.scale.clone(),
			applied: dome.scale.clone(),
			// GroundedSkybox: floor (geometry min y) stays where it was authored.
			floorY: dome.position.y + dome.scale.y * bb.min.y,
			minY: bb.min.y,
			basePos: dome.position.clone()
		};
	}
	const f = u.gsDomeFit;
	const grounded = isGroundedSkybox(dome);
	let worldR = 0;
	for (let i = 0; i < 3; i++) {
		const ws = domeWorldSphere(dome, _s);
		if (!ws) return 0;
		const curFactor = f.baseScale.x ? dome.scale.x / f.baseScale.x : 1;
		const authoredR = ws.radius / curFactor;
		let need = content && !content.isEmpty() ? ws.center.distanceTo(content.center) + content.radius : 0;
		// The viewer stays inside too (an orbit camera zoomed out past the content).
		if (viewer) need = Math.max(need, ws.center.distanceTo(viewer));
		need = Math.min(MAX_FIT_DISTANCE, need * margin);
		const targetR = Math.max(authoredR, need);
		const factor = targetR / authoredR;
		worldR = targetR;
		if (Math.abs(factor - curFactor) <= curFactor * 0.002) break;
		dome.scale.copy(f.baseScale).multiplyScalar(factor);
		if (grounded) dome.position.y = f.floorY - dome.scale.y * f.minY;
		dome.updateWorldMatrix(true, false);
	}
	f.applied.copy(dome.scale);
	return worldR;
}

/**
 * The fit for one scene. getRoots(): user content roots; exclude(obj): app
 * objects to skip; extraDomes(): app-owned domes (the VR colour skybox).
 */
export function createSceneFit({ scene, getRoots, exclude = () => false, extraDomes = () => [] }) {
	const state = {
		content: new THREE.Sphere().makeEmpty(),
		box: new THREE.Box3(),
		count: 0,
		domes: [],
		domeSpheres: [],
		fogBase: new WeakMap(),
		lastUpdate: -Infinity
	};
	/** Recompute bounds and fit domes / fog. `viewer`: camera world position (kept inside the domes). */
	function update(viewer = null) {
		const { box, sphere, count, domes } = computeContentBounds(getRoots(), { exclude });
		for (const d of extraDomes()) if (d && !domes.includes(d)) domes.push(d);
		state.content.copy(sphere); state.box.copy(box); state.count = count;
		state.domes = domes;
		state.domeSpheres = [];
		for (const d of domes) {
			fitDome(d, count ? sphere : null, { viewer });
			if (d.visible) { const s = domeWorldSphere(d); if (s) state.domeSpheres.push(s); }
			// A textured sky taking fog is just a wall of fog colour.
			for (const m of materials(d)) if (m && m.fog && m.map) { m.fog = false; m.needsUpdate = true; }
		}
		fitFog();
		return info();
	}
	function fitFog() {
		const fog = scene.fog;
		if (!fog || !fog.isFog || scene.userData?.gsKeepFog) return;
		// Remember the authored far (again whenever scene code changes it);
		// fogFarFor() pushes it out per frame from the camera.
		if (!state.fogBase.has(fog) || fog.far !== state.fogBase.get(fog).applied) state.fogBase.set(fog, { base: fog.far, applied: fog.far });
	}
	/** Called per frame (cheap) by main.js with the camera's world position. */
	function fogFarFor(cameraPos) {
		const fog = scene.fog;
		if (!fog || !fog.isFog || scene.userData?.gsKeepFog || !state.count) return;
		const rec = state.fogBase.get(fog);
		if (!rec) return;
		// The farthest object ends up at most half-way into the fog.
		const want = Math.min(MAX_FIT_DISTANCE, fog.near + Math.max(0, reach(cameraPos, state.content) - fog.near) * FOG_MARGIN);
		const far = Math.max(rec.base, want);
		if (far !== fog.far) rec.applied = fog.far = far;
	}
	/** Far plane distance that draws all content and every dome from `cameraPos`. */
	function requiredFar(cameraPos) {
		let d = state.count ? reach(cameraPos, state.content) : 0;
		for (const s of state.domeSpheres) d = Math.max(d, reach(cameraPos, s));
		return Math.min(MAX_FIT_DISTANCE, d * FAR_MARGIN);
	}
	function info() {
		return {
			count: state.count,
			center: state.count ? state.content.center.toArray() : null,
			radius: state.count ? state.content.radius : 0,
			box: state.count ? { min: state.box.min.toArray(), max: state.box.max.toArray() } : null,
			domes: state.domes.map((d) => ({ name: d.name || d.type, radius: domeWorldSphere(d)?.radius || 0, visible: d.visible }))
		};
	}
	function tick(now, viewer = null, intervalMs = 400) {
		if (now - state.lastUpdate < intervalMs) return false;
		state.lastUpdate = now;
		update(viewer);
		return true;
	}
	return { update, tick, requiredFar, fogFarFor, info, get contentSphere() { return state.content; } };
}
