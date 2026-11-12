# Meta Settings + hamburger menu

Checks that the version and Cardboard VR buttons live in the Meta Settings
tab, and that every tab is reached from a hamburger at the top left of the
menu window (desktop, phone, and an IWER Quest 3 VR session).

```
BASE=https://localhost:3540 SHOT_DIR=/workspace/gs-meta-settings-shots \
  node test.mjs
```

`/api/*` is stubbed. Needs puppeteer-core, IWER, and a local HTTPS build.
