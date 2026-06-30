/**
 * Gilligan's Island themed Blip (telemetry / log / profiling intake) seed.
 *
 * The castaways' rescue effort runs on a mobile app the Professor cobbled
 * together - "Rescue Beacon" - shipped for both iOS and Android. Blip is where
 * its runtime telemetry lands: crash dumps, frame timings, app logs, network
 * calls, and themed SOS pings. This seeder gives the Blip UI real, on-brand
 * content to demo and screenshot end to end:
 *
 *   - 2 tracked apps (Rescue Beacon iOS / Android), owned by the Professor,
 *     collection enabled, a 14-day default retention (+ a 90-day crash override),
 *     a seeded PII transform (drop castaway_gps, truncate radio_log), and a
 *     default rate limit.
 *   - 3 ingest keys per app (one active, one suspended, one revoked) so every
 *     key state renders in the key-management screen.
 *   - A deterministic backlog of a few thousand entries per app spread across
 *     the last 14 days, discovering the report types crash / fn_timing /
 *     app_log / net_request / sos_ping, with realistic level + elapsed_ms
 *     distributions.
 *   - A short run of base64 JPEG capture frames on a handful of bug_report /
 *     sos_ping entries under one session_id on iOS, so the capture strip and a
 *     one-click session timelapse have content.
 *   - Saved views ("Errors only", "Slow frames", + a default per type), and
 *     watches (match `slow-frame`, window `error-spike`) with one firing in
 *     history, plus a best-effort Bolt rule wiring `entry.matched` (slow-frame)
 *     into a castaway Banter channel - the §12.3 reactive loop.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * Everything is reproducible. Fixed object ids come from a uuid5-style hash of a
 * stable name (`uuid5('app:ios')`, …). The entry backlog is generated from a
 * seeded mulberry32 PRNG (never Math.random) against a single clock anchor read
 * ONCE from `BLIP_SEED_NOW` (RFC3339) or, absent that, captured once at start -
 * never `Date.now()` per row. So a wipe-and-reseed with the same `BLIP_SEED_NOW`
 * reproduces byte-identical payloads, levels, elapsed_ms, and timestamps. (The
 * `seq` cursor comes from the shared `blip_entry_seq` sequence and is the one
 * value that climbs across reseeds - that is by design; it orders durable-write
 * order, not content.)
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * The harness has no global `_seed` marker convention (it uses fixed-UUID /
 * natural-key find-or-create). Entries have no natural key, so each seeded row
 * carries `payload._seed = 'gilligan'` and the bulk backlog is skipped for an
 * app that already has any such row (idempotent at app granularity). Config
 * rows (apps, transforms, retention, keys, views, watches) use fixed ids with
 * ON CONFLICT DO NOTHING.
 *
 * Runs inside the api container (reaches the shared DATABASE_URL, the internal
 * bolt-api host, and the public blip ingest endpoint):
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/blip.mjs
 */

import postgres from 'postgres';
import { createHash, createHmac } from 'node:crypto';

// ── progress logging (CLAUDE.md: flushed, elapsed-stamped) ──────────────────
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg) => process.stdout.write(`[blip +${elapsed()}] ${msg}\n`);

const KEYS = JSON.parse(process.env.GKEYS || '{}');
const BOLT_API = 'http://bolt-api:4006/v1';
const BLIP_INGEST = 'http://blip-api:4018/ingest/v1';
const PEPPER = process.env.BLIP_INGEST_PEPPER || '';

// Cast user ids (kept in sync with the other seeders / run-all.mjs roster).
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
  howell: '414d283d-f13b-4608-91db-dfd024db4064',
};

