/**
 * Gilligan's Island themed Board (infinite-canvas whiteboard) seed.
 *
 * The castaways crowd around a sand-and-driftwood whiteboard to plot their
 * rescue (and the Howells' next gala). Each board is a "war room" canvas
 * stuffed with sticky notes, text headers, and labeled rectangle "shapes"
 * (Board has no dedicated shape primitive — a sticky IS a rectangle with a
 * label, which is exactly what a layout/flow box wants).
 *
 * Authorship note: board-api only lets a board's creator (or an explicit
 * edit-collaborator / org admin) add elements — a plain org member can VIEW
 * an org-visible board but not draw on it. So per-element `who` tags below
 * are honored only when they match the board owner; everything else is
 * authored by the owner. Cross-cast authorship therefore lives at the board
 * level (Skipper owns the escape brainstorm, Lovey the luau, the Professor
 * the rescue flow + raft sketch).
 *
 * Idempotent: a board is matched by exact (case-insensitive) name; if it
 * already has elements its contents are left alone.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/board.mjs
 * (The api container can reach the internal board-api host; cast API keys
 *  authenticate via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 */

const BOARD_API = 'http://board-api:4008/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (kept in sync with scripts/seed-gilligan/bam.mjs).
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
  gilligan: '0f47c55f-4c7d-4100-a00b-ca131a1e864d',
  maryann: 'd2835cc4-8ee9-4a27-b43e-84ab19a21450',
  ginger: 'c8926754-2a93-4bd6-bf20-5b1f87e27385',
  howell: '414d283d-f13b-4608-91db-dfd024db4064',
  lovey: '0ddd0b3e-4de3-4077-a905-07878dc43960',
};

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}
async function api(who, method, path, body) {
  const r = await fetch(`${BOARD_API}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 240)}`);
  }
  return data.data ?? data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// ---------------------------------------------------------------------------
// Element builders. Each element carries `who` (the cast member who "drew" it,
// authenticated via their Bearer key) so authorship spreads across the crew.
//   sticky: { kind:'sticky', who, text, x, y, color?, width?, height? }
//   text:   { kind:'text',   who, text, x, y, font_size?, color? }
// ---------------------------------------------------------------------------
const S = (who, text, x, y, color, width, height) =>
  ({ kind: 'sticky', who, text, x, y, color, width, height });
const T = (who, text, x, y, font_size, color) =>
  ({ kind: 'text', who, text, x, y, font_size, color });

// Sticky color hex values (board stores raw hex; mirrors the MCP color map).
const C = {
  yellow: '#FFEB3B',
  green: '#4CAF50',
  blue: '#2196F3',
  red: '#F44336',
  purple: '#9C27B0',
  orange: '#FF9800',
  tan: '#D7CCC8',
};

