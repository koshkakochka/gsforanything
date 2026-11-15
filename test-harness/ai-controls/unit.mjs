// Node-only tests of the AI-described controls interpreter and validator
// (site-source/aiControls.js): no browser, no network, no AI.
//   node unit.mjs
globalThis.localStorage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; })();
const A = await import('../../site-source/aiControls.js');
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

export const GRIP = { format: 'gs-control/1', name: 'Two-hand grip zoom', summary: 'Hold both grips; hands apart zooms in, together zooms out.',
	when: [{ input: 'xr:L-Squeeze', is: 'held' }, { input: 'xr:R-Squeeze', is: 'held' }], bindings: [{ source: 'xr:handDistance', action: 'zoom', sensitivity: 1, deadzone: 0.01, smoothing: 0.3 }] };
const LB = { format: 'gs-control/1', name: 'LB + right stick orbit', summary: 'While LB is held, the right stick orbits.', when: [{ input: 'pad:LB', is: 'held' }],
	bindings: [{ source: 'pad:RS-X', action: 'rotate.yaw' }, { source: 'pad:RS-Y', action: 'rotate.pitch', invert: true }] };

// ---- validation ----
let v = A.validateDefinition(GRIP);
check('grip definition validates', v.ok && v.def.when.length === 2 && v.def.bindings[0].source === 'xr:handDistance' && v.def.bindings[0].action === 'zoom', v);
const gripDef = v.def;
v = A.validateDefinition({ ...GRIP, when: [{ input: 'vr:left grip', is: 'held' }, { input: 'gamepad:L1', is: 'HELD' }] });
check('aliases normalise (vr:left grip → xr:L-Squeeze, gamepad:L1 → pad:LB, HELD → held)', v.ok && v.def.when[0].input === 'xr:L-Squeeze' && v.def.when[1].input === 'pad:LB' && v.def.when[1].is === 'held', v);
v = A.validateDefinition({ ...GRIP, bindings: [{ source: 'xr:EyeGaze', action: 'zoom' }] });
check('unsupported source refused', !v.ok && /Unsupported input "xr:EyeGaze"/.test(v.error), v);
v = A.validateDefinition({ ...GRIP, bindings: [{ source: 'xr:handDistance', action: 'teleport' }] });
check('unsupported action refused', !v.ok && /Unsupported action/.test(v.error), v);
v = A.validateDefinition({ ...GRIP, when: [{ input: 'xr:L-Squeeze', is: 'twice' }] });
check('unsupported condition refused', !v.ok && /condition/.test(v.error), v);
v = A.validateDefinition({ format: 'gs-control/1', error: 'needs eye tracking' });
check('AI "error" reply becomes a clear message', !v.ok && /could not turn that into a control: needs eye tracking/.test(v.error), v);
v = A.validateDefinition({ ...GRIP, bindings: [{ source: 'xr:handDistance', action: 'zoom', sensitivity: 999, smoothing: 7, deadzone: -1, code: 'alert(1)', clamp: [5, -5] }] });
check('numbers clamped, unknown fields dropped, clamp ordered', v.ok && v.def.bindings[0].sensitivity === 10 && v.def.bindings[0].smoothing === 0.95 && v.def.bindings[0].deadzone === 0 && !('code' in v.def.bindings[0]) && v.def.bindings[0].clamp[0] === -5, v.def?.bindings);
v = A.validateDefinition({ ...GRIP, bindings: Array(5).fill(GRIP.bindings[0]) });
check('more than 4 bindings refused', !v.ok, v);
v = A.validateDefinition({ ...GRIP, bindings: [{ source: 'xr:handDistance', action: 'resetView' }] });
check('discrete action needs a button source', !v.ok, v);
v = A.validateDefinition('function(){}');
check('non-object refused', !v.ok);
check('parseAiReply: fenced json', A.parseAiReply('Here:\n```json\n' + JSON.stringify(GRIP) + '\n```').ok);
check('parseAiReply: bare object with chatter', A.parseAiReply('Sure! ' + JSON.stringify(GRIP) + ' Enjoy').ok);
const bad = A.parseAiReply('Sure, I will make that control for you!');
check('parseAiReply: invalid JSON → clear error', !bad.ok && /not valid JSON/.test(bad.error), bad);

