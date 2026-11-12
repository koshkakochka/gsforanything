# Dependencies tab defaults

Checks that ammo.js is available but not selected by default, that a stored
`ammo: true` which only mirrors the old default is treated as off, that an
explicit user choice stays on, and that `gsRequire('ammo')` still loads
ammo.js for scenes that already use it.

```
BASE=https://localhost:3555 SHOT_DIR=/workspace/gs-ammo-shots \
  NODE_TLS_REJECT_UNAUTHORIZED=0 node test.mjs
```

`/api/*` is stubbed (including `/api/chat`). Needs puppeteer-core and a local HTTPS build.
