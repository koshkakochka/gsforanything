#!/usr/bin/env bash
# Build worker assets and deploy the *dev* Cloudflare Worker (gs-dev).
# Never deploys production (the default wrangler environment / Worker `gs`).
# Usage: scripts/deploy-dev.sh [--dry-run] [--skip-smoke]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$SCRIPT_DIR/_common.sh"

DRY_RUN=0
SKIP_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    -h|--help)
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

gs_require_node22
gs_require_cf_token

echo "Preparing worker assets…"
gs_prepare_worker_assets

cd "$GS_ROOT/worker"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run deploy of env dev (Worker $DEV_WORKER_NAME)…"
  npx wrangler deploy --env dev --dry-run
  echo "Dry-run finished. Production Worker $PROD_WORKER_NAME was not deployed."
  exit 0
fi

echo "Deploying Worker $DEV_WORKER_NAME (--env dev)…"
npx wrangler deploy --env dev

if [[ "$SKIP_SMOKE" -eq 1 ]]; then
  echo "Skipping smoke checks (--skip-smoke)."
  exit 0
fi

# Assets and custom-domain certificates can 404 / fail TLS for a few seconds
# after a first deploy. Wait for the workers.dev URL, then try the custom domain.
echo "Waiting for https://$DEV_WORKERS_HOST to come up…"
up=0
for _ in 1 2 3 4 5 6 7 8; do
  if gs_host_ok "$DEV_WORKERS_HOST"; then up=1; break; fi
  sleep 3
done
if [[ "$up" -ne 1 ]]; then
  echo "error: https://$DEV_WORKERS_HOST did not become reachable" >&2
  exit 1
fi

hosts=("$DEV_WORKERS_HOST")
custom_up=0
for _ in 1 2 3 4 5 6; do
  if gs_host_ok "$DEV_CUSTOM_HOST"; then custom_up=1; break; fi
  sleep 3
done
if [[ "$custom_up" -eq 1 ]]; then
  hosts+=("$DEV_CUSTOM_HOST")
else
  echo "note: https://$DEV_CUSTOM_HOST is not reachable yet; smoking $DEV_WORKERS_HOST only." >&2
fi

echo "Smoke-checking ${hosts[*]}…"
smoke_ok=0
for _ in 1 2 3; do
  if python3 "$SCRIPT_DIR/smoke-gs.py" "${hosts[@]}"; then
    smoke_ok=1
    break
  fi
  echo "smoke check failed; retrying in 5s…" >&2
  sleep 5
done
if [[ "$smoke_ok" -ne 1 ]]; then
  echo "error: smoke check failed" >&2
  exit 1
fi

# Scene save/load round trip against the first reachable dev host, hitting
# the dev KV only (gs-dev is bound to gs-dev-scenes).
SMOKE_HOST="${hosts[0]}"
MARKER="gs-dev-smoke-$(date +%s)"
echo "Save/load round trip on https://$SMOKE_HOST …"
payload=$(printf '{"codeBlocks":[{"id":"%s","code":"// dev smoke"}],"title":"%s"}' "$MARKER" "$MARKER")
save_body=$(mktemp)
load_body=$(mktemp)
trap 'rm -f "$save_body" "$load_body"' EXIT
save_code=$(curl -sS -o "$save_body" -w "%{http_code}" --max-time 30 \
  -X POST "https://${SMOKE_HOST}/api/save-scene" \
  -H "content-type: application/json" \
  --data "$payload")
if [[ "$save_code" != "200" ]]; then
  echo "error: POST /api/save-scene -> $save_code  body=$(head -c 200 "$save_body")" >&2
  exit 1
fi
load_code=$(curl -sS -o "$load_body" -w "%{http_code}" --max-time 30 \
  "https://${SMOKE_HOST}/api/load-scene")
if [[ "$load_code" != "200" ]]; then
  echo "error: GET /api/load-scene -> $load_code  body=$(head -c 200 "$load_body")" >&2
  exit 1
fi
python3 - "$load_body" "$MARKER" << 'PY'
import json, sys
path, marker = sys.argv[1], sys.argv[2]
data = json.load(open(path))
blocks = data.get("codeBlocks") or []
ids = [b.get("id") for b in blocks if isinstance(b, dict)]
if marker not in ids and data.get("title") != marker:
    raise SystemExit(f"load-scene did not echo the marker {marker!r}; keys={list(data)[:8]}")
print("  OK  save/load round trip (dev KV)")
PY

echo "Dev deploy OK: https://$DEV_WORKERS_HOST"
if [[ ${#hosts[@]} -gt 1 ]]; then
  echo "Custom domain: https://$DEV_CUSTOM_HOST"
fi
