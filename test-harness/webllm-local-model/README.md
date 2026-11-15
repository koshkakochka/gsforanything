# Local (WebLLM) models in the Model menu

`test.mjs` (puppeteer-core + Chrome, swiftshader). WebLLM is stubbed: the test
answers the jsDelivr URL of `@mlc-ai/web-llm@0.2.88` with a small fake module
(fake progress reports, a fake streaming engine) and `webllmWorker.js` with an
empty worker. Any other request to jsDelivr's WebLLM, Hugging Face or GitHub
is aborted and counted. `navigator.gpu` is faked per case (shader-f16 / no
shader-f16 / no adapter / no WebGPU). `/api/chat` is stubbed and counted:
never a real AI call, never production KV or Blob.

    CLAUDE_API_KEY=dummy OPENAI_API_KEY=dummy PORT=5028 node ../../site-source/server.js
    BASE=https://localhost:5028 SHOT_DIR=/workspace/gs-webllm-shots node test.mjs

`unit.mjs` (`node unit.mjs`): the one-bar progress tracker. WebLLM's
multi-phase reports (download, cache → GPU, shaders, finish) never move the
bar backwards and it reaches 100% once, only when the engine is ready.

Checks:

- Page load requests nothing from WebLLM / jsDelivr / Hugging Face / GitHub,
  starts no worker and has no such Resource Timing entries.
- Four Local options, smallest first, with their sizes ("— 603 MB download"
  for Gemma 3 1B, "— 882 MB download", "— 1.75 GB download", "— 4.30 GB
  download") in their own group after the server models; server options (ids,
  order, labels), default and request body unchanged.
- Picking one shows the confirmation (size, caching, GPU memory, Download &
  load / Use <server model> instead) and still fetches nothing. Sending before
  loading explains what to click and makes no request.
- Download & load: the pinned library is imported, the worker starts, the
  progress bar follows `initProgressCallback` as one bar over all phases
  (never backwards, 100% once, at ready), the page keeps rendering,
  `CreateWebWorkerMLCEngine` gets a Worker, the q4f16_1 model and a 16k context.
- Chat goes to the local engine (no `/api/chat`) with the default Scene prompt
  and the "[GS editor settings]" note, streams into the chat, and its vr-exec
  block runs. Auto-fix and Theme chat use the local model too.
- Switching to a server model unloads the engine; `/api/chat` carries only
  `messages` + `backend`.
- A saved Local choice comes back after reload but waits for a click; "Remove
  downloaded models" asks first.
- No WebGPU: options disabled with "needs WebGPU"; picking one explains and
  switches back. No adapter: same after the click. No shader-f16: the q4f32_1
  build of Qwen; Gemma 3 1B (q4f16_1 only) is refused with no download. A
  failed load shows the error and Try again.
- Phone: size + support warning, 44 px buttons. VR (IWER Quest 3): the Model
  menu and panel are painted in the menu window; nothing downloads.

`dev-verify.mjs` checks a deployed host with no stubs: the four options and
their sizes, nothing fetched from WebLLM on page load or on selection, the
confirmation. `REAL_LOAD=1` then really downloads and loads the 1.5B model
with the browser's WebGPU (`REAL_CHAT=1` also sends one message).

    BASE=https://dev.gsforanything.com SHOT_DIR=/workspace/gs-webllm-shots node dev-verify.mjs
