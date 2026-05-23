# Beacon — Knowledge Base Platform for BigBlueBam

**Document Version:** 0.2.0-DRAFT
**Date:** 2026-04-05
**Author:** Eddie Offermann / Claude (co-architect)
**Status:** Design Phase

---

## 1. Overview

### 1.1 What Is Beacon?

Beacon is a curated, expiry-aware knowledge base that lives alongside Bam (project management) and Banter (communication) within the BigBlueBam suite. Individual knowledge entries are called **Beacons**. The platform sits between a lightweight card system (like Guru) and a full wiki — entries can be substantive but are always subject to lifecycle governance, ensuring knowledge stays fresh and trustworthy.

### 1.2 Design Pillars

| Pillar | Description |
|---|---|
| **Freshness by default** | Every Beacon has an expiry. Stale knowledge is surfaced, not silently rotted. |
| **Hierarchical governance** | Expiry policies cascade from SuperUser → Organization → Project, with each level constrained by its parent. |
| **Agent-native** | AI agents are first-class participants, holding the same roles and permissions as human users. They can author, verify, challenge, and retire Beacons within the bounds of their assigned role. Humans handle edge cases agents can't resolve with high confidence. |
| **Semantic retrieval** | Beacons are stored in a vector database enabling semantic search, logical grouping, and agent-friendly query patterns. |
| **Suite integration** | Beacon shares authentication, authorization, database infrastructure, and UI shell with Bam and Banter. Every API endpoint is exposed via MCP with unified permission enforcement. |

### 1.3 Terminology

| Term | Definition |
|---|---|
| **Beacon** (platform) | The knowledge base subsystem as a whole. |
| **Beacon** (entry) | A single knowledge article. Pluralized as **Beacons**. Context disambiguates. |
| **Expiry** | The date/time at which a Beacon transitions from `Active` to `PendingReview`. |
| **Verification** | The act of confirming a Beacon's content is still accurate, resetting its expiry clock. |
| **Fridge Cleanout** | The governance process by which expired or unverified Beacons are surfaced, challenged, and either renewed or retired. |
| **Agent** | An AI actor registered in the system and assigned a standard BigBlueBam role (Member, Admin, etc.) at a given scope. Agents have exactly the same permissions as a human user holding the same role — no more, no less. The only behavioral differences are agent-specific metadata (model identifier, confidence thresholds, rate limits) tracked for auditability. |

---

## 2. Data Architecture

### 2.1 Relational Schema (PostgreSQL — shared with Bam/Banter)

Beacon's structured metadata lives in the same PostgreSQL instance used by Bam and Banter. The vector content lives separately (§2.2). The relational layer is the **source of truth** for identity, lifecycle, and policy; the vector layer is a **search and retrieval index** that is kept in sync.

#### 2.1.1 `beacon_entries`

The core table for Beacon metadata and lifecycle state.

```
beacon_entries
├── id                  UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── slug                VARCHAR(256) UNIQUE NOT NULL       -- URL-friendly identifier
├── title               VARCHAR(512) NOT NULL
├── summary             TEXT                               -- plain-text abstract (≤500 chars)
├── body_markdown       TEXT NOT NULL                      -- full content in Markdown (supports rich media references — images, diagrams, embedded video — via standard Markdown syntax and attachment links)
├── body_html           TEXT                               -- pre-rendered HTML cache
├── version             INTEGER NOT NULL DEFAULT 1
├── status              beacon_status NOT NULL DEFAULT 'Draft'
│                         -- ENUM: Draft, Active, PendingReview, Expired, Archived, Retired
├── visibility          beacon_visibility NOT NULL DEFAULT 'Project'
│                         -- ENUM: Public, Organization, Project, Private
├── created_by          UUID NOT NULL REFERENCES users(id)
├── owned_by            UUID NOT NULL REFERENCES users(id) -- current responsible party
├── project_id          UUID REFERENCES projects(id)       -- NULL = org-level Beacon
├── organization_id     UUID NOT NULL REFERENCES organizations(id)
├── expires_at          TIMESTAMPTZ NOT NULL
├── last_verified_at    TIMESTAMPTZ
├── last_verified_by    UUID REFERENCES users(id)          -- human or agent
├── verification_count  INTEGER NOT NULL DEFAULT 0
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
├── updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
├── retired_at          TIMESTAMPTZ                        -- set when status → Retired
├── vector_id           VARCHAR(128)                       -- foreign key into vector DB
└── metadata            JSONB DEFAULT '{}'                 -- extensible key-value pairs
```

**Indexes:**
- `idx_beacon_entries_org_project_status` on `(organization_id, project_id, status)`
- `idx_beacon_entries_expires_at` on `(expires_at)` WHERE `status = 'Active'`
- `idx_beacon_entries_slug` on `(slug)`
- GIN index on `metadata`
- Full-text search index on `(title, summary, body_markdown)` for keyword fallback

#### 2.1.2 `beacon_status` Lifecycle

```
                  ┌──────────────────────────────────────┐
                  │                                      │
                  ▼                                      │
  ┌───────┐    ┌────────┐    ┌───────────────┐    ┌──────────┐
  │ Draft │───▶│ Active │───▶│ PendingReview │───▶│ Archived │
  └───────┘    └────────┘    └───────────────┘    └──────────┘
                  ▲                  │                    │
                  │                  │                    │
                  │   (re-verified)  │                    │
                  └──────────────────┘                    │
                                                         ▼
                                                    ┌─────────┐
                                                    │ Retired │
                                                    └─────────┘
```

| Transition | Trigger |
|---|---|
| Draft → Active | Creator publishes; expiry clock starts. |
| Active → PendingReview | `expires_at` reached; or manual challenge by user/agent. |
| PendingReview → Active | Owner or authorized agent verifies; `expires_at` reset. |
| PendingReview → Archived | Grace period elapses without verification. |
| Archived → Active | Owner explicitly restores and re-verifies. |
| Archived → Retired | Admin/owner decides content is permanently obsolete. |
| Any → Retired | Admin action (hard retirement). |

#### 2.1.3 `beacon_versions`

Full version history for audit and rollback.

```
beacon_versions
├── id                  UUID PRIMARY KEY
├── beacon_id           UUID NOT NULL REFERENCES beacon_entries(id)
├── version             INTEGER NOT NULL
├── title               VARCHAR(512) NOT NULL
├── summary             TEXT
├── body_markdown       TEXT NOT NULL
├── changed_by          UUID REFERENCES users(id)
├── changed_by_agent    UUID REFERENCES beacon_agents(id)
├── change_note         TEXT
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
└── UNIQUE(beacon_id, version)
```

#### 2.1.4 `beacon_tags`

Flat tagging for organizational grouping and faceted filtering.

```
beacon_tags
├── id                  UUID PRIMARY KEY
├── beacon_id           UUID NOT NULL REFERENCES beacon_entries(id)
├── tag                 VARCHAR(128) NOT NULL
├── created_by          UUID REFERENCES users(id)
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
└── UNIQUE(beacon_id, tag)
```

#### 2.1.5 `beacon_links`

Explicit relationships between Beacons (bidirectional, typed).

```
beacon_links
├── id                  UUID PRIMARY KEY
├── source_id           UUID NOT NULL REFERENCES beacon_entries(id)
├── target_id           UUID NOT NULL REFERENCES beacon_entries(id)
├── link_type           beacon_link_type NOT NULL
│                         -- ENUM: RelatedTo, Supersedes, DependsOn, ConflictsWith, SeeAlso
├── created_by          UUID REFERENCES users(id)
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
└── UNIQUE(source_id, target_id, link_type)
```

`ConflictsWith` is a critical link type — when an agent detects contradictory information between Beacons, it creates this link and flags both for human review.

#### 2.1.6 `beacon_attachments`

Rich media (images, diagrams, embedded video) attached to Beacons. Files are stored in MinIO/S3; this table tracks metadata and ordering. The Markdown body references attachments via `![alt](/files/beacon-attachments/{id}/{filename})` links. Only the text content of `body_markdown` is encoded into the vector database for semantic search — binary media is not embedded.

```
beacon_attachments
├── id                  UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── beacon_id           UUID NOT NULL REFERENCES beacon_entries(id) ON DELETE CASCADE
├── filename            VARCHAR(512) NOT NULL
├── content_type        VARCHAR(128) NOT NULL              -- MIME type (image/png, video/mp4, etc.)
├── size_bytes          BIGINT NOT NULL
├── storage_key         VARCHAR(1024) NOT NULL              -- MinIO/S3 object key
├── sort_order          INTEGER NOT NULL DEFAULT 0
├── uploaded_by         UUID NOT NULL REFERENCES users(id)
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
└── UNIQUE(beacon_id, filename)
```

