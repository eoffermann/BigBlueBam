---
title: "Bay (Media Review) Guide"
app: bay
---

# Bay (Media Review) Guide

# Bay - Media review and approval

Bay is BigBlueBam's media review and approval app. It turns a file in your Bin store into a reviewable asset with a version stack, coordinate-anchored annotations, per-reviewer decisions, and token-gated guest links. Bay reviews stills, video, audio, and interactive 3D models in one place, and an AI agent reviews through the same tools, identity, and audit trail as a person. The canonical bytes always live in Bin; Bay owns only the review layer on top.

## Key Features

- **One review per file.** Each Bay review asset links one-to-one to a Bin asset. Opening a file find-or-creates its review and mints version 1, so the same file always lands on the same review.
- **Four media kinds.** `image`, `video`, `audio`, and `model`, inferred from content type, each with the right viewer and annotation anchors.
- **Coordinate-anchored annotations.** Notes are glued to a precise place: a video `frame` or `timerange`, an image `region` box, or a 3D `viewpoint` (remembered camera plus optional surface spot). Annotations resolve, reopen, and thread.
- **Per-reviewer decisions.** One decision per reviewer per version (Approved, Changes requested, Rejected, Pending), upserted so changing your mind updates in place. The panel shows every reviewer's verdict as the version's approval state.
- **Immutable version stack.** Upload a new cut as the next version; older versions, with their own notes and decisions, are preserved.
- **Guest review links.** Mint a public, token-gated `/bay/r/:token` URL with optional expiry and an allow-comments toggle. Revoke is soft and keeps view stats.
- **3D / FBX model review.** Upload FBX, OBJ, STL, GLB, glTF, PLY, DAE, or USD; the worker converts it to a browser-loadable GLB proxy. Orbit/pan/zoom, Remember viewpoint (fly the camera back to a saved angle), Spot (a highlight glued to the mesh surface that survives orbit), and a model stats line (tris, materials, animation clips).
- **Live updates.** Annotations and decisions (including guest comments) broadcast over a WebSocket, so reviewers see them arrive without reloading.
- **AI agent surface** of `bay_*` MCP tools covering review resolve, asset/version CRUD, annotations, decisions, and share links.

## Integrations

Bay reads its bytes from **Bin** (each review asset is one-to-one with a Bin asset), and 3D model proxies are produced by the background **worker** and stored against the Bin asset. Associate a review asset with a **Bam** project to keep media review next to the work. Agents reach Bay under an identity with heartbeat and `agent_policies` gating, post findings through `bay_annotation_create`, and route any human-ratified final approval through the platform `proposal_create` queue.

## Getting Started

Open Bay from the Launchpad. You land on the **Review Library**, which lists media files from your Bin store. Click **Upload media** to push a new file into Bin, or click an existing file. Bay opens the review (creating it and version 1 on first open). Annotate the media with the anchor tools, record your decision in the decisions panel, and click **Share** to mint a guest link. When a new cut is ready, **Upload version** adds it as the next immutable version.

## Working together

Annotations and decisions from other reviewers, and comments from guests on a share link, stream into the review page live over a WebSocket, so you see new notes and verdicts appear in place without reloading.

## Walkthrough

### Open a review

From the Review Library, click a media file. Bay find-or-creates its one-to-one review asset and mints version 1 from the Bin bytes, then opens the review page: media stage in the center, version stack, annotations panel, and decisions panel.

### Annotate with the right anchor

Capture an anchor, then post your note against it:

- **Image:** drag a rectangle to box a region.
- **Video:** **Capture frame** for a single frame, **Mark in** / **Mark out** for a time range, or **Draw region** for a box pinned to a time.
- **Audio:** mark an in/out time range.
- **3D model:** see the next section.

Notes appear in the annotations panel anchored to that exact spot; click a note to jump the player (or fly the camera) back to it. Resolve a note when it is handled, and reopen it if needed.

### Reviewing a 3D model

Open a model from the Review Library. Bay loads the **GLB proxy** the worker produced from your uploaded source (FBX, OBJ, STL, GLB, glTF, PLY, DAE, or USD) and frames the model. If the model was just uploaded, the proxy may still be processing for a moment.

- **Orbit, pan, zoom** with the mouse; **Reset view** re-frames the model.
- **Remember viewpoint** snapshots the current camera as a note's anchor. Clicking that note later flies the camera back to the saved angle.
- **Spot** then a click on the surface glues a highlight to the mesh at that point. It is stored against the geometry, so it survives orbiting and re-posing. A click that misses the geometry falls back to a screen-space box. Existing surface notes show as markers (blue open, gray resolved); click one to fly to it.
- The **stats line** shows triangle count, materials, source scale and axis, and (for animated models) the clip count.

Animated models add a frame-accurate timeline transport (play/pause, scrub, frame step, J/K/L, loop, and a clip selector for multi-clip models). Scrub to a frame, drop a spot, and the note pins that clip and frame; reopening it scrubs back and re-glues the highlight to the deformed mesh. Static models show no timeline.

### Record a decision and share

In the decisions panel, pick **Approved**, **Changes requested**, **Rejected**, or **Pending** (and an optional comment). Your decision is one per version and updates in place if you change it; the panel shows every reviewer's badge together. Click **Share** to mint a token-gated `/bay/r/:token` link (the URL is copied to your clipboard); optionally set an expiry and whether guests may comment. Revoke the link any time.

## MCP Tools

| Tool | Description |
|------|-------------|
| `bay_review_resolve` | Open (find-or-create) the Bay review for a Bin media asset by `bin_asset_id`; idempotent. |
| `bay_review_link_create` | Mint a public token-gated share link (`/bay/r/:token`) with optional expiry and allow-comments. |
| `bay_asset_list` | List Bay review assets, optionally by project or including archived. |
| `bay_asset_get` | Get one asset's metadata (media_kind, current version, project). |
| `bay_asset_create` | Create a review asset (`image`/`video`/`audio`/`model`); bytes attach via a version. |
| `bay_asset_archive` | Archive (soft-delete) an asset; review history is preserved. |
| `bay_version_list` | List the immutable version stack, newest first. |
| `bay_version_get` | Get one version (media metadata plus Bin byte references). |
| `bay_version_create` | Add a new immutable version referencing Bin bytes, with `media_meta`. |
| `bay_annotation_list` | List annotations on a version (optionally include resolved). |
| `bay_annotation_create` | Post a coordinate-anchored annotation (frame / timerange / region / 3D viewpoint). |
| `bay_annotation_resolve` | Mark an annotation resolved, or reopen it. |
| `bay_decision_list` | List the per-reviewer decisions on a version (the approval state). |
| `bay_decision_set` | Upsert the caller's decision (approved / rejected / changes_requested / pending). |

## Related Apps

- [Bin (Digital asset management)](../bin/guide.md)
- [Bam (Project management)](../bam/guide.md)
- [Introduction to BigBlueBam](../introduction/guide.md)
