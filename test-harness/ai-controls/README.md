# AI-described controls (aiControls.js)

Controls → Camera → "Describe a control" (per built-in mode) and Controls →
Custom Controls (per scene). Never calls a real AI: `/api/chat` is stubbed
with canned `gs-control/1` definitions picked from words in the description.

    node unit.mjs     # interpreter / validator, no browser

Serve `site-source` with fake keys (`CLAUDE_API_KEY=dummy OPENAI_API_KEY=dummy PORT=4417 node server.js`), then:

    BASE=https://localhost:4417 SHOT_DIR=/workspace/gs-ai-controls-shots node test.mjs   # SKIP_VR=1 skips IWER, ONLY_VR=1 only VR
    BASE=https://dev.gsforanything.com UI_ONLY=1 node test.mjs                         # no stub: UI only, reports what generation did

`navigator.getGamepads` is mocked (a standard Xbox pad); the headset is IWER's
Meta Quest 3. Every non-GET `/api` call except the stubbed chat is blocked, so
nothing reaches KV or Blob.

- unit: validation (aliases, unsupported inputs / actions / conditions, AI
  `error`, clamped numbers, dropped fields), reply parsing, Quest 3 two-hand
  grip zoom (spread → in, pinch → out, one grip / a hand on a menu / typing →
  nothing, jitter under the deadzone, hands moving together, smoothing,
  facing-relative hand motion), gamepad LB + right stick, deadzone / clamp,
  keyboard + resetView, scene params, conflicts, static VR claims, storage.
- desktop: describe box, typing never moves the camera, the request (system
  prompt, description, mode, bindings), preview card (summary, understood
  lines, inputs, conflicts), Cancel, Apply, localStorage per mode, Q/E zoom
  runtime, toggle, Edit → regenerate in place, LB + right stick runtime,
  errors (AI unavailable, invalid JSON, unsupported input, AI says no) apply
  nothing, per-mode lists, Off note, reload, delete, tampered storage dropped,
  Custom Controls scene control → `gsControls.aiValue` / `onAiValue`, scene
  file round trip, loading another scene clears it.
- phone: tap-typed description → preview that fits → Apply.
- VR: the describe box opens the VR keyboard, typing with it, grip zoom paused
  while typing, Generate + Apply with the controller ray, then the two-hand
  grip zoom (in, out), the right grip no longer cycles locomotion, one grip
  does nothing, toggled off restores both.
