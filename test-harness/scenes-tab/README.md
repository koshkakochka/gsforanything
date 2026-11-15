# Scenes tab + Share & Export tab

The Scenes tab shows only two buttons (Import .vrscene.json and Clear All From
Scene). Share link and 3D model export live on their own **Share &
Export** menu tab, reachable from the hamburger on desktop, phone and in the
VR menu. There is no Download .vrscene.json / Save to Device section on that
tab.

    BASE=https://localhost:3588 SHOT_DIR=/workspace/gs-scenes-tab-shots node test.mjs

`/api/chat` and other `/api/*` routes are stubbed. Dummy keys only. Does not
touch production KV or Blob.
