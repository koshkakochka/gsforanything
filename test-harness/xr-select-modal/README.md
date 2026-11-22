# xr-select-modal

Custom dropdowns in immersive AR/VR (`site-source/xrSelect.js`) and the shared
modal template (`site-source/gsModal.js`) used by every in-app dialog.

- **static**: `gsModal.js` and `xrSelect.js` ship to the Worker and Vercel;
  dialogs, publish, export, share, rename, version, model export and p5 import
  open through `openGsModal`.
- **desktop**: native `<select>` stays native (no custom popup); `openGsModal`
  renders a titled card with actions; `gsAlert` still uses `#gs-dialog`.
- **vr** (IWER Quest 3): opening a select paints a listbox inside the
  html-in-canvas source; a controller ray can pick an option; a `gsModal`
  card appears in the shared dialog VR window.

```
cd test-harness/xr-select-modal
BASE=https://localhost:3488 node test.mjs
ONLY=static,desktop,vr BASE=... node test.mjs
SHOT=/workspace/gs-pr59-shots/xr-select-popup.png BASE=... node test.mjs
```
