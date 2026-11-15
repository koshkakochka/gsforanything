# vr-map-grip-zoom

VR Map controls: left stick pans, both grips spread / pinch to zoom
(`site-source/vrGripZoom.js`, `updateVrGripZoom` in main.js).

    node unit.mjs                                   # the gesture maths, no browser
    # serve site-source with fake keys: CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3791 node server.js
    npm i && BASE=https://localhost:3791 OUT=/tmp/shots node test.mjs

Headless Chrome (puppeteer-core 24.43.1) with IWER emulating a Meta Quest 3
(mocked XR input sources: controller positions, squeeze and thumbstick).
`/api/chat` is stubbed; nothing touches production storage.

- Controls → Map: pan keys' VR fields are the left stick ↑ ↓ ← →; Zoom in /
  Zoom out rows show "VR: both grips, spread / pinch" (not a remappable
  field); a "Zoom in / out (VR gesture)" row with an On switch (saved as
  `gs.vrMapGripZoom` = '0' when off); the Map help text mentions it.
- Pan: left stick forward / right / diagonal moves the rig level in both
  axes; 16 m up it pans ~11× faster (× head height / 1.6 m).
- One grip alone (either hand, hands moving) does nothing; the right grip
  alone still cycles locomotion, on release.
- Both grips: pivot = ground point along the gaze (also with the rig moved
  and turned); spread 0.30 → 0.60 m → distance × 0.3 / 0.585 (1.5 cm
  deadzone subtracted), pinch 0.60 → 0.30 m → × 0.6 / 0.315, the rig moves
  exactly that much; no locomotion cycle; release ends it, no drift.
- 1 cm of hand movement: no zoom (deadzone). Smoothing: in-between values.
- Clamp at Map's 0.3 m minimum; pinching from there zooms back out.
- Off switch, a scene scheme binding `L-Squeeze`, a Map VR row remapped to a
  grip, and Orbit all stop the gesture; removing the scheme / Reset VR
  bring it back.
- Screenshots: Controls tab (keys, VR rows, VR rows with the switch off),
  the VR mirror after a zoom, and the VR menu texture of the Map rows.