const BOARDS = [
  {
    name: 'Ways Off the Island',
    owner: 'skipper',
    description: 'Castaway brainstorm: every half-baked escape plan, ranked by how badly Gilligan can ruin it.',
    elements: [
      T('skipper', 'WAYS OFF THE ISLAND  (brainstorm — no idea too dumb… ok, some are)', 40, 20, 28, '#1A237E'),
      T('skipper', '— Front-runners —', 60, 90, 18, '#33691E'),
      S('gilligan', 'Build a raft\n(little buddy steers? NO.)', 60, 130, C.yellow),
      S('skipper', 'Signal passing planes\nwith the big mirror', 300, 130, C.yellow),
      S('professor', 'Coconut radio\n(I can rig a receiver)', 540, 130, C.green),
      T('maryann', '— Long shots —', 60, 380, 18, '#33691E'),
      S('maryann', 'Message in a bottle\n(I have 100 corks)', 60, 420, C.blue),
      S('professor', 'Train the dolphins\nto tow us to Hawaii', 300, 420, C.blue),
      S('howell', 'Ask Mr. Howell\nto buy us a boat', 540, 420, C.orange),
      S('lovey', 'Charter a yacht, darling.\nMoney is no object.', 780, 420, C.orange),
      S('ginger', 'Flag down a film crew\nscouting locations', 780, 130, C.purple),
      T('skipper', 'Whatever we pick: keep Gilligan AWAY from the controls.', 60, 690, 16, '#B71C1C'),
    ],
  },
  {
    name: 'Howell Luau — Layout',
    owner: 'lovey',
    description: 'Mrs. Howell\'s seating-and-staging diagram for the lagoon gala. Every torch placed by hand.',
    elements: [
      T('lovey', 'HOWELL LUAU — LAGOON LAYOUT (final, darling)', 40, 20, 26, '#4A148C'),
      // Footprint boxes laid out like a venue map.
      S('lovey', 'STAGE\n(hula floor show)', 360, 110, C.purple, 260, 130),
      S('ginger', 'DANCE FLOOR\n(packed sand, raked smooth)', 330, 300, C.tan, 320, 160),
      S('maryann', 'BUFFET TABLE\n(roast pig + fruit)', 60, 300, C.orange, 220, 140),
      S('howell', 'HOWELL CABANA\n(reserved — VIPs only)', 700, 300, C.blue, 230, 140),
      // Tiki torches ringing the perimeter.
      S('gilligan', 'Tiki torch', 60, 110, C.red, 110, 110),
      S('gilligan', 'Tiki torch', 230, 110, C.red, 110, 110),
      S('gilligan', 'Tiki torch', 700, 110, C.red, 110, 110),
      S('gilligan', 'Tiki torch', 870, 110, C.red, 110, 110),
      S('gilligan', 'Tiki torch', 60, 500, C.red, 110, 110),
      S('gilligan', 'Tiki torch', 870, 500, C.red, 110, 110),
      T('howell', 'Budget: irrelevant. Bill it to the Howell estate.', 360, 500, 16, '#1B5E20'),
    ],
  },
  {
    name: 'Rescue Signal Plan',
    owner: 'professor',
    description: 'The Professor\'s end-to-end signaling flow: fire to mirror to smoke to a HELP the size of the beach.',
    elements: [
      T('professor', 'RESCUE SIGNAL PLAN — escalation flow', 40, 20, 26, '#01579B'),
      // A left-to-right flow. Boxes + arrow labels read as a pipeline.
      S('skipper', 'STEP 1\nSignal fire\non Lookout Point', 60, 120, C.red, 220, 150),
      T('professor', '→ if no ship by dusk →', 300, 175, 16, '#37474F'),
      S('professor', 'STEP 2\nCoconut-mirror\nflash array', 470, 120, C.yellow, 220, 150),
      T('professor', '→ if overcast →', 710, 175, 16, '#37474F'),
      S('maryann', 'STEP 3\nGreen-wood smoke\n(thick + dark)', 470, 340, C.green, 220, 150),
      T('professor', '→ last resort →', 300, 395, 16, '#37474F'),
      S('gilligan', 'STEP 4\nStamp HELP\nacross the beach', 60, 340, C.blue, 220, 150),
      T('skipper', 'Owner: Skipper (fire) · Professor (mirror/smoke) · all hands (HELP)', 60, 540, 15, '#4E342E'),
      S('professor', 'Rotation: 24/7 watch,\n4-hour shifts', 760, 340, C.purple, 220, 150),
    ],
  },
  {
    name: 'Raft v3 Concept Sketch',
    owner: 'professor',
    description: 'Annotated concept for the third raft. (v1 sank. v2 sank faster. v3 will float — probably.)',
    elements: [
      T('professor', 'RAFT v3 — CONCEPT SKETCH (learnings from v1 & v2)', 40, 20, 24, '#263238'),
      S('gilligan', 'BOW\n(pointy end —\nthis goes first)', 80, 110, C.tan, 180, 130),
      S('professor', 'DECK\n8x bamboo,\ndouble-lashed', 300, 110, C.tan, 220, 140),
      S('skipper', 'STERN\n(steering oar —\nNOT Gilligan)', 560, 110, C.tan, 200, 130),
      S('ginger', 'SAIL\n(Howell linen,\nmonogrammed)', 300, 300, C.purple, 220, 140),
      S('professor', 'OUTRIGGERS\nx2 for stability\n(v2 lacked these)', 80, 300, C.green, 180, 140),
      S('maryann', 'PROVISIONS\ncoconuts + water\nlashed amidships', 560, 300, C.orange, 200, 140),
      T('professor', 'v1 failure: under-lashed.  v2 failure: no outriggers.  v3: fixed both.', 80, 470, 16, '#B71C1C'),
    ],
  },
];

