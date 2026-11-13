# Scenes tab buttons + .vrscene.json download

The Scenes tab shows only three buttons (Import .vrscene.json, Clear All From
Scene, Share & Export 3D Scene and Files). The Share tab has a button that
downloads the current scene as a `.vrscene.json` file, the same JSON format
Import accepts.

    BASE=https://localhost:3588 SHOT_DIR=/workspace/gs-scenes-tab-shots node test.mjs

`/api/chat` and other `/api/*` routes are stubbed. Dummy keys only. Does not
touch production KV or Blob.
