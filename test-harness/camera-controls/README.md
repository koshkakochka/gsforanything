# Desktop camera controls (stock three.js addons)

`npm install`, serve `site-source` (e.g. https://localhost:3488), then:

    BASE=https://localhost:3488 node test.mjs        # headless, desktop + phone
    BASE=https://localhost:3488 node esc-real.mjs    # headful on Xvfb :99 + xdotool

`test.mjs` (headless Chrome, IWER for the VR parts) checks:

- Map is the default with its target at (0,0,0); `window.controls`,
  `gsControls` and `gsOrbit` handles; five mode buttons with stock key help
  (Orbit, Map, Fly, First person, Off — no Trackball).
- Each mode moves the camera with its stock inputs: drag, right-drag, wheel,
  arrow-key panning (Orbit, Map), Fly W/A/S/D/R/F/Q/E +
  arrows + drag-to-look, First person W/A/S/D + arrows (with a button or
  checkbox focused), lock on canvas click, mouse look, unlock, panels clickable
  without re-locking; phone touch (one finger pan on Map, pinch zoom).
- Fly drag-to-look with raw CDP `Input.dispatchMouseEvent` (buttons=1) and raw
  touch: a 110 px drag across the canvas centre, a same-frame drag, pitch, no
  turning after release, no turning when the drag is on a panel.
- Camera at eye height (y = 1.6) on page load in every saved mode, after Reset
  and in Map.
- Typing in chat (and a focused select) never moves the camera; Off does nothing.
- Switching modes 18 times leaves the window / document / canvas listener
  counts unchanged (CDP `DOMDebugger.getEventListeners`).
- Twin joysticks only in Fly and First person; gamepad per mode, Y toggles
  Orbit / First person, View resets.
- Controls are off in VR; exiting VR returns to the default desktop view.
- Old saved values (`orbit`, `free`, `off`) map to Orbit / First person / Off;
  a saved `trackball` (removed) or an unknown value falls back to Map. An
  explicit user pick in `gs.cameraControlMode` is kept; the default is not
  written to storage until the user picks a mode.
- Desktop far plane still matches VR (`gsRenderDistance`) in every mode.
- No console errors.

`esc-real.mjs` exists because headless Chrome does not route Esc to pointer
lock: it uses real clicks and a real Esc key to check that Esc unlocks, the UI
is clickable again, and clicking a panel does not re-lock.
