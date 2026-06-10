-- 0176_bureau_tables.sql
-- Why: Introduces the Bureau spatial-presence product. Bureau makes "who is
--      where in the suite right now" a first-class, queryable datum: every
--      user (and agent) inhabits a typed room on a typed floor, with audio
--      via LiveKit and door/knock semantics enforced by ACLs. High-frequency
--      position lives in Redis; this migration creates the durable tables
--      that hold the layout, the access rules, the audit trail, and the
--      per-org settings. Ten tables total: buildings, floors, rooms,
--      room_acl, bookings, knocks, summons, presence_sessions, settings,
--      and floor_analytics (the daily rollup target for the BullMQ
--      `bureau.analytics.rollup` job — surfaced in Bench but owned here so
--      the rollup writer has a stable, Bureau-scoped destination).
-- Client impact: additive only. No existing column or table is touched. All
--      tables use IF NOT EXISTS so re-runs are no-ops; cascading FKs flow
--      from organizations -> per-org tables, and from bureau_rooms ->
--      room-scoped child tables (acl, bookings, knocks, summons) so that
--      tearing down a room cleans up its ACL/audit rows in one shot.

-- ─── bureau_buildings ──────────────────────────────────────────────────────
-- Optional grouping for floors. Small orgs use a single implicit building;
-- multi-site orgs (and "All-hands" virtual buildings) model cleanly here.
CREATE TABLE IF NOT EXISTS bureau_buildings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name          varchar(120) NOT NULL,
    description   text,
    position      integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    archived_at   timestamptz
);
CREATE INDEX IF NOT EXISTS bureau_buildings_org_idx
    ON bureau_buildings(org_id);

-- ─── bureau_floors ─────────────────────────────────────────────────────────
-- A floor is one navigable map. It owns a geometry document (zones, walls,
-- door points) and an optional background image stored in MinIO. Rooms
-- reference zone ids inside floors.layout.
CREATE TABLE IF NOT EXISTS bureau_floors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    building_id     uuid REFERENCES bureau_buildings(id) ON DELETE SET NULL,
    name            varchar(120) NOT NULL,
    slug            varchar(140) NOT NULL,
    layout          jsonb NOT NULL DEFAULT '{}'::jsonb,
    background_url  text,
    position        integer NOT NULL DEFAULT 0,
    is_default      boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS bureau_floors_org_slug_idx
    ON bureau_floors(org_id, slug);
CREATE INDEX IF NOT EXISTS bureau_floors_building_idx
    ON bureau_floors(building_id);

-- ─── bureau_rooms ──────────────────────────────────────────────────────────
-- A room is an addressable space on a floor. Its `type` drives door semantics
-- (office | huddle | conference | meeting | open | lounge | focus | lobby)
-- and capacity rules. Every room maps 1:1 to a LiveKit room
-- `bureau-room-{id}`. `privacy_default` is the static fallback; live
-- overrides live in Redis (bureau:room:{roomId}:state).
CREATE TABLE IF NOT EXISTS bureau_rooms (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    floor_id         uuid NOT NULL REFERENCES bureau_floors(id) ON DELETE CASCADE,
    name             varchar(120) NOT NULL,
    type             varchar(24) NOT NULL,
    privacy_default  varchar(16) NOT NULL DEFAULT 'open',
    capacity         integer,
    bookable         boolean NOT NULL DEFAULT false,
    zone_id          varchar(64) NOT NULL,
    owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    archived_at      timestamptz
);
CREATE INDEX IF NOT EXISTS bureau_rooms_floor_idx
    ON bureau_rooms(floor_id);
CREATE INDEX IF NOT EXISTS bureau_rooms_owner_idx
    ON bureau_rooms(owner_id);
CREATE INDEX IF NOT EXISTS bureau_rooms_org_idx
    ON bureau_rooms(org_id);

