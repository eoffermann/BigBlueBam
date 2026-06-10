<!-- AGENTS: Do not delete, move, or modify this document unless the user
     specifically directs you to act on it. It is an intentional product
     proposal kept here for future consideration — it is not stray output,
     not part of any current feature branch, and not yours to clean up. -->

# BigBlueBam Bay — Design Document v0.1

**Author:** Big Blue Ceiling Prototyping & Fabrication, LLC
**Date:** June 10, 2026
**Status:** Draft — Awaiting Approval

> Working name is **Bay** (editing / screening bay). Evocative alternative: **Backlot**. Name is a one-line find-and-replace if you'd rather go the other way. See Open Decisions (§19).

---

## 1. Overview

Bay is BigBlueBam's media review and approval product. It ingests images, video, audio, and 3D models, builds web-playable proxies, and gives teams a frame-accurate, version-stacked surface to annotate and sign off on creative deliverables. Think Frame.io or SyncSketch for the review layer, Kitsu for the approval-state model, deliberately without Autodesk Flow's deep pipeline-tracking footprint. That can come later.

The thing that makes Bay a BigBlueBam product rather than a standalone Frame.io clone: AI agents are first-class reviewers. An agent can ingest a version, run automated technical QC (resolution, codec, color space, loudness, slate compliance), post frame-anchored annotations, set a decision, and summarize a review - using the same MCP tool layer, the same identity model, and the same audit trail as a human reviewer. Automated technical review sits next to human creative review in one timeline.

Bay shares the platform's PostgreSQL, Redis, and MinIO. It owns its own Fastify service (`bay-api`) because of the transcode coordination, media streaming, realtime annotation sync, and a public guest-review surface - the same reasoning that gave Banter and Helpdesk their own services.

---

## 2. Suite Positioning

Bay overlaps with two planned slots. The boundary the rest of this document assumes:

| Product | Owns | Does not own |
|---|---|---|
| **Bin** (DAM, planned) | The asset *library* - canonical storage, foldering, org-wide search of all assets | Review workflow, annotation, approval state |
| **Badge** (proofing, planned) | *Generic* sign-off - approve a PDF, a contract, a static deliverable. No media player. | Time-based / spatial media review |
| **Bay** (this doc) | Version stacks, frame/timecode/region/viewpoint annotation, review sessions, per-reviewer decisions on time-based and visual media | Long-term asset cataloging (defers to Bin), generic doc approval (defers to Badge) |

**Bin boundary.** Until Bin ships, Bay owns its own MinIO storage for versions under review. When Bin lands, a Bay version can be *sourced from* or *promoted to* a Bin asset, federated through the existing `attachment_list` / `attachment_get` tools and `entity_links`. Bay should not reimplement DAM cataloging.

**Badge boundary.** Generic non-media sign-off stays in Badge. Where an *agent* proposes a final approval that a human other than the asker must ratify, that proposal routes through the unified `/b3/approvals` surface and the `proposal_*` tools (per agent-conventions §6), not a Bay-private channel. Bay's per-reviewer `bay_review_decisions` remain the source of truth for media review state; the proposal surface is only the human-ratification path for agent-authored approvals.

---

## 3. Key Principles

1. **Versions are immutable, assets are durable.** An asset is the durable thing under review (a shot, a cut, a track, a model). Each upload is a new immutable version. You never edit a version in place; you add v2.
2. **Annotations anchor to a coordinate, not a file.** Video anchors to a frame, audio to a time range, image to a pixel region, 3D to a camera viewpoint. The anchor is structured data, queryable, agent-legible.
3. **Decisions are per-reviewer, per-version.** Approval rollup is a policy over decisions (all-required vs any-one), never a single mutable "approved" boolean.
4. **Agents review like humans.** Identical roles, identical MCP tools, identical audit trail. Automated QC is just another reviewer.
5. **Shared infrastructure.** Same PostgreSQL, Redis, MinIO, Docker network, BullMQ worker. No separate datastore.
6. **Guests are token-scoped, never platform users.** External review via share links runs on short-lived tokens with explicit grants. Guests are never run through the user-visibility preflight because they have no platform identity.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Bay UI (section of the /b3/ SPA)   │  Guest Review (/r/) │
│  React 19 · Tailwind v4 · Radix     │  minimal public SPA │
└──────────────────┬──────────────────┴──────────┬──────────┘
                   │ HTTPS                         │ HTTPS (token)