// ── deterministic ids ───────────────────────────────────────────────────────
/** Stable uuid5-style id from a name (sha1 + version/variant bits). */
function uuid5(name) {
  const h = createHash('sha1').update(`blip-gilligan:${name}`).digest('hex').split('');
  h[12] = '5'; // version 5
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // variant 10xx
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// ── seeded PRNG (mulberry32) + distributions ────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
/** weighted pick over [[value, weight], ...]. */
function weighted(rng, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}
/** standard normal via Box-Muller (uses the seeded rng). */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** log-normal elapsed_ms: median = exp(mu), spread = sigma. */
function logNormalMs(rng, mu, sigma) {
  return Math.round(Math.exp(mu + sigma * gaussian(rng)) * 10) / 10;
}

// ── tracked apps + themed content ───────────────────────────────────────────
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR' +
  'CAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
  'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK' +
  'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWG' +
  'h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl' +
  '5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
  'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk' +
  'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE' +
  'hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk' +
  '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD/2Q==';

const APPS = [
  {
    key: 'ios',
    id: uuid5('app:ios'),
    name: 'Rescue Beacon (iOS)',
    description: "The Professor's iOS rescue-signal app. Coconut-powered telemetry.",
    platform: 'ios',
    appVersions: ['1.4.0', '1.4.1', '1.4.2', '1.5.0-beta'],
    seed: 0x5eed10,
    sessions: ['lagoon-AM', 'lagoon-PM', 'signal-fire', 'raft-trial', 'radio-watch', 'howell-suite'],
    captures: true,
  },
  {
    key: 'android',
    id: uuid5('app:android'),
    name: 'Rescue Beacon (Android)',
    description: "The Android build of the rescue beacon. Same coconuts, different OS.",
    platform: 'android',
    appVersions: ['1.3.7', '1.4.0', '1.4.1'],
    seed: 0x5eed20,
    sessions: ['beach-walk', 'lookout-pt', 'tide-sensor', 'pedal-gen', 'night-watch'],
    captures: false,
  },
];

const APP_LOG_MESSAGES = [
  'Radio receiver warming up',
  'Coconut battery at 62%',
  'GPS fix acquired',
  'Signal fire telemetry uploaded',
  'Lagoon tide sensor reading recorded',
  'Pedal generator cadence nominal',
  'Howell yacht beacon not found in range',
  'Bamboo raft buoyancy check passed',
  "Mary Ann's pie timer started",
  'Reconnecting to coconut mesh',
  'Star-fix navigation packet computed',
  'Message-bottle queue flushed to tide',
];
const LOGGERS = ['radio', 'power', 'gps', 'sensors', 'net', 'ui', 'nav'];
const FN_NAMES = ['decodeFrame', 'renderMap', 'encodeSosPacket', 'pollGps', 'drawSignalFire', 'computeDrift', 'syncTelemetry', 'paintLagoon'];
const NET_URLS = ['/api/rescue/ping', '/api/weather/tides', '/api/howell/funds', '/api/sat/uplink', '/api/coconut/mesh', '/api/beacon/register'];
const CRASH_ERRORS = [
  'NullCoconutReferenceException',
  'RadioTubeOverheatError',
  'RaftBuoyancyAssertionFailed',
  'GpsLostAtSeaException',
  'PieTimerDeadlockError',
];
const RADIO_LOG =
  'CQ CQ CQ de S.S. MINNOW - seven souls, uncharted island, request immediate rescue. ' +
  'Reward offered, substantial, signed Thurston Howell III. Gilligan stop pedaling unevenly. ' +
  'Repeat: seven souls. Coordinates to follow once the Professor finishes the star fix. ' +
  'Over. (this line runs long on purpose so the truncate transform has something to bite)';

const REPORT_TYPE_WEIGHTS = [
  ['app_log', 45],
  ['fn_timing', 30],
  ['net_request', 15],
  ['sos_ping', 7],
  ['crash', 3],
];

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/** Build one synthetic entry for an app at a given received_at. */
function makeEntry(app, rng, receivedAt) {
  const reportType = weighted(rng, REPORT_TYPE_WEIGHTS);
  const sessionId = pick(rng, app.sessions);
  const appVersion = pick(rng, app.appVersions);
  // client_ts: a little before the server received it.
  const clientTs = new Date(receivedAt.getTime() - Math.floor(rng() * 2000) - 50);

  const payload = {
    report_type: reportType,
    session_id: sessionId,
    app_version: appVersion,
    platform: app.platform,
    timestamp: clientTs.toISOString(),
    _seed: 'gilligan',
  };
  let level = null;
  let elapsedMs = null;

  if (reportType === 'app_log') {
    level = weighted(rng, [['debug', 40], ['info', 35], ['warn', 15], ['error', 8], ['fatal', 2]]);
    payload.message = pick(rng, APP_LOG_MESSAGES);
    payload.logger = pick(rng, LOGGERS);
    if (rng() < 0.12) payload.radio_log = RADIO_LOG; // transform truncate target
  } else if (reportType === 'fn_timing') {
    elapsedMs = logNormalMs(rng, Math.log(10), 0.85); // ~10ms median, fat tail
    payload.fn = pick(rng, FN_NAMES);
    payload.frame = Math.floor(rng() * 5000);
    payload.elapsed_ms = elapsedMs;
    level = elapsedMs > 16 ? (elapsedMs > 100 ? 'error' : 'warn') : 'debug';
  } else if (reportType === 'net_request') {
    elapsedMs = logNormalMs(rng, Math.log(120), 0.7); // ~120ms median latency
    const status = weighted(rng, [[200, 80], [201, 6], [404, 8], [500, 4], [503, 2]]);
    payload.url = pick(rng, NET_URLS);
    payload.method = weighted(rng, [['GET', 70], ['POST', 30]]);
    payload.status = status;
    payload.bytes = Math.floor(rng() * 8000) + 120;
    payload.elapsed_ms = elapsedMs;
    level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  } else if (reportType === 'sos_ping') {
    level = weighted(rng, [['info', 70], ['warn', 30]]);
    payload.signal_strength = Math.floor(rng() * 100);
    payload.satellites = Math.floor(rng() * 12);
    payload.beacon_id = `RB-${app.platform.toUpperCase()}-${1000 + Math.floor(rng() * 9000)}`;
    if (rng() < 0.25) payload.radio_log = RADIO_LOG;
    // castaway_gps is the transform DROP target; include it occasionally to
    // illustrate the field the transform removes on the real ingest path.
    if (rng() < 0.4) payload.castaway_gps = { lat: 17.5 + rng(), lon: -149.5 - rng() };
  } else if (reportType === 'crash') {
    level = weighted(rng, [['fatal', 88], ['error', 12]]);
    const err = pick(rng, CRASH_ERRORS);
    payload.error = err;
    payload.stack = `${err}\n  at ${pick(rng, FN_NAMES)} (RescueBeacon.app:${100 + Math.floor(rng() * 900)})\n  at main (bootstrap:42)`;
    payload.fatal = true;
  }

  if (level) payload.level = level; // reserved keys stay in payload too (§6)

  return {
    received_at: receivedAt,
    client_ts: clientTs,
    report_type: reportType,
    level,
    session_id: sessionId,
    app_version: appVersion,
    platform: app.platform,
    elapsed_ms: elapsedMs,
    capture_count: 0,
    payload,
    payload_bytes: Buffer.byteLength(JSON.stringify(payload)),
    ingest_key_id: null,
  };
}

/** Capture-bearing entries (iOS only): a session of bug_report / sos_ping with
 *  one inline base64 JPEG frame each, ordered for a session timelapse.
 *  NOTE: production offloads screen_captures to Bin and stores refs (§23.2);
 *  this self-contained seeder inlines a tiny valid 1x1 JPEG so the capture strip
 *  and timelapse have deterministic content without an object-storage round-trip. */
function makeCaptureEntries(app, anchorMs) {
  const sessionId = 'sos-rescue-001';
  const baseMs = anchorMs - 30 * 60 * 60 * 1000; // ~30h ago
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const reportType = i % 2 === 0 ? 'sos_ping' : 'bug_report';
    const level = i % 3 === 0 ? 'error' : 'warn';
    const receivedAt = new Date(baseMs + i * 10 * 60 * 1000); // 10 min apart
    const payload = {
      report_type: reportType,
      session_id: sessionId,
      app_version: '1.4.2',
      platform: app.platform,
      level,
      timestamp: receivedAt.toISOString(),
      note: i % 2 === 0 ? 'Distress beacon screen, satellites visible' : 'Crash on rescue-submit; attaching screen',
      screen_captures: [TINY_JPEG_B64],
      _seed: 'gilligan',
    };
    rows.push({
      received_at: receivedAt,
      client_ts: receivedAt,
      report_type: reportType,
      level,
      session_id: sessionId,
      app_version: '1.4.2',
      platform: app.platform,
      elapsed_ms: null,
      capture_count: 1,
      payload,
      payload_bytes: Buffer.byteLength(JSON.stringify(payload)),
      ingest_key_id: null,
    });
  }
  return rows;
}

