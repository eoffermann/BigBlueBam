# Bureau — Dossier (code-only)

> Research basis: CODE ONLY. There is no `docs/apps/bureau/` directory and no
> screenshots. Everything below is cited to source files under
> `apps/bureau-api/src` (backend), `apps/bureau/src` (frontend SPA),
> `packages/bureau-client/src` (the cross-app "docked box" SDK),
> `apps/mcp-server/src/tools/bureau-tools.ts` (MCP tools), plus the worker
> jobs and the design plan `docs/plans/bureau-design-document.md`.

---

## 1. App identity

- **App key:** `bureau`
- **Display name:** Bureau
- **Category:** Virtual office & presence
- **Tagline (design doc §1):** "Bureau is a virtual office… a layer that stays
  open around everything else you do in the suite, so that 'who is around right
  now' and 'let's all go look at this together' are one click away no matter
  which app you happen to be in." (`docs/plans/bureau-design-document.md:13`)
- **SPA path:** `/bureau/` (served by nginx; React SPA in `apps/bureau/src`)
- **API path:** `/bureau/api/` → bureau-api Fastify service. REST routes under
  the `/v1` prefix; WS at `/bureau/ws` with no prefix
  (`apps/bureau-api/src/server.ts:126-168`)
- **WebSocket:** `/bureau/ws` (raw upgrade, session-cookie auth at handshake; the
  live presence/door/knock/summon/chat protocol — `apps/bureau-api/src/routes/ws.routes.ts`)
- **Prerequisites:**
  - Must be **logged in to Bam** — Bureau shares Bam's session and reads
    `/b3/api/auth/me` for permissions (`apps/bureau/src/main.tsx:48-52`,
    `apps/bureau/src/App.tsx:123-138`). Unauthenticated users see "Please log in
    to BigBlueBam first" with a "Go to BigBlueBam Login" link.
  - **Org admin / owner / SuperUser** for floor and office administration.
  - **LiveKit** configured and the platform **calling kill switch ON**, or every
    token mint returns `503 CALLING_DISABLED` (`livekit.routes.ts:43-52,112-113`).
  - Cross-app summon/teleport relies on **Bolt** (events), **Book** (bookings),
    **Banter** (leave-a-note DM fallback), and the cross-app access preflight.

---

## 2. Key concepts and vocabulary

Schema: `apps/bureau-api/src/db/schema/bureau.ts` and `bureau-chat.ts`.

- **Building** (`bureau_buildings`) — optional grouping of floors for multi-site
  orgs. Not exposed in the current SPA (no building CRUD UI), only as an optional
  `building_id` on floor create.
- **Floor** (`bureau_floors`) — one navigable map. Owns `layout` JSON (zones,
  width/height), optional `background_url` underlay, a `slug` (unique per org),
  `position`, `is_default`. Soft-deleted via `archived_at`.
- **Room** (`bureau_rooms`) — addressable space on a floor; maps 1:1 to LiveKit
  room `bureau-room-{id}`. Fields: `name`, `type`, `privacy_default`, `capacity`,
  `bookable`, `zone_id` (must reference a layout zone), `owner_id`.
  - **Room types** (8): `office`, `huddle`, `conference`, `meeting`, `open`,
    `lounge`, `focus`, `lobby` (`rooms.routes.ts:25-34`).
  - **Room privacy / "door state"** (3): `open`, `knock`, `private`
    (`rooms.routes.ts:36`).
- **Door** — live or default privacy of a room. DB `privacy_default` is the
  durable fallback; live overrides (lock / DND window) live in Redis and apply on
  top (`rooms.routes.ts:512-574`; WS `set_door`/`lock_room`).
- **Room ACL** (`bureau_room_acl`) — per-user grant for private rooms. Role
  `member` or `manager` (managers can edit the room + manage its ACL).
- **Office** — a `type='office'` room with `owner_id`. The owner can be knocked
  on, sets the door, and admits/declines visitors ("personal office").
- **Presence session** (`bureau_presence_sessions`; live state in Redis) — which
  floor, room, status, and location URL a user is on. `device` ∈
  `web | pip | desktop | agent`.
- **Presence status** (6): `available`, `busy`, `dnd`, `focus`, `away`,
  `in_meeting` (`ws.routes.ts:132-139`, `presence.service.ts:71-77`). The docked
  box exposes a **DND** ("head-down") toggle that flips `available`↔`dnd`.