┌──────────────────▼───────────────────────────────▼─────────┐
│              Single nginx container (port 80/443)           │
│   /b3/             → BigBlueBam SPA                          │
│   /bay/api/        → bay-api  :4005   (proposed, confirm)    │
│   /bay/ws          → bay-api  WebSocket                      │
│   /r/{token}       → guest review SPA (public bundle)        │
│   /b3/api/         → BBB API  :4000                          │
│   /mcp/            → MCP server :3001                        │
│   /files/          → MinIO :9000  (presigned, time-limited)  │
└──────────┬──────────────────────────────────────┬───────────┘
           │ REST + WS                              │
┌──────────▼──────────────┐          ┌──────────────▼──────────┐
│  Docker: bay-api         │          │  Docker: worker (shared) │
│  Fastify v5 :4005        │  enqueue │  BullMQ                  │
│  REST + WS (annotations) │ ───────► │  queues: bay-transcode,  │
│  Shares DB with BBB API  │          │  bay-notify, bay-cleanup │
└──────────┬───────────────┘          └──────────┬───────────────┘
           │                                      │
┌──────────▼────────┬─────────────────┬───────────▼─────────────┐
│ PostgreSQL :5432  │  Redis :6379    │  MinIO :9000            │
│ (shared)          │  (pubsub/cache) │  bucket: bay/ prefix    │
└───────────────────┴─────────────────┴─────────────────────────┘
```

### 4.1 Service vs section

The authenticated review UI is a **section of the existing `/b3/` SPA** (a "Bay" nav item, like Board and Bond), so it inherits org auth, the command palette, and the global nav. It talks to `bay-api` over `/bay/api/`. Only the **public guest surface** is a separate minimal bundle at `/r/{token}`, because guest reviewers have no org session - the same split logic that made Helpdesk external-facing.

`bay-api` is its own Fastify service (precedent: `banter-api` :4002, `helpdesk-api` :4001, and Blueprint's own port assignment) because media streaming, realtime annotation WS, transcode orchestration, and the public surface are heavy enough to keep off the core API.

### 4.2 Deployment Options

| Deployment | Bay UI | bay-api | Notes |
|---|---|---|---|
| **Docker Compose** | bundled into /b3/ SPA; guest bundle at /r/ | Fastify :4005 (internal) | Default. Added to docker-compose.yml |
| **Dev mode** | Vite (existing /b3/ dev server) | tsx watch :4005 | docker-compose.dev.yml override |
| **Standalone** | static host | any Node host | Point `BAY_API_URL` + `DATABASE_URL` at the platform DB |

> **Port :4005 is provisional.** Confirm against the live compose file before wiring nginx. Blueprint's API port is still open and may claim :4004; assign Bay the next free port and update this doc.

---

## 5. Data Model

All tables use the `bay_` prefix per suite convention. UUID PKs, `gen_random_uuid()`, `created_at` / `updated_at` TIMESTAMPTZ, `org_id` for tenancy.

### 5.1 `bay_assets`

The durable thing under review. Holds metadata; the bits live on versions.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `org_id` | UUID | FK → organizations.id, NOT NULL | Tenancy |
| `project_id` | UUID | FK → projects.id, NULLABLE | Optional project scoping (drives visibility) |
| `name` | VARCHAR(255) | NOT NULL | e.g. "SH_042_comp" |
| `media_kind` | VARCHAR(16) | NOT NULL | `image` \| `video` \| `audio` \| `model3d` |
| `current_version_id` | UUID | FK → bay_asset_versions.id, NULLABLE | Latest version pointer (denormalized) |
| `created_by` | UUID | FK → users.id | Human or agent (users.kind) |
| `archived_at` | TIMESTAMPTZ | NULLABLE | Soft delete |

### 5.2 `bay_asset_versions`

Immutable. One row per upload. `version_number` is monotonic per asset.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `asset_id` | UUID | FK → bay_assets.id, NOT NULL | |
| `version_number` | INT | NOT NULL | v1, v2, ... |
| `uploaded_by` | UUID | FK → users.id | |
| `original_filename` | VARCHAR(255) | NOT NULL | |
| `content_type` | VARCHAR(100) | NOT NULL | MIME |
| `size_bytes` | BIGINT | NOT NULL | |
| `status` | VARCHAR(20) | NOT NULL DEFAULT 'pending_upload' | `pending_upload` \| `transcoding` \| `ready` \| `failed` |
| `failure_reason` | TEXT | NULLABLE | Populated on `failed` |
| `duration_ms` | INT | NULLABLE | video/audio |
| `fps_num` / `fps_den` | INT | NULLABLE | Exact frame rate as a rational (e.g. 24000/1001). Frame accuracy depends on this. |
| `width` / `height` | INT | NULLABLE | image/video |
| `color_space` | VARCHAR(32) | NULLABLE | e.g. `sRGB`, `Rec.709`, `ACEScg` |
| `loudness_lufs` | NUMERIC(5,2) | NULLABLE | audio/video, measured on ingest |
| `approval_status` | VARCHAR(20) | NOT NULL DEFAULT 'pending' | Rolled up: `pending` \| `in_review` \| `changes_requested` \| `approved` \| `rejected` |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique:** `(asset_id, version_number)`.

### 5.3 `bay_version_media`

Encoded representations of a version (original plus derived proxies). Decouples "the version" from "the many files we made from it."

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `version_id` | UUID | FK → bay_asset_versions.id | |
| `role` | VARCHAR(24) | NOT NULL | `original` \| `proxy_h264` \| `thumbnail` \| `poster` \| `filmstrip` \| `waveform` \| `model_glb` \| `model_usdz` |
| `storage_key` | TEXT | NOT NULL | MinIO object key (§6.3) |
| `content_type` | VARCHAR(100) | NOT NULL | |
| `size_bytes` | BIGINT | NOT NULL | |
| `meta` | JSONB | NULLABLE | role-specific (filmstrip tile count, waveform peaks ref, etc.) |

### 5.4 `bay_reviews`

A review session: a curated, ordered set of versions sent out for sign-off. The Frame.io "review link" / SyncSketch "review" / Kitsu "playlist" concept.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `org_id` | UUID | FK, NOT NULL | |
| `project_id` | UUID | FK → projects.id, NULLABLE | |
| `name` | VARCHAR(255) | NOT NULL | "Client review - cut 3" |
| `status` | VARCHAR(20) | NOT NULL DEFAULT 'open' | `open` \| `completed` \| `archived` |
| `due_at` | TIMESTAMPTZ | NULLABLE | |
| `approval_policy` | VARCHAR(16) | NOT NULL DEFAULT 'all_required' | `all_required` \| `any_one` |
| `created_by` | UUID | FK → users.id | |

### 5.5 `bay_review_items`

Join: which versions are in a review, in what order.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `review_id` | UUID | FK → bay_reviews.id | |
| `version_id` | UUID | FK → bay_asset_versions.id | |
| `position` | INT | NOT NULL | Playlist order |

**Unique:** `(review_id, version_id)`.

### 5.6 `bay_review_reviewers`

Who is asked to review, and whether they are required for rollup.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `review_id` | UUID | FK → bay_reviews.id | |
| `user_id` | UUID | FK → users.id, NULLABLE | Platform reviewer (human or agent) |
| `guest_email` | VARCHAR(320) | NULLABLE | Guest reviewer (no platform identity) |
| `is_required` | BOOLEAN | NOT NULL DEFAULT true | Counts toward `all_required` rollup |

**Check:** exactly one of `user_id` / `guest_email` is set.

### 5.7 `bay_annotations`

The heart of the product. One annotation = one anchored note, optionally with a vector drawing.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `version_id` | UUID | FK → bay_asset_versions.id, NOT NULL | |
| `review_id` | UUID | FK → bay_reviews.id, NULLABLE | The session it was made in |
| `author_id` | UUID | FK → users.id, NULLABLE | Human or agent |
| `guest_email` | VARCHAR(320) | NULLABLE | Guest author (token surface) |
| `anchor_type` | VARCHAR(16) | NOT NULL | `frame` \| `time_range` \| `region` \| `viewpoint` |
| `anchor` | JSONB | NOT NULL | Structured per type (§7) |
| `drawing` | JSONB | NULLABLE | Vector strokes in normalized coords (§7.5) |
| `body` | TEXT | NOT NULL | Comment text |
| `body_plain` | TEXT | NOT NULL | For search |
| `status` | VARCHAR(12) | NOT NULL DEFAULT 'open' | `open` \| `resolved` |
| `is_qc` | BOOLEAN | NOT NULL DEFAULT false | True if produced by an automated QC pass |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Index:** `(version_id, anchor_type)` and a GIN index on `anchor` for frame/time range queries.

### 5.8 `bay_annotation_replies`

Threaded discussion under an annotation.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `annotation_id` | UUID | FK → bay_annotations.id | |
| `author_id` | UUID | FK → users.id, NULLABLE | |
| `guest_email` | VARCHAR(320) | NULLABLE | |
| `body` | TEXT | NOT NULL | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

### 5.9 `bay_review_decisions`

Per-reviewer, per-version verdict. Drives the `approval_status` rollup.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `review_id` | UUID | FK → bay_reviews.id | |
| `version_id` | UUID | FK → bay_asset_versions.id | |
| `reviewer_user_id` | UUID | FK → users.id, NULLABLE | |
| `guest_email` | VARCHAR(320) | NULLABLE | |
| `decision` | VARCHAR(20) | NOT NULL | `approved` \| `changes_requested` \| `rejected` |
| `note` | TEXT | NULLABLE | |
| `decided_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique:** `(review_id, version_id, reviewer_user_id)` and `(review_id, version_id, guest_email)` - one standing verdict per reviewer per version, updated in place.

