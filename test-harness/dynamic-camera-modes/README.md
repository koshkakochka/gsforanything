# Dynamic camera modes (gsControls.registerCameraMode)

Serve `site-source` with fake keys (`CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3761 node server.js`), then:

    BASE=https://localhost:3761 SHOT_DIR=/workspace/gs-dyncam-shots node test.mjs   # SKIP_VR=1 skips the IWER part

`/api/chat` is stubbed with a sample third-person shooter whose `vr-exec` block
registers "Custom 3rd Person Controls" (follow camera, WASD params, distance
slider, `sticks: true`). Nothing reaches an LLM; Community writes are blocked.

- Prompt: the always-added chat section documents `registerCameraMode`.
- The reply adds the button after Orbit / Map / Fly / First person / Off and
  activates it at once (activate once, no stock control, no key-remap rows,
  help text, not saved as the preference, on-screen sticks shown).
- Follow camera: update every frame, W walks the player, camera 4 m behind;
  the distance param updates live; "Keys and settings" opens its Custom
  Controls card.
- Custom → each built-in mode (deactivate, stock control, update stops,
  choice saved) and back (activate again); Map keys work after the hand-back;
  clicking the active custom button is a no-op.
- Hot reload (same id) while active / while on a built-in mode; a mode that
  re-parents the camera and changes fov is undone on leave; a throwing
  activate falls back; invalid id; unknown `custom:*` mode; handle
  activate / deactivate.
- Clear All From Scene, importing a scene file, loading another scene, and a
  stale `custom:tps` preference (loads as Map).
- Phone: full-width ≥44 px button, built-in grid intact, no overflow, the
  on-screen left stick walks the player, Map hides the sticks.
- VR (IWER Quest 3): update hook idle during the session, ray clicks on Orbit
  and on the custom button switch modes through the painted menu.