// ---- Quest 3 controllers: two-hand grip zoom ----
// Rig-local controller positions (metres), Quest 3 resting pose ~1.1 m high, 0.3 m in front.
const hand = (grip, pos, extra = {}) => ({ connected: true, blocked: false, stickBlocked: false, stick: [0, 0], pos, inputs: { 'L-Squeeze': grip, 'R-Squeeze': grip, ...extra } });
function xrFrame(lp, rp, { lg = 1, rg = 1, yaw = 0, blockedL = false, typing = false } = {}) {
	const L = hand(lg, lp); L.blocked = blockedL; L.inputs = { 'L-Squeeze': lg };
	const R = hand(rg, rp); R.inputs = { 'R-Squeeze': rg };
	return { dt: 1 / 72, typing, keys: new Set(), mouse: { buttons: new Set(), dx: 0, dy: 0, wheel: 0 }, pad: { connected: false }, xr: { presenting: true, headYaw: yaw, hands: { left: L, right: R } } };
}
function runSpread(rt, ctl, from, to, frames = 72, opts = {}) {
	let z = 0; const eng = [];
	for (let f = 0; f <= frames; f++) {
		const d = from + (to - from) * (f / frames);
		const o = rt.step(xrFrame([-d / 2, 1.1, -0.3], [d / 2, 1.1, -0.3], opts), ctl);
		z += o.camera.zoom || 0; eng.push(o.engaged);
	}
	for (let f = 0; f < 30; f++) { const o = rt.step(xrFrame([-to / 2, 1.1, -0.3], [to / 2, 1.1, -0.3], opts), ctl); z += o.camera.zoom || 0; } // smoothing settles
	return { z, eng };
}
let rt = A.createAiRuntime();
const ctl = [{ id: 'grip1', enabled: true, def: gripDef }];
let r = runSpread(rt, ctl, 0.3, 0.6);
check('Quest 3: both grips + hands apart 0.3 m → zoom in (~0.3 × 3 = 0.9)', near(r.z, 0.87, 0.08), r.z);
check('Quest 3: both grips engage L/R squeeze + handDistance', r.eng[5].has('xr:L-Squeeze') && r.eng[5].has('xr:R-Squeeze') && r.eng[5].has('xr:handDistance'));
rt.step(xrFrame([-0.3, 1.1, -0.3], [0.3, 1.1, -0.3], { lg: 0, rg: 0 }), ctl); // let go
r = runSpread(rt, ctl, 0.6, 0.3);
check('Quest 3: pinch hands together → zoom out', near(r.z, -0.87, 0.08), r.z);
rt.step(xrFrame([-0.3, 1.1, -0.3], [0.3, 1.1, -0.3], { lg: 0, rg: 0 }), ctl);
r = runSpread(rt, ctl, 0.3, 0.6, 72, { rg: 0 });
check('Quest 3: only the left grip held → no zoom', r.z === 0, r.z);
rt.step(xrFrame([-0.3, 1.1, -0.3], [0.3, 1.1, -0.3], { lg: 0, rg: 0 }), ctl);
r = runSpread(rt, ctl, 0.3, 0.6, 72, { blockedL: true });
check('Quest 3: grips pressed while the left ray is on a menu window (that press is the menu\'s) → no zoom', r.z === 0, r.z);
rt.step(xrFrame([-0.3, 1.1, -0.3], [0.3, 1.1, -0.3], { lg: 0, rg: 0 }), ctl);
rt.step(xrFrame([-0.15, 1.1, -0.3], [0.15, 1.1, -0.3]), ctl); // grips pressed in open space
r = runSpread(rt, ctl, 0.3, 0.6, 72, { blockedL: true }); // ...then the ray sweeps over a window mid-zoom
check('Quest 3: a grip zoom already under way keeps going when a ray passes over a window', near(r.z, 0.87, 0.1), r.z);
r = runSpread(rt, ctl, 0.3, 0.6, 72, { typing: true });
check('typing (text field / VR keyboard) pauses AI controls', r.z === 0, r.z);
// jitter below the 1 cm deadzone does nothing
rt = A.createAiRuntime();
let jz = 0;
for (let f = 0; f < 120; f++) { const j = 0.003 * Math.sin(f); const o = rt.step(xrFrame([-0.2 - j, 1.1, -0.3], [0.2 + j, 1.1, -0.3]), ctl); jz += o.camera.zoom || 0; }
check('hand jitter under the 1 cm deadzone → no zoom', jz === 0, jz);
// moving both hands together (same distance) → no zoom; the rig turning doesn't matter
rt = A.createAiRuntime();
let mz = 0;
for (let f = 0; f < 72; f++) { const s = f * 0.005; const o = rt.step(xrFrame([-0.2 + s, 1.1, -0.3 + s], [0.2 + s, 1.1, -0.3 + s], { yaw: f * 0.02 }), ctl); mz += o.camera.zoom || 0; }
check('both hands moving together (distance unchanged) → no zoom', Math.abs(mz) < 1e-9, mz);
check('disabled control does nothing', runSpread(A.createAiRuntime(), [{ ...ctl[0], enabled: false }], 0.3, 0.6).z === 0);
// smoothing: the first frames give less than the raw delta
rt = A.createAiRuntime();
rt.step(xrFrame([-0.15, 1.1, -0.3], [0.15, 1.1, -0.3]), ctl);
rt.step(xrFrame([-0.16, 1.1, -0.3], [0.16, 1.1, -0.3]), ctl); // passes the deadzone
const o1 = rt.step(xrFrame([-0.18, 1.1, -0.3], [0.18, 1.1, -0.3]), ctl);
check('smoothing 0.3 eases in (first frame < raw 0.04 m × 3)', o1.camera.zoom > 0 && o1.camera.zoom < 0.12, o1.camera.zoom);

