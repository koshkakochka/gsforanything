# Cloudflare dev and production

GS is served by a Cloudflare Worker. Vercel (`vrclaudeinterface`) auto-deploys from `main` and is the **backup**, not the primary. Leave that Vercel project as it is.

This file covers the two Cloudflare environments and the deploy scripts. For the version-number rule, the `sync-public.sh` file list, and post-ship version-log steps, also read **[DEPLOY.md](DEPLOY.md)** before any production release.

## Environments

| | Production | Development |
| --- | --- | --- |
| Worker name | `gs` | `gs-dev` (wrangler `--env dev`) |
| URLs | https://gsforanything.com, https://www.gsforanything.com, fallback https://gs.krossruiz.workers.dev | https://dev.gsforanything.com, fallback https://gs-dev.krossruiz.workers.dev |
| KV namespace | `carl-junior-scenes` (`SCENES` binding id `0e333b55e246449e9f97cb7e90d32f7a`) | `gs-dev-scenes` (`SCENES` binding id `07dcdd515d524614b1d3e2ff0c2faa3a`) |
| Secrets | `CLAUDE_API_KEY`, `OPENAI_API_KEY`, `LLM_BACKEND` (set with `wrangler secret put`, not in the repo) | Separate secret store on `gs-dev`. Put keys with `npx wrangler secret put NAME --env dev`. Dev must not reuse production KV; secret *values* cannot be read back from production. |
| How it deploys | **Manual only.** `scripts/deploy-prod.sh --confirm` from a clean `origin/main` (the script calls `wrangler deploy --env=""` so the top-level production environment is explicit). There is no production GitHub Action. | `scripts/deploy-dev.sh` from any branch. GitHub Actions also deploys `gs-dev` on a push to the `dev` branch and on pull requests against `main`. |
| Backup | Vercel project `vrclaudeinterface` → https://vrclaudeinterface.vercel.app (auto-deploy from `main`) | — |

Dev and production are different Workers and different KV namespaces. A save, Community upload, or description edit on `gs-dev` never writes to production KV, and the other way around.

`routes` in `worker/wrangler.jsonc` are inheritable, so the `env.dev` block **must** declare its own routes (only `dev.gsforanything.com`). Do not delete that override: without it, `wrangler deploy --env dev` would try to attach the production custom domains to `gs-dev`.

## Scripts

All of these expect Node.js ≥ 22 (the box toolchain at `/workspace/node22/bin` is used when present) and `CLOUDFLARE_API_TOKEN` in the environment. The account id defaults to `427ce73a5d3f4bb5589f1cff8d9a13f9`.

From the repo root:

```bash
# Deploy gs-dev, smoke-check it, and run a save/load round trip against dev KV
./scripts/deploy-dev.sh

# Same steps, but do not contact Cloudflare (config + bundle only)
./scripts/deploy-dev.sh --dry-run

# Copy a handful of public Community scenes from prod KV → dev KV (prod is read-only)
python3 scripts/seed-dev-scenes.py

# Production: clean tree on origin/main, explicit confirm, then smoke all four
# hosts (three Cloudflare URLs + the Vercel backup) and the platform embeds
./scripts/deploy-prod.sh --confirm
./scripts/deploy-prod.sh --dry-run
```

`deploy-prod.sh` refuses to run unless all of these are true: the current branch is `main`, `git status` is clean, `HEAD` equals `origin/main` (it fetches first), and you passed `--confirm`. It deploys only the Cloudflare Worker `gs`. It does not promote or redeploy Vercel.

Smoke checks (shared `scripts/smoke-gs.py`) verify:

- `/version.js` exports `GS_VERSION`
- `/api/backends` returns JSON
- every static import reached from `index.html` and `main.js` (including the import map, `three.module.js`, and local `./…` modules) returns HTTP 200
- production also checks `/embed/mvziiev10e4f789b` on the Cloudflare hosts and `/embed/musxb3sm5b31e766` on Vercel

## GitHub Actions

[`.github/workflows/deploy-dev.yml`](.github/workflows/deploy-dev.yml) runs `scripts/deploy-dev.sh` on:

- a push to the `dev` branch
- a pull request targeting `main`

Pushes to `main` do **not** deploy Cloudflare production. Ship production with `scripts/deploy-prod.sh --confirm` after the version pick in `DEPLOY.md`.

The workflow needs the repository secret `CLOUDFLARE_API_TOKEN` and may use the repository variable `CLOUDFLARE_ACCOUNT_ID`. Every pull request shares the same `gs-dev` Worker and `gs-dev-scenes` KV (there is no per-PR Worker).

To create the `dev` branch the first time: `git checkout main && git pull && git checkout -b dev && git push -u origin dev`.

## Secrets on gs-dev

Production secret *values* cannot be read from Cloudflare. Set dev keys separately, from the `worker/` directory:

```bash
npx wrangler secret put CLAUDE_API_KEY --env dev
npx wrangler secret put OPENAI_API_KEY --env dev
# optional; the Worker defaults to openai-sol if this is unset
npx wrangler secret put LLM_BACKEND --env dev
```

`/api/backends` still responds if the AI keys are missing; cloud models are listed as `available: false` and chat calls return a "not configured" error. Ollama (browser-local) stays available.

## Seeding dev Community scenes

`scripts/seed-dev-scenes.py` reads `cs-index` and a few scene / thumbnail / context / HDRI keys from the production namespace and writes those keys, plus a trimmed `cs-index`, into `gs-dev-scenes` only. It refuses to write to the production namespace. Re-run it whenever you want a fresh sample on dev; it overwrites the copied keys and the dev index.

## What not to do

- Do not run `npx wrangler deploy` (no `--env`) unless you intend to ship production, and then only via `scripts/deploy-prod.sh --confirm`.
- Do not point `env.dev.kv_namespaces` at the production KV id.
- Do not put API keys in the repo, in wrangler config, or in GitHub Actions logs.
- Do not invent a version number. Ask before bumping `site-source/version.js`.
