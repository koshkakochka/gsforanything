# Canvas resize / zoom

The three.js render canvas must always fill the visible page after a window
resize, orientation change, pinch-zoom or browser zoom, iOS toolbar
show/hide, and devicePixelRatio change. The drawing buffer must match the
CSS box times the (capped) pixel ratio.

```
BASE=https://localhost:3558 SHOT_DIR=/workspace/gs-canvas-resize-shots node test.mjs
```

Covers a 390×844 phone, rotation to 844×390, a 320×600 window, a
deviceScaleFactor change, a visualViewport-only growth (zoom out / toolbar
hide, no `window.resize`), and Hide UI.
