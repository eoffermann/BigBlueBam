# Bay - Media review and approval

Bay is BigBlueBam's media review and approval app. It turns a file in your Bin store into a reviewable asset with a version stack, coordinate-anchored annotations, per-reviewer decisions, and token-gated guest links. Bay reviews stills, video, audio, and interactive 3D models in one place, and an AI agent reviews through the same tools, identity, and audit trail as a person. The canonical bytes always live in Bin; Bay owns only the review layer on top.

## Key Features

- **One review per file.** Each Bay review asset links one-to-one to a Bin asset. Opening a file find-or-creates its review and mints version 1, so the same file always lands on the same review.
- **Four media kinds.** `image`, `video`, `audio`, and `model`, each with the right viewer and annotation anchors.
- **Coordinate-anchored annotations.** Notes are glued to a precise place: a video `frame` or `timerange`, an image `region` box, or a 3D `viewpoint` (remembered camera plus optional surface spot). Annotations resolve, reopen, and thread.
- **Per-reviewer decisions.** One decision per reviewer per version (Approved, Changes requested, Rejected, Pending), upserted so changing your mind updates in place; the panel shows every reviewer's verdict together.
- **Immutable version stack.** Upload a new cut as the next version; older versions, with their own notes and decisions, are preserved.
- **Guest review links.** A public, token-gated `/bay/r/:token` URL with optional expiry and an allow-comments toggle; revoke is soft and keeps view stats.
- **3D / FBX model review.** Upload FBX, OBJ, STL, GLB, glTF, PLY, DAE, or USD; the worker converts it to a browser-loadable GLB proxy. Orbit/pan/zoom, Remember viewpoint, a surface Spot that survives orbit, and a model stats line (tris, materials, clips).
- **AI agent surface** of `bay_*` MCP tools covering review resolve, asset/version CRUD, annotations, decisions, and share links.

## Integrations

Bay reads its bytes from Bin (each review asset is one-to-one with a Bin asset), and 3D model proxies are produced by the background worker and stored against the Bin asset. Associate a review asset with a Bam project to keep media review next to the work. Agents reach Bay under an identity with heartbeat and `agent_policies` gating, post findings through `bay_annotation_create`, and route any human-ratified final approval through the platform `proposal_create` queue.

## Getting Started

Open Bay from the Launchpad. You land on the Review Library, which lists media files from your Bin store. Upload a new file or click an existing one; Bay opens the review (creating it and version 1 on first open). Annotate with the anchor tools, record your decision, and click Share to mint a guest link. When a new cut is ready, upload it as the next immutable version.
