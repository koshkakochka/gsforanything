# chat-files

The Files tab is gone. Context files are attached in the chat window (paperclip,
drag-and-drop, paste) and shown as thumbnails: a photo preview, a first-page
PDF render (or a PDF badge if pdf.js cannot load), the opening lines of a text
file, and an audio tile with duration and a play control.

    cd test-harness/chat-files
    # node_modules: symlink puppeteer-core 24.43.1, or npm i
    BASE=https://localhost:3643 node test.mjs

`SHOT_DIR` defaults to `/workspace/gs-chat-files-shots`. The suite stubs
`/api/chat` and `/api/backends`; it never talks to production KV or Blob.
