// Desktop / phone camera controls: the stock three.js r180 addons from
// vendor_modules/three/examples/jsm/controls, one at a time, with standard
// settings. GS adds no camera maths of its own here. It only:
//   - creates / disposes the chosen control and keeps it disabled while you
//     type into a text field or while WebXR / Cardboard drives the camera,
//   - runs First person's WASD the way the official
//     misc_controls_pointerlock example does,
//   - applies the key remapping from controlBindings.js (Controls tab): a
//     pressed key is looked up in the active style's bindings and handed to
//     the stock control as the stock key it stands for,
//   - forwards game-controller and on-screen stick values to each control's
//     own movement / rotation API (see stick()).
// Modes: map (MapControls, default), orbit (OrbitControls), fly (FlyControls),
// firstperson (PointerLockControls), off.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { FlyControls } from 'three/examples/jsm/controls/FlyControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { actionForCode } from './controlBindings.js';

export const DEFAULT_CAMERA_MODE = 'map';
export const CAMERA_MODES = ['orbit', 'map', 'fly', 'firstperson', 'off'];
export const CAMERA_MODE_LABELS = { orbit: 'Orbit', map: 'Map', fly: 'Fly', firstperson: 'First person', off: 'Off' };
// Values saved by GS 0.976 and earlier (Orbit / Free-roam / Off), plus
// Trackball which was later removed (falls back to the Map default).
const LEGACY_MODES = { free: 'firstperson', 'free-roam': 'firstperson', trackball: 'map' };
export function normalizeCameraMode(saved) {
	if (CAMERA_MODES.includes(saved)) return saved;
	return LEGACY_MODES[saved] || DEFAULT_CAMERA_MODE;
}

// Default desktop view: 4 m back from the scene origin at eye height.
export const DEFAULT_CAMERA_POSITION = Object.freeze(new THREE.Vector3(0, 1.6, 4));
// First person eye height (Controls tab → First person → Player height).
export const PLAYER_HEIGHT_DEFAULT = 1.6;
export const PLAYER_HEIGHT_MIN = 0.3;
export const PLAYER_HEIGHT_MAX = 5;
export const PLAYER_HEIGHT_STEP = 0.1;
export function clampPlayerHeight(h) {
	const n = Number(h);
	if (!Number.isFinite(n)) return null;
	return Math.round(Math.min(PLAYER_HEIGHT_MAX, Math.max(PLAYER_HEIGHT_MIN, n)) * 100) / 100;
}
export const ORBIT_TARGET = Object.freeze(new THREE.Vector3(0, 0, 0));
const TARGET_MODES = new Set(['orbit', 'map']);
// Modes whose stick input is forwarded (on-screen joysticks are shown for these).
export const STICK_MODES = new Set(['fly', 'firstperson']);
const GAMEPAD_MODES = new Set(['orbit', 'map', 'fly', 'firstperson']);

// First person, as in the official pointerlock example (velocity damped by
// 10/s, accelerated toward the pressed direction); scaled to metres so the
// top speed is about 3 m/s (the example's 400 suits its 1 unit = 1 cm world).
const FP_DAMPING = 10;
const FP_ACCEL = 30;
const STICK_MOVE_SPEED = 3;      // m/s at full deflection (First person, Fly)
const STICK_LOOK_SPEED = 2.4;    // rad/s at full deflection
const STICK_ZOOM_SPEED = 1.5;    // Orbit / Map dolly factor per second (triggers); OrbitControls' _dollyIn/_dollyOut take a scale < 1 like its wheel zoom
const POINTERLOCK_MOUSE_SENSITIVITY = 0.002; // PointerLockControls' own constant
// Fly drag-to-look: radians per dragged pixel. Stock FlyControls turns at a rate
// set by how far the pointer sits from the canvas centre, so a normal drag near
// the centre (or a quick one) barely turned the view; here the view follows the
// drag, like PointerLockControls' mouse look.
const FLY_DRAG_SENSITIVITY = 0.004;

