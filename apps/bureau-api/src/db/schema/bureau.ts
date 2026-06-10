/**
 * Bureau Drizzle schema (workstream 1).
 *
 * Mirrors infra/postgres/migrations/0176_bureau_tables.sql exactly. Ten
 * tables in total:
 *   bureau_buildings, bureau_floors, bureau_rooms, bureau_room_acl,
 *   bureau_bookings, bureau_knocks, bureau_summons,
 *   bureau_presence_sessions, bureau_settings, bureau_floor_analytics.
 *
 * Cross-app references (organizations, users) come from @bigbluebam/db-stubs
 * — the same shared package that bond-api/bolt-api/etc. use. Keeping the
 * stub import in one place avoids the bbb-refs.ts drift trap.
 *
 * High-frequency presence (room occupancy, live status, door overrides)
 * lives in Redis (§7 of the design doc); these tables hold only the
 * durable layout, ACLs, audit trail, and per-org settings.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { organizations, users } from '@bigbluebam/db-stubs';

/**
 * A building groups floors. Optional: small orgs use a single implicit
 * building. Present so multi-site orgs (and "All-hands" virtual buildings)
 * model cleanly.
 */
export const bureauBuildings = pgTable(
  'bureau_buildings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('bureau_buildings_org_idx').on(t.org_id)],
);

/**
 * A floor is one navigable map. It owns a geometry document (zones, walls,
 * door points) in `layout` and an optional MinIO image underlay. Rooms
 * reference zone ids stored inside `layout`.
 */
export const bureauFloors = pgTable(
  'bureau_floors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    building_id: uuid('building_id').references(() => bureauBuildings.id, {
      onDelete: 'set null',
    }),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 140 }).notNull(),
    layout: jsonb('layout').default({}).notNull(),
    background_url: text('background_url'),
    position: integer('position').notNull().default(0),
    is_default: boolean('is_default').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('bureau_floors_org_slug_idx').on(t.org_id, t.slug),
    index('bureau_floors_building_idx').on(t.building_id),
  ],
);

/**
 * A room is an addressable space on a floor. `type` drives door semantics
 * and capacity rules. Every room maps 1:1 to a LiveKit room named
 * `bureau-room-{id}`. `privacy_default` is the static fallback; live
 * overrides live in Redis.
 *
 * type:            office | huddle | conference | meeting | open | lounge | focus | lobby
 * privacy_default: open | knock | private
 */
export const bureauRooms = pgTable(
  'bureau_rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    floor_id: uuid('floor_id')
      .notNull()
      .references(() => bureauFloors.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    type: varchar('type', { length: 24 }).notNull(),
    privacy_default: varchar('privacy_default', { length: 16 })
      .notNull()
      .default('open'),
    capacity: integer('capacity'),
    bookable: boolean('bookable').notNull().default(false),
    zone_id: varchar('zone_id', { length: 64 }).notNull(),
    owner_id: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').default({}).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    index('bureau_rooms_floor_idx').on(t.floor_id),
    index('bureau_rooms_owner_idx').on(t.owner_id),
    index('bureau_rooms_org_idx').on(t.org_id),
  ],
);

/**
 * Access control list for private rooms. Membership grants walk-in
 * rights to a room whose privacy is `private`. Open/knock rooms need no
 * rows here. role: member | manager.
 */
