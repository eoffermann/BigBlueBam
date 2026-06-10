# Bureau Design Document

**The spatial presence layer for BigBlueBam.**

Status: Draft v1 (design)
App slot: #15 (joins Bam, Banter, Beacon, Bearing, Bench, Bill, Blank, Blast, Board, Bolt, Bond, Book, Brief, Helpdesk/Bell)
Author: design pass for Eddie Offermann

---

## 1. What Bureau is

Bureau is a virtual office. It gives the org a floor plan you can see and move around in: private offices, huddle rooms, conference rooms, big meeting rooms, open lounges, focus pods. You see where people are. You walk into the rooms that are open. You knock on the ones that aren't. You book the conference room. And critically, Bureau is not a place you go to instead of working. It is a layer that stays open around everything else you do in the suite, so that "who is around right now" and "let's all go look at this together" are one click away no matter which app you happen to be in.

The headline feature is teleport. When you are standing in a room with people and you navigate (anywhere in the suite) to a Board canvas or a Brief doc or a Bam project, you can hit **Bring everyone here** in the floating Bureau box. Everyone in the room who has access to that resource gets pulled to it. If you have continuous audio on, the call doesn't even drop. They just look up and they're looking at your document, still talking.

This is a first-class BigBlueBam app that knows about every other app in the suite.

### Why "Bureau"

It literally means office, it is one word, it sits comfortably next to Beacon, Bearing, and Belong in the naming convention, and it does not collide with any existing product. (Runner-up was Bay, which is friendlier but reads more "open-plan workspace" than "the building you walk around in." I went with the building.)

---

## 2. The one constraint that shapes everything

Your apps are separate React SPAs served by a single nginx, navigated by path (`/board/`, `/banter/`, `/brief/`, and so on). Navigating from one app to another is a full document load. A React component mounted inside the Board SPA is gone the instant the user clicks through to Banter.

That means the floating overlay cannot be "a React component that follows you." It would be torn down on every navigation. So the design inverts the usual assumption:

**The presence session is server-side state. The floating box is a disposable view over it.**

A user's spatial presence (which floor, which room, what status, what they are currently looking at) lives in Redis, keyed to the user and device, refreshed by a heartbeat. Every render target (desktop window, picture-in-picture window, docked panel) is a thin client that reconnects to that session over WebSocket and re-paints. When the Board SPA unloads and the Banter SPA loads, the docked panel re-mounts, reconnects, and resumes the exact same session in well under a second. The user never sees a gap because the truth was never in the page.

This is also what makes teleport possible across apps: every app reports the user's current location to the same server-side session, so Bureau always knows where everyone is, regardless of which SPA they happen to be inside.

---

## 3. Where Bureau sits in the suite

Bureau is deliberately thin on infrastructure it does not own. It composes existing pieces.

| Capability | Owner | How Bureau uses it |
|---|---|---|
| Voice / video transport | LiveKit SFU (`:7880`), `packages/livekit-tokens/` | Each spatial room maps to a LiveKit room. Bureau mints scoped tokens via the existing package. |
| Presence primitive | Banter (`banter_set_presence`) | Bureau publishes a richer spatial status and keeps it in sync with the shared `user.presence` event so Banter and Bam still see online/idle/dnd. |
| Calls inside a doc | Board (`board-{id}` room), Brief (`brief-{id}` room) | On teleport, Bureau hands off (or extends) the call into the destination app's native LiveKit room. See §9. |
| Scheduling / availability | Book (`:4012`) | Conference-room bookings are Book events. Bureau stores only the room link and reservation window; Book owns conflict detection and reminders. |
| Automation | Bolt (`publishBoltEvent`, event catalog) | Bureau emits presence/knock/booking/summon events so rules can fire on them. |
| Deep links | The existing `*.url` convention on Bolt event payloads | Teleport targets are canonical resource URLs, the same ones Bolt rules already build. |
| Agent identity | Platform users + `voice-agent` (Python, LiveKit Agents SDK) | Agents are first-class occupants with the same presence records and permissions as humans. |
| AI tooling | MCP server (`:3001`) | ~17 `bureau_*` tools join the registry, pushing the suite past 350 tools. |

Bureau's own new infrastructure is small: one Fastify service, one set of `bureau_` tables, a Redis presence model, and a tiny client SDK embedded in every SPA.

---

## 4. Product and UX

### 4.1 The floor view (standalone app, `/bureau/`)

```
+------------------------------------------------------------------+
|  BUREAU   3rd Floor / Engineering              [ Available  v ]  |
+------------------------------------------------------------------+
|                                                                  |
|  +-----------+  +-----------+    +-----------------------------+  |
|  | Eddie     |  | Teeny     |    |  War Room (conf, cap 8)     |  |
|  | (office)  |  | (office)  |    |  * RESERVED 2-3p  Standup   |  |
|  |  [ DND ]  |  |  ( o )    |    |  (o)(o)(A)   3 inside       |  |
|  +-----------+  +-----------+    +-----------------------------+  |
|                                                                  |
|  +--------------------+   +-----------+   +-------------------+   |
|  | Huddle A           |   | Focus Pod |   | Lounge (open)     |   |
|  | (o)(o)  2 inside   |   | [private] |   | (o)         (o)   |   |
|  +--------------------+   +-----------+   +-------------------+   |
|                                                                  |
|  Floors:  [Eng 3F]  [Design 2F]  [All-hands]  [+ add floor]      |
+------------------------------------------------------------------+
   (o) = person avatar    (A) = agent avatar
```

Rooms are zones with a type, a capacity, and a privacy default. People appear as avatars inside the room they are in. Clicking an open room enters it (joins audio). Clicking a closed office prompts a knock. Hovering a person shows their status and what they are currently looking at, if they have shared that.