**Indexes:**
- `idx_beacon_attachments_beacon_id` on `(beacon_id)`

#### 2.1.7 `beacon_comments`

Inline discussion threads on Beacons. Supports threaded replies via `parent_id`. Beacons can also be referenced in Banter conversations using the format `BEACON-{short_id}` (first 8 chars of the Beacon UUID), enabling cross-platform discussion.

```
beacon_comments
├── id                  UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── beacon_id           UUID NOT NULL REFERENCES beacon_entries(id) ON DELETE CASCADE
├── parent_id           UUID REFERENCES beacon_comments(id) ON DELETE CASCADE  -- NULL = top-level comment
├── author_id           UUID NOT NULL REFERENCES users(id)
├── body_markdown       TEXT NOT NULL
├── body_html           TEXT                               -- pre-rendered HTML cache
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
├── updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Indexes:**
- `idx_beacon_comments_beacon_id` on `(beacon_id, created_at)`
- `idx_beacon_comments_parent_id` on `(parent_id)`

#### 2.1.8 `beacon_expiry_policies`

Hierarchical expiry governance. See §3 for the constraint resolution algorithm.

```
beacon_expiry_policies
├── id                  UUID PRIMARY KEY
├── scope               expiry_scope NOT NULL
│                         -- ENUM: System, Organization, Project
├── organization_id     UUID REFERENCES organizations(id)  -- NULL for System scope
├── project_id          UUID REFERENCES projects(id)       -- NULL for System/Org scope
├── min_expiry_days     INTEGER NOT NULL
├── max_expiry_days     INTEGER NOT NULL
├── default_expiry_days INTEGER NOT NULL
├── grace_period_days   INTEGER NOT NULL DEFAULT 14        -- time in PendingReview before auto-Archive
├── set_by              UUID NOT NULL REFERENCES users(id)
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
├── updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
├── CHECK (min_expiry_days <= default_expiry_days)
├── CHECK (default_expiry_days <= max_expiry_days)
├── CHECK (min_expiry_days > 0)
└── UNIQUE(scope, organization_id, project_id)
```

#### 2.1.9 `beacon_verifications`

Audit log of every verification event.

```
beacon_verifications
├── id                  UUID PRIMARY KEY
├── beacon_id           UUID NOT NULL REFERENCES beacon_entries(id)
├── verified_by         UUID NOT NULL REFERENCES users(id) -- human or agent (is_agent flag on user)
├── verification_type   verification_type NOT NULL
│                         -- ENUM: Manual, AgentAutomatic, AgentAssisted, ScheduledReview
├── outcome             verification_outcome NOT NULL
│                         -- ENUM: Confirmed, Updated, Challenged, Retired
├── confidence_score    REAL                               -- agent-originated verifications; 0.0–1.0
├── notes               TEXT
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

#### 2.1.10 `beacon_agents`

Registry of AI agents. Agents are **not** a separate permission tier — they are principals that hold standard BigBlueBam roles (Member, Admin, Owner, etc.) at a given scope, just like human users. This table stores agent-specific metadata for auditability and behavioral configuration; the actual permission grant comes from the same role-assignment tables used by human users.

```
beacon_agents
├── id                  UUID PRIMARY KEY
├── user_id             UUID NOT NULL REFERENCES users(id) -- agents get a user record (is_agent=true)
├── name                VARCHAR(256) NOT NULL
├── model_identifier    VARCHAR(256)                       -- e.g. "claude-sonnet-4-20250514"
├── organization_id     UUID REFERENCES organizations(id)
├── agent_config        JSONB NOT NULL DEFAULT '{}'        -- behavioral tuning (see below)
├── is_active           BOOLEAN NOT NULL DEFAULT true
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
└── updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

The `user_id` foreign key links to a standard `users` row with `is_agent = true`. This user record participates in the normal role-assignment system (`user_roles`, `project_members`, etc.), so an agent granted `ProjectMember` on Project X can do exactly what a human `ProjectMember` can do on Project X — create Beacons, edit their own, verify their own, challenge any.

**`agent_config` schema:**

```json
{
  "auto_confirm_threshold": 0.85,
  "assisted_threshold": 0.50,
  "max_daily_verifications": 200,
  "auto_publish_authored_beacons": false
}
```

These fields govern *agent-specific behavior* (confidence routing, rate limits) but do **not** expand or restrict the agent's underlying permissions.

---

### 2.2 Vector Storage Layer

#### 2.2.1 Requirements

The vector database must support:

1. **Full CRUD** — insert, update (in-place or upsert), and hard delete of individual vectors. This rules out append-only architectures.
2. **Hybrid search** — both dense vector similarity (semantic) and sparse/keyword search in a single query, with score fusion.
3. **Filtered search** — pre-filter by structured metadata (org, project, status, tags) before vector comparison.
4. **Payload storage** — attach structured metadata to each vector point so results can be enriched without a round-trip to PostgreSQL.
5. **Multi-vector per document** — a single Beacon may be chunked into multiple vectors; the DB must support grouping/retrieving by a parent ID.
6. **Logical grouping retrieval** — the ability to query a term and retrieve a cluster of logically related content, not just the top-N nearest embeddings. This requires a combination of explicit metadata links, tag overlap scoring, and graph-aware retrieval.

#### 2.2.2 Recommended Engine: Qdrant

**Why Qdrant:**

| Requirement | Qdrant Support |
|---|---|
| Full CRUD | Native upsert and delete by point ID. Updates are atomic. |
| Hybrid search | Supports dense + sparse vectors on the same point. Built-in reciprocal rank fusion (RRF). |
| Filtered search | Payload-based filtering with indexed fields. Filters are applied before ANN, not post-hoc. |
| Payload storage | Arbitrary JSON payloads per point, with indexed fields for filtering. |
| Multi-vector | Multiple named vectors per point, or use separate points with a shared `beacon_id` payload field. |
| Grouping | `group_by` parameter in search allows retrieving the best result per group (per Beacon). |
| Delete support | True delete — points are removed from the index, not tombstoned indefinitely. |
| Deployment | Self-hosted (Docker/K8s) or Qdrant Cloud. Rust-based, high performance. |

**Alternatives considered:**

- **Weaviate** — strong hybrid search, but update semantics are replace-only (no partial update). Viable but Qdrant's `group_by` is a better fit for multi-chunk retrieval.
- **Milvus** — excellent at scale, but delete support has historically been eventually-consistent. Better for large-scale append-heavy workloads.
- **Pinecone** — managed-only, no self-hosting option. Metadata filtering is good but sparse vector support is newer and less battle-tested.
- **pgvector** — could co-locate with existing PostgreSQL, but lacks hybrid search, grouping, and payload filtering at the sophistication Beacon needs. Useful as a fallback for simple similarity queries only.

#### 2.2.3 Vector Collection Schema

**Collection: `beacon_chunks`**

```json
{
  "collection_name": "beacon_chunks",
  "vectors": {
    "dense": {
      "size": 1024,
      "distance": "Cosine"
    },
    "sparse": {
      "modifier": "idf"
    }
  },
  "payload_schema": {
    "beacon_id":       { "type": "uuid",    "indexed": true },
    "organization_id": { "type": "uuid",    "indexed": true },
    "project_id":      { "type": "uuid",    "indexed": true },
    "status":          { "type": "keyword", "indexed": true },
    "tags":            { "type": "keyword", "indexed": true, "is_array": true },
    "visibility":      { "type": "keyword", "indexed": true },
    "chunk_index":     { "type": "integer" },
    "chunk_type":      { "type": "keyword", "indexed": true },
    "title":           { "type": "text" },
    "owned_by":        { "type": "uuid",    "indexed": true },
    "expires_at":      { "type": "datetime","indexed": true },
    "version":         { "type": "integer" },
    "linked_beacon_ids": { "type": "uuid",  "indexed": true, "is_array": true }
  }
}
```

**Chunk types:**
- `title_summary` — the title + summary, embedded as one chunk. Always present.
- `body_section` — a section of the body, split at heading boundaries or by token-count threshold (~512 tokens).
- `tags_metadata` — a synthetic chunk encoding tags and linked Beacon titles for retrieval-by-association.

#### 2.2.4 Chunking Strategy

```
┌─────────────────────────────────────────────────────┐
│                  Beacon Entry                       │
│  title: "Deploying to Staging"                      │
│  summary: "Step-by-step guide for staging deploys"  │
│  body: (Markdown, ~2000 words)                      │
│  tags: [deployment, staging, devops, CI/CD]          │
│  links: [beacon:abc123 (RelatedTo)]                 │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Chunk 0 [title_summary]                            │
│    "Deploying to Staging — Step-by-step guide..."   │
│                                                     │
│  Chunk 1 [body_section]                             │
│    "## Prerequisites\n\nBefore deploying..."        │
│                                                     │
│  Chunk 2 [body_section]                             │
│    "## Environment Configuration\n\n..."            │
│                                                     │
│  Chunk 3 [body_section]                             │
│    "## Running the Deploy Script\n\n..."            │
│                                                     │
│  Chunk 4 [tags_metadata]                            │
│    "Topics: deployment, staging, devops, CI/CD.     │
│     Related: Rollback Procedures (beacon:abc123)"   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

