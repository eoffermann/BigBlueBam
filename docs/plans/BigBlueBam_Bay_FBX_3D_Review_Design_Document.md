<!-- AGENTS: Do not delete, move, or modify this document unless the user
     specifically directs you to act on it. It is an intentional product
     proposal kept here for future consideration. It is not stray output,
     not part of any current feature branch, and not yours to clean up. -->

# BigBlueBam Bay — FBX Preview and 3D Annotation — Design Document v0.1

**Author:** Big Blue Ceiling Prototyping & Fabrication, LLC
**Date:** June 30, 2026
**Status:** Draft — Awaiting Approval
**Extends:** `BigBlueBam_Bay_Design_Document.md` (§7 anchor model, §9.1 players, §18 Phase 3)

This document specifies FBX review in Bay: an FBX stored in Bin, previewed and annotated in Bay, for both static meshes (remember a viewpoint, highlight a spot on the surface, attach a note) and animated takes (scrub the clip, annotate a frame, the same way Bay annotates video today).

---

## 0. Baseline correction (code is ground truth)

The shipped code has moved past the v0.1 Bay doc in ways that matter for this feature, so the spec is written against the repo, not the doc:

- **Canonical bytes live in Bin, not Bay.** `bay_assets.bin_asset_id` is a 1:1 link to the Bin asset; `bay_asset_versions.bin_asset_id` / `bin_version_id` point at the Bin version that holds the bytes. Bay stores no media of its own. (v0.1's "Bay owns its own MinIO until Bin ships" is obsolete.)
- **`media_kind` is already `image | video | audio | model`** (CHECK on `bay_assets`). 3D is `model`. No new kind is needed; FBX is an ingest *format* that yields a `model` asset.
- **Derived media is two scalar slots on `bin_assets`, not a `bay_version_media` table.** Bin holds `object_key` (original) plus `proxy_object_key` / `proxy_content_type` and `poster_object_key`, with `transcode_status` and `scan_status` gating. Serving is three variants: `original | proxy | poster` (`apps/bay-api/src/lib/bin-media.ts`).
- **Annotations are one discriminated `anchor` jsonb**, not `anchor_type` + `anchor`. Live shape (`apps/bay-api/src/db/schema/bay-annotations.ts`): `{ type: 'frame' | 'timerange' | 'region' | 'viewpoint', ... }`. There is no `drawing` column, no `is_qc`, no replies table (threading is `thread_parent_id`), `resolved` is a boolean. The `viewpoint` variant currently carries only `camera`.
- **Processing is a worker sweep** (`apps/worker/src/jobs/bin-transcode.job.ts`) that claims clean Bin assets and writes proxy/poster. It explicitly retires every non-image/video/audio row to `transcode_status='skipped'`, so **today an uploaded FBX is skipped and never gets a proxy.** That retirement clause is the first thing this feature changes.

Net: FBX review is an *extension* of three live surfaces (the Bin worker, the `viewpoint` anchor, and a not-yet-built Bay viewer), not a new subsystem.

---

## 1. The shape of the thing

```
FBX uploaded to Bin ─► bin_assets.object_key (canonical, immutable)
        │
        ├─ worker (bin-model-process) ─► proxy_object_key   = <key>.proxy.glb   (model/gltf-binary)
        │                                poster_object_key  = <key>.poster.png  (¾ framing render)
        │                                media_meta (probe) = animations, bounds, counts, units
        │
Bay asset (media_kind='model') ─► bin_asset_id 1:1
   └─ bay_asset_versions[n] ─► bin_version_id, media_meta (copied probe)
          └─ bay_annotations ─► anchor {type:'viewpoint', camera, time?, surface?, draw?}
```

The viewer loads the **GLB proxy** (self-contained, browser-native via three.js), never the FBX. The original FBX is download-only (gated by `can_download`, default off for guests), for artists who want the source back.

One GLB carries both cases: glTF encodes node-TRS and skeletal (skin) animation, so a static mesh and an animated take are the same proxy format. `media_meta.has_animation` is the only thing the UI branches on.

---

## 2. Ingest and processing

### 2.1 Detection

Bin must stop trusting the absence of an `image/ video/ audio/` MIME prefix to mean "skip." Model detection is by **extension first, magic bytes second**. Note this is genuinely new logic, not an extension of existing behavior: `bin-transcode.job.ts` today keys *entirely* off `content_type` LIKE-prefixes (`mediaKind()` reads only the MIME prefix) and never consults the filename extension or magic bytes. Model uploads commonly arrive as `application/octet-stream`, so MIME alone cannot route them.

- Extensions routed to the model path (matched against `bin_assets.name` / `object_key`): `.fbx .obj .stl .glb .gltf .ply .dae .usd .usdz .usdc .usda`.
- FBX magic-byte sniff (binary FBX begins with the 20-byte literal `Kaydara FBX Binary  ` then `0x00 0x1A 0x00`; ASCII FBX begins with `; FBX`). Used to confirm `.fbx` and to catch mislabeled uploads.

The fix in `bin-transcode.job.ts` is narrow but has two parts, because the "retire to skipped" step is a pure SQL `UPDATE ... WHERE content_type NOT LIKE 'image/%' ...`:

1. Make that retire `UPDATE` **extension-aware** so a model row (recognized by a known extension on `name`/`object_key`, even with an `octet-stream` content type) is *not* swept into `skipped`.
2. Let the dedicated `bin-model-process` job claim those rows by the same extension/MIME predicate.

### 2.2 The model job (`apps/worker/src/jobs/bin-model-process.job.ts`)

A separate job, not a branch inside the ffmpeg job, because the toolchain and the failure modes are different (ffmpeg has nothing to say about a rig). Same sweep contract as `bin-transcode`: once-a-minute sweep plus on-demand `{ asset_id }`, gated on `scan_status IN ('clean','skipped')`, claims `transcode_status='pending'` model rows, advances to `done` / `error`.

**Worker wiring (not just a file).** Mirror `bin-transcode`'s registration in `apps/worker/src/worker.ts`: a `new Worker('bin-model-process', ...)`, a `new Queue('bin-model-process', ...)`, a repeatable `bin-model-process-tick` upsert with `{ pattern: '* * * * *' }`, plus adding the worker to the graceful-shutdown array and the closeable worker list. The model rows and AV/transcode rows share `transcode_status`, so the two sweeps must not both claim the same row: the model job claims by the model predicate, and (per §2.1) the transcode retire-step must exclude model rows.

Per asset it does four things:

1. **Convert to GLB.** Source (FBX/OBJ/STL/etc.) to a single self-contained `.glb`. Toolchain decision in §10.1; lead is **Assimp (BSD-3)**. Skinned meshes and animation tracks are preserved; the glTF is Y-up, meters, right-handed (the glTF convention), with the source up-axis and unit scale recorded in `media_meta` so the viewer can label "source was Z-up / cm."
2. **Optimize (optional, flagged).** `gltf-transform` pass: weld, prune, dedup, and **meshopt** geometry compression (MIT; preferred over Draco's Apache-2.0 to keep the dependency graph MIT-clean). Behind `BIN_MODEL_OPTIMIZE` because aggressive welding can move vertices and is wrong for some QC-sensitive reviews; default on for proxies, off when the review is explicitly a geometry-integrity check.
3. **Probe.** Inspect the GLB document and emit `media_meta` (§3). This is where animation clips, fps, bounds, and counts come from. No second tool: `gltf-transform`'s document model gives all of it.
4. **Render a poster.** A single ¾-view thumbnail at a deterministic auto-framing (camera placed on the bounding sphere, looking at center, light from camera-up-right). Headless render. CPU is fine at thumbnail quality (§10.6); GPU rendering is out of scope for v1 because it would require new infrastructure (see §2.3), not a configuration flag.

Artifacts land next to the canonical object (`<key>.proxy.glb`, `<key>.poster.png`) and are recorded on `bin_assets` via the worker's existing `putObjectFromFile` / `downloadObjectToFile` storage utils (`apps/worker/src/utils/storage.js`, already used by `bin-transcode`), exactly as video/audio proxies are today. `proxy_content_type` is `model/gltf-binary`.

**Packaging is the real cost.** The worker image is `node:22-alpine` (musl), which today only `apk add`s `ffmpeg`. The model toolchain is not a clean Alpine add:
- **Assimp** ships an `assimp` package in the Alpine community repo, but confirm the build includes the **CLI exporter** with glTF2 output before committing to a shell-out; if not, drive Assimp via a small Node/native binding or fall back to a Node-side glTF writer (`ufbx` parse + `@gltf-transform` write).
- **Blender** is effectively unavailable as an Alpine package (glibc-based, very large, and needs a GL/EGL stack). Adopting it as the high-fidelity fallback means either switching the worker base image to a glibc distro (e.g. `debian-slim`) or running Blender in its own sidecar container the worker shells into over a queue. Either is a larger change than "invoke a CLI."
- **Headless poster rendering** likewise needs an offscreen GL stack (EGL + a software rasterizer such as Mesa/llvmpipe, or `gl`/`headless-gl` native deps). Alpine does not provide this out of the box. Budget image-size and build-time growth accordingly.

Treat the worker Dockerfile change (base image and/or new system packages) as a first-class Phase A task, not an afterthought.

### 2.3 Where it runs (no pool architecture exists)

The earlier draft placed this on "Pool B" with a "scale-to-zero image-gen profile" and reserved "Pool C" for real-time. **None of that infrastructure exists in the repo.** The worker is a single BullMQ processor in one `apps/worker` container with no exposed port and no GPU; there is no pool tiering and no image-gen service to borrow a profile from.

So, against the as-built suite:

- Conversion, probe, and poster render all run **in-process in the one worker container**, as ordinary BullMQ jobs, exactly like `bin-transcode`'s ffmpeg work does today.
- They are CPU-bound and bursty. The existing mitigations apply unchanged: a small per-sweep `limit` (ffmpeg uses 5), a hard per-invocation timeout (`bin-transcode` uses `BIN_TRANSCODE_TIMEOUT_MS`), and `transcode_status` claiming so two workers do not double-process a row.
- Large or pathological files are the real risk on a shared worker: a multi-million-triangle FBX can pin a core for minutes and starve email/notification/export jobs sharing the process. v1 mitigation is a conservative file-size ceiling (reject/skip with a loud `error` above, say, a few hundred MB) and the per-job timeout. A dedicated `worker-heavy` container or an actual GPU tier is a *future* infra change to design separately, not a precondition this doc can assume.
- Poster render is CPU headless for v1 (§10.6). GPU rendering would require new infrastructure (a GPU host and a GL/EGL stack in the image), so it is explicitly out of scope for v1, not a configuration toggle.

---

## 3. `media_meta` contract for models

The probe writes this onto `bin_assets.media_meta` (new column, §10.1 decision) and Bay copies it to `bay_asset_versions.media_meta` at version-complete. The viewer reads it without a round-trip to the bytes.

```jsonc
{
  "kind": "model",
  "source_format": "fbx",
  "source_up_axis": "z",          // as authored; the GLB is normalized to y-up
  "source_unit": "cm",            // for the "1 unit = 1 cm" label
  "bounds": {
    "min": [x, y, z],
    "max": [x, y, z],
    "center": [x, y, z],
    "radius": 1.84                // bounding-sphere radius, drives auto-framing + surface spot scale
  },
  "counts": {
    "nodes": 1240,
    "meshes": 42,
    "triangles": 1850000,
    "materials": 12,
    "textures": 8
  },
  "skeleton": { "present": true, "bones": 78 },
  "has_animation": true,
  "animations": [
    { "id": "anim_0", "name": "Idle",  "duration_sec": 2.50, "fps": 30, "frame_count": 75 },
    { "id": "anim_1", "name": "Walk",  "duration_sec": 1.20, "fps": 30, "frame_count": 36 }
  ],
  "proxy": { "format": "glb", "compression": "meshopt", "triangles": 920000 }
}
```

`fps` per clip is the spine of frame-accurate animated annotation. glTF animation tracks are sampled in seconds (not integer frames), so `frame` is derived: `frame = round(time_sec * fps)`. `fps` comes from the source FBX scene frame rate where the importer exposes it, defaulting to 30 (then 24) when it does not; the default is recorded so the number is never silently wrong. This mirrors how video frame accuracy depends on the exact `fps_num/fps_den` rational, adapted to per-clip animation.

For a **static** model the probe still runs but `has_animation:false` and `animations:[]`; the UI shows no timeline.

---

## 4. Serving (no new variant)

The viewer loads `GET /bay/.../raw?variant=proxy` and gets the GLB. The poster serves as `variant=poster`. The FBX serves as `variant=original` only when download is permitted. `ServeVariant = 'original' | 'proxy' | 'poster'` already covers all three. There are **two** serving paths and both already read `proxy_content_type` straight off the `bin_assets` row, so neither needs a code change for models, only the data (a `model/gltf-binary` proxy content type written by the job):

- the authenticated player goes through Bin's own `/assets/:id/raw` (`apps/bin-api/src/services/asset.service.ts` resolves `asset.proxy_content_type ?? 'application/octet-stream'`);
- the public guest player goes through `apps/bay-api/src/lib/bin-media.ts` (`resolveTarget` resolves the same field).

Range support already exists (`getRange` on the storage driver), so a large GLB streams. One small read-path addition: neither serving `SELECT` fetches `media_meta` today, but the viewer reads `media_meta` from `bay_version_get` (`bay_asset_versions.media_meta`), not from the byte-serving row, so no change is needed there.

---

## 5. The 3D anchor model (the heart)

The live `viewpoint` anchor is `{ type:'viewpoint', camera:{...} }`. This extends it with two *optional* sub-objects, `time` and `surface`, plus an optional screen-space `draw`. The decision (§10.3) is to keep **one** `viewpoint` type rather than splitting static and animated, because the camera is the common spine of every 3D note (you always need to know what the reviewer was looking at), and time and surface are orthogonal refinements layered on top.

```jsonc
{
  "type": "viewpoint",

  // ALWAYS present. The remembered view. Click the note -> fly back to exactly this.
  "camera": {
    "position": [x, y, z],
    "target":   [x, y, z],
    "up":       [x, y, z],
    "fov":      35,
    "projection": "perspective"        // or "orthographic" with "ortho_height"
  },

  // OPTIONAL. Present only for animated takes. Pins the moment.
  "time": {
    "clip_id": "anim_1",               // matches media_meta.animations[].id; null = bind pose
    "frame": 18,                       // canonical integer
    "time_sec": 0.6,                   // convenience mirror
    "fps": 30                          // copied from the clip so frame<->time is reproducible offline
  },

  // OPTIONAL. The highlighted spot on the mesh. Two robustness tiers.
  "surface": {
    "mode": "geometry",                // "geometry" (glued to the mesh) | "screen" (camera-relative fallback)

    // geometry mode: anchored to the surface, survives orbit and (for skinned meshes) re-pose
    "node": "Body_LOD0",               // glTF node path of the hit mesh
    "primitive": 0,
    "tri": 15233,                      // triangle index within that primitive
    "bary": [0.21, 0.34, 0.45],        // barycentric coords of the hit point on that triangle
    "local_point": [x, y, z],          // hit point in the node's local space (static quick-reframe fallback)
    "radius": 0.05,                    // spot radius in model world units; a disc/sphere drawn on the surface

    // screen mode: when geometry picking is unavailable (instanced/huge scenes), a box in the captured viewport
    "rect": { "x": 0.31, "y": 0.22, "w": 0.14, "h": 0.09 }   // normalized 0..1 to the captured camera frame
  },

  // OPTIONAL. Freehand markup, screen-space relative to the captured camera (mirrors video drawing).
  "draw": {
    "strokes": [ { "color": "#ff3b30", "width": 0.004, "points": [[0.31, 0.22], [0.33, 0.24]] } ],
    "shapes":  [ { "type": "arrow", "from": [0.40, 0.50], "to": [0.55, 0.50] } ]
  }
}
```

All freeform inside the existing `anchor` jsonb, so **zero schema migration** on `bay_annotations`. The discriminated `type` stays `viewpoint`; agents and the `bay_annotation_create` tool keep working unchanged (the anchor is opaque to the tool layer).

### Reproducibility guarantees

- **Static mesh.** `camera` + `surface(geometry)`. Orbit freely: the highlight stays glued to the surface because it is anchored to `(node, tri, bary)`, not to pixels. Clicking the note flies the camera back to `camera`. "This seam, here" reproduces exactly.
- **Animated take.** Add `time`. Opening the note: select `clip_id`, scrub to `frame`, evaluate the posed (skinned) mesh at that frame, resolve the surface point against the *deformed* geometry, fly to `camera`. "This clipping pokes through at frame 18 of Walk, from this angle" reproduces exactly: pose, plus camera, plus surface point.

The hard part is "resolve the surface point against the deformed geometry." §6.

---

## 6. Surface picking and skinned re-resolution

### 6.1 Capture (on click)

The reviewer clicks the viewport. A three.js `Raycaster` against the currently posed mesh yields an intersection with `face` (vertex indices a,b,c), `point` (world), and the mesh `object`. From that:

```ts
/**
 * Build a geometry-anchored surface descriptor from a raycast hit.
 *
 * Stores the triangle + barycentric coordinates (not a world point), so the
 * highlight can be re-resolved from any camera and, for skinned meshes, at any
 * animation frame. local_point is a cheap fallback for static quick-reframe.
 *
 * @param hit   The first Raycaster intersection under the cursor.
 * @param frame The active animation frame at capture time, or null if static.
 * @returns The `surface` sub-anchor (geometry mode).
 */
function captureSurface(hit: THREE.Intersection, frame: number | null): SurfaceAnchor {
  const mesh = hit.object as THREE.Mesh;
  const geom = mesh.geometry as THREE.BufferGeometry;
  const tri = hit.faceIndex!;                       // triangle index
  const bary = barycentricOf(hit.point, hit.face!, geom, mesh); // (u,v,w), see below
  const localPoint = mesh.worldToLocal(hit.point.clone());
  return {
    mode: 'geometry',
    node: nodePathOf(mesh),
    primitive: primitiveIndexOf(mesh),
    tri,
    bary: [bary.x, bary.y, bary.z],
    local_point: [localPoint.x, localPoint.y, localPoint.z],
    radius: defaultSpotRadius(geom),                 // ~2-3% of bounding-sphere radius
  };
}
```

Barycentric coordinates come from the hit `point` and the triangle's three *posed world* vertices (for a static mesh, the local vertices suffice). Storing `(tri, bary)` instead of the world point is the whole trick: a world point is only correct for the pose and camera it was taken in.

### 6.2 Re-resolution at view time

**Static mesh:** trivial. Look up the triangle's three local vertices, interpolate by `bary`, transform by the node's world matrix. Done.

**Skinned mesh at frame F:** the triangle's three vertices deform under linear blend skinning, so re-resolve them, then interpolate:

```ts
/**
 * Resolve a geometry-anchored surface point to a world position at a given
 * animation frame, accounting for skeletal (linear blend) skinning.
 *
 * Only the three vertices of the hit triangle are skinned on the CPU (cheap),
 * then combined by the stored barycentric weights. Bone matrices are sampled by
 * the AnimationMixer already scrubbed to the target frame, so this reads the
 * live skeleton rather than re-evaluating tracks.
 *
 * @param surface  The geometry-mode surface anchor (node, tri, bary).
 * @param mesh     The SkinnedMesh, with its Skeleton already posed to the frame.
 * @returns The deformed world-space point of the highlight.
 */
function resolveSkinnedPoint(surface: SurfaceAnchor, mesh: THREE.SkinnedMesh): THREE.Vector3 {
  const geom = mesh.geometry;
  const idx = geom.index!;
  const base = surface.tri * 3;
  const vIds = [idx.getX(base), idx.getX(base + 1), idx.getX(base + 2)];

  // Linear blend skinning for exactly the 3 triangle vertices.
  const skinned = vIds.map((vid) => skinVertex(vid, mesh));   // bindMatrix, boneMatrices, weights
  const [w0, w1, w2] = surface.bary;
  return skinned[0].multiplyScalar(w0)
    .add(skinned[1].multiplyScalar(w1))
    .add(skinned[2].multiplyScalar(w2));
}
```

`skinVertex` does the standard LBS: for each of the (up to 4) influencing bones, `boneMatrix * bindMatrixInverse * bindMatrix * position`, weighted by `skinWeight`, summed. three.js does not expose CPU-skinned positions directly, but doing it for three vertices is negligible. The mixer is scrubbed to F first (so the skeleton is live), the point is resolved, and the highlight disc is placed and oriented to the local surface normal.

This is the technically meaty path and the reason the review surface is **custom three.js, not `@google/model-viewer`** (§7): model-viewer does not expose the skeleton, the raycaster, or programmatic camera capture.

### 6.3 Fallbacks

- **Screen mode** (`surface.mode:'screen'`, a `rect` normalized to the captured camera frame) is the escape hatch for scenes where geometry picking is unreliable (heavy instancing, point clouds, missing index buffers). It is exactly the video `region` idea, tied to a remembered camera instead of a frame. Less robust under orbit (it only makes sense from `camera`), but always available.
- **`draw`** strokes are likewise screen-space relative to `camera`, the same overlay the video player uses, reused verbatim.

Lead: geometry mode for the common case (a clean character or prop), screen mode offered automatically when the raycast misses or the mesh has no index.

---

## 7. Frontend viewer

### 7.1 Component

Custom three.js (MIT) review viewer, not model-viewer. **Every dependency below is net-new to Bay.** `apps/bay/package.json` currently ships only React, TanStack Query, Zustand, Radix, lucide, clsx, date-fns, and zod. There is no existing 3D, WebGL, or animation library to build on. All are permissive (consistent with the v0.1 license stance and the tldraw caution):

- `three` (MIT): scene, `GLTFLoader`, `AnimationMixer`, `Raycaster`. **New dep.**
- `OrbitControls` or `ArcballControls` from three examples (MIT, bundled with `three`): orbit/pan/zoom.
- meshopt decoder (MIT) for compressed proxies. **New dep.**
- The highlight disc, screen overlay, and transport are plain three.js + canvas/SVG, matching how the video player draws, so no *additional* heavy dep beyond `three` itself.

`@google/model-viewer` (Apache-2.0) may remain as an *optional* lightweight quicklook for USDZ on mobile (Apple Quick Look), but it is not the annotation surface. Lean: ship without it initially; revisit if mobile AR quicklook is requested.

### 7.2 Camera capture / restore

"Remember this viewpoint" snapshots `OrbitControls` target plus camera position/up/fov into `anchor.camera`. Restoring tweens the camera back over ~400ms so the reviewer sees *how* the view was framed, not a hard cut. (Motion is **not** currently a Bay dependency, contrary to the earlier draft, so the tween is either a small manual `requestAnimationFrame` ease against the three.js camera (no new dep) or `motion` added explicitly. A hand-rolled rAF tween is the lighter choice here and avoids pulling an animation library in just for one camera fly.)

### 7.3 Animated transport (mirror the video player)

For `has_animation:true`, reuse the video player's transport vocabulary against the animation timeline instead of a `<video>`:

- Play/pause, scrub bar, **frame counter** (`f18 / 36 · 30fps`), J/K/L transport, `,` / `.` frame step, loop-range select.
- A **clip selector** (`Idle ▾ / Walk`) when `animations.length > 1`; switching clips re-scopes the timeline and the rail.
- Scrubbing drives `mixer.setTime(frame / fps)`; the skeleton updates; any open surface annotation re-resolves live (§6.2).

For static models there is no timeline: just the orbit viewport, a "remember viewpoint" affordance, and the rail.

### 7.4 Annotation rail

Shared with the rest of Bay. For models the rail groups by:
- **Static / viewpoint notes** (no `time`): sorted by creation, each a camera thumbnail.
- **Per-clip notes** (have `time`): grouped under their clip, sorted by `frame`, click to scrub + fly.

### 7.5 Wireframes

Static mesh review:

```
┌───────────────────────────────────────────────────────────────┐
│ helmet_hero · v3 ▾   [in_review]            Review: Look-dev ▾ │
├──────────────────────────────────────────────┬────────────────┤
│                                              │ Annotations     │
│            ┌──────────────────────┐          │ ───────────────│
│            │      3D viewport      │  ◉←spot  │ ◉ Eddie        │
│            │   (orbit / pan / zoom)│          │   seam visible │
│            │                      │          │ ◉ QC-bot       │
│            └──────────────────────┘          │   1.85M tris   │
│  ⟲ reset view   ⊕ remember viewpoint          │   over budget  │
│  1 unit = 1 cm · 1.85M tris · y-up (src z-up) │                │
├──────────────────────────────────────────────┴────────────────┤
│ ◉ spot  ✎ draw  ↗ arrow   |  Comment ________  [Post]          │
│ Decision:  ✓ Approve   ⟳ Changes   ✕ Reject                    │
└───────────────────────────────────────────────────────────────┘
```

Animated take review (note the added timeline, identical to the video transport):

```
│  ◀◀ ◀ ▮▮ ▶ ▶▶   f18 / 36   30fps   Clip: Walk ▾   loop[ ]      │
│  ▭▬▬▬◉▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ clip timeline (◉ = note)  │
```

---

## 8. Compare (Phase C)

The video A/B compare generalizes to models: two versions side by side with a **synchronized orbit** (one camera drives both) and, for animated, a **synchronized clip playhead**. The wipe slider becomes a clip-plane or a split viewport. Useful for "did v4 fix the shoulder weighting v3 had." Same `bay_review` machinery, two `bay_review_items`.

---

## 9. Agents as first-class reviewers (model QC)

**`bay_qc_run` does not exist yet.** It is a *planned* tool in the base Bay design doc §14 (where it was also paired with an `is_qc` annotation column that was never built). So there is nothing to "extend." The good news is the actual mechanism below needs no new tool: model QC findings are ordinary annotations posted through the **existing** `bay_annotation_create` MCP tool (whose `anchor` is opaque `z.record(z.unknown())`, so a `viewpoint` anchor carrying the richer fields just works). If a dedicated `bay_qc_run` is built later, it would orchestrate exactly these checks; until then an agent runs the checks itself and posts the results as annotations.

The model checks an agent posts as `viewpoint`-anchored or asset-level notes:

- Triangle/material budget over spec (counts from `media_meta`).
- Missing UVs, missing normals, degenerate triangles.
- Scale/unit sanity (`source_unit` vs. an expected real-world size), root transform not at origin.
- Skeleton sanity: unskinned verts, bones with no weight, non-uniform bind scale.
- Animation frame-rate mismatch (clip `fps` not equal to the project's delivery fps), clips not starting at frame 0, root motion present/absent against spec.

These post through the same MCP/identity/audit path as a human note, with `actor_type` auto-distinguishing agent from human in the activity log. No model-specific tool and no `bay_qc_run` dependency; QC findings are ordinary `bay_annotation_create` annotations with `body` text and a `viewpoint` anchor framing the offending region.

---

## 10. Open decisions (with leanings)

1. **Where model metadata lives.** Add `media_meta jsonb` to `bin_assets` (additive migration) vs. compute it only into `bay_asset_versions.media_meta`. **Lean: add it to `bin_assets`.** The probe describes the bytes, not the review surface; putting it with the canonical asset means any future consumer (Bin's own viewer, Beacon embeds) gets it free, and Bay just copies it forward. `bin-media.ts` already does a raw `bin_assets` SELECT, so the read path exists.

2. **FBX-to-glTF toolchain.** **Lean: Assimp (BSD-3-Clause)** as primary: imports FBX including skeletal animation, exports glTF2/GLB, clean permissive license. `ufbx` (MIT) noted as a parser-only alternative if Assimp's FBX importer proves lossy on complex rigs (you would write the glTF export). **Blender headless as the high-fidelity fallback**, invoked strictly as an external CLI: this is mere aggregation, the GPL does not propagate to BBB because Blender is not linked into the codebase, only shelled out to. **Avoid FBX2glTF**: its reliance on the proprietary Autodesk FBX SDK is exactly the non-permissive dependency the suite refuses. **Packaging caveat (decides as much as the license does):** the worker is `node:22-alpine`. Assimp's CLI may or may not be in the Alpine build; Blender is not a practical Alpine package at all (see §2.2). The license cleanliness is necessary but not sufficient. If avoiding a base-image change is a goal, the all-Node path (`ufbx` MIT parse plus `@gltf-transform` MIT write, no native CLI, no Blender) is worth prototyping first even though it carries more of the conversion burden in our own code; reserve Blender for a glibc-base or sidecar follow-up.

3. **One `viewpoint` type vs. split.** **Lean: one type** with optional `time` and `surface`. A separate `modelframe` type would duplicate the camera spine and double the agent contract for no queryable benefit; `WHERE anchor->>'type'='viewpoint' AND anchor->'time'->>'clip_id'=...` already filters animated notes.

4. **Surface region representation.** Spot (`local_point`/`tri`+`bary` plus `radius`, a disc on the surface) vs. a brushed surface loop (selected-triangle set). **Lean: spot for v1.** A brushed loop is the nicer "circle this exact panel" affordance but expensive to capture and store; defer to a later pass.

5. **Skinned re-resolution vs. bake-at-capture.** Re-resolve the 3 hit-triangle verts per frame on the CPU (glued under re-pose) vs. bake the highlight to screen-space `rect` at capture time (cheap, loses glue if you orbit or scrub away). **Lean: re-resolve** for geometry mode (it is three vertices), with screen mode as the explicit cheap fallback.

6. **Poster render placement.** CPU headless render vs. Pool B GPU. **Lean: CPU for v1** (thumbnail quality does not need Cycles); flag Pool B as a quality upgrade, not a dependency.

---

## 11. Phasing

**Phase A — static FBX review.** Worker packaging first (the long pole): pick the conversion toolchain and make the worker image actually build it (new Alpine packages and/or a base-image change plus a headless-GL stack for the poster, see §2.2). Then: extension/magic-byte detection + an extension-aware retire-step fix in `bin-transcode.job.ts`; the `bin-model-process` job (convert, probe, poster) fully wired into `worker.ts` (worker + queue + tick + shutdown list); `media_meta` model contract; `bin_assets.media_meta` additive migration; the new Bay frontend deps (`three`, meshopt decoder) and a custom three.js viewer with orbit + camera capture/restore; `viewpoint` annotations with geometry surface pick and screen fallback; rail; serve `proxy=glb`. (Static is fully useful on its own: look-dev sign-off, prop review.)

**Phase B — animated takes.** Clip selector + `AnimationMixer` + frame-accurate transport (reusing the video transport UI); `time` sub-anchor; skinned surface re-resolution (§6.2); loop ranges; per-clip rail grouping.

**Phase C — polish.** meshopt optimization pass; model QC checks posted via `bay_annotation_create` (or a `bay_qc_run` tool if one is built by then; see §9); A/B compare with synced orbit and synced clip time; screen-space `draw` overlay; optional model-viewer USDZ mobile quicklook.

---

## 12. Licensing summary (MIT-throughout sanity check)

| Component | License | Verdict |
|---|---|---|
| three.js, OrbitControls/ArcballControls | MIT | clean |
| meshoptimizer (geometry compression) | MIT | clean, preferred over Draco |
| Draco (if ever used) | Apache-2.0 | permissive, acceptable (precedent: hls.js) |
| gltf-transform (optimize + probe) | MIT | clean |
| Assimp (FBX -> glTF) | BSD-3-Clause | clean |
| ufbx (alt FBX parser) | MIT | clean |
| Blender (fallback CLI only) | GPL | external aggregation, no propagation |
| Autodesk FBX SDK | proprietary | **avoid** |
| @google/model-viewer (optional quicklook) | Apache-2.0 | permissive, optional |

No copyleft enters the BBB tree. The only GPL tool (Blender) is touched only as a separate executable, never linked.

---

## 13. What does not change

- No new `media_kind` (FBX is a `model` ingest format).
- No `bay_annotations` migration (the anchor is freeform jsonb; `viewpoint` gains optional fields).
- No new serve variant (`original | proxy | poster` already fits).
- No new MCP tool for the core flow (`bay_annotation_create` carries the richer `viewpoint` anchor; `bay_version_get` surfaces `media_meta`). Model QC uses that same `bay_annotation_create` (there is no `bay_qc_run` to reuse; see §9).
- Entity links, Bolt events, the activity log, share links, and the approval rollup are all media-agnostic and inherit unchanged.
