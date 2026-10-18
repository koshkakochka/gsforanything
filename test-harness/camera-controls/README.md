# Desktop camera controls (stock three.js addons)

`npm install`, serve `site-source` (e.g. https://localhost:3488), then:

    BASE=https://localhost:3488 node test.mjs        # headless, desktop + phone
    BASE=https://localhost:3488 node esc-real.mjs    # headful on Xvfb :99 + xdotool

`test.mjs` (headless Chrome, IWER for the VR parts) checks:

- Orbit is the default with its target at (0,0,0); `window.controls`,
  `gsControls` and `gsOrbit` handles; six mode buttons with stock key help.
- Each mode moves the camera with its stock inputs: drag, right-drag, wheel,
  arrow-key panning (Orbit, Map), Trackball drag + A/S/D, Fly W/A/S/D/R/F/Q/E +
  arrows + drag-to-look, First person W/A/S/D + arrows (with a button or
  checkbox focused), lock on canvas click, mouse look, unlock, panels clickable
  without re-locking; phone touch (one finger, pinch).
- Typing in chat (and a focused select) never moves the camera; Off does nothing.
- Switching modes 18 times leaves the window / document / canvas listener
  counts unchanged (CDP `DOMDebugger.getEventListeners`).
- Twin joysticks only in Fly and First person; gamepad per mode (Trackball
  ignores it), Y toggles Orbit / First person, View resets.
- Controls are off in VR; exiting VR returns to the default desktop view.
- Old saved values (`orbit`, `free`, `off`) map to Orbit / First person / Off.
- Desktop far plane still matches VR (`gsRenderDistance`) in every mode.
- No console errors.

`esc-real.mjs` exists because headless Chrome does not route Esc to pointer
lock: it uses real clicks and a real Esc key to check that Esc unlocks, the UI
is clickable again, and clicking a panel does not re-lock.
