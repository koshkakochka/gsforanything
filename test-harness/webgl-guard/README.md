# WebGL guard test

Checks `site-source/webglGuard.js` in the normal app (`/s/:id`, the share
page an old `/embed/:id` link now redirects to, and `/`):

- exactly one WebGL context, no `webglcontextlost`, the scene renders;
  pixel ratio capped at 3, `preserveDrawingBuffer` kept (photo capture)
- context lost then restored once: recovers on the same context, no message
- lost again right after the restore: rendering stops with a Reload message,
  no new contexts
- WebGL refused (`getContext` returns null, like Chrome's "Web page caused
  context loss and was blocked"): full-page "3D graphics are unavailable"
  message instead of a half-built page

`/api/chat` and `/api/backends` are stubbed. Local servers only (never
production KV / Blob):

```bash
cd ../../worker && ./sync-public.sh && npx wrangler dev --port 3632 --persist-to /tmp/webgl-guard-kv --ip 127.0.0.1 &
cd ../test-harness/webgl-guard && npm i
BASE=http://127.0.0.1:3632 SHOTS=/tmp/webgl-guard-shots node test.mjs
```
