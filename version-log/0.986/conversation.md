# GS 0.986 — exact conversation text

Verbatim user messages from the thread that shipped as 0.986
(HDRI / sky domes and render distance always fit the whole scene). Hidden system prompts and tool dumps omitted. Chronological.

## 2026-11-02

### User
Update the AI's system prompt so that when generating scenes with an HDRI background dome, the dome always expands to the largest size of the scene and fits all objects inside it. Currently the dome is a fixed size and scenes larger than it get cut off. The dome should dynamically scale to encompass the full scene bounds including every object placed in the scene.

### Assistant
Got it. I'm updating the scene AI's instructions so the HDRI dome always grows to fit the whole scene and every object in it, instead of staying a fixed size. I'll put it on its own branch with tests and come back to you before anything ships.

### User
Also update the AI's system prompt so the render distance is always sufficient to render everything in the scene at once — no objects should be clipped or omitted due to render distance limits. The render distance should dynamically match or exceed the full scene bounds.

### Assistant
Will do. I'm adding that to the same update: the camera's view distance will always stretch past the whole scene, so nothing gets clipped or left out because it's too far away.

### User
Ship the dome fix as 0.986

### Assistant
I'm shipping the dome and render-distance fix as 0.986 now. It'll go live on all four sites, and I'll confirm once I've checked each one.
