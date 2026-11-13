# Community grid, thumbnails, and descriptions

Checks the Community tab's responsive tile grid, save-time thumbnails (from
the scene's initial camera pose), and editable per-scene descriptions.

- `unit.mjs`: `sceneThumbnail.js` and `sceneDescription.js` helpers.
  `node unit.mjs`
- `vercel-sim.mjs`: `site-source/server.js` as on Vercel, with an in-memory
  Vercel Blob fake, on `http://localhost:3621` (`SIM_PORT`).
- `api.mjs`: upload / list / GET / PATCH and the `/api/community-scenes/:id/thumb`
  (and `/api/scenes/:id/thumb`) endpoint. The Cloudflare Worker is tested
  in-process against a mock KV (never the production `SCENES` namespace).
  `HOSTS=vercel-sim=http://localhost:3621 node api.mjs`
- `test.mjs` (puppeteer-core + Chrome, swiftshader): grid layout at desktop
  (expanded, several columns) and phone (one column) widths; saving after
  moving the camera produces a thumbnail of the *initial* pose, served by
  the endpoint; every tile has a description section (empty ones show
  "No description yet" plus Edit); edit + save/cancel + persist + reload,
  multiline and escaping, Esc/Cancel restores, guests can edit too.
  `/api/chat` is stubbed. `SHOTS=/dir` saves screenshots (desktop grid, phone
  grid, placeholder/edit states, a VR-menu htmlInCanvas paint, a sample thumbnail).

```bash
node unit.mjs
node vercel-sim.mjs &
HOSTS=vercel-sim=http://localhost:3621 node api.mjs
SHOTS=/tmp/community-grid-shots NODE_PATH=/workspace/gs-test-deps/node_modules node test.mjs
```

Never points at production KV.
