# bay MCP Tools

Bay exposes 14 `bay_*` MCP tools so an AI agent can review media exactly like a person: open a review, post coordinate-anchored annotations, and set a decision through the same tools, identity, and audit trail. Canonical bytes live in Bin; these tools operate the review layer. Each write maps to a REST endpoint under `/bay/api/v1/` and is gated by a named `bay.*` capability. The 3D viewpoint anchor rides on the existing `bay_annotation_create` anchor field, so 3D notes need no separate tool. The public ingest of guest comments and the read-only WebSocket fanout are intentionally not exposed as tools (the share link and live updates cover those).

| Tool | REST endpoint | Description |
|------|---------------|-------------|
| `bay_review_resolve` | `POST /review/resolve` | Open (find-or-create) the Bay review for a Bin media asset by `bin_asset_id`. Creates the asset and version 1 on first call, idempotent thereafter. |
| `bay_review_link_create` | `POST /review-links` | Mint a public, token-gated share link (`/bay/r/:token`) for a review. Optional `expires_in_days` (1-365) and `allow_comments`. Returns the shareable `url`. |
| `bay_asset_list` | `GET /assets` | List Bay review assets, optionally filtered by `project_id` or including archived. |
| `bay_asset_get` | `GET /assets/:id` | Get a single asset's metadata (media_kind, current version, project). |
| `bay_asset_create` | `POST /assets` | Create a review asset. `media_kind` is `image`/`video`/`audio`/`model`; bytes attach via a version. |
| `bay_asset_archive` | `POST /assets/:id/archive` | Archive (soft-delete) an asset; review history is preserved. |
| `bay_version_list` | `GET /assets/:id/versions` | List the immutable version stack of an asset, newest first. |
| `bay_version_get` | `GET /versions/:id` | Get a single version (media metadata plus Bin byte references). |
| `bay_version_create` | `POST /assets/:id/versions` | Add a new immutable version referencing Bin bytes (`bin_asset_id` / `bin_version_id`), with `media_meta`. |
| `bay_annotation_list` | `GET /versions/:id/annotations` | List annotations on a version (optionally include resolved). |
| `bay_annotation_create` | `POST /versions/:id/annotations` | Post a coordinate-anchored annotation. Anchor is structured: video `{type:"frame",frame}` or `{type:"timerange",start,end}`; image `{type:"region",x,y,w,h}`; 3D `{type:"viewpoint",camera}`. Carries the freeform 3D viewpoint anchor. |
| `bay_annotation_resolve` | `POST /annotations/:id/resolve` | Mark an annotation resolved, or reopen it with `resolved:false`. |
| `bay_decision_list` | `GET /versions/:id/decisions` | List the per-reviewer decisions on a version (the approval-rollup input). |
| `bay_decision_set` | `PUT /versions/:id/decision` | Upsert the caller's decision (`approved` / `rejected` / `changes_requested` / `pending`); one per reviewer per version. A final approval needing human ratification should route through `proposal_create` instead. |

## Related Apps

- [Bin (Digital asset management)](../bin/mcp-tools.md)
- [Bam (Project management)](../bam/mcp-tools.md)
