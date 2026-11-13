import { environmentHdriForRecord, HDRI_FILE_MAX_BYTES, hdriContentType } from "../site-source/sceneHdri.js";
import { allowExportFromBody, embedUnavailableHtml, exportAllowed, isSceneOwner, newOwnerKey, OWNER_KEY_HEADER, ownerKeyHash, publicSceneRecord } from "../site-source/sceneExportPolicy.js";
import { listThumbFields, parseThumbnailPayload, publicThumbnailField, thumbKey, thumbStub } from "../site-source/sceneThumbnail.js";
import { descriptionForList, sanitizeDescription, descriptionPayloadTooLarge, createRateLimiter, clientIpFromHeaders } from "../site-source/sceneDescription.js";
import { CHAT_PROMPT_REQUIRED, FIX_CODE_PROMPT, MAX_CUSTOM_PROMPT_CHARS, SYSTEM_PROMPT, THEME_SYSTEM_PROMPT } from "./prompts.js";

const descriptionPatchLimit = createRateLimiter();

// Hosted Worker for Carl Junior. Local-only HTTPS / self-signed certs / port
// binding from site-source/server.js are intentionally not included: Workers
// terminates TLS and does not listen on a port.
// Static client files are Workers static assets (ASSETS). This module only
// handles /api/* plus the /s/:id, /e/:id and /embed/:id share routes.

const LLM_BACKEND_DEFAULT = "openai-sol";
const OPENAI_MODEL_DEFAULT = "gpt-6-astra";
const OPENAI_SOL_MODEL = "gpt-6.1-sol";
const FABLE_THINKING_BUDGET = 4096;
const SCENE_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

// Same as resolveChatPrompt in site-source/server.js: the default Scene chat
// prompt, or the user's custom prompt (Chat → Prompt) plus the required
// technical section, capped at MAX_CUSTOM_PROMPT_CHARS.
function resolveChatPrompt(custom) {
  if (custom == null || custom === "") return { prompt: SYSTEM_PROMPT, custom: false };
  if (typeof custom !== "string") return { error: "systemPrompt must be a string" };
  if (!custom.trim()) return { prompt: SYSTEM_PROMPT, custom: false };
  if (custom.length > MAX_CUSTOM_PROMPT_CHARS) return { error: `Custom prompt is too long (${custom.length} characters, max ${MAX_CUSTOM_PROMPT_CHARS}). Shorten it in Chat → Prompt.` };
  return { prompt: `${custom.trim()}\n\n${CHAT_PROMPT_REQUIRED}`, custom: true };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
      "access-control-allow-headers": "content-type, x-gs-owner-key",
      ...extraHeaders,
    },
  });
}

