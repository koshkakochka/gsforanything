# Camera capture + AR / VR toggle headless test

Checks the 📷 button (photoCapture.js) and the AR / VR mode toggle with
puppeteer-core + Chrome's fake camera (`--use-fake-device-for-media-stream`,
`--use-fake-ui-for-media-stream`). `/api/*` is always stubbed with the CDP
Fetch domain, so nothing reaches a live model or production KV.

- Desktop: 📷 sits right after 📎; the live preview opens between the message
  bubbles and the button row; Take photo attaches `camera-YYYYMMDD-HHMMSS.jpg`
  like an upload and it is sent as `image/jpeg` with the next message; ✕ (or
  📷 again) stops every track.
- Camera selection with a mocked `enumerateDevices` (three cameras): switching
  reopens with `deviceId: {exact}`, the choice is remembered.
- Quest Browser user agent with Quest labels (`camera 2 1, facing back`…):
  a passthrough camera is the default, labels are friendly, not mirrored.
- Errors (NotAllowedError / NotFoundError, Quest hint): in-app message in the
  panel, shutter disabled, no native dialogs.
- Phone (390x844 touch): 📷 behind More (+), back camera, layout.
- AR / VR toggle with a mocked `navigator.xr` (both / VR only / AR only /
  none): disabled option, ENTER AR / ENTER VR, `requestSession` mode,
  `gs.xrMode` persistence, the Env tab's AR / VR buttons.
- IWER Meta Quest 3: ray-click 📷 in the VR menu, the live preview quad on the
  menu window, ray-click Take photo / ✕; an `immersive-ar` session is
  transparent with no sky and the Env tab switches VR colour / AR live; Enter
  VR asks for the camera first only for people who used it before.

```bash
cd site-source && CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3521 node server.js &
cd test-harness/camera-capture && npm i   # or symlink node_modules (puppeteer-core, iwer)
BASE=https://localhost:3521 SHOT_DIR=/tmp/cam-shots node test.mjs
```

- Quest Browser permission behaviour (mocked `mediaDevices`, like a real
  Quest 3: only `camera 0, facing front` and OverconstrainedError for
  `facingMode: {exact: 'environment'}` until Headset cameras is allowed; then
  `camera 1/2, facing back`): first request asks for the environment camera;
  "Quest passthrough (left/right)" labels; a late list with no devicechange is
  picked up; avatar-only shows the inline hint + "How to turn it on" gsDialog
  and switches to passthrough once it's allowed; a chosen avatar camera is
  kept; in VR the hint and the passthrough preview quad are on the VR menu;
  Enter VR asks for Headset cameras first when "granted" lists only the avatar
  camera.

Not covered (needs a real Quest 3): the real passthrough camera frames, the
Headset cameras permission prompt, and whether Quest Browser keeps the camera
running inside an immersive session.