For v1, movement is room-centric: you click a room to enter it, the way you "went to" a place in the product you described. Free-walk avatars with proximity-based audio falloff in open zones are a distant stretch goal, not a near-term target. They come (if ever) only after everything else we'd want is already built. Room-centric is the right model regardless because it matches the mental model and keeps the audio routing trivial (room = LiveKit room).

### 4.2 The floating box (the overlay)

This is the piece that stays open around everything else. It is small, always-on-top, and shows: the room you are in, who else is in it, what you are currently looking at, and the controls.

```
+--------------------------------+
|  BUREAU             _  [ ]  x  |   <- always-on-top mini window
+--------------------------------+
|  In: War Room                  |
|   (o) Eddie  (o) Teeny  (A) Ada|
+--------------------------------+
|  Viewing: "Q3 Roadmap" (Board) |
|     [  Bring everyone here  ]  |
+--------------------------------+
|  [mic] [cam] [screen] [ door ] |
+--------------------------------+
```

"Viewing" is filled in by whichever SPA you are in, reported to the server session. "Bring everyone here" is enabled only when you are looking at something teleportable that you have the right to share.

### 4.3 Knock flow

```
Visitor clicks a closed office
   -> "Knock on Eddie's door?"   [ Knock ]  [ Cancel ]

Owner receives (in the floating box and as a notification):
   "Teeny is knocking"           [ Let in ]  [ Not now ]  [ Decline ]
       Let in  -> visitor enters, audio connects both ways
       Not now -> visitor sees "Eddie will be a moment"
       Decline -> visitor sees "Eddie can't talk right now"
       No answer in 30s -> auto "Not now"

If the owner has DND on:
   the knock is never delivered. Visitor immediately sees
   "Eddie is heads-down" and is offered [ Leave a note ] (a Banter DM).
```

Offices have an owner. Only the owner sets their door state (open, knock-to-enter, DND). Conference rooms, huddles, and open spaces are walk-in unless someone inside marks them private, exactly as you described. A reserved conference room shows as reserved during its window and offers "knock to join" to non-attendees.

### 4.4 The summon (teleport) flow

```
Eddie is in the War Room with Teeny and agent Ada.
Eddie navigates to a Board canvas "Q3 Roadmap".
The floating box now shows "Viewing: Q3 Roadmap (Board)".
Eddie clicks [ Bring everyone here ].

Server:
  1. resolves Eddie's current room occupants: [Teeny, Ada, Sam]
  2. checks each one's access to board "Q3 Roadmap"
        Teeny: yes.  Ada: yes.  Sam: NO ACCESS.
  3. pushes a summon to each eligible occupant (Teeny, Ada).
  4. pushes an access report back to Eddie listing who couldn't come.

Eddie receives (only when someone was held back):
  +-------------------------------------------------+
  | 2 people are heading to "Q3 Roadmap"            |
  |                                                 |
  | 1 person in the room doesn't have access:       |
  |   Sam                                           |
  |                                                 |
  |   [ Grant access & bring them ]   [ Dismiss ]   |
  +-------------------------------------------------+
  Grant   -> Bureau calls Board's share API to add Sam as a
             collaborator (only offered if Eddie can share the
             board), then summons just Sam.
  Dismiss -> Eddie noted it; Sam is never pulled and never told.
  If Eddie can't share -> the button reads [ Open sharing ]
             and deep-links to the board's share settings instead.

Teeny receives (consent-by-default):
  +------------------------------------------+
  | Eddie pulled the War Room to             |
  |   "Q3 Roadmap"  (Board)                  |
  |   Ada is heading there too               |
  |        [ Join ]      [ Stay here ]       |
  +------------------------------------------+

  Join -> Teeny's SPA navigates to the board. If continuous audio
          is on, the War Room call extends into the board's room and
          never drops. Otherwise Teeny rejoins audio on arrival.
  Stay -> Teeny stays put; Bureau notes a declined summon.

If Teeny has opted into "auto-follow this room", she is navigated
automatically with a 3s "going to Q3 Roadmap... [cancel]" countdown.
```

The consent model is a genuine product decision and I made a call: consent-by-default, with an opt-in auto-follow toggle per room. Your original description was "automatically migrate them," which auto-follow gives you, but forcing a navigation on someone mid-keystroke is hostile, so the safe default is a one-click pull. This is a fork you can flip (see §18).

The access boundary cuts in two directions, and both matter. A summon never navigates someone to a resource they cannot see, and the people who lack access are never notified, so the summon never reveals the resource to someone who can't open it. But the summoner is not kept in the dark: you are already standing in the document, so telling you that Sam isn't on it leaks nothing you don't already know, and it's exactly the information you need to decide whether to share the doc or to realize Sam wasn't supposed to be there. So denials are silent to the denied, and explicit to the summoner.

---

## 5. Service architecture

```
                        nginx (single reverse proxy, :80)
   /bureau/        -> bureau SPA (static)
   /bureau/api/    -> bureau-api Fastify        :4015
   /bureau/ws      -> bureau-api WebSocket hub   :4015
                         |
        +----------------+------------------+----------------------+
        |                |                  |                      |
   PostgreSQL 16     Redis 7            LiveKit SFU            Internal HTTP
   bureau_* tables   presence sessions  bureau-room-{id}       to peer APIs
                     pub/sub channels   token mint via         (Board/Brief/Book
                     (bigbluebam:events) packages/livekit-tokens permission checks)
```

- **bureau-api** (Fastify v5, Drizzle ORM, Zod, Node 22). Port 4015. Owns floors, rooms, bookings, knocks, summons, presence aggregation, LiveKit token minting, and the WS hub.
- **bureau SPA** (React 19, TanStack Query, Zustand, Radix UI, Motion). Two surfaces: the full floor view, and the floating box (which is the same codebase rendered in a compact layout).
- **@bigbluebam/bureau-client** (new shared package). The thin SDK embedded in every other SPA. Reports location, renders the docked floating box, handles incoming summons and knocks. About 1500 lines.
- **Redis** holds all live position state and pub/sub, on the existing `bigbluebam:events` fan-out plus Bureau-specific channels.
- **LiveKit** is reused as-is. No new media infrastructure.
- **Worker** (BullMQ) gains a handful of Bureau jobs (§13).

