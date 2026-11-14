# Embed WebGL context test

Loads the exact Share-tab embed snippet (`buildEmbedSnippet`) from a page
served by `python3 -m http.server` (default port 3681, never 3531), the way a
user self-hosts it, and checks inside the `/embed/:id` iframe:

- exactly one WebGL context, no `webglcontextlost`, the scene renders
- embed renderer: no `preserveDrawingBuffer`, pixel ratio capped at 2
- three iframe reloads: one context each, no loss
- context lost then restored once: recovers on the same context, no message
- lost again right after the restore: rendering stops with a Reload message,
  no new contexts (`site-source/webglGuard.js`)
- WebGL refused (`getContext` returns null, like Chrome's "Web page caused
  context loss and was blocked"): full-frame friendly message

Local servers only (never production KV / Blob):

```bash
cd ../../worker && ./sync-public.sh && npx wrangler dev --port 3632 --persist-to /tmp/embed-webgl-kv --ip 127.0.0.1 &
cd ../test-harness/embed-webgl && npm i
BASE=http://127.0.0.1:3632 SHOTS=/tmp/embed-webgl-shots node test.mjs
```
