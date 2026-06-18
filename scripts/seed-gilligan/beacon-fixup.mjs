/**
 * Gilligan's Island Beacon (knowledge base) FRESHNESS FIXUP.
 *
 * The 11 island-wiki beacons were seeded by scripts/seed-gilligan/beacon.mjs.
 * As seeded they all read **Expired / 0% freshness** and **unverified** in the
 * Beacon UI. Two facts conspire to produce that:
 *
 *   1. None were ever verified (`last_verified_at IS NULL`,
 *      `verification_count = 0`), and the frontend freshness rule
 *      (apps/beacon/src/components/beacon/freshness-indicator.tsx) treats a
 *      never-verified beacon as **expired** even when `expires_at` is in the
 *      future — the `expires_at` check only fires when it is *within 14 days*
 *      or already past, otherwise it falls through to the last-verified branch,
 *      and "never verified -> expired".
 *   2. `expires_at` was set to publish-time + 90d. Comfortable, but it does
 *      nothing for freshness while the beacon is unverified.
 *
 * So the fixup does two things, idempotently, against the EXISTING beacons
 * (it creates none, deletes none, retires none):
 *
 *   A) VERIFY a majority via the documented Bearer mechanism — each beacon is
 *      verified by its *original author's* cast key, which is owner+creator and
 *      therefore always passes requireBeaconEditAccess (a Member can only verify
 *      beacons it owns). Verification stamps `last_verified_at = now`, which
 *      makes computeFreshness return `fresh` (daysSinceVerify = 0).
 *   B) EXTEND `expires_at` into the future for the verified set so they stay
 *      unambiguously current beyond the verify-recency window, and PULL IN one
 *      beacon's `expires_at` to within the 14-day window so it reads "Expiring"
 *      — a realistic governance mix rather than a uniform 100%.
 *
 *      There is no Bearer endpoint that sets an arbitrary `expires_at`
 *      (PUT /beacons/:id ignores it; verify/publish/restore recompute it from
 *      policy only on a lifecycle transition we don't want to trigger here), so
 *      the expires_at writes go straight to Postgres via the `postgres` client
 *      that ships in the api image, using the container's own DATABASE_URL. The
 *      writes are scoped to this org's beacon ids by slug, so they touch
 *      nothing else.
 *
 * Run from the repo host (the api container shares the backend network with
 * beacon-api and reaches it at the internal host below, and has DATABASE_URL):
 *
 *   GKEYS=$(node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("scripts/.gilligan-keys.env","utf8").split("\n")){if(l&&!l.startsWith("#")&&l.includes("=")){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1).trim();}}process.stdout.write(JSON.stringify(o))')
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/beacon-fixup.mjs
 *
 * Idempotent + safe to re-run: re-verifying just adds another verification row
 * and re-stamps last_verified_at (still `fresh`); the expires_at writes are
 * absolute targets, not relative bumps, so the goal state converges.
 */

