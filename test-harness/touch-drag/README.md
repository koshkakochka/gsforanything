# Window drag with touch (phones, tablets) + desktop mouse

`npm install`, serve `site-source` (e.g. `CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3488 node server.js`), then:

    BASE=https://localhost:3488 node test.mjs
    ONLY=phone-390x844 node test.mjs      # one device (prefix match, comma-separated)

Touch is real CDP touch input (`Input.dispatchTouchEvent`), so it goes through
Chrome's touch-action / Pointer Events pipeline like a finger.

Devices: phone 390x844 and 844x390, tablets 820x1180, 1180x820, 1024x1366,
1366x1024 (touch), desktop 1280x800 and 1920x1080 (mouse).

Per touch device:

- `html.gs-phone` only on phones; `touch-action: none` on the header only (the
  message list keeps `pan-y`); header (drag handle) at least 44px tall.
- A finger drag on the header moves the window by the finger delta and keeps
  its size (phones: the stretched panel is pinned, not squeezed). Phone
  landscape is a full-height column, so it moves sideways only.
- Dragged far off any edge: the window stays inside the visible viewport.
- The position is saved and comes back after a reload.
- Tapping a tab and the header's Expand button still works and doesn't move
  the window; an expanded window doesn't drag; restore returns to the spot.
- A finger drag in the message list scrolls it; a finger drag on the scene
  still moves the camera; neither moves the window.
- Double-tap on the header: default place and size, saved spot cleared (and
  the tap's click doesn't land on whatever is under the finger afterwards).

Phone 390x844 keyboard: after dragging the window to the bottom, focusing the
input still gives the keyboard layout with the input and Send above the
keyboard; when it closes the window is back where it was dragged.

Desktop mouse: drag by the cursor delta, clamp at the window edges (no margin,
as before), right button and header buttons don't drag, position restored after
reload, corner resize, tab clicks and scene orbit still work, double-click
resets, and the parked VR mirror (`html-in-canvas-source`) never drags.

Screenshots go to `$SHOT_DIR` (default `/workspace/gs-touchdrag-shots`).