Each chunk gets both a dense embedding (from the embedding model) and a sparse embedding (BM25/SPLADE) for hybrid retrieval.

#### 2.2.5 Sync Protocol: PostgreSQL → Qdrant

The relational database is the source of truth. Qdrant is a derived index. Sync is event-driven, not polling-based.

```
  ┌────────────┐     CDC / event      ┌──────────────────┐      upsert/delete     ┌────────┐
  │ PostgreSQL │ ──────────────────▶  │  Beacon Indexer  │ ──────────────────────▶ │ Qdrant │
  │  (source)  │                      │    (worker)      │                         │(index) │
  └────────────┘                      └──────────────────┘                         └────────┘
        │                                     │
        │  beacon_entries INSERT/UPDATE/DELETE │  1. Fetch full Beacon + tags + links
        │  beacon_tags    INSERT/DELETE        │  2. Chunk the body
        │  beacon_links   INSERT/DELETE        │  3. Embed each chunk (dense + sparse)
        │                                      │  4. Upsert points by (beacon_id, chunk_index)
        │                                      │  5. Delete orphaned chunks if body shrank
        └──────────────────────────────────────┘
```

**Consistency guarantees:**
- Writes to PostgreSQL are committed first. The indexer processes events asynchronously.
- A `vector_sync_status` column on `beacon_entries` tracks: `Pending`, `Synced`, `Error`.
- On `Error`, the indexer retries with exponential backoff. A background reconciliation job runs hourly comparing PostgreSQL beacon IDs against Qdrant point beacon_ids to catch drift.
- On Beacon deletion (status → Retired), all Qdrant points with that `beacon_id` are hard-deleted.

#### 2.2.6 Retrieval: Beyond Semantic Similarity

A key design goal is that querying "deployment" should return not just Beacons semantically similar to "deployment" but also logically related content — rollback procedures, CI/CD configuration, environment setup — even if those Beacons don't use the word "deployment."

**Strategy: Multi-signal retrieval with re-ranking**

```
  User/Agent Query: "deployment"
         │
         ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Stage 1: Candidate Retrieval (broad, parallel)         │
  │                                                          │
  │  (a) Hybrid search in Qdrant (dense + sparse, RRF)     │
  │      → top 50 chunks                                    │
  │                                                          │
  │  (b) Tag expansion: find Beacons sharing tags with      │
  │      top results from (a)                                │
  │      → additional Beacon IDs                             │
  │                                                          │
  │  (c) Link traversal: follow beacon_links from top       │
  │      results (RelatedTo, DependsOn, SeeAlso)            │
  │      → additional Beacon IDs                             │
  │                                                          │
  │  (d) PostgreSQL full-text fallback (ts_vector)          │
  │      → Beacon IDs matching keyword but missed by        │
  │        embedding (rare terms, acronyms, proper nouns)   │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
         │
         ▼  Deduplicated candidate set (Beacon-level)
  ┌──────────────────────────────────────────────────────────┐
  │  Stage 2: Re-ranking                                    │
  │                                                          │
  │  Cross-encoder or LLM-based re-ranker scores each       │
  │  candidate Beacon against the original query.           │
  │  Factors:                                                │
  │    - Semantic relevance (cross-encoder score)            │
  │    - Freshness decay: Beacons that have not been         │
  │      verified recently decay in relevance as they        │
  │      approach expiry. A recently-verified Beacon ranks   │
  │      higher than a year-old Beacon at equal semantic     │
  │      relevance. Decay is a small continuous penalty,     │
  │      not a cliff — computed as:                          │
  │        freshness_boost = 1.0 - (days_since_verified /    │
  │                                  expiry_window) * 0.15   │
  │      clamped to [0.85, 1.0]. Max 15% penalty.           │
  │    - Authority (verification count, link in-degree)     │
  │    - Visibility match (user's access level)             │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
         │
         ▼  Final ranked results
```

This ensures that "deployment" surfaces rollback procedures (linked via `RelatedTo`), CI/CD config (shared `devops` tag), and environment setup (semantically adjacent) — even though none of those are literal keyword matches or nearest-neighbor embeddings for the query term.

---

## 3. Hierarchical Expiry Policy Engine

### 3.1 Scope Levels

```
  SuperUser (System scope)
      │
      ├── Organization A
      │       ├── Project A1
      │       └── Project A2
      │
      └── Organization B
              └── Project B1
```

Each level can define `min_expiry_days`, `max_expiry_days`, and `default_expiry_days`. A level's values **must fall within the range defined by its parent**.

### 3.2 Policy Resolution Algorithm

When a user creates or modifies a Beacon's expiry, the system resolves the effective policy by walking up the hierarchy:

```
FUNCTION resolve_expiry_policy(project_id, organization_id) → EffectivePolicy:

    system_policy   ← SELECT FROM beacon_expiry_policies WHERE scope = 'System'
    org_policy      ← SELECT FROM beacon_expiry_policies
                       WHERE scope = 'Organization' AND organization_id = :org_id
    project_policy  ← SELECT FROM beacon_expiry_policies
                       WHERE scope = 'Project' AND project_id = :project_id

    -- Start from system defaults
    effective.min     ← system_policy.min_expiry_days
    effective.max     ← system_policy.max_expiry_days
    effective.default ← system_policy.default_expiry_days
    effective.grace   ← system_policy.grace_period_days

    -- Narrow with org policy (if defined)
    IF org_policy EXISTS:
        effective.min     ← MAX(effective.min,     org_policy.min_expiry_days)
        effective.max     ← MIN(effective.max,     org_policy.max_expiry_days)
        effective.default ← CLAMP(org_policy.default_expiry_days, effective.min, effective.max)
        effective.grace   ← org_policy.grace_period_days   -- org overrides system grace

    -- Narrow with project policy (if defined)
    IF project_policy EXISTS:
        effective.min     ← MAX(effective.min,     project_policy.min_expiry_days)
        effective.max     ← MIN(effective.max,     project_policy.max_expiry_days)
        effective.default ← CLAMP(project_policy.default_expiry_days, effective.min, effective.max)
        effective.grace   ← project_policy.grace_period_days  -- project overrides org grace

    -- Sanity: if narrowing caused min > max, the child policy is invalid
    IF effective.min > effective.max:
        RAISE PolicyConflictError(
            "Project/Org policy creates impossible range. "
            "Child min ({effective.min}) exceeds parent max ({effective.max})."
        )

    RETURN effective
```

### 3.3 Policy Validation on Save

When an admin saves a policy at any level, the system validates it against the parent:

```
FUNCTION validate_policy_save(new_policy, parent_policy) → bool:

    IF new_policy.min_expiry_days < parent_policy.min_expiry_days:
        REJECT "Minimum ({new_policy.min}) is below parent minimum ({parent_policy.min})"

    IF new_policy.max_expiry_days > parent_policy.max_expiry_days:
        REJECT "Maximum ({new_policy.max}) exceeds parent maximum ({parent_policy.max})"

    IF new_policy.default_expiry_days < new_policy.min_expiry_days
       OR new_policy.default_expiry_days > new_policy.max_expiry_days:
        REJECT "Default must fall within [min, max]"

    -- Also validate that no CHILD policies are now out of range
    child_policies ← SELECT FROM beacon_expiry_policies
                      WHERE parent scope matches
    FOR EACH child IN child_policies:
        IF child.min < new_policy.min OR child.max > new_policy.max:
            WARN "Child policy '{child.scope}:{child.id}' is now out of range
                   and will be auto-clamped on next access"
            -- Option: auto-clamp vs. reject save. Recommend auto-clamp with
            -- notification to affected admins.

    RETURN valid
```

### 3.4 Expiry Flow Example