Migration tip is at 0140, so Bureau lands at `0141_bureau_tables.sql` and up, additive and idempotent per house style.

### 5.1 The three render targets, one session

| Target | Always-on-top | Install | Notes | Phase |
|---|---|---|---|---|
| **Document Picture-in-Picture** | Yes (OS-level) | None | `documentPictureInPicture.requestWindow()` pops the floating box into a real always-on-top window from the browser. Chromium-based browsers. This is the no-install magic. | v1 |
| **Docked panel** | No (in-page) | None | Fallback for browsers without Document PiP. Re-mounts on each SPA navigation, resumes the server session. | v1 |
| **Tauri desktop companion** | Yes (OS-level) | Small app | Frameless always-on-top window. Works across browser tabs and even when the user is outside the suite entirely. Rust core, light footprint, friendly to self-hosting. | v2 |

All three are views over the same Redis-backed session and the same WS stream. Building the session correctly in v1 is what makes Tauri a packaging exercise later rather than a rebuild.

---

## 6. Data model (PostgreSQL 16 / Drizzle ORM)

Live, high-frequency position state lives in Redis (§7). PostgreSQL holds the durable definitions and the audit trail. All tables carry `org_id` and follow the suite's soft-delete and timestamp conventions.

```typescript
// apps/bureau-api/src/db/schema/bureau.ts
import {
  pgTable, uuid, varchar, text, integer, boolean,
  jsonb, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "@bigbluebam/db/schema"; // shared refs

/**
 * A building groups floors. Optional: small orgs use a single implicit
 * building. Present so multi-site orgs (and "All-hands" virtual buildings)
 * model cleanly.
 */
export const bureauBuildings = pgTable("bureau_buildings", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => ({
  orgIdx: index("bureau_buildings_org_idx").on(t.orgId),
}));

/**
 * A floor is one navigable map. It owns a geometry document (zones, walls,
 * door points) and an optional background image stored in MinIO.
 */
export const bureauFloors = pgTable("bureau_floors", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  buildingId: uuid("building_id").references(() => bureauBuildings.id),
  name: varchar("name", { length: 120 }).notNull(),
  slug: varchar("slug", { length: 140 }).notNull(),
  // Structured layout: { width, height, zones:[...], walls:[...] }.
  // Authored by the floor editor (§16). Rooms reference zone ids here.
  layout: jsonb("layout").notNull().default({}),
  backgroundUrl: text("background_url"), // optional MinIO image underlay
  position: integer("position").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => ({
  orgSlug: uniqueIndex("bureau_floors_org_slug_idx").on(t.orgId, t.slug),
}));

/**
 * A room is an addressable space on a floor. Its type drives door semantics
 * and capacity rules. Every room maps 1:1 to a LiveKit room named
 * `bureau-room-{id}`.
 */
export const bureauRooms = pgTable("bureau_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  floorId: uuid("floor_id").notNull().references(() => bureauFloors.id),
  name: varchar("name", { length: 120 }).notNull(),
  // office | huddle | conference | meeting | open | lounge | focus | lobby
  type: varchar("type", { length: 24 }).notNull(),
  // open | knock | private  -- the DEFAULT privacy; live overrides in Redis
  privacyDefault: varchar("privacy_default", { length: 16 }).notNull().default("open"),
  capacity: integer("capacity"), // null = unbounded (open spaces)
  bookable: boolean("bookable").notNull().default(false), // conference/meeting
  // zone id within floors.layout that this room occupies
  zoneId: varchar("zone_id", { length: 64 }).notNull(),
  // For offices: the owning user. Null for shared rooms.
  ownerId: uuid("owner_id").references(() => users.id),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => ({
  floorIdx: index("bureau_rooms_floor_idx").on(t.floorId),
  ownerIdx: index("bureau_rooms_owner_idx").on(t.ownerId),
}));

/**
 * Access control list for private rooms. Membership in this list grants
 * walk-in rights to a room whose privacy is `private`. Open/knock rooms
 * do not need rows here.
 */
export const bureauRoomAcl = pgTable("bureau_room_acl", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id").notNull().references(() => bureauRooms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  // member | manager   (manager can change room privacy / kick)
  role: varchar("role", { length: 16 }).notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("bureau_room_acl_uniq").on(t.roomId, t.userId),
}));

/**
 * A reservation of a bookable room. The authoritative event lives in Book;
 * this row links the Book event to the Bureau room and caches the window
 * for fast "is this room reserved right now" checks during floor render.
 */
export const bureauBookings = pgTable("bureau_bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  roomId: uuid("room_id").notNull().references(() => bureauRooms.id),
  bookEventId: uuid("book_event_id").notNull(), // FK into Book, validated via API
  organizerId: uuid("organizer_id").notNull().references(() => users.id),
  title: varchar("title", { length: 200 }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  // open (non-attendees may knock) | locked (attendees only)
  access: varchar("access", { length: 16 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (t) => ({
  roomWindow: index("bureau_bookings_room_window_idx").on(t.roomId, t.startsAt, t.endsAt),
}));

/**
 * A knock request against a closed office. Resolved by the owner or by
 * timeout. Persisted for audit and for "leave a note" follow-up.
 */
export const bureauKnocks = pgTable("bureau_knocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  roomId: uuid("room_id").notNull().references(() => bureauRooms.id),
  visitorId: uuid("visitor_id").notNull().references(() => users.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  // pending | admitted | declined | deferred | timed_out | dnd_blocked
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  message: text("message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => ({
  ownerPending: index("bureau_knocks_owner_status_idx").on(t.ownerId, t.status),
}));

/**
 * The audit record of a summon ("bring everyone here"). One row per summon,
 * with the per-recipient outcome captured in `recipients`. Lets Bench report
 * on summon usage and gives Bolt a clean event to fire on.
 */
export const bureauSummons = pgTable("bureau_summons", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  summonerId: uuid("summoner_id").notNull().references(() => users.id),
  fromRoomId: uuid("from_room_id").references(() => bureauRooms.id),
  // canonical deep link, e.g. https://host/board/b/{id}
  targetUrl: text("target_url").notNull(),
  targetApp: varchar("target_app", { length: 24 }).notNull(),   // board|brief|bam...
  targetLabel: varchar("target_label", { length: 200 }),
  livekitRoomHint: varchar("livekit_room_hint", { length: 96 }), // continuous-audio
  // [{ userId, eligible, outcome: joined|declined|no_access|granted|timed_out }]
  recipients: jsonb("recipients").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  summonerIdx: index("bureau_summons_summoner_idx").on(t.summonerId),
}));

/**
 * A durable record of presence sessions. Live state is in Redis; this table
 * exists for audit (agents and humans alike) and for utilization analytics.
 * Written on session open/close and on room changes, not on every heartbeat.
 */
export const bureauPresenceSessions = pgTable("bureau_presence_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  isAgent: boolean("is_agent").notNull().default(false),
  device: varchar("device", { length: 32 }).notNull(), // web|pip|desktop|agent
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => ({
  userIdx: index("bureau_presence_sessions_user_idx").on(t.userId),
}));

/**
 * Per-org Bureau configuration: feature flags and defaults.
 */
export const bureauSettings = pgTable("bureau_settings", {
  orgId: uuid("org_id").primaryKey().references(() => organizations.id),
  continuousAudio: boolean("continuous_audio").notNull().default(true),
  allowAutoFollow: boolean("allow_auto_follow").notNull().default(true),
  freeWalk: boolean("free_walk").notNull().default(false), // far-future stretch; off
  defaultOfficePrivacy: varchar("default_office_privacy", { length: 16 })
    .notNull().default("knock"),
  membersCanBook: boolean("members_can_book").notNull().default(true),
  membersCanCreateRooms: boolean("members_can_create_rooms").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Ten tables, all additive. Nothing here duplicates a concern another app owns: bookings point at Book, audio points at LiveKit, deep links reuse the existing convention.

---

## 7. Redis presence model (live state)

Position is too hot for PostgreSQL. It lives in Redis with TTLs refreshed by heartbeat, and changes fan out over pub/sub on the shared `bigbluebam:events` channel plus Bureau-specific channels.

```
# Per active session (a user may have several: web + pip + desktop)
bureau:sess:{sessionId}        HASH  { userId, isAgent, orgId, floorId,
                                       roomId, status, statusText, emoji,
                                       locationUrl, locationApp, locationLabel,
                                       device, lastBeat }
                               TTL 35s, refreshed on each heartbeat (every 15s)

