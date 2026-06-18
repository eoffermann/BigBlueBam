/**
 * Gilligan's Island themed Bureau (virtual-office) seed.
 *
 * The castaways run their day from "The Lagoon HQ" — the island reimagined as
 * a spatial office floor, with a themed room for every corner of the camp.
 * Idempotent: skips the floor if one with the same name exists, and skips any
 * room whose name already exists on that floor.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bureau.mjs
 * (the api container can reach the internal bureau-api host; the Skipper's
 *  API key authenticates via Bearer, which bypasses CSRF and scopes to the
 *  Gilligan org. Floor/room creation is admin/owner-gated — the Skipper is
 *  the org Owner, so seed as the Skipper.)
 *
 * Mechanism note: bureau-api lives at bureau-api:4015 with all routes under
 * /v1 (verified against docker-compose.yml + apps/bureau-api/src/server.ts).
 * Room create REQUIRES a zone_id, and when a floor's layout defines zones[],
 * the zone_id must be one of them (apps/bureau-api/src/services/
 * floor-layout.service.ts). We therefore author the floor layout with one
 * zone per room and create each room into its matching zone, which is exactly
 * what the floor view (apps/bureau/src/pages/floor-view.tsx) walks to render
 * the office map.
 */

const BUREAU = 'http://bureau-api:4015/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

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

