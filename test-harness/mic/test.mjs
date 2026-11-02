// Mic suite (desktop): visible status, permission states, model download
// progress, adaptive VAD, 15 s cap, filler filtering. /api/chat is stubbed.
//   npm i && python3 make-fixtures.py && BASE=https://localhost:3488 node test.mjs
import fs from 'fs';
import { open, check, summary, sleep, SHOT_DIR } from './common.mjs';
const shot = (p, n) => p.screenshot({ path: `${SHOT_DIR}/${n}.png` });
const clickMic = (p) => p.click('#desktop-mic-button');
const statesSeen = async (s, until) => s;

// ---- 1. fresh profile, speech: permission → model download % → listening → sent
{
	const { b, p, errors, chats, mic, until } = await open({ wav: 'speech.wav', fresh: true });
	const before = await mic();
	check('Status line hidden before using the mic', before.statusHidden && before.statusText === '');
	check('Old top-right #status badge stays hidden', before.oldStatusHidden);
	check('Mic button aria-pressed=false initially', before.ariaPressed === 'false');
	// Unit: filler filter
	const clean = await p.evaluate(() => ['[Music]', ' [BLANK_AUDIO] ', '(beeping)', '*coughs*', '♪ ♪', '[BEEP] [Music]', '', '  ', 'Add a red cube.', '[Music] make it blue', '(upbeat music) Hello there'].map((t) => window.__gsMic.cleanTranscript(t)));
	check('cleanTranscript drops [Music]/[BLANK_AUDIO]/(beeping)/*coughs*/♪/empty', clean.slice(0, 8).every((t) => t === ''), clean);
	check('cleanTranscript keeps real words and strips tags around them', clean[8] === 'Add a red cube.' && clean[9] === 'make it blue' && clean[10] === 'Hello there', clean.slice(8));
	await clickMic(p);
	const loading = await until((s) => s.statusState === 'loading' && /Loading speech model… \d+%/.test(s.statusText), 30000, 100);
	check('Shows "Loading speech model… N%" while Whisper downloads', loading.statusState === 'loading', loading.statusText);
	check('Button is pending (amber), not "listening", while the model loads', /mic-pending/.test(loading.btnClass) && !/listening/.test(loading.btnClass), loading.btnClass);
	check('aria-pressed=true once toggled on', loading.ariaPressed === 'true');
	check('Status line sits under the mic button', loading.statusRect[1] >= loading.btnRect[1] + loading.btnRect[3] - 2 && loading.statusRect[2] > 100, { s: loading.statusRect, b: loading.btnRect });
	await shot(p, 'desktop-1-loading');
	const pcts = new Set();
	const listening = await until((s) => { const m = /(\d+)%/.exec(s.statusText); if (m) pcts.add(+m[1]); return s.micListening; }, 120000, 150);
	check('Download percentage advances', pcts.size >= 2, [...pcts]);
	check('Listening only after the model is ready', listening.micListening && listening.sttModelReady, listening);
	check('Status says Listening', /Listening/.test(listening.statusText) && listening.statusState === 'listening', listening.statusText);
	check('Button turns red/pulsing (listening) when live', /listening/.test(listening.btnClass) && !/mic-pending/.test(listening.btnClass));
	check('Whisper runs in a Web Worker', listening.worker === true, listening);
	await shot(p, 'desktop-2-listening');
	// The fixture loops and listening can start mid-phrase, so the first segment
	// may be a tail ("…to the tree"); wait for a full pass of the phrase.
	const sent = await until(() => chats.some((c) => /red cube/i.test(c)), 40000);
	check('Spoken request is transcribed and auto-sent', chats.some((c) => /red cube/i.test(c)), chats.map((c) => c.slice(-80)));
	const sentState = await until((s) => s.statusState === 'sent', 3000, 100);
	check('Status confirms what was sent', /^Sent: “/.test(sentState.statusText), sentState.statusText);
	await shot(p, 'desktop-3-sent');
	await clickMic(p);
	await sleep(500);
	const off = await mic();
	check('Second click turns it off (not listening, aria-pressed=false)', !off.micListening && off.micMode === 'off' && off.ariaPressed === 'false' && !/listening|mic-pending/.test(off.btnClass), off);
	check('Microphone released (no live tracks) after turning off', off.liveTracks === 0, off.liveTracks);
	check('Status shows "Mic off" then hides', /Mic off/.test(off.statusText));
	const hidden = await until((s) => s.statusHidden, 4000);
	check('"Mic off" auto-hides', hidden.statusHidden);
	check('No console errors (speech flow)', errors.length === 0, errors);
	fs.writeFileSync(`${SHOT_DIR}/desktop-sent.json`, JSON.stringify(chats, null, 1));
	await b.close();
}

