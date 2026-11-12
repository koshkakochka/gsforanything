# Render tab (SBS VR180 screenshot + recording)

```
BASE=https://localhost:3540 SHOT_DIR=/workspace/gs-render-tab-shots node test.mjs
```

Checks FOV validation, a stereo side-by-side screenshot (2:1 PNG/JPEG), a
non-empty MediaRecorder blob in headless Chrome, and the tab in the hamburger
(desktop, phone, IWER VR). `/api/*` is stubbed.
