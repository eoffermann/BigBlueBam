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

## 2. Phase A + B delivered (verified end to end)

- **Pipeline proven on a real FBX** (Samba Dancing.fbx, skinned + animated): upload
  -> assimpjs WASM conversion -> GLB proxy (model/gltf-binary, servable) + full
  media_meta probe (counts, bounds, skeleton 52 bones, animation 546f @ 30fps) ->
  copy-forward to bay_asset_versions. Worker registered the `bin-model-process`
  queue + tick.
- **Viewer verified** (Phase A static + Phase B animated): the three.js viewer
  renders the model, the timeline transport scrubs the animation, viewpoint/spot
  annotations create and re-resolve. Captured screenshots of the Review Library
  (models listed) and the model viewer with the timeline + seeded annotations +
  decision.
- **Reproducible demo:** a tiny self-contained animated GLB ("rescue-beacon.glb",
  BeaconSpin clip) is base64-embedded in the gilligan bay seeder, with seeded
  viewpoint/spot annotations + a decision. The docs-capture recipe navigates to it
  by name.

## 3. Bugs caught + fixed via the live test/screenshot loop

- `res.GetFileCount()` -> `res.FileCount()` (assimpjs API; conversion crashed).
- Skinned-resolution strict-null (`ix[k]` index) typecheck fix.
- **Review Library filtered out model/* assets** (`isMediaContentType`) so models
  never appeared in the UI -> `isReviewableMedia` now includes model MIME +
  extensions. This was the bug that made the feature unreachable; caught only by
  screenshotting the library.

## 4. CI + promotion

- Local: bay/worker/bin-api/bay-api typecheck + lint clean; lint:migrations clean.
- main CI all green (Migration Replay, DB Drift, Seed Smoke, Lint, Test,
  Typecheck) on the first push. Promoted main -> stable.

## 5. Phase C delivered (polish/follow-up per design §11)

- **Worker meshopt geometry compression** (`bin-model-process.job.ts`): after the
  weld/dedup/prune optimize pass, the proxy runs EXT_meshopt_compression via the
  `meshoptimizer` encoder, wired as `NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder })` +
  `await MeshoptEncoder.ready` before `doc.transform(meshopt({ encoder }))`.
  Default-on behind `BIN_MODEL_OPTIMIZE`; isolated try/catch means a WASM/encoder
  failure falls back to the uncompressed (but welded) proxy with
  `compression:'none'` and never fails the job. Validated in scratch at ~84% size
  reduction with skins/animation intact; the frontend GLTFLoader already ships the
  meshopt DECODER so a compressed proxy loads with no client change.
- **A/B version compare** (`review-asset.tsx` `ModelCompare` + a "Compare versions"
  toggle): two `ModelViewer`s side by side with synced orbit (`cameraPose`/
  `onCameraChange`) and a shared clip playhead (`playhead`/`transportControlled`/
  `onClipsLoaded`), so a reviewer can scrub two versions in lockstep.
- **Screen-space draw overlay** (`model-viewer.tsx`): a Draw/Arrow toolbar renders
  a freehand/arrow SVG overlay; entering draw mode disables orbit so the overlay
  receives the pointer (`controls.enabled = drawTool == null`). `focusedDraw`
  highlights the annotation being viewed.
- **Model QC demo**: a third seeded `[Auto-QC]` model annotation (professor) in
  `scripts/seed-gilligan/bay.mjs` demonstrates §9 — agents post findings through
  the existing `bay_annotation_create` with a viewpoint anchor; no new endpoint.
- **Deferred (still)**: USDZ mobile quicklook and the headless-GL poster render
  (needs an offscreen GL stack — see §1). Neither blocks review.