const BEACON = 'http://beacon-api:4004/v1';
const ORG_SLUG = 'gilligan-travel-ltd';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Future horizon for the "current" beacons (well past the server's real clock).
const FRESH_EXPIRES_AT = '2026-12-31T00:00:00Z';
// Days from real now for the single "Expiring soon" beacon (inside the UI's
// 14-day expiring window so it reads Expiring, not Expired).
const EXPIRING_IN_DAYS = 10;

// Authorship map (slug -> cast key), mirrored from scripts/seed-gilligan/beacon.mjs.
// The author owns+created the beacon, so its key always passes the edit guard.
const AUTHOR = {
  'two-way-radio-from-coconuts': 'professor',
  'lagoon-fishing-and-spear-technique': 'skipper',
  'reading-the-stars-to-navigate-home': 'professor',
  'mary-anns-coconut-cream-pie': 'maryann',
  'bamboo-raft-construction-101': 'skipper',
  'when-a-ship-is-sighted': 'skipper',
  'surviving-the-wet-season': 'professor',
  'howell-guide-to-island-etiquette': 'howell',
  'finding-fresh-water-on-the-island': 'professor',
  'firstaid-island-injuries': 'maryann',
  'building-the-bamboo-hut': 'gilligan', // the Draft — left as-is
};

// The realistic governance mix over the 10 Active beacons:
//   - VERIFY_AND_EXTEND: verify (Bearer) + push expires_at to FRESH_EXPIRES_AT  -> Fresh
//   - EXPIRING_UNVERIFIED: leave unverified, pull expires_at into the 14-day
//       window -> reads "Expiring"
//   - STALE_UNVERIFIED: leave unverified, leave expires_at alone (already ~90d
//       out) -> falls through to last-verified branch -> "Needs verification"
// Result: 8 verified, 8 extended, 2 unverified, 1 expiring, 1 needs-verification.
const VERIFY_AND_EXTEND = [
  'two-way-radio-from-coconuts',
  'reading-the-stars-to-navigate-home',
  'mary-anns-coconut-cream-pie',
  'bamboo-raft-construction-101',
  'when-a-ship-is-sighted',
  'surviving-the-wet-season',
  'finding-fresh-water-on-the-island',
  'lagoon-fishing-and-spear-technique',
];
const EXPIRING_UNVERIFIED = ['howell-guide-to-island-etiquette'];
const STALE_UNVERIFIED = ['firstaid-island-injuries'];
const DRAFT_SLUG = 'building-the-bamboo-hut';

// ----- Bearer helpers (same shape as scripts/seed-gilligan/beacon.mjs) -------
function H(who, hasBody) {
  const h = { Authorization: `Bearer ${KEYS[who]}` };
  if (hasBody) h['Content-Type'] = 'application/json';
  return h;
}

async function beacon(who, method, path, body) {
  const r = await fetch(`${BEACON}${path}`, {
    method,
    headers: H(who, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 250)}`);
  }
  return { status: r.status, data };
}

(async () => {
  // ---- Connect to Postgres for the expires_at writes (no Bearer surface) ----
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL, { max: 4, idle_timeout: 5, connect_timeout: 10 });

  let verified = 0;
  let extended = 0;
  let expiringSet = 0;
  let leftStale = 0;
  const failures = [];

  try {
    // Resolve org id once.
    const [org] = await sql`SELECT id FROM organizations WHERE slug = ${ORG_SLUG} LIMIT 1`;
    if (!org) throw new Error(`org ${ORG_SLUG} not found`);
    const orgId = org.id;

    // Load this org's beacons (id, slug, status) so we operate only on existing rows.
    const rows = await sql`
      SELECT id, slug, status
      FROM beacon_entries
      WHERE organization_id = ${orgId}
    `;
    const bySlug = new Map(rows.map((r) => [r.slug, r]));

    // ---- (A) Verify + extend ----
    for (const slug of VERIFY_AND_EXTEND) {
      const row = bySlug.get(slug);
      if (!row) {
        failures.push(`${slug}: not found in org`);
        continue;
      }
      const who = AUTHOR[slug];
      if (!KEYS[who]) {
        failures.push(`${slug}: missing key for author '${who}'`);
        continue;
      }
      // Verify via Bearer as the author (owner+creator -> passes edit guard).
      try {
        await beacon(who, 'POST', `/beacons/${row.id}/verify`, {
          verification_type: 'ScheduledReview',
          outcome: 'Confirmed',
          confidence_score: 0.95,
          notes: 'Island-wiki periodic review — content confirmed current.',
        });
        verified++;
      } catch (e) {
        failures.push(`verify ${slug}: ${e.message}`);
      }
      // Extend expires_at well into the future.
      try {
        await sql`
          UPDATE beacon_entries
          SET expires_at = ${FRESH_EXPIRES_AT}, updated_at = NOW()
          WHERE id = ${row.id}
        `;
        extended++;
      } catch (e) {
        failures.push(`extend ${slug}: ${e.message}`);
      }
    }

    // ---- (B) One Expiring-soon beacon (unverified, expires inside 14 days) ----
    for (const slug of EXPIRING_UNVERIFIED) {
      const row = bySlug.get(slug);
      if (!row) {
        failures.push(`${slug}: not found in org`);
        continue;
      }
      try {
        await sql`
          UPDATE beacon_entries
          SET expires_at = NOW() + (${EXPIRING_IN_DAYS} || ' days')::interval, updated_at = NOW()
          WHERE id = ${row.id}
        `;
        expiringSet++;
      } catch (e) {
        failures.push(`expiring ${slug}: ${e.message}`);
      }
    }

    // ---- One genuinely stale/unverified beacon: leave expires_at + verify alone ----
    for (const slug of STALE_UNVERIFIED) {
      if (bySlug.has(slug)) leftStale++;
      else failures.push(`${slug}: not found in org`);
    }

    // ---- Report current freshness across the org's beacons ----
    const after = await sql`
      SELECT slug, status,
             (expires_at < NOW()) AS past_expiry,
             EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400.0 AS days_to_expiry,
             last_verified_at IS NOT NULL AS verified,
             verification_count
      FROM beacon_entries
      WHERE organization_id = ${orgId}
      ORDER BY status, slug
    `;

    // Mirror computeFreshness (freshness-indicator.tsx) for an accurate score.
    function freshness(r) {
      if (r.past_expiry) return 'expired';
      if (r.days_to_expiry <= 14) return 'expiring';
      if (r.verified) return 'fresh'; // just verified -> daysSinceVerify ~ 0
      return 'expired'; // never verified -> treated as expired
    }

    const active = after.filter((r) => r.status === 'Active');
    const counts = { fresh: 0, expiring: 0, stale: 0, expired: 0 };
    console.log('\nPer-beacon freshness (Active only):');
    for (const r of active) {
      const f = freshness(r);
      counts[f] = (counts[f] || 0) + 1;
      console.log(
        `  ${f.padEnd(8)} ${r.verified ? 'verified  ' : 'unverified'} ` +
          `exp+${Number(r.days_to_expiry).toFixed(0)}d  ${r.slug}`,
      );
    }
    const draft = after.find((r) => r.slug === DRAFT_SLUG);
    if (draft) console.log(`  (draft)  ${draft.verified ? 'verified' : 'unverified'}  ${draft.slug}`);

    const activeTotal = active.length;
    const currentish = counts.fresh + counts.expiring; // not "Expired/needs verification"
    const pct = activeTotal ? Math.round((counts.fresh / activeTotal) * 100) : 0;

    console.log('\n=== Beacon fixup summary (Gilligan Travel, Ltd.) ===');
    console.log(`expires_at extended (future): ${extended}`);
    console.log(`expires_at pulled into expiring window: ${expiringSet}`);
    console.log(`verified (Bearer, by author): ${verified}`);
    console.log(`left intentionally stale/unverified: ${leftStale}`);
    console.log(
      `Active beacons: ${activeTotal} — fresh ${counts.fresh}, expiring ${counts.expiring}, ` +
        `needs-verification(expired) ${counts.expired}`,
    );
    console.log(
      `Approx freshness: ${pct}% Fresh (${currentish}/${activeTotal} current i.e. not "needs verification"), 1 Draft left as-is.`,
    );
    if (failures.length) {
      console.log(`\nFAILURES (${failures.length}):`);
      for (const f of failures) console.log(`  - ${f}`);
    } else {
      console.log('\nNo failures.');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (failures.length) process.exit(1);
})().catch((e) => {
  console.error('beacon fixup failed:', e?.message || e);
  process.exit(1);
});