### 5.10 `bay_share_links`

Token-scoped guest access to a review.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `review_id` | UUID | FK → bay_reviews.id | |
| `token` | VARCHAR(64) | UNIQUE, NOT NULL | URL-safe random; the `/r/{token}` path |
| `password_hash` | TEXT | NULLABLE | Optional gate |
| `expires_at` | TIMESTAMPTZ | NULLABLE | |
| `can_comment` | BOOLEAN | NOT NULL DEFAULT true | |
| `can_download` | BOOLEAN | NOT NULL DEFAULT false | |
| `watermark` | BOOLEAN | NOT NULL DEFAULT true | Burn-in session/email watermark on proxies |
| `created_by` | UUID | FK → users.id | |
| `revoked_at` | TIMESTAMPTZ | NULLABLE | |

### 5.11 `bay_settings`

Per-org configuration.

| Column | Type | Notes |
|---|---|---|
| `org_id` | UUID PK FK | |
| `allowed_formats` | JSONB | Whitelist of ingest extensions per media_kind |
| `default_transcode_preset` | VARCHAR(32) | e.g. `h264_1080p_8mbit` |
| `guest_access` | VARCHAR(16) | `enabled` \| `password_only` \| `disabled` |
| `default_watermark` | BOOLEAN | |
| `max_upload_bytes` | BIGINT | |