export const bureauRoomAcl = pgTable(
  'bureau_room_acl',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    room_id: uuid('room_id')
      .notNull()
      .references(() => bureauRooms.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull().default('member'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('bureau_room_acl_uniq').on(t.room_id, t.user_id)],
);

/**
 * A reservation against a bookable room. The authoritative event lives in
 * Book; this row links the Book event to the Bureau room and caches the
 * window for fast "is this room reserved right now" checks during floor
 * render. access: open (non-attendees may knock) | locked (attendees only).
 */
export const bureauBookings = pgTable(
  'bureau_bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    room_id: uuid('room_id')
      .notNull()
      .references(() => bureauRooms.id, { onDelete: 'cascade' }),
    book_event_id: uuid('book_event_id').notNull(),
    organizer_id: uuid('organizer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 200 }).notNull(),
    starts_at: timestamp('starts_at', { withTimezone: true }).notNull(),
    ends_at: timestamp('ends_at', { withTimezone: true }).notNull(),
    access: varchar('access', { length: 16 }).notNull().default('open'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('bureau_bookings_room_window_idx').on(t.room_id, t.starts_at, t.ends_at),
    index('bureau_bookings_organizer_idx').on(t.organizer_id),
  ],
);

/**
 * A knock request against a closed office. Resolved by the owner or by
 * timeout. Persisted for audit and "leave a note" follow-up.
 * status: pending | admitted | declined | deferred | timed_out | dnd_blocked.
 */
export const bureauKnocks = pgTable(
  'bureau_knocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    room_id: uuid('room_id')
      .notNull()
      .references(() => bureauRooms.id, { onDelete: 'cascade' }),
    visitor_id: uuid('visitor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    owner_id: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    message: text('message'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('bureau_knocks_owner_status_idx').on(t.owner_id, t.status),
    index('bureau_knocks_room_idx').on(t.room_id),
  ],
);

/**
 * Audit record of a teleport ("bring everyone here"). One row per summon;
 * the per-recipient outcome lives in `recipients` as
 *   [{ userId, eligible, outcome: joined|declined|no_access|granted|timed_out }]
 * Gives Bench a clean object to roll up and gives Bolt a clean event to
 * fire on.
 */
export const bureauSummons = pgTable(
  'bureau_summons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    summoner_id: uuid('summoner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    from_room_id: uuid('from_room_id').references(() => bureauRooms.id, {
      onDelete: 'set null',
    }),
    target_url: text('target_url').notNull(),
    target_app: varchar('target_app', { length: 24 }).notNull(),
    target_label: varchar('target_label', { length: 200 }),
    livekit_room_hint: varchar('livekit_room_hint', { length: 96 }),
    recipients: jsonb('recipients').default([]).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('bureau_summons_summoner_idx').on(t.summoner_id),
    index('bureau_summons_org_created_idx').on(t.org_id, t.created_at),
  ],
);

/**
 * Durable record of presence sessions. Live state is in Redis; this table
 * exists for audit and utilization analytics. Written on session open/close
 * and on room changes, NOT on every heartbeat.
 * device: web | pip | desktop | agent.
 */
export const bureauPresenceSessions = pgTable(
  'bureau_presence_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    is_agent: boolean('is_agent').notNull().default(false),
    device: varchar('device', { length: 32 }).notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    ended_at: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('bureau_presence_sessions_user_idx').on(t.user_id),
    index('bureau_presence_sessions_org_started_idx').on(t.org_id, t.started_at),
  ],
);

/**
 * Per-org Bureau configuration. One row per org (org_id is the PK).
 */
export const bureauSettings = pgTable('bureau_settings', {
  org_id: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  continuous_audio: boolean('continuous_audio').notNull().default(true),
  allow_auto_follow: boolean('allow_auto_follow').notNull().default(true),
  free_walk: boolean('free_walk').notNull().default(false),
  default_office_privacy: varchar('default_office_privacy', { length: 16 })
    .notNull()
    .default('knock'),
  members_can_book: boolean('members_can_book').notNull().default(true),
  members_can_create_rooms: boolean('members_can_create_rooms')
    .notNull()
    .default(false),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Daily per-floor utilization rollup. Owns the destination for the
 * BullMQ `bureau.analytics.rollup` job: one row per (floor, day) with
 * summon counts, peak occupancy, and an avg-occupancy-by-hour JSONB
 * histogram so the shape can evolve without a follow-up migration.
 * Bench dashboards read here; `bureau_presence_sessions` stays the
 * audit-grade source of truth.
 */
export const bureauFloorAnalytics = pgTable(
  'bureau_floor_analytics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    floor_id: uuid('floor_id')
      .notNull()
      .references(() => bureauFloors.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    peak_occupancy: integer('peak_occupancy').notNull().default(0),
    summon_count: integer('summon_count').notNull().default(0),
    knock_count: integer('knock_count').notNull().default(0),
    booking_count: integer('booking_count').notNull().default(0),
    avg_occupancy_by_hour: jsonb('avg_occupancy_by_hour').default({}).notNull(),
    computed_at: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('bureau_floor_analytics_floor_day_idx').on(t.floor_id, t.day),
    index('bureau_floor_analytics_org_day_idx').on(t.org_id, t.day),
  ],
);
