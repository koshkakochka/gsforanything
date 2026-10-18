# GS

A WebXR app that lets you talk to Claude (or a local Ollama model) inside
VR and have it modify the 3D scene live. Live deploy:
https://gsforanything.com (fallback: https://gs.krossruiz.workers.dev). See [howIWork.md](howIWork.md) for how the
pieces fit together.

## Quick start

```
python run.py --ollama                       # local Ollama model, interactive picker
python run.py --api-key sk-ant-...           # Claude API (key saved permanently)
python run.py                                # Claude API, reuses a saved key
python run.py stop / status / restart
python run.py --port 4123                    # serve on a custom port (default: 3000)
```

See `python run.py --help` for the full flag list.

## HTTPS is always on

The server always listens over `https://`, using a self-signed certificate
that's generated automatically on first run and cached under
`site-source/certs/` (regenerated if your LAN IP changes). This isn't
optional: browsers only treat a page as a "secure context" (required for
WebXR) over plain `http://` when the address is `localhost` — the moment
the Quest loads the site by your laptop's **LAN IP**
(e.g. `192.168.1.10:3000`), that's not a secure context, and
`navigator.xr` will report VR as unsupported no matter how correctly
everything else is configured. Serving HTTPS everywhere avoids that trap
regardless of how you reach the server.

The first time you open the printed URL — on the Quest browser, and on any
desktop browser you test with — you'll hit an untrusted-certificate
warning; click **Advanced → Proceed** (wording varies by browser) once per
device, and the browser will treat the session as secure from then on.
This is expected and safe here since it's your own server on your own LAN
— the warning only appears because the cert isn't signed by a public
certificate authority.

## Headset setup

### Quest 3 standalone (passthrough)

Open the `https://` Network URL the launcher prints (e.g.
`https://192.168.x.x:3000`) directly in the Meta Quest Browser on the
headset, with both devices on the same WiFi — accepting the
certificate warning once. The enter button uses passthrough so the
chat panels float in your real room.

### PCVR via Link / Air Link / SteamVR (Quest 3, Quest 2/Pro, Valve Index, HTC Vive, Windows Mixed Reality, ...)

These headsets don't expose camera passthrough to the browser, so the app
falls back to a plain `immersive-vr` session with a colored skybox instead
of a see-through background (toggle/customize this under the **Environment**
tab, or it switches automatically when a passthrough-less session starts).

For the PC's desktop browser to see the headset as a WebXR device at all,
**all** of the following must be true when you load the page:

1. **The Link/Air Link/SteamVR session is actually connected** — the
   headset must be showing the Link home environment (or SteamVR's), not
   just plugged in via USB.
2. **The active OpenXR runtime on the PC is set to the headset's runtime.**
   - Quest via Link/Air Link: Meta Quest desktop app → Settings (gear icon)
     → General tab → "OpenXR Runtime" → "Set Meta Quest Link as active."
   - Other PCVR headsets, or Quest via SteamVR: open SteamVR and make sure
     it's the active OpenXR runtime instead.
   - Installing/opening SteamVR commonly steals this setting from Meta
     Quest Link, so re-check it if VR suddenly stops being detected.
3. **You're using a WebXR-capable desktop browser** — recent Chrome or Edge.
   Firefox does not support WebXR by default.
4. **You've accepted the self-signed certificate warning** on that browser
   (see "HTTPS is always on" above) — until you click through it once, the
   page may fail to load at all rather than just lacking XR support.

If any of these isn't true, `navigator.xr.isSessionSupported()` genuinely
returns `false` for VR, and the button will read
"VR NOT SUPPORTED" — that's the browser correctly reporting no XR
runtime is available, not a bug in the page. Reload the page after fixing
the runtime setting; the button re-checks support on load.