```
System policy:   min=7,  max=365, default=90,  grace=14
Org policy:      min=14, max=180, default=60,  grace=7
Project policy:  min=14, max=90,  default=30,  grace=7

User creates Beacon in Project:
  → effective default = 30 days
  → user can override to any value in [14, 90]
  → Beacon.expires_at = now() + 30 days

Day 30: Beacon transitions to PendingReview
  → Owner notified, agents assigned to verify
  → Grace period = 7 days

Day 37 (no verification): Beacon transitions to Archived
  → Visible in search with "Archived" badge
  → No longer surfaced in agent retrieval by default

Day 37 (verified by agent at confidence 0.95): Beacon transitions back to Active
  → expires_at = now() + 30 days (re-uses project default, or user-specified duration)
```

---

## 4. Agent Integration

### 4.1 Agent Permissions Model

Agents are **not** a separate permission tier. An agent is a `users` record with `is_agent = true`, assigned standard BigBlueBam roles (SuperUser, Org Admin, Org Owner, Project Admin, Project Member) through the same role-assignment mechanism as human users. Whatever a human can do at a given role level, an agent at that same level can do — and nothing more.

**Example:**
- An agent assigned `ProjectMember` on Project X can: create Beacons in X, edit its own Beacons, verify its own Beacons, challenge any Beacon in X.
- That same agent **cannot**: edit other users' Beacons, retire Beacons, or set expiry policies — because `ProjectMember` doesn't grant those capabilities to anyone.
- An agent assigned `ProjectAdmin` on Project X gains the same elevated capabilities a human `ProjectAdmin` would: editing any Beacon in scope, setting project-level expiry policy, retiring Beacons.

The only agent-specific behaviors are:

| Behavior | Purpose | Configured in |
|---|---|---|
| **Confidence thresholds** | Route verification outcomes to auto-confirm, assisted, or escalation. | `beacon_agents.agent_config` |
| **Rate limits** | Cap daily automated actions to control cost and prevent runaway loops. | `beacon_agents.agent_config` |
| **Auto-publish toggle** | Whether agent-authored Beacons can skip human review. Default: `false`. | `beacon_agents.agent_config` |
| **Audit tagging** | All agent actions are tagged with `verification_type` = `AgentAutomatic` or `AgentAssisted` for traceability. | Automatic |

These behaviors constrain or annotate agent actions — they never expand permissions beyond what the agent's assigned role allows.

### 4.2 Verification Pipeline

```
  ┌────────────────────────────────────────────────────────────┐
  │              Beacon Verification Pipeline                  │
  │                                                            │
  │  Trigger: Beacon.status → PendingReview                   │
  │           OR scheduled verification sweep                  │
  │                                                            │
  │  Step 1: Agent Context Assembly                           │
  │    - Fetch Beacon content + metadata                       │
  │    - Fetch linked Beacons (1 hop)                          │
  │    - Fetch recent Bam activity in same project             │
  │    - Fetch recent Banter threads mentioning Beacon tags    │
  │                                                            │
  │  Step 2: Agent Verification Check                         │
  │    - Does the content contradict any linked Beacons?       │
  │    - Has the project context changed materially since      │
  │      the last verification? (new Bam tasks, closed epics)  │
  │    - Are there external signals (if web-access enabled)    │
  │      that invalidate the content?                          │
  │    - Confidence score: 0.0–1.0                             │
  │                                                            │
  │  Step 3: Outcome Routing                                  │
  │    - confidence ≥ 0.85 → AgentAutomatic: Confirmed        │
  │      (reset expiry, log verification)                      │
  │    - 0.50 ≤ confidence < 0.85 → AgentAssisted: Challenged │
  │      (notify owner with agent's findings for human review) │
  │    - confidence < 0.50 → Escalate to human immediately    │
  │      (agent marks as uncertain, assigns to owner)          │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

### 4.3 Agent Confidence Thresholds

These thresholds are configurable per agent via `beacon_agents.agent_config`:

```json
{
  "auto_confirm_threshold": 0.85,
  "assisted_threshold": 0.50,
  "max_daily_verifications": 200
}
```

### 4.4 Agent-Created Beacons

Agents with a role that grants Beacon creation (Member+) can create new Beacons, but these enter a distinct workflow by default:

- Status starts as `Draft` with `metadata.agent_authored = true`.
- An `AgentDraft` notification is sent to project owners.
- The Beacon is not searchable until a human promotes it to `Active`.
- Exception: The agent's `agent_config.auto_publish_authored_beacons` can be set to `true` if the organization trusts the agent pipeline.

---

## 5. API Surface

### 5.1 REST Endpoints

All endpoints are prefixed with `/api/v1/beacon`.

#### Beacon CRUD

| Method | Path | Description | Auth |
|---|---|---|---|
| `POST` | `/beacons` | Create a new Beacon (Draft). | Member+ |
| `GET` | `/beacons` | List Beacons (filtered, paginated). | Member+ |
| `GET` | `/beacons/:id` | Get a single Beacon by ID or slug. | Member+ |
| `PUT` | `/beacons/:id` | Update Beacon content (creates new version). | Owner/Admin |
| `DELETE` | `/beacons/:id` | Retire a Beacon (soft delete). | Owner/Admin |
| `POST` | `/beacons/:id/publish` | Transition Draft → Active. | Owner/Admin |
| `POST` | `/beacons/:id/verify` | Record a verification event. | Owner/Admin (own/any per role) |
| `POST` | `/beacons/:id/challenge` | Flag for review (→ PendingReview). | Member+ |
| `GET` | `/beacons/:id/versions` | List version history. | Member+ |
| `GET` | `/beacons/:id/versions/:v` | Get a specific version. | Member+ |
| `POST` | `/beacons/:id/restore` | Restore Archived → Active (re-verify). | Owner/Admin |

#### Search & Retrieval

| Method | Path | Description | Auth |
|---|---|---|---|
| `POST` | `/search` | Hybrid search (semantic + keyword + graph). | Member+ |
| `GET` | `/search/suggest` | Typeahead suggestions from title/tag index. | Member+ |
| `POST` | `/search/context` | Structured retrieval optimized for agent consumption (richer metadata, linked Beacons pre-fetched). Same permissions as `/search`. | Member+ |

#### Policy Management

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/policies` | Get effective policy for current scope. | Member+ |
| `PUT` | `/policies` | Set/update policy at scope level. | Admin/SuperUser |
| `GET` | `/policies/resolve?project_id=X` | Preview resolved effective policy. | Admin+ |

#### Comments

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/beacons/:id/comments` | List comments on a Beacon (threaded). | Member+ |
| `POST` | `/beacons/:id/comments` | Add a comment (set `parent_id` for replies). | Member+ |
| `PUT` | `/beacons/:id/comments/:comment_id` | Edit own comment. | Author only |
| `DELETE` | `/beacons/:id/comments/:comment_id` | Delete own comment (Admin can delete any). | Author/Admin |

#### Attachments

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/beacons/:id/attachments` | List attachments on a Beacon. | Member+ |
| `POST` | `/beacons/:id/attachments` | Upload an attachment (multipart). | Owner/Admin |
| `DELETE` | `/beacons/:id/attachments/:attachment_id` | Remove an attachment. | Owner/Admin |

