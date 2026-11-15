// VR Map zoom with two hands: hold BOTH grip (squeeze) buttons and move the
// controllers apart to zoom in, closer together to zoom out, like a pinch
// zoom on a phone (scale-style: the distance to the point you zoom toward is
// divided by the ratio of the hand spread). Releasing either grip ends it.
//
// Pure maths, no three.js and no DOM, so it is easy to test; main.js feeds it
// the grip states, the controller and head positions and the zoom pivot, and
// applies the rig offset it returns.
//
//   ratio      = startSpread / effectiveSpread   (spread minus the deadzone)
//   distance   = startDistance × ratio, clamped to [min, max] (Map's limits)
//   smoothed   → exponential approach (time constant 1 / smoothing s)
//   each frame the rig moves along the start pivot→head line by the change
//   of the smoothed factor (head ends at pivot + (head0 − pivot) × factor).

export const GRIP_ZOOM_DEFAULTS = Object.freeze({
	deadzone: 0.015,   // m of change in hand spread before zooming starts (no jitter)
	smoothing: 12,     // 1/s: ~83 ms time constant
	minSpread: 0.03,   // m: spreads below this are treated as this (no divide by ~0)
	exponent: 1        // 1 = pinch-zoom proportional (double the spread → half the distance)
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * createGripZoom({ min, max, deadzone, smoothing, exponent })
 *   min / max: allowed distance (m) from the head to the zoom pivot.
 * update(dt, { left, right, leftPos, rightPos, head, pivot, enabled })
 *   left / right: grip held (bool). leftPos / rightPos / head: {x,y,z} world.
 *   pivot(): called once when the gesture starts → {x,y,z} (where you zoom toward).
 *   → null (no gesture) or { offset: {x,y,z} to add to the rig, distance, target }
 */
export function createGripZoom(opts = {}) {
	const o = { ...GRIP_ZOOM_DEFAULTS, ...opts };
	let g = null; // { spread0, d0, pivot, target, smooth, applied }
	const state = {
		get active() { return !!g; },
		get info() { return g ? { startSpread: g.spread0, startDistance: g.d0, pivot: { ...g.pivot }, target: g.target, smoothed: g.smooth } : null; },
		end() { g = null; },
		update(dt, s) {
			if (!s || !s.enabled || !s.left || !s.right || !s.leftPos || !s.rightPos || !s.head) { g = null; return null; }
			const spread = Math.max(o.minSpread, dist3(s.leftPos, s.rightPos));
			if (!g) {
				const pivot = typeof s.pivot === 'function' ? s.pivot() : s.pivot;
				if (!pivot) return null;
				const d0 = Math.max(1e-3, dist3(s.head, pivot));
				g = { spread0: spread, d0, pivot: { x: pivot.x, y: pivot.y, z: pivot.z }, v0: { x: s.head.x - pivot.x, y: s.head.y - pivot.y, z: s.head.z - pivot.z }, target: 1, smooth: 1 };
				return { offset: { x: 0, y: 0, z: 0 }, distance: d0, target: 1 };
			}
			// Deadzone: the first `deadzone` metres of change do nothing, then the
			// zoom follows the change past it (no jump at the edge).
			const delta = spread - g.spread0;
			const eff = Math.abs(delta) <= o.deadzone ? g.spread0 : Math.max(o.minSpread, g.spread0 + delta - Math.sign(delta) * o.deadzone);
			// Distance factor: apart (eff > spread0) → < 1 → closer → zoom in.
			let target = Math.pow(g.spread0 / eff, o.exponent);
			// Clamp against Map's limits from where the gesture started; if it
			// started outside them only the way back in is allowed.
			const lo = Math.min(1, o.min / g.d0), hi = Math.max(1, o.max / g.d0);
			target = clamp(target, lo, hi);
			g.target = target;
			const k = dt > 0 ? 1 - Math.exp(-o.smoothing * dt) : 0;
			const prev = g.smooth;
			g.smooth = prev + (target - prev) * k;
			if (Math.abs(g.smooth - target) < 1e-4) g.smooth = target;
			// Move along the start pivot→head line by this frame's change. Not
			// from the live head: in a headset the head position read before
			// rendering lags the rig by a frame, which would overshoot.
			const step = g.smooth - prev;
			const v = g.v0;
			return { offset: { x: v.x * step, y: v.y * step, z: v.z * step }, distance: g.d0 * g.smooth, target };
		}
	};
	return state;
}