// ── ingest keys (direct insert; one active/suspended/revoked per app) ───────
// The harness mints read_write GKEYS, but POST /blip/api/apps/:id/keys is gated
// by requireScope('admin') (API-KEY scope, not org role), so a read_write key
// cannot mint. Direct insert is the deterministic path. If BLIP_INGEST_PEPPER is
// present in this container's env, the active key's HMAC matches the server's and
// the token actually authenticates (used by the soft live-path proof below);
// otherwise it is a display-only row and the live-path proof soft-skips.
function keyRowsFor(app) {
  const mk = (slot, status, label) => {
    const keyId = `gil${app.key}${slot}`.replace(/[^a-z0-9]/gi, '').slice(0, 16);
    const secret = `gilligan-${app.key}-${slot}-${app.id.slice(0, 8)}`;
    const token = `blip_${keyId}_${secret}`;
    const secretHmac = PEPPER
      ? createHmac('sha256', PEPPER).update(secret).digest('hex')
      : createHash('sha256').update(`nopepper:${secret}`).digest('hex');
    const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 16);
    return { keyId, secret, token, secretHmac, last4: secret.slice(-4), fingerprint, status, label };
  };
  return [
    mk('a1', 'active', `${app.name} - prod (active)`),
    mk('s2', 'suspended', `${app.name} - beta (suspended)`),
    mk('r3', 'revoked', `${app.name} - legacy (revoked)`),
  ];
}

