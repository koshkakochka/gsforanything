# Orbit origin + on-screen twin joysticks

`test.mjs` runs at desktop (1280×800, mouse) and phone (390×844, touch) and checks:

- Orbit pivot is the scene origin (0,0,0) on first load, after Clear scene, after loading a
  `.vrscene` (`box.vrscene`), after Reset Camera View, after the gamepad View button, and after
  First person → Orbit. Both the `gsOrbit.pivot()` value and the *measured* pivot (drag to orbit,
  intersect the view rays before/after) must agree.
- Arrow keys in Orbit (OrbitControls' own key panning) move the pivot while the rig stays put, and the camera still circles that pivot.
- The desktop far plane still matches VR (`gsRenderDistance.far` + camera-to-VR-eye distance).
- Sticks: hidden in Orbit / Off / VR, shown in First person (and Fly, see `../camera-controls`); bottom corners clear of the dock and chat;
  low opacity, ≤ 100 px, fade when idle; left stick moves forward/back at gamepad speed with the
  gamepad deadzone; right stick yaws/pitches; two fingers at once (phone); taps beside the sticks
  reach the canvas; UI and WASD still work; the Controls-tab "Show on-screen joysticks" option
  hides them and is remembered across reloads.
- No console errors. Saves a phone screenshot (`SHOT=...` to override the path).

```bash
npm i            # iwer + puppeteer-core
BASE=https://localhost:3488 node test.mjs   # any GS server; needs /usr/bin/google-chrome
```
