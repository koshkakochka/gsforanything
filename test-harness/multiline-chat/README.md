# Multiline chat inputs

The Scene and Theme chat inputs are auto-growing `<textarea class="gs-chat-textarea">`s
(`initChatTextarea` in `site-source/main.js`). `npm install` (puppeteer-core; Chrome at
`/usr/bin/google-chrome`), serve `site-source`, then:

    BASE=https://localhost:3488 node test.mjs   # desktop, theme chat, html-in-canvas paint, phones
    BASE=https://localhost:3488 node vr.mjs     # IWER Quest 3 session (uses ../vr-windows/node_modules for iwer)

Screenshots go to `SHOT_DIR` (default `/workspace/gs-multiline-shots`). `/api/chat` and
`/api/theme-chat` are intercepted (no real calls). Checks:

- Desktop: one line to start (same height as the old input); Shift+Enter adds a line and
  the field grows a line at a time; long text wraps (no horizontal scroll); capped at
  7 lines, then it scrolls with the caret line in view; Enter sends the whole multi-line
  text, clears it and returns to one line; the Send button does the same; a programmatic
  `.value` write (voice input, VR keyboard) re-measures; a narrower panel re-wraps;
  in Fly and First person modes, W/A/S/D held in the field only type and the camera
  position doesn't change (control: the same keys with the page focused do move it); Enter on an empty field does nothing.
- Theme chat: the same textarea behaviour; fills its row; grows while typing (height
  checked after every word); capped so the theme history keeps its share; Enter sends
  with the newline kept.
- html-in-canvas (VR panel): the multi-line value is painted wrapped, line by line.
- Phones (390x844, 844x390, keyboard simulated by shrinking the window): 44px one-line
  input and Send; Enter on the on-screen keyboard adds a new line and Send sends (focus
  stays, back to 44px); with the keyboard up the input and Send stay visible and the
  input takes at most about a third of the visible height, still fills its row, and the
  newest message stays in view.
- VR (`vr.mjs`): ray click on the chat textarea opens the in-scene keyboard with the
  focus ring and a "Send" Enter key; keys type into it; it grows; the menu texture paints
  the wrapped lines and the cyan focus ring; capped and scrolled to the caret; fills its row up to Send and leaves the history its
  share; the
  keyboard's Send sends the whole message and the field returns to one line.
