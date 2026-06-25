/**
 * Gilligan's Island themed Bin (DAM + structured-data) seed.
 *
 * Seeds four structured-data assets into the Gilligan org so the Bin asset
 * library and the structured-data editor (grid + tree) have real, on-brand
 * content to demo and screenshot — one per supported format:
 *
 *   - daily-coconut-count.csv   (record / grid)   Gilligan's coconut tally
 *   - rescue-sightings.jsonl    (record / grid)   the Professor's sighting log
 *   - minnow-manifest.json      (tree)            the S.S. Minnow charter manifest
 *   - luau-menu.yaml            (tree)            Mr. Howell's luau menu
 *
 * Idempotent: assets are matched by name and skipped if already present.
 *
 * Runs inside the api container (reaches bin-api:4016 on the docker network and
 * the shared DATABASE_URL):
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bin.mjs
 *
 * Bytes go through Bin's proxied multipart upload (the default path; no
 * browser-reachable object store required). After upload, the four seeded assets
 * are marked scan_status='clean' directly in the DB so they are immediately
 * servable/readable for screenshots without waiting on the AV sweep — these are
 * trusted, hand-authored seed files.
 */

import postgres from 'postgres';

const BIN = 'http://bin-api:4016/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');
const OWNER = 'skipper'; // The Skipper owns the island records.

function authHeader() {
  return { Authorization: `Bearer ${KEYS[OWNER]}` };
}

async function listAssets() {
  const r = await fetch(`${BIN}/assets`, { headers: authHeader() });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GET /assets -> ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return Array.isArray(d) ? d : (d.data ?? []);
}

