// Camera modes registered by scene code (Controls tab → Camera).
//
// A scene that drives the camera itself (third-person follow camera, chase
// cam, top-down tracker, …) registers a mode; it gets its own button next to
// Orbit, Map, Fly, First person and Off, and the built-in modes stay one click
// away:
//
//   const tps = gsControls.registerCameraMode({
//     id: 'tps', label: 'Custom 3rd Person Controls',
//     description: 'Camera follows the player. WASD move, mouse aims.',
//     params: [ { name: 'forward', label: 'Move forward', type: 'key', default: 'W' }, … ],
//     activate(m) { … },        // camera handed to the scene (also on register)
//     update(dt, m) { … },      // every frame while active (after gs.onUpdate)
//     deactivate(m) { … }       // the user picked another mode: stop steering the camera
//   });
//   tps.isDown('forward'); tps.values; tps.active; tps.activate(); tps.sticks();
//
// - Registering activates the mode right away unless `active: false`.
// - Registering the same id again (hot reload) swaps the hooks, label and
//   params, and keeps whether it is active.
// - `params` become a Custom Controls card (customControls.js) whose values
//   the handle reads (values, get, set, isDown, keyName, onChange, onPress).
// - `sticks: true` shows the on-screen joysticks while active (phones);
//   read them with m.sticks() → { lx, ly, rx, ry }.
// - Leaving the mode calls deactivate, puts the camera back in the rig if
//   the scene re-parented it, and the built-in control takes over.
// - The mode is never saved as the camera preference: clearing / replacing
//   the scene removes its modes and returns to the saved built-in mode.
import { CUSTOM_CAMERA_MODE_PREFIX } from './cameraControls.js';

export const MAX_CUSTOM_CAMERA_MODES = 4;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const HOOKS = ['activate', 'deactivate', 'update', 'reset'];

/**
 * opts: {
 *   camera, canvas,
 *   getMode(), switchTo(modeKey) (main's setCameraControlMode, never persists a custom key),
 *   fallbackMode() → built-in mode to return to,
 *   customControls (createCustomControls instance, may be set later via setCustomControls),
 *   stickAxes() → { lx, ly, rx, ry },
 *   onChange() (list / labels changed: re-render the buttons)
 * }
 */