// ── config payloads ─────────────────────────────────────────────────────────
const RATE_LIMIT = {
  refill_per_sec: 50,
  burst: 200,
  max_body_bytes: 262144,
  max_batch_count: 500,
  max_capture_body_bytes: 4194304,
  max_capture_bytes: 2097152,
  max_captures_per_report: 8,
};
const TRANSFORM_RULES = [
  { match: 'payload:castaway_gps', action: 'drop' },
  { match: 'payload:radio_log', action: 'truncate', params: { max_len: 256 } },
];

function reservedColumns() {
  return [
    { field: 'received_at' },
    { field: 'level' },
    { field: 'session_id' },
    { field: 'app_version' },
    { field: 'platform' },
    { field: 'elapsed_ms' },
  ];
}

// ── partition helper (defensive; the migration already pre-creates the range) ─
async function ensurePartition(sql, monthDate) {
  const start = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 1));
  const name = `blip_entries_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF blip_entries FOR VALUES FROM ('${startStr}') TO ('${endStr}')`,
  );
}

// ── bulk insert (chunked + pipelined) ───────────────────────────────────────
async function insertEntries(sql, orgId, appId, rows) {
  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await sql.begin((tx) =>
      Promise.all(
        chunk.map(
          (r) => tx`
            INSERT INTO blip_entries
              (received_at, org_id, tracked_app_id, report_type, ingest_key_id,
               client_ts, level, session_id, app_version, platform, elapsed_ms,
               capture_count, payload, payload_bytes)
            VALUES
              (${r.received_at}, ${orgId}, ${appId}, ${r.report_type}, ${r.ingest_key_id},
               ${r.client_ts}, ${r.level}, ${r.session_id}, ${r.app_version}, ${r.platform}, ${r.elapsed_ms},
               ${r.capture_count}, ${tx.json(r.payload)}, ${r.payload_bytes})`,
        ),
      ),
    );
    done += chunk.length;
    log(`    … inserted ${done}/${rows.length} entries`);
  }
}