---

## 6. Media Pipeline

### 6.1 Ingest

Large-file friendly. Client requests a presigned multipart upload from `bay-api`, uploads directly to MinIO, then notifies `bay-api`, which marks the version `transcoding` and enqueues a `bay-transcode` job. The API never proxies the bytes.

### 6.2 Transcode (BullMQ `bay-transcode`, worker)

| media_kind | Derives | Tool |
|---|---|---|
| `video` | `proxy_h264` (web-playable, faststart), `poster`, `filmstrip` (sprite sheet for scrub thumbnails), `waveform` (peaks JSON), probe fps/duration/color/loudness | ffmpeg / ffprobe |
| `image` | web preview (resized), `thumbnail`; EXR/TIFF tonemapped to sRGB preview | ffmpeg / OpenImageIO |
| `audio` | normalized preview, `waveform` peaks JSON, loudness (LUFS) | ffmpeg / ebur128 |
| `model3d` | `model_glb` (web proxy from obj/fbx/stl), `model_usdz` (Apple Quick Look), `thumbnail` (offline render) | gltf-transform / usd tooling / headless render |

Frame accuracy depends on capturing exact `fps_num`/`fps_den` from ffprobe (rational, never a rounded float) so the client can map `currentTime` to frame index deterministically.

> **GPU note.** Video transcode (NVENC) and 3D thumbnail render are natural **Pool B** scale-to-zero GPU workloads (the same bursty profile as image gen and async TTS). The `bay-transcode` queue can dispatch to Modal/RunPod for heavy jobs and fall back to CPU ffmpeg for light ones. Decision flagged in §19.

