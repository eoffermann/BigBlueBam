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

// A tiny self-contained animated GLB ("Rescue Beacon": body + base + a spinning
// beacon light with a BeaconSpin rotation clip), authored with gltf-transform and
// base64-embedded so the FBX/3D model-review demo seeds without an external binary
// or toolchain. The model-process worker probes it (counts/bounds/animation) and
// serves it as the GLB proxy the three.js viewer loads.
const RESCUE_BEACON_GLB_B64 =
  'Z2xURgIAAAAcEAAAtAkAAEpTT057ImFzc2V0Ijp7ImdlbmVyYXRvciI6ImdsVEYtVHJhbnNmb3JtIHY0LjQuMCIsInZlcnNpb24iOiIyLjAifSwiYWNjZXNzb3JzIjpbeyJ0eXBlIjoiVkVDMyIsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjozNiwibWF4IjpbMSwwLjY5OTk5OTk4ODA3OTA3MSwwLjYwMDAwMDAyMzg0MTg1NzldLCJtaW4iOlstMSwtMC42OTk5OTk5ODgwNzkwNzEsLTAuNjAwMDAwMDIzODQxODU3OV0sImJ1ZmZlclZpZXciOjAsImJ5dGVPZmZzZXQiOjB9LHsidHlwZSI6IlNDQUxBUiIsImNvbXBvbmVudFR5cGUiOjUxMjMsImNvdW50IjozNiwiYnVmZmVyVmlldyI6MSwiYnl0ZU9mZnNldCI6MH0seyJ0eXBlIjoiU0NBTEFSIiwiY29tcG9uZW50VHlwZSI6NTEyMywiY291bnQiOjM2LCJidWZmZXJWaWV3IjoxLCJieXRlT2Zmc2V0Ijo3Mn0seyJ0eXBlIjoiU0NBTEFSIiwiY29tcG9uZW50VHlwZSI6NTEyMywiY291bnQiOjM2LCJidWZmZXJWaWV3IjoxLCJieXRlT2Zmc2V0IjoxNDR9LHsidHlwZSI6IlZFQzMiLCJjb21wb25lbnRUeXBlIjo1MTI2LCJjb3VudCI6MzYsIm1heCI6WzEuMjk5OTk5OTUyMzE2Mjg0MiwwLjA3OTk5OTk5ODIxMTg2MDY2LDAuODUwMDAwMDIzODQxODU3OV0sIm1pbiI6Wy0xLjI5OTk5OTk1MjMxNjI4NDIsLTAuMDc5OTk5OTk4MjExODYwNjYsLTAuODUwMDAwMDIzODQxODU3OV0sImJ1ZmZlclZpZXciOjIsImJ5dGVPZmZzZXQiOjB9LHsidHlwZSI6IlZFQzMiLCJjb21wb25lbnRUeXBlIjo1MTI2LCJjb3VudCI6MzYsIm1heCI6WzAuMjE5OTk5OTk4ODA3OTA3MSwwLjE1OTk5OTk5NjQyMzcyMTMsMC4yMTk5OTk5OTg4MDc5MDcxXSwibWluIjpbLTAuMjE5OTk5OTk4ODA3OTA3MSwtMC4xNTk5OTk5OTY0MjM3MjEzLC0wLjIxOTk5OTk5ODgwNzkwNzFdLCJidWZmZXJWaWV3IjozLCJieXRlT2Zmc2V0IjowfSx7InR5cGUiOiJTQ0FMQVIiLCJjb21wb25lbnRUeXBlIjo1MTI2LCJjb3VudCI6NSwibWF4IjpbMl0sIm1pbiI6WzBdLCJidWZmZXJWaWV3Ijo0LCJieXRlT2Zmc2V0IjowfSx7InR5cGUiOiJWRUM0IiwiY29tcG9uZW50VHlwZSI6NTEyNiwiY291bnQiOjUsImJ1ZmZlclZpZXciOjQsImJ5dGVPZmZzZXQiOjIwfV0sImJ1ZmZlclZpZXdzIjpbeyJidWZmZXIiOjAsImJ5dGVPZmZzZXQiOjAsImJ5dGVMZW5ndGgiOjQzMiwiYnl0ZVN0cmlkZSI6MTIsInRhcmdldCI6MzQ5NjJ9LHsiYnVmZmVyIjowLCJieXRlT2Zmc2V0Ijo0MzIsImJ5dGVMZW5ndGgiOjIxNiwidGFyZ2V0IjozNDk2M30seyJidWZmZXIiOjAsImJ5dGVPZmZzZXQiOjY0OCwiYnl0ZUxlbmd0aCI6NDMyLCJieXRlU3RyaWRlIjoxMiwidGFyZ2V0IjozNDk2Mn0seyJidWZmZXIiOjAsImJ5dGVPZmZzZXQiOjEwODAsImJ5dGVMZW5ndGgiOjQzMiwiYnl0ZVN0cmlkZSI6MTIsInRhcmdldCI6MzQ5NjJ9LHsiYnVmZmVyIjowLCJieXRlT2Zmc2V0IjoxNTEyLCJieXRlTGVuZ3RoIjoxMDB9XSwiYnVmZmVycyI6W3siYnl0ZUxlbmd0aCI6MTYxMn1dLCJtYXRlcmlhbHMiOlt7Im5hbWUiOiJCb2R5X21hdCIsInBick1ldGFsbGljUm91Z2huZXNzIjp7ImJhc2VDb2xvckZhY3RvciI6WzAuMDUsMC41LDAuNTUsMV0sInJvdWdobmVzc0ZhY3RvciI6MC42fX0seyJuYW1lIjoiQmFzZV9tYXQiLCJwYnJNZXRhbGxpY1JvdWdobmVzcyI6eyJiYXNlQ29sb3JGYWN0b3IiOlswLjEsMC4xLDAuMTIsMV0sInJvdWdobmVzc0ZhY3RvciI6MC42fX0seyJuYW1lIjoiQmVhY29uX21hdCIsInBick1ldGFsbGljUm91Z2huZXNzIjp7ImJhc2VDb2xvckZhY3RvciI6WzAuOTUsMC4yLDAu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rkdhvq5HYT4K1yO+rkdhvq5HYT4K1yM+rkdhvq5HYb4K1yO+rkdhvq5HYT4K1yM+rkdhvq5HYb4K1yM+rkdhvq5HYT4K1yO+rkdhPq5HYb4K1yO+rkdhPq5HYb4K1yM+rkdhPq5HYT4K1yO+rkdhPq5HYb4K1yM+rkdhPq5HYT4K1yM+rkdhPq5HYb4K1yO+rkdhPq5HYb4K1yO+rkdhvq5HYb4K1yM+rkdhvq5HYb4K1yO+rkdhPq5HYb4K1yM+rkdhvq5HYb4K1yM+rkdhPq5HYT4K1yO+rkdhvq5HYT4K1yO+rkdhPq5HYT4K1yM+rkdhPq5HYT4K1yO+rkdhvq5HYT4K1yM+rkdhPq5HYT4K1yM+rkdhvq5HYb4K1yO+rkdhPq5HYT4K1yO+rkdhPq5HYT4K1yO+rkdhvq5HYb4K1yO+rkdhPq5HYT4K1yO+rkdhvq5HYb4K1yO+rkdhvq5HYb4K1yM+rkdhvq5HYT4K1yM+rkdhvq5HYT4K1yM+rkdhPq5HYb4K1yM+rkdhvq5HYT4K1yM+rkdhPq5HYb4K1yM+rkdhPgAAAAAAAAA/AACAPwAAwD8AAABAAAAAAAAAAAAAAAAAAACAPwAAAADzBDU/AAAAAPMENT8AAAAAAACAPwAAAAAyMY0kAAAAAPMENT8AAAAA8wQ1vwAAAAAyMQ0lAAAAAAAAgL8=';
