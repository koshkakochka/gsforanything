#!/usr/bin/env python3
"""
VRClaudeInterface launcher — starts the Node web server (server.js), streams
its output, and cleanly stops it on Ctrl+C.

Choose one model backend via flags:

    python run.py --ollama                       # interactive picker over your
                                                  # locally-downloaded Ollama models
    python run.py --ollama --ollama-model llama3 # skip the picker, use this model
    python run.py --api-key sk-ant-...           # use Claude; save key permanently
    python run.py --api-key-file key.txt         # use Claude; read key from a file
    python run.py                                # use Claude; reuse a previously
                                                  # saved CLAUDE_API_KEY env var
    python run.py start                    # same as bare 'python run.py'
    python run.py stop                     # kill server from a previous run
    python run.py status                   # show whether the recorded PID is alive
    python run.py restart                  # stop then start

Backend selection:
    --ollama            Use a local Ollama model. No API key needed; requires
                         Ollama running locally (default http://localhost:11434).
                         If --ollama-model isn't given, shows a numbered picker
                         of the models you've already pulled locally.
    --ollama-model NAME Skip the picker and request this model from Ollama.
    --api-key KEY       Use the Claude API with this key, and PERMANENTLY save
                         it as the CLAUDE_API_KEY environment variable on this
                         system (via `setx` on Windows, or your shell profile
                         on macOS/Linux) so future runs don't need it again.
    --api-key-file FILE Use the Claude API with a key read from a file (plain
                         text or KEY=VAL). Used for this run only — not saved.
    --port PORT         Local port for the Node web server (default: 3000,
                         or $PORT if set).

The server always listens over HTTPS with an auto-generated, locally-cached
self-signed certificate (WebXR requires a secure context, and plain HTTP
only counts as one for 'localhost' — not for the LAN IP the Quest uses).
Your browser will show a one-time untrusted-certificate warning; click
through it ("Advanced" > "Proceed") on each device that connects.

Claude API key resolution order, when --ollama is not given (first one wins):
    1. --api-key CLI argument (also persisted to the system environment)
    2. --api-key-file CLI argument (path; whitespace stripped; not persisted)
    3. CLAUDE_API_KEY environment variable (e.g. from a prior --api-key run)

The resolved key is passed to the Node child via its env only — it is never
written to the PID file or logged.

Env vars honored:
    CLAUDE_API_KEY         — fallback source for the key (see above)
    PORT                   — port for the Node web server (default 3000)
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE_DIR = ROOT / "site-source"
PID_FILE = ROOT / ".vrclaude.pids"

IS_WINDOWS = sys.platform == "win32"

# ANSI colors. On Windows 10+, calling os.system("") flips the console into
# VT100 processing mode so these render correctly in cmd.exe.
if IS_WINDOWS:
    os.system("")
RESET = "\033[0m"
NODE_COL = "\033[36m"   # cyan
ERR_COL = "\033[31m"    # red
OK_COL = "\033[32m"     # green
DIM = "\033[2m"


def cprint(color, msg):
    print(f"{color}{msg}{RESET}", flush=True)


def stream_output(proc, prefix, color):
    """Pump a child process's combined stdout/stderr to our stdout, line by line."""
    try:
        for raw in iter(proc.stdout.readline, b""):
            text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            sys.stdout.write(f"{color}[{prefix}]{RESET} {text}\n")
            sys.stdout.flush()
    except Exception as e:
        sys.stdout.write(f"{ERR_COL}[{prefix}] stream error: {e}{RESET}\n")


def write_pids(pids: dict):
    PID_FILE.write_text(json.dumps(pids))


def read_pids():
    if not PID_FILE.exists():
        return None
    try:
        return json.loads(PID_FILE.read_text())
    except Exception:
        return None