bureau:user:{userId}:sessions  SET   { sessionId, ... }        # device fan-in

# Per room: who is currently inside (union across a user's sessions)
bureau:room:{roomId}:occupants SET   { userId, ... }

# Live privacy/lock override on a room (defaults come from PostgreSQL)
bureau:room:{roomId}:state     HASH  { privacy, lockedBy }     # ephemeral

# Per floor: cached render set for fast initial paint
bureau:floor:{floorId}:index   HASH  { userId -> roomId }
```

Pub/sub channels:

```
bureau:floor:{floorId}     presence deltas (enter/leave/status/location)
bureau:room:{roomId}       room-scoped events (enter/leave/door/lock)
user:{userId}              targeted events (incoming knock, incoming summon)
bigbluebam:events          mirror of user.presence so Banter/Bam stay in sync
```

A reaper job (§13) sweeps sessions whose `lastBeat` has lapsed and emits the corresponding leave events, so a hard browser close cleans up within one heartbeat window.

---

## 8. Real-time protocol (WebSocket, `/bureau/ws`)

Raw WebSocket with Redis PubSub, matching the house pattern (Bam, Banter, Board, Brief all do this). Authenticated by the shared session cookie on connect, exactly like the other hubs.

**Client to server**

| Message | Payload | Effect |
|---|---|---|
| `subscribe_floor` | `{ floorId }` | Subscribe to a floor's presence stream, get a snapshot back. |
| `enter_room` | `{ roomId }` | Move into a room (privacy checked). Mints a LiveKit token. |
| `leave_room` | `{}` | Leave current room. |
| `heartbeat` | `{}` | Refresh session TTL (every 15s). |
| `set_status` | `{ status, statusText?, emoji? }` | available\|busy\|dnd\|focus\|away\|in_meeting. |
| `set_door` | `{ roomId, privacy }` | Owner sets office door, or room manager sets private/open. |
| `lock_room` | `{ roomId, locked }` | Anyone inside a shared room can lock/unlock it private. |
| `knock` | `{ roomId, message? }` | Knock on a closed office. |
| `knock_respond` | `{ knockId, decision }` | admit\|defer\|decline. |
| `location_update` | `{ url, app, label }` | Reported by the bureau-client SDK in every SPA. |
| `summon` | `{ targetUrl, app, label, lkRoomHint? }` | Bring everyone in my room here. |
| `summon_respond` | `{ summonId, decision }` | join\|stay. |
| `summon_grant_access` | `{ summonId, userIds }` | Grant the listed users access to the target (calls the destination app's share API), then summon just them. Requires the summoner to have share rights on the target. |

**Server to client**

| Message | Payload |
|---|---|
| `presence_snapshot` | Full floor occupancy on subscribe. |
| `presence_delta` | `{ userId, roomId?, status?, location? }` |
| `room_enter` / `room_leave` | `{ roomId, userId }` |
| `door_changed` / `room_locked` | `{ roomId, privacy/locked, by }` |
| `livekit_token` | `{ roomName, token, url }` (on entering a room) |
| `knock_incoming` | `{ knockId, visitor, roomId }` (to office owner) |
| `knock_resolved` | `{ knockId, decision }` (to visitor) |
| `summon_incoming` | `{ summonId, summoner, targetUrl, app, label, lkRoomHint?, autoFollow }` |
| `summon_access_report` | `{ summonId, denied: [{ userId, name }], canShare }` (to the summoner, only when someone was held back; `canShare` decides whether the dialog offers "Grant access" or "Open sharing") |
| `summon_progress` | `{ summonId, joined: n, total: m }` |
| `status_changed` | `{ userId, status }` |

---

## 9. LiveKit integration and the continuous-audio handoff

Each spatial room maps to a LiveKit room `bureau-room-{roomId}`. Entering a room mints a token (via `packages/livekit-tokens/`) and joins; leaving disconnects. Mute-by-default, matching Board's convention. Agents join the same way through the `voice-agent` service.

The interesting part is teleport. Board already auto-joins `board-{boardId}` and Brief auto-joins `brief-{docId}` on open. So there are two handoff strategies:

**Strategy A (simple, app-autonomous).** On summon, recipients navigate to the destination. The destination app joins its own native LiveKit room. The Bureau room call ends for them. There is a brief audio gap during the transition. Works everywhere with zero changes to other apps.

**Strategy B (continuous audio, recommended).** The summon payload carries a `lkRoomHint` equal to the originating `bureau-room-{roomId}`. The destination app, if it understands the hint, joins *that* room instead of its default. The call never drops. People keep talking; only what they are looking at changes. This requires Board and Brief to honor an `lkRoom` query parameter (or summon-context value) and to fall back to their default room when absent. It is a small change to two apps that already do LiveKit auto-join, and it delivers the exact effect you described ("migrate them to your doc" with the conversation intact).

I recommend Strategy B for Board and Brief, with Strategy A as the universal fallback for every other destination. The `continuousAudio` org setting gates it.

```
Summon contract (server -> recipient -> destination app):

  summon_incoming { targetUrl: "https://host/board/b/Q3R...",
                    lkRoomHint: "bureau-room-7f3a..." }

  recipient navigates to: targetUrl + "?lkRoom=bureau-room-7f3a..."

  Board reads lkRoom on mount:
    if present and valid -> join that room (continuous)
    else                 -> join board-{boardId} (default)