-- ─── bureau_room_acl ───────────────────────────────────────────────────────
-- Walk-in rights for `private` rooms. role: member | manager (manager may
-- change room privacy / kick). Open/knock rooms need no rows here.
CREATE TABLE IF NOT EXISTS bureau_room_acl (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id     uuid NOT NULL REFERENCES bureau_rooms(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        varchar(16) NOT NULL DEFAULT 'member',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bureau_room_acl_uniq
    ON bureau_room_acl(room_id, user_id);

-- ─── bureau_bookings ───────────────────────────────────────────────────────
-- A reservation against a bookable room. The authoritative event lives in
-- Book; this row links the Book event to the Bureau room and caches the
-- window for fast "is this room reserved right now" checks during render.
-- access: open (non-attendees may knock) | locked (attendees only).
CREATE TABLE IF NOT EXISTS bureau_bookings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    room_id         uuid NOT NULL REFERENCES bureau_rooms(id) ON DELETE CASCADE,
    book_event_id   uuid NOT NULL,
    organizer_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           varchar(200) NOT NULL,
    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,
    access          varchar(16) NOT NULL DEFAULT 'open',
    created_at      timestamptz NOT NULL DEFAULT now(),
    cancelled_at    timestamptz
);
CREATE INDEX IF NOT EXISTS bureau_bookings_room_window_idx
    ON bureau_bookings(room_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS bureau_bookings_organizer_idx
    ON bureau_bookings(organizer_id);

-- ─── bureau_knocks ─────────────────────────────────────────────────────────
-- A knock request against a closed office. Resolved by the owner or by
-- timeout. Persisted for audit and "leave a note" follow-up. status:
-- pending | admitted | declined | deferred | timed_out | dnd_blocked.
CREATE TABLE IF NOT EXISTS bureau_knocks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    room_id      uuid NOT NULL REFERENCES bureau_rooms(id) ON DELETE CASCADE,
    visitor_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       varchar(16) NOT NULL DEFAULT 'pending',
    message      text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS bureau_knocks_owner_status_idx
    ON bureau_knocks(owner_id, status);
CREATE INDEX IF NOT EXISTS bureau_knocks_room_idx
    ON bureau_knocks(room_id);

-- ─── bureau_summons ────────────────────────────────────────────────────────
-- Audit record of a teleport ("bring everyone here"). recipients is an
-- array of { userId, eligible, outcome: joined|declined|no_access|granted
-- |timed_out } captured per-recipient. Powers Bench rollups and Bolt
-- automation.
CREATE TABLE IF NOT EXISTS bureau_summons (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    summoner_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_room_id        uuid REFERENCES bureau_rooms(id) ON DELETE SET NULL,
    target_url          text NOT NULL,
    target_app          varchar(24) NOT NULL,
    target_label        varchar(200),
    livekit_room_hint   varchar(96),
    recipients          jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bureau_summons_summoner_idx
    ON bureau_summons(summoner_id);
CREATE INDEX IF NOT EXISTS bureau_summons_org_created_idx
    ON bureau_summons(org_id, created_at DESC);

-- ─── bureau_presence_sessions ──────────────────────────────────────────────
-- Durable record of presence sessions. Live state is in Redis; this table
-- exists for audit and utilization analytics. Written on session open/close
-- and on room changes, NOT on every heartbeat. device: web | pip | desktop
-- | agent.
CREATE TABLE IF NOT EXISTS bureau_presence_sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_agent    boolean NOT NULL DEFAULT false,
    device      varchar(32) NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    ended_at    timestamptz
);
CREATE INDEX IF NOT EXISTS bureau_presence_sessions_user_idx
    ON bureau_presence_sessions(user_id);
CREATE INDEX IF NOT EXISTS bureau_presence_sessions_org_started_idx
    ON bureau_presence_sessions(org_id, started_at DESC);

-- ─── bureau_settings ───────────────────────────────────────────────────────
-- Per-org Bureau configuration: feature flags and defaults.
CREATE TABLE IF NOT EXISTS bureau_settings (
    org_id                     uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    continuous_audio           boolean NOT NULL DEFAULT true,
    allow_auto_follow          boolean NOT NULL DEFAULT true,
    free_walk                  boolean NOT NULL DEFAULT false,
    default_office_privacy     varchar(16) NOT NULL DEFAULT 'knock',
    members_can_book           boolean NOT NULL DEFAULT true,
    members_can_create_rooms   boolean NOT NULL DEFAULT false,
    updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- ─── bureau_floor_analytics ────────────────────────────────────────────────
-- Daily per-floor utilization rollup. Owns the destination for the BullMQ
-- `bureau.analytics.rollup` job (§13 in the design doc): one row per
-- (floor, day) with summon counts, peak occupancy, and average occupancy
-- by hour-of-day bucket stored as JSONB so the shape can evolve without
-- another migration. Bench dashboards read directly off this table; the
-- raw `bureau_presence_sessions` rows remain the audit-grade source.
CREATE TABLE IF NOT EXISTS bureau_floor_analytics (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    floor_id            uuid NOT NULL REFERENCES bureau_floors(id) ON DELETE CASCADE,
    day                 date NOT NULL,
    peak_occupancy      integer NOT NULL DEFAULT 0,
    summon_count        integer NOT NULL DEFAULT 0,
    knock_count         integer NOT NULL DEFAULT 0,
    booking_count       integer NOT NULL DEFAULT 0,
    avg_occupancy_by_hour jsonb NOT NULL DEFAULT '{}'::jsonb,
    computed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bureau_floor_analytics_floor_day_idx
    ON bureau_floor_analytics(floor_id, day);
CREATE INDEX IF NOT EXISTS bureau_floor_analytics_org_day_idx
    ON bureau_floor_analytics(org_id, day DESC);