### 6.3 Storage layout (MinIO)

Single bucket, `bay/` prefix:

```
bay/{asset_id}/{version_id}/original.{ext}
bay/{asset_id}/{version_id}/proxy_h264.mp4
bay/{asset_id}/{version_id}/poster.jpg
bay/{asset_id}/{version_id}/filmstrip.jpg
bay/{asset_id}/{version_id}/waveform.json
bay/{asset_id}/{version_id}/model.glb
bay/{asset_id}/{version_id}/model.usdz
```

All reads via short-TTL presigned URLs through `/files/`. Watermarked variants for guest surfaces are generated on first guest access and cached under a `wm/` subkey keyed by share-link id.

### 6.4 Other queues

- `bay-notify` - email reviewers, post to Banter, fire reminders on `due_at`.
- `bay-cleanup` - expire share links, purge proxies of archived assets, reclaim failed-upload temp keys.

---

## 7. Annotation Model

`anchor_type` + `anchor` JSONB. All spatial values normalized 0..1 so they survive proxy resolution changes.

### 7.1 `frame` (video)

```json
{ "frame": 142, "time_ms": 5916 }
```
`frame` is canonical; `time_ms` is a convenience mirror. Client computes `frame = round(time_ms / 1000 * fps_num / fps_den)`.

### 7.2 `time_range` (audio, or video ranges)

```json
{ "start_ms": 5916, "end_ms": 7240 }
```

### 7.3 `region` (image, or a box on a video frame)

```json
{ "frame": 142, "x": 0.31, "y": 0.22, "w": 0.14, "h": 0.09 }
```
`frame` omitted for still images.

### 7.4 `viewpoint` (3D)

```json
{
  "camera": { "position": [x,y,z], "target": [x,y,z], "up": [x,y,z], "fov": 35 },
  "node_id": "mesh_042"
}
```
Captures the camera so a reviewer's "this seam, here" reproduces the exact view. Hardest to get right; scheduled Phase 3.

### 7.5 `drawing`

Vector strokes, normalized, resolution-independent:

```json
{
  "strokes": [
    { "color": "#ff3b30", "width": 0.004,
      "points": [[0.31,0.22],[0.33,0.24],[0.36,0.25]] }
  ],
  "shapes": [ { "type": "arrow", "from": [0.4,0.5], "to": [0.55,0.5] } ]
}
```
Rendered on a canvas overlay sized to the player viewport. For `viewpoint`, strokes are screen-space relative to the captured camera.

---

## 8. Review Sessions and Approval Workflow

### 8.1 Lifecycle

```
open ──(all required decisions in, none rejecting)──► completed
  │
  └──(creator archives)──► archived
```

### 8.2 Version rollup

`bay_asset_versions.approval_status` is recomputed on every decision write, by policy:

- **`all_required`**: `approved` only when every required reviewer's standing decision is `approved`. Any `rejected` → `rejected`. Any `changes_requested` (and no rejection) → `changes_requested`. Otherwise `in_review`.
- **`any_one`**: first `approved` → `approved`; first `rejected` with no approval → `rejected`.

Recompute happens in `bay-api` inside the same transaction as the decision write, and emits a `bay.version.approval_changed` event (§13).

### 8.3 Sharing

A review issues one or more `bay_share_links`. Guests hit `/r/{token}`, optionally pass a password, and get a stripped player with comment/decision rights per the link grant. Guest comments and decisions write with `guest_email` instead of `user_id`. Watermark burn-in per link policy.

---

## 9. Frontend

### 9.1 Players

| media_kind | Player | Notes |
|---|---|---|
| `video` | Custom controls over `<video>` + `requestVideoFrameCallback` for frame-accurate stepping; hls.js if HLS proxies are added later | Frame counter, J/K/L transport, loop range, frame step (`,` / `.`) |
| `image` | Pan/zoom (OpenSeadragon-style) + canvas overlay | Pixel-peep for stills, EXR tonemapped preview |
| `audio` | wavesurfer.js waveform + region select | Annotations are time ranges on the waveform |
| `model3d` | three.js / `@google/model-viewer` (glb + usdz) | Viewpoint capture for annotations |