#### Tags & Links

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/tags` | List all tags in scope (with counts). | Member+ |
| `POST` | `/beacons/:id/tags` | Add tags. | Owner/Admin |
| `DELETE` | `/beacons/:id/tags/:tag` | Remove a tag. | Owner/Admin |
| `POST` | `/beacons/:id/links` | Create a link to another Beacon. | Member+ |
| `DELETE` | `/beacons/:id/links/:link_id` | Remove a link. | Owner/Admin |

### 5.2 Search Request Schema

```json
{
  "query": "deployment",
  "filters": {
    "organization_id": "uuid",
    "project_ids": ["uuid", "uuid"],
    "status": ["Active"],
    "tags": ["devops"],
    "visibility_max": "Project",
    "expires_after": "2026-04-01T00:00:00Z"
  },
  "options": {
    "include_graph_expansion": true,
    "include_tag_expansion": true,
    "include_fulltext_fallback": true,
    "rerank": true,
    "top_k": 10,
    "group_by_beacon": true
  }
}
```

### 5.3 Search Response Schema

```json
{
  "results": [
    {
      "beacon_id": "uuid",
      "slug": "deploying-to-staging",
      "title": "Deploying to Staging",
      "summary": "Step-by-step guide for staging deploys",
      "status": "Active",
      "relevance_score": 0.94,
      "match_sources": ["semantic", "tag_expansion"],
      "expires_at": "2026-05-05T00:00:00Z",
      "last_verified_at": "2026-03-20T00:00:00Z",
      "verification_count": 3,
      "tags": ["deployment", "staging", "devops"],
      "linked_beacons": [
        { "id": "uuid", "title": "Rollback Procedures", "link_type": "RelatedTo" }
      ],
      "highlight": "...run the **deploy** script with the staging flag..."
    }
  ],
  "total_candidates": 47,
  "retrieval_stages": {
    "semantic_hits": 32,
    "tag_expansion_hits": 8,
    "link_traversal_hits": 5,
    "fulltext_fallback_hits": 2
  }
}
```

### 5.4 MCP (Model Context Protocol) Exposure

**Every Beacon REST endpoint is exposed as an MCP tool.** This is not a separate API layer — the MCP server is a thin transport adapter over the same service layer that backs the REST API, sharing identical permission enforcement, validation, and audit logging.

#### 5.4.1 Design Principles

1. **1:1 mapping.** Each REST endpoint maps to exactly one MCP tool. No MCP-only operations exist, and no REST operations are excluded from MCP. If it's in the API, it's callable via MCP.
2. **Unified auth.** MCP tool calls authenticate through the same BigBlueBam auth system (OAuth2 / API key / session token). The calling agent's `user_id` (which may have `is_agent = true`) is resolved to its role assignments, and permission checks are identical to a REST call made by that same principal.
3. **No permission escalation.** The MCP transport layer never grants additional capabilities. An agent with `ProjectMember` calling `beacon_verify` via MCP is subject to the same "own Beacons only" restriction as a human calling `POST /beacons/:id/verify` via REST.
4. **Structured I/O.** MCP tool inputs and outputs use the same JSON schemas as the REST request/response bodies (§5.2, §5.3). No schema translation or lossy mapping.

#### 5.4.2 MCP Tool Registry

| MCP Tool Name | Maps to REST Endpoint | Description |
|---|---|---|
| `beacon_create` | `POST /beacons` | Create a new Beacon (Draft). |
| `beacon_list` | `GET /beacons` | List Beacons with filters and pagination. |
| `beacon_get` | `GET /beacons/:id` | Retrieve a single Beacon by ID or slug. |
| `beacon_update` | `PUT /beacons/:id` | Update content (creates new version). |
| `beacon_retire` | `DELETE /beacons/:id` | Retire a Beacon (soft delete). |
| `beacon_publish` | `POST /beacons/:id/publish` | Transition Draft → Active. |
| `beacon_verify` | `POST /beacons/:id/verify` | Record a verification event. |
| `beacon_challenge` | `POST /beacons/:id/challenge` | Flag for review. |
| `beacon_versions` | `GET /beacons/:id/versions` | List version history. |
| `beacon_version_get` | `GET /beacons/:id/versions/:v` | Get a specific version. |
| `beacon_restore` | `POST /beacons/:id/restore` | Restore Archived → Active. |
| `beacon_search` | `POST /search` | Hybrid semantic + keyword + graph search. |
| `beacon_suggest` | `GET /search/suggest` | Typeahead suggestions. |
| `beacon_search_context` | `POST /search/context` | Structured retrieval with enriched metadata. |
| `beacon_policy_get` | `GET /policies` | Get effective policy for current scope. |
| `beacon_policy_set` | `PUT /policies` | Set/update policy at scope level. |
| `beacon_policy_resolve` | `GET /policies/resolve` | Preview resolved effective policy. |
| `beacon_tags_list` | `GET /tags` | List all tags in scope. |
| `beacon_tag_add` | `POST /beacons/:id/tags` | Add tags to a Beacon. |
| `beacon_tag_remove` | `DELETE /beacons/:id/tags/:tag` | Remove a tag. |
| `beacon_link_create` | `POST /beacons/:id/links` | Create a typed link between Beacons. |
| `beacon_link_remove` | `DELETE /beacons/:id/links/:link_id` | Remove a link. |
| `beacon_comment_list` | `GET /beacons/:id/comments` | List comments on a Beacon. |
| `beacon_comment_add` | `POST /beacons/:id/comments` | Add a comment or reply. |
| `beacon_comment_update` | `PUT /beacons/:id/comments/:comment_id` | Edit own comment. |
| `beacon_comment_delete` | `DELETE /beacons/:id/comments/:comment_id` | Delete a comment. |
| `beacon_attachment_list` | `GET /beacons/:id/attachments` | List attachments on a Beacon. |
| `beacon_attachment_upload` | `POST /beacons/:id/attachments` | Upload an attachment. |
| `beacon_attachment_delete` | `DELETE /beacons/:id/attachments/:attachment_id` | Remove an attachment. |

#### 5.4.3 MCP Server Configuration

The Beacon MCP server runs as a sidecar (or integrated module) within the BigBlueBam API gateway, alongside the Bam and Banter MCP servers. All three share the same auth middleware and user/role resolution.

```
  ┌──────────────────────────────────────────────────────────────┐
  │                  BigBlueBam API Gateway                      │
  │                                                              │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
  │  │ Bam MCP  │  │ Banter   │  │ Beacon   │                  │
  │  │ Server   │  │ MCP Srv  │  │ MCP Srv  │                  │
  │  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
  │       │              │              │                        │
  │       └──────────────┼──────────────┘                        │
  │                      ▼                                       │
  │           ┌─────────────────────┐                            │
  │           │  Shared Auth / RBAC │                            │
  │           │  (OAuth2 + roles)   │                            │
  │           └─────────────────────┘                            │
  │                      │                                       │
  │       ┌──────────────┼──────────────┐                        │
  │       ▼              ▼              ▼                        │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
  │  │ Bam      │  │ Banter   │  │ Beacon   │                  │
  │  │ Service  │  │ Service  │  │ Service  │                  │
  │  └──────────┘  └──────────┘  └──────────┘                  │
  └──────────────────────────────────────────────────────────────┘
