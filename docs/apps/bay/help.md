# Bay - Media review and approval

> Bay is the BigBlueBam media review and approval app. It turns a file sitting in Bin into a reviewable asset: a version stack, coordinate-anchored annotations, per-reviewer decisions, and a token-gated link you can hand to an outside client. It reviews stills, video, audio, and now interactive 3D models in the same place, and an AI agent reviews through the exact same tools, identity, and audit trail as a person.

## Overview

Bay separates the bytes from the review. The canonical media file lives in **Bin** (the asset store); Bay holds only the review layer on top of it: the versions you cut, the notes people leave, the decisions they record, and the share links you mint. A Bay review asset is linked one-to-one to a Bin asset, so there is exactly one review surface per file and opening the same file twice lands you on the same review.

The review loop is the same for every media kind:

1. **Upload or pick** a media file. Bay reads it from your Bin file store. Each asset has a `media_kind` of `image`, `video`, `audio`, or `model`, inferred from the file's content type (anything that is not an image, video, or audio file is treated as a 3D model).
2. **Open the review.** The first time you open a file, Bay creates the review asset and mints version 1 referencing the Bin bytes. Every later open is idempotent: same file, same review.
3. **Annotate.** Reviewers leave notes anchored to a precise place in the media: a video frame or time range, a region box on an image, or a remembered camera viewpoint (and optional surface spot) on a 3D model.
4. **Decide.** Each reviewer records one decision per version: Approved, Changes requested, Rejected, or Pending. A reviewer can change their mind; their decision updates in place rather than stacking up.
5. **Share.** Mint a public, token-gated link so an unauthenticated guest can view the media, the annotations, and the decisions at `/bay/r/:token`, and optionally leave comments of their own.
6. **Re-version.** Upload a new cut as a new immutable version. The version stack is preserved, so you always have the history of what was reviewed.

Bay is org-scoped and connects to the rest of the suite: bytes come from Bin, 3D proxies are produced by the background worker, and review events broadcast over a WebSocket so collaborators see new annotations and decisions arrive live.

This document describes what the Bay web app actually does today, across stills, video, audio, and 3D models (static and animated).

### Key concepts

- **Review asset** - the durable thing under review (a shot, a cut, a track, or a model). Holds a name, a `media_kind`, an optional project, a version stack, and a 1:1 link to the Bin asset that holds the bytes. Archiving an asset is a soft-delete; its review history is preserved.
- **Media kind** - `image`, `video`, `audio`, or `model`. Determines the viewer and which annotation anchors apply. Inferred from content type: `image/*`, `video/*`, `audio/*`, and everything else (including 3D model files that upload as `application/octet-stream`) becomes `model`.
- **Version** - an immutable snapshot in the review stack, numbered monotonically (v1, v2, ...). Each version references the Bin bytes (`bin_asset_id` / `bin_version_id`) and carries `media_meta` (dimensions, codec, or for models the probe stats). The newest version is the asset's current version.
- **Annotation** - a note anchored to a coordinate in the media. The anchor is structured and queryable, not just a screenshot. Annotations can be resolved and reopened, and can thread under a parent. Guest comments are annotations with no member author.
- **Anchor** - the structured location an annotation points at. Four types: `frame`, `timerange`, `region`, and `viewpoint` (see Feature reference).
- **Decision** - one reviewer's verdict on one version: `approved`, `changes_requested`, `rejected`, or `pending`. Exactly one decision per reviewer per version; setting it again updates the existing one.
- **Review (share) link** - a public, token-gated URL (`/bay/r/:token`) that lets an unauthenticated guest view a review. Optional expiry (1-365 days) and an allow-comments toggle. Revoking a link is a soft revoke that keeps its view stats.
- **GLB proxy** - for 3D models, a browser-loadable `.glb` that the background worker converts from the uploaded source (FBX, OBJ, STL, and others). The viewer always loads the proxy, never the raw source file.

### Where to find it

Bay lives at `/bay/`. Open it from the Launchpad app switcher, or go straight to the URL. You must be signed in to BigBlueBam; Bay is org-scoped, so use the OrgSwitcher in the header to change which organization's data you see. Guests reach a single shared review at `/bay/r/:token` with no login.