export function createCustomCameraModes(opts) {
	const modes = new Map(); // key ('custom:id') -> record
	let customControls = opts.customControls || null;
	let entered = null; // record whose activate ran and whose deactivate has not
	let saved = null;   // camera parent / up when the mode was entered

	const keyOf = (id) => CUSTOM_CAMERA_MODE_PREFIX + id;
	const call = (rec, name, ...args) => {
		const fn = rec.hooks[name];
		if (typeof fn !== 'function') return true;
		try { fn(...args, rec.handle); return true; }
		catch (e) { console.error(`camera mode "${rec.label}" ${name} failed:`, e); return false; }
	};

	function makeHandle(rec) {
		const scheme = () => rec.scheme;
		return {
			get id() { return rec.id; },
			get mode() { return rec.key; },
			get label() { return rec.label; },
			get active() { return opts.getMode() === rec.key && modes.get(rec.key) === rec; },
			get camera() { return opts.camera; },
			get canvas() { return opts.canvas; },
			get scheme() { return scheme(); },
			get values() { return scheme() ? scheme().values : {}; },
			get(name) { return scheme()?.get(name); },
			set(name, v) { return scheme() ? scheme().set(name, v) : false; },
			isDown(name) { return scheme() ? scheme().isDown(name) : false; },
			keyName(name) { return scheme() ? scheme().keyName(name) : ''; },
			onChange(fn) { return scheme() ? scheme().onChange(fn) : () => {}; },
			onPress(name, fn) { return scheme() ? scheme().onPress(name, fn) : () => {}; },
			/** On-screen joysticks (and nothing when they are hidden): { lx, ly, rx, ry }. */
			sticks() { return rec.sticks && this.active ? opts.stickAxes() : { lx: 0, ly: 0, rx: 0, ry: 0 }; },
			/** Switch the camera to this mode. */
			activate() { if (modes.get(rec.key) === rec) opts.switchTo(rec.key); return this.active; },
			/** Back to the saved built-in mode (only if this one is active). */
			deactivate() { if (this.active) opts.switchTo(opts.fallbackMode()); },
			remove() { remove(rec.id); }
		};
	}

	function register(def) {
		if (!def || typeof def !== 'object') throw new Error('registerCameraMode needs { id, label, activate?, update?, deactivate?, params? }');
		const id = String(def.id ?? '');
		if (!ID_RE.test(id)) throw new Error('registerCameraMode: id must be 1-40 letters, digits, "_" or "-"');
		const key = keyOf(id);
		const old = modes.get(key);
		if (!old && modes.size >= MAX_CUSTOM_CAMERA_MODES) throw new Error(`registerCameraMode: at most ${MAX_CUSTOM_CAMERA_MODES} custom camera modes`);
		for (const h of HOOKS) if (def[h] != null && typeof def[h] !== 'function') throw new Error(`registerCameraMode: ${h} must be a function`);
		const label = clip(def.label || def.name || id, 40) || id;
		const description = clip(def.description || '', 300);
		let schemeHandle = null;
		const schemeId = 'camera.' + id;
		if (Array.isArray(def.params) && def.params.length) {
			if (!customControls) throw new Error('registerCameraMode: custom controls are not ready');
			// Validates the params (throws before anything changes on bad input).
			schemeHandle = customControls.define({
				id: schemeId, name: label,
				description: description || `Settings for the ${label} camera mode.`,
				params: def.params
			}, { cameraModeId: id });
		} else if (old?.scheme) {
			customControls?.remove(schemeId);
		}
		const wasActive = !!old && opts.getMode() === key;
		const rec = old || { id, key };
		if (wasActive && entered === rec) leave(); // old hooks let go before the new ones take over
		rec.label = label;
		rec.description = description;
		rec.hooks = Object.fromEntries(HOOKS.map((h) => [h, def[h] || null]));
		rec.scheme = schemeHandle;
		rec.sticks = !!def.sticks;
		if (!old) { rec.handle = makeHandle(rec); modes.set(key, rec); }
		opts.onChange?.({ type: old ? 'update' : 'register', id, label });
		if (wasActive) enter(rec);
		else if (!old && def.active !== false) opts.switchTo(key);
		return rec.handle;
	}

	// ---- hand-over (called by main's setCameraControlMode) ----
	/** Before the camera mode changes away from `prevKey`. */
	function leave() {
		const rec = entered;
		if (!rec) return;
		entered = null;
		call(rec, 'deactivate');
		const cam = opts.camera;
		if (saved) {
			// The scene may have parented the camera to its player; put it back
			// in the rig (keeping where it is in the world).
			if (saved.parent && cam.parent !== saved.parent) saved.parent.attach(cam);
			cam.up.copy(saved.up);
			if (cam.isPerspectiveCamera && cam.fov !== saved.fov) { cam.fov = saved.fov; cam.updateProjectionMatrix(); }
		}
		saved = null;
	}
	/** After the camera mode became `key`; false when activate threw. */
	function enter(recOrKey) {
		const rec = typeof recOrKey === 'string' ? modes.get(recOrKey) : recOrKey;
		if (!rec) return false;
		const cam = opts.camera;
		saved = { parent: cam.parent, up: cam.up.clone(), fov: cam.fov };
		entered = rec;
		if (!call(rec, 'activate')) { entered = null; saved = null; return false; }
		return true;
	}
	function update(dt) {
		if (entered && opts.getMode() === entered.key) call(entered, 'update', dt);
	}
	/** Reset Camera View while a custom mode is active. */
	function resetView() { if (entered) call(entered, 'reset'); }

	function remove(id) {
		const key = keyOf(id);
		const rec = modes.get(key);
		if (!rec) return false;
		const active = opts.getMode() === key;
		if (active) opts.switchTo(opts.fallbackMode()); // runs leave() while the record still exists
		modes.delete(key);
		if (rec.scheme) customControls?.remove('camera.' + id);
		opts.onChange?.({ type: 'remove', id, label: rec.label });
		return true;
	}
	/** Scene cleared / replaced: its modes go, the camera returns to the saved built-in mode. */
	function reset() {
		if (!modes.size) return;
		if (modes.has(opts.getMode())) opts.switchTo(opts.fallbackMode());
		for (const rec of modes.values()) if (rec.scheme) customControls?.remove('camera.' + rec.id);
		modes.clear();
		entered = null; saved = null;
		opts.onChange?.({ type: 'reset' });
	}

	return {
		register,
		remove,
		reset,
		leave,
		enter,
		update,
		resetView,
		has: (key) => modes.has(key),
		get: (id) => modes.get(keyOf(id))?.handle || null,
		wantsSticks: (key) => !!modes.get(key)?.sticks,
		labelOf: (key) => modes.get(key)?.label || '',
		descriptionOf: (key) => modes.get(key)?.description || '',
		hasParams: (key) => !!modes.get(key)?.scheme,
		/** [{ id, mode, label, description, active, params }] in registration order. */
		list() {
			const cur = opts.getMode();
			return [...modes.values()].map((r) => ({ id: r.id, mode: r.key, label: r.label, description: r.description, active: cur === r.key, params: !!r.scheme, sticks: r.sticks }));
		},
		setCustomControls(cc) { customControls = cc; },
		get count() { return modes.size; }
	};
}