```

#### 5.4.4 Cross-Suite Agent Workflows via MCP

Because Bam, Banter, and Beacon all expose MCP tools through the same gateway, an agent can compose cross-suite workflows in a single session:

- **Bam task closes → agent calls `beacon_search` to find related Beacons → calls `beacon_challenge` on any that may be outdated.**
- **Agent calls `beacon_search_context` to gather knowledge → uses results to draft a Banter message summarizing current state for the team.**
- **Banter thread flagged as knowledge-worthy → agent calls `beacon_create` with content distilled from the thread.**

The MCP transport enables these compositions naturally — the agent simply calls tools from whichever suite's MCP server it needs, with permissions checked per-call against its role assignments in each scope.

---

### 5.5 Human Query Experience

The preceding sections (§5.1–§5.4) define the data-level API surface — what the system accepts, returns, and exposes to agents. This section specifies how **human users** search, browse, and discover Beacons through the UI. The design philosophy: give humans direct, transparent access to the retrieval pipeline. No invisible AI summarization layer sits between the search engine and the person. If synthesis is needed, an AI agent teammate does that work visibly — in Banter, where it can be discussed.

#### 5.5.1 Faceted Query Builder

The query builder is the primary human search interface. It translates interactive selections into the same search request schema defined in §5.2. No NLP, no language model, no "smart" interpretation — humans are the architects of their own queries here.

##### Component Anatomy

The query builder is a set of composable controls mapped directly to §5.2 fields:

```
┌────────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 🔍  Search Beacons...                          [Search] │  │  ← query
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  Project: [Current Project ▾] [+ Add project]                  │  ← filters.project_ids
│  Tags:    [devops ×] [staging ×] [+ Add tag ▾]    (32 total)  │  ← filters.tags
│                                                                │
│  ▸ Advanced filters                                            │  ← collapsed by default
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Status:    [✓] Active  [ ] PendingReview  [ ] Archived │  │  ← filters.status
│  │  Freshness: Verified within [  30  ] days                │  │  ← filters.expires_after
│  │             Expiring within [  ── ] days                 │  │
│  │  Retrieval: [✓] Graph expansion  [✓] Tag neighbors      │  │  ← options.*
│  │             [✓] Keyword fallback                         │  │
│  │  Visibility ceiling: [Project ▾]                         │  │  ← filters.visibility_max
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ≈ 47 Beacons match                          [Save query ▾]   │  ← live count + saved queries
└────────────────────────────────────────────────────────────────┘
```

##### Control-to-Schema Mapping

| UI Control | §5.2 Field | Type | Default | Notes |
|---|---|---|---|---|
| Free-text search field | `query` | string | `""` | Searches title, summary, body via hybrid retrieval |
| Project scope selector | `filters.project_ids` | UUID[] | Current project | Multi-select; expandable to org-wide (empty array = all accessible projects) |
| Tag filter | `filters.tags` | string[] | `[]` | Typeahead populated from `GET /tags`; shows per-tag Beacon counts |
| Status checkboxes | `filters.status` | string[] | `["Active"]` | `Retired` excluded unless admin toggle is on |
| Freshness — "verified within" | `filters.expires_after` | ISO timestamp | `null` | Computed: `now() + N days` (ensures Beacons expiring after that date, i.e., recently verified) |
| Freshness — "expiring within" | `filters.expires_after` | ISO timestamp | `null` | Computed: `now() + N days` (shows only Beacons expiring soon) |
| Graph expansion toggle | `options.include_graph_expansion` | boolean | `true` | Follows `beacon_links` from top results |
| Tag neighbor toggle | `options.include_tag_expansion` | boolean | `true` | Expands by shared tags |
| Keyword fallback toggle | `options.include_fulltext_fallback` | boolean | `true` | PostgreSQL `ts_vector` fallback |
| Visibility ceiling | `filters.visibility_max` | string | User's highest permitted | `Public`, `Organization`, `Project`, or `Private` |

##### Progressive Disclosure

Two tiers prevent overwhelm:

- **Primary tier** (always visible): free-text field, project scope, tag filter.
- **Advanced tier** (expandable panel): status filter, freshness controls, retrieval toggles, visibility ceiling.

The advanced tier remembers its collapsed/expanded state per user, persisted in the user's `preferences` JSONB column (same mechanism as Bam's notification preferences). Preference key: `beacon_query_advanced_expanded: boolean`.

##### Live Query Preview

As the user adjusts filters, the builder displays an estimated result count. This is a lightweight `POST /search` call with `top_k: 0` (count-only mode — the search endpoint returns `total_candidates` without materializing full results when `top_k` is 0). The count updates debounced at 300ms after the last filter change.

##### Saved Queries

Users can save named query configurations — serialized §5.2 request bodies with metadata.

```
beacon_saved_queries
├── id                  UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── name                VARCHAR(200) NOT NULL
├── description         VARCHAR(500)
├── query_body          JSONB NOT NULL                -- serialized §5.2 search request
├── owner_id            UUID NOT NULL REFERENCES users(id)
├── scope               saved_query_scope NOT NULL DEFAULT 'Private'
│                         -- ENUM: Private, Project, Organization
├── project_id          UUID REFERENCES projects(id)  -- NULL unless scope = Project
├── organization_id     UUID NOT NULL REFERENCES organizations(id)
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
├── updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
└── UNIQUE(owner_id, name)
```

**Indexes:**
- `idx_saved_queries_owner` on `(owner_id)`
- `idx_saved_queries_scope_org` on `(scope, organization_id)` WHERE `scope != 'Private'`

**REST endpoints:**

| Method | Path | Description | Auth |
|---|---|---|---|
| `POST` | `/search/saved` | Save a named query. | Member+ |
| `GET` | `/search/saved` | List saved queries (own + shared in scope). | Member+ |
| `GET` | `/search/saved/:id` | Get a saved query by ID. | Member+ (own or shared) |
| `DELETE` | `/search/saved/:id` | Delete a saved query. | Owner only |

**MCP tools (added to registry):**

| MCP Tool Name | Maps to REST Endpoint | Description |
|---|---|---|
| `beacon_query_save` | `POST /search/saved` | Save a named search query. |
| `beacon_query_list` | `GET /search/saved` | List saved queries in scope. |
| `beacon_query_get` | `GET /search/saved/:id` | Retrieve a saved query. |
| `beacon_query_delete` | `DELETE /search/saved/:id` | Delete a saved query. |

Agents can execute a saved query by name: call `beacon_query_get` to retrieve the `query_body`, then pass it directly to `beacon_search`.

##### URL-Serialized State

The full query state is encoded in URL query parameters so that query links are shareable — paste a URL in Banter and the recipient sees the exact filtered view.

Serialization approach: the §5.2 request body is JSON-stringified, then Base64url-encoded into a single `q` parameter:

```
/beacons/search?q=eyJxdWVyeSI6ImRlcGxveW1lbnQiLCJmaWx0ZXJz...
```

The query builder reads this parameter on mount and hydrates all controls from it. If both URL state and user-modified controls exist, URL state wins on initial load (it represents an inbound shared link).

For simple queries (text-only, default filters), a human-readable shorthand is also supported:

```
/beacons/search?text=deployment&tags=devops,staging&project=uuid
```

The builder recognizes both forms; the `q` parameter takes precedence when present.

---

#### 5.5.2 Relevance-Ordered Results Surface

Results are Beacons, presented as Beacons — not as "ten blue links" and not as AI-generated answer summaries. Each result is a first-class knowledge card showing enough context to evaluate relevance at a glance.

##### Result Card Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│  Deploying to Staging                                [Active]   │  ← title (linked) + status badge
│                                                                 │
│  Step-by-step guide for staging deploys via the CI/CD pipeline. │  ← summary (≤500 chars)
│                                                                 │
│  "...run the **deploy** script with the staging flag..."        │  ← highlight (matched passage)
│                                                                 │
│  [deployment] [staging] [devops]                                │  ← tags (clickable → adds to filter)
│                                                                 │
│  ◉ Semantic match  ◉ Related via: Rollback Procedures           │  ← match_sources badges
│                                                                 │
│  ●●●○ Fresh (verified 16d ago)   3 verifications   @eddie      │  ← freshness ring + metadata
│  └─ Linked: Rollback Procedures (RelatedTo)                     │  ← linked Beacons preview
│             CI/CD Configuration (DependsOn)                     │
└─────────────────────────────────────────────────────────────────┘
```

Each field maps to the §5.3 response schema:

| Card Element | Source Field | Behavior |
|---|---|---|
| Title | `title` | Clickable link to full Beacon view |
| Status badge | `status` | Color-coded: green (Active), yellow (PendingReview), grey (Archived) |
| Summary | `summary` | Plain text, ≤500 chars |
| Highlight | `highlight` | Matched passage with emphasis on query terms |
| Tags | `tags` | Interactive chips; clicking a tag adds it to the current query's tag filter |
| Match sources | `match_sources` | Badges explaining why this result appeared: `"semantic"` → "Semantic match", `"tag_expansion"` → "Shared tag: X", `"link_traversal"` → "Related via: Y", `"fulltext_fallback"` → "Keyword match" |
| Freshness indicator | `last_verified_at`, `expires_at` | Ring/icon: green = verified ≤30d ago, yellow = expiring within 14d, red = expired/PendingReview |
| Verification count | `verification_count` | Subtle metadata |
| Owner | `owned_by` → display name | Subtle metadata |
| Linked Beacons | `linked_beacons` | First 2 shown as inline references with link-type labels; clickable into Knowledge Graph Explorer (§5.5.3) |

##### Result Ordering and Grouping

Results are ordered by the re-ranker's final `relevance_score` (§2.2.6 Stage 2). The default view is a flat ranked list — no pagination tricks, no "grouped by project" default.

Client-side re-sort control provides alternative orderings:

| Sort Mode | Sort Key | Description |
|---|---|---|
| Relevance (default) | `relevance_score` DESC | Re-ranker's combined score |
| Freshness | `last_verified_at` DESC | Most recently verified first |
| Expiry | `expires_at` ASC | Soonest-expiring first (triage mode) |
| Authority | `verification_count + inbound_link_count` DESC | Most-verified and most-referenced first |

The re-sort is client-side over the already-returned result set (no additional API call). The sort mode selector is a compact dropdown in the results header.

##### Retrieval Transparency

At the top of the results surface, the `retrieval_stages` summary from §5.3 is displayed:

```
47 Beacons found: 32 semantic · 8 tag-expanded · 5 link-traversed · 2 keyword fallback
```

This builds trust and helps users understand the search behavior. If all results came from one stage (e.g., "All results from keyword fallback"), that's useful diagnostic signal — the embedding model may not have captured this term well.

##### Empty and Sparse States

| Condition | Behavior |
|---|---|
| **Zero results** | Show the current filter summary. Suggest broadening: "Try removing tag filters" or "Search org-wide" (if currently project-scoped). Offer a one-click "Clear all filters" action. |
| **Few results (< 3)** | Show results normally. Append a "Related tags" suggestion below the results, populated from tags on the returned Beacons that the user hasn't filtered on. Also suggest "Broaden to org" if project-scoped. |
| **All results stale** | Surface prominently: "All matching Beacons are awaiting review. Consider verifying or creating new content." Link to the Fridge Cleanout dashboard (§6.3). |

##### No AI Summary Layer

The results surface does **not** include an AI-generated answer or summary panel. This is a deliberate design decision:

