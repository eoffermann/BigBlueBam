/**
 * Gilligan's Island themed Bureau PRESENCE + ROOM-BOOKING seed.
 *
 * Companion to scripts/seed-gilligan/bureau.mjs (which seeds the floor + rooms).
 * This pass populates the three newly-built surfaces so they render non-empty
 * for docs/screenshots:
 *
 *   1. Presence statuses (PATCH /v1/me/status) for the core cast, so
 *      `bureau_get_presence` / the floor view's status chips and the floating
 *      presence widget show a believable mix of available / focus / dnd / busy.
 *   2. Durable room placement: each status-set castaway is dropped into a
 *      themed room on "The Lagoon HQ" floor by writing the TTL-LESS presence
 *      substrate directly in Redis — the room-occupants SET
 *      (`bureau:room:{id}:occupants`), the floor index
 *      (`bureau:floor:{id}:index`, userId -> roomId), and a long-lived session
 *      HASH (`bureau:sess:{id}`). The live WS hub uses a 35s TTL on the
 *      session HASH; a one-shot seed cannot keep a live socket open, so we
 *      seed the occupants SET + floor index (which have no TTL and are what
 *      the floor view's initial paint + presence snapshot read) and give the
 *      backing session HASH a long TTL so the org-wide presence SCAN
 *      (GET /v1/presence) still finds it for a docs capture run.
 *   3. At least one room booking (POST /v1/rooms/:id/bookings) for an upcoming
 *      meeting, so the Room booking screen's "Upcoming bookings" list is
 *      populated rather than the empty state.
 *   4. Explicit org Bureau settings (PATCH /v1/settings as the Owner) so the
 *      Admin settings screen shows deliberate, non-default toggle states.
 *
 * Idempotent throughout: status writes are last-write-wins by nature; the
 * booking is find-or-create by (room, title); Redis presence is overwritten
 * in place; settings is an upsert. Safe to re-run.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("scripts/.gilligan-keys.env","utf8").split("\n")){if(l&&!l.startsWith("#")&&l.includes("=")){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1).trim();}}process.stdout.write(JSON.stringify(o))') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bureau-presence.mjs
 *
 * (the api container can reach the internal bureau-api host AND the shared
 *  Redis; cast API keys authenticate via Bearer, scoping to the Gilligan org.)
 *
 * Mechanism notes (verified against the source):
 *   - bureau-api lives at bureau-api:4015, routes under /v1 (docker-compose.yml).
 *   - PATCH /v1/me/status sets the CALLER's own durable status; the MCP enum is
 *     {available,busy,dnd,focus,away,in_meeting} (me-status.routes.ts). There is
 *     no free-text status on this path, so the themed labels ("On the bridge",
 *     "In the lab - do not disturb", "Available") map to the closest enum value
 *     and live in the room metadata / docs prose, not the status field.
 *   - Redis presence schema is presence.service.ts §7: occupants SET + floor
 *     index are TTL-less; the session HASH carries SESSION_TTL_SECONDS (35s) in
 *     production. We seed a long TTL here purely so a later docs capture's
 *     org-wide SCAN still sees the session.
 */

import Redis from 'ioredis';

const BUREAU = 'http://bureau-api:4015/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

const ORG_ID = '57db0001-3f0e-463f-b514-1cd14fd14241';

// Cast user ids (mirror of scripts/seed-gilligan/bam.mjs CAST map).
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
  gilligan: '0f47c55f-4c7d-4100-a00b-ca131a1e864d',
  maryann: 'd2835cc4-8ee9-4a27-b43e-84ab19a21450',
  ginger: 'c8926754-2a93-4bd6-bf20-5b1f87e27385',
  howell: '414d283d-f13b-4608-91db-dfd024db4064',
  lovey: '0ddd0b3e-4de3-4077-a905-07878dc43960',
};

const OWNER = 'skipper'; // org Owner — clears the admin/owner gate on settings.

// Keep the seeded session HASHes around well past a capture run. Production
// heartbeats keep this at 35s; a docs seed wants the SCAN to find them later.
const SEEDED_SESSION_TTL_SECONDS = 6 * 60 * 60; // 6h

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}

