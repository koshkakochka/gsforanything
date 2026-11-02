// Mic in VR (IWER-emulated Meta Quest 3): the Enter VR click asks for the mic
// only for people who used it before, ray-clicking 🎤 in the VR menu shows the
// status line in the menu + HUD and sends speech, push-to-talk (A button)
// transcribes and sends, and a blocked mic in VR shows the Quest settings hint.
// /api/chat is ALWAYS stubbed (see common.mjs).
//   BASE=https://localhost:3492 node vr.mjs
import fs from 'fs';
import { open, check, summary, sleep, SHOT_DIR } from './common.mjs';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');

// Permissions API reporting "prompt" (what a Quest user who never answered sees).
const promptPerm = (p) => p.evaluateOnNewDocument(() => {
	const q = navigator.permissions.query.bind(navigator.permissions);
	navigator.permissions.query = async (d) => (d && d.name === 'microphone' ? { state: 'prompt', onchange: null, addEventListener() {}, removeEventListener() {} } : q(d));
});

async function enterVr(p) {
	await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
	await p.click('#XRButton').catch(() => {});
	for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
	await sleep(1500);
	await p.evaluate(() => {
		const V = THREE.Vector3;
		window.__t = {
			win: (n) => window.__gsVrWindows.byName(n),
			pointFor(el, winName) { const w = this.win(winName); const sr = w.source.getBoundingClientRect(); const r = el.getBoundingClientRect(); const u = (r.left + r.width / 2 - sr.left) / sr.width, v = 1 - (r.top + r.height / 2 - sr.top) / sr.height; w.mesh.updateMatrixWorld(true); return w.mesh.localToWorld(new V(u - 0.5, v - 0.5, 0.0)); },
			aim(hand, target) { const c = [0, 1].map((i) => renderer.xr.getController(i)).find((x) => x.userData.handedness === hand); const xrCam = renderer.xr.getCamera(); const head = new V(); xrCam.getWorldPosition(head); const origin = head.clone().add(new V(hand === 'right' ? 0.15 : -0.15, -0.3, -0.1)); const parent = c.parent; parent.updateMatrixWorld(true); const inv = parent.matrixWorld.clone().invert(); const o = origin.clone().applyMatrix4(inv), t = target.clone().applyMatrix4(inv); const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(o, t, new V(0, 1, 0))); const dc = window.__xrDevice.controllers[hand]; dc.position.set(o.x, o.y, o.z); dc.quaternion.set(q.x, q.y, q.z, q.w); },
			aimAt(hand, el, winName) { this.aim(hand, this.pointFor(el, winName)); },
			trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); },
			button(hand, name, v) { window.__xrDevice.controllers[hand].updateButtonValue(name, v); }
		};
	});
	return p.evaluate(() => renderer.xr.isPresenting);
}
const rayClick = async (p, sel, win = 'menu') => {
	await p.evaluate((s, w) => __t.aimAt('right', document.querySelector(s), w), sel, win);
	await sleep(400);
	await p.evaluate(() => __t.trigger('right', 1)); await sleep(300); await p.evaluate(() => __t.trigger('right', 0)); await sleep(400);
};
const shot = async (p, name) => { await p.screenshot({ path: `${SHOT_DIR}/${name}.png` }); };