```

---

## 10. The teleport (summon) system in detail

This is the headline, so it gets its own section.

1. **Trigger.** Summoner clicks "Bring everyone here" (UI), or an agent calls `bureau_summon` (MCP). The summoner's current `locationUrl/app/label` come from the server session (reported by the SDK), so the summoner does not pass the target by hand in the UI case.
2. **Resolve occupants.** Read `bureau:room:{roomId}:occupants` for the summoner's current room. Exclude the summoner.
3. **Access filter.** For each occupant, call the destination app's internal permission check over internal HTTP (the same internal-call pattern MCP tools already use to reach peer APIs). Board exposes "can user X read board Y," Brief the same for docs, Bam for projects, and so on. Occupants without access are recorded as `no_access`. They are not navigated and not notified, so the summon never reveals the resource to someone who cannot open it. The denial is private to the denied, not to the summoner (step 4a).
4. **Fan out.** Push `summon_incoming` to each eligible occupant's `user:{id}` channel. If the room is large, offload the fan-out to the `bureau.summon.fanout` worker job so the WS handler stays snappy.
4a. **Report denials to the summoner.** If any occupant was held back, push `summon_access_report` to the summoner with the denied users (by name) and a `canShare` flag derived from the summoner's own rights on the target. The client renders the dialog in §4.4. If the summoner has share rights, the dialog offers "Grant access & bring them," which sends `summon_grant_access`; Bureau then calls the destination app's share/collaborator API for those users and issues a follow-up summon to just them. If the summoner lacks share rights, the dialog instead deep-links to the target's sharing settings. Either way nothing is pushed to the denied users until they actually have access.
5. **Consent.** Recipients without auto-follow see Join/Stay. Recipients who opted into auto-follow for this room get a 3-second cancelable auto-navigate. The `allowAutoFollow` org setting can disable auto-follow entirely.
6. **Navigate.** Joining navigates the recipient's active SPA to `targetUrl` (with `?lkRoom=` if continuous audio). The bureau-client SDK performs the navigation so it works regardless of which app the recipient is currently in.
7. **Audit and automate.** Write the `bureau_summons` row with per-recipient outcomes (including `no_access` and any later `granted` transitions). Emit `bureau.summon.issued` to Bolt. Update `summon_progress` to the summoner as recipients join.

Edge cases handled explicitly: summoner has no current room (summon disabled), target is not teleportable (no canonical URL), recipient is mid-call in a booked meeting (summon queued as a notification rather than a navigate, so we never yank someone out of a scheduled meeting), recipient is an agent (navigation is a no-op but the agent's session location updates so it "follows" logically and can act on the new resource).

---

## 11. The bureau-client SDK (`@bigbluebam/bureau-client`)

A small package every other SPA imports and mounts once. Responsibilities:

- Open and maintain the WS connection to `/bureau/ws`, with reconnect/resume.
- Report `location_update` whenever the host app's route or focused resource changes, using the canonical `*.url` for the current resource.
- Render the docked floating box (or hand off to Document PiP / desktop when present).
- Receive `knock_incoming` and `summon_incoming` and surface them as the toast/controls shown in §4.
- Perform navigations on the host app's behalf when a summon is accepted.

Each host app provides a tiny adapter telling the SDK how to describe its current resource:

```typescript
// In the Board SPA, for example:
import { mountBureauClient } from "@bigbluebam/bureau-client";