Roles and authority: viewing assets, versions, annotations, and decisions is member-level. Resolving (opening) a review, creating assets and versions, annotating, resolving annotations, setting your own decision, and minting or revoking share links are read/write actions, each gated by a named `bay.*` capability that is delegatable per the standard permission model.

## Feature reference

### Review Library

The Review Library is the home page. It lists the media files from your Bin file store, each with a media-kind badge (image, video, audio, or model) and an icon. Use the **Upload media** button to push a new file into Bin; Bay then opens its review for you. Click any item to open its review, which find-or-creates the one-to-one Bay review asset behind it and drops you on the review page.

### The review page

The review page is the working surface. It shows the media stage in the center, the version stack, the annotations panel with its anchor-capture toolbar, and the decisions panel. From here you can upload a new version, download the original bytes, archive the asset, and mint a share link with the **Share** button (which copies the public URL to your clipboard). Annotations and decisions from other reviewers (and from guests on a share link) stream in live over a WebSocket, so you see notes and verdicts appear without reloading.

### Versions

Versions are immutable and numbered in order. Uploading a new cut mints the next version and makes it current; older versions stay in the stack so you can see exactly what was reviewed at each round. A version records which Bin bytes it points at and a `media_meta` blob (image dimensions, video codec and duration, or, for models, the probe stats described below). Each version carries its own annotations and its own per-reviewer decisions.

### Annotations and the four anchor types

An annotation is a comment glued to a precise place in the media. The anchor is a structured object, so notes are queryable and survive being reopened. There are four anchor types, matched to the media kind:

- **`frame`** (video) - a single frame: `{ type: "frame", frame, time_sec? }`. Capture the current frame while scrubbing.
- **`timerange`** (video, audio) - an in/out span: `{ type: "timerange", start_sec, end_sec }`. Mark in and out to bracket a moment.
- **`region`** (image; video in draw-region mode) - a normalized box: `{ type: "region", x, y, w, h }`, with `x/y/w/h` in 0-1, optionally pinned to a frame or time on video. Drag a rectangle over the area you mean.
- **`viewpoint`** (3D model) - a remembered camera, optionally with a surface spot. See the 3D / FBX model review section below.

Annotations can be marked resolved (and reopened), and can thread under a parent annotation. The author's name is shown from their profile; guest comments carry the name the guest typed.

### Decisions and the approval state

Each reviewer records one decision per version: **Approved**, **Changes requested**, **Rejected**, or **Pending**. The decisions panel shows every reviewer's badge together, which is the approval state of that version, plus a picker for setting (or changing) your own. Decisions are an upsert: there is exactly one decision per reviewer per version, so changing your mind updates your existing decision rather than adding another. Bay does not compute a single aggregate verdict for you; the panel shows the full set of per-reviewer decisions so you can see where each reviewer stands.

### Guest review links

To get a sign-off from someone outside the org, mint a **share link**. It produces a public URL at `/bay/r/:token` that an unauthenticated guest can open to see the media, the annotations, and the decisions, all read-only. Options:

