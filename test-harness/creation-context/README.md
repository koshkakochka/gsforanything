# Creation context headless test

End-to-end check of saving / publishing / reopening a scene with its creation
context, on a Vercel-style server and on the Cloudflare Worker.

- `vercel-sim.mjs` runs `site-source/server.js` the way Vercel does (no
  self-signed HTTPS) with an in-memory fake of the Vercel Blob HTTP API, on
  `http://localhost:3601` (`SIM_PORT` to change). Needs the repo's `npm ci`.
- For the Worker, run `wrangler dev --port 3602 --persist-to <tmp>` in a copy of
  the Worker project (with `worker-patches/` applied, `public/` pointing at
  `site-source/`), and optionally an unpatched copy on 3603.
- `test.mjs` (puppeteer-core + Chrome; `CHROME` for the binary) mocks
  `/api/chat` and `/api/backends`, then per host: chats with an attached file
  that contains a fake API key, applies a Code-tab edit, publishes (with and
  without context), saves to the server slot, opens the scenes from Community,
  `/e/:id`, `/s/:id` and Load Saved in fresh browser contexts, and checks the
  restored chat, the viewer, the VR chat canvas text, what the next chat
  request sends, redaction, and that a legacy scene still loads.

```bash
node vercel-sim.mjs &
HOSTS=vercel-sim=http://localhost:3601,cf-patched=http://localhost:3602 node test.mjs
```
