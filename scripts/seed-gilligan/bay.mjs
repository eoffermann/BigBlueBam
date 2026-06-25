/**
 * Gilligan's Island themed Bay (media review & approval) seed.
 *
 * The castaways review their rescue-promo creative in Bay: an image, a video
 * cut, and an audio jingle, each as a versioned review item with frame/region/
 * timecode annotations and per-reviewer decisions — including the Professor
 * acting as the "automated QC" reviewer. Demonstrates the review pipeline and
 * gives the API/MCP layer real, on-brand data.
 *
 * Idempotent: assets matched by name; skipped if already present.
 *
 * Runs inside the api container (reaches bay-api:4017 on the docker network):
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bay.mjs
 */

const BAY = 'http://bay-api:4017/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}
async function api(who, method, path, body) {
  const r = await fetch(`${BAY}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data.data ?? data;
}
const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// Themed review items: name, media_kind, version media_meta, annotations, decisions.
const ITEMS = [
  {
    name: 'Rescue Beacon Promo (poster)',
    media_kind: 'image',
    meta: { width: 1080, height: 1350, codec: 'png' },
    annotations: [
      { who: 'skipper', anchor: { type: 'region', x: 0.4, y: 0.15, w: 0.2, h: 0.12 }, body: 'Make the SOS bigger and brighter.' },
      { who: 'professor', anchor: { type: 'region', x: 0.05, y: 0.85, w: 0.3, h: 0.05 }, body: '[Auto-QC] Color space is sRGB, resolution OK, no slate.' },
    ],
    decisions: [
      { who: 'skipper', decision: 'changes_requested', comment: 'Bigger SOS, then ship.' },
      { who: 'howell', decision: 'approved', comment: 'Splendid. Bill it to the estate.' },
    ],
  },
  {
    name: 'Castaway Rescue Reel (cut 1)',
    media_kind: 'video',
    meta: { width: 1920, height: 1080, duration_sec: 92, codec: 'h264', fps: 24 },
    annotations: [
      { who: 'ginger', anchor: { type: 'timerange', start: 12.5, end: 18.0 }, body: 'Hold on the lagoon shot a beat longer.' },
      { who: 'professor', anchor: { type: 'frame', frame: 480 }, body: '[Auto-QC] Loudness -14 LUFS, within spec.' },
    ],
    decisions: [{ who: 'skipper', decision: 'changes_requested', comment: 'Tighten the open.' }],
  },
  {
    name: 'Coconut Radio Jingle (mix v2)',
    media_kind: 'audio',
    meta: { duration_sec: 30, codec: 'aac', sample_rate: 48000 },
    annotations: [
      { who: 'maryann', anchor: { type: 'timerange', start: 0.0, end: 4.0 }, body: 'Love the ukulele intro!' },
    ],
    decisions: [{ who: 'howell', decision: 'approved', comment: 'Catchy. Approved.' }],
  },
];

async function main() {
  if (!KEYS.skipper) throw new Error('GKEYS missing the skipper key; run via run-all.mjs');
  const existing = asArr(await api('skipper', 'GET', '/assets'));
  const byName = new Set(existing.map((a) => a.name));

  let created = 0;
  let skipped = 0;
  for (const item of ITEMS) {
    if (byName.has(item.name)) {
      console.log(`  = ${item.name} (already present)`);
      skipped += 1;
      continue;
    }
    const asset = await api('skipper', 'POST', '/assets', { name: item.name, media_kind: item.media_kind });
    const version = await api('skipper', 'POST', `/assets/${asset.id}/versions`, { media_meta: item.meta });
    const vid = version.version?.id ?? version.id;
    for (const a of item.annotations) {
      await api(a.who, 'POST', `/versions/${vid}/annotations`, { anchor: a.anchor, body: a.body });
    }
    for (const d of item.decisions) {
      await api(d.who, 'PUT', `/versions/${vid}/decision`, { decision: d.decision, comment: d.comment });
    }
    created += 1;
    console.log(`  + ${item.name} (${asset.id}) — ${item.annotations.length} annotations, ${item.decisions.length} decisions`);
  }

  console.log(`bay.mjs done: ${created} created, ${skipped} already present.`);
}

main().catch((err) => {
  console.error(`bay.mjs ERROR: ${err.message}`);
  process.exit(1);
});
