#!/usr/bin/env python3
"""Copy a handful of public community scenes from production KV into the
dev KV so gs-dev is not empty. READ-ONLY on the production namespace;
writes go only to the dev namespace (gs-dev-scenes).

Usage (from repo root, with CLOUDFLARE_API_TOKEN set):
  python3 scripts/seed-dev-scenes.py
  python3 scripts/seed-dev-scenes.py --limit 8
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PROD_KV_ID = "0e333b55e246449e9f97cb7e90d32f7a"
DEV_KV_ID = "07dcdd515d524614b1d3e2ff0c2faa3a"
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "427ce73a5d3f4bb5589f1cff8d9a13f9")
ROOT = Path(__file__).resolve().parents[1]


def wrangler(*args: str, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = ACCOUNT
    node22 = Path("/workspace/node22/bin")
    if node22.is_dir():
        env["PATH"] = str(node22) + os.pathsep + env.get("PATH", "")
    cmd = ["npx", "wrangler", *args]
    return subprocess.run(
        cmd,
        cwd=str(ROOT / "worker"),
        env=env,
        check=check,
        capture_output=capture,
        text=False,
    )


def kv_get(namespace_id: str, key: str) -> bytes | None:
    """Return the raw value, or None if missing. Never writes."""
    proc = wrangler(
        "kv", "key", "get", key,
        "--namespace-id", namespace_id,
        "--remote",
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace")
        # wrangler prints "Value not found" (or similar) for a missing key.
        low = err.lower()
        if "not found" in low or "404" in low or "does not exist" in low:
            return None
        sys.stderr.write(err)
        raise SystemExit(f"error: failed to GET {key!r} from namespace {namespace_id}")
    return proc.stdout


def kv_put(namespace_id: str, key: str, data: bytes, metadata: dict | None = None) -> None:
    if namespace_id == PROD_KV_ID:
        raise SystemExit("refusing to write to the production KV namespace")
    if namespace_id != DEV_KV_ID:
        raise SystemExit(f"refusing to write to unexpected namespace {namespace_id}")
    with tempfile.NamedTemporaryFile(delete=False) as fh:
        fh.write(data)
        path = fh.name
    try:
        args = [
            "kv", "key", "put", key,
            "--namespace-id", namespace_id,
            "--remote",
            "--path", path,
        ]
        if metadata:
            args.extend(["--metadata", json.dumps(metadata)])
        proc = wrangler(*args, check=False)
        if proc.returncode != 0:
            sys.stderr.buffer.write(proc.stderr or b"")
            raise SystemExit(f"error: failed to PUT {key!r} into dev KV")
    finally:
        os.unlink(path)


def pick_scenes(index: list, limit: int) -> list[dict]:
    def ts(item: dict) -> str:
        return str(item.get("updatedAt") or item.get("uploadedAt") or item.get("createdAt") or "")

    # Prefer scenes that already have a thumbnail, newest first.
    with_thumb = sorted(
        [i for i in index if isinstance(i, dict) and i.get("id") and i.get("hasThumbnail")],
        key=ts,
        reverse=True,
    )
    without = sorted(
        [i for i in index if isinstance(i, dict) and i.get("id") and not i.get("hasThumbnail")],
        key=ts,
        reverse=True,
    )
    picked, seen = [], set()
    for item in with_thumb + without:
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        picked.append(item)
        if len(picked) >= limit:
            break
    return picked


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=8, help="How many community scenes to copy (default 8)")
    args = ap.parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be ≥ 1")
    if PROD_KV_ID == DEV_KV_ID:
        raise SystemExit("dev KV id must not equal production KV id")
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        raise SystemExit("error: CLOUDFLARE_API_TOKEN is not set")

    print(f"Reading production community index (namespace {PROD_KV_ID})…")
    raw = kv_get(PROD_KV_ID, "cs-index")
    if not raw:
        raise SystemExit("production cs-index is missing or empty; nothing to copy")
    index = json.loads(raw.decode("utf-8"))
    if not isinstance(index, list):
        raise SystemExit("production cs-index is not a list")
    picked = pick_scenes(index, args.limit)
    print(f"Production index has {len(index)} scenes; copying {len(picked)} into dev KV {DEV_KV_ID}:")
    for item in picked:
        print(f"  - {item['id']}  {item.get('name', '')!s}"[:120])

    copied = 0
    for item in picked:
        sid = item["id"]
        keys = [f"cs:{sid}", f"scene:{sid}:thumb", f"scene:{sid}:context", f"scene:{sid}:hdri"]
        for key in keys:
            value = kv_get(PROD_KV_ID, key)
            if value is None:
                if key.startswith("cs:"):
                    print(f"    skip {key} (missing on prod)", file=sys.stderr)
                continue
            # HDRI / thumb values may have metadata (contentType); copy bytes only.
            # The Worker still serves them (it falls back when metadata is absent).
            print(f"    copy {key} ({len(value)} bytes)")
            kv_put(DEV_KV_ID, key, value)
            copied += 1

    dev_index = picked  # keep the original list metadata so the Community grid works
    payload = json.dumps(dev_index, separators=(",", ":")).encode("utf-8")
    print(f"    write dev cs-index ({len(picked)} entries, {len(payload)} bytes)")
    kv_put(DEV_KV_ID, "cs-index", payload)
    copied += 1
    print(f"Done. Wrote {copied} keys to dev KV only. Production KV was not modified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
