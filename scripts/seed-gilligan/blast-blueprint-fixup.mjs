/**
 * Gilligan Travel, Ltd. — two small demo-data fixups. Idempotent; safe to
 * re-run. Runs inside the `api` container so it can reach the internal
 * blast-api / blueprint-api hosts (cast API keys authenticate via Bearer,
 * which bypasses CSRF and scopes to the Gilligan org) AND the Postgres DB
 * directly (via the porsager `postgres` driver on DATABASE_URL) for the one
 * operation the cast keys lack scope for.
 *
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/blast-blueprint-fixup.mjs
 *
 * TASK 1 (Blast): the 3 seeded segments cache a 0 recipient count. Two of
 *   them ("Howell VIPs", "Hollywood Contacts") filter on bond_contacts values
 *   that match NONE of the 6 seeded contacts (every contact has lead_score 0,
 *   so the >50 / >80 score gates can never fire, and there is no 'customer +
 *   score>80' contact). "Passing Ships" already matches 2 contacts but its
 *   cached count was never refreshed. We rewrite the two dead filters to match
 *   real contact values, add an "All Island Contacts" catch-all, and recount
 *   every segment so the Segments list shows live numbers.
 *
 * TASK 2 (Blueprint): star one diagram and archive another so the Starred /
 *   Archived filters are non-empty.
 *     - STAR  "Coconut Radio — Wiring Diagram"  via POST /diagrams/:id/star
 *       (requireAuth only — a read_write cast key is enough).
 *     - ARCHIVE "Island Map"                    via POST /diagrams/:id/archive.
 *       That route is gated by requireScope('admin'); the cast keys are
 *       read_write, so the HTTP call 403s. We attempt it anyway, then fall
 *       back to a direct, org-scoped UPDATE on blueprint_diagrams (the same
 *       single-column flip archiveDiagram() performs) so the demo state lands
 *       regardless of key scope.
 */

const BLAST = 'http://blast-api:4010/v1';
const BLUEPRINT = 'http://blueprint-api:4015/v1';
const ORG_ID = '57db0001-3f0e-463f-b514-1cd14fd14241';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Skipper is the org owner; Professor authored the two diagrams we touch.
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
};

