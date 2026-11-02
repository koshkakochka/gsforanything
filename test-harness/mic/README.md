# Mic (speech-to-text) suite

Headless Chrome with a fake microphone (`--use-fake-device-for-media-stream`,
`--use-file-for-fake-audio-capture=<wav>`), puppeteer-core 24.43.1, and IWER
(Meta Quest 3) for the VR part. **`/api/chat` is always stubbed** (CDP Fetch,
scoped to `<BASE origin>/api/*`), so no test ever reaches a real model.

Setup: `npm install` (or symlink `node_modules` to `../vr-windows/node_modules`),
`python3 make-fixtures.py` (noise / continuous / beep WAVs), then serve
`site-source` with fake keys:

    CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3493 node server.js
    BASE=https://localhost:3493 node test.mjs   # desktop + phone (~5 min, downloads Whisper once)
    BASE=https://localhost:3493 node vr.mjs     # IWER Quest 3

Screenshots go to `$SHOT_DIR` (default `/workspace/gs-mic-shots`). The Whisper
model is cached in `$MIC_PROFILE` (default `/tmp/gs-mic-test-profile`); the
first desktop scenario always uses a fresh profile to exercise the download.

`test.mjs`: fresh profile + speech (loading % → listening → transcribed and
auto-sent), noisy room, noise only (nothing sent, idle recording rotated),
beeps (no `[BEEP]`-style filler sent), continuous sound (cut at ~15 s),
permission denied, no microphone, phone 390×844.

`vr.mjs`: Enter VR asks for the mic only when `gs.micUsed` is set and the
permission is still "prompt"; ray-click 🎤 in the VR menu (status line in the
menu + HUD, speech sent); push-to-talk on A; blocked mic in VR shows the
Quest "Settings › Apps › Browser" hint.

Note: don't use Puppeteer's `setRequestInterception(true)` here — it stalls
the Whisper Web Worker's ONNX wasm fetches (the model never reports ready).
