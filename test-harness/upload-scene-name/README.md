# Upload scene name

The Community → **Upload Current Scene** dialog has a labeled **Scene name**
field. The name is stored with the upload and shown as the Community tile
title. Empty values fall back to `My Scene` on the client and `Untitled` on
the server (the same default older nameless records already used). Names are
trimmed, stripped of control characters, and capped at 80 characters.

- `api.mjs`: `sceneName.js` unit checks, plus POST/GET/list on the Cloudflare
  Worker (in-process, mock KV — never production) and any `HOSTS`.
  `node api.mjs`
  `HOSTS=vercel-sim=http://localhost:3671 node api.mjs`
- `test.mjs` (puppeteer-core + Chrome, swiftshader): desktop field (label,
  focus, maxlength, Enter submits, Escape cancels, keys don't move the
  camera, empty → `My Scene`, tile title, prefill after upload), phone layout
  (44 px targets, 16 px font), the Allow others to export uploads checkbox (in this modal, not the Community tab; default on, uncheck sends allowExport:false), and a VR-window check (the card is handed to
  htmlInCanvas / vrWindows, the name field is not DOM-focused, the VR
  keyboard's Send publishes, the card paints with the shared HTML via
  htmlInCanvas — walker by default, and the WICG `drawElementImage` path
  when Chrome is launched with `--enable-blink-features=CanvasDrawElement`).
  `/api/chat` is stubbed.
  `BASE=http://localhost:3671 SHOTS=/dir node test.mjs`

Reuse `../community-grid/vercel-sim.mjs` (`SIM_PORT=3671`) for a local Vercel
server. Never points at production KV.
