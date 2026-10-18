# Render distance: desktop vs VR

`test.mjs` checks that the windowed view (desktop 1280×800 and phone 390×844) draws
everything the VR view draws. VR runs in an emulated Meta Quest 3 session
([IWER](https://github.com/meta-quest/immersive-web-emulation-runtime)), entered
through the real ENTER VR button.

Checks:
- the `gsRenderDistance` defaults are near 0.1 and far 100
- Orbit: far = 100 + the camera's distance from the VR eye, by default and zoomed out to 50 m
- First person: the same, and exactly 0.1 / 100 when the camera sits at the eye
- VR is unchanged: XR camera and session `depthNear` / `depthFar` are 0.1 / 100
- marker boxes at 50 m, 98 m and 140 m from the VR eye: 98 m is drawn everywhere, 140 m nowhere
- scene code `camera.far = 1000` applies to VR and desktop, and going back to 100 works
- no console errors

```bash
npm i            # iwer + puppeteer-core
BASE=https://localhost:3488 node test.mjs   # any GS server; needs /usr/bin/google-chrome
```