// ── field catalog (drives the report-type browser + sort/column pickers) ────
function tallyCatalog(rows, catalog, appId, orgId) {
  const RESERVED = new Set(['level', 'session_id', 'app_version', 'platform', 'elapsed_ms', 'client_ts']);
  const typeOf = (v) =>
    Array.isArray(v) ? 'array' : v === null ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : typeof v === 'object' ? 'object' : 'string';
  for (const r of rows) {
    const reportType = r.report_type;
    const note = (path, inferred) => {
      const k = `${reportType} ${path}`;
      let e = catalog.get(k);
      if (!e) {
        e = { org_id: orgId, tracked_app_id: appId, report_type: reportType, field_path: path, types: new Set(), count: 0 };
        catalog.set(k, e);
      }
      e.types.add(inferred);
      e.count += 1;
    };
    // promoted reserved columns present on the row
    if (r.level != null) note('level', 'string');
    if (r.session_id != null) note('session_id', 'string');
    if (r.app_version != null) note('app_version', 'string');
    if (r.platform != null) note('platform', 'string');
    if (r.elapsed_ms != null) note('elapsed_ms', 'number');
    // payload-only fields
    for (const [k, v] of Object.entries(r.payload)) {
      if (k === '_seed' || k === 'report_type' || RESERVED.has(k) || k === 'timestamp' || k === 'screen_captures') continue;
      note(`payload:${k}`, typeOf(v));
    }
  }
}
async function upsertCatalog(sql, catalog) {
  for (const e of catalog.values()) {
    const inferred = e.types.size > 1 ? 'mixed' : [...e.types][0] || 'string';
    const isMetric = e.field_path === 'elapsed_ms';
    await sql`
      INSERT INTO blip_field_catalog
        (org_id, tracked_app_id, report_type, field_path, inferred_type, is_metric, observation_count)
      VALUES
        (${e.org_id}, ${e.tracked_app_id}, ${e.report_type}, ${e.field_path}, ${inferred}, ${isMetric}, ${e.count})
      ON CONFLICT (tracked_app_id, report_type, field_path) DO UPDATE SET
        inferred_type = EXCLUDED.inferred_type,
        is_metric = blip_field_catalog.is_metric OR EXCLUDED.is_metric,
        observation_count = EXCLUDED.observation_count,
        last_seen = NOW()`;
  }
}

// ── best-effort Bolt rule (entry.matched / slow-frame -> Banter) ────────────
async function seedBoltRule() {
  const tok = KEYS.skipper;
  if (!tok) {
    log('  bolt rule: skipped (no skipper GKEY available)');
    return;
  }
  const name = 'Slow Frame on the Rescue Beacon → Post to #rescue-ops';
  const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  try {
    const found = await fetch(`${BOLT_API}/automations/by-name/${encodeURIComponent(name)}`, { headers: H });
    if (found.ok) {
      const env = await found.json().catch(() => null);
      if (env?.data?.id) {
        log('  bolt rule: already present');
        return;
      }
    }
    const body = {
      name,
      description:
        'When a Blip match-watch named slow-frame fires (a Rescue Beacon frame blew the 500ms budget), ' +
        'announce it in #rescue-ops with the viewer deep link. Throttled by the watch cooldown.',
      trigger_source: 'blip',
      trigger_event: 'entry.matched',
      enabled: true,
      conditions: [{ sort_order: 0, field: 'watch_name', operator: 'equals', value: 'slow-frame', logic_group: 'and' }],
      actions: [
        {
          sort_order: 0,
          mcp_tool: 'banter_post_message',
          parameters: {
            channel_name: 'rescue-ops',
            content: '🐢 Slow frame on the Rescue Beacon - a frame blew the 500ms budget. Check the live tail.',
          },
        },
      ],
    };
    const r = await fetch(`${BOLT_API}/automations`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (r.ok) {
      log('  bolt rule: created (entry.matched / slow-frame → #rescue-ops)');
    } else {
      const txt = (await r.text().catch(() => '')).slice(0, 160);
      log(`  bolt rule: skipped (Bolt rejected ${r.status}: ${txt})`);
    }
  } catch (e) {
    log(`  bolt rule: skipped (best-effort, ${e.message})`);
  }
}

// ── soft live-path proof (real ingest; partial-expected on rate-limit/lag) ──
async function livePathProof(app, activeKey) {
  if (!PEPPER) {
    log(`  live-path (${app.key}): skipped - BLIP_INGEST_PEPPER not in env, seeded key cannot authenticate (expected)`);
    return;
  }
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(BLIP_INGEST, {
        method: 'POST',
        headers: { 'X-Blip-Key': activeKey.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_type: i % 2 === 0 ? 'fn_timing' : 'app_log',
          fn: 'decodeFrame',
          elapsed_ms: 9.5 + i,
          message: 'live-path proof ping',
          session_id: 'live-proof',
          app_version: '1.4.2',
          platform: app.platform,
          level: 'debug',
        }),
      });
      if (r.status === 202) ok += 1;
    } catch {
      /* swallow - soft */
    }
  }
  if (ok > 0) log(`  live-path (${app.key}): ${ok}/5 reports accepted (202) through real ingest`);
  else log(`  live-path (${app.key}): partial (expected) - 0/5 accepted (rate-limit or worker lag)`);
}

