// Pure maths of site-source/vrGripZoom.js (no browser): node unit.mjs
import { createGripZoom } from '../../site-source/vrGripZoom.js';
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} unit: ${n}${d !== '' ? '  — ' + JSON.stringify(d) : ''}`); };
const V = (x, y, z) => ({ x, y, z });
const len = (v) => Math.hypot(v.x, v.y, v.z);
// Run a gesture: hands at ±s/2 on x, head moved by the returned offsets.
function run(z, { d0 = 10, spreads, frames = 120, dt = 1 / 60 }) {
	let head = V(0, d0, 0); const pivot = V(0, 0, 0);
	let r = null;
	const step = (s) => {
		r = z.update(dt, { enabled: true, left: true, right: true, leftPos: V(-s / 2, 1, 0), rightPos: V(s / 2, 1, 0), head, pivot });
		if (r) head = V(head.x + r.offset.x, head.y + r.offset.y, head.z + r.offset.z);
	};
	step(spreads[0]);
	for (const s of spreads.slice(1)) for (let i = 0; i < frames; i++) step(s);
	return { head, dist: len(head), r };
}
const mk = (o = {}) => createGripZoom({ min: 0.3, max: 20000, ...o });
let t = run(mk(), { spreads: [0.3, 0.6] });
check('spread 0.3 → 0.6 m zooms IN (distance ×0.3/0.585)', Math.abs(t.dist - 10 * 0.3 / 0.585) < 0.01, t.dist);
t = run(mk(), { spreads: [0.6, 0.3] });
check('pinch 0.6 → 0.3 m zooms OUT (distance ×0.6/0.315)', Math.abs(t.dist - 10 * 0.6 / 0.315) < 0.02, t.dist);
t = run(mk(), { spreads: [0.4, 0.41] });
check('1 cm change stays inside the 1.5 cm deadzone (no move)', Math.abs(t.dist - 10) < 1e-9, t.dist);
t = run(mk(), { spreads: [0.4, 0.42] });
check('2 cm change: only the 0.5 cm past the deadzone counts (no jump)', Math.abs(t.dist - 10 * 0.4 / 0.405) < 0.005, t.dist);
t = run(mk(), { d0: 2, spreads: [0.1, 1.2] });
check('spread far apart clamps at min 0.3 m', Math.abs(t.dist - 0.3) < 1e-6, t.dist);
t = run(mk(), { d0: 5000, spreads: [1.2, 0.1] });
check('pinch hard clamps at max 20 km', Math.abs(t.dist - 20000) < 1e-3, t.dist);
t = run(mk(), { d0: 25000, spreads: [0.6, 0.3] });
check('already beyond max: pinch does not move further out', Math.abs(t.dist - 25000) < 1e-6, t.dist);
t = run(mk(), { d0: 25000, spreads: [0.3, 0.6] });
check('already beyond max: spread still zooms in', t.dist < 25000 * 0.6, t.dist);
// smoothing: one frame after a jump it is part of the way there
{
	const z = mk(); const pivot = V(0, 0, 0); let head = V(0, 10, 0);
	z.update(1 / 60, { enabled: true, left: true, right: true, leftPos: V(-0.15, 1, 0), rightPos: V(0.15, 1, 0), head, pivot });
	const r = z.update(1 / 60, { enabled: true, left: true, right: true, leftPos: V(-0.3, 1, 0), rightPos: V(0.3, 1, 0), head, pivot });
	const d1 = r.distance;
	check('smoothed: first frame moves part of the way (between start and target)', d1 < 10 && d1 > 10 * r.target + 0.5, { d1, target: 10 * r.target });
}
// single grip / disabled → nothing
{
	const z = mk();
	const r = z.update(1 / 60, { enabled: true, left: true, right: false, leftPos: V(0, 1, 0), rightPos: V(1, 1, 0), head: V(0, 10, 0), pivot: V(0, 0, 0) });
	check('one grip: no gesture', r === null && !z.active);
	const r2 = z.update(1 / 60, { enabled: false, left: true, right: true, leftPos: V(0, 1, 0), rightPos: V(1, 1, 0), head: V(0, 10, 0), pivot: V(0, 0, 0) });
	check('disabled: no gesture', r2 === null && !z.active);
}
// release ends it; a new press re-bases on the new spread
{
	const z = mk(); const head = V(0, 10, 0), pivot = V(0, 0, 0);
	z.update(1 / 60, { enabled: true, left: true, right: true, leftPos: V(-0.1, 1, 0), rightPos: V(0.1, 1, 0), head, pivot });
	z.update(1 / 60, { enabled: true, left: true, right: false, leftPos: V(-0.1, 1, 0), rightPos: V(0.1, 1, 0), head, pivot });
	check('releasing a grip ends the gesture', !z.active);
	const r = z.update(1 / 60, { enabled: true, left: true, right: true, leftPos: V(-0.4, 1, 0), rightPos: V(0.4, 1, 0), head, pivot });
	check('a new gesture starts from the new spread (no jump)', r && len(r.offset) === 0 && Math.abs(z.info.startSpread - 0.8) < 1e-9, z.info);
}
console.log(`\nunit: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