// Seed as the Skipper — he is the org Owner, so he clears the admin/owner
// gate on POST /floors and POST /rooms.
const OWNER = 'skipper';

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}
async function api(who, method, path, body) {
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
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.data ?? data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// ── The Lagoon HQ floorplan ─────────────────────────────────────────────
// World space is 1200 x 800. Zones are positioned to read as a believable
// island camp seen from above: the Howell Estate dominates the prime
// north-east corner, the Professor's Lab anchors the north-west, the working
// huts run down the west wall, the Kitchen sits central, and the open Lagoon
// fills the south as the all-hands gathering area.
const FLOOR = {
  name: 'The Lagoon HQ',
  slug: 'the-lagoon-hq',
  width: 1200,
  height: 800,
};

// Each room: zone geometry (x,y,w,h + label for the canvas) + the room row
// fields. zone_id ties the bureau_rooms row to the floor-layout zone so the
// floor view paints it in the right place. `who` (when set) becomes owner_id
// for type='office' rooms — the knock target.
const ROOMS = [
  {
    zone_id: 'zone-professors-lab',
    label: "Professor's Lab",
    name: "Professor's Lab",
    type: 'office',
    privacy_default: 'knock',
    capacity: 1,
    bookable: false,
    who: 'professor',
    x: 60, y: 60, w: 260, h: 200,
    metadata: { motto: 'I can make a radio out of a coconut. A boat? No.' },
  },
  {
    zone_id: 'zone-lookout-point',
    label: 'Lookout Point',
    name: 'Lookout Point',
    type: 'huddle',
    privacy_default: 'open',
    capacity: 4,
    bookable: false,
    x: 360, y: 60, w: 240, h: 200,
    metadata: { duty: 'Scan the horizon for ships. Wave shirt. Repeat.' },
  },
  {
    zone_id: 'zone-howell-estate',
    label: 'Howell Estate',
    name: 'Howell Estate',
    type: 'office',
    privacy_default: 'private',
    capacity: 2,
    bookable: false,
    who: 'howell',
    x: 660, y: 60, w: 480, h: 280,
    metadata: { decor: 'Imported bamboo, monogrammed coconuts, a butler-less butler pantry.' },
  },
  {
    zone_id: 'zone-radio-hut',
    label: 'Radio Hut',
    name: 'Radio Hut',
    type: 'focus',
    privacy_default: 'knock',
    capacity: 2,
    bookable: true,
    x: 60, y: 300, w: 240, h: 180,
    metadata: { warning: 'Do NOT let Gilligan touch the dial.' },
  },
  {
    zone_id: 'zone-supply-hut',
    label: 'Supply Hut',
    name: 'Supply Hut',
    type: 'lounge',
    privacy_default: 'open',
    capacity: 6,
    bookable: false,
    x: 340, y: 300, w: 240, h: 180,
    metadata: { inventory: 'Rope, crates, the professor’s mystery boxes, one inexplicable anchor.' },
  },
  {
    zone_id: 'zone-maryanns-kitchen',
    label: "Mary Ann's Kitchen",
    name: "Mary Ann's Kitchen",
    type: 'lounge',
    privacy_default: 'open',
    capacity: 8,
    bookable: true,
    x: 660, y: 380, w: 480, h: 200,
    metadata: { specialty: 'Coconut cream pie. Always the coconut cream pie.' },
  },
  {
    zone_id: 'zone-the-lagoon',
    label: 'The Lagoon',
    name: 'The Lagoon',
    type: 'open',
    privacy_default: 'open',
    capacity: 12,
    bookable: true,
    x: 60, y: 520, w: 560, h: 220,
    metadata: { purpose: 'All-hands rescue planning. BYO life vest.' },
  },
];

(async () => {
  // ── Find-or-create the floor ──────────────────────────────────────────
  const existingFloors = asArr(await api(OWNER, 'GET', '/floors'));
  let floor = existingFloors.find((f) => f.name === FLOOR.name);

  const layout = {
    width: FLOOR.width,
    height: FLOOR.height,
    zones: ROOMS.map((r) => ({
      id: r.zone_id,
      shape: 'rect',
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      label: r.label,
    })),
    walls: [],
  };

  let floorCreated = false;
  if (!floor) {
    floor = await api(OWNER, 'POST', '/floors', {
      name: FLOOR.name,
      slug: FLOOR.slug,
      layout,
      position: 0,
      is_default: true,
    });
    floorCreated = true;
    console.log(`floor: ${FLOOR.name} (${floor.id})`);
  } else {
    console.log(`floor exists: ${FLOOR.name} (${floor.id})`);
  }

  // ── Find-or-create each room on the floor ─────────────────────────────
  // GET /floors/:id returns a rooms[] summary (id, name, zone_id). Use it to
  // skip rooms that already exist by name (idempotency).
  const floorDetail = await api(OWNER, 'GET', `/floors/${floor.id}`);
  const existingRoomNames = new Set((floorDetail.rooms ?? []).map((r) => r.name));

  let roomsMade = 0;
  let roomsSkipped = 0;
  const failures = [];

  for (const room of ROOMS) {
    if (existingRoomNames.has(room.name)) {
      console.log(`  room exists: ${room.name}`);
      roomsSkipped++;
      continue;
    }
    const body = {
      name: room.name,
      type: room.type,
      floor_id: floor.id,
      zone_id: room.zone_id,
      privacy_default: room.privacy_default,
      capacity: room.capacity,
      bookable: room.bookable,
      ...(room.who ? { owner_id: CAST[room.who] } : {}),
      ...(room.metadata ? { metadata: room.metadata } : {}),
    };
    try {
      const created = await api(OWNER, 'POST', '/rooms', body);
      console.log(`  + room: ${room.name} [${room.type}] (${created.id})`);
      roomsMade++;
    } catch (e) {
      console.log(`  room FAILED: ${room.name} — ${e.message}`);
      failures.push({ room: room.name, error: e.message });
    }
  }

  console.log(
    `\nBureau seed done: floor ${floorCreated ? 'created' : 'existed'} (${floor.id}); ` +
      `${roomsMade} rooms created, ${roomsSkipped} already present, ${failures.length} failed.`,
  );
  if (failures.length > 0) {
    console.log('FAILURES:', JSON.stringify(failures, null, 2));
    process.exit(1);
  }
})().catch((e) => {
  console.error('bureau seed failed:', e.message);
  process.exit(1);
});