// ── best-effort Bench rollup refresh (§13/§21.3) ────────────────────────────
async function refreshRollups(sql) {
  try {
    const mvs = await sql`SELECT matviewname FROM pg_matviews WHERE matviewname LIKE 'blip%'`;
    if (mvs.length === 0) {
      log('  rollups: none found (blip Bench rollup MVs not migrated yet) - skipped');
      return;
    }
    for (const { matviewname } of mvs) {
      try {
        await sql.unsafe(`REFRESH MATERIALIZED VIEW ${matviewname}`);
        log(`  rollups: refreshed ${matviewname}`);
      } catch (e) {
        log(`  rollups: skip ${matviewname} (${e.message.slice(0, 80)})`);
      }
    }
  } catch (e) {
    log(`  rollups: skipped (${e.message.slice(0, 80)})`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sql = postgres(process.env.DATABASE_URL, { max: 4 });

  // Resolve the Gilligan org from the Professor's membership (no hardcoded UUID).
  const [orgRow] = await sql`
    SELECT om.org_id, o.name
    FROM organization_memberships om
    JOIN organizations o ON o.id = om.org_id
    WHERE om.user_id = ${CAST.professor}
    ORDER BY om.joined_at ASC
    LIMIT 1`;
  if (!orgRow) {
    log('Could not resolve Gilligan org from the Professor membership. Aborting.');
    await sql.end();
    process.exit(1);
  }
  const ORG = orgRow.org_id;
  log(`org: ${orgRow.name} (${ORG})`);

  // Single clock anchor (BLIP_SEED_NOW or captured once). Never per-row Date.now().
  const anchor = process.env.BLIP_SEED_NOW ? new Date(process.env.BLIP_SEED_NOW) : new Date();
  const anchorMs = anchor.getTime();
  log(`clock anchor: ${anchor.toISOString()}${process.env.BLIP_SEED_NOW ? ' (from BLIP_SEED_NOW)' : ' (captured now)'}`);

  // Ensure the monthly partitions covering [anchor-14d, anchor] exist (defensive).
  const spanMonths = new Set();
  for (let d = anchorMs - FOURTEEN_DAYS_MS - 36 * 60 * 60 * 1000; d <= anchorMs; d += 24 * 60 * 60 * 1000) {
    spanMonths.add(new Date(d).toISOString().slice(0, 7));
  }
  for (const m of spanMonths) await ensurePartition(sql, new Date(`${m}-15T00:00:00Z`));
  log(`partitions ensured for: ${[...spanMonths].sort().join(', ')}`);

  const ENTRIES_PER_APP = 2400;
  const summary = [];

  for (const app of APPS) {
    log(`── app: ${app.name} ──`);

    // 1. Tracked app (fixed id).
    await sql`
      INSERT INTO blip_tracked_apps
        (id, org_id, name, description, collection_enabled, rate_limit, transform_version, owner_id, created_by)
      VALUES
        (${app.id}, ${ORG}, ${app.name}, ${app.description}, true, ${JSON.stringify(RATE_LIMIT)}::jsonb, 1, ${CAST.professor}, ${CAST.professor})
      ON CONFLICT (id) DO NOTHING`;
    log(`  tracked app ready (${app.id})`);

    // 2. Transform (drop castaway_gps, truncate radio_log) - app-wide.
    await sql`
      INSERT INTO blip_transforms (id, org_id, tracked_app_id, report_type, enabled, rules, version, updated_by)
      VALUES (${uuid5(`transform:${app.key}`)}, ${ORG}, ${app.id}, ${null}, true, ${JSON.stringify(TRANSFORM_RULES)}::jsonb, 1, ${CAST.professor})
      ON CONFLICT (id) DO NOTHING`;

    // 3. Retention - 14-day app-wide default + a 90-day crash override.
    await sql`
      INSERT INTO blip_retention_policies (id, org_id, tracked_app_id, report_type, max_age_days, updated_by)
      VALUES (${uuid5(`retention:${app.key}:default`)}, ${ORG}, ${app.id}, ${null}, 14, ${CAST.professor})
      ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO blip_retention_policies (id, org_id, tracked_app_id, report_type, max_age_days, updated_by)
      VALUES (${uuid5(`retention:${app.key}:crash`)}, ${ORG}, ${app.id}, 'crash', 90, ${CAST.professor})
      ON CONFLICT (id) DO NOTHING`;
    log('  transform + retention (14d default, 90d crash) seeded');

    // 4. Ingest keys: one active / suspended / revoked (display every state).
    const keys = keyRowsFor(app);
    for (const k of keys) {
      await sql`
        INSERT INTO blip_ingest_keys
          (org_id, tracked_app_id, key_id, secret_hmac, last4, fingerprint, label, status, created_by, suspended_at)
        VALUES
          (${ORG}, ${app.id}, ${k.keyId}, ${k.secretHmac}, ${k.last4}, ${k.fingerprint}, ${k.label}, ${k.status}, ${CAST.professor},
           ${k.status === 'suspended' ? anchor : null})
        ON CONFLICT (key_id) DO NOTHING`;
    }
    log(`  ingest keys: ${keys.map((k) => `${k.keyId}(${k.status})`).join(', ')}`);

    // 5. Entry backlog - skip if this app already has seeded rows (idempotent).
    const [existing] = await sql`
      SELECT 1 FROM blip_entries
      WHERE tracked_app_id = ${app.id} AND payload->>'_seed' = 'gilligan'
      LIMIT 1`;
    const catalog = new Map();
    if (existing) {
      log('  entries: already seeded for this app, skipping backlog');
    } else {
      log(`  generating ${ENTRIES_PER_APP} entries (seeded PRNG, last 14 days)…`);
      const rng = mulberry32(app.seed);
      const rows = [];
      for (let i = 0; i < ENTRIES_PER_APP; i++) {
        const receivedAt = new Date(anchorMs - Math.floor(rng() * FOURTEEN_DAYS_MS));
        rows.push(makeEntry(app, rng, receivedAt));
      }
      // Sort ascending so seq (DB default nextval) climbs with received_at.
      rows.sort((a, b) => a.received_at - b.received_at);
      if (app.captures) rows.push(...makeCaptureEntries(app, anchorMs));
      log(`  inserting ${rows.length} entries…`);
      await insertEntries(sql, ORG, app.id, rows);
      tallyCatalog(rows, catalog, app.id, ORG);
      await upsertCatalog(sql, catalog);
      log(`  field catalog upserted (${catalog.size} fields)`);
    }

    // 6. Saved views: a default per type + the two named views.
    const REPORT_TYPES = ['app_log', 'fn_timing', 'net_request', 'sos_ping', 'crash'];
    for (const rt of REPORT_TYPES) {
      const spec = { filter: { op: 'and', conditions: [] }, columns: reservedColumns(), sort: [{ field: 'seq', dir: 'desc' }], liveTail: true, pageSize: 100 };
      await sql`
        INSERT INTO blip_saved_views (id, org_id, tracked_app_id, report_type, name, owner_id, scope, is_default, spec)
        VALUES (${uuid5(`view:${app.key}:${rt}:default`)}, ${ORG}, ${app.id}, ${rt}, 'Default', ${CAST.professor}, 'org', true, ${JSON.stringify(spec)}::jsonb)
        ON CONFLICT (id) DO NOTHING`;
    }
    const errorsView = {
      filter: { op: 'and', conditions: [{ field: 'level', operator: 'in', value: ['error', 'fatal'] }] },
      columns: [{ field: 'received_at' }, { field: 'level' }, { field: 'payload:message' }, { field: 'session_id' }],
      sort: [{ field: 'seq', dir: 'desc' }],
      liveTail: true,
      pageSize: 100,
    };
    await sql`
      INSERT INTO blip_saved_views (id, org_id, tracked_app_id, report_type, name, owner_id, scope, is_default, spec)
      VALUES (${uuid5(`view:${app.key}:errors`)}, ${ORG}, ${app.id}, 'app_log', 'Errors only', ${CAST.professor}, 'org', false, ${JSON.stringify(errorsView)}::jsonb)
      ON CONFLICT (id) DO NOTHING`;
    const slowView = {
      filter: { op: 'and', conditions: [{ field: 'elapsed_ms', operator: 'gte', value: 16 }] },
      columns: [{ field: 'received_at' }, { field: 'payload:fn' }, { field: 'elapsed_ms' }, { field: 'app_version' }],
      sort: [{ field: 'elapsed_ms', dir: 'desc' }],
      liveTail: true,
      pageSize: 100,
    };
    await sql`
      INSERT INTO blip_saved_views (id, org_id, tracked_app_id, report_type, name, owner_id, scope, is_default, spec)
      VALUES (${uuid5(`view:${app.key}:slow`)}, ${ORG}, ${app.id}, 'fn_timing', 'Slow frames', ${CAST.professor}, 'org', false, ${JSON.stringify(slowView)}::jsonb)
      ON CONFLICT (id) DO NOTHING`;
    log('  saved views: Default×5, "Errors only", "Slow frames"');

    // 7. Watches: match slow-frame (fn_timing) + window error-spike (all types).
    const slowFramePred = { op: 'and', conditions: [{ field: 'elapsed_ms', operator: 'gt', value: 500 }] };
    await sql`
      INSERT INTO blip_watches (id, org_id, tracked_app_id, report_type, name, description, kind, enabled, predicate, cooldown_sec, created_by)
      VALUES (${uuid5(`watch:${app.key}:slow-frame`)}, ${ORG}, ${app.id}, 'fn_timing', 'slow-frame',
              'A single frame blew the 500ms budget.', 'match', true, ${JSON.stringify(slowFramePred)}::jsonb, 60, ${CAST.professor})
      ON CONFLICT (id) DO NOTHING`;
    const errorSpikePred = {
      window_sec: 60,
      aggregate: { op: 'count' },
      comparator: { operator: 'gt', value: 20 },
      filter: { op: 'and', conditions: [{ field: 'level', operator: 'in', value: ['error', 'fatal'] }] },
    };
    await sql`
      INSERT INTO blip_watches (id, org_id, tracked_app_id, report_type, name, description, kind, enabled, predicate, cooldown_sec, created_by)
      VALUES (${uuid5(`watch:${app.key}:error-spike`)}, ${ORG}, ${app.id}, ${null}, 'error-spike',
              'More than 20 error/fatal reports inside any 60s window.', 'window', true, ${JSON.stringify(errorSpikePred)}::jsonb, 60, ${CAST.professor})
      ON CONFLICT (id) DO NOTHING`;
    log('  watches: match "slow-frame", window "error-spike"');

    // 8. One firing in slow-frame's history (so the watch history screen is real).
    const watchId = uuid5(`watch:${app.key}:slow-frame`);
    const firedAt = new Date(anchorMs - 6 * 60 * 60 * 1000);
    await sql`
      INSERT INTO blip_watch_events (id, org_id, watch_id, tracked_app_id, report_type, event_name, fired_at, context)
      VALUES (${uuid5(`watchevent:${app.key}:slow-frame:1`)}, ${ORG}, ${watchId}, ${app.id}, 'fn_timing', 'entry.matched', ${firedAt},
              ${JSON.stringify({ watch_name: 'slow-frame', fn: 'decodeFrame', elapsed_ms: 812.4, app_version: '1.4.2', platform: app.platform, summary: 'decodeFrame 812.4ms' })}::jsonb)
      ON CONFLICT (id) DO NOTHING`;
    log('  watch history: 1 slow-frame firing recorded');

    // 9. Soft live-path proof through the real ingest endpoint.
    await livePathProof(app, keys[0]);

    summary.push({ app: app.name, id: app.id });
  }

  // 10. Best-effort cross-app wiring.
  log('── cross-app wiring ──');
  await seedBoltRule();
  await refreshRollups(sql);

  await sql.end();

  log('────────────────────────────────────────────────');
  log(`blip.mjs done in ${elapsed()}: ${summary.length} tracked apps seeded.`);
  for (const s of summary) log(`  • ${s.app} (${s.id})`);
  log('Sign in at /b3/login as a castaway (password Castaway2026!) and open /blip.');
}

main().catch((err) => {
  log(`ERROR: ${err.message}`);
  process.exit(1);
});