// ---- 2. speech over continuous noise louder than the old fixed threshold
{
	const { b, p, errors, chats, mic, until } = await open({ wav: 'speech-noisy.wav' });
	await clickMic(p);
	const l = await until((s) => s.micListening, 60000);
	check('Noisy room: listening (cached model)', l.micListening);
	await until(() => chats.length > 0, 40000);
	const s = await mic();
	check('Noisy room: speech still segmented and sent', chats.some((c) => /cube|tree/i.test(c)), chats);
	check('Adaptive threshold tracks the measured noise floor', s.noise > 0.0005 && s.threshold >= s.noise * 1.9, { noise: s.noise, threshold: s.threshold });
	check('No console errors (noisy)', errors.length === 0, errors);
	await b.close();
}

// ---- 3. noise only: nothing is sent, recording keeps rotating (short segments)
{
	const { b, p, errors, chats, mic, until } = await open({ wav: 'noise.wav' });
	await clickMic(p);
	await until((s) => s.micListening, 60000);
	await sleep(16000);
	const s = await mic();
	check('Noise only: nothing sent to chat', chats.length === 0, chats);
	check('Noise only: still listening', s.micListening && s.statusState !== 'error', s.statusText);
	check('Noise only: idle recording is rotated (no ever-growing segment)', s.rotations >= 2 && s.recStarts >= 3, { rotations: s.rotations, starts: s.recStarts, segments: s.segments });
	check('No console errors (noise)', errors.length === 0, errors);
	await b.close();
}

// ---- 4. periodic 1 kHz beeps: fillers like [BEEP]/[Music] are not sent
{
	const { b, p, errors, chats, mic, until } = await open({ wav: 'beep.wav' });
	await clickMic(p);
	await until((s) => s.micListening, 60000);
	await sleep(14000);
	const s = await mic();
	check('Beep tone: no bracketed filler sent', chats.every((c) => !/^\s*[\[(*♪]/.test(c)), chats);
	check('Beep tone: segments transcribed or dropped, not stuck', s.segments + s.rotations + s.dropped >= 1, s);
	console.log('   beep stats', JSON.stringify({ segments: s.segments, rotations: s.rotations, dropped: s.dropped, chats }));
	check('No console errors (beep)', errors.length === 0, errors);
	await b.close();
}

// ---- 5. continuous sound with no pause: cut at ~15 s
{
	const { b, p, errors, mic, until } = await open({ wav: 'continuous.wav' });
	await clickMic(p);
	await until((s) => s.micListening, 60000);
	const s = await until((x) => x.segments >= 1, 24000, 250);
	check('Continuous speech-level sound is cut into a segment within ~15 s', s.segments >= 1 && s.lastSegmentMs >= 14000 && s.lastSegmentMs <= 16500, { segments: s.segments, lastSegmentMs: s.lastSegmentMs });
	check('No console errors (continuous)', errors.length === 0, errors);
	await b.close();
}

// ---- 6. permission denied: visible "blocked" message
{
	const { b, p, chats, mic, until } = await open({ grant: false });
	await clickMic(p);
	const s = await until((x) => x.statusState === 'blocked', 8000);
	check('Denied: "Microphone blocked" shown under the button', !s.statusHidden && /Microphone blocked/.test(s.statusText) && /address bar/.test(s.statusText), s.statusText);
	check('Denied: button back to off (not red, aria-pressed=false)', !/listening|mic-pending/.test(s.btnClass) && s.ariaPressed === 'false', s);
	check('Denied: getUserMedia failed with NotAllowedError', s.gumErr.includes('NotAllowedError'), s.gumErr);
	await shot(p, 'desktop-4-blocked');
	// Quest wording when the UA is the Quest Browser is covered in vr.mjs.
	check('Denied: nothing sent', chats.length === 0);
	await b.close();
}

// ---- 7. no microphone
{
	const { b, p, mic, until } = await open({ before: (pg) => pg.evaluateOnNewDocument(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Requested device not found', 'NotFoundError'); }; }) });
	await clickMic(p);
	const s = await until((x) => x.statusState === 'nomic', 8000);
	check('No mic: "No microphone found" shown', /No microphone found/.test(s.statusText), s.statusText);
	await shot(p, 'desktop-5-nomic');
	await b.close();
}

// ---- 8. phone layout: status visible without opening the "+" tools
{
	const { b, p, mic, until } = await open({ grant: false, viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
	await p.evaluate(() => document.getElementById('desktop-chat-more')?.click());
	await sleep(300);
	await p.evaluate(() => document.getElementById('desktop-mic-button').click());
	await sleep(400);
	await p.evaluate(() => document.getElementById('desktop-chat-more')?.click()); // close the tools again
	const s = await until((x) => x.statusState === 'blocked', 8000);
	const vis = await p.evaluate(() => { const r = document.getElementById('gs-mic-status').getBoundingClientRect(); return r.width > 100 && r.height > 10 && r.bottom <= innerHeight && r.top >= 0; });
	check('Phone: blocked message visible with the tools row closed', vis && /Microphone blocked/.test(s.statusText), s.statusRect);
	await shot(p, 'phone-1-blocked');
	await b.close();
}
summary('mic (desktop)');
