# Export permission test (and Embed removal)

Checks the per-scene **Allow exports / Don't allow exports** choice made on
Community upload, and that the removed **Embed** feature stays gone. (This
suite used to be `embed-export`.)

- `unit.mjs`: `site-source/sceneExportPolicy.js` (flag parsing, owner
  key/hash, public record) and `legacyEmbedRedirectPath` (old `/embed/:id` ->
  `/s/:id`, bad ids -> `/`); `embedExport.js` no longer exists. `node unit.mjs`
- `api.mjs`: per host, upload with/without `allowExport`, flag persisted on
  the record and in the list, owner key -> `isOwner`, hash never served, no
  `embedUrl` in responses, `/embed/:id` answers `302` -> `/s/:id` (allowed,
  exports off, missing, `?vr=0`; bad id -> `/`), `frame-ancestors 'self'` on
  `/s/:id` of no-export scenes, ownership can't be spoofed on upload, only the
  owner key can change the flag (PATCH), rename keeps it.
- `test.mjs` (puppeteer-core + Chrome): the Share & Export tab has the link,
  "Allow others to export" and 3D formats but no Embed section (desktop and
  390x844 phone), Community rows have no Embed button; creator uploads one
  scene with exports on and one with exports off (Community checkbox mirrored
  in the Share tab), owner rows get an Allow/Block exports toggle; another
  browser opening the no-export scene gets disabled model exports, blocked
  `.vrscene` export / Save to Device / re-upload (also after edits), no Merge;
  an old `/embed/:id` link lands on the view-only `/s/:id` page; an old
  snippet inside another origin's page (a tiny local server on `HOST_PORT`,
  default 3639) follows the redirect and shows the share page, while a
  no-export scene stays blocked by CSP. `/api/chat` and `/api/backends` are
  always stubbed. `SHOTS=/dir` saves screenshots.

Local servers only (never production KV / Blob):

```bash
cd ../community-hdri && SIM_PORT=3631 node vercel-sim.mjs &
cd ../../worker && ./sync-public.sh && npx wrangler dev --port 3632 --persist-to /tmp/perm-kv --ip 127.0.0.1 &   # Node 22
cd ../test-harness/export-permission
node unit.mjs
HOSTS=vercel-sim=http://localhost:3631,cf=http://127.0.0.1:3632 node api.mjs
HOSTS=vercel-sim=http://localhost:3631,cf=http://127.0.0.1:3632 SHOTS=/tmp/perm-shots node test.mjs
```
