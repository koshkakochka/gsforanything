# Cloudflare Worker patches

> **Since 0.973 the Worker source is in this repo (`worker/`) and `0001` is already
> applied to `worker/index.js`.** Edit `worker/index.js` directly; this folder is kept for history.

The Cloudflare Worker (`gs`, https://gsforanything.com; fallback https://gs.krossruiz.workers.dev) is deployed from a
separate local project (`worker/index.js` + `public/` + `wrangler.jsonc`) that is
not in this repo. API changes the Worker needs are kept here as patches against
that project's `worker/index.js` so they can be reviewed with the rest of a
feature and applied at deploy time.

Apply from the Worker project root, then deploy as described in `DEPLOY.md`:

```bash
patch -p1 --dry-run -i /path/to/gs/worker-patches/0001-scene-creation-context.patch
patch -p1 -i /path/to/gs/worker-patches/0001-scene-creation-context.patch
```

## 0001-scene-creation-context.patch

Stores a community scene's creation context (chat log + info log, see
`site-source/creationContext.js`) under its own KV key, mirroring what
`site-source/server.js` does with Vercel Blob:

- `POST /api/community-scenes`: if the body has `creationContext`
  (`{ format: 'gs-creation-context', version, encoding, data, summary }`), it is
  validated (400 if malformed, 413 over 20 MB) and written to KV key
  `scene:<id>:context`. The scene record `cs:<id>` keeps a small stub
  `{ format, version, encoding, stored: 'separate', url: '/api/community-scenes/<id>/context', key, size, summary }`,
  so the scene itself and the `cs-index` list stay small.
- `GET /api/community-scenes/:id/context` (new): returns the stored envelope;
  falls back to an inline `creationContext` for scenes uploaded before the
  patch; 404 when the scene has none.

Without the patch everything still works: the Worker stores the whole upload,
so the context stays inline in `cs:<id>` (well under the 25 MiB KV value limit,
since the client caps the encoded context at 3 MB) and the client reads it from
there. The patch only moves it to its own key so it loads lazily.

Tested locally with `wrangler dev` (local KV) against both the patched and the
unpatched Worker. Not deployed.
