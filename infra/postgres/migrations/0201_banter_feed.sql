-- 0201_banter_feed.sql
-- Why: Banter Feed (docs/plans/banter-feed-design-document.md). Introduces the
--   three tables the ranked cross-app feed is built on: banter_feed_subscriptions
--   (the default-on follow/mute hierarchy, §5), banter_feed_entries (the per-user
--   candidate index the fan-in job upserts and the read path ranks, §7.1), and
--   banter_feed_weights (the two-level platform/org tunable weight sets, §7.2).
-- Client impact: additive only — three new tables plus their indexes. No existing
--   table is touched. Idempotent: CREATE TABLE/INDEX IF NOT EXISTS throughout.

-- ---------------------------------------------------------------------------
-- §5.4 banter_feed_subscriptions — the follow/mute hierarchy.
-- Default-on: we store ONLY deviations (unfollowed / muted, plus the rare
-- explicit re-following row that overrides a broader opt-out). Absence of a row
-- means "use the effective default" (following).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banter_feed_subscriptions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type    varchar(16) NOT NULL,   -- 'item' | 'channel' | 'project' | 'source'
    scope_source  varchar(16) NOT NULL,   -- which app: 'banter','bam','brief',...
    scope_id      uuid,                    -- entity/channel/project id; NULL for scope_type='source'
    state         varchar(12) NOT NULL DEFAULT 'following', -- 'following' | 'unfollowed' | 'muted'
    origin        varchar(8)  NOT NULL DEFAULT 'manual',    -- 'manual' | 'auto'
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One explicit row per (user, scope). COALESCE folds NULL scope_id (source-level)
-- onto a sentinel so the unique index treats "the bam source" as a single key.
CREATE UNIQUE INDEX IF NOT EXISTS banter_feed_subs_unique
    ON banter_feed_subscriptions (user_id, scope_type, scope_source, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS banter_feed_subs_lookup
    ON banter_feed_subscriptions (user_id, scope_source, scope_type);

-- ---------------------------------------------------------------------------
-- §7.1 banter_feed_entries — the per-(user, entity) candidate index.
-- One row per (user, entity). The fan-in job inserts on first relevance and
-- thereafter bumps last_activity_at / engagement_count / the flag bitsets.
-- Recency is NOT stored (it decays continuously and is computed at read time).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banter_feed_entries (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category           varchar(48) NOT NULL,     -- §8 taxonomy, e.g. 'banter.channel_post'
    entity_type        varchar(48) NOT NULL,     -- canonical entity_type, e.g. 'brief.document'
    entity_id          uuid NOT NULL,
    root_entity_type   varchar(48),              -- for grouping (thread root, parent task); NULL = self
    root_entity_id     uuid,
    source             varchar(16) NOT NULL,     -- owning app for subscription resolution
    channel_id         uuid,                     -- when applicable (banter); NULL otherwise
    project_id         uuid,                     -- when applicable (bam-linked); NULL otherwise
    published_at       timestamptz NOT NULL,
    last_activity_at   timestamptz NOT NULL,
    relationship_flags integer NOT NULL DEFAULT 0,  -- bitset: assignee, author, watcher, mentioned, commenter, reactor, approver
    interaction_flags  integer NOT NULL DEFAULT 0,  -- bitset of the viewer's own past interactions
    engagement_count   integer NOT NULL DEFAULT 0,  -- denormalized comment+reaction+participant tally
    seen_at            timestamptz,
    dismissed_at       timestamptz,
    seq                bigserial,                -- monotonic for cache keys / cursoring
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS banter_feed_entries_unique
    ON banter_feed_entries (user_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS banter_feed_entries_ranking
    ON banter_feed_entries (user_id, last_activity_at DESC)
    WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS banter_feed_entries_seq
    ON banter_feed_entries (org_id, seq DESC);

-- ---------------------------------------------------------------------------
-- §7.2 banter_feed_weights — two-level (platform/org) tunable weight sets.
-- Effective weights = deepMerge(PLATFORM_DEFAULTS, platformRow, orgRow). version
-- bumps on every write and feeds the read-path Redis cache key so tuning is live.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banter_feed_weights (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope       varchar(8) NOT NULL,          -- 'platform' | 'org'
    org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL for platform
    weights     jsonb NOT NULL,               -- partial or full weight set; org rows hold only overrides
    version     integer NOT NULL DEFAULT 1,   -- bumped on write; feeds the cache key
    updated_by  uuid REFERENCES users(id),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- At most one platform row, and at most one row per org.
CREATE UNIQUE INDEX IF NOT EXISTS banter_feed_weights_platform
    ON banter_feed_weights (scope) WHERE scope = 'platform';
CREATE UNIQUE INDEX IF NOT EXISTS banter_feed_weights_org
    ON banter_feed_weights (org_id) WHERE scope = 'org';
