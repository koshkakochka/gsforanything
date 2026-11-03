# passthrough-texture smoke check

Quick headless check (not a full suite) for the shared camera pipeline
(`site-source/passthroughTexture.js`): Chrome's fake camera behind mocked
Quest 3 camera labels, /api/* stubbed, IWER Meta Quest 3 for the VR part.

    BASE=https://localhost:3531 SHOT_DIR=/workspace/gs-passtex-shots node smoke.mjs

Checks: the hidden <video> is in the DOM (not display:none), muted,
playsInline and playing; the 2D preview canvas and the VR menu window's live
quad get non-black frames, and keep updating inside XR; gsPassthroughTexture()
is an sRGB VideoTexture of the same video, tagged gsNoExport, with no extra
getUserMedia; status line + Details diagnostics; the avatar-only case shows
the Quest Settings hint and the exact passthrough request error; scene clear and
closing the panel release the camera. `node_modules` is a symlink to the
shared test deps (gitignored).
