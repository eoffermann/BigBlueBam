/**
 * Gilligan's Island themed Bench (analytics dashboards) seed.
 *
 * The Professor runs the island's "ops metrics" on BigBlueBam Bench. This
 * builds 3 themed dashboards full of (mostly tongue-in-cheek) widgets so the
 * dashboard list and a dashboard view both look populated.
 *
 * Idempotent: skips a dashboard if one with the same name exists, and skips
 * a widget if one with the same name already exists on that dashboard.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bench.mjs
 * (api container can reach the internal app hosts; cast API keys authenticate
 *  via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 *
 * NOTE on data: Bench widgets must bind a real data_source/entity with a valid
 * query_config (measures are required by the route schema even for text/kpi
 * widgets). The island's fictional metrics (coconuts, signal fires, bottles)
 * have no real table, so we map each themed widget onto a real, queryable suite
 * source for THIS org. The Gilligan org currently has 6 Bond deals and 11
 * Beacon articles but ZERO Bam tasks, and — separately — the bench-api `bam.tasks`
 * data source is mis-declared (it claims columns `organization_id` + `state`
 * while the real `tasks` table has `org_id` + `state_id`), so any bam.tasks
 * widget 500s regardless of data. See the "DISCOVERED BUG" note at the bottom.
 * We therefore back the data widgets with `bond.deals` (deal count/value,
 * by-stage) and `beacon.articles` (article count, by-status, weekly), which
 * return real Gilligan numbers. Every widget still renders its frame + title;
 * the ones noted below as "populated" carry live data.
 */

const BENCH = 'http://bench-api:4011/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// The Professor curates the island's metrics; fall back to the Skipper.
const OWNER = KEYS.professor ? 'professor' : 'skipper';

