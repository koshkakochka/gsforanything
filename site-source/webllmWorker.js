// Web Worker for the local in-browser model (WebLLM). localLLM.js starts it
// only after the user picks a Local model and clicks Download & load, so the
// WebLLM library (and the model weights it fetches) never load before that.
// Keep the version in sync with WEBLLM_VERSION in localLLM.js.
import { WebWorkerMLCEngineHandler } from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.88/+esm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