All players share one **annotation overlay canvas** and one **annotation rail** (list of notes, sorted by frame/time, click to seek).

### 9.2 Compare / wipe

Frame.io/SyncSketch staple: A/B two versions of the same asset, side-by-side or with a draggable **wipe slider**, time-synced. Useful for "what changed between v3 and v4." Phase 3.

### 9.3 Wireframe - video review

```
┌───────────────────────────────────────────────────────────────┐
│ SH_042_comp · v4 ▼   [in_review]        Review: Client cut 3 ▼ │
├──────────────────────────────────────────────┬────────────────┤
│                                              │ Annotations     │
│            ┌──────────────────────┐          │ ───────────────│
│            │                      │          │ ▸ f142  Eddie  │
│            │     video + overlay  │          │   dead pixels  │
│            │                      │          │ ▸ f201  QC-bot │
│            └──────────────────────┘          │   peaks -2LUFS │
│  ◀◀  ◀ ▮▮ ▶ ▶▶    f142 / 1440   24fps        │ ▸ f388  Teeny  │
│  ▭▬▬▬▭▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ filmstrip │   color warm   │
├──────────────────────────────────────────────┴────────────────┤
│ ✎ draw  ▣ box  ↗ arrow   |   Comment ____________  [Post]      │
│ Decision:  ✓ Approve   ⟳ Changes   ✕ Reject                    │
└───────────────────────────────────────────────────────────────┘
```

### 9.4 Tech

React 19, TanStack Query, Zustand, Radix UI, Tailwind v4, Motion. Drawing layer plain canvas/SVG (no heavy dep). New runtime deps and their licenses (all permissive, no copyleft surprises - relevant given the tldraw precedent): hls.js (Apache-2.0), wavesurfer.js (BSD-3), OpenSeadragon (BSD-3), three.js (MIT), @google/model-viewer (Apache-2.0).

---

## 10. Realtime

WebSocket on `bay-api` (`/bay/ws`), same pattern as Banter. Redis pub/sub fans out across API instances.

- **Annotation sync.** New/resolved annotations and replies broadcast to everyone in the same version room.
- **Presence.** "Who is watching this review" + optional playhead-follow (a presenter drives, others follow), a SyncSketch-style synchronized review.
- **Decision updates.** Rollup changes push live so the approval badge updates without refresh.

---

## 11. REST API (bay-api)

Mounted at `/bay/api/`. Session cookie + org role for the authenticated surface; share-link token for `/r/` routes. Representative catalog (~28 endpoints):

```
POST   /assets                          create asset
GET    /assets                          list (filter: project, media_kind, approval_status)
GET    /assets/:id                      detail + versions
POST   /assets/:id/archive

POST   /assets/:id/versions             create version → presigned upload
POST   /versions/:id/complete           mark uploaded → enqueue transcode
GET    /versions/:id                    detail + media + approval_status
GET    /versions/:id/status             transcode progress (poll fallback to WS)

POST   /reviews                         create review session
GET    /reviews                         list
GET    /reviews/:id                     detail (items, reviewers, rollup)
POST   /reviews/:id/items               add versions
DELETE /reviews/:id/items/:itemId
POST   /reviews/:id/reviewers           add reviewer(s)
POST   /reviews/:id/complete

POST   /versions/:id/annotations        create annotation
GET    /versions/:id/annotations        list (filter: anchor_type, status, frame range)
POST   /annotations/:id/replies
PATCH  /annotations/:id/resolve

PUT    /reviews/:id/versions/:vid/decision   set/update my decision

POST   /reviews/:id/shares              issue share link
DELETE /shares/:id                      revoke

GET    /settings  /  PATCH /settings

# Public (token-scoped, no org session):
GET    /r/:token                        review payload for guest
POST   /r/:token/annotations
PUT    /r/:token/versions/:vid/decision
```

---

## 12. MCP Tools