// hand delta in the facing frame: right hand moves +X in the rig while facing 90° left (yaw +π/2) → forward
const panDef = A.validateDefinition({ name: 'drag', when: [{ input: 'xr:R-Trigger', is: 'held' }], bindings: [{ source: 'xr:R-Hand-Z', action: 'pan.y' }] }).def;
rt = A.createAiRuntime();
let pz = 0;
for (let f = 0; f <= 10; f++) {
	const R = { connected: true, inputs: { 'R-Trigger': 1 }, pos: [0.2 + f * 0.01, 1, -0.3], stick: [0, 0] };
	const o = rt.step({ dt: 1 / 72, keys: new Set(), xr: { presenting: true, headYaw: -Math.PI / 2, hands: { right: R, left: { connected: true, inputs: {}, pos: [-0.2, 1, -0.3] } } } }, [{ id: 'p', enabled: true, def: panDef }]);
	pz += o.camera['pan.y'] || 0;
}
check('hand motion is measured relative to where you face (yaw -90°: rig +X = forward)', near(pz, 0.1 * 4, 0.02), pz);

// ---- simulated gamepad: hold LB + right stick orbits ----
const lbDef = A.validateDefinition(LB).def;
rt = A.createAiRuntime();
const padFrame = (lb, rx, ry) => ({ dt: 1 / 60, keys: new Set(), pad: { connected: true, inputs: { LB: lb }, axes: { leftX: 0, leftY: 0, rightX: rx, rightY: ry } } });
let yaw = 0, pitch = 0, eng;
for (let f = 0; f < 60; f++) { const o = rt.step(padFrame(1, 1, -0.5), [{ id: 'lb', enabled: true, def: lbDef }]); yaw += o.camera['rotate.yaw'] || 0; pitch += o.camera['rotate.pitch'] || 0; eng = o.engaged; }
check('gamepad: LB held + right stick → yaw 2 rad/s, pitch inverted (stick up = look up)', near(yaw, 2, 0.01) && near(pitch, 1, 0.01), { yaw, pitch });
check('gamepad: engaged inputs include pad:LB and the right stick axes', eng.has('pad:LB') && eng.has('pad:RS-X') && eng.has('pad:RS-Y'), [...eng]);
let y2 = 0;
for (let f = 0; f < 60; f++) { const o = rt.step(padFrame(0, 1, 0), [{ id: 'lb', enabled: true, def: lbDef }]); y2 += o.camera['rotate.yaw'] || 0; eng = o.engaged; }
check('gamepad: without LB the stick does nothing here (left to the stock camera)', y2 === 0 && eng.size === 0, { y2, eng: [...eng] });
// deadzone + clamp on a rate source
const dzDef = A.validateDefinition({ name: 'dz', bindings: [{ source: 'pad:LS-X', action: 'pan.x', deadzone: 0.2, clamp: [-1, 1] }] }).def;
rt = A.createAiRuntime();
let px = 0; for (let f = 0; f < 60; f++) px += rt.step({ dt: 1 / 60, pad: { connected: true, inputs: {}, axes: { leftX: 0.15 } } }, [{ id: 'd', enabled: true, def: dzDef }]).camera['pan.x'] || 0;
check('deadzone 0.2: stick at 0.15 does nothing', px === 0, px);
px = 0; for (let f = 0; f < 60; f++) px += rt.step({ dt: 1 / 60, pad: { connected: true, inputs: {}, axes: { leftX: 1 } } }, [{ id: 'd', enabled: true, def: dzDef }]).camera['pan.x'] || 0;
check('clamp [-1, 1]: full stick pans at most 1 m/s (not 3)', near(px, 1, 0.01), px);
// keyboard: hold Q to zoom in; press R to reset view (event once)
const kDef = A.validateDefinition({ name: 'keys', bindings: [{ source: 'key:KeyQ', action: 'zoom' }, { source: 'key:KeyR', action: 'resetView' }] }).def;
rt = A.createAiRuntime();
let kz = 0, evs = [];
for (let f = 0; f < 30; f++) { const o = rt.step({ dt: 1 / 60, keys: new Set(['KeyQ', 'KeyR']) }, [{ id: 'k', enabled: true, def: kDef }]); kz += o.camera.zoom || 0; evs.push(...o.events); }
check('keyboard: holding Q zooms in at 1/s; R fires resetView once', near(kz, 0.5, 0.01) && evs.length === 1 && evs[0] === 'resetView', { kz, evs });
// scene param, add + range, set mode
const pDef = A.validateDefinition({ name: 'throttle', bindings: [{ source: 'pad:RT', action: 'param:throttle', paramMode: 'set' }, { source: 'pad:A', action: 'param:car.topSpeed', clamp: [0, 0.5] }] }).def;
rt = A.createAiRuntime();
let last;
for (let f = 0; f < 120; f++) last = rt.step({ dt: 1 / 60, pad: { connected: true, inputs: { RT: 0.7, A: 1 }, axes: {} } }, [{ id: 'q', enabled: true, def: pDef }]);
check('param set mode follows the trigger (0.7); add mode accumulates within its range [0, 0.5]', near(rt.value('throttle'), 0.7, 1e-9) && rt.value('car.topSpeed') === 0.5, rt.values);

