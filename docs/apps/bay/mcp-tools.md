# bay MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `bay_annotation_create` | Post a coordinate-anchored annotation on a Bay version. The anchor is structured + queryable: video → {type:"frame",frame} or {type:"timerange",start,end}; image → {type:"region",x,y,w,h}; 3D → {type:"viewpoint",camera}. This is how an agent posts automated-QC findings next to human notes. | `version_id`, `anchor`, `body`, `thread_parent_id` |
| `bay_annotation_list` | List annotations on a Bay version (optionally include resolved). | none |
| `bay_annotation_resolve` | Mark a Bay annotation resolved (or reopen with resolved:false). | none |
| `bay_asset_archive` | Archive (soft-delete) a Bay asset. Review history is preserved. | none |
| `bay_asset_create` | Create a Bay review asset. media_kind is one of image/video/audio/model. The canonical bytes live in Bin; attach them via bay_version_create with bin_asset_id. | `media_kind`, `project_id` |
| `bay_asset_get` | Get a Bay asset's metadata (media_kind, current version, project). | none |
| `bay_asset_list` | List Bay review assets (the durable things under review: a shot, cut, track, or model), optionally filtered by project or including archived. Returns metadata; use bay_version_list for the version stack. | `project_id`, `include_archived` |
| `bay_decision_list` | List the per-reviewer decisions on a Bay version (the approval rollup input). | none |
| `bay_decision_set` | Set (upsert) the caller's review decision on a Bay version — one decision per reviewer per version. decision is approved/rejected/changes_requested/pending. An agent setting a decision is a first-class reviewer; an agent-proposed FINAL approval that a different human must ratify should instead route through proposal_create. | `version_id`, `decision`, `comment` |
| `bay_review_link_create` | Mint a public, token-gated share link for a Bay review so an unauthenticated guest can view the media + annotations + decisions (and optionally comment) at /bay/r/:token. Optionally set an expiry (days) and whether guest comments are allowed. Returns the link including its shareable url. | `asset_id`, `expires_in_days`, `allow_comments` |
| `bay_review_resolve` | Open (find-or-create) the Bay review for a Bin media asset. Given the Bin asset id (and optionally its content_type/name/current bin_version_id), returns the Bay review asset — creating it + an initial version on first call, idempotent thereafter. This is how a media file in Bin is opened for review in Bay. | `bin_asset_id`, `bin_version_id`, `media_kind`, `content_type` |
| `bay_version_create` | Add a new immutable version to a Bay asset. Reference the canonical bytes already stored in Bin via bin_asset_id / bin_version_id, and pass media_meta (duration_sec, width, height, codec, …). | `asset_id`, `bin_asset_id`, `bin_version_id`, `media_meta` |
| `bay_version_get` | Get a single Bay version (media metadata + Bin byte references). | none |
| `bay_version_list` | List the immutable version stack of a Bay asset, newest first. | none |