// Text-entry fields keep their keys: the controls are disabled while one has
// focus. Buttons, checkboxes, radios, sliders and panels do not block keys.
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
export function isTextEntry(el) {
	if (!el || el === document.body) return false;
	if (el.isContentEditable) return true;
	const tag = el.tagName;
	if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
	if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
	return false;
}

export function createCameraControls({ camera, domElement, isSuspended = () => false, onModeChange = () => {}, onLockChange = () => {} }) {
	let mode = 'off';
	let controls = null;
	let typing = isTextEntry(document.activeElement);
	let stickActive = false;
	let flyDrag = null; // Fly drag-to-look pointer { id, x, y }
	let playerHeight = PLAYER_HEIGHT_DEFAULT; // First person eye height (m above the floor)
	// First person keyboard state (pointerlock example).
	const fp = { forward: false, backward: false, left: false, right: false, velocity: new THREE.Vector3(), direction: new THREE.Vector3() };
	const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

	function enabledNow() { return !!controls && !typing && !isSuspended(); }

	function clearHeldInput() {
		fp.forward = fp.backward = fp.left = fp.right = false;
		fp.velocity.set(0, 0, 0);
		if (controls instanceof FlyControls) {
			for (const k of Object.keys(controls._moveState)) controls._moveState[k] = 0;
			controls._status = 0;
			controls._updateMovementVector();
			controls._updateRotationVector();
		}
		stickActive = false;
		flyDrag = null;
	}

	function refreshEnabled() {
		if (!controls) return;
		const on = enabledNow();
		if (controls.enabled !== on) {
			controls.enabled = on;
			if (!on) clearHeldInput();
		}
		if (!on && controls instanceof PointerLockControls && controls.isLocked) controls.unlock();
	}

	// ---- First person keys (pointerlock example's onKeyDown / onKeyUp) ----
	function onFpKey(e) {
		if (mode !== 'firstperson' || !controls || !controls.enabled) return;
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		const down = e.type === 'keydown';
		const a = actionForCode('firstperson', e.code); // remappable; defaults W/A/S/D + arrows
		if (!a) return;
		fp[a.id] = down;
		e.preventDefault();
	}
	// ---- Orbit / Map / Fly keys through the remapping ----
	// The stock listeners are not attached (see build()); each bound key is
	// passed on as the stock code of its action, modifiers kept.
	function stockKeyEvent(e, code) {
		return {
			code, key: e.key, type: e.type, repeat: e.repeat,
			altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
			preventDefault: () => e.preventDefault(), stopPropagation: () => {}
		};
	}
	function onMappedKey(e) {
		if (!controls || !controls.enabled) return;
		if (mode === 'orbit' || mode === 'map') {
			if (e.type !== 'keydown') return;
			const a = actionForCode(mode, e.code);
			if (a) controls._handleKeyDown(stockKeyEvent(e, a.stock));
		} else if (mode === 'fly' && controls instanceof FlyControls) {
			const a = actionForCode('fly', e.code);
			if (!a) return;
			if (e.type === 'keydown') controls._onKeyDown(stockKeyEvent(e, a.stock));
			else controls._onKeyUp(stockKeyEvent(e, a.stock));
		}
	}
	// Click the scene (mouse) to lock the pointer. Panels never lock it, and a
	// press that a p5 / canvas panel in the scene takes (stopImmediatePropagation
	// in main.js) never reaches this listener.
	function onFpPointerDown(e) {
		if (mode !== 'firstperson' || !controls || !controls.enabled || controls.isLocked) return;
		if (e.pointerType !== 'mouse' || e.button !== 0) return;
		// Same as PointerLockControls.lock(), but the browser's refusal (e.g. a
		// click within a second of Esc) is handled quietly instead of an
		// unhandled rejection; the next click locks.
		try {
			const r = domElement.requestPointerLock();
			if (r && typeof r.catch === 'function') r.catch(() => onLockChange(false, 'refused'));
		} catch { onLockChange(false, 'refused'); }
	}
	const onFocusChange = () => {
		const t = isTextEntry(document.activeElement);
		if (t !== typing) { typing = t; refreshEnabled(); }
	};
	const onBlur = () => clearHeldInput();
	// ---- Fly drag-to-look (see FLY_DRAG_SENSITIVITY) ----
	const _flyQ = new THREE.Quaternion();
	const _axisX = new THREE.Vector3(1, 0, 0), _axisY = new THREE.Vector3(0, 1, 0);
	function onFlyPointerDown(e) {
		if (mode !== 'fly' || !controls || !controls.enabled || flyDrag) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		flyDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
	}
	function onFlyPointerMove(e) {
		if (!flyDrag || e.pointerId !== flyDrag.id) return;
		if (mode !== 'fly' || !controls || !controls.enabled) { flyDrag = null; return; }
		const dx = e.clientX - flyDrag.x, dy = e.clientY - flyDrag.y;
		flyDrag.x = e.clientX; flyDrag.y = e.clientY;
		if (!dx && !dy) return;
		// Same local-frame rotation FlyControls.update applies for yaw / pitch.
		camera.quaternion.multiply(_flyQ.setFromAxisAngle(_axisY, -dx * FLY_DRAG_SENSITIVITY));
		camera.quaternion.multiply(_flyQ.setFromAxisAngle(_axisX, -dy * FLY_DRAG_SENSITIVITY));
	}
	function onFlyPointerUp(e) { if (flyDrag && e.pointerId === flyDrag.id) flyDrag = null; }
	domElement.addEventListener('pointerdown', onFlyPointerDown);
	window.addEventListener('pointermove', onFlyPointerMove);
	window.addEventListener('pointerup', onFlyPointerUp);
	window.addEventListener('pointercancel', onFlyPointerUp);
	document.addEventListener('keydown', onFpKey);
	document.addEventListener('keyup', onFpKey);
	window.addEventListener('keydown', onMappedKey);
	window.addEventListener('keyup', onMappedKey);
	domElement.addEventListener('pointerdown', onFpPointerDown);
	document.addEventListener('focusin', onFocusChange);
	document.addEventListener('focusout', () => setTimeout(onFocusChange, 0));
	window.addEventListener('blur', onBlur);
	function levelCamera() {
		camera.up.set(0, 1, 0);
		_euler.setFromQuaternion(camera.quaternion, 'YXZ');
		_euler.z = 0;
		camera.quaternion.setFromEuler(_euler);
	}
	function aimAtTarget() {
		// Keep the camera where it is, unless it sits (nearly) on the vertical
		// axis through the origin, where orbiting would start by staring down.
		if (Math.hypot(camera.position.x, camera.position.z) < 1) camera.position.copy(DEFAULT_CAMERA_POSITION);
		camera.up.set(0, 1, 0);
		camera.lookAt(ORBIT_TARGET);
	}

	function build(m) {
		switch (m) {
			case 'orbit': {
				const c = new OrbitControls(camera, domElement);
				c.enableDamping = true;
				c.target.copy(ORBIT_TARGET);
				// Keys: arrow keys pan, Shift/Ctrl/⌘ + arrows rotate, through
				// onMappedKey (remappable) instead of c.listenToKeyEvents(window).
				c.update();
				return c;
			}
			case 'map': {
				const c = new MapControls(camera, domElement);
				c.enableDamping = true;
				c.target.copy(ORBIT_TARGET);
				c.maxPolarAngle = Math.PI / 2;
				// Keys through onMappedKey, like Orbit.
				c.update();
				return c;
			}
			case 'fly': {
				const c = new FlyControls(camera, domElement);
				c.movementSpeed = STICK_MOVE_SPEED;
				c.rollSpeed = Math.PI / 4;
				c.autoForward = false;
				c.dragToLook = true; // look only while dragging, so moving the mouse to the panels doesn't spin the view
				// The view follows the drag (onFlyPointerMove) instead of the stock
				// "distance from the canvas centre" turn rate; keys are stock.
				domElement.removeEventListener('pointermove', c._onPointerMove);
				// Keys through onMappedKey (remappable) instead of the stock
				// window listeners; same handlers, translated codes.
				window.removeEventListener('keydown', c._onKeyDown);
				window.removeEventListener('keyup', c._onKeyUp);
				return c;
			}
			case 'firstperson': {
				const c = new PointerLockControls(camera, domElement);
				// Quiet replacement for the stock console.error on a refused lock.
				document.removeEventListener('pointerlockerror', c._onPointerlockError);
				c._onPointerlockError = () => onLockChange(false, 'refused');
				document.addEventListener('pointerlockerror', c._onPointerlockError);
				c.addEventListener('lock', () => onLockChange(true));
				c.addEventListener('unlock', () => onLockChange(false));
				return c;
			}
			default: return null;
		}
	}

	function disposeControls() {
		if (!controls) return;
		if (controls instanceof PointerLockControls && controls.isLocked) controls.unlock();
		clearHeldInput();
		if (controls instanceof OrbitControls) controls.stopListenToKeyEvents();
		controls.dispose();
		if (controls instanceof PointerLockControls) document.removeEventListener('pointerlockerror', controls._onPointerlockError);
		controls = null;
		camera.up.set(0, 1, 0);
	}

	function setMode(m) {
		m = normalizeCameraMode(m);
		disposeControls();
		mode = m;
		if (TARGET_MODES.has(m)) aimAtTarget();
		else levelCamera();
		if (m === 'firstperson') camera.position.y = playerHeight; // walk at the player's eye height
		controls = build(m);
		if (controls) { controls.enabled = true; refreshEnabled(); }
		onModeChange(m);
		return m;
	}

	// Default desktop view for the current mode: camera 4 m back at eye
	// height, looking at the origin (target modes) or straight ahead along -Z.
	function reset() {
		disposeControls();
		camera.position.copy(DEFAULT_CAMERA_POSITION);
		if (mode === 'firstperson') camera.position.y = playerHeight;
		camera.quaternion.identity();
		camera.up.set(0, 1, 0);
		if (TARGET_MODES.has(mode)) camera.lookAt(ORBIT_TARGET);
		controls = build(mode);
		if (controls) { controls.enabled = true; refreshEnabled(); }
	}

	function update(dt) {
		if (!controls || !controls.enabled) return;
		if (controls instanceof OrbitControls) controls.update();
		else if (controls instanceof FlyControls) controls.update(dt);
		else if (controls instanceof PointerLockControls && dt > 0) {
			// misc_controls_pointerlock animate(), without the jump/gravity part
			// (GS has no floor to land on). Moves whether or not the mouse is locked.
			const v = fp.velocity, d = fp.direction;
			v.x -= v.x * FP_DAMPING * dt;
			v.z -= v.z * FP_DAMPING * dt;
			d.z = Number(fp.forward) - Number(fp.backward);
			d.x = Number(fp.right) - Number(fp.left);
			d.normalize();
			if (fp.forward || fp.backward) v.z -= d.z * FP_ACCEL * dt;
			if (fp.left || fp.right) v.x -= d.x * FP_ACCEL * dt;
			if (Math.abs(v.x) > 1e-5 || Math.abs(v.z) > 1e-5) {
				controls.moveRight(-v.x * dt);
				controls.moveForward(-v.z * dt);
			}
		}
	}

	// Game controller / on-screen joysticks, already past the deadzone.
	// lx/ly: left stick (y down = positive), rx/ry: right stick, vertical:
	// up (+) / down (-), zoom: in (+) / out (-). Each value goes into the
	// active control's own API.
	function stick(dt, { lx = 0, ly = 0, rx = 0, ry = 0, vertical = 0, zoom = 0 } = {}) {
		if (!controls || !controls.enabled || dt <= 0 || !GAMEPAD_MODES.has(mode)) return;
		const any = lx || ly || rx || ry || vertical || zoom;
		if (controls instanceof OrbitControls) { // Orbit and Map (MapControls extends OrbitControls)
			if (!any) return;
			const h = domElement.clientHeight || window.innerHeight;
			if (rx) controls._rotateLeft(rx * STICK_LOOK_SPEED * dt);
			if (ry) controls._rotateUp(ry * STICK_LOOK_SPEED * dt);
			if (mode === 'map') {
				// Left stick pans over the ground like a left-drag.
				if (lx || ly) controls._pan(-lx * h * 0.5 * dt, -ly * h * 0.5 * dt);
			} else {
				// Left stick: x pans sideways, y dollies in/out (forward/back).
				if (lx) controls._pan(-lx * h * 0.5 * dt, 0);
				if (ly) { const s = Math.pow(1 / STICK_ZOOM_SPEED, Math.abs(ly) * dt * 2); if (ly < 0) controls._dollyIn(s); else controls._dollyOut(s); }
			}
			if (zoom) { const s = Math.pow(1 / STICK_ZOOM_SPEED, Math.abs(zoom) * dt * 2); if (zoom > 0) controls._dollyIn(s); else controls._dollyOut(s); }
			return;
		}
		if (controls instanceof PointerLockControls) {
			if (lx) controls.moveRight(lx * STICK_MOVE_SPEED * dt);
			if (ly) controls.moveForward(-ly * STICK_MOVE_SPEED * dt);
			if (rx || ry) {
				// Through PointerLockControls' own mouse-look handler (same pitch
				// limits), as if the mouse moved this many pixels while locked.
				const k = STICK_LOOK_SPEED * dt / (POINTERLOCK_MOUSE_SENSITIVITY * controls.pointerSpeed);
				const locked = controls.isLocked;
				controls.isLocked = true;
				controls._onMouseMove({ movementX: rx * k, movementY: ry * k });
				controls.isLocked = locked;
			}
			return;
		}
		if (controls instanceof FlyControls) {
			if (!any && !stickActive) return;
			const s = controls._moveState;
			s.right = Math.max(0, lx); s.left = Math.max(0, -lx);
			s.back = Math.max(0, ly); s.forward = Math.max(0, -ly);
			s.up = Math.max(0, vertical); s.down = Math.max(0, -vertical);
			// FlyControls turns about 2 x rollSpeed rad/s per unit of state;
			// scale so full deflection turns at STICK_LOOK_SPEED.
			const r = STICK_LOOK_SPEED / (2 * controls.rollSpeed);
			s.yawRight = Math.max(0, rx) * r; s.yawLeft = Math.max(0, -rx) * r;
			s.pitchDown = Math.max(0, ry) * r; s.pitchUp = Math.max(0, -ry) * r;
			controls._updateMovementVector();
			controls._updateRotationVector();
			stickActive = !!any;
		}
	}

	return {
		get mode() { return mode; },
		get controls() { return controls; },
		get typing() { return typing; },
		get locked() { return !!(controls && controls.isLocked); },
		get playerHeight() { return playerHeight; },
		/** First person eye height in metres (clamped); moves the camera now when in First person. */
		setPlayerHeight(h) {
			const v = clampPlayerHeight(h);
			if (v === null) return playerHeight;
			playerHeight = v;
			if (mode === 'firstperson') camera.position.y = v;
			return v;
		},
		/** Bindings changed: drop held keys so nothing keeps moving. */
		releaseKeys() { clearHeldInput(); if (controls instanceof FlyControls) controls.movementSpeedMultiplier = 1; },
		get target() { return controls && controls.target ? controls.target : null; },
		setMode,
		reset,
		update,
		stick,
		refreshEnabled,
		unlock() { if (controls instanceof PointerLockControls && controls.isLocked) controls.unlock(); },
		/** Put the Orbit / Map target back on the scene origin. */
		recenter() {
			if (!controls || !controls.target) return;
			// Drop any damped pan / rotate still in flight so the target stays put.
			if (controls._panOffset) controls._panOffset.set(0, 0, 0);
			if (controls._sphericalDelta) controls._sphericalDelta.set(0, 0, 0);
			if (controls._panEnd && controls._panStart) controls._panStart.copy(controls._panEnd);
			controls.target.copy(ORBIT_TARGET);
			controls.update();
		},
		dispose() { disposeControls(); }
	};
}
