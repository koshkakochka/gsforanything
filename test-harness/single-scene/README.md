# Single active scene – headless test

GS has exactly one active scene. Loading a scene from Community, a share link
(`/e/:id`), a scene file or Load Saved replaces what is in the world, the
Code tab and the chat history (no layering, no stacked histories).

`test.mjs` (puppeteer-core + headless Chrome, swiftshader; `/api/chat` and
`/api/backends` are mocked, no real tokens) on the Vercel simulator:

    cd ../creation-context && SIM_PORT=3621 node vercel-sim.mjs &
    cd ../single-scene && HOSTS=vercel-sim=http://localhost:3621 SHOTS=/tmp/single-shots node test.mjs

It publishes two scenes ("Scene Alpha", "Scene Beta") with creation context
from two author sessions, then in a visitor session checks:

- no layer UI: no Clear first / Layer load mode, no Export Combined, no
  Import Folder or multi-file picker, no scene checkboxes or × buttons;
- Community A then B: only B's objects, B's code, B's chat history (one
  history card), one loaded context, only B's row marked active, and the next
  chat request carries only B's history;
- GLB / glTF / FBX / OBJ / Blender exports, Save to Device (.vrscene),
  Community publish (code + creation context) and Share link all use only the
  active scene (and its name);
- back-to-back Load clicks (A, B) end with B only; a chat reply that arrives
  after the scene changed is dropped;
- importing a scene file replaces the scene and resets the chat; Clear scene
  empties the world, Code tab and chat;
- `/e/A` then Community B; phone viewport A then B; no page errors.
