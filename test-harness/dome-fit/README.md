# Dome fit + render distance

`test.mjs` checks `site-source/sceneFit.js` (sky / HDRI domes, `camera.far` and
fog follow the whole scene) and that the scene prompts tell the AI the same.

Checks:
- `/api/prompts` system prompt has the "Sky domes, HDRI backgrounds and render
  distance" section (`userData.gsHdriDome`, full scene bounds × 1.5, refit on
  change, GroundedSkybox floor, `camera.far` past everything, depthNear/depthFar
  in VR, fog, `gsFitScene()` + example); the custom-prompt required section and
  the fix-code prompt mention it; `worker/prompts.js` is regenerated
- fresh page: no content counted, far stays 100 + orbit offset, VR skybox 50 m
- a fixed 50 m HDRI dome (auto-detected) grows to enclose boxes 600 m out;
  `camera.far` reaches them and the dome; real-render pixel checks
- the camera zoomed far out stays inside the dome
- automatic refit (no `gsFitScene()` call) when an object is added or moved;
  back to the authored 50 m when the far objects are removed; a dome scaled by
  scene code keeps that as its minimum
- a `userData.gsHdriDome` sphere and a `GroundedSkybox` (floor stays at y ≈ 0)
- `userData.gsHdriDome = false` opt-out
- linear fog pushed out so the farthest object is at most half fogged;
  `scene.userData.gsKeepFog` opt-out
- no dome: 3 km and 40 km objects drawn; near stays 0.1 (raised to far/100000
  only for the 40 km case) and goes back
- VR (IWER Quest 3): dome encloses the 800 m object and the headset; session
  `depthFar` reaches the whole dome

```bash
cd ../community-hdri && SIM_PORT=3711 node vercel-sim.mjs &
cd ../dome-fit && npm i   # iwer + puppeteer-core
BASE=http://localhost:3711 SHOTS=/tmp/domefit-shots node test.mjs
```
- `shots.mjs`: before / after screenshots (fixed 50 m dome hiding towers vs fitted dome). `BASE=... SHOTS=/dir node shots.mjs`