- **Knock** (`bureau_knocks`) — async request to enter a closed office. Status ∈
  `pending | admitted | declined | deferred | timed_out | dnd_blocked`.
  Auto-times-out after 30 s.
- **Summon / Teleport** (`bureau_summons`) — "Bring everyone here": pull every
  eligible co-occupant of your current room to a URL in another app. Per-recipient
  outcome ∈ `pending | joined | declined | no_access | granted | timed_out`.
- **Booking** (`bureau_bookings`) — reservation of a bookable room for a window,
  mirrored to a Book event. `access` ∈ `open` (non-attendees may wander in) |
  `locked` (private for the meeting).
- **Ring** — push an incoming-call overlay to a specific user on a content
  surface ("Invite…"). DND-respecting. Admin "Force Invite" bypasses the accept
  prompt with a 3 s cancellable auto-navigate.
- **Hunt** — locate a specific org member and jump to wherever they are
  ("Hunt…"). DND-respecting, destination-access-filtered.
- **Surface huddle** — LiveKit room `huddle-{surface_app}-{surface_id}`: the
  canonical audio room for any content surface (Board canvas, Brief doc, Bond
  deal…). The bureau-client SDK auto-joins it on navigation.
- **Docked box / PresenceChipStrip** — the floating Bureau overlay rendered by
  `mountBureauClient()` inside EVERY SPA. A disposable view over server-side
  presence; the truth lives in Redis so navigation never drops the session
  (`docs/plans/bureau-design-document.md:29-35`).
- **Room chat** (`bureau_chat_*`) — ephemeral text chat scoped to a room/surface,
  default 24 h retention. Recoverable later from "Recent chats".
- **Settings** (`bureau_settings`, one row per org) — `continuous_audio`,
  `allow_auto_follow`, `free_walk`, `default_office_privacy`, `members_can_book`,
  `members_can_create_rooms`.
- **Floor analytics** (`bureau_floor_analytics`) — daily per-floor utilization
  rollup (worker job; read by Bench). No Bureau-SPA surface.

---

## 3. Feature inventory

### 3.A Standalone Bureau SPA (`/bureau/`)

Router (`apps/bureau/src/App.tsx:43-58`), base `/bureau`:
- `/` → Floors list (`floor-list`)
- `/floors/:id` → live Floor view (`floor`)
- `/chats` → Recent chats (`chats`)
- `/admin/floors` → Admin Floors list (`admin-floor-list`)
- `/admin/floors/:id` → Floor editor (`admin-floor`)
- `/admin/offices` → Admin Offices (`admin-offices`)

**Sidebar** (`components/layout/bureau-sidebar.tsx`) labels:
- Brand: **"Bureau"**.
- "Floors": **"All floors"** (→ `/`), then one row per floor (name + occupancy badge).
- "History": **"Recent chats"** (→ `/chats`).
- "Admin" (admin/owner/superuser only): **"Edit floors"** (→ `/admin/floors`),
  **"Offices"** (→ `/admin/offices`).
- Header bar (`bureau-layout.tsx`): Launchpad trigger, breadcrumbs, OrgSwitcher,
  NotificationsBell (prefix `/bureau/`), UserMenu.

#### Feature: Browse floors (Floors landing)
- **UI:** `pages/floor-list.tsx`. Heading **"Floors"**; subtitle "Pick a floor to
  drop in. Live occupancy shows who's around right now." Floor cards show name,
  slug, a **"Default"** pill, and "{n} person/people here now". Empty: "No floors
  yet" / "Ask an org admin to create the first floor under Admin to Floors."
- **Steps:** Open `/bureau/` → click a floor card → `/floors/:id`.
- **Route:** `GET /v1/floors` (occupancy from Redis) (`floors.routes.ts:110-142`).

#### Feature: Live floor view (spatial canvas)
- **UI:** `pages/floor-view.tsx`. Canvas2D: one rectangle per room, occupant dots,
  grid background. Status bar shows floor name + a connection chip **"Live"** (else
  raw status). When in a room a **"Leave room"** button appears.
- **Interaction:** click a room rect → `enterRoom(roomId)` over WS; hover thickens
  border; rooms without a zone auto-grid (4 cols).
