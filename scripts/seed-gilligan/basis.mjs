/**
 * Gilligan's Island themed Basis (governed metric layer) seed.
 *
 * The castaways run their rescue operation on numbers everyone agrees on: how
 * many coconuts they log, how much the Howells' rescue fund has raised, the open
 * chore backlog. Basis defines each metric ONCE (over data that already lives in
 * Bam/Bill via Bench) and certifies it so every screen and agent reads the same
 * figure. Idempotent: skips a metric whose slug already exists.
 *
 * Depends on bam.mjs (tasks) and bill.mjs (invoices) having run first, so the
 * definitions resolve against real gilligan data through Bench.
 *
 * Run from the repo host (the api container can reach basis-api on the compose
 * network; cast API keys authenticate via Bearer):
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/basis.mjs
 */

const BASIS = 'http://basis-api:4019/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (must match the other gilligan seeders).
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
};

// Only send Content-Type when there is a JSON body. A bodyless POST (certify,
// decertify) with Content-Type: application/json makes Fastify try to parse an
// empty body and reject with 400.
function H(who, hasBody) {
  const h = { Authorization: `Bearer ${KEYS[who]}` };
  if (hasBody) h['Content-Type'] = 'application/json';
  return h;
}

async function basis(who, method, path, body) {
  const r = await fetch(`${BASIS}${path}`, {
    method,
    headers: H(who, body != null),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: data.data ?? data, raw: data };
}

// Themed metrics. Definitions use only sources verified to resolve for gilligan
// (bam.tasks, bill.invoices). Class-A dimensions (status/priority) give a labeled
// "why did it change" breakdown out of the box.
const METRICS = [
  {
    owner: 'skipper',
    certify: true,
    target: { value: 3, comparison: 'gte' }, // keep at least 3 coconuts a day
    body: {
      slug: 'daily_coconut_count',
      name: 'Daily Coconut Count',
      description: 'Coconuts logged as tasks by the crew. The islands core productivity signal.',
      unit: 'count',
      favorable_direction: 'up',
      related_apps: ['bam'],
      definition: {
        source_product: 'bam',
        source_entity: 'tasks',
        measure: { field: 'id', agg: 'count' },
        default_dimensions: ['priority'],
        time_column: 'created_at',
      },
    },
    // A second version so the detail page shows real version history.
    secondVersion: {
      change_note: 'Widen to all logged tasks, not just high priority',
      definition: {
        source_product: 'bam',
        source_entity: 'tasks',
        measure: { field: 'id', agg: 'count' },
        default_dimensions: ['priority', 'status'],
        time_column: 'created_at',
      },
    },
  },
  {
    owner: 'howell',
    certify: true,
    body: {
      slug: 'rescue_fund_revenue',
      name: 'Rescue Fund Revenue',
      description: 'Total billed toward the castaway rescue fund (the Howells foot most of it).',
      unit: 'currency',
      favorable_direction: 'up',
      related_apps: ['bill'],
      definition: {
        source_product: 'bill',
        source_entity: 'invoices',
        measure: { field: 'amount', agg: 'sum' },
        default_dimensions: ['status'],
        time_column: 'created_at',
      },
    },
  },
  {
    owner: 'professor',
    certify: false, // stays a draft to show the lifecycle in the catalog
    body: {
      slug: 'open_chore_backlog',
      name: 'Open Chore Backlog',
      description: 'Outstanding chores on the island. Lower is better - we want off this rock.',
      unit: 'count',
      favorable_direction: 'down',
      related_apps: ['bam'],
      definition: {
        source_product: 'bam',
        source_entity: 'tasks',
        measure: { field: 'id', agg: 'count' },
        default_dimensions: ['status'],
        time_column: 'created_at',
      },
    },
  },
  {
    owner: 'lovey',
    certify: false,
    body: {
      slug: 'luau_invoice_count',
      name: 'Luau Invoice Count',
      description: 'Number of invoices raised for the Howells island events.',
      unit: 'count',
      favorable_direction: 'neutral',
      related_apps: ['bill'],
      definition: {
        source_product: 'bill',
        source_entity: 'invoices',
        measure: { field: 'id', agg: 'count' },
        default_dimensions: ['status'],
        time_column: 'created_at',
      },
    },
  },
];

async function existingBySlug() {
  const r = await basis('skipper', 'GET', '/metrics');
  if (!r.ok) return new Map();
  const list = Array.isArray(r.data) ? r.data : [];
  return new Map(list.map((m) => [m.slug, m]));
}

async function main() {
  if (!KEYS.skipper) {
    console.error('[basis] no cast API keys in GKEYS; skipping');
    return;
  }
  const existing = await existingBySlug();
  let created = 0;
  let certified = 0;
  let skipped = 0;

  for (const m of METRICS) {
    const who = KEYS[m.owner] ? m.owner : 'skipper';
    const prior = existing.get(m.body.slug);
    if (prior) {
      // Self-heal: if it should be certified but is still a draft (e.g. a prior
      // partial run), certify it now instead of just skipping.
      if (m.certify && prior.certification === 'draft') {
        const cert = await basis(who, 'POST', `/metrics/${prior.id}/certify`);
        if (cert.ok) {
          certified++;
          console.log(`[basis] certified existing ${m.body.slug}`);
        } else {
          console.error(`[basis] certify existing ${m.body.slug} -> ${cert.status}`);
        }
      } else {
        console.log(`[basis] skip (exists): ${m.body.slug}`);
      }
      skipped++;
      continue;
    }
    const c = await basis(who, 'POST', '/metrics', {
      ...m.body,
      owner_id: CAST[m.owner] ?? CAST.skipper,
    });
    if (!c.ok) {
      console.error(`[basis] create ${m.body.slug} -> ${c.status} ${JSON.stringify(c.raw).slice(0, 160)}`);
      continue;
    }
    const id = c.data.metric.id;
    created++;
    console.log(`[basis] created ${m.body.slug} (${id})`);

    if (m.secondVersion) {
      const v = await basis(who, 'POST', `/metrics/${id}/versions`, m.secondVersion);
      if (v.ok) console.log(`[basis]   + version 2 on ${m.body.slug}`);
    }
    if (m.target) {
      await basis(who, 'PATCH', `/metrics/${id}`, { target: m.target });
    }
    if (m.certify) {
      const cert = await basis(who, 'POST', `/metrics/${id}/certify`);
      if (cert.ok) {
        certified++;
        console.log(`[basis]   certified ${m.body.slug}`);
      } else {
        console.error(`[basis]   certify ${m.body.slug} -> ${cert.status}`);
      }
    }
  }

  console.log(`[basis] done: ${created} created, ${certified} certified, ${skipped} skipped`);
}

main().catch((err) => {
  console.error('[basis] failed:', err.message);
  process.exit(1);
});
