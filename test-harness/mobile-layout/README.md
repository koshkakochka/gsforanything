# Phone layout + on-screen keyboard

`npm install`, serve `site-source` (e.g. https://localhost:3488), then:

    BASE=https://localhost:3488 node test.mjs
    DESKTOP_REF=https://localhost:3990 node test.mjs   # also compare the desktop layout with an older build
    SHOTS_ONLY=1 SHOT_PREFIX=before BASE=<older build> node test.mjs   # screenshots only
    ONLY=390x844:android node test.mjs                 # one phone / keyboard style

Phones: 390x844 and 412x915 portrait, 844x390 and 915x412 landscape. The
keyboard is simulated two ways, sliding up over a few frames:

- **android**: the window shrinks (Chrome with `interactive-widget=resizes-content`).
- **ios**: only `visualViewport.height` shrinks (Safari); the layout viewport stays.

Checks, per phone and keyboard style:

- `html.gs-phone` is on; every visible tap target in the panel, dock and
  Hide UI (all nine tabs' panels) is at least 44x44, and nothing covers one.
- The nine tabs are one horizontally scrollable row; the last one is reachable.
- "+" opens and closes attach / files / mic / history (44px).
- Keyboard up in the chat input: compact layout, the input and Send are fully
  inside the visible area and at its bottom, nothing covers them, the dock /
  Hide UI / tabs are hidden, recent messages are visible, typing works.
- Send with the keyboard up: the message goes out, the field keeps focus, and
  the newest reply is in view.
- Android: the canvas is not resized while the keyboard animates, and matches
  the window again after it closes.
- Keyboard dismissed while the field keeps focus: the full layout and the
  panel's previous size come back; tapping the field again brings it back.
- Blur restores the tabs, dock and Hide UI.
- Theme chat input and the Code editor (caret line in view, Apply reachable)
  also stay above the keyboard.
- No console errors.

Desktop (1280x800 and 700x800, mouse): no phone / keyboard classes even with
the input focused, and with `DESKTOP_REF` the layout of the panel, tabs,
input, buttons and dock is pixel-identical to the older build.

Screenshots go to `$SHOT_DIR` (default `/workspace/gs-mobile-shots`).
