# Embed export + export permission test

Checks the Share tab / Community **Embed** export (an `<iframe>` to
`/embed/:id`), the embed view itself, and the per-scene **Allow exports /
Don't allow exports** choice made on Community upload.

- `unit.mjs`: `site-source/embedExport.js` snippet helpers and
  `site-source/sceneExportPolicy.js` (flag parsing, owner key/hash, public
  record, the "embedding unavailable" page). `node unit.mjs`
- `api.mjs`: per host, upload with/without `allowExport`, flag persisted on
  the record and in the list, owner key -> `isOwner`, hash never served,
  `?embed=1` and `/embed/:id` refused (403) for no-export scenes, 404 page,
  `frame-ancestors 'self'` on `/s/:id` of no-export scenes, ownership can't be
  spoofed on upload, only the owner key can change the flag (PATCH), rename
  keeps it.
- `test.mjs` (puppeteer-core + Chrome): creator embeds an unsaved scene from
  the Share tab (uploads once, snippet, size / VR options, copy, reuse),
  uploads a second scene with exports off (Community checkbox mirrored in the
  Share tab), owner rows get an Allow/Block exports toggle; another browser
  opening the no-export scene gets disabled model exports + Embed, blocked
  `.vrscene` export / Save to Device / re-upload (also after edits), no Merge,
  in-app gsDialog messages; `/embed/:id` renders with only Enter VR (faked
  WebXR) + "Made with GS For Anything", `?vr=0`, the 403 page; the snippet
  inside another origin's page (a tiny local server on `HOST_PORT`, default
  3639) and the CSP block for framed no-export `/s/:id`; phone viewport
  dialog; the in-headset path (copied + in-app card). `/api/chat` and
  `/api/backends` are always stubbed. `SHOTS=/dir` saves screenshots.

Local servers only (never production KV / Blob):

```bash
cd ../community-hdri && SIM_PORT=3631 node vercel-sim.mjs &
cd ../../worker && ./sync-public.sh && npx wrangler dev --port 3632 --persist-to /tmp/embed-kv --ip 127.0.0.1 &   # Node 22
cd ../test-harness/embed-export
node unit.mjs
HOSTS=vercel-sim=http://localhost:3631,cf=http://127.0.0.1:3632 node api.mjs
HOSTS=vercel-sim=http://localhost:3631,cf=http://127.0.0.1:3632 SHOTS=/tmp/embed-shots node test.mjs
```
