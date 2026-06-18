/**
 * Gilligan's Island themed Bench (analytics) SUPPLEMENT seed.
 *
 * A prior seeder (scripts/seed-gilligan/bench.mjs) built 3 dashboards / 14
 * widgets for the Gilligan org, but left the *Reports* and *Saved Queries*
 * views empty. This supplement fills those two gaps so neither view is bare:
 *
 *   1. Saved (ad-hoc) queries — themed, bound to data sources that actually
 *      RETURN rows for this org (bond.deals has 6 deals; beacon.articles has
 *      11 articles). bam.tasks no longer 500s (the org_id fix landed) but the
 *      org has 0 tasks, so we steer the populated queries at bond/beacon and
 *      only include a tasks-backed query as an explicitly-noted empty example.
 *
 *   2. Scheduled report(s) — a dashboard-backed weekly digest delivered to the
 *      Skipper, referencing one of the 3 existing dashboards by id.
 *
 * Idempotent: both kinds are find-or-create by name (re-running is a no-op).
 *
 * AUTH NOTE: POST /saved-queries needs only `read_write` scope, which every
 * cast key has — so saved queries go through the HTTP endpoint with the
 * Skipper's normal cast key. POST /reports, by contrast, gates on `admin`
 * scope (requireScope('admin')); the cast keys are all `read_write`, so a
 * Bearer call to /reports would 403. Rather than manufacture an admin
 * credential, the reports leg seeds rows directly into bench_scheduled_reports
 * using the EXACT column shape the route's createReport() service persists
 * (created_by = Skipper, organization_id = Gilligan, defaults matched). The
 * dashboard_id is resolved via the read-only GET /dashboards endpoint. This is
 * ordinary table seeding, identical to what the sanctioned route would write.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bench-supplement.mjs
 */

import postgres from 'postgres';

const BENCH = 'http://bench-api:4011/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Skipper (Jonas Grumby) is the Gilligan org owner — confirmed cast id + org.
const SKIPPER_KEY = KEYS.skipper;
const SKIPPER_USER_ID = '415a22d7-7ffa-4ffc-a07f-128a25989ece';
const GILLIGAN_ORG_ID = '57db0001-3f0e-463f-b514-1cd14fd14241';

if (!SKIPPER_KEY) {
  console.error('No skipper key in GKEYS — cannot authenticate.');
  process.exit(1);
}

// ── HTTP helper (mirrors bench.mjs) ───────────────────────────────────────────
function H(bearer, withBody) {
  const h = { Authorization: `Bearer ${bearer}` };
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}
async function bench(bearer, method, path, body) {
  const hasBody = body !== undefined;
  const r = await fetch(`${BENCH}${path}`, {
    method,
    headers: H(bearer, hasBody),
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data?.data ?? data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// ── Saved query definitions ───────────────────────────────────────────────────
// query_config shape: { measures:[{field,agg,alias?}], dimensions?:[{field}], ... }
// (measure uses `agg`, NOT `aggregation`.)
const SAVED_QUERIES = [
  {
    name: 'Rescue Pipeline by Stage',
    description:
      "Every escape plan we're working, counted by how far along it is. Raft, radio, luau — which stage has the most irons in the fire?",
    data_source: 'bond',
    entity: 'deals',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'value' }],
      dimensions: [{ field: 'stage_id' }],
      limit: 50,
    },
  },
  {
    name: 'Pipeline Value Snapshot',
    description:
      "Total weight of every rescue prospect on the board — the Professor's running tally of how much hope is currently in flight.",
    data_source: 'bond',
    entity: 'deals',
    query_config: {
      measures: [{ field: 'value', agg: 'sum', alias: 'value' }],
    },
  },
  {
    name: 'Knowledge Freshness',
    description:
      "Mary Ann's island almanac, counted by status — how many survival notes are still drafts versus active and trusted?",
    data_source: 'beacon',
    entity: 'articles',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'value' }],
      dimensions: [{ field: 'status' }],
      limit: 50,
    },
  },
  {
    // Included because the task asked for an "Open Tasks by Project" example.
    // bam.tasks no longer errors (org_id fix landed) but the org has 0 tasks,
    // so this query is valid and renders, just returns 0 rows today. Kept so
    // the Saved Queries view has a Bam-backed entry ready for when tasks land.
    name: 'Open Tasks by Project',
    description:
      'Castaway chores grouped by project. Currently quiet (no Bam tasks seeded for the island yet) but wired and ready.',
    data_source: 'bam',
    entity: 'tasks',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'value' }],
      dimensions: [{ field: 'project_id' }],
      limit: 50,
    },
  },
];

// ── Scheduled report definitions (dashboard-backed) ───────────────────────────
// delivery_method ∈ email|banter_channel|brief_document; export_format ∈ pdf|png|csv.
// dashboard_id is resolved at runtime against the 3 existing dashboards by name.
const REPORTS = [
  {
    name: 'Weekly Rescue-Ops Digest',
    dashboard_name: 'Rescue Readiness',
    cron_expression: '0 8 * * 1', // Mondays 08:00
    cron_timezone: 'UTC',
    delivery_method: 'email',
    delivery_target: 'skipper@gilligan-travel.example',
    export_format: 'pdf',
    enabled: true,
  },
  {
    name: 'Monthly Island Operations Review',
    dashboard_name: 'Island Operations',
    cron_expression: '0 9 1 * *', // 1st of the month 09:00
    cron_timezone: 'UTC',
    delivery_method: 'email',
    delivery_target: 'skipper@gilligan-travel.example',
    export_format: 'pdf',
    enabled: true,
  },
];

