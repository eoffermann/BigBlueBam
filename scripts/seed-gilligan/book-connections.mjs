/**
 * Gilligan's Island themed Book — external calendar Connections seed.
 *
 * Demonstrates the Book external-calendar sync feature (Connections page) with
 * a working, no-OAuth ICS feed. The castaways subscribe to the island's
 * "Rescue Watch Rota" — an external iCalendar feed of dawn horizon watches,
 * signal-fire shifts, and radio windows — which Book pulls in and mirrors onto
 * the Island Calendar so it shows up on the week/day/month views.
 *
 * The feed itself is an in-character .ics fixture this script hosts on the
 * stack's MinIO at a stable, public-read URL (http://minio:9000/<bucket>/...).
 * book-api can fetch that URL on every sync, including the worker's recurring
 * 15-minute sweep, so the connection stays green long after this seed runs and
 * does not depend on outbound internet.
 *
 * Idempotent:
 *   - the public-read bucket + object are upserted (overwrite is fine);
 *   - the ICS connection is found-or-created by (provider='ics', feed host +
 *     name) for the Skipper, then synced.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("scripts/.gilligan-keys.env","utf8").split("\n")){if(l&&!l.startsWith("#")&&l.includes("=")){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1).trim();}}process.stdout.write(JSON.stringify(o))')
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/book-connections.mjs
 *
 * NOTE: this MUST run in the *api* container (not book-api): the api image
 * bundles the `minio` client used to host the fixture. The book-api container
 * is what fetches the feed during sync, and it can reach http://minio:9000 on
 * the same compose network. The two are wired by the shared MinIO host.
 */

import * as Minio from 'minio';

const BOOK = 'http://book-api:4012/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// The Skipper owns the island calendar and runs the rescue watch, so the
// connection is his.
const OWNER = 'skipper';

// MinIO: default dev creds + a dedicated public-read bucket so the feed URL is
// unauthenticated and stable across syncs.
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://minio:9000';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'minioadmin';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'minioadmin';
const FEED_BUCKET = 'gilligan-feeds';
const FEED_KEY = 'rescue-watch-rota.ics';

