# BigBlueBam Bay FBX — Implementation Decisions Log

Tracks decisions while implementing FBX 3D review from
`BigBlueBam_Bay_FBX_3D_Review_Design_Document.md`. Newest section last.

**Branch:** `feat/bay-fbx` (off `main`, after the Blip merge + stable promotion).
**Started:** 2026-06-30.

---

## 0. Toolchain de-risking (the doc's "long pole" — solved)

The design doc treats worker packaging (FBX→glTF on `node:22-alpine`) as the
biggest risk: Assimp's Alpine CLI may lack a glTF exporter, Blender needs
glibc/sidecar, headless-GL for the poster needs Mesa/llvmpipe.

**Validated a pure-Node/WASM path that eliminates all of that:**
- `assimpjs@0.0.10` (MIT, WASM Assimp) + `@gltf-transform/core@4.4.0` (MIT) +
  `@gltf-transform/functions` (MIT).
- Proven in a scratch test: assimpjs loads in ~30ms, `ConvertFileList(list,'glb2')`
  converted a hand-authored OBJ to a valid GLB (glTF magic), and gltf-transform's
  `NodeIO.readBinary` probed it (meshes/nodes/animations). Assimp imports FBX
  (incl. skeletal animation) and exports glTF2 binary, so FBX is just another
  input format.
- **Consequence:** the `bin-model-process` worker job needs only
  `npm install assimpjs @gltf-transform/core @gltf-transform/functions` — **no
  apps/worker/Dockerfile change, no Alpine native packages, no Blender, no
  base-image switch.** This overrides §2.2/§10.2's packaging caveat and the
  Phase A "worker packaging is the long pole" framing.

## 1. Poster render deferred for v1

Headless 3D poster rendering is the one remaining piece that would need an
offscreen GL stack (the doc's other risk). **Decision: defer the rendered poster
to a later phase.** The viewer loads the GLB directly, so a poster thumbnail is a
nice-to-have, not a blocker. `bin-model-process` sets `poster_object_key` null for
models in v1; the UI falls back to a model glyph / first-frame-on-load. Avoids
pulling a headless-GL stack into the worker image. (Revisit in Phase C.)

---

_(entries appended as implementation proceeds)_
