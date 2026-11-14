# Controls tab — key remapping, Player height, Custom Controls

Serve `site-source` with fake keys (`CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3741 node server.js`), then:

    BASE=https://localhost:3741 SHOT_DIR=/workspace/gs-controls-remap-shots node test.mjs

`/api/chat` is stubbed with a reply whose `vr-exec` block calls
`gsControls.defineCustomScheme(...)` (a drivable box); nothing reaches an LLM
and Community writes are blocked.

Desktop (1280×800):
- Camera | Custom Controls sub-tabs; no Trackball; Map's list (4 pan actions,
  arrow defaults), read-only mouse/touch list, Reset disabled at defaults.
- Capture (press I, press ArrowUp into the alternate slot), typing names
  ("Space", "k" → K, partial names marked invalid), Backspace clears, Esc
  restores; saved to `gs.controlKeys.v2`; the remapped key pans and the old
  one doesn't.
- Duplicate warning and highlighted fields; Reset to defaults.
- Fly (13 actions): remap survives reload, new key moves, old key doesn't,
  untouched keys still work. First person: primary + alternate keys.
- Player height: type, ▲/▼, invalid text, clamp to 0.3–5 m, "170cm",
  hold-to-repeat, walking keeps the height, reload, Reset Camera View, Reset.
- Custom Controls empty state + "Describe a scheme in chat"; the stubbed chat
  reply populates the tab (key fields, slider + number, switch, list),
  cameraMode off, keys drive the box, remapping a scheme key, live
  onChange / onPress, duplicate warning, localStorage, re-define keeps
  values, invalid defaults rejected, Reset, Clear scene removes it and
  restores Map, a scene file's `customControls` values apply on load.

Phone (390×844): no horizontal overflow, ≥44 px key fields / sub-tabs /
height buttons, one-row sub-tabs and header, duplicate warning, Custom
Controls populated and fitting.

First person D regression (bug report "the D key isn't working"): fresh
storage D/A/W/S and the arrows move the right way (measured in the camera's
frame); a key field leaves focus after capturing so a later W can't rebind
it; help text shows remapped keys; clearing every key of Move right restores
D / ArrowRight; a stale v1 layout (Move right = W) is dropped; a partial v2
layout (blank Move right, `'w'`, junk) falls back to defaults. Map: a
remapped-away arrow doesn't move the camera at all.