// ---- 1. Enter VR, never used the mic: no getUserMedia ----
{
	const { b, p, errors } = await open({ iwer: IWER, before: promptPerm });
	const inVr = await enterVr(p);
	check('[hook] Entered immersive VR (IWER Quest 3)', inVr);
	await sleep(1000);
	const g = await p.evaluate(() => __micT.gum);
	check('[hook] Never used the mic: Enter VR does NOT ask for it', g === 0, g);
	check('[hook] No console errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ---- 2. Enter VR, used the mic before + permission "prompt": asks once, on the click ----
{
	const { b, p, errors, mic } = await open({ iwer: IWER, before: promptPerm });
	await p.evaluate(() => localStorage.setItem('gs.micUsed', '1'));
	await enterVr(p);
	await sleep(1500);
	const s = await mic();
	check('[hook] Used the mic before + "prompt": one getUserMedia on the Enter VR click', s.gum === 1 && s.gumOk === 1, { gum: s.gum, ok: s.gumOk, err: s.gumErr });
	check('[hook] …and the probe stream is released right away', s.liveTracks === 0, s.liveTracks);
	check('[hook] …and the speech model starts preloading', s.sttModelReady || s.sttPct > 0 || /Loading/.test(s.statusText) || s.worker, s);
	check('[hook] No console errors', errors.length === 0, errors.slice(0, 3));
	await b.close();
}

// ---- 3. In VR: ray-click 🎤 in the menu, speech gets sent; then push-to-talk ----
{
	const { b, p, errors, chats, mic, until } = await open({ iwer: IWER, wav: 'speech.wav' });
	check('[vr] Entered immersive VR', await enterVr(p));
	await rayClick(p, '#desktop-mic-button');
	const pend = await mic();
	check('[vr] Ray click on 🎤 in the VR menu turns the mic on', pend.ariaPressed === 'true', pend);
	const listening = await until((s) => s.micListening, 90000, 200);
	check('[vr] Listening once the model is ready', listening.micListening && /Listening/.test(listening.statusText), listening.statusText);
	const inMenu = await p.evaluate(() => { const w = __t.win('menu'); const st = document.getElementById('gs-mic-status'); return w.source.contains(st) && !st.hidden && w.mesh.visible; });
	check('[vr] Status line is inside the VR menu window', inMenu);
	check('[vr] HUD shows the mic status', /Listening|mic/i.test(listening.hud), listening.hud);
	await p.evaluate(() => __t.win('menu').tick && __t.win('menu').tick(true));
	await shot(p, 'vr-1-listening');
	const sent = await until(() => chats.length > 0, 40000);
	check('[vr] Speech transcribed and sent (stubbed /api/chat)', chats.length > 0 && /cube|tree|red/i.test(chats[0]), chats);
	const st = await until((s) => s.statusState === 'sent', 4000, 100);
	check('[vr] HUD confirms the send', /Sent/i.test(st.hud) || /Sent/.test(st.statusText), { hud: st.hud, status: st.statusText });
	await shot(p, 'vr-2-sent');
	// turn always-on off, then push-to-talk with the right A button
	await rayClick(p, '#desktop-mic-button');
	await until((s) => s.micMode === 'off', 5000);
	const n0 = chats.length;
	await p.evaluate(() => __t.button('right', 'a-button', 1));
	const ptt = await until((s) => s.micMode === 'ptt' && s.micListening, 8000, 100);
	check('[ptt] A button starts push-to-talk capture', ptt.micMode === 'ptt' && ptt.micListening, ptt);
	await sleep(8500); // a full loop of the fixture (2 s silence, phrase, 4 s silence)
	await p.evaluate(() => __t.button('right', 'a-button', 0));
	await until(() => chats.length > n0, 30000);
	check('[ptt] Releasing A transcribes and sends', chats.length > n0 && /cube|tree|red/i.test(chats[chats.length - 1]), chats.slice(n0));
	await shot(p, 'vr-3-ptt-sent');
	const counts = await p.evaluate(() => __gsMic.state());
	check('[vr] No console errors', errors.length === 0, errors.slice(0, 3));
	console.log('   stats', JSON.stringify({ segments: counts.segments, rotations: counts.rotations, dropped: counts.dropped, worker: counts.worker }));
	await b.close();
}

// ---- 4. In VR, mic blocked: push-to-talk says so with the Quest hint ----
{
	const { b, p, chats, mic, until } = await open({ iwer: IWER, grant: false, before: (pg) => pg.evaluateOnNewDocument(() => {
		const q = navigator.permissions.query.bind(navigator.permissions);
		navigator.permissions.query = async (d) => (d && d.name === 'microphone' ? { state: 'denied', onchange: null, addEventListener() {}, removeEventListener() {} } : q(d));
		navigator.mediaDevices.getUserMedia = async () => { window.__micT.gum++; throw new DOMException('Permission denied', 'NotAllowedError'); };
	}) });
	await enterVr(p);
	await p.evaluate(() => __t.button('right', 'a-button', 1)); await sleep(600); await p.evaluate(() => __t.button('right', 'a-button', 0));
	const s = await until((x) => x.statusState === 'blocked', 6000);
	check('[blocked] Push-to-talk with mic blocked shows "blocked" (not silent)', s.statusState === 'blocked', s.statusText);
	check('[blocked] Quest wording: Settings › Apps › Browser', /Settings/.test(s.statusText) && /Browser/.test(s.statusText), s.statusText);
	check('[blocked] HUD shows it too', /block/i.test(s.hud), s.hud);
	await p.evaluate(() => __t.win('menu').tick && __t.win('menu').tick(true));
	await shot(p, 'vr-4-blocked');
	check('[blocked] Nothing sent', chats.length === 0, chats);
	await b.close();
}
summary('mic (VR)');