// Backend key -> provider/model/label. Order here is dropdown order (newest/
// best first within each provider). Keys are stable: never rename one.
// model: null on "openai" means env.OPENAI_MODEL || OPENAI_MODEL_DEFAULT.
const BACKENDS = {
  "claude-opus-55": { provider: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
  "claude-sonnet-55": { provider: "claude", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  "claude-haiku-55": { provider: "claude", model: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  fable: { provider: "claude", model: "claude-fable-5-1", label: "Claude (Fable 5.1)" },
  claude: { provider: "claude", model: "claude-sonnet-5", label: "Claude (Sonnet 5)" },
  "openai-sol": { provider: "openai", model: OPENAI_SOL_MODEL, label: "GPT6.1 Sol" },
  "openai-6-sol": { provider: "openai", model: "gpt-6-sol", label: "GPT6 Sol" },
  "openai-luna": { provider: "openai", model: "gpt-6-luna", label: "GPT6 Luna" },
  openai: { provider: "openai", model: null, label: "GPT6 Astra" },
  ollama: { provider: "ollama", label: "Ollama (runs in your browser, local)", local: true },
};

function getAvailableBackends(env) {
  const out = {};
  for (const [id, b] of Object.entries(BACKENDS)) {
    const available = b.provider === "ollama" ? true : b.provider === "openai" ? !!env.OPENAI_API_KEY : !!env.CLAUDE_API_KEY;
    out[id] = { label: b.label, provider: b.provider, available, ...(b.local ? { local: true } : {}) };
  }
  return out;
}

async function callClaudeAPI(apiKey, systemPrompt, messages, maxTokens, model) {
  const isFable = model === "claude-fable-5-1";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: isFable ? maxTokens + FABLE_THINKING_BUDGET : maxTokens,
      ...(model === "claude-sonnet-5" ? { thinking: { type: "disabled" } } : {}),
      // Fable 5.1 rejects thinking.type "enabled"; adaptive + effort is required.
      ...(isFable ? { thinking: { type: "adaptive" }, output_config: { effort: "medium" } } : {}),
      system: systemPrompt,
      messages,
    }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
  }
  if (res.status >= 400) return { error: true, status: res.status, data: parsed };
  if (Array.isArray(parsed.content)) {
    const textBlock = parsed.content.find((b) => b.type === "text");
    if (textBlock && parsed.content[0] !== textBlock) {
      parsed.content = [textBlock, ...parsed.content.filter((b) => b !== textBlock)];
    }
  }
  return { error: false, data: parsed };
}

async function callOpenAIAPI(apiKey, systemPrompt, messages, maxTokens, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response from OpenAI: ${text.slice(0, 200)}`);
  }
  if (res.status >= 400) {
    return { error: true, status: res.status, data: { error: { message: parsed.error?.message || text } } };
  }
  const answer = parsed.choices?.[0]?.message?.content || "";
  return { error: false, data: { content: [{ text: answer }] } };
}

function callLLM(env, systemPrompt, messages, maxTokens, backend) {
  const chosen = (backend || env.LLM_BACKEND || LLM_BACKEND_DEFAULT).toLowerCase();
  if (chosen === "ollama") {
    return Promise.resolve({
      error: true,
      status: 400,
      data: { error: { message: "Ollama requests should go directly from the browser to localhost:11434, not through this server." } },
    });
  }
  // Unknown keys fall back to Claude Sonnet 5 (the old default behavior).
  const entry = BACKENDS[chosen] || BACKENDS.claude;
  if (entry.provider === "openai") {
    if (!env.OPENAI_API_KEY) {
      return Promise.resolve({ error: true, status: 400, data: { error: { message: "OPENAI_API_KEY is not configured on the server." } } });
    }
    const model = entry.model || env.OPENAI_MODEL || OPENAI_MODEL_DEFAULT;
    return callOpenAIAPI(env.OPENAI_API_KEY, systemPrompt, messages, maxTokens, model);
  }
  if (!env.CLAUDE_API_KEY) {
    return Promise.resolve({ error: true, status: 400, data: { error: { message: "CLAUDE_API_KEY is not configured on the server." } } });
  }
  const model = entry.model;
  return callClaudeAPI(env.CLAUDE_API_KEY, systemPrompt, messages, maxTokens, model);
}

function newSceneId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return Date.now().toString(36) + hex;
}

function sanitizeSceneName(name) {
  const cleaned = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "Untitled").slice(0, 80);
}

function createdAtGuessFromId(id) {
  if (!id || id.length <= 8) return null;
  const tsPart = id.slice(0, -8);
  const ms = parseInt(tsPart, 36);
  if (!Number.isFinite(ms) || ms < 1e12 || ms > 4e12) return null;
  return new Date(ms).toISOString();
}

function requestOrigin(request) {
  return new URL(request.url).origin;
}

function sceneUrls(request, id) {
  const origin = requestOrigin(request);
  return { id, editorUrl: `${origin}/e/${id}`, viewUrl: `${origin}/s/${id}`, embedUrl: `${origin}/embed/${id}` };
}

function requireStore(env) {
  if (!env.SCENES) return json({ error: "Community uploads aren't configured on this server (no Blob store linked)." }, 501);
  return null;
}

async function readJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function kvGetJson(env, key) {
  const raw = await env.SCENES.get(key);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function readIndex(env, key) {
  return (await kvGetJson(env, key)) || [];
}

function listItemTimestamps(meta) {
  const updatedAt = meta.updatedAt || meta.uploadedAt || null;
  const createdAt = meta.createdAt || createdAtGuessFromId(meta.id) || updatedAt;
  return { createdAt, updatedAt };
}

function sanitizeThemePayload(body) {
  const name = sanitizeSceneName(body?.name);
  const cssVars = body?.cssVars && typeof body.cssVars === "object" && !Array.isArray(body.cssVars) ? body.cssVars : null;
  if (!cssVars || Object.keys(cssVars).length === 0) return { error: "Invalid theme: cssVars object required" };
  const cleaned = {};
  for (const [k, v] of Object.entries(cssVars)) {
    if (typeof k !== "string" || !k.startsWith("--")) continue;
    if (typeof v !== "string") continue;
    cleaned[k.slice(0, 64)] = String(v).slice(0, 500);
  }
  if (Object.keys(cleaned).length === 0) return { error: "Invalid theme: no usable cssVars" };
  let customCSS = "";
  if (typeof body.customCSS === "string") customCSS = body.customCSS.slice(0, 8000);
  return { name, cssVars: cleaned, customCSS };
}

// Creation context (chat log + info log) uploaded with a community scene as
// `creationContext` = { format, version, encoding, data, summary }. Stored
// under its own KV key so the scene record and list stay small; the record
// keeps a stub pointing at GET /api/community-scenes/:id/context (lazy load).
// KV values max out at 25 MiB; the client keeps the encoded context under 3 MB.
const CONTEXT_FORMAT = "gs-creation-context";
const CONTEXT_MAX_CHARS = 20 * 1024 * 1024;
const contextKey = (id) => `scene:${id}:context`;
const hdriKey = (id) => `scene:${id}:hdri`;
const HDRI_UPLOAD_WINDOW_MS = 15 * 60 * 1000;

function validCreationContext(cc) {
  return !!(cc && typeof cc === "object" && cc.format === CONTEXT_FORMAT &&
    (cc.encoding === "gzip-base64" ? typeof cc.data === "string" : cc.encoding === "json" && cc.data && typeof cc.data === "object"));
}

function contextStub(cc, id, extra = {}) {
  return {
    format: CONTEXT_FORMAT,
    version: cc.version || 1,
    encoding: cc.encoding,
    stored: "separate",
    url: `/api/community-scenes/${id}/context`,
    summary: cc.summary && typeof cc.summary === "object" ? cc.summary : null,
    ...extra,
  };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return json({ ok: true });

  if (method === "GET" && path === "/api/backends") {
    return json({
      backends: getAvailableBackends(env),
      default: (env.LLM_BACKEND || LLM_BACKEND_DEFAULT).toLowerCase(),
    });
  }

  if (method === "GET" && path === "/api/prompts") {
    return json({
      systemPrompt: SYSTEM_PROMPT,
      fixCodePrompt: FIX_CODE_PROMPT,
      themePrompt: THEME_SYSTEM_PROMPT,
      chatPromptRequired: CHAT_PROMPT_REQUIRED,
      maxCustomPromptChars: MAX_CUSTOM_PROMPT_CHARS,
    });
  }

  // Read-only relay for public p5.js web editor sketches (same as server.js
  // GET /api/p5-editor/:user/:id). editor.p5js.org sends no CORS headers, so
  // the browser can't fetch it directly. Only this one public project-JSON
  // endpoint on editor.p5js.org is reachable; username and id are validated.
  const p5EditorMatch = path.match(/^\/api\/p5-editor\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && p5EditorMatch) {
    let user, id;
    try { user = decodeURIComponent(p5EditorMatch[1]); id = decodeURIComponent(p5EditorMatch[2]); } catch { user = id = ""; }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(user) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return json({ error: "Invalid p5 editor username or sketch id" }, 400);
    }
    try {
      const upstream = await fetch(`https://editor.p5js.org/editor/${encodeURIComponent(user)}/projects/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (upstream.status === 404) return json({ error: "Sketch not found", notFound: true }, 404);
      if (!upstream.ok) return json({ error: `p5 editor returned HTTP ${upstream.status}` }, 502);
      const data = await upstream.json();
      if (!data || !Array.isArray(data.files)) return json({ error: "Sketch not found", notFound: true }, 404);
      return json({ name: data.name, files: data.files, user: data.user && { username: data.user.username } }, 200, { "cache-control": "public, max-age=60" });
    } catch (err) {
      return json({ error: `Could not reach the p5 editor: ${err.message}` }, 502);
    }
  }

  if (method === "POST" && (path === "/api/chat" || path === "/api/fix-code" || path === "/api/theme-chat")) {
    const body = await readJsonBody(request);
    if (body == null) return json({ error: "Invalid JSON" }, 400);
    try {
      let data;
      if (path === "/api/chat" || path === "/api/theme-chat") {
        if (!body.messages || !Array.isArray(body.messages)) return json({ error: "Messages array is required" }, 400);
        let prompt = THEME_SYSTEM_PROMPT;
        if (path === "/api/chat") {
          // Optional custom Scene chat prompt from Chat → Prompt.
          const resolved = resolveChatPrompt(body.systemPrompt);
          if (resolved.error) return json({ error: resolved.error }, 400);
          prompt = resolved.prompt;
        }
        const maxTokens = path === "/api/chat" ? 16384 : 4096;
        data = await callLLM(env, prompt, body.messages, maxTokens, body.backend);
      } else {
        const { failingCode, errorMessage, errorStack, attempt, priorFixes, backend, sceneContext } = body;
        if (!failingCode || !errorMessage) return json({ error: "failingCode and errorMessage are required" }, 400);
        let userContent = `The following vr-exec code block failed to execute.\n\n`;
        userContent += `**Error:** \`${errorMessage}\`\n`;
        if (errorStack) userContent += `**Stack:** \`${errorStack}\`\n`;
        userContent += `**Attempt:** ${attempt || 1} of 3\n\n`;
        userContent += `**Failing code:**\n\`\`\`javascript\n${failingCode}\n\`\`\`\n\n`;
        if (priorFixes && priorFixes.length > 0) {
          userContent += `**Previous fix attempts that also failed:**\n`;
          for (const fix of priorFixes) {
            userContent += `\nAttempt ${fix.attempt} error: \`${fix.error}\`\n`;
            userContent += `\`\`\`javascript\n${fix.code}\n\`\`\`\n`;
          }
          userContent += `\nThe prior fixes did not work. Try a different approach.\n`;
        }
        userContent += `\nFix this code. Return ONLY a single \`vr-exec\` code block.`;
        // Editor settings note from the client (Environment, Dependencies, gamepad), capped.
        if (typeof sceneContext === "string" && sceneContext.trim()) {
          userContent += `\n\n${sceneContext.slice(0, 8000)}`;
        }
        data = await callLLM(env, FIX_CODE_PROMPT, [{ role: "user", content: userContent }], 8192, backend);
      }
      if (data.error) {
        return json({ error: data.data.error?.message || `API error: ${data.status}` }, data.status || 500);
      }
      return json(data.data);
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  }

  if (path === "/api/save-scene" && method === "POST") {
    const missing = requireStore(env);
    if (missing) return missing;
    const sceneData = await readJsonBody(request);
    if (!sceneData || !sceneData.codeBlocks || !Array.isArray(sceneData.codeBlocks)) {
      return json({ error: "Invalid scene data: missing codeBlocks array" }, 400);
    }
    await env.SCENES.put("saved-scene", JSON.stringify(sceneData));
    return json({ ok: true, file: "saved-scene.vrscene" });
  }

  if (path === "/api/load-scene" && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const raw = await env.SCENES.get("saved-scene");
    if (!raw) return json({ error: "No saved scene found" }, 404);
    return json(JSON.parse(raw));
  }

  const sceneIdMatch = path.match(/^\/api\/community-scenes\/([^/]+)$/);
  const sceneContextMatch = path.match(/^\/api\/community-scenes\/([^/]+)\/context$/);
  const sceneThumbMatch = path.match(/^\/api\/(?:community-scenes|scenes)\/([^/]+)\/thumb$/);

  if (sceneThumbMatch && (method === "GET" || method === "HEAD")) {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneThumbMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const { value, metadata } = await env.SCENES.getWithMetadata(thumbKey(id), "arrayBuffer");
    if (value) {
      return new Response(method === "HEAD" ? null : value, {
        headers: {
          "content-type": (metadata && metadata.contentType) || "image/jpeg",
          "content-length": String(value.byteLength),
          "cache-control": "public, max-age=31536000, immutable",
          "access-control-allow-origin": "*",
        },
      });
    }
    // Legacy: an inline data-URL thumbnail on the scene record.
    const record = await kvGetJson(env, `cs:${id}`);
    if (record && typeof record.thumbnail === "string" && record.thumbnail.startsWith("data:image/")) {
      const parsed = parseThumbnailPayload(record.thumbnail);
      if (parsed && parsed.bytes) {
        return new Response(method === "HEAD" ? null : parsed.bytes, {
          headers: {
            "content-type": parsed.contentType,
            "content-length": String(parsed.bytes.byteLength),
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
          },
        });
      }
    }
    return json({ error: "This scene has no thumbnail" }, 404);
  }

  if (sceneContextMatch && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneContextMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const raw = await env.SCENES.get(contextKey(id));
    if (raw) return new Response(raw, { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
    // Older uploads from unpatched servers keep the context inline.
    const record = await kvGetJson(env, `cs:${id}`);
    if (!record) return json({ error: "Scene not found" }, 404);
    if (record.creationContext && record.creationContext.data) return json(record.creationContext);
    return json({ error: "This scene has no creation context" }, 404);
  }
  const themeIdMatch = path.match(/^\/api\/community-themes\/([^/]+)$/);
  // Custom environment HDRI file of a community scene (same rules as
  // server.js): PUT once, right after the upload, only for a scene that
  // declared environmentHdri.kind 'file'; stored as raw bytes under its own
  // KV key (KV values max 25 MiB; HDRI_FILE_MAX_BYTES is 20 MB).
  const sceneHdriMatch = path.match(/^\/api\/community-scenes\/([^/]+)\/hdri$/);
  if (sceneHdriMatch && (method === "GET" || method === "HEAD")) {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneHdriMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const { value, metadata } = await env.SCENES.getWithMetadata(hdriKey(id), "arrayBuffer");
    if (!value) return json({ error: "This scene has no stored HDRI" }, 404);
    return new Response(method === "HEAD" ? null : value, {
      headers: {
        "content-type": (metadata && metadata.contentType) || "application/octet-stream",
        "content-length": String(value.byteLength),
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
      },
    });
  }
  if (sceneHdriMatch && method === "PUT") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneHdriMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const record = await kvGetJson(env, `cs:${id}`);
    if (!record) return json({ error: "Scene not found" }, 404);
    const hdri = record.environmentHdri;
    if (!hdri || hdri.kind !== "file") return json({ error: "This scene has no custom HDRI" }, 409);
    const age = Date.now() - new Date(record.updatedAt || record.createdAt || 0).getTime();
    if (!(age >= 0 && age <= HDRI_UPLOAD_WINDOW_MS)) return json({ error: "HDRI upload window has closed" }, 409);
    if ((await env.SCENES.list({ prefix: hdriKey(id), limit: 1 })).keys.some((k) => k.name === hdriKey(id))) return json({ error: "HDRI already uploaded" }, 409);
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > HDRI_FILE_MAX_BYTES) return json({ error: "HDRI file is too large" }, 413);
    const body = await request.arrayBuffer();
    if (!body.byteLength) return json({ error: "Empty HDRI" }, 400);
    if (body.byteLength > HDRI_FILE_MAX_BYTES) return json({ error: "HDRI file is too large" }, 413);
    const type = request.headers.get("content-type") || "";
    const contentType = hdri.format === "image" && /^image\/[a-z0-9.+-]+$/i.test(type) ? type : hdriContentType(hdri.format);
    await env.SCENES.put(hdriKey(id), body, { metadata: { contentType, size: body.byteLength, name: hdri.name || "" } });
    return json({ ok: true, size: body.byteLength, url: hdri.url });
  }

  if (path === "/api/community-scenes" && method === "POST") {
    const missing = requireStore(env);
    if (missing) return missing;
    const sceneData = await readJsonBody(request);
    if (!sceneData || !sceneData.codeBlocks || !Array.isArray(sceneData.codeBlocks)) {
      return json({ error: "Invalid scene data: missing codeBlocks array" }, 400);
    }
    const id = newSceneId();
    const name = sanitizeSceneName(sceneData.name);
    const now = new Date().toISOString();
    const { creationContext, ...sceneFields } = sceneData;
    const { allowExport: allowExportRaw, ownerKey: _ignoredOwnerKey, ownerKeyHash: _ignoredHash, isOwner: _ignoredIsOwner, thumbnail: thumbRaw, description: descRaw, ...cleanFields } = sceneFields;
    const allowExport = allowExportFromBody(allowExportRaw);
    const ownerKey = newOwnerKey();
    const record = { ...cleanFields, id, name, createdAt: sceneData.createdAt || now, updatedAt: now, allowExport, ownerKeyHash: await ownerKeyHash(ownerKey) };
    // Environment HDRI (see site-source/sceneHdri.js): keep a clean copy or drop it.
    delete record.environmentHdri;
    delete record.thumbnail;
    const hdri = environmentHdriForRecord(sceneData.environmentHdri, id);
    if (hdri) record.environmentHdri = hdri;
    const description = sanitizeDescription(descRaw);
    if (description) record.description = description;
    else delete record.description;
    const parsedThumb = parseThumbnailPayload(thumbRaw);
    let hasThumbnail = false;
    if (parsedThumb && parsedThumb.bytes) {
      await env.SCENES.put(thumbKey(id), parsedThumb.bytes, { metadata: { contentType: parsedThumb.contentType, size: parsedThumb.bytes.byteLength } });
      record.thumbnail = thumbStub(id, { contentType: parsedThumb.contentType, size: parsedThumb.bytes.byteLength });
      hasThumbnail = true;
    }
    if (creationContext != null) {
      if (!validCreationContext(creationContext)) return json({ error: "Invalid creationContext" }, 400);
      const ctxEncoded = JSON.stringify(creationContext);
      if (ctxEncoded.length > CONTEXT_MAX_CHARS) return json({ error: "Creation context is too large" }, 413);
      await env.SCENES.put(contextKey(id), ctxEncoded);
      record.creationContext = contextStub(creationContext, id, { key: contextKey(id), size: ctxEncoded.length });
    }
    const encoded = JSON.stringify(record);
    await env.SCENES.put(`cs:${id}`, encoded);
    const meta = { id, name, uploadedAt: now, createdAt: record.createdAt, updatedAt: now, size: new TextEncoder().encode(encoded).length, pathname: `community-scenes/${id}--${encodeURIComponent(name)}.json`, allowExport, hasThumbnail, description: description || "" };
    const index = await readIndex(env, "cs-index");
    index.unshift(meta);
    await env.SCENES.put("cs-index", JSON.stringify(index));
    return json({
      ok: true,
      url: `${requestOrigin(request)}/api/community-scenes/${id}`,
      pathname: meta.pathname,
      scene: meta,
      allowExport,
      // Returned once; the uploader's browser keeps it to prove ownership.
      ownerKey,
      ...sceneUrls(request, id),
    });
  }

  if (path === "/api/community-scenes" && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const index = await readIndex(env, "cs-index");
    const scenes = index.map((s) => ({
      id: s.id,
      name: s.name,
      url: `${requestOrigin(request)}/api/community-scenes/${s.id}`,
      pathname: s.pathname,
      uploadedAt: s.uploadedAt,
      size: s.size,
      allowExport: exportAllowed(s),
      description: descriptionForList(s.description),
      ...listThumbFields(s.id, s.hasThumbnail),
      ...listItemTimestamps(s),
      ...sceneUrls(request, s.id),
    }));
    return json({ scenes });
  }

  if (sceneIdMatch && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneIdMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const record = await kvGetJson(env, `cs:${id}`);
    if (!record) return json({ error: "Scene not found" }, 404);
    const isOwner = await isSceneOwner(record, request.headers.get(OWNER_KEY_HEADER));
    // The embed page asks with ?embed=1: refuse when the creator turned exports off.
    if (url.searchParams.get("embed") === "1" && !exportAllowed(record) && !isOwner) {
      return json({ error: "The creator of this scene turned off exports, so it can't be embedded.", exportsDisabled: true }, 403);
    }
    const pub = publicSceneRecord(record, { isOwner });
    const thumb = publicThumbnailField({ ...record, ...pub, id });
    if (thumb) pub.thumbnail = thumb;
    else delete pub.thumbnail;
    if (pub.description == null) pub.description = descriptionForList(record.description);
    return json({ ...pub, ...listThumbFields(id, !!(record.thumbnail && record.thumbnail.stored === "separate") || !!thumb), ...sceneUrls(request, id) });
  }

  if (sceneIdMatch && method === "PATCH") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneIdMatch[1]);
    const body = await readJsonBody(request);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const record = await kvGetJson(env, `cs:${id}`);
    if (!record) return json({ error: "Scene not found" }, 404);
    if (body == null || (body.name == null && body.allowExport == null && body.description == null)) return json({ error: "Missing name" }, 400);
    const isOwner = await isSceneOwner(record, request.headers.get(OWNER_KEY_HEADER));
    // Only the uploader (owner key) can change the export setting.
    // Descriptions are editable by anyone, same as rename; sanitize + rate/size-guard them.
    if (body.allowExport != null && !isOwner) {
      return json({ error: "Only the scene's creator can change its export setting" }, 403);
    }
    if (body.description != null) {
      if (descriptionPayloadTooLarge(body.description)) {
        return json({ error: "Description is too large" }, 413);
      }
      if (!descriptionPatchLimit(clientIpFromHeaders(request.headers))) {
        return json({ error: "Too many description updates, try again in a minute" }, 429);
      }
    }
    const name = body.name != null ? sanitizeSceneName(body.name) : sanitizeSceneName(record.name);
    record.name = name;
    record.id = id;
    if (body.allowExport != null) record.allowExport = allowExportFromBody(body.allowExport);
    if (body.description != null) {
      const description = sanitizeDescription(body.description);
      if (description) record.description = description;
      else delete record.description;
    }
    record.updatedAt = new Date().toISOString();
    const encoded = JSON.stringify(record);
    await env.SCENES.put(`cs:${id}`, encoded);
    const allowExport = exportAllowed(record);
    const index = await readIndex(env, "cs-index");
    const next = index.map((s) => s.id === id ? { ...s, name, allowExport, updatedAt: record.updatedAt, uploadedAt: record.updatedAt, size: new TextEncoder().encode(encoded).length, pathname: `community-scenes/${id}--${encodeURIComponent(name)}.json`, description: descriptionForList(record.description), hasThumbnail: !!(s.hasThumbnail || (record.thumbnail && record.thumbnail.stored === "separate")) } : s);
    await env.SCENES.put("cs-index", JSON.stringify(next));
    const meta = next.find((s) => s.id === id) || { pathname: `community-scenes/${id}--${encodeURIComponent(name)}.json`, size: encoded.length };
    return json({
      ok: true,
      url: `${requestOrigin(request)}/api/community-scenes/${id}`,
      pathname: meta.pathname,
      scene: { id, name, uploadedAt: record.updatedAt, createdAt: record.createdAt || null, updatedAt: record.updatedAt, size: meta.size, allowExport, description: descriptionForList(record.description), ...listThumbFields(id, !!(record.thumbnail && record.thumbnail.stored === "separate")) },
      allowExport,
      description: descriptionForList(record.description),
      ...sceneUrls(request, id),
    });
  }

  if (path === "/api/community-themes" && method === "POST") {
    const missing = requireStore(env);
    if (missing) return missing;
    const body = await readJsonBody(request);
    const cleaned = sanitizeThemePayload(body);
    if (cleaned.error) return json({ error: cleaned.error }, 400);
    const id = newSceneId();
    const now = new Date().toISOString();
    const record = {
      id,
      name: cleaned.name,
      cssVars: cleaned.cssVars,
      customCSS: cleaned.customCSS || "",
      createdAt: body?.createdAt || now,
      updatedAt: now,
    };
    const encoded = JSON.stringify(record);
    await env.SCENES.put(`ct:${id}`, encoded);
    const meta = { id, name: cleaned.name, uploadedAt: now, createdAt: record.createdAt, updatedAt: now, size: new TextEncoder().encode(encoded).length, pathname: `community-themes/${id}--${encodeURIComponent(cleaned.name)}.json` };
    const index = await readIndex(env, "ct-index");
    index.unshift(meta);
    await env.SCENES.put("ct-index", JSON.stringify(index));
    return json({
      ok: true,
      url: `${requestOrigin(request)}/api/community-themes/${id}`,
      pathname: meta.pathname,
      theme: { id, name: cleaned.name, uploadedAt: now, createdAt: record.createdAt, updatedAt: record.updatedAt, size: meta.size },
    });
  }

  if (path === "/api/community-themes" && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const index = await readIndex(env, "ct-index");
    const themes = index.map((t) => ({
      id: t.id,
      name: t.name,
      url: `${requestOrigin(request)}/api/community-themes/${t.id}`,
      pathname: t.pathname,
      uploadedAt: t.uploadedAt,
      size: t.size,
      ...listItemTimestamps(t),
    }));
    return json({ themes });
  }

  if (themeIdMatch && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(themeIdMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Theme not found" }, 404);
    const record = await kvGetJson(env, `ct:${id}`);
    if (!record) return json({ error: "Theme not found" }, 404);
    return json(record);
  }

  if (themeIdMatch && method === "PATCH") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(themeIdMatch[1]);
    const body = await readJsonBody(request);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Theme not found" }, 404);
    const record = await kvGetJson(env, `ct:${id}`);
    if (!record) return json({ error: "Theme not found" }, 404);
    if (body == null || body.name == null) return json({ error: "Missing name" }, 400);
    const name = sanitizeSceneName(body.name);
    record.name = name;
    record.id = id;
    record.updatedAt = new Date().toISOString();
    const encoded = JSON.stringify(record);
    await env.SCENES.put(`ct:${id}`, encoded);
    const index = await readIndex(env, "ct-index");
    const next = index.map((t) => t.id === id ? { ...t, name, updatedAt: record.updatedAt, uploadedAt: record.updatedAt, size: new TextEncoder().encode(encoded).length, pathname: `community-themes/${id}--${encodeURIComponent(name)}.json` } : t);
    await env.SCENES.put("ct-index", JSON.stringify(next));
    const meta = next.find((t) => t.id === id);
    return json({
      ok: true,
      url: `${requestOrigin(request)}/api/community-themes/${id}`,
      pathname: meta.pathname,
      theme: { id, name, uploadedAt: record.updatedAt, createdAt: record.createdAt || null, updatedAt: record.updatedAt, size: meta.size },
    });
  }

  return json({ error: "Not found" }, 404);
}

