# vr-input

Headless checks, using puppeteer-core 24.43.1 and IWER emulating a Meta Quest 3, for:

1. **Top bar.** Enter VR (or Cardboard VR / VR NOT SUPPORTED) and the **GS vX** version button sit side by side in the window header, above the tabs.
   - Checked at desktop 1600 / 1280 (no WebXR), iPhone 390, Android 360 (WebXR), Android landscape 844×390 and tablet 820.
   - The bar must not overlap the expand/minimise buttons.
   - The page-level Hide UI button is not shown while the menu is open;
     minimize hides the menu and Show UI brings it back.
   - Touch targets must be 44px.
   - Nothing may be left at the bottom of the page.
   - The version button still opens the picker.
   - The header still drags the window.
   - Default and 300px-wide windows keep one 49px header row (labels go compact below 345px); at the 280px minimum width the bar wraps onto its own row.
2. **Exit VR.** In VR, a large red **Exit VR** button sits at the top of the menu on every tab, and it's painted red into the headset texture.
   - A ray click calls `XRSession.end()` once.
   - The page is then back in 2D: VR windows hidden, window un-parked, Enter VR shown again.
3. **Code tab scrolling in VR.**
   - The thumbstick (with locomotion on) scrolls the code under the ray and doesn't move the player.
   - The highlight layer follows the scroll.
   - Scrolling clamps at the end, and the last line is visible and painted.
   - A scrollbar thumb is painted.
   - Trigger-drag scrolls too. Hand pinch uses the same select path.
4. **Origin gizmo grab.** Grip with the ray on the gizmo grabs it.
   - The gizmo gets an amber halo, locomotion doesn't cycle and the player doesn't move.
   - The scene's origin rotation follows `controllerQ_now × controllerQ_start⁻¹ × base`.
   - Release stops it.
   - The left hand works too.
   - Grip elsewhere still cycles locomotion (right hand).

```
npm i
BASE=https://localhost:3711 OUT=/tmp/vr-input-shots node test.mjs
```

`OUT` saves page screenshots and headset-texture PNGs.