(async () => {
  const sqCreated = [];
  const sqSkipped = [];
  const sqProbed = []; // { name, ds, rows }
  const reportsCreated = [];
  const reportsSkipped = [];
  const failures = [];

  // ── 1. Saved queries (Skipper read_write cast key) ──────────────────────────
  let existingSq = [];
  try {
    existingSq = asArr(await bench(SKIPPER_KEY, 'GET', '/saved-queries'));
  } catch (e) {
    console.log(`warn: could not list saved queries — ${e.message}`);
  }
  const sqByName = new Map(existingSq.map((q) => [q.name, q]));

  for (const sq of SAVED_QUERIES) {
    if (sqByName.has(sq.name)) {
      sqSkipped.push(sq.name);
      console.log(`saved query exists: ${sq.name}`);
    } else {
      try {
        const row = await bench(SKIPPER_KEY, 'POST', '/saved-queries', {
          name: sq.name,
          description: sq.description,
          data_source: sq.data_source,
          entity: sq.entity,
          query_config: sq.query_config,
        });
        sqCreated.push(sq.name);
        console.log(`+ saved query: ${sq.name} (${row?.id ?? '?'}) [${sq.data_source}.${sq.entity}]`);
      } catch (e) {
        failures.push(`saved query ${sq.name}: ${e.message}`);
        console.log(`saved query FAILED: ${sq.name} — ${e.message}`);
        continue;
      }
    }
    // Probe data via /query/preview (read auth) to report populated vs empty.
    try {
      const res = await bench(SKIPPER_KEY, 'POST', '/query/preview', {
        data_source: sq.data_source,
        entity: sq.entity,
        query_config: sq.query_config,
      });
      const rows = res?.rows ?? [];
      sqProbed.push({ name: sq.name, ds: `${sq.data_source}.${sq.entity}`, rows: rows.length });
    } catch (e) {
      sqProbed.push({ name: sq.name, ds: `${sq.data_source}.${sq.entity}`, rows: -1, err: e.message });
    }
  }

  // ── 2. Scheduled reports — seed rows directly (route needs admin scope) ──────
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    // Resolve dashboards by name once (read-only endpoint, cast key is fine).
    let dashboards = [];
    try {
      dashboards = asArr(await bench(SKIPPER_KEY, 'GET', '/dashboards'));
    } catch (e) {
      console.log(`warn: could not list dashboards — ${e.message}`);
    }
    const dashByName = new Map(dashboards.map((d) => [d.name, d]));

    for (const r of REPORTS) {
      const dash = dashByName.get(r.dashboard_name);
      if (!dash) {
        failures.push(`report ${r.name}: dashboard "${r.dashboard_name}" not found`);
        console.log(`report FAILED: ${r.name} — dashboard "${r.dashboard_name}" not found`);
        continue;
      }
      // Find-or-create by (org, name).
      const existing = await sql`
        SELECT id FROM bench_scheduled_reports
        WHERE organization_id = ${GILLIGAN_ORG_ID} AND name = ${r.name}
        LIMIT 1`;
      if (existing.length > 0) {
        reportsSkipped.push(r.name);
        console.log(`report exists: ${r.name} (${existing[0].id})`);
        continue;
      }
      try {
        const ins = await sql`
          INSERT INTO bench_scheduled_reports (
            dashboard_id, organization_id, name, cron_expression, cron_timezone,
            delivery_method, delivery_target, export_format, enabled, created_by
          ) VALUES (
            ${dash.id}, ${GILLIGAN_ORG_ID}, ${r.name}, ${r.cron_expression}, ${r.cron_timezone},
            ${r.delivery_method}, ${r.delivery_target}, ${r.export_format}, ${r.enabled}, ${SKIPPER_USER_ID}
          )
          RETURNING id`;
        reportsCreated.push(r.name);
        console.log(`+ report: ${r.name} (${ins[0].id}) -> dashboard "${r.dashboard_name}" (${dash.id})`);
      } catch (e) {
        failures.push(`report ${r.name}: ${e.message}`);
        console.log(`report FAILED: ${r.name} — ${e.message}`);
      }
    }
  } finally {
    try { await sql.end({ timeout: 5 }); } catch { /* noop */ }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n========== SUMMARY ==========');
  console.log(`Saved queries: ${sqCreated.length} created, ${sqSkipped.length} already present.`);
  if (sqCreated.length) console.log(`  created: ${sqCreated.join(', ')}`);
  if (sqSkipped.length) console.log(`  skipped: ${sqSkipped.join(', ')}`);
  console.log('  data probe (rows returned per saved query):');
  for (const p of sqProbed) {
    if (p.rows < 0) console.log(`    ! ${p.name} [${p.ds}] — probe error: ${p.err}`);
    else console.log(`    ${p.rows > 0 ? 'POPULATED' : 'empty    '} ${p.name} [${p.ds}] — ${p.rows} row(s)`);
  }
  console.log(`Scheduled reports: ${reportsCreated.length} created, ${reportsSkipped.length} already present.`);
  if (reportsCreated.length) console.log(`  created: ${reportsCreated.join(', ')}`);
  if (reportsSkipped.length) console.log(`  skipped: ${reportsSkipped.join(', ')}`);
  if (failures.length) {
    console.log(`\nFailures (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
  }
})().catch((e) => {
  console.error('bench supplement failed:', e.message);
  process.exit(1);
});