- **Steps:** `/floors/:id` → click a room → "Leave room".
- **Routes/WS:** `GET /v1/floors/:id` (`floors.routes.ts:145-204`); live data over
  `/bureau/ws` via `useBureauWs` (sends `subscribe_floor`/`enter_room`/`leave_room`/
  `knock`; receives `presence_snapshot`/`room_enter`/`room_leave`/`presence_delta`/
  `status_changed`). Entering mints a LiveKit token server-side.

#### Feature: Recent chats (room-chat recovery)
- **UI:** `pages/chats.tsx`. Heading **"Recent chats"**; subtitle "Room chats you
  were present for. Messages expire 24 hours after they were sent unless an admin
  extends or retains the thread." Search "Search by room name or message text…".
  Thread list (label, message count, retention text, last-message time,
  ShieldCheck if retained). Click → transcript dialog. Admins get a **"Retention"**
  dropdown: "24 hours (default)", "2 days", "3 days", "1 week (max)", "Retain
  permanently".
- **Steps:** Sidebar → "Recent chats" → search/select → read transcript; (admin)
  change retention.
- **Routes:** `GET /v1/chat/rooms?search=`; `GET /v1/chat/rooms/:roomKey/messages`;
  `PATCH /v1/chat/rooms/:roomKey/retention` (admin only) (`chat.routes.ts`).

#### Feature: Admin — Floors list (create/edit/preview/archive/restore)
- **UI:** `pages/admin/floor-list.tsx`. Heading **"Admin · Floors"**, **"New
  floor"** button. Sections "Live floors (n)" / "Archived (n)". Live cards have
  **"Edit"**, **"Preview as member"**, **"Archive"**; archived rows have
  **"Restore"**. Non-admins: "Floor administration requires admin or owner".
  - **Create dialog** ("New floor"): **Name** (placeholder "e.g. Engineering 3F"),
    **Slug** (auto, `[a-z0-9-]+`), helper "Used in the floor URL: /floors/{slug}".
    Submit **"Create + open editor"**.
- **Routes:** `GET /v1/floors?include_archived=1`, `POST /v1/floors`,
  `DELETE /v1/floors/:id` (archive), `PATCH /v1/floors/:id {archived_at:null}`
  (restore) (`floors.routes.ts`).

