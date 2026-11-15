#!/usr/bin/env bash
# Shared helpers for GS Cloudflare deploy scripts. Source from sibling scripts.
# shellcheck shell=bash
if [[ -z "${GS_ROOT:-}" ]]; then
  GS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
export GS_ROOT

# Prefer the box Node 22 toolchain when it is present; otherwise require Node ≥ 22 on PATH.
if [[ -x /workspace/node22/bin/node ]]; then
  export PATH="/workspace/node22/bin:$PATH"
fi

# Public Cloudflare account id for this project (also in DEPLOY.md / prior deploys).
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-427ce73a5d3f4bb5589f1cff8d9a13f9}"

PROD_WORKER_NAME="gs"
DEV_WORKER_NAME="gs-dev"
PROD_KV_ID="0e333b55e246449e9f97cb7e90d32f7a"
DEV_KV_ID="07dcdd515d524614b1d3e2ff0c2faa3a"
DEV_WORKERS_HOST="gs-dev.krossruiz.workers.dev"
DEV_CUSTOM_HOST="dev.gsforanything.com"
PROD_HOSTS=(
  gsforanything.com
  www.gsforanything.com
  gs.krossruiz.workers.dev
  vrclaudeinterface.vercel.app
)
# Canonical smoke hosts (3 Cloudflare production URLs + the Vercel backup).
# Smoke scenes differ per platform because scene ids are not shared across
# stores. smoke-gs.py --scene checks /s/ID, /api/community-scenes/ID and that
# the retired /embed/ID redirects (302) to /s/ID.
PROD_CF_SCENE="mvziiev10e4f789b"
PROD_VERCEL_SCENE="musxb3sm5b31e766"

gs_require_node22() {
  local ver major
  if ! command -v node >/dev/null 2>&1; then
    echo "error: Node.js ≥ 22 is required (looked for node on PATH and /workspace/node22/bin)" >&2
    return 1
  fi
  ver="$(node -v)"
  major="${ver#v}"
  major="${major%%.*}"
  if [[ "$major" -lt 22 ]]; then
    echo "error: Node.js ≥ 22 is required (found $ver)" >&2
    return 1
  fi
}

gs_require_cf_token() {
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "error: CLOUDFLARE_API_TOKEN is not set" >&2
    return 1
  fi
}

gs_prepare_worker_assets() {
  # Rebuild worker/public from site-source and regenerate prompts.js.
  # Must be run from anywhere; paths are absolute via GS_ROOT.
  (cd "$GS_ROOT/worker" && ./sync-public.sh && node gen-prompts.mjs)
}

gs_host_ok() {
  # Return 0 if https://$1 responds with any HTTP status (DNS + TLS work).
  local host="$1"
  local code
  code="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 8 --max-time 20 "https://${host}/" || true)"
  [[ -n "$code" && "$code" != "000" ]]
}
