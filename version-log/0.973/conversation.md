# GS 0.973 — conversation (relayed, partly paraphrased)

> **Exception to the verbatim rule (read this first).** The rules in
> `../Version Log Updating Rules.md` ask for exact text. For 0.973 the requests
> reached the working agent **relayed**: Kross gave them over **two voice calls**,
> and the assistant that took the calls passed them on as **paraphrased summaries**,
> plus some chat messages. No transcript of the calls exists, so the exact words
> can't be recorded.
>
> - Sections marked **User (relayed from voice call, paraphrased, not verbatim)**
>   are those summaries, not quotes.
> - Text in quotation marks inside them is the only exact wording that was passed on.
> - **Assistant (reconstructed)** sections are rebuilt from the pull request reports
>   (#2–#5) and the release report. They are not the exact delivered text.
>
> Hidden system prompts and tool output are left out. Chronological.

## 2026-10-17

### User (relayed from a voice call, paraphrased, not verbatim)
Add a way to export GS scenes as 3D model files (GLB and FBX).

### User (relayed from a voice call, paraphrased, not verbatim)
Put sharing and export together: a Share tab with a link to the current scene that
works like the Community share, plus exports to GLB, glTF, FBX, OBJ and Blender. Keep
lights in the export where the format allows. Don't merge, deploy or bump the version yet.

### Assistant (reconstructed from PR #2)
PR #2 (`feature/scene-export`) is ready: a 🔗 Share tab with **Share link to this scene**
(the same Community share flow, `/e/:id` link, View-only toggle and Copy link) and five
exports: GLB, glTF (one self-contained file), FBX, OBJ + MTL (zip) and Blender (zip with
the .glb and an `open_in_blender.py` script). Directional, point and spot lights go
into GLB / glTF / Blender via `KHR_lights_punctual`. The VR Scenes panel has the same
buttons. Tested headless on desktop and phone, and in Blender 4.2. Not merged or deployed.

### User (relayed from a voice call, paraphrased, not verbatim)
The code window lags in VR, so fix its performance. Let VR windows either stay put or
follow the headset. Make the Code tab hot-reload changes instead of rebuilding the
whole scene. Let VR controllers click p5 and canvas panels.

### Assistant (reconstructed from PR #3)
PR #3 (`fix/vr-windows-perf-follow`): the in-headset menu mirror only repaints when
something changes (a repaint went from 76 ms to about 8–10 ms; idle repaints dropped
from 14 to 1 per 2 s). Windows can be **Fixed** or **Follow headset** (Controls → VR
windows, plus a button in the VR Environment panel). Code-tab **Apply** now hot-reloads
only the changed blocks (with `gs.state` and `gs.onUpdate`), and **Full reset** rebuilds
everything. Controller trigger, mouse and touch work on p5 and canvas panels.

### User (relayed from a voice call, paraphrased, not verbatim)
Save the chat and context that made a scene with the scene, so when it's reopened the
history comes back and the conversation can continue.

### Assistant (reconstructed from PR #4)
PR #4 (`feature/scene-creation-context`): saves and Community publishes carry a
**creation context**. That is the chat log (prompts, replies, models, timestamps,
attachments) and an info log (files, Environment and Dependencies, settings note, Code
edits, version and host). Publishing from desktop shows what will be shared, and secrets
are scrubbed. Reopening a scene restores the chat as history, and 📜 shows or downloads
the log. Vercel stores it in its own blob. The Cloudflare change was a worker patch.

### User (relayed from a voice call, paraphrased, not verbatim)
Let me import existing p5.js sketches into GS and view them on panels in VR.

### Assistant (reconstructed from PR #5)
PR #5 (`feature/p5-sketch-import`): **Import p5 sketch** by paste, file, zip, folder or
URL, including p5 web editor links (through a small relay, `GET /api/p5-editor/:user/:id`)
and OpenProcessing. Each sketch runs in its own sandboxed frame and is shown on a panel.
Clicks, taps and controller rays reach the sketch. The import is saved as a code block
in the scene.

### User (chat, relayed)
Kross approved shipping all of it together to both Vercel and Cloudflare once it passes
testing, and said to "Pick the next version number yourself (0.973 or later as appropriate)".
The version chosen was 0.973.

### Assistant (reconstructed from the release report)
Shipped as 0.973. PRs #2–#5 were merged together on `release/0.973`, all test suites
were run against the combined build (desktop and phone, plus combined checks: VR clicks
on imported sketches, hot reload with an imported sketch, export and share of a scene
with history), integration bugs were fixed, and it was deployed to Vercel and the
Cloudflare Worker. The Worker source now lives in the repo under `worker/`.
