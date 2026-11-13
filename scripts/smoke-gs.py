#!/usr/bin/env python3
"""Smoke-check a GS host (or several): version.js, /api/backends, and every
static import from index.html and main.js (followed recursively for local
modules). Optional --embed PATH checks that an embed URL returns 200.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import PurePosixPath
from typing import Iterable
from urllib.parse import urljoin, urlparse, urlunparse

IMPORT_RE = re.compile(
    r"""(?:import\s*(?:[\s\S]*?\sfrom\s*)?|export\s*[\s\S]*?\sfrom\s*|import\s*\()\s*['"]([^'"]+)['"]""",
    re.MULTILINE,
)
GS_VERSION_RE = re.compile(r"""GS_VERSION\s*=\s*['"]([^'"]+)['"]""")


class _HtmlRefs(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.scripts: list[str] = []
        self.importmaps: list[str] = []
        self.links: list[str] = []
        self._in_importmap = False
        self._importmap_chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        ad = {k: v or "" for k, v in attrs}
        if tag == "script":
            typ = ad.get("type", "").lower()
            src = ad.get("src")
            if typ == "importmap":
                self._in_importmap = True
                self._importmap_chunks = []
            elif src:
                self.scripts.append(src)
        elif tag == "link":
            href = ad.get("href")
            rel = ad.get("rel", "").lower()
            if href and rel in {"stylesheet", "modulepreload", "preload", "icon", "shortcut icon"}:
                if not href.startswith("data:"):
                    self.links.append(href)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._in_importmap:
            self.importmaps.append("".join(self._importmap_chunks))
            self._in_importmap = False
            self._importmap_chunks = []

    def handle_data(self, data: str) -> None:
        if self._in_importmap:
            self._importmap_chunks.append(data)


def _norm_url(url: str) -> str:
    p = urlparse(url)
    # Drop cache-busting query / fragment for visited-set purposes, keep path.
    return urlunparse((p.scheme, p.netloc, p.path, "", "", ""))


def fetch(url: str, timeout: float = 45.0) -> tuple[int, bytes, dict[str, str]]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "gs-smoke-check/1.0",
            "Accept": "*/*",
            "Cache-Control": "no-cache",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            headers = {k.lower(): v for k, v in res.headers.items()}
            return res.status, res.read(), headers
    except urllib.error.HTTPError as e:
        headers = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
        return e.code, e.read() if e.fp else b"", headers
    except Exception as e:  # noqa: BLE001 — report any transport failure
        raise RuntimeError(f"request failed: {e}") from e


def is_local_spec(spec: str) -> bool:
    if spec.startswith(("http://", "https://", "data:", "blob:", "javascript:")):
        return False
    if spec.startswith(("./", "../", "/")):
        return True
    # bare or "three/..." may be import-mapped; handled separately
    return False


def resolve_spec(spec: str, base_url: str, import_map: dict[str, str]) -> str | None:
    # Exact import-map match first, then prefix keys ending with /
    if spec in import_map:
        target = import_map[spec]
        return urljoin(base_url, target)
    for prefix, target in import_map.items():
        if prefix.endswith("/") and spec.startswith(prefix):
            return urljoin(base_url, target + spec[len(prefix) :])
    if is_local_spec(spec):
        return urljoin(base_url, spec)
    return None  # remote / unmapped bare specifier (e.g. skipped)


def parse_import_map(raw: str, page_url: str) -> dict[str, str]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    imports = data.get("imports") or {}
    out: dict[str, str] = {}
    for k, v in imports.items():
        if isinstance(k, str) and isinstance(v, str):
            out[k] = urljoin(page_url, v)
    return out


def extract_js_imports(source: str) -> list[str]:
    # Strip block and line comments enough that commented imports are ignored.
    no_block = re.sub(r"/\*[\s\S]*?\*/", "", source)
    no_line = re.sub(r"(?m)^\s*//.*$", "", no_block)
    return IMPORT_RE.findall(no_line)


def looks_like_js(url: str, content_type: str) -> bool:
    path = urlparse(url).path
    if path.endswith((".js", ".mjs", ".cjs")):
        return True
    return "javascript" in content_type or "ecmascript" in content_type


def check_host(host: str, embed: str | None, expect_version: str | None) -> list[str]:
    errors: list[str] = []
    origin = host if host.startswith("http") else f"https://{host}"
    origin = origin.rstrip("/")
    page_url = origin + "/"

    def fail(msg: str) -> None:
        errors.append(f"{origin}: {msg}")

    # --- version.js ---
    ver_url = origin + "/version.js"
    try:
        status, body, _ = fetch(ver_url)
    except RuntimeError as e:
        fail(f"GET /version.js {e}")
        return errors
    if status != 200:
        fail(f"GET /version.js -> {status}")
    else:
        text = body.decode("utf-8", "replace")
        m = GS_VERSION_RE.search(text)
        if not m:
            fail("GET /version.js: no GS_VERSION export found")
        elif expect_version and m.group(1) != expect_version:
            fail(f"GS_VERSION is {m.group(1)!r}, expected {expect_version!r}")
        else:
            print(f"  OK  {ver_url}  GS_VERSION={m.group(1)}")

    # --- /api/backends ---
    backends_url = origin + "/api/backends"
    try:
        status, body, headers = fetch(backends_url)
    except RuntimeError as e:
        fail(f"GET /api/backends {e}")
        return errors
    if status != 200:
        fail(f"GET /api/backends -> {status}")
    else:
        try:
            data = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            fail("GET /api/backends: not JSON")
        else:
            # Worker returns { backends: { id: {label, available, ...}, ... } }
            # or a bare map; accept either.
            backends = data.get("backends", data) if isinstance(data, dict) else None
            if not isinstance(backends, dict) or not backends:
                fail(f"GET /api/backends: unexpected payload keys={list(data)[:8] if isinstance(data, dict) else type(data).__name__}")
            else:
                avail = [k for k, v in backends.items() if isinstance(v, dict) and v.get("available")]
                print(f"  OK  {backends_url}  backends={len(backends)} available={avail or '(none)'}")

    # --- index.html + recursive imports ---
    try:
        status, body, _ = fetch(page_url)
    except RuntimeError as e:
        fail(f"GET / {e}")
        return errors
    if status != 200:
        fail(f"GET / -> {status}")
        return errors
    html = body.decode("utf-8", "replace")
    parser = _HtmlRefs()
    parser.feed(html)
    import_map: dict[str, str] = {}
    for raw in parser.importmaps:
        import_map.update(parse_import_map(raw, page_url))

    queue: list[str] = []
    for src in parser.scripts:
        queue.append(urljoin(page_url, src))
    for href in parser.links:
        queue.append(urljoin(page_url, href))
    # Always also hit main.js / versions.json even if markup changes.
    queue.append(urljoin(page_url, "./main.js"))
    queue.append(urljoin(page_url, "./versions.json"))

    visited: set[str] = set()
    while queue:
        url = queue.pop(0)
        key = _norm_url(url)
        # Only check same-origin assets
        if urlparse(key).netloc != urlparse(origin).netloc:
            continue
        if key in visited:
            continue
        visited.add(key)
        try:
            status, body, headers = fetch(url)
        except RuntimeError as e:
            fail(f"GET {urlparse(url).path or '/'} {e}")
            continue
        if status != 200:
            fail(f"GET {urlparse(url).path or '/'} -> {status} ({len(body)} bytes)")
            continue
        if len(body) == 0:
            fail(f"GET {urlparse(url).path or '/'} -> 200 but empty body")
            continue
        print(f"  OK  {url}  {len(body)} bytes")
        ctype = headers.get("content-type", "").split(";")[0].strip().lower()
        if looks_like_js(url, ctype):
            try:
                src = body.decode("utf-8")
            except UnicodeDecodeError:
                continue
            for spec in extract_js_imports(src):
                resolved = resolve_spec(spec, url, import_map)
                if resolved:
                    queue.append(resolved)

    if embed:
        if not embed.startswith("/"):
            embed = "/" + embed
        embed_url = origin + embed
        try:
            status, body, _ = fetch(embed_url)
        except RuntimeError as e:
            fail(f"GET {embed} {e}")
        else:
            if status != 200:
                fail(f"GET {embed} -> {status}")
            elif len(body) < 200:
                fail(f"GET {embed} -> 200 but tiny body ({len(body)} bytes)")
            else:
                print(f"  OK  {embed_url}  {len(body)} bytes")

    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("hosts", nargs="+", help="Hostname or https URL")
    ap.add_argument("--embed", action="append", default=[], help="Embed path to check (repeatable). Applied to every host.")
    ap.add_argument("--expect-version", default=None, help="Require this GS_VERSION string")
    args = ap.parse_args(argv)

    all_errors: list[str] = []
    for host in args.hosts:
        embeds = list(args.embed)
        print(f"== {host} ==")
        # Allow host-specific embed via host|path ? Keep it simple: same embeds on all,
        # callers pass the right hosts in separate invocations.
        if len(embeds) == 1:
            all_errors.extend(check_host(host, embeds[0], args.expect_version))
        elif not embeds:
            all_errors.extend(check_host(host, None, args.expect_version))
        else:
            # First pass checks imports; subsequent only the extra embeds would re-do work.
            all_errors.extend(check_host(host, embeds[0], args.expect_version))
            for extra in embeds[1:]:
                all_errors.extend(check_host_embed_only(host, extra))

    if all_errors:
        print("SMOKE FAILED:", file=sys.stderr)
        for e in all_errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("SMOKE OK")
    return 0


def check_host_embed_only(host: str, embed: str) -> list[str]:
    errors: list[str] = []
    origin = host if host.startswith("http") else f"https://{host}"
    origin = origin.rstrip("/")
    if not embed.startswith("/"):
        embed = "/" + embed
    url = origin + embed
    try:
        status, body, _ = fetch(url)
    except RuntimeError as e:
        errors.append(f"{origin}: GET {embed} {e}")
        return errors
    if status != 200:
        errors.append(f"{origin}: GET {embed} -> {status}")
    elif len(body) < 200:
        errors.append(f"{origin}: GET {embed} -> 200 but tiny body ({len(body)} bytes)")
    else:
        print(f"  OK  {url}  {len(body)} bytes")
    return errors


if __name__ == "__main__":
    sys.exit(main())