- **Expiry** - optional, 1 to 365 days. After it expires the link returns "this share link has expired".
- **Allow comments** - on by default. When on, a guest can leave comments (stored as annotations with no member author and the guest's typed name); when off, the comment form is hidden and guest comments are refused.

Revoking a link is a soft revoke: the token stops working but its view stats (view count, last viewed) are kept. A missing or revoked token returns a plain "not found" rather than confirming the token ever existed. Guest comments broadcast over the same WebSocket, so members watching the review see them arrive live.

### 3D / FBX model review

Bay reviews interactive 3D models alongside stills, video, and audio. This is the newest media kind, and it is built so a reviewer can point at an exact spot on a mesh, not just describe it.

**Supported formats and the GLB proxy.** Upload the authored model and Bay handles the rest. The background worker accepts `fbx`, `obj`, `stl`, `glb`, `gltf`, `ply`, `dae`, and the USD family (`usd`, `usdz`, `usdc`, `usda`), and converts the source to a single self-contained `.glb` **proxy** (using Assimp compiled to WebAssembly; a file that is already `.glb` is normalized through a glTF pipeline). Browsers cannot load FBX or OBJ directly, so the viewer always renders the GLB proxy, never the raw source. Conversion runs as a background sweep, so a freshly uploaded model may show a brief "the proxy may still be processing" state until the worker finishes; you can always download the original in the meantime.

**Orbit, pan, zoom.** The viewer is a custom three.js scene with orbit controls and damping. On load it auto-frames the model to fit, drops a model-sized ground grid, and lights it. **Reset view** re-frames the model at any time.

**Remember viewpoint.** Click **Remember viewpoint** to snapshot the current camera (position, target, up vector, and field of view) as the anchor for a note. When someone later clicks that note, the viewer flies the camera back to the remembered view with a short animated transition, so a note about "the seam on the left pauldron" always reopens from the angle the reviewer was looking at.

**Spot (surface annotation).** Click **Spot**, then click the model, to glue a highlight to the surface itself. The spot is stored against the mesh geometry (node, triangle, and barycentric coordinates), so it is re-resolved to the right point on every frame and **survives orbiting and re-posing** the camera, rather than floating in screen space. If a click misses the geometry, Bay falls back to a screen-space box in the captured camera frame so the note still lands somewhere meaningful. Existing surface notes show as clickable markers on the model (blue when open, gray when resolved); clicking a marker flies to its viewpoint.

**Model stats.** The review page shows a stats line read from the model probe: triangle count (compact, e.g. "1.85M tris"), material count, the source scale and up-axis, and, for animated models, the number of animation clips.

**Animated takes.** For an animated model the viewer adds a frame-accurate timeline transport beneath the viewport, mirroring the video player: play/pause, a scrub bar, a frame counter (`f18 / 546 · 30fps`), single-frame step (`,` / `.`), J/K/L transport, a loop toggle, and a clip selector when the model has more than one clip. Scrubbing poses the skeleton to that exact frame. When you capture a viewpoint or spot while a clip is active, the note records a `time` pin (clip, frame, time); reopening the note selects the clip, scrubs to the frame, re-resolves the highlight against the deformed (skinned) mesh, and flies the camera back. Static models show no timeline.

The 3D viewpoint anchor itself is a single structured object: a `camera` (always present), an optional `surface` spot (geometry-glued or a screen box), an optional `time` pin for animated takes, and optional freehand `draw` strokes in the captured frame. It is the same opaque anchor field every annotation uses, so 3D notes needed no new tool or schema, just a richer anchor.

### Working with AI agents

Bay's defining idea is that an agent reviews exactly like a person: it opens a review, posts anchored annotations, and sets a decision through the same tools, under its own agent identity, and into the same audit trail. There is no separate "agent QC" path, so an automated finding lands next to human notes on the same version.

What agents drive (the `bay_*` MCP tools):

- **Open a review:** `bay_review_resolve` find-or-creates the Bay review for a Bin media asset by `bin_asset_id`, idempotent thereafter. This is how a file in Bin is opened for review.
- **Assets and versions:** `bay_asset_list`, `bay_asset_get`, `bay_asset_create`, `bay_asset_archive`, `bay_version_list`, `bay_version_get`, and `bay_version_create` (references the Bin bytes and passes `media_meta`).
- **Annotations:** `bay_annotation_list`, `bay_annotation_create` (the coordinate-anchored note; its anchor carries the freeform 3D viewpoint, so 3D QC findings need no new tool), and `bay_annotation_resolve`.
- **Decisions:** `bay_decision_list` (the per-reviewer approval state) and `bay_decision_set` (upsert the caller's decision). An agent setting a decision is a first-class reviewer; an agent-proposed *final* approval that a human must ratify should instead route through the platform `proposal_create` flow.
- **Sharing:** `bay_review_link_create` mints the public token-gated link.

For the full tool list and the REST/MCP mapping, see the Bay MCP-tools reference and guide in `docs/apps/bay/`.

## User Stories

### Story: Review a video cut and request changes

**Who:** An editor or producer reviewing a rough cut.
**Goal:** Leave precise, time-anchored notes and record a verdict.
**Before you start:** You are signed in with read/write access, and the cut is in your Bin file store.

**Steps**

1. Open Bay. On the **Review Library**, click the video (or click **Upload media** to push a new cut into Bin first).
2. On the review page, scrub the player. To flag a single frame, **Capture frame**; to bracket a span, **Mark in** and **Mark out**; to box an area, **Draw region**.
3. With the anchor captured, type your note and post it. It appears in the annotations panel anchored to that exact frame, span, or box.
4. In the decisions panel, pick **Changes requested** and optionally add a comment.

**Result:** The version carries time-anchored notes and your "changes requested" decision. Clicking a note later seeks the player straight to it.

**Related:** When the new cut is ready, upload it as a new version and review again.

### Story: Review a 3D model and pin a note to the mesh

**Who:** An art director or technical reviewer checking a 3D asset.
**Goal:** Point at an exact spot on the model and remember the angle.
**Before you start:** The model (FBX, OBJ, STL, GLB, and others) is uploaded; the worker has produced its GLB proxy.

**Steps**

1. Open the model from the Review Library. The viewer loads the GLB proxy and frames the model.
2. Orbit, pan, and zoom to the area you want to discuss.
3. Click **Spot**, then click the surface. A highlight glues to the mesh at that point.
4. Type your note and post it. Or, to anchor a note to an angle rather than a point, click **Remember viewpoint** before posting.
5. Read the stats line (tris, materials, clips) to sanity-check the asset, and record your decision.

**Result:** The note is glued to the surface and survives orbiting; reopening it (or a viewpoint note) flies the camera back to where the reviewer was looking. Reviewers no longer have to describe "the spot near the left shoulder" in prose.

**Related:** Animated models get a frame-accurate timeline transport with per-clip selection; viewpoint notes can pin a specific clip and frame.

### Story: Send a client a guest review link

**Who:** A producer who needs sign-off from someone outside the org.
**Goal:** Let a client view the media and comment without an account.
**Before you start:** You are on the review page with read/write access.

**Steps**

1. Click **Share**. Bay mints a token-gated link and copies the `/bay/r/:token` URL to your clipboard.
2. (Optional) Set an expiry in days and decide whether guests may comment.
3. Send the URL to the client.
4. The client opens it, sees the media, the annotations, and the decisions, and (if comments are allowed) leaves their own.

**Result:** The client reviews without logging in, and their comments stream into your review live. Revoke the link any time; its view stats are kept.

### Story: Cut a new version and keep the history

**Who:** Anyone iterating on media after a round of notes.
**Goal:** Put up a new cut for review without losing the old one.
**Before you start:** You are on the review page and the new file is in Bin.

**Steps**

1. Click **Upload version** and pick the new bytes.
2. Bay mints the next version number and makes it current; the previous versions stay in the stack.
3. Review the new version; its annotations and decisions are its own.

**Result:** An immutable version history. You can always see what was reviewed, and decided, at each round.

### Story: Let an agent run automated QC on a model

**Who:** An AI agent (or the engineer who wired it) doing automated checks.
**Goal:** Post machine findings next to human notes and propose a verdict.
**Before you start:** The agent has a Bay-scoped identity and the model's review exists (or `bay_review_resolve` opens it).

**Steps**

1. The agent calls `bay_review_resolve` for the Bin asset to get the review, then `bay_version_get` to read the model's probe stats.
2. For each finding (an n-gon, a stray material, an off-scale dimension), it calls `bay_annotation_create` with a `viewpoint` anchor pointing at the spot.
3. It calls `bay_decision_set` with `changes_requested`, or routes a final approval through the platform proposal queue for a human to ratify.

**Result:** Automated findings appear on the same version as human notes, under the agent's identity in the audit trail, and a human can act on (or ratify) them in the normal UI.

## Related

- **Bin** - holds the canonical media bytes; every Bay review asset links one-to-one to a Bin asset, and the GLB proxy for a model is produced and stored against the Bin asset.
- **Bam** - associate a review asset with a project to keep media review next to the work it belongs to.
- Bay MCP-tools reference and guide in `docs/apps/bay/`.