def is_alive(pid):
    if not pid:
        return False
    try:
        if IS_WINDOWS:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True, text=True
            )
            return str(pid) in out.stdout
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def kill_pid(pid):
    """Best-effort terminate. On Windows uses taskkill /T to also kill children."""
    if not pid or not is_alive(pid):
        return False
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        else:
            os.kill(pid, signal.SIGTERM)
            for _ in range(20):
                time.sleep(0.1)
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    return True
            os.kill(pid, signal.SIGKILL)
        return True
    except Exception:
        return False


def persist_env_var(name, value):
    """Permanently set an environment variable on this system.

    Windows: `setx` writes it to the user's registry-backed environment
    (visible in new shells; does not affect the current process's own env).
    macOS/Linux: appended as an `export` line to the user's shell profile.
    Returns True on success, False otherwise. Never raises.
    """
    try:
        if IS_WINDOWS:
            result = subprocess.run(
                ["setx", name, value],
                capture_output=True, text=True
            )
            return result.returncode == 0
        else:
            shell = os.environ.get("SHELL", "")
            profile = ".zshrc" if "zsh" in shell else ".bashrc"
            profile_path = Path.home() / profile
            line = f'\nexport {name}="{value}"\n'
            with open(profile_path, "a", encoding="utf-8") as f:
                f.write(line)
            return True
    except Exception as e:
        cprint(ERR_COL, f"Warning: failed to permanently save {name}: {e}")
        return False


def resolve_api_key(arg_key, arg_key_file):
    """Resolve the Claude API key from the available sources.

    Priority: --api-key > --api-key-file > $CLAUDE_API_KEY.
    Returns the key as a string, or None if no source provided one.
    The key is NEVER written to the PID file or logged.
    """
    if arg_key:
        key = arg_key.strip()
        cprint(OK_COL, "Saving CLAUDE_API_KEY permanently to your system environment...")
        if persist_env_var("CLAUDE_API_KEY", key):
            cprint(OK_COL, "Saved. Future runs won't need --api-key (new shells only).")
        return key

    if arg_key_file:
        path = Path(arg_key_file).expanduser()
        if not path.is_file():
            cprint(ERR_COL, f"--api-key-file: {path} does not exist or is not a file")
            return None
        try:
            content = path.read_text(encoding="utf-8")
        except Exception as e:
            cprint(ERR_COL, f"--api-key-file: failed to read {path}: {e}")
            return None
        # Take the first non-empty, non-comment line so KEY=VAL or plain-text both work.
        for raw in content.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line and line.split("=", 1)[0].strip().upper() in (
                "CLAUDE_API_KEY", "ANTHROPIC_API_KEY"
            ):
                line = line.split("=", 1)[1].strip().strip('"').strip("'")
            return line
        cprint(ERR_COL, f"--api-key-file: {path} contained no usable key")
        return None

    env_key = os.environ.get("CLAUDE_API_KEY")
    if env_key:
        return env_key.strip()

    return None