`bay_` prefix, registered on the existing MCP server. Target ~20 tools so agents are first-class. (Note the README's tool badge and the architecture doc disagree on the live count of 86 vs 340 across services - reconcile the count when these land.)

| Tool | Purpose |
|---|---|
| `bay_asset_create` | Create an asset |
| `bay_asset_list` | List/filter assets |
| `bay_asset_get` | Asset + versions |
| `bay_version_create` | Begin a version (returns presigned upload) |
| `bay_version_complete` | Finalize upload, trigger transcode |
| `bay_version_get` | Version detail + media + approval_status |
| `bay_version_status` | Transcode progress |
| `bay_review_create` | New review session |
| `bay_review_list` / `bay_review_get` | Browse reviews |
| `bay_review_add_items` | Add versions to a review |
| `bay_review_add_reviewers` | Add reviewers (human or agent) |
| `bay_review_send` | Issue a share link |
| `bay_annotation_create` | Anchored annotation (frame/time/region/viewpoint) |
| `bay_annotation_list` | List/filter annotations |
| `bay_annotation_reply` | Reply in a thread |
| `bay_annotation_resolve` | Resolve |
| `bay_decision_set` | Set/update a reviewer decision |
| `bay_review_status` | Rollup state for a review |
| `bay_qc_run` | Run automated technical QC on a version (§14) |
| `bay_share_revoke` | Kill a share link |

Every write tool emits Bolt events with the enriched payload convention (actor.name/email, urls, ids) per the bolt-id-mapping strategy.

---

## 13. Suite Integration

- **Entity links.** Link `bay.asset` / `bay.review` to `bam.task` (a shot task), `bond.deal` (client deliverable), `brief.document` (the spec) via existing `entity_links_*`. Federate version files into `attachment_list`.
- **Bam auto-transition.** Optional rule: when a linked task's review reaches `approved`, transition the task phase (precedent: helpdesk task-status sync and the GitHub-PR auto-transition). Configurable, off by default.
- **Bolt events.** Emit `bay.version.uploaded`, `bay.version.transcoded`, `bay.annotation.added`, `bay.decision.set`, `bay.version.approval_changed`, `bay.review.completed`. Enables automations like "on changes_requested, ping the artist in Banter."
- **Banter share.** Add `banter_share_review` alongside the existing `banter_share_task/sprint/ticket`.
- **Bin / Badge.** Boundaries per §2.

---

## 14. Agents as First-Class Reviewers

This is where Bay earns its place in BigBlueBam rather than being a Frame.io reskin.

An agent reviewer can:

1. **Ingest and watch.** Subscribe to `bay.version.uploaded`, pull the proxy/probe data.
2. **Run technical QC** (`bay_qc_run`) and post `is_qc=true` annotations: resolution/aspect mismatch, wrong codec or color space, frame-rate drift, loudness over spec (LUFS), missing or malformed slate, dropped frames, black/silence at head/tail. This maps directly onto color-science/LUT/loudness QC, the kind of automated review you'd otherwise do by hand.
3. **Set a technical decision** (`bay_decision_set` → `changes_requested` with a structured note) while humans handle creative judgment.
4. **Summarize** a review: cluster annotations, surface the blocking ones, draft the "here's what to fix for v5" note.

Because agents hold standard roles and run through the same MCP tools and audit trail, automated QC shows up as just another reviewer in the same timeline - no separate dashboard, full transparency. That is the consistent platform thesis.

---

## 15. Visibility and Permissions

### 15.1 Authenticated surface

Project-scoped assets/reviews: visible to project members or org admin/owner. Org-scoped (no `project_id`): visible org-wide. Standard role gates on writes.

### 15.2 Guests

Guest reviewers (share-link tokens) are **never** run through the user-visibility preflight - they have no platform identity. The token itself is the grant. Token routes are isolated to `/r/` and read only the linked review's versions.

### 15.3 Agent-conventions integration (required, do not skip)

New entity types must be **registered in `SUPPORTED_ENTITY_TYPES`** (`apps/api/src/services/visibility.service.ts`) with a preflight branch in `can_access`, or agents citing Bay entities cross-audience will **deny by default** (agent-conventions §2, §4). Add:

| entity_type | physical table | visibility rule |
|---|---|---|
| `bay.asset` | `bay_assets` | project member if `project_id` set, else same org; or org admin/owner |
| `bay.version` | `bay_asset_versions` | inherits the parent asset's rule |
| `bay.review` | `bay_reviews` | project member if scoped, else same org |
| `bay.annotation` | `bay_annotations` | inherits the version's rule |

Mirror these in `agent-conventions.md` §2 and move Bay off the "Wave 3 forward pointer" list once shipped. This is the recurring integration step that bites if left to the end.

---

## 16. Activity Log and Audit

Reuse the partitioned `activity_log`. Actions: `bay.asset.created`, `bay.version.uploaded`, `bay.version.transcoded`, `bay.annotation.added`, `bay.annotation.resolved`, `bay.decision.set`, `bay.review.completed`, `bay.share.created`, `bay.share.revoked`. `actor_type` auto-populates from `users.kind`, so human vs agent vs service reviews are distinguishable in the audit trail with no extra stamping.

---

## 17. Security

- **Share-link tokens.** 256-bit URL-safe random, optional bcrypt/argon2 password, optional expiry, revocable. Rate-limit guest comment/decision writes.
- **Watermarking.** Per-link burn-in (session id + guest email) on guest-served proxies, deterring leaks of unreleased work.
- **Download control.** `can_download` gates whether originals/proxies are downloadable; default off for guests.
- **Presigned URLs.** Short TTL; never expose raw MinIO keys.
- **Upload validation.** Enforce `allowed_formats` and `max_upload_bytes` before transcode; sniff content type, do not trust the client MIME.

---

## 18. Implementation Phases

Estimates are padded so completions land early. Solo-dev days.

### Phase 1 — Core ingest + image/video review (MVP) · ~6-8 days
- Schema (`bay_assets`, `bay_asset_versions`, `bay_version_media`, `bay_annotations`, `bay_annotation_replies`, `bay_reviews`, `bay_review_items`, `bay_review_reviewers`, `bay_review_decisions`, `bay_settings`)
- `bay-api` service, presigned multipart upload, `bay-transcode` worker for image + video (ffmpeg proxy, poster, filmstrip, probe)
- Version stack + frame-accurate video player + image viewer + annotation overlay/rail
- `frame` and `region` annotations, threaded replies, per-reviewer decisions, rollup
- Bay section in the /b3/ SPA; Docker + nginx
- Entity-type registration in `SUPPORTED_ENTITY_TYPES` (§15.3)

### Phase 2 — Sharing + audio + suite integration · ~4-5 days
- `bay_share_links` + public `/r/{token}` guest SPA (password, expiry, watermark, download policy)
- Audio ingest + wavesurfer waveform + `time_range` annotations
- `entity_links` to Bam/Bond/Brief; optional Bam auto-transition on approval
- Bolt events (enriched payloads); `banter_share_review`
- MCP tool suite; `bay-notify` email + reminders

### Phase 3 — 3D + automated QC + compare · ~5-6 days
- 3D ingest (glb/usdz proxy, offline thumbnail) + three.js/model-viewer + `viewpoint` annotations
- Version compare (A/B + wipe slider, time-synced)
- `bay_qc_run` automated technical QC agent path (§14)
- Synchronized review (presenter playhead-follow over WS)
- Pool B GPU dispatch for transcode/render (pending §19 decision)

---

## 19. Open Decisions

1. **Badge overlap.** Confirm Bay is a distinct product (media review) and Badge stays generic sign-off, per §2 - or fold one into the other.
2. **Name.** Bay vs Backlot vs other single-word B. (Bay assumed throughout; one find-and-replace.)
3. **Port.** :4005 is provisional. Confirm against the live compose file; Blueprint may claim :4004.
4. **Service vs section.** Confirmed assumption: `bay-api` is its own service, UI is a /b3/ section, guests get a /r/ bundle. Reverse if you'd rather keep it on the core API.
5. **Transcode on Pool B GPU vs CPU worker.** NVENC + 3D render map cleanly onto bursty scale-to-zero GPU. Decide whether `bay-transcode` dispatches to Modal/RunPod or stays CPU ffmpeg in the shared worker for now.
6. **Bin boundary timing.** Bay owns storage until Bin ships, then federates. Confirm that's the intended sequencing.
7. **Guest preflight isolation.** Confirm guests stay off the user-visibility preflight (token-scoped only), per §15.2.
8. **MCP tool count reconciliation.** Architecture doc says 86 server tools, README badge says 340 - reconcile the canonical number when Bay's ~20 land.
