// Shared helpers for the mic suite: launch Chrome with a fake microphone,
// stub the server APIs (/api/chat is ALWAYS stubbed: no real model calls),
// and instrument getUserMedia / MediaRecorder.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
export const BASE = process.env.BASE || 'https://localhost:3488';
export const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-mic-shots';
export const FIX = new URL('./fixtures/', import.meta.url).pathname;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOT_DIR, { recursive: true });
let pass = 0, fail = 0;
export const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); };
export const summary = (name) => { console.log(`\n${name}: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; };
// A profile that keeps the downloaded Whisper model between scenarios (the
// first scenario uses a fresh profile so the download progress is exercised).
export const CACHE_PROFILE = process.env.MIC_PROFILE || '/tmp/gs-mic-test-profile';

export async function open({ wav = null, grant = true, fresh = false, iwer = null, viewport = { width: 1400, height: 900 }, before = null } = {}) {
	const args = ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
	if (grant) args.push('--use-fake-ui-for-media-stream');
	if (wav) args.push('--use-file-for-fake-audio-capture=' + path.join(FIX, wav));
	const userDataDir = fresh ? fs.mkdtempSync('/tmp/gs-mic-fresh-') : CACHE_PROFILE;
	const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args, userDataDir });
	const p = await b.newPage();
	const errors = [], chats = [], log = [];
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	p.on('console', (m) => {
		const t = m.text();
		log.push(m.type() + ': ' + t);
		// "Speech error" is the expected console.error for denied / no-mic cases; counted separately.
		if (m.type() === 'error' && !/Failed to load resource|Speech error/.test(t)) errors.push('console: ' + t);
	});
	await p.setViewport(viewport);
	if (iwer) await p.evaluateOnNewDocument(iwer + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
	await p.evaluateOnNewDocument(() => {
		if (!sessionStorage.getItem('__micSeeded')) { sessionStorage.setItem('__micSeeded', '1'); localStorage.removeItem('gs.micUsed'); }
		const T = (window.__micT = { gum: 0, gumOk: 0, gumErr: [], streams: [], recStarts: 0, recStops: 0 });
		const md = navigator.mediaDevices; const o = md.getUserMedia.bind(md);
		md.getUserMedia = async (c) => { T.gum++; try { const s = await o(c); T.gumOk++; T.streams.push(s); return s; } catch (e) { T.gumErr.push(e.name); throw e; } };
		const MR = window.MediaRecorder;
		window.MediaRecorder = class extends MR { start(...a) { T.recStarts++; return super.start(...a); } stop() { T.recStops++; return super.stop(); } };
		T.liveTracks = () => T.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length;
	});
	if (before) await before(p);
	// Stub the API with the CDP Fetch domain, scoped to /api/* only. Puppeteer's
	// setRequestInterception() pauses *every* request, and requests made from the
	// Whisper Web Worker (ORT wasm) never reach page.on('request'), so they hang
	// forever. Pattern-scoped Fetch leaves worker/CDN traffic alone.
	// /api/chat is ALWAYS stubbed — never hit a live chat backend from tests.
	const cdp = await p.createCDPSession();
	await cdp.send('Network.enable');
	await cdp.send('Fetch.enable', { patterns: [{ urlPattern: new URL(BASE).origin + '/api/*', requestStage: 'Request' }] });
	const json = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
	cdp.on('Fetch.requestPaused', async (ev) => {
		const u = new URL(ev.request.url);
		const reply = (o) => cdp.send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: json(o) }).catch(() => {});
		if (u.pathname === '/api/backends') return reply({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' });
		if (u.pathname === '/api/community-scenes') return reply({ scenes: [] });
		if (u.pathname === '/api/chat' || u.pathname === '/api/theme-chat') {
			let text = '', raw = ev.request.postData;
			if (!raw && ev.request.hasPostData && ev.networkId) { try { raw = (await cdp.send('Network.getRequestPostData', { requestId: ev.networkId })).postData; } catch (e) { /* ignore */ } }
			try { const body = JSON.parse(raw || '{}'); const last = (body.messages || []).filter((m) => m.role === 'user').pop(); const c = last && last.content; text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : ''; } catch (e) { /* ignore */ }
			chats.push(text);
			return reply({ content: [{ type: 'text', text: 'Mock reply.' }] });
		}
		return cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
	});
	await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
	await sleep(1500);
	const mic = () => p.evaluate(() => {
		const btn = document.getElementById('desktop-mic-button'); const st = document.getElementById('gs-mic-status');
		const hud = document.getElementById('gs-vr-hud-mic');
		const r = st.getBoundingClientRect(); const br = btn.getBoundingClientRect();
		return { ...window.__gsMic.state(), btnClass: btn.className, ariaPressed: btn.getAttribute('aria-pressed'), statusText: st.textContent, statusHidden: st.hidden, statusState: st.dataset.state, statusRect: [r.x, r.y, r.width, r.height].map(Math.round), btnRect: [br.x, br.y, br.width, br.height].map(Math.round), hud: hud.hidden ? '' : hud.textContent, gum: __micT.gum, gumOk: __micT.gumOk, gumErr: __micT.gumErr, liveTracks: __micT.liveTracks(), recStarts: __micT.recStarts, recStops: __micT.recStops, oldStatusHidden: document.getElementById('status').hidden };
	});
	// Poll until pred(state) or timeout; returns the last state.
	const until = async (pred, ms = 60000, step = 250) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await mic(); if (pred(s)) return s; await sleep(step); } return s; };
	return { b, p, errors, chats, log, mic, until };
}
