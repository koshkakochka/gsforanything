# Model import (PLY splats + export formats)

Users can import a 3D model from the Scenes tab (**Import model**), a file
picker, or a drag-and-drop onto the 3D view. Supported:

- Gaussian splat `.ply` (INRIA 3DGS / compressed SuperSplat when Spark can
  read it), plus `.spz` / `.splat` / `.ksplat`
- Every format GS can export: `.glb`, `.gltf`, `.fbx`, OBJ `.zip` (or loose
  `.obj` + `.mtl`), Blender `.zip` (`.glb` + `open_in_blender.py`)
- `.vrscene.json` still uses **Import .vrscene.json**
- A plain point-cloud `.ply` falls back to `THREE.Points`

Imported models can be moved, rotated and scaled (desktop TransformControls,
click to select, W/E/R; in XR, grip-grab, two-hand or thumbstick scale).
Transforms are written back into the `gsImportModel({ transform })` code
block and saved / uploaded with the scene.

    BASE=https://localhost:3588 SHOT=/workspace/gs-ply-shots/imported-splat.png node test.mjs

Uses a tiny synthetic splat `.ply` generated in the test (no real model
download). `/api/*` is stubbed. Dummy keys only.