(async () => {
  let boardsCreated = 0;
  let boardsExisting = 0;
  let elementsMade = 0;
  const report = [];
  const failures = [];

  for (const def of BOARDS) {
    // Find-or-create as the OWNER. The owner can always see their own board,
    // and org visibility lets the rest of the crew see it too.
    let b;
    try {
      const found = asArr(await api(def.owner, 'GET', `/boards?search=${encodeURIComponent(def.name)}&limit=50`));
      b = found.find((x) => x.name.toLowerCase() === def.name.toLowerCase());
    } catch (e) {
      failures.push(`list "${def.name}": ${e.message}`);
      continue;
    }

    if (!b) {
      try {
        b = await api(def.owner, 'POST', '/boards', {
          name: def.name,
          description: def.description,
          background: 'dots',
          visibility: 'organization',
        });
        boardsCreated++;
        console.log(`board created: ${def.name} (${b.id}) owner=${def.owner}`);
      } catch (e) {
        failures.push(`create "${def.name}": ${e.message}`);
        continue;
      }
    } else {
      boardsExisting++;
      console.log(`board exists: ${def.name} (${b.id})`);
    }

    // Idempotency is per-element: the authoritative scene is the export blob
    // (the snapshot-table read is only a partial mirror), so we collect the
    // text of every live element already on the canvas and skip any planned
    // element whose text is already there. Re-runs are therefore no-ops, and
    // a partially-seeded board gets topped up rather than skipped or doubled.
    const present = new Set();
    try {
      const exported = await api(def.owner, 'POST', `/boards/${b.id}/export`, { format: 'json' });
      const scene = exported?.scene ?? {};
      for (const e of (scene.elements ?? [])) {
        if (e && e.isDeleted !== true && typeof e.text === 'string') present.add(e.text);
      }
    } catch (e) {
      failures.push(`read scene "${def.name}": ${e.message}`);
    }

    // Seed elements serially (each POST loads + re-saves the scene, so order
    // matters — concurrent writes would clobber each other). All writes go
    // through the board OWNER: board-api forbids non-creator edits, so the
    // per-element `who` is honored only when it equals the owner.
    let made = 0;
    let skipped = 0;
    for (const el of def.elements) {
      if (present.has(el.text)) {
        skipped++;
        continue;
      }
      const author = el.who === def.owner ? el.who : def.owner;
      try {
        if (el.kind === 'sticky') {
          await api(author, 'POST', `/boards/${b.id}/elements/sticky`, {
            text: el.text,
            x: el.x,
            y: el.y,
            color: el.color ?? C.yellow,
            ...(el.width ? { width: el.width } : {}),
            ...(el.height ? { height: el.height } : {}),
          });
        } else {
          await api(author, 'POST', `/boards/${b.id}/elements/text`, {
            text: el.text,
            x: el.x,
            y: el.y,
            ...(el.font_size ? { font_size: el.font_size } : {}),
            ...(el.color ? { color: el.color } : {}),
          });
        }
        made++;
        elementsMade++;
        present.add(el.text);
      } catch (e) {
        failures.push(`element on "${def.name}" (${el.kind}: ${String(el.text).slice(0, 24)}…): ${e.message}`);
      }
    }
    console.log(`  + ${made} new, ${skipped} already present (of ${def.elements.length} planned)`);
    report.push({
      board: def.name,
      id: b.id,
      owner: def.owner,
      elements: made,
      skipped,
      status: made > 0 ? 'seeded' : 'kept',
    });
  }

  console.log('\n=== Board seed summary ===');
  console.log(`boards: ${boardsCreated} created, ${boardsExisting} already existed`);
  console.log(`elements created this run: ${elementsMade}`);
  for (const r of report) {
    console.log(`  ${r.status.padEnd(7)} ${r.board} — +${r.elements} new, ${r.skipped} kept (owner ${r.owner}, id ${r.id})`);
  }
  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
  } else {
    console.log('\nNo failures.');
  }
})().catch((e) => {
  console.error('board seed failed:', e.message);
  process.exit(1);
});