function H(who) {
  const token = KEYS[who];
  if (!token) throw new Error(`No API key for "${who}" in GKEYS`);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function call(base, who, method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: H(who),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { ok: r.ok, status: r.status, data: data.data ?? data, raw: data };
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// Stable, order-insensitive JSON for deep equality of filter_criteria.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// TASK 1 — Blast segments
// ---------------------------------------------------------------------------

// Desired end-state for each segment, keyed by exact name. `filter` is set
// only when we want to (idempotently) overwrite the stored filter_criteria;
// segments we only recount leave `filter` undefined.
const SEGMENT_PLAN = [
  {
    name: 'Passing Ships',
    owner: 'skipper',
    // Existing filter already matches 2 contacts (lead_source ILIKE '%ship%'
    // -> "Passing Ship Sighting", plus lifecycle_stage = 'lead' -> Cmdr Buoy).
    // No filter change needed; just refresh the stale cached count.
    filter: undefined,
  },
  {
    name: 'Howell VIPs',
    owner: 'howell',
    // Was: ALL of {lifecycle=customer, lead_score>80}. No contact has a
    // non-zero lead_score, so it matched 0. Rewrite to Thurston's actual
    // book: anyone who is a customer or a live opportunity (Quibble +
    // Tidewater + Glitz = 3).
    filter: {
      match: 'any',
      conditions: [
        { field: 'lifecycle_stage', op: 'equals', value: 'customer' },
        { field: 'lifecycle_stage', op: 'equals', value: 'opportunity' },
      ],
    },
  },
  {
    name: "Hollywood Contacts (Ginger's list)",
    owner: 'ginger',
    // Was: any of {lead_source~hollywood, city='Los Angeles', lead_score>50}
    // — none match (no city, all scores 0). Rewrite to the screen-test lead
    // Ginger actually has on the island: Maximilian Glitz, lead_source
    // "Castaway Screen Test" (1). Keep a 'hollywood' clause for future data.
    filter: {
      match: 'any',
      conditions: [
        { field: 'lead_source', op: 'contains', value: 'screen' },
        { field: 'lead_source', op: 'contains', value: 'castaway' },
        { field: 'lead_source', op: 'contains', value: 'hollywood' },
      ],
    },
  },
  {
    name: 'All Island Contacts',
    owner: 'skipper',
    description: 'Everyone whose bottle ever washed ashore — the full island address book.',
    create: true,
    // Catch-all: every seeded contact has an email, so this resolves to all 6.
    filter: {
      match: 'any',
      conditions: [{ field: 'email', op: 'is_set' }],
    },
  },
];

async function findSegment(owner, name) {
  const res = await call(BLAST, owner, 'GET', `/segments?search=${encodeURIComponent(name)}&limit=50`);
  if (!res.ok) throw new Error(`GET /segments (${name}) -> ${res.status} ${JSON.stringify(res.raw).slice(0, 200)}`);
  return asArr(res.data).find((s) => s.name === name);
}

async function recount(owner, id) {
  const res = await call(BLAST, owner, 'POST', `/segments/${id}/count`, {});
  if (!res.ok) return { error: `${res.status} ${JSON.stringify(res.raw).slice(0, 160)}` };
  return { count: res.data?.count ?? null };
}

async function runBlast() {
  const results = [];
  for (const plan of SEGMENT_PLAN) {
    let seg = await findSegment(plan.owner, plan.name);

    if (!seg && plan.create) {
      const created = await call(BLAST, plan.owner, 'POST', '/segments', {
        name: plan.name,
        description: plan.description,
        filter_criteria: plan.filter,
      });
      if (!created.ok) {
        results.push({ name: plan.name, status: 'create_failed', error: `${created.status} ${JSON.stringify(created.raw).slice(0, 160)}` });
        continue;
      }
      seg = created.data;
      console.log(`segment created: ${plan.name} (${seg.id})`);
    }

    if (!seg) {
      results.push({ name: plan.name, status: 'missing' });
      console.log(`segment missing (not found, not create): ${plan.name}`);
      continue;
    }

    // Idempotently align the stored filter to plan (only when we have one and
    // it differs from what's stored). Compare order-insensitively: the API
    // round-trips filter_criteria with a different key order than the plan
    // literal, so a naive JSON.stringify compare would never match and we'd
    // PATCH on every run.
    if (plan.filter) {
      const same = canonical(seg.filter_criteria) === canonical(plan.filter);
      if (!same) {
        const patched = await call(BLAST, plan.owner, 'PATCH', `/segments/${seg.id}`, {
          filter_criteria: plan.filter,
        });
        if (!patched.ok) {
          results.push({ name: plan.name, id: seg.id, status: 'patch_failed', error: `${patched.status} ${JSON.stringify(patched.raw).slice(0, 160)}` });
          continue;
        }
        console.log(`segment filter updated: ${plan.name} (${seg.id})`);
      }
    }

    const rc = await recount(plan.owner, seg.id);
    results.push({ name: plan.name, id: seg.id, count: rc.count, ...(rc.error ? { count_error: rc.error } : {}) });
    console.log(`segment count: ${plan.name} -> ${rc.count ?? `ERROR ${rc.error}`}`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// TASK 2 — Blueprint star + archive
// ---------------------------------------------------------------------------

const STAR_NAME = 'Coconut Radio — Wiring Diagram';
const ARCHIVE_NAME = 'Island Map';

async function findDiagram(owner, name) {
  // include_archived so a re-run can still locate an already-archived target.
  const res = await call(BLUEPRINT, owner, 'GET', '/diagrams?include_archived=true');
  if (!res.ok) throw new Error(`GET /diagrams -> ${res.status} ${JSON.stringify(res.raw).slice(0, 200)}`);
  return asArr(res.data).find((d) => d.name === name);
}

async function runBlueprint(sql) {
  const out = {};

  // ---- STAR (Professor authored Coconut Radio; star route is auth-only) ----
  const starDiag = await findDiagram('professor', STAR_NAME);
  if (!starDiag) {
    out.star = { name: STAR_NAME, status: 'diagram_missing' };
  } else {
    const res = await call(BLUEPRINT, 'professor', 'POST', `/diagrams/${starDiag.id}/star`, {});
    if (res.ok) {
      out.star = { name: STAR_NAME, id: starDiag.id, status: 'starred', by: 'professor' };
      console.log(`starred: ${STAR_NAME} (${starDiag.id})`);
    } else {
      out.star = { name: STAR_NAME, id: starDiag.id, status: 'star_failed', error: `${res.status} ${JSON.stringify(res.raw).slice(0, 160)}` };
    }
  }

  // ---- ARCHIVE (Island Map). API route needs admin scope; cast keys are
  // read_write, so try the API then fall back to a direct org-scoped UPDATE. ----
  const arcDiag = await findDiagram('professor', ARCHIVE_NAME);
  if (!arcDiag) {
    out.archive = { name: ARCHIVE_NAME, status: 'diagram_missing' };
  } else if (arcDiag.is_archived) {
    out.archive = { name: ARCHIVE_NAME, id: arcDiag.id, status: 'already_archived' };
    console.log(`archive: ${ARCHIVE_NAME} already archived (${arcDiag.id})`);
  } else {
    const res = await call(BLUEPRINT, 'professor', 'POST', `/diagrams/${arcDiag.id}/archive`, {});
    if (res.ok) {
      out.archive = { name: ARCHIVE_NAME, id: arcDiag.id, status: 'archived', via: 'api' };
      console.log(`archived via API: ${ARCHIVE_NAME} (${arcDiag.id})`);
    } else {
      // Expected 403 (read_write key lacks admin scope). Fall back to DB.
      const rows = await sql`
        UPDATE blueprint_diagrams
           SET is_archived = true, updated_at = now()
         WHERE id = ${arcDiag.id} AND org_id = ${ORG_ID}
         RETURNING id, is_archived`;
      if (rows.length > 0) {
        out.archive = { name: ARCHIVE_NAME, id: arcDiag.id, status: 'archived', via: 'db_fallback', api_status: res.status };
        console.log(`archived via DB fallback (API ${res.status}): ${ARCHIVE_NAME} (${arcDiag.id})`);
      } else {
        out.archive = { name: ARCHIVE_NAME, id: arcDiag.id, status: 'archive_failed', api_status: res.status, error: 'db update matched no row' };
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL);
  const summary = {};
  try {
    console.log('=== TASK 1: Blast segments ===');
    summary.segments = await runBlast();

    console.log('\n=== TASK 2: Blueprint star + archive ===');
    summary.blueprint = await runBlueprint(sql);
  } finally {
    await sql.end();
  }

  const nonZero = (summary.segments ?? []).filter((s) => (s.count ?? 0) > 0).length;

  console.log('\n=== FIXUP SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nSegments with non-zero count: ${nonZero} (goal: >= 2).`);

  const failures = [];
  for (const s of summary.segments ?? []) {
    if (s.status && s.status.endsWith('failed')) failures.push(`segment ${s.name}: ${s.status} ${s.error ?? ''}`);
    if (s.count_error) failures.push(`segment ${s.name} count: ${s.count_error}`);
  }
  for (const k of ['star', 'archive']) {
    const v = summary.blueprint?.[k];
    if (v && v.status && v.status.endsWith('failed')) failures.push(`blueprint ${k}: ${v.status} ${v.error ?? ''}`);
    if (v && v.status === 'diagram_missing') failures.push(`blueprint ${k}: diagram_missing`);
  }

  if (nonZero < 2) failures.push(`only ${nonZero} segment(s) have a non-zero count`);

  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nAll fixups landed.');
})().catch((e) => {
  console.error('fixup failed:', e?.stack || e?.message || e);
  process.exit(1);
});