def list_ollama_models(host="http://localhost:11434"):
    """Query a local Ollama daemon for the models it has downloaded.

    Returns a list of model name strings, or None if Ollama couldn't be
    reached (not running, wrong host, etc).
    """
    try:
        with urllib.request.urlopen(f"{host}/api/tags", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return [m["name"] for m in data.get("models", [])]
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        return None


def pick_ollama_model():
    """Interactive picker over locally-downloaded Ollama models.

    Falls back to "llama3" (with a warning) if Ollama isn't reachable or has
    no models pulled, since that's not something an interactive prompt can
    fix on the spot.
    """
    models = list_ollama_models()

    if models is None:
        cprint(ERR_COL,
               "Couldn't reach Ollama at http://localhost:11434 — is it running? "
               "Falling back to default model 'llama3'.")
        return "llama3"

    if not models:
        cprint(ERR_COL,
               "Ollama is running but has no models downloaded. Run "
               "'ollama pull <model>' first. Falling back to 'llama3'.")
        return "llama3"

    print()
    cprint(OK_COL, "Local Ollama models:")
    for i, name in enumerate(models, start=1):
        print(f"  {i}) {name}")
    print()

    while True:
        choice = input(f"Pick a model [1-{len(models)}] (default 1): ").strip()
        if not choice:
            return models[0]
        if choice.isdigit() and 1 <= int(choice) <= len(models):
            return models[int(choice) - 1]
        cprint(ERR_COL, f"Enter a number between 1 and {len(models)}.")


def spawn(cmd, cwd, env_extra=None):
    """Spawn a child with merged stdout/stderr and a new process group on Windows."""
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    if env_extra:
        env.update(env_extra)

    kwargs = dict(
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        bufsize=0,
    )
    if IS_WINDOWS:
        # Detach from our console group so Ctrl+C in our shell doesn't race
        # the child to death — we want to terminate it ourselves.
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(cmd, **kwargs)


def cmd_start(api_key=None, api_key_file=None, use_ollama=False, ollama_model=None,
              port=None):
    if not SITE_DIR.is_dir():
        cprint(ERR_COL, f"site-source directory not found at {SITE_DIR}")
        return 1
    server_js = SITE_DIR / "server.js"
    if not server_js.is_file():
        cprint(ERR_COL, f"server.js missing at {server_js}")
        return 1
    if shutil.which("node") is None:
        cprint(ERR_COL, "'node' not found on PATH — install Node.js.")
        return 1

    # All configured backends are available at once now (the browser's model
    # dropdown picks per-request), so this just decides the *default* backend
    # and makes sure its key is present — any OPENAI_API_KEY already set in
    # this shell is passed through regardless of which flags were given, so
    # OpenAI shows up in the dropdown too whenever it's configured.
    if use_ollama:
        chosen_model = ollama_model or pick_ollama_model()
        backend_env = {
            "LLM_BACKEND": "ollama",
            "OLLAMA_MODEL": chosen_model,
        }
    else:
        resolved_key = resolve_api_key(api_key, api_key_file)
        if (not resolved_key and not os.environ.get("OPENAI_API_KEY")
                and not os.environ.get("XAI_API_KEY")):
            cprint(ERR_COL,
                   "No Claude API key supplied and no OPENAI_API_KEY or "
                   "XAI_API_KEY set — pass --api-key, --api-key-file, set "
                   "OPENAI_API_KEY or XAI_API_KEY, or use --ollama for a local model.")
            return 1
        if resolved_key:
            default_backend = "claude"
        elif os.environ.get("OPENAI_API_KEY"):
            default_backend = "openai"
        else:
            default_backend = "grok"
        backend_env = {"LLM_BACKEND": default_backend}
        if resolved_key:
            backend_env["CLAUDE_API_KEY"] = resolved_key

    if os.environ.get("OPENAI_API_KEY"):
        backend_env["OPENAI_API_KEY"] = os.environ["OPENAI_API_KEY"]
    if os.environ.get("OPENAI_MODEL"):
        backend_env["OPENAI_MODEL"] = os.environ["OPENAI_MODEL"]
    if os.environ.get("XAI_API_KEY"):
        backend_env["XAI_API_KEY"] = os.environ["XAI_API_KEY"]

    if port is not None:
        backend_env["PORT"] = str(port)

    existing = read_pids()
    if existing and is_alive(existing.get("node")):
        cprint(ERR_COL,
               f"Server already appears to be running (see {PID_FILE.name}). "
               "Run 'python run.py stop' first.")
        return 1

    cprint(OK_COL, f"Starting Node web server ({'ollama' if use_ollama else 'claude'} backend)...")
    # Pass secrets/backend selection only to the Node child, not to anything we log.
    node_proc = spawn(
        ["node", "server.js"],
        cwd=SITE_DIR,
        env_extra=backend_env,
    )
    threading.Thread(
        target=stream_output, args=(node_proc, "node", NODE_COL), daemon=True
    ).start()

    write_pids({"launcher": os.getpid(), "node": node_proc.pid})

    print()
    cprint(OK_COL, "Server launched. Press Ctrl+C to stop.")
    print(f"  {DIM}Node PID: {node_proc.pid}{RESET}")
    print()

    shutting_down = {"flag": False}

    def shutdown(*_):
        if shutting_down["flag"]:
            return
        shutting_down["flag"] = True
        print()
        cprint(OK_COL, "Shutting down...")

        if node_proc.poll() is None:
            try:
                if IS_WINDOWS:
                    # taskkill /T also kills any grandchildren
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(node_proc.pid)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                    )
                else:
                    node_proc.terminate()
            except Exception as e:
                cprint(ERR_COL, f"  node: terminate failed: {e}")

        try:
            node_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cprint(ERR_COL, "  node: didn't exit, killing")
            try:
                node_proc.kill()
            except Exception:
                pass

        if PID_FILE.exists():
            try:
                PID_FILE.unlink()
            except Exception:
                pass
        cprint(OK_COL, "Done.")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, shutdown)
        except Exception:
            pass

    # Babysit: if the child dies on its own, tear down so the user notices
    # instead of leaving a stale PID file.
    try:
        while True:
            if node_proc.poll() is not None:
                cprint(ERR_COL,
                       f"Node server exited with code {node_proc.returncode}.")
                shutdown()
            time.sleep(0.5)
    except KeyboardInterrupt:
        shutdown()


