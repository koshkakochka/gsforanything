# Game controller + VR controller bindings (inputBindings.js)

Serve `site-source` with fake keys (`CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3762 node server.js`), then:

    BASE=https://localhost:3762 SHOT_DIR=/workspace/gs-padxr-shots node test.mjs   # SKIP_VR=1 skips IWER

`navigator.getGamepads` is mocked (one standard-mapping Xbox pad the test
drives); the headset is IWER's Quest 3 (mocked XR input sources). `/api/chat`
is stubbed with a car scheme (keys only, plus an explicit `gamepad: 'Y', xr: 'B'`
horn). Writes the built-in table to `$SHOT_DIR/builtin-bindings.json`.

- Every built-in action has a pad binding; XR equivalents for all but Fly
  look / roll / slow (head-driven); drag / wheel gestures have pad + VR rows.
- UI rows show Gamepad / VR fields (remappable: see controller-remap); Map controller rows.
- Map: d-pad pans, left stick pans, right stick rotates, RT zooms; deadzone;
  typing blocks the pad. Orbit d-pad pans. Fly: left stick forward, d-pad
  roll, left stick press Slow, RB up. First person: left stick walks.
- Custom Controls: generated bindings, explicit ones kept, chips, pad
  isDown / value / onPress, deadzone, typing, claimed d-pad + left stick stop
  driving the camera (right stick still rotates), bad binding rejected,
  custom camera mode params + `m.sticks()` from the pad.
- Custom Controls rows read Label | Key | Gamepad | VR (generated and explicit,
  on the key's line on desktop); the sample third-person scene's "Custom 3rd
  Person Controls" card (desktop + phone screenshots), Gamepad A = Jump.
- Phone: Fly rows and the Custom Controls card fit.
- VR: locomotion unchanged without bindings; gsXrInput deadzone; the scheme's
  left / right sticks press its params and are taken from locomotion; removing
  the scheme gives them back; right trigger fires a binding when pointing
  away but clicks the menu (and not the scene) when pointing at it; an
  explicit B binding fires and GS's ray toggle steps aside.
