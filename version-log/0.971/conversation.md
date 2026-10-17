# GS 0.971 — exact conversation text

Verbatim user messages and assistant replies from the Controls tab thread that shipped as 0.971.
Hidden system prompts and tool dumps omitted. Chronological.

## 2026-10-17

### User
Can you add a controls tab to the menu? Have it be able to use WASD and the mouse for free-roam camera controls, orbit controls (the default) around the origin of the scene, and the ability to disable controls all-together.

### Assistant
Sure. I'll add a Controls tab with three modes: Orbit as the default, Free-roam with WASD and the mouse, and Off. I'll test it on my computer before asking you for a version number.

### Assistant
I'm building the Controls tab now. I'll show you screenshots when it's ready to look at.

### Assistant
The Controls tab is built and passed all my tests on my computer. It has three modes:

- **Orbit** is the default. Drag to orbit, scroll to zoom and right-drag to pan; picking Orbit centres the orbit on the scene origin.
- **Free-roam** uses WASD to move and Q/E for up and down, with Shift to go faster. Click the scene to look around with the mouse, and press Esc to release it.
- **Off** stops all camera input.

Your choice is saved between visits, typing in the chat box never moves the camera, and headset controls are unchanged.

One choice for you: right now, Orbit only centres on the origin when you click the Orbit button. If it did that on first load too, everyone's starting view, including share links, would begin 4 m back from where it does today.

### User
Ship as 0.971 with Orbit centred on the origin from first load

### Assistant
Got it. I'll make Orbit centre on the origin from first load, check it, then ship as **0.971** to Vercel and Cloudflare.

### User
No panning for the orbit controls.

### Assistant
Got it. I'm turning off panning in Orbit so it stays centred on the origin, and I'll include that in this 0.971 ship.