const CONN_NAME = 'Rescue Watch Rota';

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}
async function book(who, method, path, body) {
  const r = await fetch(`${BOOK}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 280)}`);
  return data.data ?? data;
}
const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// ---- iCalendar fixture (RFC 5545). UTC instants; the parser treats Z times
// as UTC and the Book UI renders them in the calendar's timezone. Honolulu is
// UTC-10 with no DST, so a 06:00 island watch = 16:00Z. Events land in the
// week of 2026-06-15..21 to populate the capture-window calendar views. ----
const ICAL_DTSTAMP = '20260615T000000Z';
function vevent({ uid, summary, description, location, startZ, endZ }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${ICAL_DTSTAMP}`,
    `DTSTART:${startZ}`,
    `DTEND:${endZ}`,
    `SUMMARY:${summary}`,
    description ? `DESCRIPTION:${description.replace(/,/g, '\\,').replace(/;/g, '\\;')}` : null,
    location ? `LOCATION:${location.replace(/,/g, '\\,')}` : null,
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ]
    .filter(Boolean)
    .join('\r\n');
}

// Honolulu local -> UTC Z string. local + 10h = UTC.
function z(date, hhmm) {
  const utcMs = Date.parse(`${date}T${hhmm}:00Z`) + 10 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

const ROTA = [
  {
    uid: 'rota-2026-06-15-dawn@gilligan-island',
    summary: 'Rescue Watch: Dawn Horizon Sweep',
    description: 'Scan the full horizon at first light. Spyglass, signal mirror, and a thermos of coconut coffee. Log any smoke, sails, or aircraft.',
    location: 'Lookout Point (the tall palm)',
    startZ: z('2026-06-15', '05:30'), endZ: z('2026-06-15', '07:00'),
  },
  {
    uid: 'rota-2026-06-16-radio@gilligan-island',
    summary: 'Rescue Watch: Radio Distress Window',
    description: 'Broadcast the island call sign on the marine band and listen for any reply. Gilligan on the bicycle generator.',
    location: "The Professor's lab hut",
    startZ: z('2026-06-16', '07:00'), endZ: z('2026-06-16', '07:45'),
  },
  {
    uid: 'rota-2026-06-17-fire@gilligan-island',
    summary: 'Rescue Watch: Signal-Fire Refuel',
    description: 'Stack the beacon high with dry driftwood and green fronds for maximum smoke. Keep it lit through the afternoon shipping lane window.',
    location: 'North Beach signal fire',
    startZ: z('2026-06-17', '13:00'), endZ: z('2026-06-17', '15:30'),
  },
  {
    uid: 'rota-2026-06-18-dawn@gilligan-island',
    summary: 'Rescue Watch: Dawn Horizon Sweep',
    description: 'Second dawn watch of the week. Trade off the spyglass every twenty minutes so nobody nods off.',
    location: 'Lookout Point (the tall palm)',
    startZ: z('2026-06-18', '05:30'), endZ: z('2026-06-18', '07:00'),
  },
  {
    uid: 'rota-2026-06-19-radio@gilligan-island',
    summary: 'Rescue Watch: Radio Distress Window',
    description: 'Friday distress broadcast. If a storm front is forecast, log it and reschedule the weekend sweeps.',
    location: "The Professor's lab hut",
    startZ: z('2026-06-19', '07:00'), endZ: z('2026-06-19', '07:45'),
  },
  {
    uid: 'rota-2026-06-21-allhands@gilligan-island',
    summary: 'Rescue Watch: All-Hands Sunday Sweep',
    description: 'Full-roster horizon watch. Mirrors, fire, message bottles, and the big HELP stamped in the sand. This is the week we get off this island.',
    location: 'Lookout Point + signal fire',
    startZ: z('2026-06-21', '09:00'), endZ: z('2026-06-21', '12:00'),
  },
];

function buildIcs() {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gilligan Island//Rescue Watch Rota//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Rescue Watch Rota',
    'X-WR-TIMEZONE:Pacific/Honolulu',
    ...ROTA.map(vevent),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

(async () => {
  // ---- 1. Host the ICS fixture on MinIO with a public-read policy. ----
  const url = new URL(S3_ENDPOINT);
  const mc = new Minio.Client({
    endPoint: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    useSSL: url.protocol === 'https:',
    accessKey: S3_ACCESS_KEY,
    secretKey: S3_SECRET_KEY,
  });

  const exists = await mc.bucketExists(FEED_BUCKET).catch(() => false);
  if (!exists) {
    await mc.makeBucket(FEED_BUCKET);
    console.log(`minio: created bucket ${FEED_BUCKET}`);
  } else {
    console.log(`minio: bucket ${FEED_BUCKET} exists`);
  }

  // Anonymous read on this bucket only, so book-api can fetch the feed with no
  // credentials and no presigned URL (which would expire and break re-syncs).
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${FEED_BUCKET}/*`],
      },
    ],
  };
  await mc.setBucketPolicy(FEED_BUCKET, JSON.stringify(policy));

  const ics = buildIcs();
  await mc.putObject(FEED_BUCKET, FEED_KEY, Buffer.from(ics, 'utf8'), Buffer.byteLength(ics), {
    'Content-Type': 'text/calendar; charset=utf-8',
  });
  const feedUrl = `${S3_ENDPOINT.replace(/\/$/, '')}/${FEED_BUCKET}/${FEED_KEY}`;
  console.log(`minio: uploaded ${FEED_KEY} (${ROTA.length} VEVENTs) -> ${feedUrl}`);

  // ---- 2. Resolve the target Book calendar (Island Calendar, fallback default). ----
  const cals = asArr(await book(OWNER, 'GET', '/calendars'));
  const island = cals.find((c) => c.name === 'Island Calendar') ?? cals[0];
  if (!island) throw new Error('No Book calendar found for the Skipper — run book.mjs first.');
  console.log(`target calendar: ${island.name} (${island.id})`);

  // ---- 3. Find-or-create the ICS connection (idempotent by name). ----
  const existing = asArr(await book(OWNER, 'GET', '/connections'));
  let conn = existing.find((c) => c.provider === 'ics' && c.name === CONN_NAME);
  if (!conn) {
    conn = await book(OWNER, 'POST', '/connections/ics', {
      feed_url: feedUrl,
      name: CONN_NAME,
      calendar_id: island.id,
    });
    console.log(`connection: created "${CONN_NAME}" (${conn.id})`);
  } else {
    console.log(`connection exists: "${CONN_NAME}" (${conn.id})`);
  }

  // ---- 4. Sync now so the feed's events mirror into the Island Calendar. ----
  // Send an explicit empty body: the route sets Content-Type: application/json,
  // and Fastify rejects an application/json POST with a zero-length body.
  const result = await book(OWNER, 'POST', `/connections/${conn.id}/sync`, {});
  console.log(
    `sync: status=${result.status} imported=${result.imported} created=${result.created} updated=${result.updated} removed=${result.removed}` +
      (result.error ? ` error=${result.error}` : ''),
  );

  // ---- 5. Report the connection's final state as the UI will show it. ----
  const after = asArr(await book(OWNER, 'GET', '/connections')).find((c) => c.id === conn.id);
  if (after) {
    console.log(
      `connection now: status=${after.sync_status} last_sync_event_count=${after.last_sync_event_count} last_sync_at=${after.last_sync_at}`,
    );
  }

  if (result.status !== 'active') {
    console.error('Connection did not reach active status.');
    process.exit(1);
  }
  console.log('\nBook Connections seed done.');
})().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