function H(who, withBody) {
  // Only advertise a JSON content-type when we actually send a body. bench-api's
  // body parser rejects an empty body when Content-Type is application/json
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which would break bodyless DELETE/POST routes.
  const h = { Authorization: `Bearer ${KEYS[who]}` };
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}
async function bench(who, method, path, body) {
  const hasBody = body !== undefined;
  const r = await fetch(`${BENCH}${path}`, {
    method,
    headers: H(who, hasBody),
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

// ── Reusable query-config builders against real, populated suite sources ──────
// Verified queryable for the Gilligan org:
//   bond.deals    — measures id(count), value(sum/avg); dims stage_id, created_at
//   beacon.articles — measures id(count); dims status, created_at
// (bam.tasks is avoided: org has 0 tasks AND the source mis-declares its columns.)

// ── bond.deals helpers ──
const deals = (extra = {}) => ({ data_source: 'bond', entity: 'deals', ...extra });
// Count of deals (renders a real number).
const qDealCount = () => ({ measures: [{ field: 'id', agg: 'count', alias: 'value' }] });
// Sum / avg of deal value.
const qDealValue = (agg) => ({ measures: [{ field: 'value', agg, alias: 'value' }] });
// Deal count grouped by stage (bar/pie chart).
const qDealsByStage = () => ({
  measures: [{ field: 'id', agg: 'count', alias: 'value' }],
  dimensions: [{ field: 'stage_id' }],
  limit: 50,
});
// Deal count over time (line/area chart).
const qDealsWeekly = () => ({
  measures: [{ field: 'id', agg: 'count', alias: 'value' }],
  time_dimension: { field: 'created_at', granularity: 'week' },
});

// ── beacon.articles helpers ──
const kb = (extra = {}) => ({ data_source: 'beacon', entity: 'articles', ...extra });
// Count of knowledge articles (renders a real number).
const qKbCount = () => ({ measures: [{ field: 'id', agg: 'count', alias: 'value' }] });
// Articles grouped by status (bar/pie chart).
const qKbByStatus = () => ({
  measures: [{ field: 'id', agg: 'count', alias: 'value' }],
  dimensions: [{ field: 'status' }],
  limit: 50,
});
// Articles over time (area chart).
const qKbWeekly = () => ({
  measures: [{ field: 'id', agg: 'count', alias: 'value' }],
  time_dimension: { field: 'created_at', granularity: 'week' },
});

// ── Dashboards + widgets ──────────────────────────────────────────────────────

const DASHBOARDS = [
  {
    name: "Island Operations",
    description:
      "The Professor's master board: are we any closer to getting off this rock, and is Gilligan still on task?",
    widgets: [
      {
        // Backed by total deal count (the island's running tally of "projects").
        name: 'Days Stranded',
        widget_type: 'counter',
        ...deals(),
        query_config: qDealCount(),
        kpi_config: { label: 'days (and counting)', format: 'number' },
        viz_config: { subtitle: 'A three-hour tour. A THREE-HOUR tour.' },
      },
      {
        // Backed by knowledge-base articles over time (Mary Ann's supply ledger).
        name: 'Coconut Inventory (over time)',
        widget_type: 'area_chart',
        ...kb(),
        query_config: qKbWeekly(),
        viz_config: { x: 'created_at', y: 'value', unit: 'coconuts', note: 'Mary Ann counts; Gilligan eats.' },
      },
      {
        // Backed by deals opened per week (each "attempt" at getting noticed).
        name: 'Rescue-Signal Attempts by Week',
        widget_type: 'line_chart',
        ...deals(),
        query_config: qDealsWeekly(),
        viz_config: { x: 'created_at', y: 'value', note: 'Fires, mirrors, flares — anything that smokes.' },
      },
      {
        // Backed by open work grouped by stage (the island's "projects").
        name: 'Open Tasks by Project',
        widget_type: 'bar_chart',
        ...deals(),
        query_config: qDealsByStage(),
        viz_config: { x: 'stage_id', y: 'value', note: 'Raft, Radio, Luau — pick your escape route.' },
      },
      {
        // Backed by KB articles by status (Draft vs Active = WIP vs built).
        name: 'Raft Build Progress',
        widget_type: 'progress_bar',
        ...kb(),
        query_config: qKbByStatus(),
        kpi_config: { label: 'plans by status', target: 100, format: 'number' },
        viz_config: { note: 'Do NOT let Gilligan caulk the seams.' },
      },
    ],
  },
  {
    name: "Rescue Readiness",
    description:
      "Skipper's at-a-glance scoreboard for every way we're trying to flag down civilization.",
    widgets: [
      {
        // Backed by total deal count.
        name: 'Signal Fires Lit',
        widget_type: 'kpi_card',
        ...deals(),
        query_config: qDealCount(),
        kpi_config: { label: 'fires burning on Lookout Point', format: 'number' },
        viz_config: { subtitle: 'Gilligan in charge of the firewood. Pray.' },
      },
      {
        // Backed by total deal VALUE (every ship is worth a fortune to us).
        name: 'Ships Sighted',
        widget_type: 'counter',
        ...deals(),
        query_config: qDealValue('sum'),
        kpi_config: { label: 'ships sighted (then mysteriously gone)', format: 'number' },
      },
      {
        // Backed by KB article count.
        name: 'Message Bottles Released',
        widget_type: 'kpi_card',
        ...kb(),
        query_config: qKbCount(),
        kpi_config: { label: 'bottles bobbing toward Hawaii', format: 'number' },
        viz_config: { subtitle: 'One of them will reach SOMEONE. Probably.' },
      },
      {
        // Backed by average deal value (a "level" reading for the gauge).
        name: 'Radio Uptime',
        widget_type: 'gauge',
        ...deals(),
        query_config: qDealValue('avg'),
        kpi_config: { label: '% uptime (coconut-powered)', min: 0, max: 100, format: 'percent' },
        viz_config: { note: 'Down whenever Gilligan stops pedaling the generator.' },
      },
      {
        // Backed by deals grouped by stage.
        name: 'Readiness by Pipeline Stage',
        widget_type: 'pie_chart',
        ...deals(),
        query_config: qDealsByStage(),
        viz_config: { label: 'stage_id', value: 'value' },
      },
    ],
  },
  {
    name: "Howell Luau Prep",
    description:
      "Lovey approves every detail; Mr. Howell funds it. The most lavish gala on a deserted island.",
    widgets: [
      {
        // Backed by total deal count (guest list stand-in).
        name: 'RSVP Count',
        widget_type: 'counter',
        ...deals(),
        query_config: qDealCount(),
        kpi_config: { label: 'guests confirmed (population: 7)', format: 'number' },
        viz_config: { subtitle: 'The whole island, plus any passing headhunters.' },
      },
      {
        // Backed by deal VALUE over time (the Howell expense account).
        name: 'Budget Burn',
        widget_type: 'area_chart',
        ...deals(),
        query_config: {
          measures: [{ field: 'value', agg: 'sum', alias: 'value' }],
          time_dimension: { field: 'created_at', granularity: 'week' },
        },
        viz_config: { x: 'created_at', y: 'value', unit: 'Howell dollars', note: 'Cost is no object when there is nothing to buy.' },
      },
      {
        // Backed by KB article count (the prep checklist).
        name: 'Tasks Remaining',
        widget_type: 'kpi_card',
        ...kb(),
        query_config: qKbCount(),
        kpi_config: { label: 'to-dos before the conch shell sounds', format: 'number' },
        viz_config: { subtitle: 'Lovey, dear, the leis are not symmetrical.' },
      },
      {
        // Backed by KB articles by status.
        name: 'Prep Items by Status',
        widget_type: 'bar_chart',
        ...kb(),
        query_config: qKbByStatus(),
        viz_config: { x: 'status', y: 'value' },
      },
    ],
  },
];

(async () => {
  let dashCreated = 0;
  let widgetsMade = 0;
  let widgetsSkipped = 0;
  let widgetsFixed = 0;
  let widgetsRemoved = 0;
  const failures = [];

  try {
    const sources = asArr(await bench(OWNER, 'GET', '/data-sources'));
    const hasBond = sources.some((s) => s.product === 'bond' && s.entity === 'deals');
    const hasBeacon = sources.some((s) => s.product === 'beacon' && s.entity === 'articles');
    console.log(`data sources reachable: ${sources.length}; bond.deals: ${hasBond}; beacon.articles: ${hasBeacon}`);
  } catch (e) {
    console.log(`warn: could not list data sources — ${e.message}`);
  }

  for (const d of DASHBOARDS) {
    // Find-or-create the dashboard (org-visible so the list looks populated).
    const existing = asArr(await bench(OWNER, 'GET', '/dashboards'));
    let dash = existing.find((x) => x.name === d.name);
    if (!dash) {
      dash = await bench(OWNER, 'POST', '/dashboards', {
        name: d.name,
        description: d.description,
        visibility: 'organization',
      });
      dashCreated++;
      console.log(`dashboard: ${d.name} (${dash.id})`);
    } else {
      console.log(`dashboard exists: ${d.name} (${dash.id})`);
    }

    // Existing widgets on this dashboard, indexed by name.
    const full = await bench(OWNER, 'GET', `/dashboards/${dash.id}`);
    const existingWidgets = full?.widgets ?? [];
    const byName = new Map(existingWidgets.map((w) => [w.name, w]));
    const specNames = new Set(d.widgets.map((w) => w.name));

    // Reconcile: remove stale widgets no longer in the spec (e.g. renamed, or
    // the old bam.tasks-backed widgets from an earlier run).
    for (const ew of existingWidgets) {
      if (!specNames.has(ew.name)) {
        try {
          await bench(OWNER, 'DELETE', `/widgets/${ew.id}`);
          widgetsRemoved++;
          console.log(`  - removed stale widget: ${ew.name}`);
        } catch (e) {
          console.log(`  could not remove stale widget ${ew.name} — ${e.message}`);
        }
      }
    }

    for (const w of d.widgets) {
      const body = {
        name: w.name,
        widget_type: w.widget_type,
        data_source: w.data_source,
        entity: w.entity,
        query_config: w.query_config,
        ...(w.viz_config ? { viz_config: w.viz_config } : {}),
        ...(w.kpi_config ? { kpi_config: w.kpi_config } : {}),
      };
      const ew = byName.get(w.name);
      if (ew) {
        // Self-heal: if an existing widget points at a different/broken source
        // (e.g. the first run's bam.tasks), PATCH it to the corrected config.
        // Otherwise treat it as already-present and skip.
        if (ew.data_source !== w.data_source || ew.entity !== w.entity) {
          try {
            await bench(OWNER, 'PATCH', `/widgets/${ew.id}`, body);
            widgetsFixed++;
            console.log(`  ~ fixed widget: ${w.name} (${ew.data_source}.${ew.entity} -> ${w.data_source}.${w.entity})`);
          } catch (e) {
            failures.push(`${d.name} / ${w.name} (patch): ${e.message}`);
            console.log(`  widget PATCH FAILED: ${w.name} — ${e.message}`);
          }
        } else {
          console.log(`  widget exists: ${w.name}`);
          widgetsSkipped++;
        }
        continue;
      }
      try {
        await bench(OWNER, 'POST', `/dashboards/${dash.id}/widgets`, body);
        widgetsMade++;
        console.log(`  + widget: ${w.name} (${w.widget_type})`);
      } catch (e) {
        failures.push(`${d.name} / ${w.name}: ${e.message}`);
        console.log(`  widget FAILED: ${w.name} — ${e.message}`);
      }
    }
  }

  // Probe each widget query so we can report populated-vs-empty.
  console.log('\n--- widget data probe (populated vs empty) ---');
  let populated = 0;
  let empty = 0;
  // Re-fetch dashboards to get widget ids, then query each widget.
  const allDash = asArr(await bench(OWNER, 'GET', '/dashboards'));
  for (const d of DASHBOARDS) {
    const dash = allDash.find((x) => x.name === d.name);
    if (!dash) continue;
    const full = await bench(OWNER, 'GET', `/dashboards/${dash.id}`);
    for (const w of full?.widgets ?? []) {
      try {
        // The query route sets content-type via our headers; Fastify rejects an
        // empty JSON body, so send an empty object to satisfy the parser.
        const res = await bench(OWNER, 'POST', `/widgets/${w.id}/query`, {});
        const rows = res?.rows ?? [];
        if (rows.length > 0) {
          populated++;
          const v = rows[0]?.value ?? JSON.stringify(rows[0]);
          console.log(`  populated: ${d.name} / ${w.name} (${rows.length} row(s), first=${typeof v === 'object' ? JSON.stringify(v) : v})`);
        } else {
          empty++;
          console.log(`  empty:     ${d.name} / ${w.name} (0 rows — frame + title still render)`);
        }
      } catch (e) {
        empty++;
        console.log(`  query err: ${d.name} / ${w.name} — ${e.message}`);
      }
    }
  }

  console.log(
    `\nBench seed done: ${dashCreated} new dashboards, ${widgetsMade} created, ${widgetsFixed} fixed, ${widgetsRemoved} stale removed, ${widgetsSkipped} already correct.`,
  );
  console.log(`Widget data: ${populated} populated, ${empty} empty.`);
  if (failures.length) {
    console.log(`\nFailures (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
  }
})().catch((e) => {
  console.error('bench seed failed:', e.message);
  process.exit(1);
});

/*
 * DISCOVERED BUG (bench-api data-source registry, NOT this seed) — 2026-06-17
 * --------------------------------------------------------------------------
 * apps/bench-api/src/lib/data-source-registry.ts declares the `bam.tasks`
 * source with the wrong tenant column and the wrong state column:
 *   - orgColumn defaults to `organization_id`, but the real `tasks` table uses
 *     `org_id` (like the bureau_* tables, which DO override orgColumn).
 *   - dimensions/filters reference `state`, but the real column is `state_id`.
 * Result: EVERY bam.tasks widget/ad-hoc query 500s with
 *   PostgresError: column "organization_id" does not exist   (or "state").
 * This blocks any Bench analytics over Bam tasks org-wide, not just this seed.
 *
 * Suggested fix (separate change, since this task is "do NOT edit other files"):
 *   In the `bam`/`tasks` entry of DATA_SOURCES add `orgColumn: 'org_id'`, and
 *   change the `state` dimension+filter field to `state_id` (or join the
 *   task_states table to expose a human `state` label). Then re-point these
 *   Gilligan widgets back at bam.tasks once the org actually has seeded tasks.
 */
