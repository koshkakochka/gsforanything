# in-app-dialogs

GS never opens a browser-native `alert()` / `confirm()` / `prompt()`. Every
question goes through `site-source/gsDialog.js`: a page modal on desktop and
phones, and a VR window (html-in-canvas, same DOM card) in front of the head
in an immersive session. Every page in this suite fails if a native dialog fires.

- **static**: no native dialog calls left in `site-source` (the p5 iframe's
  sandboxed `alert` shim excepted); the Scene / required / fix prompts tell the
  AI to use `gsAlert` / `gsConfirm` / `gsPrompt`; `worker/prompts.js` is
  regenerated; `gsDialog.js` ships to the Worker and Vercel.
- **desktop** (1280x800): Clear scene, Files → Clear all, Upload theme
  (prompt, mocked `/api/community-themes`), Chat → Prompt → Reset. Escape,
  Tab + Enter, click, backdrop (ignored), focus trap, keys don't reach the
  camera, scene-code `alert()` / `confirm()` / `gsPrompt` queueing, text-only
  messages, focus restore.
- **phone** (390x844, touch): 44px targets, tapping Cancel / OK.
- **vr** (IWER Quest 3): the dialog opens ~1.2 m in front of the head where you
  look, controller ray + trigger answers it, the menu behind it can't be
  clicked, a prompt opens the VR keyboard under the dialog and its Send key
  answers OK, leaving VR moves an open dialog to the page modal.

```
cd test-harness/in-app-dialogs && npm i   # puppeteer-core 24.43.1, iwer
BASE=https://localhost:3488 node test.mjs  # any GS server; needs /usr/bin/google-chrome
ONLY=desktop,vr BASE=... node test.mjs      # sections: static, desktop, phone, vr
SHOT_DIR=/tmp/shots BASE=... node test.mjs  # default /workspace/gs-modals-shots
```