function appIndex(request, env) {
  const indexUrl = new URL(request.url);
  indexUrl.pathname = "/index.html";
  indexUrl.search = "";
  return env.ASSETS.fetch(new Request(indexUrl.toString(), { method: "GET" }));
}

function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function htmlResponse(html, status) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// /s/:id and /e/:id: the app. /embed/:id: the app in embed mode (main.js),
// only for scenes whose creator allows exports. A scene with exports off
// also gets frame-ancestors 'self' on /s and /e so its share links can't be
// iframed on other sites (the embed route is what other sites should use).
async function serveShareRoute(request, env, kind, rawId) {
  let id = "";
  try { id = decodeURIComponent(rawId); } catch { id = ""; }
  let record = null;
  if (env.SCENES && SCENE_ID_RE.test(id)) {
    try { record = await kvGetJson(env, `cs:${id}`); } catch { record = null; }
  }
  if (kind === "embed") {
    if (!record) return htmlResponse(embedUnavailableHtml({ status: 404, origin: requestOrigin(request) }), 404);
    if (!exportAllowed(record)) return htmlResponse(embedUnavailableHtml({ status: 403, name: record.name, origin: requestOrigin(request) }), 403);
    return withHeaders(await appIndex(request, env), { "cache-control": "no-store" });
  }
  const res = await appIndex(request, env);
  if (record && !exportAllowed(record)) return withHeaders(res, { "content-security-policy": "frame-ancestors 'self'" });
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api" || path.startsWith("/api/")) {
      return handleApi(request, env);
    }
    const shareMatch = path.match(/^\/(s|e|embed)\/([^/]+)\/?$/);
    if (shareMatch) {
      return serveShareRoute(request, env, shareMatch[1], shareMatch[2]);
    }
    return env.ASSETS.fetch(request);
  },
};
