# AR | VR toggle in the headset menu

Checks the AR | VR toggle inside an XR session on an IWER Meta Quest 3. The
toggle lives in the window's top bar (`#gs-xr-mode` in `#gs-dock`), which is
the top of the VR menu window painted into the headset, so it is the same
element and setting (`gs.xrMode`) as on desktop. `/api/*` is always stubbed
with the CDP Fetch domain (no live AI, no KV).

- In a VR session the toggle shows next to Exit VR with VR selected and is
  part of the painted menu window (the canvas is dumped to PNG).
- Ray-click AR: the VR session ends and an `immersive-ar` session starts at
  once (passthrough, clear alpha 0); the toggle shows AR; saved.
- Ray-click VR in the AR session: colour sky live, same session; AR again
  brings passthrough back. Exit VR: the desktop button reads ENTER AR.
- Fallback: the next `requestSession` is made to reject (NotAllowedError):
  an in-app dialog ("needs one more tap", Enter AR) shows on the page and
  its button starts AR. No native dialogs.
- Headset without `immersive-ar`: AR disabled in the headset menu; choosing it
  through the API / Env tab shows an in-app message and stays in VR.
- The Env tab's AR / VR buttons in a session behave the same.

```bash
cd site-source && CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3531 node server.js &
cd test-harness/xr-menu-mode && ln -s /workspace/gs-test-deps/node_modules .   # puppeteer-core, iwer
BASE=https://localhost:3531 SHOT_DIR=/tmp/xr-menu-shots node test.mjs
```

Not covered (needs a real Quest 3): whether Quest Browser accepts the
immediate `requestSession('immersive-ar')` after `end()` from a controller
click (if it doesn't, the one-tap dialog is what you get).