async function createAsset(name, contentType, opts = {}) {
  const r = await fetch(`${BIN}/assets`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      content_type: contentType,
      visibility: 'organization',
      folder_id: opts.folder_id ?? null,
      tags: opts.tags ?? [],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST /assets -> ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data;
}

async function findOrCreateFolder(name) {
  const r = await fetch(`${BIN}/folders`, { headers: authHeader() });
  const d = await r.json().catch(() => ({}));
  const existing = (Array.isArray(d) ? d : (d.data ?? [])).find((f) => f.name === name);
  if (existing) return existing.id;
  const cr = await fetch(`${BIN}/folders`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const cd = await cr.json().catch(() => ({}));
  if (!cr.ok) throw new Error(`POST /folders -> ${cr.status} ${JSON.stringify(cd).slice(0, 200)}`);
  return cd.data.id;
}

async function uploadBytes(assetId, name, contentType, text) {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: contentType }), name);
  // Note: do NOT set Content-Type — fetch adds the multipart boundary.
  const r = await fetch(`${BIN}/assets/${assetId}/upload`, {
    method: 'POST',
    headers: authHeader(),
    body: fd,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST /assets/${assetId}/upload -> ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data;
}

// ---------------------------------------------------------------------------
// Themed content
// ---------------------------------------------------------------------------

const CSV_COCONUTS = `date,gatherer,coconuts,ripe,notes
1964-09-26,Gilligan,42,31,"dropped 6 climbing down"
1964-09-27,Mary Ann,55,48,"found the good grove past the lagoon"
1964-09-28,Gilligan,12,9,"chased off by a crab"
1964-09-29,The Professor,38,38,"all ripe; saved for radio battery acid test"
1964-09-30,Skipper,61,52,"little buddy helped (mostly)"
1964-10-01,Mary Ann,49,40,"baked 3 cream pies"
`;

const JSONL_SIGHTINGS = [
  { date: '1964-09-26', spotter: 'The Professor', vessel: 'cargo freighter', bearing_deg: 84, confidence: 'low', signaled: false },
  { date: '1964-09-29', spotter: 'Ginger', vessel: 'pleasure yacht', bearing_deg: 112, confidence: 'medium', signaled: true },
  { date: '1964-10-02', spotter: 'Skipper', vessel: 'navy destroyer', bearing_deg: 47, confidence: 'high', signaled: true },
  { date: '1964-10-04', spotter: 'Gilligan', vessel: 'flying boat', bearing_deg: 200, confidence: 'low', signaled: false },
  { date: '1964-10-07', spotter: 'The Professor', vessel: 'research vessel', bearing_deg: 15, confidence: 'high', signaled: true },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

const JSON_MANIFEST = JSON.stringify(
  {
    vessel: 'S.S. Minnow',
    charter: { operator: 'Gilligan Travel Ltd', departed: 'Honolulu', tour_length_hours: 3, fateful: true },
    crew: [
      { role: 'captain', name: 'Jonas "Skipper" Grumby', certified: true },
      { role: 'first mate', name: 'Gilligan', certified: false },
    ],
    passengers: [
      { name: 'Thurston Howell III', cabin: 'A1', vip: true },
      { name: 'Lovey Howell', cabin: 'A1', vip: true },
      { name: 'Ginger Grant', cabin: 'B2', vip: false },
      { name: 'The Professor', cabin: 'B3', vip: false },
      { name: 'Mary Ann Summers', cabin: 'B4', vip: false },
    ],
    cargo: { coconuts: 0, radio: { brand: 'islander', working: true }, lifeboats: 1 },
  },
  null,
  2,
) + '\n';

const YAML_LUAU = `event: Howell Castaway Luau
host: Thurston Howell III
location: The Lagoon Clearing
torches: 24
courses:
  appetizers:
    - coconut shrimp (no shrimp; coconut)
    - seaweed crisps
  mains:
    - roast wild boar
    - Mary Ann's banana surprise
  desserts:
    - coconut cream pie
    - mango sorbet (when the freezer raft works)
beverages:
  - fresh coconut water
  - Mr. Howell's "emergency" champagne
seating:
  head_table:
    - Mr. Howell
    - Lovey Howell
  general: everyone else
notes: |
  Black tie optional. Gilligan is NOT allowed near the punch bowl
  after last time.
`;

const ASSETS = [
  { name: 'daily-coconut-count.csv', type: 'text/csv', text: CSV_COCONUTS, tags: ['provisions', 'daily-log'] },
  { name: 'rescue-sightings.jsonl', type: 'application/x-ndjson', text: JSONL_SIGHTINGS, tags: ['rescue', 'log'] },
  { name: 'minnow-manifest.json', type: 'application/json', text: JSON_MANIFEST, tags: ['vessel', 'manifest'] },
  { name: 'luau-menu.yaml', type: 'application/x-yaml', text: YAML_LUAU, tags: ['howell', 'event'] },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!KEYS[OWNER]) throw new Error('GKEYS missing the skipper key; run via run-all.mjs');
  const existing = await listAssets();
  const byName = new Set(existing.map((a) => a.name));
  // Organize the island records into a folder, tagged for search.
  const folderId = await findOrCreateFolder('Island Records');

  const seededIds = [];
  let created = 0;
  let skipped = 0;
  for (const a of ASSETS) {
    if (byName.has(a.name)) {
      console.log(`  = ${a.name} (already present)`);
      skipped += 1;
      continue;
    }
    const asset = await createAsset(a.name, a.type, { folder_id: folderId, tags: a.tags });
    await uploadBytes(asset.id, a.name, a.type, a.text);
    seededIds.push(asset.id);
    created += 1;
    console.log(`  + ${a.name} (${asset.id})`);
  }

  // Mark the freshly-seeded assets clean so they are immediately readable for
  // screenshots (trusted hand-authored seed files; the AV sweep would do this
  // within a minute anyway).
  if (seededIds.length > 0 && process.env.DATABASE_URL) {
    const sql = postgres(process.env.DATABASE_URL, { max: 1 });
    try {
      await sql`UPDATE bin_assets SET scan_status = 'clean' WHERE id IN ${sql(seededIds)}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    console.log(`  ✓ marked ${seededIds.length} asset(s) clean for serving`);
  }

  console.log(`bin.mjs done: ${created} created, ${skipped} already present.`);
}

main().catch((err) => {
  console.error(`bin.mjs ERROR: ${err.message}`);
  process.exit(1);
});
