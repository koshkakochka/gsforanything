# Community HDRI test

Checks that the Environment tab's 360 / HDRI environment is saved with a
Community upload (and Share link) and restored when the scene is opened fresh.

- `unit.mjs`: the shared `site-source/sceneHdri.js` helpers (validation, the
  server-set file URL, share signatures). `node unit.mjs`
- `vercel-sim.mjs`: `site-source/server.js` as on Vercel with a binary-safe
  in-memory Vercel Blob fake, on `http://localhost:3611` (`SIM_PORT`).
- Worker: `cd worker && ./sync-public.sh && npx wrangler dev --port 3612 --persist-to /tmp/hdri-kv --ip 127.0.0.1` (Node 22).
- `api.mjs`: upload with a URL HDRI, a file HDRI (POST + one-shot
  `PUT /api/community-scenes/:id/hdri`), invalid / legacy / oversized / late /
  repeated uploads, rename. `HOSTS=vercel-sim=http://localhost:3611,cf=http://127.0.0.1:3612 node api.mjs`
- `test.mjs` (puppeteer-core + Chrome): loads a scene file and a local `.hdr`,
  uploads it, then in fresh browser contexts opens `/e/:id`, `/s/:id` and the
  Community list and checks `scene.environment` / `scene.background`, the
  background-off URL case, legacy scenes, the viewer's own saved HDRI and that
  share links of unchanged scenes are reused. `SHOTS=/dir` saves screenshots.

```bash
python3 make-hdr.py /tmp/sunset.hdr sunset && python3 make-hdr.py /tmp/teal.hdr teal
node vercel-sim.mjs &
HOSTS=vercel-sim=http://localhost:3611,cf=http://127.0.0.1:3612 node api.mjs
HOSTS=vercel-sim=http://localhost:3611,cf=http://127.0.0.1:3612 SHOTS=/tmp/hdri-shots node test.mjs
```