Beacon's retrieval pipeline (§2.2.6) gets the right Beacons in front of the right humans. If synthesis is needed — combining information from multiple Beacons into a coherent answer — that is a workflow an AI agent teammate performs in Banter, where the synthesized output can be discussed, challenged, and refined by the team. The search surface stays honest: you see what the knowledge base actually contains, not what an AI thinks it means. This prevents the "confident wrong answer" problem that plagues RAG systems where users see only the summary and never the source material.

---

#### 5.5.3 Knowledge Graph Explorer (Browse & Discover)

Not every knowledge interaction starts with a query. The Knowledge Graph Explorer is a visual, interactive network view of the Beacon link graph. It lets users freely explore the knowledge landscape — discovering connections, seeing what's central, what's peripheral, what's freshly maintained, and what's decaying.

##### Graph Data Model

The explorer visualizes two edge types:

| Edge Type | Source | Styling | Description |
|---|---|---|---|
| **Explicit links** | `beacon_links` (§2.1.5) | Solid line, color-coded by `link_type` | `RelatedTo` (blue), `Supersedes` (purple), `DependsOn` (orange), `ConflictsWith` (red, dashed), `SeeAlso` (grey) |
| **Implicit links (tag affinity)** | Computed: shared tags ≥ N | Dotted grey line, lighter weight | Two Beacons sharing N or more tags are connected. Global default N=2. Tunable per organization and per project via settings (org/project admins can override the threshold to suit their tagging density). Shows topical clustering without manual linking. |

Implicit edges are computed server-side during graph data retrieval (§5.5.3 API Support) so the client doesn't need the full tag index.

##### Node Rendering

Each Beacon is a node. Visual properties encode metadata:

| Property | Encodes | Mapping |
|---|---|---|
| **Size** | Authority | `verification_count + inbound_link_degree`. More verified and more referenced = larger node. Min radius 20px, max 60px, linear scale. |
| **Color / ring** | Freshness + status | Active + verified ≤30d = green ring. Active + expiring ≤14d = yellow ring. PendingReview = orange ring. Archived = grey ring. Retired nodes hidden by default. |
| **Label** | Title | Truncated to 30 chars with full title + summary on hover. |

On hover or select, a detail popover appears:

```
┌─────────────────────────────────────┐
│  Deploying to Staging       Active  │
│                                     │
│  Step-by-step guide for staging     │
│  deploys via the CI/CD pipeline.    │
│                                     │
│  [deployment] [staging] [devops]    │
│                                     │
│  Verified 16d ago · 3 verifications │
│  Owner: @eddie                      │
│                                     │
│  [View Beacon]  [Explore from here] │
└─────────────────────────────────────┘
```

"View Beacon" navigates to the full Beacon detail page. "Explore from here" re-centers the graph on this node.

##### Entry Points

| From | Action | Explorer State |
|---|---|---|
| Search results (§5.5.2) | Click a linked-Beacon reference or "See in graph" icon on any result card | Centered on that Beacon, 1-hop neighbors loaded |
| Beacon detail view | "View connections" action in the detail header | Centered on the current Beacon |
| Knowledge Home (standalone) | Open the explorer from the Beacon nav | Knowledge Home view (see below) |
| Tag | Click "Explore tag: devops" from tag detail or result card | All Beacons with that tag shown, plus their connections |

##### Exploration Mechanics

1. **Focus + expand.** Clicking a node makes it the focus. Its immediate neighbors (1-hop) are loaded and displayed. A second click or a dedicated "Expand" button loads 2-hop neighbors. Data is lazy-loaded — the full graph is never sent to the client at once.

2. **Traversal breadcrumb.** As the user explores, a breadcrumb trail of focus nodes is maintained:

   ```
   Staging Deploy → Rollback Procedures → CI/CD Configuration
   ```

   Each crumb is clickable for backtracking. The trail resets when the user opens a new entry point.

3. **Filter overlay.** The same faceted filters from §5.5.1 (project scope, tags, status, freshness) can be applied as a live overlay on the graph. Nodes that don't match the filters are dimmed (reduced opacity, no interactivity) rather than removed — this preserves spatial context while narrowing focus.

4. **Cluster detection.** The layout algorithm groups densely-connected subgraphs into visual clusters. Tag affinity edges reinforce clustering — Beacons sharing many tags and explicit links naturally group. Each cluster is labeled by its most common shared tag(s) (e.g., "devops cluster," "onboarding cluster").

##### Knowledge Home

The explorer's default landing state when opened without a focal node:

| Panel | Content | Source |
|---|---|---|
| **Hub Beacons** (center graph) | Top 20 nodes by combined authority (in-degree + verification count) | `GET /graph/hubs` |
| **Recently Updated** (sidebar) | Beacons updated/verified in the last 7 days, with one-click focus in graph | `GET /graph/recent` |
| **At-Risk** (highlighted in graph) | Beacons expiring within 7 days, rendered with a pulsing outline | `GET /graph/hubs` response includes `expires_at`; client-side filter |
| **Coverage Summary** (sidebar) | Per-project Beacon counts, linking to project-scoped graph views | `GET /beacons` with `group_by=project` aggregation |

##### API Support