async function api(who, method, path, body) {
  if (!KEYS[who]) throw new Error(`No API key for "${who}" in GKEYS — check scripts/.gilligan-keys.env`);
  const r = await fetch(`${BUREAU}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = {};
  try {
    const text = await r.text();
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!r.ok) {
    throw new Error(`${method} ${path} (${who}) -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.data ?? data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// Redis presence key builders — mirror apps/bureau-api/src/services/presence.service.ts.
const rkeys = {
  session: (sessionId) => `bureau:sess:${sessionId}`,
  userSessions: (userId) => `bureau:user:${userId}:sessions`,
  roomOccupants: (roomId) => `bureau:room:${roomId}:occupants`,
  floorIndex: (floorId) => `bureau:floor:${floorId}:index`,
  userStatus: (userId) => `bureau:user:${userId}:status`,
  sessionIndex: () => 'bureau:presence:index',
};

// Themed presence: which castaway, which room they're working from, and the
// closest status enum to their flavor line.
//   - Skipper:   "On the bridge"             -> available (running the camp)
//   - Professor: "In the lab - do not disturb" -> dnd
//   - Mary Ann:  "Available"                  -> available
//   - Ginger:    rehearsing in the kitchen    -> busy (rounds the floor out to 4)
const PRESENCE = [
  { who: 'skipper', room: "Lookout Point", status: 'available', flavor: 'On the bridge' },
  { who: 'professor', room: "Professor's Lab", status: 'dnd', flavor: 'In the lab - do not disturb' },
  { who: 'maryann', room: "Mary Ann's Kitchen", status: 'available', flavor: 'Available' },
  { who: 'ginger', room: "Mary Ann's Kitchen", status: 'busy', flavor: 'Rehearsing the rescue-day number' },
];

(async () => {
  // ── Resolve the floor + room ids by name ──────────────────────────────
  const floors = asArr(await api(OWNER, 'GET', '/floors'));
  const floor = floors.find((f) => f.name === 'The Lagoon HQ');
  if (!floor) {
    throw new Error(
      'Floor "The Lagoon HQ" not found — run scripts/seed-gilligan/bureau.mjs first.',
    );
  }
  console.log(`floor: The Lagoon HQ (${floor.id})`);

  const rooms = asArr(await api(OWNER, 'GET', '/rooms'));
  const roomByName = new Map(rooms.map((r) => [r.name, r]));

  // ── Redis client (same REDIS_URL the api container uses) ──────────────
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL not set in the api container env');
  const redis = new Redis(redisUrl);

  // ── 1 + 2. Durable status + durable room placement per castaway ───────
  let statusCount = 0;
  let placedCount = 0;
  for (const p of PRESENCE) {
    const userId = CAST[p.who];
    const room = roomByName.get(p.room);
    if (!room) {
      console.log(`  presence SKIP ${p.who}: room "${p.room}" not found`);
      continue;
    }

    // (a) Durable chosen status (REST — this is the source of truth the
    //     presence snapshot + status chip read for a user with no live socket).
    await api(p.who, 'PATCH', '/me/status', { status: p.status });
    statusCount++;

    // (b) Durable per-user status HASH (belt + braces: PATCH already wrote
    //     this, but assert org-scoping explicitly).
    await redis.hset(rkeys.userStatus(userId), 'status', p.status, 'orgId', ORG_ID);

    // (c) Drop the user into their room: occupants SET + floor index are
    //     TTL-less; the session HASH gets a long TTL so the org-wide SCAN
    //     (GET /v1/presence) finds it during a capture run.
    const sessionId = `seed-${p.who}`;
    const now = Date.now();
    const pipe = redis.pipeline();
    pipe.hset(rkeys.session(sessionId), {
      userId,
      isAgent: '0',
      orgId: ORG_ID,
      floorId: floor.id,
      roomId: room.id,
      status: p.status,
      statusText: p.flavor,
      emoji: '',
      locationUrl: `/bureau/floors/${floor.id}`,
      locationApp: 'bureau',
      locationLabel: p.room,
      device: 'web',
      lastBeat: String(now),
    });
    pipe.expire(rkeys.session(sessionId), SEEDED_SESSION_TTL_SECONDS);
    pipe.sadd(rkeys.userSessions(userId), sessionId);
    pipe.sadd(rkeys.roomOccupants(room.id), userId);
    pipe.hset(rkeys.floorIndex(floor.id), userId, room.id);
    pipe.hset(
      rkeys.sessionIndex(),
      sessionId,
      JSON.stringify({ userId, orgId: ORG_ID, floorId: floor.id, roomId: room.id, device: 'web' }),
    );
    await pipe.exec();
    placedCount++;
    console.log(`  + presence ${p.who}: ${p.status} in "${p.room}" ("${p.flavor}")`);
  }

  // ── 3. At least one upcoming room booking ─────────────────────────────
  // Find-or-create by (room, title) so a re-run does not stack duplicates.
  const BOOKING_ROOM = "Mary Ann's Kitchen";
  const BOOKING_TITLE = 'Rescue-day briefing';
  const bookingRoom = roomByName.get(BOOKING_ROOM);
  let bookingMade = 0;
  let bookingSkipped = 0;
  if (!bookingRoom) {
    console.log(`  booking SKIP: room "${BOOKING_ROOM}" not found`);
  } else {
    // Window: tomorrow 10:00-11:00 local-ish (UTC; the screen renders local).
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(16, 0, 0, 0); // 16:00Z ~ a sane working-hours slot most TZs
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    // The list endpoint returns { bookings: [...] } (api() unwraps .data).
    const listResp = await api(OWNER, 'GET', `/rooms/${bookingRoom.id}/bookings`);
    const currentBookings = listResp.bookings ?? [];
    const already = currentBookings.some((b) => b.title === BOOKING_TITLE);

    if (already) {
      console.log(`  booking exists: "${BOOKING_TITLE}" in ${BOOKING_ROOM}`);
      bookingSkipped++;
    } else {
      const created = await api(OWNER, 'POST', `/rooms/${bookingRoom.id}/bookings`, {
        title: BOOKING_TITLE,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        access: 'locked',
      });
      console.log(
        `  + booking: "${BOOKING_TITLE}" in ${BOOKING_ROOM} ${start.toISOString()} (${created.id})`,
      );
      bookingMade++;
    }
  }

  // A second, open-access booking on a different room so the screen reads as a
  // real schedule, not a one-off. Best-effort / find-or-create.
  const BOOKING2_ROOM = 'The Lagoon';
  const BOOKING2_TITLE = 'All-hands raft launch';
  const booking2Room = roomByName.get(BOOKING2_ROOM);
  if (booking2Room) {
    const listResp2 = await api(OWNER, 'GET', `/rooms/${booking2Room.id}/bookings`);
    const cur2 = listResp2.bookings ?? [];
    if (cur2.some((b) => b.title === BOOKING2_TITLE)) {
      console.log(`  booking exists: "${BOOKING2_TITLE}" in ${BOOKING2_ROOM}`);
      bookingSkipped++;
    } else {
      const start2 = new Date();
      start2.setUTCDate(start2.getUTCDate() + 2);
      start2.setUTCHours(15, 0, 0, 0);
      const end2 = new Date(start2.getTime() + 90 * 60 * 1000);
      const created2 = await api(OWNER, 'POST', `/rooms/${booking2Room.id}/bookings`, {
        title: BOOKING2_TITLE,
        starts_at: start2.toISOString(),
        ends_at: end2.toISOString(),
        access: 'open',
      });
      console.log(
        `  + booking: "${BOOKING2_TITLE}" in ${BOOKING2_ROOM} ${start2.toISOString()} (${created2.id})`,
      );
      bookingMade++;
    }
  }

  // ── 4. Explicit org Bureau settings (Owner only) ──────────────────────
  // Deliberate non-default state so the Admin settings screen shows toggles
  // in a meaningful configuration rather than all-defaults.
  const settings = await api(OWNER, 'PATCH', '/settings', {
    continuous_audio: true,
    allow_auto_follow: true,
    members_can_book: true,
    members_can_create_rooms: false,
    default_office_privacy: 'knock',
  });
  console.log(
    `  settings: continuous_audio=${settings.continuous_audio}, allow_auto_follow=${settings.allow_auto_follow}, ` +
      `members_can_book=${settings.members_can_book}, members_can_create_rooms=${settings.members_can_create_rooms}, ` +
      `default_office_privacy=${settings.default_office_privacy}`,
  );

  await redis.quit();

  console.log(
    `\nBureau presence seed done: ${statusCount} statuses set, ${placedCount} castaways placed in rooms, ` +
      `${bookingMade} bookings created, ${bookingSkipped} already present, settings configured.`,
  );
})().catch((e) => {
  console.error('bureau presence seed failed:', e.message);
  process.exit(1);
});