mountBureauClient({
  describeLocation: (route) => ({
    url: canonicalBoardUrl(route.boardId),   // reuse the *.url convention
    app: "board",
    label: route.boardTitle,
    // tells Bureau this destination supports continuous audio:
    livekitRoom: route.boardId ? `bureau-room` : undefined,
  }),
  navigate: (url) => router.push(stripOrigin(url)),
});
```

This is the only change required in each existing SPA: import, mount, provide an adapter. Board and Brief additionally read the `?lkRoom=` hint for continuous audio.

---

## 12. REST API catalog (`/bureau/api/`)

```
# Floors & rooms (read: any member; write: admin or per settings)
GET    /floors                       list floors (with live occupancy counts)
GET    /floors/:id                   floor layout + current occupancy
POST   /floors                       create floor                 [admin]
PATCH  /floors/:id                   update floor / layout        [admin]
POST   /floors/:id/background        upload backdrop image (MinIO)[admin]
DELETE /floors/:id                   archive floor                [admin]

GET    /rooms/:id                    room detail + occupants
POST   /rooms                        create room                  [admin|setting]
PATCH  /rooms/:id                    update room                  [admin|owner]
DELETE /rooms/:id                    archive room                 [admin]
POST   /rooms/:id/acl                add/update ACL entry         [admin|manager]
DELETE /rooms/:id/acl/:userId        remove ACL entry             [admin|manager]
PATCH  /rooms/:id/door               set door/privacy             [owner|manager]

# Offices
POST   /offices/assign               assign an office to a user   [admin]
GET    /offices/mine                 my office (if any)

# Bookings (delegates conflict logic to Book)
GET    /rooms/:id/bookings           reservations for a room (window query)
POST   /rooms/:id/bookings           reserve a room (creates a Book event)
PATCH  /bookings/:id                 update a reservation
DELETE /bookings/:id                 cancel a reservation

# Knocks
POST   /knocks                       knock on an office
PATCH  /knocks/:id                   respond (admit|defer|decline)
GET    /knocks/inbox                 my pending knocks (owner)

# Presence & summon (most live traffic is on WS; these are REST mirrors)
GET    /presence                     org presence snapshot (access-filtered)
GET    /presence/locate?user=:id     where is this user
POST   /summon                       bring-everyone-here (REST mirror of WS)
GET    /summons/:id                  summon outcome (audit)

# LiveKit
POST   /rooms/:id/token              mint a scoped LiveKit token

# Settings
GET    /settings                     org Bureau settings
PATCH  /settings                     update settings              [admin]
```

All write routes carry the org-role and scope guards already standardized across the suite (the same middleware family as `requireChannelMember` and friends in Banter). Validation via Zod schemas exported from `packages/shared`.

---

## 13. BullMQ jobs (worker)

| Job | Trigger | Work |
|---|---|---|
| `bureau.presence.reap` | repeat every 15s | Sweep sessions whose `lastBeat` lapsed; emit `room_leave` + `presence_delta`; close the `bureau_presence_sessions` row. |
| `bureau.summon.fanout` | on large-room summon | Run access checks and push `summon_incoming` to N recipients off the WS hot path; update `summon_progress`. |
| `bureau.knock.timeout` | on knock create (delayed 30s) | If still pending, resolve as `timed_out`, notify visitor. |
| `bureau.booking.activate` | scheduled at booking start | Mark room reserved in Redis state; optionally pre-spin the LiveKit room. |
| `bureau.booking.release` | scheduled at booking end | Clear reserved state; broadcast `door_changed`. |
| `bureau.booking.remind` | scheduled (lead time) | Delegate to Book/notification queue so attendees get a nudge with a one-click "enter the War Room" link. |
| `bureau.analytics.rollup` | daily | Room utilization, summon counts, average occupancy by hour, written for Bench dashboards. |

---

## 14. Bolt event catalog additions

Register in `packages/shared/src/bolt-events/` and emit via `publishBoltEvent`. Each payload carries the standard enriched `actor` object and a `*.url` where one exists, per the ID-mapping strategy.

```
bureau.user.entered_room   { actor, room{id,name,type,url}, floor{id,name} }
bureau.user.left_room      { actor, room{id,name}, durationSeconds }
bureau.status.changed      { actor, status, previousStatus }
bureau.knock.requested     { actor(visitor), owner, room{id,name} }
bureau.knock.resolved      { actor(owner), visitor, room, decision }
bureau.room.booked         { actor, room, booking{id,title,startsAt,endsAt,url} }
bureau.room.locked         { actor, room, locked }
bureau.summon.issued       { actor(summoner), fromRoom, target{url,app,label},
                             recipients:[{userId,outcome}] }
```

These make presence automatable. For example, a rule: "when anyone enters the room named Incident, post in #incident-bridge and page the on-call." Or: "when the War Room is booked, create a Brief doc from the meeting-notes template and attach it to the booking." The compliance-sentinel and coordinated-workflow patterns in your Bolt strategy docs apply directly.

---

## 15. MCP tool registry (`bureau_*`, ~17 tools)

Agents are first-class occupants, so the tool set lets an agent perceive the office, move within it, and act on it under the same permissions as a human. Destructive or socially-significant tools (summon, book, knock) use the existing Redis-backed confirm-token mechanism.

```
# Perception (any authenticated user/agent)
bureau_list_floors          List floors with occupancy counts.
bureau_get_floor            Floor layout + who is in each room.
bureau_who_is_in_room       Occupants of a room (access-filtered).
bureau_locate_user          Which room/floor a user is in, if visible.
bureau_get_presence         Org presence snapshot (access-filtered).

# Self-movement & status (the agent's own avatar)
bureau_move_self            Move the calling agent into a room.
bureau_set_status           Set the calling user's spatial status.
bureau_set_door_state       Set door/privacy on a room you own or manage.

# Social
bureau_knock                Knock on an office (notifies the owner).
bureau_respond_knock        Admit/defer/decline a pending knock.

# Booking (delegates to Book)
bureau_book_room            Reserve a bookable room (confirm token).
bureau_list_bookings        Reservations for a room or for the caller.
bureau_cancel_booking       Cancel a reservation (confirm token).