def cmd_stop():
    pids = read_pids()
    if not pids:
        print("No PID file found — nothing to stop.")
        return 0
    pid = pids.get("node")
    stopped = pid and kill_pid(pid)
    try:
        PID_FILE.unlink()
    except Exception:
        pass
    if stopped:
        cprint(OK_COL, f"Stopped: node (pid {pid})")
    else:
        print("Recorded PID was already gone.")
    return 0


def cmd_status():
    pids = read_pids()
    if not pids:
        print("No PID file — launcher hasn't been used yet (or stop was already run).")
        return 0
    pid = pids.get("node")
    if not pid:
        print("  node: no PID recorded")
        return 0
    alive = is_alive(pid)
    col = OK_COL if alive else ERR_COL
    state = "running" if alive else "not running"
    print(f"  node: pid {pid} — {col}{state}{RESET}")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Start/stop the VRClaudeInterface server.",
    )
    parser.add_argument(
        "action", nargs="?", default="start",
        choices=["start", "stop", "status", "restart"],
        help="What to do (default: start)",
    )
    parser.add_argument(
        "--ollama", action="store_true",
        help="Use a local Ollama model instead of the Claude API.",
    )
    parser.add_argument(
        "--ollama-model", default=None,
        help="Ollama model name to use with --ollama. If omitted, an "
             "interactive picker lists your locally-downloaded models.",
    )
    parser.add_argument(
        "--api-key",
        help="Claude API key. Saved permanently as the CLAUDE_API_KEY system "
             "environment variable. Takes priority over --api-key-file and "
             "$CLAUDE_API_KEY. Ignored if --ollama is set.",
    )
    parser.add_argument(
        "--api-key-file",
        help="Path to a file containing the Claude API key (plain or KEY=VAL). "
             "Used for this run only — not saved. Ignored if --ollama is set.",
    )
    parser.add_argument(
        "--port", type=int, default=None,
        help="Local port for the Node web server (default: 3000, or $PORT).",
    )
    args = parser.parse_args()

    if args.action == "start":
        return cmd_start(api_key=args.api_key, api_key_file=args.api_key_file,
                          use_ollama=args.ollama, ollama_model=args.ollama_model,
                          port=args.port)
    if args.action == "stop":
        return cmd_stop()
    if args.action == "status":
        return cmd_status()
    if args.action == "restart":
        cmd_stop()
        time.sleep(0.5)
        return cmd_start(api_key=args.api_key, api_key_file=args.api_key_file,
                          use_ollama=args.ollama, ollama_model=args.ollama_model,
                          port=args.port)


if __name__ == "__main__":
    sys.exit(main() or 0)