function makeModelGlb() {
  return Buffer.from(RESCUE_BEACON_GLB_B64, 'base64');
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
  {
    // 3D model review (Bay FBX feature). A small animated GLB; the model-process
    // worker probes + serves it as the GLB proxy the three.js viewer renders.
    name: 'rescue-beacon.glb',
    content_type: 'model/gltf-binary',
    tags: ['3d', 'model', 'rescue'],
    bytes: () => makeModelGlb(),
    annotations: [
      {
        who: 'professor',
        anchor: {
          type: 'viewpoint',
          camera: { position: [3, 2.6, 4], target: [0, 1, 0], up: [0, 1, 0], fov: 35, projection: 'perspective' },
          surface: { mode: 'geometry', node: 'Beacon', primitive: 0, tri: 2, bary: [0.3, 0.3, 0.4], local_point: [0, 1.7, 0], radius: 0.08 },
        },
        body: 'Beacon strobe mesh reads well from this angle; spin rate looks right for an SOS pattern.',
      },
      {
        who: 'skipper',
        anchor: {
          type: 'viewpoint',
          camera: { position: [0, 1.8, 5], target: [0, 0.9, 0], up: [0, 1, 0], fov: 35, projection: 'perspective' },
        },
        body: 'Widen the base so it stands in soft sand without tipping.',
      },
    ],
    decisions: [{ who: 'howell', decision: 'changes_requested', comment: 'Wider base, then approved.' }],
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