# Teleport
bureau_summon               Bring everyone in a room to a resource URL.
                            Runs the same access filter as the UI path, and
                            returns the denied list (users who lacked access)
                            so the calling agent can grant access or notify,
                            never silently. (confirm token; high-impact)

# Administration (admin/owner)
bureau_create_floor         Create a floor.
bureau_create_room          Create a room on a floor.
bureau_update_room          Update a room's properties.
```

A concrete agentic flow this enables: a meeting-assistant agent sits in the War Room (`bureau_move_self`), watches for the standup booking to activate, joins the LiveKit room as a participant via the existing voice-agent path, transcribes (Banter's transcript path), and when someone says "let's look at the roadmap," calls `bureau_summon` to pull the room to the Board doc. That is the suite's "agents as peers, not plugins" principle expressed spatially.

---

## 16. Floor authoring, Docker, nginx, migrations

**Floor editor.** A structured zone editor, not a freeform canvas. Rooms are rectangles or polygons with a type, capacity, and door point. I considered reusing Board/Excalidraw, but Board is freeform and rooms need structured semantics (capacity, type, LiveKit binding), so a bespoke editor that writes `floors.layout` JSON is cleaner and smaller. It supports an optional image underlay (a real office photo or a designed map) stored in MinIO, with zones drawn on top. Admin-only, lives at `/bureau/admin/floors/:id`.

**Renderer.** The live floor uses a Canvas2D avatar layer with a React/Radix chrome layer on top (Motion for avatar movement and enter/leave transitions). Canvas2D handles dozens of moving avatars without the DOM thrash that pure SVG would cause at scale; PixiJS is the upgrade path if a floor ever holds hundreds of avatars. Given your shader background this layer is the one place a little GPU polish (soft shadows, presence glow) would pay off, but none of that is on the v1 critical path.

**Docker service.**

```yaml
bureau-api:
  build: { context: ., dockerfile: apps/bureau-api/Dockerfile }
  environment:
    DATABASE_URL: ${DATABASE_URL}
    REDIS_URL: ${REDIS_URL}
    SESSION_SECRET: ${SESSION_SECRET}
    LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
    LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
    LIVEKIT_HOST: ${LIVEKIT_HOST}
    BOOK_INTERNAL_URL: http://book-api:4012
    BOARD_INTERNAL_URL: http://board-api:4008
    BRIEF_INTERNAL_URL: http://brief-api:4005
    INTERNAL_SERVICE_SECRET: ${INTERNAL_SERVICE_SECRET}
  ports: ["4015"]
  depends_on: [postgres, redis, livekit]
