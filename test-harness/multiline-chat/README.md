# Multiline chat inputs

The Scene and Theme chat inputs are auto-growing `<textarea class="gs-chat-textarea">`s
(`initChatTextarea` in `site-source/main.js`). `npm install` (puppeteer-core; Chrome at
`/usr/bin/google-chrome`), serve `site-source`, then:

    BASE=https://localhost:3488 node test.mjs

Screenshots go to `SHOT_DIR` (default `/workspace/gs-multiline-shots`). `/api/chat` and
`/api/theme-chat` are intercepted (no real calls). Checks:

- Desktop: one line to start (same height as the old input); Shift+Enter adds a line and
  the field grows a line at a time; long text wraps (no horizontal scroll); capped at
  7 lines, then it scrolls with the caret line in view; Enter sends the whole multi-line
  text, clears it and returns to one line; the Send button does the same; a programmatic
  `.value` write (voice input, VR keyboard) re-measures; a narrower panel re-wraps;
  WASD goes into the field, not the camera; Enter on an empty field does nothing.
- Theme chat: the same textarea behaviour; Enter sends with the newline kept.
- html-in-canvas (VR panel): the multi-line value is painted wrapped, line by line.
- Phones (390x844, 844x390, keyboard simulated by shrinking the window): 44px one-line
  input and Send; Enter on the on-screen keyboard adds a new line and Send sends (focus
  stays, back to 44px); with the keyboard up the input and Send stay visible and the
  input takes at most about a third of the visible height, so messages stay in view.
