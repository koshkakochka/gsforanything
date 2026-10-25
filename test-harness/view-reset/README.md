# View reset on refresh

A page refresh puts the whole view back to its defaults; what the user made or
chose on purpose survives. puppeteer-core + Chrome, one browser profile per
device so storage survives the reloads.

`npm install`, serve the site with the Vercel simulator (the share-link part
needs Community uploads):

    cd ../creation-context && SIM_PORT=3601 node vercel-sim.mjs &
    cd ../view-reset && BASE=http://localhost:3601 node test.mjs
    ONLY=desktop|phone|tablet|share node test.mjs      # sections (comma-separated)
    SHOT_DIR=/some/dir node test.mjs                  # default /workspace/gs-viewreset-shots

Devices: desktop 1280x800 and 1920x1080 (mouse), phone 390x844 and tablet
820x1180 (CDP touch). Per device:

- Changes the view: camera moved / turned / zoomed (and the Orbit/Map target),
  window dragged and corner-resized, chat history scrolled, Prompt sub-tab,
  Community → Themes, Environment tab, origin rotated, Snap 15° and Live code
  on, background hue / saturation / brightness, window expanded. Reload ->
  window at its default spot and size, not expanded, default tab and sub-tabs,
  default camera, unrotated origin (gizmo fields too), default toggles and
  sliders, nothing scrolled, no view state in storage.
- Again with the UI hidden (Hide UI) and the window only dragged / resized.
- A window rect and origin rotation stored by an older build are ignored and
  cleared.
- Kept across every reload: custom chat prompt (still active), theme with
  Remember theme on, camera mode (Map), twin sticks off, VR window anchor
  (Follow head), 2D/3D choice, dependencies (p5 on), publish-context
  preference, saved HDRI URL, Files library (IndexedDB).

Share: `/e/:id` opens the scene with its saved origin rotation on first load
(in a browser whose own view had been changed) and at the default camera; a
refresh of `/e/:id` re-opens it the same way; `/s/:id` display-only and
`?scene=id` too. No console errors throughout.
