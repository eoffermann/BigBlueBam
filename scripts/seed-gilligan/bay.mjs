/**
 * Gilligan's Island themed Bay (media review) seed — UNIFIED model.
 *
 * Bin is the single file store; Bay reviews Bin media. So this seeder uploads
 * real media bytes into BIN (a small PNG poster + a short WAV jingle), organized
 * in a "Rescue Creative" folder and tagged, marks them clean, then resolves a
 * Bay review for each (find-or-create) and seeds frame/region/timecode
 * annotations + per-reviewer decisions — including the Professor as automated QC.
 *
 * Runs inside the api container (reaches bin-api:4016 + bay-api:4017 + the DB):
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bay.mjs
 */

import postgres from 'postgres';

const BIN = 'http://bin-api:4016/v1';
const BAY = 'http://bay-api:4017/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}` };
}
function Hjson(who) {
  return { ...H(who), 'Content-Type': 'application/json' };
}
async function jpost(url, who, body) {
  const r = await fetch(url, { method: 'POST', headers: Hjson(who), body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${url} -> ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data ?? d;
}
async function jput(url, who, body) {
  const r = await fetch(url, { method: 'PUT', headers: Hjson(who), body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PUT ${url} -> ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data ?? d;
}
async function jget(url, who) {
  const r = await fetch(url, { headers: H(who) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data ?? d;
}

// ── Tiny valid media generators (no external tools) ─────────────────────────

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
async function makePng(width, height, [r, g, b]) {
  const zlib = await import('node:zlib');
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function makeWav(seconds, freq, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000);
    data.writeInt16LE(s, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ── Bin (file store) + Bay (review) helpers ─────────────────────────────────

async function findOrCreateBinFolder(who, name) {
  const folders = await jget(`${BIN}/folders`, who);
  const existing = folders.find((f) => f.name === name);
  if (existing) return existing.id;
  return (await jpost(`${BIN}/folders`, who, { name })).id;
}
async function binCreate(who, name, contentType, tags, folderId) {
  return jpost(`${BIN}/assets`, who, { name, content_type: contentType, tags, folder_id: folderId, visibility: 'organization' });
}
async function binUpload(who, id, name, contentType, buf) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: contentType }), name);
  const r = await fetch(`${BIN}/assets/${id}/upload`, { method: 'POST', headers: H(who), body: fd });
  if (!r.ok) throw new Error(`upload ${name} -> ${r.status}`);
}

// ── Themed media items ──────────────────────────────────────────────────────

const ITEMS = [
  {
    name: 'rescue-beacon-promo.png',
    content_type: 'image/png',
    tags: ['rescue', 'promo'],
    bytes: () => makePng(480, 270, [13, 148, 136]),
    annotations: [
      { who: 'skipper', anchor: { type: 'region', x: 0.4, y: 0.15, w: 0.2, h: 0.12 }, body: 'Make the SOS bigger and brighter.' },
      { who: 'professor', anchor: { type: 'region', x: 0.05, y: 0.85, w: 0.3, h: 0.05 }, body: '[Auto-QC] Color space sRGB, 480×270, no slate.' },
    ],
    decisions: [
      { who: 'skipper', decision: 'changes_requested', comment: 'Bigger SOS, then ship.' },
      { who: 'howell', decision: 'approved', comment: 'Splendid. Bill it to the estate.' },
    ],
  },
  {
    name: 'coconut-radio-jingle.wav',
    content_type: 'audio/wav',
    tags: ['audio', 'jingle'],
    bytes: () => makeWav(3, 440),
    annotations: [
      { who: 'maryann', anchor: { type: 'timerange', start_sec: 0.0, end_sec: 1.5 }, body: 'Love the ukulele intro!' },
      { who: 'professor', anchor: { type: 'timerange', start_sec: 0.0, end_sec: 3.0 }, body: '[Auto-QC] Peak -6 dBFS, mono, 8 kHz.' },
    ],
    decisions: [{ who: 'howell', decision: 'approved', comment: 'Catchy. Approved.' }],
  },
];

async function main() {
  if (!KEYS.skipper) throw new Error('GKEYS missing the skipper key; run via run-all.mjs');
  const folderId = await findOrCreateBinFolder('skipper', 'Rescue Creative');
  const existing = await jget(`${BIN}/assets`, 'skipper');
  const byName = new Set(existing.map((a) => a.name));

  const cleanIds = [];
  let created = 0;
  let skipped = 0;
  for (const item of ITEMS) {
    if (byName.has(item.name)) {
      console.log(`  = ${item.name} (already present)`);
      skipped += 1;
      continue;
    }
    // 1. media bytes land in Bin (the file store), foldered + tagged.
    const binAsset = await binCreate('skipper', item.name, item.content_type, item.tags, folderId);
    await binUpload('skipper', binAsset.id, item.name, item.content_type, await item.bytes());
    cleanIds.push(binAsset.id);
    // mark clean now so it is immediately reviewable (trusted seed bytes).
    if (process.env.DATABASE_URL) {
      const sql = postgres(process.env.DATABASE_URL, { max: 1 });
      try {
        await sql`UPDATE bin_assets SET scan_status='clean' WHERE id = ${binAsset.id}`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    // 2. open the Bay review for that Bin asset (find-or-create + initial version).
    //    Re-read the bin asset post-upload to capture its current_version_id.
    const fresh = await jget(`${BIN}/assets/${binAsset.id}`, 'skipper');
    const resolveBody = { bin_asset_id: binAsset.id, name: item.name, content_type: item.content_type };
    if (fresh.current_version_id) resolveBody.bin_version_id = fresh.current_version_id;
    const bayAsset = await jpost(`${BAY}/review/resolve`, 'skipper', resolveBody);
    const versions = await jget(`${BAY}/assets/${bayAsset.id}/versions`, 'skipper');
    const vid = versions[0]?.id;
    // 3. seed annotations + decisions from multiple cast reviewers.
    for (const a of item.annotations) {
      await jpost(`${BAY}/versions/${vid}/annotations`, a.who, { anchor: a.anchor, body: a.body });
    }
    for (const d of item.decisions) {
      await jput(`${BAY}/versions/${vid}/decision`, d.who, { decision: d.decision, comment: d.comment });
    }
    created += 1;
    console.log(`  + ${item.name} → Bin asset ${binAsset.id} → Bay review ${bayAsset.id} (${item.annotations.length} annotations, ${item.decisions.length} decisions)`);
  }

  console.log(`bay.mjs done: ${created} media created, ${skipped} already present.`);
}

main().catch((err) => {
  console.error(`bay.mjs ERROR: ${err.message}`);
  process.exit(1);
});