// ---- conflicts ----
const cf = A.findConflicts(gripDef, { xr: { 'L-Stick-Up': 'Map: Pan forward' }, reservedXr: { 'R-Squeeze': 'GS: cycles VR locomotion' } });
check('conflicts: R grip is GS\'s locomotion cycle', cf.length === 1 && cf[0].input === 'xr:R-Squeeze' && /locomotion/.test(cf[0].with), cf);
const cf2 = A.findConflicts(lbDef, { gamepad: { 'RS-Left': 'Map: Rotate left', 'RS-Up': 'Map: Rotate up', LB: '' }, others: [{ name: 'Other', def: lbDef }] });
check('conflicts: right stick axes clash with the stock rotate rows and another AI control', cf2.some((c) => c.with === 'Map: Rotate left') && cf2.some((c) => c.with === 'Map: Rotate up') && cf2.some((c) => /AI control "Other"/.test(c.with)), cf2);
check('static claims: grip zoom holds both grips (GS\'s own grip uses step aside)', [...A.staticXrButtonClaims([{ enabled: true, def: gripDef }])].sort().join() === 'left:1,right:1');

// ---- storage ----
localStorage.setItem(A.AI_CONTROLS_STORAGE_KEY, JSON.stringify({ v: 1, modes: { map: [{ id: 'abcd1234', description: 'grip zoom', enabled: true, def: GRIP }, { id: 'bad', def: { bindings: [{ source: 'x', action: 'y' }] } }], 'Bad Mode!': [] } }));
const st = A.readModeStore();
check('storage: valid records kept, invalid ones dropped', Object.keys(st).join() === 'map' && st.map.length === 1 && st.map[0].id === 'abcd1234', st);
const sl = A.sanitizeList([{ description: 'x', def: GRIP }, ...Array(20).fill({ def: GRIP })]);
check('at most 12 AI controls per list', sl.length === 12, sl.length);

// prompt / message
const sys = A.buildSystemPrompt();
check('system prompt: format, no code, grip example', /gs-control\/1/.test(sys) && /Do NOT write any JavaScript/.test(sys) && /handDistance/.test(sys));
const um = A.buildUserMessage('hold both grips to zoom', { modeLabel: 'Map', bindings: { actions: [{ id: 'panUp' }] }, reserved: 'R grip cycles locomotion' });
check('user message: description, mode and bindings', /hold both grips to zoom/.test(um) && /Camera mode: Map/.test(um) && /panUp/.test(um) && /R grip/.test(um), um);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