```

**nginx.**

```nginx
location /bureau/api/ { proxy_pass http://bureau-api:4015/; }
location /bureau/ws   { proxy_pass http://bureau-api:4015/bureau/ws;
                        proxy_set_header Upgrade $http_upgrade;
                        proxy_set_header Connection "upgrade"; }
location /bureau/     { try_files $uri /bureau/index.html; }
```

**Migrations.** `0141_bureau_tables.sql` (the ten tables), `0142_bureau_seed_demo_floor.sql` (a demo floor with a few offices, a couple of huddles, the War Room, and a lounge, so the empty state is never truly empty). Additive and idempotent, per house rule. Add `bureau-api` to `scripts/deploy/shared/services.mjs` so the Railway manifests regenerate.

---

## 17. Build plan and effort

Following the Board agent-breakdown style. Effort is rough engineering-days for one focused builder; the agents parallelize where dependencies allow.

| # | Agent / workstream | Deliverables | Effort |
|---|---|---|---|
| 1 | DB + Drizzle schema | Migrations 0141-0142, schema files, seed demo floor | 2d |
| 2 | bureau-api core | Floors/rooms/offices/ACL/settings routes + services, auth guards | 4d |
| 3 | Presence + WS hub | Redis session model, WS protocol, reaper job, LiveKit token mint | 5d |
| 4 | Booking integration | Book event create/cancel, reserved-state jobs, reminders | 3d |
| 5 | Knock system | Routes, WS events, timeout job, DND handling, "leave a note" | 2d |
| 6 | **Summon system** | Occupant resolve, access filter, fan-out job, audit, Bolt event | 4d |
| 7 | bureau-client SDK | WS client, location reporting, docked box, summon/knock handling | 5d |
| 8 | Floor view SPA | Canvas2D renderer, floor nav, room enter/leave, audio controls | 6d |
| 9 | Floor editor (admin) | Zone editor, image underlay, room property forms | 4d |
| 10 | Document PiP overlay | PiP window host, compact layout, fallback to docked panel | 3d |
| 11 | Continuous audio | `lkRoom` hint contract, Board + Brief adapters honor it | 2d |
| 12 | MCP tools | ~17 `bureau_*` tools, confirm tokens, internal calls | 3d |
| 13 | Embed SDK in peer SPAs | Mount bureau-client + adapter in each existing app | 2d |
| 14 | Bench rollup + Bolt events | Analytics job, event registration in shared package | 2d |
| 15 | Tests + security audit | Route auth, ACL enforcement, summon access-leak tests, e2e | 4d |

Rough total for a v1 that ships the floor, the overlay, knocks, booking, and summon-with-continuous-audio: on the order of seven to eight focused weeks for one person, less with parallel agents. The Tauri desktop companion is the main v2 item. Free-walk and proximity audio are a far-future stretch, well past everything else worth building.

---

## 18. Decisions I made, and the forks you can flip

Resolved in conversation: the name is **Bureau**; movement is **room-centric**, with free-walk a far-future stretch rather than a roadmap item; and summon denials are **reported to the summoner** (silent to the denied, explicit to you).

Three real product calls remain open where you might still disagree. Each is cheap to flip:

1. **Consent-by-default summon, with opt-in auto-follow.** I default to a one-click Join rather than yanking people's screens. Your original framing was "automatic," which auto-follow gives, but as a default it's hostile. Flip the `allowAutoFollow` default and the per-room default if you want auto the baseline.
2. **Continuous audio via an `lkRoom` hint (Strategy B).** Recommended, but it touches Board and Brief (small changes). Say the word and I drop to Strategy A (simple handoff, brief gap, zero changes to other apps) for v1.
3. **Document PiP first, Tauri in v2.** Web-first ships the always-on-top overlay with no install. If you want the desktop companion as the flagship from day one (true cross-tab, works outside the suite), we promote agent 10 and add a Tauri workstream to v1.

If those three sit right with you, the next artifact is the implementation plan for whichever workstream you want to start with. The natural first cut is agents 1 + 3 (schema and the presence/WS core), because everything else hangs off a working server-side session.

---

## 19. v2 simplification: the unified call model

Sections 1-18 above remain a record of the original v1 design and the choices that shaped it. This section captures the consolidation Bureau went through after the v1 surface stabilized — kept in-doc so the v1 reasoning is still legible alongside the new model rather than overwritten.

### What changed

In v1 each app owned its own LiveKit stack:

- Board mounted its own audio-controls panel, minted tokens via `board-api`, and joined `board-{boardId}` rooms.
- Brief did the same with `brief-api` and `brief-{docId}` rooms (and a continuous-audio widget on top of it).
- Banter had a separate calling pipeline (`banter-api/src/routes/call.routes.ts`) for 1:1 and huddle calls.
- Bureau's docked box maintained its OWN LiveKit connection for the spatial room.

Summons reconciled this jungle by carrying an `lkRoom` query param into the destination URL. The destination SPA's audio code would read `?lkRoom=...` and join that specific room instead of its default, which is how the "continuous audio across teleport" property of §9 actually worked.

The v2 model collapses all of that into one rule:

> **Every user has exactly ONE LiveKit endpoint — the docked box. The room it's connected to is derived from the user's current URL or their current Bureau spatial room.**

The bureau-client SDK ships with `packages/bureau-client/src/active-room.ts` ↦ `ActiveCallManager`, which owns a single `Room` instance per page. It picks its target by priority:

1. **Spatial Bureau room** — if the user has explicitly entered one via the floor view, target `bureau-room-{uuid}` regardless of where they navigate.
2. **Surface huddle** — otherwise, if `describeLocation()` reports `app + surface_id`, target `huddle-{app}-{surface_id}`.
3. **Idle** — otherwise no call. Mic/cam/screen buttons are disabled.

Mic/cam/screen buttons in the docked box flip tracks on the active Room's `localParticipant`; toggling them is a one-liner against `livekit-client` rather than a coordination protocol with whichever app currently "owns" the call.

### What this lets us delete

The per-app LiveKit machinery becomes redundant and is removed across Phase 2:

- `apps/board-api/src/routes/audio.routes.ts` + `apps/board-api/src/services/livekit.service.ts` — gone.
- `apps/brief-api/src/routes/audio.routes.ts` + `apps/brief-api/src/services/livekit.service.ts` — gone.
- `apps/board/src/components/canvas/audio-controls.tsx` + the matching `use-audio.ts` hook — gone.
- `apps/brief/src/components/continuous-audio-widget.tsx` + `use-continuous-audio.ts` — gone.
- Banter's call panel, video grid, transcript view, device dialog, incoming-call overlay, and `useCall` / `useLivekit` / `useDevices` hooks — gone (the docked box's overlay handler does this work universally).

The §9 "continuous-audio handoff" no longer needs a special mode either: in v2 the audio doesn't drop at navigation, because navigation never tore down a per-app LiveKit Room to begin with. The docked box just rebinds its target on the URL change. If the user navigates between two surfaces, the manager mints a new token, disconnects the old Room, and connects to the new one — but that's the same sub-second operation we needed for spatial-vs-spatial switching anyway.

### What ring and summon mean now

The semantics of both immediate-interaction primitives shift:

- **Ring** is no longer "let's start a new huddle call in this surface's room." The huddle room ALREADY exists; the recipient's SDK is either in it (if they're on the surface) or will be the moment they navigate. Ring is now a notification: "pay attention to this surface I'm on." Accept = navigate; navigate triggers the LiveKit join. The explicit `POST /v1/surface-huddle/token` on accept is dropped from the recipient flow — see `packages/bureau-client/src/ring-handler.tsx`.
- **Summon** stops carrying `?lkRoom=` in the destination URL. The SDK on the recipient picks the right room when their location changes (spatial bureau room if they're in one, surface huddle if they aren't). The `livekit_room_hint` field stays on the wire and in `bureau_summons.livekit_room_hint` for audit, but it no longer steers anything client-side.

### The naming contract

`huddle-{surface_app}-{surface_id}` IS the canonical LiveKit room for a content surface in v2. There is no other room name. Two implementations must agree on the derivation:

1. `packages/bureau-client/src/active-room.ts` ↦ `mintToken` (`surface` branch).
2. `apps/bureau-api/src/routes/livekit.routes.ts` ↦ `buildSurfaceHuddleRoomName`.

Any change in one must land in the same commit as the matching change in the other. Symmetric authorization (recipient is actually on the surface) lives in `apps/bureau-api/src/services/surface-presence.service.ts` and stays available as defense-in-depth for future hardening.

### Why this is in §19 instead of overwriting §9 and §11

Two reasons:

1. The v1 model was working and shipped; the v1 sections explain why the staged version exists at all (the cross-app continuous-audio puzzle, the §11 SDK contract, the §9 handoff). Future readers will be better served by reading the original design AND this consolidation than by reading only a flattened version.
2. The deletions in Phase 2 — the audio routes, the Banter call surfaces, the per-app widgets — are reversible in principle if we ever decide we need a per-app LiveKit stack again (say, for a specialized recording or transcription path that the docked box can't host). The original sections describe what that surface looked like the last time we tried it.
