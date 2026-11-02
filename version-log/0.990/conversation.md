# GS 0.990 — exact conversation text

Verbatim messages from the thread that shipped as 0.990
(Exit VR button in the VR menu; Enter VR + version button at the top of the window; Code window scrolling in VR; grip-rotate the origin gizmo). The first messages were a voice request (text as transcribed). Hidden system prompts and tool dumps omitted. Chronological.

## 2026-11-02

### User
Add an exit VR button to the menu inside VR. It should be clearly visible and let the user leave the VR session from within the menu.

### User
Move the enter VR button to the top of the window instead of the bottom of the page. It should appear at the top of the UI.

### User
Also move the version button to sit next to the enter VR button at the top of the window, and remove it from the bottom of the screen where it currently is.

### User
In VR, the code window currently cannot be scrolled. Make it so the code window can be scrolled through in VR — add scrolling support so users can view all the code content.

### User
In the menu system, there is a gizmo with a 3D component that controls the default orientation of the camera. Make it so that in VR, when a button on the six-degree-of-freedom controller is pressed, the controller can control the orientation of that gizmo — as the user rotates the controller, the gizmo rotates along with it.

<!-- Assistant replies for the voice call and the PR #23 ready message go here: their exact text was not available when this file was written. -->

### Assistant
GS 0.989 with the mic fix is live. I checked [gsforanything.com](https://gsforanything.com), www, the workers.dev backup and [Vercel](https://vrclaudeinterface.vercel.app), and all four are serving 0.989 and loading normally. The merge was [PR #22](https://github.com/koshkakochka/gsforanything/pull/22). Future deploys will use your API token, so this login problem shouldn't come back.

The VR input changes (the Exit VR button, the buttons moved to the top, code window scrolling and gizmo rotation) are ready next. They're waiting on your pick for the version number, which is offered as 0.990.

### User
0.990 works for me

### Assistant
Great, I'll ship the VR changes as 0.990. First I'm rebasing them onto 0.989 and rerunning the tests.