New endpoints for graph exploration:

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/graph/neighbors` | Nodes and edges within N hops of a focal Beacon. | Member+ |
| `GET` | `/graph/hubs` | Most-connected Beacons in scope (for Knowledge Home). | Member+ |
| `GET` | `/graph/recent` | Recently modified/verified Beacons (lightweight). | Member+ |

**`GET /graph/neighbors` request parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `beacon_id` | UUID | required | Focal Beacon |
| `hops` | integer (1–3) | `1` | Traversal depth |
| `include_implicit` | boolean | `true` | Include tag-affinity edges |
| `tag_affinity_threshold` | integer (1–5) | `2` | Minimum shared tags for an implicit edge |
| `filters.status` | string[] | `["Active", "PendingReview"]` | Exclude nodes by status |

**`GET /graph/neighbors` response schema:**

```json
{
  "focal_beacon_id": "uuid",
  "nodes": [
    {
      "id": "uuid",
      "title": "Deploying to Staging",
      "summary": "Step-by-step guide...",
      "status": "Active",
      "tags": ["deployment", "staging", "devops"],
      "verification_count": 3,
      "inbound_link_count": 5,
      "expires_at": "2026-05-05T00:00:00Z",
      "last_verified_at": "2026-03-20T00:00:00Z",
      "owned_by": "uuid"
    }
  ],
  "edges": [
    {
      "source_id": "uuid",
      "target_id": "uuid",
      "edge_type": "explicit",
      "link_type": "RelatedTo"
    },
    {
      "source_id": "uuid",
      "target_id": "uuid",
      "edge_type": "implicit",
      "shared_tags": ["devops", "infrastructure"],
      "shared_tag_count": 2
    }
  ]
}
```

**`GET /graph/hubs` request parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `scope` | `"project"` \| `"organization"` | `"project"` | Scope level |
| `project_id` | UUID | current project | Required if scope = project |
| `top_k` | integer (1–50) | `20` | Number of hub nodes to return |

**`GET /graph/recent` request parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `scope` | `"project"` \| `"organization"` | `"project"` | Scope level |
| `project_id` | UUID | current project | Required if scope = project |
| `days` | integer (1–90) | `7` | Lookback window |

**MCP tools (added to registry):**

| MCP Tool Name | Maps to REST Endpoint | Description |
|---|---|---|
| `beacon_graph_neighbors` | `GET /graph/neighbors` | Get nodes and edges within N hops of a Beacon. |
| `beacon_graph_hubs` | `GET /graph/hubs` | Get the most-connected Beacons in scope. |
| `beacon_graph_recent` | `GET /graph/recent` | Get recently modified/verified Beacons. |

##### Performance & Rendering

| Constraint | Value | Rationale |
|---|---|---|
| Max visible nodes | ~200 (soft cap) | UX choice, not a performance limit — the rendering stack handles 5k–10k nodes at 60fps. Can be relaxed as the knowledge base grows without re-architecting. Apply proximity culling: show only the most connected/relevant nodes within the current viewport. |
| Graph data model | **graphology** — in-memory graph with node/edge CRUD, attribute storage, and traversal. Shared data layer between layout and rendering. | |
| Layout engine | **ForceAtlas2** via `graphology-layout-forceatlas2` (web worker mode). `linLogMode` enabled to emphasize community structure, surfacing tag-affinity clusters without a separate detection pass. | Produces naturally clustered, organic network layouts tuned for exploratory visualization. |
| Rendering engine | **Sigma.js v2** — consumes graphology instances directly. WebGL-accelerated node/edge drawing, label culling at zoom thresholds, hover/click interaction, built-in neighborhood highlighting for focus-and-expand. | |
| Custom node visuals | Freshness rings, status-colored borders, authority-scaled sizing, pulsing at-risk indicators — implemented as **custom node programs** (GLSL shaders registered with Sigma's renderer). | |
| Detail popovers | Sigma's **HTML overlay layer** composited above the WebGL canvas, rendered as a React portal positioned at the focused node's screen coordinates. | |
| Lazy loading | Fetch node/edge data only as the user expands neighborhoods | No full-graph dump. Each `GET /graph/neighbors` call returns a bounded result set. |
| Layout stability | New nodes are added with low-alpha simulation steps to avoid full re-layout | Prevents the jarring "everything moves" experience when expanding a neighborhood. |
| Implicit edge computation | Server-side, cached per Beacon with 10-minute TTL | Avoids shipping the full tag index to the client. Cache invalidated on tag add/remove. |

---

## 6. Fridge Cleanout Governance

### 6.1 Scheduled Sweeps

A background job runs daily (configurable per org):

1. **Expiry check:** Find all Beacons where `status = 'Active' AND expires_at <= now()`. Transition to `PendingReview`.
2. **Grace check:** Find all Beacons where `status = 'PendingReview' AND expires_at + grace_period <= now()`. Transition to `Archived`.
3. **Stale draft cleanup:** Find all Beacons where `status = 'Draft' AND created_at < now() - 30 days`. Notify creator; auto-delete after 60 days.
4. **Agent verification queue:** Enqueue all `PendingReview` Beacons for agent verification (§4.2).
5. **Contradiction scan:** Periodically (weekly), agents scan recently-modified Beacons for conflicts with existing content.

### 6.2 Notifications

| Event | Recipient | Channel |
|---|---|---|
| Beacon entering PendingReview | Owner, project admins | Banter DM + email |
| Agent verified (auto-confirm) | Owner (FYI) | Banter DM |
| Agent challenged | Owner (action required) | Banter DM + email |
| Grace period 50% elapsed | Owner, project admins | Banter DM |
| Beacon archived | Owner, project admins | Banter channel + email |
| Contradiction detected | Both Beacon owners | Banter DM |

### 6.3 Dashboard Metrics

The Beacon health dashboard (accessible to Admins+) surfaces:

- **Freshness score:** % of Active Beacons verified within the last 30 days.
- **At-risk Beacons:** Count expiring within 7 days.
- **Archived backlog:** Beacons in Archived state > 30 days (candidates for retirement).
- **Agent activity:** Verifications/day, auto-confirm rate, challenge rate.
- **Coverage gaps:** Projects with fewer than N Beacons (configurable threshold).
- **Contradiction count:** Open `ConflictsWith` links awaiting resolution.

---

## 7. Integration Points with Bam & Banter

### 7.1 Bam Integration

- **Link Beacons to Bam cards:** A Bam task/story can reference one or more Beacons. When the task is completed, linked Beacons are flagged for potential re-verification (the work may have changed the landscape).
- **Auto-suggest Beacons in Bam:** When creating a task, the system suggests relevant Beacons based on the task title/description (via semantic search).
- **Epic-level knowledge:** When an epic closes, the system prompts the team to create or update Beacons capturing lessons learned.

### 7.2 Banter Integration

- **Beacon references in Banter:** Beacons can be referenced in any Banter message using the format `BEACON-{short_id}` (first 8 characters of the Beacon UUID, e.g., `BEACON-a1b2c3d4`). Banter renders these as rich unfurls showing the Beacon title, summary, status badge, and freshness indicator — clickable to open the Beacon detail view. This enables discussions about specific Beacons to happen naturally in Banter while the Beacon itself hosts its own inline comment threads.
- **Beacon bot:** A Banter bot (`@beacon`) that responds to queries inline in conversation threads. Users can ask `@beacon what's our staging deploy process?` and get results.
- **Thread-to-Beacon:** A Banter action ("Save as Beacon") that extracts a conversation thread into a draft Beacon, pre-populated with content distilled from the thread by an agent.
- **Notification delivery:** All Beacon lifecycle notifications route through Banter DMs.

---

## 8. Permissions Model

Beacon inherits the BigBlueBam role hierarchy. **Agents and humans share the same permissions table** — an agent assigned a given role has exactly the same capabilities as a human at that role. The `is_agent` flag on the user record is used for audit tagging and behavioral configuration (confidence thresholds, rate limits), never for permission grants or restrictions.

| Capability | SuperUser | Org Admin | Org Owner | Project Admin | Project Member |
|---|---|---|---|---|---|
| Set system-level expiry policy | ✅ | ❌ | ❌ | ❌ | ❌ |
| Set org-level expiry policy | ✅ | ✅ | ✅ | ❌ | ❌ |
| Set project-level expiry policy | ✅ | ✅ | ✅ | ✅ | ❌ |
| Create Beacon | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit own Beacon | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit any Beacon in scope | ✅ | ✅ | ✅ | ✅ | ❌ |
| Verify own Beacon | ✅ | ✅ | ✅ | ✅ | ✅ |
| Verify any Beacon in scope | ✅ | ✅ | ✅ | ✅ | ❌ |
| Challenge Beacon | ✅ | ✅ | ✅ | ✅ | ✅ |
| Comment on Beacon | ✅ | ✅ | ✅ | ✅ | ✅ |
| Delete any comment in scope | ✅ | ✅ | ✅ | ✅ | ❌ |
| Upload attachment | ✅ | ✅ | ✅ | ✅ | ❌ |
| Retire Beacon | ✅ | ✅ | ✅ | ✅ | ❌ |
| Register/manage agents | ✅ | ✅ | ✅ | ❌ | ❌ |

An agent assigned `ProjectMember` on a given project can create, edit its own, verify its own, and challenge — identical to a human `ProjectMember`. An agent assigned `ProjectAdmin` can additionally edit any Beacon in scope, verify any, retire, and set project-level policy. No special agent permission logic exists.

---

## 9. Embedding & Model Considerations

### 9.1 Embedding Model

For the dense vector embeddings, recommended models (as of 2026-04):

| Model | Dimensions | Notes |
|---|---|---|
| `voyage-3-large` | 1024 | Best-in-class retrieval quality. API-based. |
| `text-embedding-3-large` (OpenAI) | 3072 (truncatable) | Good quality, truncate to 1024 for storage efficiency. |
| Self-hosted: `nomic-embed-text-v2` | 768 | On-premise option. Slightly lower quality but fully self-hosted. |

The collection schema (§2.2.3) specifies 1024 dimensions; adjust if a different model is selected.

### 9.2 Sparse Embeddings

For the sparse vector component of hybrid search:

- **SPLADE** (via Qdrant's built-in support or self-hosted): Learned sparse representations that outperform raw BM25.
- **Fallback:** Qdrant's built-in BM25-based sparse encoding if SPLADE overhead is prohibitive.

### 9.3 Re-ranking

Stage 2 re-ranking (§2.2.6) uses a cross-encoder model:

- `cross-encoder/ms-marco-MiniLM-L-12-v2` — lightweight, fast, good quality.
- Or delegate re-ranking to Claude (Haiku) for higher quality at the cost of latency and token spend.

**Freshness decay** is applied as a post-cross-encoder multiplier (see §2.2.6 Stage 2). Beacons verified recently receive a small boost relative to Beacons approaching expiry. The decay is continuous and capped at a 15% penalty — enough to break ties in favor of fresher content without overwhelming strong semantic matches.

---

## 10. Future Work

| Priority | Item | Notes |
|---|---|---|
| **P0** | Collaborative graph exploration — multiple users seeing each other's cursors/focus in the Knowledge Graph Explorer in real time via WebSocket. | Near-term follow-up. |
| **P1** | Public Beacons — exposing select Beacons as a customer-facing knowledge base. | Ties directly into Helpdesk. |
| **P1** | Scheduled saved queries — run nightly, post results to a Banter channel. | |
| **P2** | Multi-language support (i18n) — translate Beacons automatically for global teams. | |
| **P2** | Beacon analytics — who reads what, how often, bounce rate. Privacy implications to be resolved. | |
| **P2** | Versioned embeddings — managing re-indexing when the embedding model changes. | |

---

## Appendix A: Example System-Level Default Policy

```sql
INSERT INTO beacon_expiry_policies (
    id, scope, organization_id, project_id,
    min_expiry_days, max_expiry_days, default_expiry_days, grace_period_days,
    set_by
) VALUES (
    gen_random_uuid(), 'System', NULL, NULL,
    7, 365, 90, 14,
    :superuser_id
);
```

This establishes: any Beacon across the entire system must expire between 7 and 365 days, defaults to 90 days, and gets a 14-day grace period in PendingReview before auto-archival.
