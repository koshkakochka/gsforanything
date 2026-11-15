# Remapping game controller + VR controller bindings (controllerBindings.js)

Serve `site-source` with fake keys (`CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3762 node server.js`), then:

    BASE=https://localhost:3762 SHOT_DIR=/workspace/gs-padxr-remap-shots node test.mjs   # SKIP_VR=1 skips IWER

`navigator.getGamepads` is mocked (one standard-mapping Xbox pad the test
drives); the headset is IWER's Quest 3 (mocked XR input sources). `/api/chat`
is stubbed with the car scheme of `gamepad-xr-bindings`; the third-person
sample registers a custom camera mode. Dummy keys; no writes leave the page.

- Stock styles (Controls → Camera): every row has a Gamepad / VR field; click
  → listening + picker; Esc and a click elsewhere cancel; a button held before
  listening is ignored until released; pad RB assigned and used at once (d-pad
  no longer pans); a ½ stick push is ignored, a full one is captured but
  refused when another row has it; picker assigns, refuses conflicts, None
  clears; global Y → RS press switches Orbit / First person; VR picker; VR
  conflict refused; reload keeps everything (`gs.controllerBindings.v1`);
  Reset gamepad / Reset VR each reset one device; Fly Move up → RT by pressing
  it, used at once; listening pauses the camera.
- Custom Controls: capture RT for Accelerate (stored per scheme param, drives
  isDown / value at once), onPress follows a remap, conflicts refused, the
  assigned press doesn't also fire the scene, VR picker, redefine + reload keep
  remaps, per-card Reset gamepad / Reset VR.
- Custom camera mode params (desktop + phone): Jump → Gamepad B (pressed on
  desktop, tapped in the picker on the phone), B jumps and A no longer; phone
  layouts fit (listening picker, remapped card, Controls tab).
- VR: trigger-click on the menu field starts listening and is not captured;
  clicking the field again cancels; B captured (ray toggle doesn't fire) and
  then moves you forward instead of the left stick; a trigger pulled while
  pointing away is captured; a Custom Controls param captured from the right
  grip fires onPress; while listening, a trigger on the menu still clicks it
  and cancels.