#### Feature: Admin — Floor editor (canvas room placement)
- **UI:** `pages/admin/floor-editor.tsx` + `components/floor-editor/*`. Top
  toolbar: Back, editable floor-name input, "{n} zones · WxH", tool selector
  **"Select" / "New room" / "New office"**, image-underlay control, **"Save"**.
  Canvas for draw/drag/select; right inspector for the selected zone. Empty hint:
  "Click a zone to edit it, or pick 'New room' / 'New office' and click-drag on the
  floor."
  - **Room inspector fields** (`room-inspector.tsx`): **Name** ("e.g. War Room"),
    **Type** ("Office (single owner)", "Huddle", "Conference", "Meeting", "Open
    space", "Lounge", "Focus", "Lobby"), **Capacity (people)** ("(unlimited)"),
    **Door default** ("Open"/"Knock"/"Private") with helper "The default — visitors
    override this at runtime via the docked box", **Bookable** ("Allow reservations
    via Book"), **Owner** (offices only — PeoplePicker "Choose owner…" + a "View
    owner in People" link), **Geometry (world units)** x/y/w/h, read-only **Zone
    id**. Footer **"Remove zone"** (soft-deletes the room on save; "Live occupants
    are evicted to the lobby").
  - **Image underlay** (`image-underlay-upload.tsx`): upload image/* via Bam's
    `POST /b3/api/upload`; Replace/Remove states; PATCHes the `/files/…` URL onto
    the floor.
- **Save flow** (`floor-editor.tsx:334-413`): `PATCH /v1/floors/:id` (layout, name,
  background_url) then per-zone `POST /v1/rooms` (new), `PATCH /v1/rooms/:id`
  (changed), `DELETE /v1/rooms/:id` (removed).

#### Feature: Admin — Offices (assign/reassign office owners)
- **UI:** `pages/admin/offices.tsx`. Heading **"Admin · Offices"**. Table columns
  **"Floor / Office"**, **"Owner"** (avatar+name+email or **"Unassigned"**),
  **"Actions"** with a **"Reassign owner"** button. Picker dialog "Reassign {office}"
  (placeholder "Search name or email…", "Current" tag on existing owner).
  Non-admins: "Office administration requires admin or owner".
- **Routes:** `GET /v1/offices`, `POST /v1/offices/assign {room_id,user_id}`.
  Member list from Bam's `/b3/api/org/members` (`offices.routes.ts`, `offices.tsx`).

### 3.B Cross-app docked box (PresenceChipStrip) — `packages/bureau-client/src`

`mountBureauClient()` is mounted by every SPA (incl. Bureau's `main.tsx`). It
renders the floating "docked box" plus knock/summon/ring toasts and the room-chat
panel into a portal, tracks the server-side presence session, and reports the
user's location via `describeLocation()` on each navigation. This is the surface
the orchestrator calls the "Bureau docked box" (Board and Banter surface this same
box).

Docked-box UI labels (`packages/bureau-client/src/index.tsx`):
- Header: status dot + **"Bureau"**; a **"CHAT"** toggle (badge = unread; title
  "Open room chat (ephemeral — 24h)"); a **"DND"** head-down toggle (title "Go
  head-down: block invites and hunts (DND)"); popout (PiP) button; collapse chevron.
- **"In:"** row → current room name (or **"No room"**) + "(X people here)" count.
- Occupants list (or **"Just you"**). Agents prefixed "(A) ".
- **"Viewing:"** row → human-readable current location.
- **"Bring everyone here"** button (when in a room with others on a located page)
  → issues a summon to the viewed URL.
- **"Invite…"** (ring) — left-click ask, right-click Force Invite (admin). Opens
  `InvitePopover`.
- **"Hunt…"** — find a member and jump to them. Opens `HuntPopover`.
- Active-call strip + controls: **"mic"/"mic on"**, **"cam"/"cam on"**, **"screen"**;
  video tiles.
- **Incoming knock toast** (`knock-handler.tsx`): **"Let in"** (admit), **"Not now"**
  (defer), **"Decline"**; auto-defers after 30 s.
- **Incoming summon toast** (`summon-handler.tsx`): **Join** / **"Stay here"**;
  optional 3 s cancellable auto-follow.

### 3.C Backend REST routes (full enumeration)

Under `/bureau/api/v1`. Auth via `requireAuth` unless noted. Role hierarchy
`viewer<member<admin<owner`; `is_superuser` overrides.

**Floors** (`floors.routes.ts`)
- `GET /floors` — list + live occupancy; `include_archived=1` (admin) adds archived.
- `GET /floors/:id` — metadata + layout + per-room occupancy + rooms array.
- `POST /floors` — create (admin/owner); 409 on duplicate `(org,slug)`.
- `PATCH /floors/:id` — update (admin/owner); `{archived_at:null}` = unarchive.
- `DELETE /floors/:id` — soft-delete/archive (admin/owner).
- `POST /floors/:id/background` — set background URL (admin/owner).

**Rooms / doors / ACL** (`rooms.routes.ts`)
- `GET /rooms/:id` — detail + live occupants (org-scoped).
- `POST /rooms` — create (admin/owner always; members iff
  `members_can_create_rooms`). Validates `zone_id` against floor layout.
- `PATCH /rooms/:id` — update (admin/owner, office owner, or room manager).
- `DELETE /rooms/:id` — soft-delete (admin/owner).
- `POST /rooms/:id/acl` — upsert ACL `{user_id, role: member|manager}`.
- `DELETE /rooms/:id/acl/:userId` — remove ACL.
- `PATCH /rooms/:id/door` — set durable `privacy_default` (office owner / room
  manager / admin).

**Offices** (`offices.routes.ts`)
- `GET /offices` (admin) — all office rooms + owner data.
- `POST /offices/assign` (admin) — set `owner_id`.
- `GET /offices/mine` — caller's owned room (or null).

**Bookings** (`bookings.routes.ts`)
- `GET /rooms/:id/bookings?from&to` — active bookings in a window (default 7 days).
- `POST /rooms/:id/bookings` — `{title, starts_at, ends_at, access, book_event_id?}`;
  mints a Book event (fallback local UUID); schedules lifecycle jobs; gated by
  `members_can_book`.
- `PATCH /bookings/:id` — organizer or admin; re-schedules lifecycle jobs.
- `DELETE /bookings/:id` — soft-cancel; drops jobs; best-effort cancels Book event.

**Knocks** (`knocks.routes.ts`)
- `POST /knocks {room_id, message?}` — knock on an office. Office-only, must have
  owner, cannot knock own; 423 `OWNER_DND` if owner in DND. Emits
  `knock.requested`, schedules 30 s timeout, in-app-notifies the owner.
- `PATCH /knocks/:id {decision: admit|defer|decline}` — owner resolves. Emits
  `knock.resolved`.
- `GET /knocks/inbox` — pending knocks where caller is owner.
- `POST /knocks/leave-note {room_id, message}` — DND fallback: Banter DM prefixed
  "[Bureau knock note] " (200 delivered / 202 if Banter unreachable).

**LiveKit token mint** (`livekit.routes.ts`)
- `POST /rooms/:id/token` — token for `bureau-room-{id}` (privacy/ACL/owner/admin
  gated + live door; 503 if calling disabled). Returns `{token, room_name, ws_url}`,
  TTL 3600 s.
- `POST /surface-huddle/token {surface_app, surface_id}` — token for
  `huddle-{app}-{id}`; symmetric-auth gate (403 `NOT_ON_SURFACE` if not present on
  the surface).

**Summons / teleport** (`summons.routes.ts`)
- `POST /summon {target_url, target_app, target_label?, lk_room_hint?}` — plan +
  record + fan out; must be in a room (400 otherwise); cross-app access-checks each
  recipient; in-app-notifies eligible recipients. Returns `{summon_id, from_room_id,
  eligible_count, denied_count, can_share}`.
- `GET /summons/:id` — audit row (summoner/admin only).
- `POST /summons/:id/grant-access {user_ids[]}` — §4.4 grant-and-summon (summoner).

**Presence** (`presence-here.routes.ts`, `presence-where.routes.ts`, `ring.routes.ts`)
- `GET /presence/here?url=` — other users on the same content URL (deduped,
  access-filtered): `[{user_id, display_name, avatar_url, status, status_emoji}]`.
- `GET /presence/where/:userId` — where a user is now (url/app/label/status) or
  `{located:false}` (offline/DND/access-denied); 404 for non-org-members.
- `POST /ring {to_user_id, surface_app, surface_id, surface_label?, surface_url?,
  force?}` — incoming-call overlay; 423 `RECIPIENT_DND` unless `force`; `force`
  (admin) = 3 s cancellable auto-navigate.

**Settings** (`settings.routes.ts`)
- `GET /settings` — org Bureau settings (creates defaults).
- `PATCH /settings` — update (admin/owner): `continuous_audio`, `allow_auto_follow`,
  `default_office_privacy`, `members_can_book`, `members_can_create_rooms`.

**Internal cross-app** (`internal.routes.ts`, `X-Internal-Service-Secret`)
- `GET /internal/can-join-room/:roomId/:userId` — `{allowed, reason?}` preflight
  used by board-api / brief-api before a `?lkRoom=bureau-room-X` token mint.

**WebSocket** (`ws.routes.ts`, `/bureau/ws`)
- Client→server: `subscribe_floor`, `enter_room`, `leave_room`, `heartbeat`,
  `set_status`, `set_door`, `lock_room`, `knock`, `knock_respond`,
  `location_update`, `chat_join`, `chat_leave`, `chat_send`, `ring_respond`,
  `summon`, `summon_respond`, `summon_grant_access`.
- Server→client: `presence_snapshot`, `presence_delta`, `room_enter`/`room_leave`,
  `status_changed`, `door_changed`, `room_locked`, `knock_incoming`/`knock_resolved`,
  `chat_joined`/`chat_message`, `ring_incoming`/`ring_responded`,
  `summon_incoming`/`summon_ack`/`summon_progress`, `livekit_token`, `error`.

**Bolt events** (`lib/bureau-events.ts`, source `bureau`): `user.entered_room`,
`user.left_room`, `status.changed`, `knock.requested`, `knock.resolved`,
`room.booked`, `room.locked`, `summon.issued`.

**Worker jobs** (`apps/worker/src/jobs/bureau-*`): `bureau-knock-timeout`
(30 s → `timed_out`), `bureau-presence-reap` (15 s stale-session sweep →
`user.left_room`), `bureau-booking-lifecycle` (privacy override at start/end),
`bureau-summon-fanout`, `bureau-chat-expiry`, `bureau-analytics-rollup`
(daily floor utilization → Bench).

---

## 4. MCP tools (apps/mcp-server/src/tools/bureau-tools.ts)

17 tools registered by registerBureauTools (forwarding the caller bearer token).
Three high-impact tools use the confirm_action preview-then-commit pattern.

Perception (read-only):
1. bureau_list_floors -> GET /floors. (Floors landing.)
2. bureau_get_floor -> GET /floors/:id. (Floor view / enumerate rooms.)
3. bureau_who_is_in_room -> GET /rooms/:id. (Occupancy before summon/knock.)
4. bureau_locate_user -> GET /presence/locate?user= -- STUB (endpoint not
   implemented; returns {data:null,_stub:true}).
5. bureau_get_presence -> GET /presence -- STUB (not implemented; {data:[]}).

Self-movement and status:
6. bureau_move_self -> POST /rooms/:id/token. (Enter a room; canonical
   "appear in the room" action for agents.)
7. bureau_set_status -> PATCH /me/status -- STUB (not implemented; accepts
   active|dnd|away).
8. bureau_set_door_state -> PATCH /rooms/:id/door.

Social:
9. bureau_knock -> POST /knocks.
10. bureau_respond_knock -> PATCH /knocks/:id.

Booking:
11. bureau_book_room (confirm_action) -> POST /rooms/:id/bookings.
12. bureau_list_bookings -> GET /rooms/:id/bookings.
13. bureau_cancel_booking (confirm_action) -> DELETE /bookings/:id.

Teleport:
14. bureau_summon (confirm_action) -> POST /summon. ("Bring everyone here".)

Administration (admin/owner gated server-side):
15. bureau_create_floor -> POST /floors.
16. bureau_create_room -> POST /rooms.
17. bureau_update_room -> PATCH /rooms/:id.

> Not covered by any MCP tool: ACL management, office assignment, ring/invite,
> hunt/locate-via-where, leave-note, summon grant-access, chat, settings, floor
> update/delete/background.

---

## 5. Candidate User Stories

1. Drop into the office and join a room. /bureau/ -> pick a floor -> click an open
   room to enter (mints audio) -> "Leave room".
2. Knock on a busy colleague office. Click their knock/private office -> knock ->
   they get a toast ("Let in" / "Not now" / "Decline") -> admitted on "Let in".
3. Owner triages knocks. Respond to knock toasts or GET /knocks/inbox; flip DND on
   the docked box to block knocks (visitors get a leave-a-note path).
4. Bring everyone here (teleport). In a room with others, navigate to a
   Board/Brief/Bond resource -> "Bring everyone here" -> eligible co-occupants get a
   Join toast and land on the same URL; denied users -> "grant access".
5. Invite one person (ring). "Invite..." on any located page -> pick a member ->
   they get a call overlay -> accept navigates them to your surface + auto-joins the
   huddle. (Admin right-click = Force Invite.)
6. Hunt a teammate. "Hunt..." -> pick a member -> jump to wherever they are.
7. Book the conference room. In a bookable room, reserve a window (mirrors a Book
   event; locked keeps it private). Agent: bureau_book_room.
8. Admin builds a floor. Admin -> "Edit floors" -> "New floor" -> draw rooms/offices,
   set type/door/capacity/owner, upload underlay -> "Save".
9. Admin assigns offices. Admin -> "Offices" -> "Reassign owner" -> pick a member.
10. Recover what was said. Sidebar -> "Recent chats" -> open a transcript; admins
    extend/retain retention.
11. Agent staffs a room and pulls humans in. bureau_get_floor -> bureau_move_self ->
    bureau_who_is_in_room -> bureau_summon (confirm).

---

## 6. Agent flows

Agents drive Bureau through the 17 bureau_* MCP tools (forwarding the user bearer
token):
- Enter a room = bureau_move_self (mints token + registers session, so the agent
  appears in bureau_who_is_in_room).
- Perceive = bureau_list_floors / bureau_get_floor / bureau_who_is_in_room.
  bureau_locate_user and bureau_get_presence are STUBS today (fail-soft empty).
- Socialize = bureau_knock / bureau_respond_knock (surface the 423 DND
  leave-a-note hint instead of retrying).
- Teleport = bureau_summon (high-impact, confirm_action; caller must be in a room).
- Book = bureau_book_room / bureau_cancel_booking (confirm_action) /
  bureau_list_bookings.
- Administer = bureau_create_floor / bureau_create_room / bureau_update_room /
  bureau_set_door_state (admin/owner gated server-side).
- Agents are first-class spatial occupants (is_agent; device "agent"); the docked
  box prefixes their names "(A) ".

---

## 7. Screenshots available

None. No docs/apps/bureau/ directory and no screenshots exist for this app
(docs_exists:false; confirmed no docs/apps/bureau path in the repo). The writer
must capture fresh screenshots or describe the views in prose.

---

## 8. Discrepancies (code vs. tool descriptions / design doc)

1. bureau_locate_user is a stub but a real endpoint exists. The tool hits the
   unbuilt GET /presence/locate?user=, yet GET /presence/where/:userId (org-scoped,
   DND-aware, access-filtered) does exactly this. The tool was wired to the wrong
   path (bureau-tools.ts:211-228 vs presence-where.routes.ts).
2. bureau_get_presence is a stub. GET /presence (org-wide map) is unimplemented;
   the closest live endpoint is GET /presence/here?url= (per-URL co-presence),
   which the tool does not call.
3. bureau_set_status is a stub. PATCH /me/status does not exist; the real status
   change is the WS set_status frame with no REST mirror. Agents cannot change
   presence status today.
4. bureau_set_status enum mismatch. Tool accepts active|dnd|away, but the canonical
   enum is available|busy|dnd|focus|away|in_meeting (ws.routes.ts:132-139).
   "active" is not a real status value.
5. free_walk setting is unreachable via API. bureau_settings.free_walk exists in
   schema with a default but is absent from PATCH /settings
   (settings.routes.ts:19-25) -- it cannot be toggled through the API.
6. No org Bureau settings page in the SPA. GET/PATCH /v1/settings exist
   (continuous_audio, allow_auto_follow, members_can_book, members_can_create_rooms,
   default_office_privacy) but no settings view renders them in apps/bureau/src --
   only reachable via API/MCP.
7. summon.issued / room.booked emitters not located in the routes read.
   lib/bureau-events.ts defines and the Bolt catalog registers them, but the REST
   summon route and WS summon handler do not call emitSummonIssued in the paths
   read; room.booked is likely fired by the booking-lifecycle worker. Verify the
   actual emit site before documenting these as guaranteed.
8. CLAUDE.md MCP inventory predates Bureau. The CLAUDE.md app catalog and tool
   tallies list Banter/Beacon/etc. but no Bureau row; not load-bearing for help.

---

## 9. Open questions

1. Where do members set their own status / DND outside the docked box? The only
   status control found is the docked-box DND toggle and the WS set_status frame;
   there is no in-app status menu in the Bureau SPA. Is the docked box the sole
   intended surface?
2. Continuous-audio handoff specifics. internal/can-join-room and ?lkRoom= are
   referenced, but summon-handler.tsx says the ?lkRoom= mechanism is "dead" in the
   v2 unified-call model (SDK auto-joins on navigation). Which is authoritative for
   current behavior?
3. Buildings. bureau_buildings exists and POST /floors accepts building_id, but
   there is no building CRUD route or UI. Are multi-building orgs supported, or is
   this latent schema?
4. Are bureau_get_presence / bureau_locate_user / bureau_set_status landing soon
   ("workstream 13" TODOs)? Affects whether "ask an agent who is in Bureau" is
   documentable.
5. Settings exposure. Should help mention org settings (members_can_book,
   members_can_create_rooms, etc.) given there is no UI yet? They materially affect
   who can book/create rooms.
6. Live door lock UX. The SPA inspector only sets durable privacy_default; live
   lock/DND overrides go through the docked box / WS (set_door, lock_room). The
   per-room live-lock UI (if any) lives deeper in the SDK and was not fully
   enumerated -- follow up in people-here.tsx / pip-host.tsx if the writer needs the
   live-door UX.
