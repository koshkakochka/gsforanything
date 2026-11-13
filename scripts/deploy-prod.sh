#!/usr/bin/env bash
# Build worker assets and deploy the *production* Cloudflare Worker (`gs`).
# Requires a clean working tree on origin/main and an explicit --confirm flag.
# Does not deploy Vercel (vrclaudeinterface auto-deploys from main; it is the backup).
# Usage: scripts/deploy-prod.sh --confirm
#        scripts/deploy-prod.sh --dry-run
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$SCRIPT_DIR/_common.sh"

DRY_RUN=0
CONFIRM=0
SKIP_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --confirm) CONFIRM=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "Usage: scripts/deploy-prod.sh --confirm | --dry-run" >&2
      exit 2
      ;;
  esac
done

gs_require_node22

if [[ "$DRY_RUN" -eq 1 ]]; then
  gs_require_cf_token
  echo "Preparing worker assets…"
  gs_prepare_worker_assets
  echo "Dry-run deploy of production Worker $PROD_WORKER_NAME (no --env)…"
  (cd "$GS_ROOT/worker" && npx wrangler deploy --env="" --dry-run)
  echo "Dry-run finished. Nothing was deployed."
  exit 0
fi

if [[ "$CONFIRM" -ne 1 ]]; then
  echo "error: refusing to deploy production without --confirm" >&2
  echo "This deploys Worker $PROD_WORKER_NAME to gsforanything.com, www.gsforanything.com, and gs.krossruiz.workers.dev." >&2
  echo "Usage: scripts/deploy-prod.sh --confirm" >&2
  exit 2
fi

gs_require_cf_token

# Must be a clean checkout of origin/main (never deploy prod from a feature branch).
if ! git -C "$GS_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: $GS_ROOT is not a git work tree" >&2
  exit 1
fi
branch="$(git -C "$GS_ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" ]]; then
  echo "error: production deploys must be made from 'main' (currently on '$branch')" >&2
  exit 1
fi
if [[ -n "$(git -C "$GS_ROOT" status --porcelain)" ]]; then
  echo "error: working tree is not clean; commit or stash before a production deploy" >&2
  git -C "$GS_ROOT" status -sb >&2
  exit 1
fi
echo "Fetching origin/main…"
git -C "$GS_ROOT" fetch origin main
head="$(git -C "$GS_ROOT" rev-parse HEAD)"
origin_main="$(git -C "$GS_ROOT" rev-parse origin/main)"
if [[ "$head" != "$origin_main" ]]; then
  echo "error: HEAD ($head) does not match origin/main ($origin_main)" >&2
  echo "Merge or check out origin/main before deploying production." >&2
  exit 1
fi

echo "Preparing worker assets…"
gs_prepare_worker_assets

echo "Deploying production Worker $PROD_WORKER_NAME…"
(cd "$GS_ROOT/worker" && npx wrangler deploy --env="")

if [[ "$SKIP_SMOKE" -eq 1 ]]; then
  echo "Skipping smoke checks (--skip-smoke)."
  exit 0
fi

echo "Smoke-checking Cloudflare production hosts + embed ${PROD_CF_EMBED}…"
python3 "$SCRIPT_DIR/smoke-gs.py" \
  gsforanything.com www.gsforanything.com gs.krossruiz.workers.dev \
  --embed "$PROD_CF_EMBED"

echo "Smoke-checking Vercel backup + embed ${PROD_VERCEL_EMBED}…"
python3 "$SCRIPT_DIR/smoke-gs.py" \
  vrclaudeinterface.vercel.app \
  --embed "$PROD_VERCEL_EMBED"

echo "Production deploy OK."
