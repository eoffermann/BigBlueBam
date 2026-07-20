/**
 * Gilligan's Island themed Bursar (procurement leveling & spend-baseline) seed.
 *
 * The castaways need a rescue beacon. The Skipper opens the "Lagoon Rescue Beacon
 * Procurement" request, four island suppliers bid, and Bursar levels the quotes -
 * surfacing the crew training Howell's bid is silent about and the installation it
 * quietly excludes, so the sticker-cheapest offer is not the cheapest deal. The
 * award is frozen into a baseline, and post-award the detectors light up on the
 * Island Weather Feed's price drift and renewal cliff.
 *
 * DETERMINISTIC materialization (no live LLM). The original seed drove the async
 * derive-scope -> level engines, which call the internal LLM proxy: non-deterministic,
 * provider-dependent, and (with no provider seeded) it left the request stuck at
 * scope_status='pending' with 5 nodes, no leveling, no coverage, and no award. This
 * seeder instead writes the FULL settled end-state directly via SQL - the 14-node
 * confirmed scope tree, the four leveling runs, the per-(offer, node) coverage matrix,
 * the comparable totals, and the split-blanket manipulation finding - then calls the
 * REAL POST /awards route so the Radio Parts baseline (hash, entity_links, events) is
 * produced authentically from the coverage it reads. The result reproduces
 * BURSAR_SEED_EXPECTATIONS exactly, so the Matrix/Diff UI, screenshots, and the 12-step
 * Playwright suite all settle on one canonical state.
 *
 * Depends on bond.mjs (companies) and bill.mjs (expenses) having run first - it is
 * registered in run-all.mjs's Billing phase. Idempotent: if an award already exists on
 * the request the whole build is skipped; otherwise it CLEANS the request's prior
 * offers/nodes/coverage/runs/mismatches and rebuilds from scratch (safe to re-run).
 * Every insert carries the gilligan organization_id (resolved from the request row).
 *
 * Runs INSIDE the api container (`docker compose exec -T api node -`), so it can do BOTH
 * HTTP calls to bursar-api (vendors, the award route) AND direct SQL via the `postgres`
 * driver on DATABASE_URL (the pattern bay.mjs already uses). Bursar internal host is
 * http://bursar-api:4023 and ALL routes register under /v1. Money is in MINOR units
 * (cents). NEVER seed the generic e2e org - gilligan only.
 *
 * Run via run-all.mjs, which injects BURSAR_EXPECTATIONS (the canonical number set from
 * bursar.expectations.mjs) so this seeder and the Playwright suite agree on one source
 * (spec 19.3). Standalone:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bursar.mjs
 */

import { createHash } from 'node:crypto';
import postgres from 'postgres';

const BASE = 'http://bursar-api:4023/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Canonical numbers, injected by run-all.mjs from bursar.expectations.mjs (spec 19.3).
// Absent on a standalone run; the inline INLINE_* fallbacks below mirror the same figures
// so the seeder builds the identical state either way.
const EXP = (() => {
  try {
    return JSON.parse(process.env.BURSAR_EXPECTATIONS || '{}');
  } catch {
    return {};
  }
})();

// Cast owner (Skipper) - the request owner and the identity the Playwright suite runs as.
const OWNER = 'skipper';
const REQUEST_TITLE = 'Lagoon Rescue Beacon Procurement';

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

// A deterministic, valid UUID (v5-shaped) from stable parts, so every re-run computes the
// same ids and the natural unique keys line up. Not a real namespaced v5 - just a stable,
// well-formed uuid for seed rows.
function duid(...parts) {
  const h = sha256(parts.join('|'));
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function H(who, hasBody) {
  const h = { Authorization: `Bearer ${KEYS[who]}` };
  if (hasBody) h['Content-Type'] = 'application/json';
  return h;
}

async function api(who, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: H(who, body != null),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: data?.data ?? data, raw: data };
}

// ── Vendors (5), with the messy aliases spec 19 calls out ──────────────
const VENDORS = [
  {
    key: 'howell',
    display_name: 'Howell Industries Salvage',
    category: 'hardware',
    criticality: 'high',
    aliases: ['HOWELL IND *SALVAGE', 'Howell Industries Inc', 'THURSTON HOWELL III HLDG'],
  },
  {
    key: 'radio',
    display_name: 'Radio Parts & Coconut Wire Co',
    category: 'hardware',
    criticality: 'critical',
    aliases: ['RADIO PARTS+COCONUT', 'Radio Parts & Coconut Wire'],
  },
  {
    key: 'lagoon',
    display_name: 'Lagoon Freight Lines',
    category: 'logistics',
    criticality: 'standard',
    aliases: ['LAGOON FRT LINES', 'Lagoon Freight'],
  },
  {
    key: 'weather',
    display_name: 'Island Weather Feed',
    category: 'data_feed',
    criticality: 'high',
    aliases: ['ISLAND WX FEED', 'Island Weather Svc'],
  },
  {
    key: 'professor',
    display_name: "Professor's Lab Supply",
    category: 'hardware',
    criticality: 'standard',
    aliases: ['PROF LAB SUPPLY', 'Professors Laboratory Supply'],
  },
];

// ── The 14-node confirmed scope tree ────────────────────────────────────
// 12 mandatory (3 named verbatim + 9 request-derived) + 2 library should_have. `quote` is the
// cited span the Scope Tree popover shows (spec 20.3 step 1 asserts at least one non-empty).
const NODES = [
  { title: 'On-island installation and commissioning', strength: 'mandatory', derived: 'request_document', quote: 'On-island installation and commissioning of the beacon, performed on site.' },
  { title: 'Crew training for six', strength: 'mandatory', derived: 'request_document', quote: 'Crew training for six (6) crew members on operation and emergency use.' },
  { title: '24-month parts warranty', strength: 'mandatory', derived: 'request_document', quote: 'A 24-month parts warranty covering all supplied hardware.' },
  { title: 'Weatherproof beacon enclosure', strength: 'mandatory', derived: 'request_document', quote: 'Weatherproof beacon enclosure rated for tropical marine exposure.' },
  { title: 'Solar charging array with 72-hour battery reserve', strength: 'mandatory', derived: 'request_document', quote: 'Solar charging array with a 72-hour battery reserve.' },
  { title: 'Dual-band distress transmitter (121.5 and 406 MHz)', strength: 'mandatory', derived: 'request_document', quote: 'Dual-band distress transmitter (121.5 and 406 MHz).' },
  { title: 'GPS position encoding in the distress signal', strength: 'mandatory', derived: 'request_document', quote: 'GPS position encoding in the distress signal.' },
  { title: 'Automatic activation on water immersion', strength: 'mandatory', derived: 'request_document', quote: 'Automatic activation on water immersion.' },
  { title: 'Manual activation switch accessible from the deck', strength: 'mandatory', derived: 'request_document', quote: 'Manual activation switch accessible from the deck.' },
  { title: 'Documented test and inspection procedure at handover', strength: 'mandatory', derived: 'request_document', quote: 'Documented test/inspection procedure at handover.' },
  { title: 'Spare-parts kit sufficient for one field repair', strength: 'mandatory', derived: 'request_document', quote: 'Spare-parts kit sufficient for one field repair.' },
  { title: 'Operating manual in printed and digital form', strength: 'mandatory', derived: 'request_document', quote: 'Operating manual in printed and digital form.' },
  { title: 'Data export on termination', strength: 'should_have', derived: 'library', quote: 'On termination, the vendor shall export all data in a portable format.' },
  { title: 'Price escalation cap', strength: 'should_have', derived: 'library', quote: 'Annual price escalation shall be capped at a stated percentage.' },
];

// ── The four offers (spec 19.1). `lines` are the parsed offer-line ledger; `stated` is the
//    sticker total (minor); `gapAdjusted` is the comparable total after valuing gaps (null when
//    withheld). Each offer's source_text produces the parsed lines and the source_doc_hash. ──
const OFFERS = [
  {
    key: 'howell', label: 'Howell Industries Salvage', vendor: 'howell', source_format: 'pdf',
    stated: 1_640_000, gapAdjusted: 2_195_000, blanket: false,
    source_text: 'HOWELL INDUSTRIES SALVAGE - Beacon Bid. Total price: USD 16,400. Installation by others.',
    lines: [
      { role: 'base', amount: 1_640_000, text: 'Total price: USD 16,400. Included: enclosure, solar array, dual-band transmitter, GPS, water activation, deck switch, handover test, spare-parts kit, operating manual, 24-month parts warranty.' },
      { role: 'exclusion', amount: null, exclusion: true, text: 'On-island installation and commissioning is NOT included; installation by others.' },
    ],
  },
  {
    key: 'radio', label: 'Radio Parts & Coconut Wire Co', vendor: 'radio', source_format: 'csv',
    stated: 1_910_000, gapAdjusted: 1_970_000, blanket: false,
    source_text: 'Radio Parts & Coconut Wire Co - exported bid spreadsheet. Base 19100; 24-month warranty upgrade 600.',
    lines: [
      { role: 'base', amount: 1_910_000, text: 'Rescue beacon system (base): USD 19,100. Installation, crew training, enclosure, solar array, transmitter, GPS, activation, deck switch, handover test, spare-parts kit, manual all included.' },
      { role: 'option', amount: 60_000, unit: 60_000, text: '24-month warranty upgrade: +USD 600 (upgrades the standard 12-month parts warranty to 24 months).' },
      { role: 'base', amount: null, text: '12-month parts warranty (standard): included.' },
    ],
  },
  {
    key: 'lagoon', label: 'Lagoon Freight Lines', vendor: 'lagoon', source_format: 'email',
    stated: 1_780_000, gapAdjusted: 1_900_000, blanket: false,
    source_text: 'Lagoon Freight Lines - all-in rescue beacon quote USD 17,800; delivery to the lagoon dock included.',
    lines: [
      { role: 'base', amount: 1_780_000, text: 'All-in price USD 17,800: on-island installation and commissioning, crew training for six, enclosure, solar array, transmitter, GPS, water activation, deck switch, handover test, spare-parts kit, and manual.' },
    ],
  },
  {
    key: 'professor', label: "Professor's Lab Supply", vendor: 'professor', source_format: 'pdf',
    stated: 1_590_000, gapAdjusted: null, blanket: true,
    source_text: "Professor's Lab Supply - Rescue Beacon Proposal. Total USD 15,900. Everything provided at no additional charge.",
    lines: [
      { role: 'base', blanket: true, amount: null, text: 'Installation, crew training and the 24-month warranty are provided at no additional charge.' },
      { role: 'base', blanket: true, amount: null, text: 'Data export, escalation cap and commissioning are provided at no additional charge.' },
      { role: 'base', blanket: true, amount: null, text: 'The enclosure, solar array and dual-band transmitter are provided at no additional charge.' },
      { role: 'base', blanket: true, amount: null, text: 'GPS encoding, water activation, the manual switch and the handover test are provided at no additional charge.' },
    ],
  },
];

// ── The coverage gaps per offer, keyed by node title. Everything not listed is `covered`
//    (published, high band). Professor is the split-blanket demo: EVERY node is capped to
//    needs_review with withheld_reason='blanket_cap' (0 auto-published covered). ──
const GAPS = {
  howell: {
    'Crew training for six': { verdict: 'absent', priced: 250_000, rejected: true },
    'On-island installation and commissioning': { verdict: 'excluded_explicit', priced: 305_000, line: 'exclusion' },
  },
  radio: {
    '24-month parts warranty': { verdict: 'partial', delta_kind: 'term', delta: 60_000, priced: 60_000, line: 'option' },
  },
  lagoon: {
    '24-month parts warranty': { verdict: 'absent', priced: 120_000, rejected: true },
    // should_have supplement, absent + unvalued: routes to review (non-mandatory absent), so it is
    // NOT in the exclusion diff (mandatory-only) and NOT a counted headline gap.
    'Price escalation cap': { verdict: 'absent', priced: null, rejected: true, review: 'needs_review', band: 'low', withheld: 'band' },
  },
  professor: '__blanket__',
};

// ── helpers ────────────────────────────────────────────────────────────
async function ensureVendors() {
  const existing = await api(OWNER, 'GET', '/vendors?limit=200');
  const byName = new Map(
    (Array.isArray(existing.data) ? existing.data : []).map((v) => [v.display_name, v]),
  );
  const ids = {};
  for (const v of VENDORS) {
    let row = byName.get(v.display_name);
    if (!row) {
      const c = await api(OWNER, 'POST', '/vendors', {
        display_name: v.display_name,
        category: v.category,
        criticality: v.criticality,
      });
      if (!c.ok) {
        console.error(`[bursar] vendor ${v.display_name} -> ${c.status}`);
        continue;
      }
      row = c.data;
      console.log(`[bursar] vendor ${v.display_name} (${row.id})`);
    }
    ids[v.key] = row.id;
    for (const raw of v.aliases) {
      await api(OWNER, 'POST', `/vendors/${row.id}/aliases`, { raw_payee: raw });
    }
  }
  return ids;
}

async function findRequest() {
  const r = await api(OWNER, 'GET', '/requests?limit=200');
  const list = Array.isArray(r.data) ? r.data : [];
  return list.find((x) => x.title === REQUEST_TITLE) ?? null;
}

function dedupKey(title) {
  return sha256(title).slice(0, 40);
}

// The canonical numbers, EXP-first with inline fallback so both run-all and standalone build
// the identical state (spec 19.3 - one source for the numbers).
function expOffer(key) {
  return (EXP.offers || []).find((o) => o.key === key) || {};
}
function statedOf(o) {
  return expOffer(o.key).statedMinor ?? o.stated;
}
function gapAdjustedOf(o) {
  const e = expOffer(o.key);
  return 'gapAdjustedMinor' in e ? e.gapAdjustedMinor : o.gapAdjusted;
}

/**
 * Materialize the whole settled end-state for the request directly in one transaction, then
 * (outside it) call the real award route. Idempotent: if an award already exists the build is
 * skipped; otherwise the request's prior offer/scope/coverage graph is cleaned and rebuilt.
 */
async function materialize(sql, req, vendorIds) {
  const org = req.organization_id;
  const rid = req.id;
  const skipper = req.created_by;

  // Skip a fully-built request (award present == everything downstream is frozen).
  const [{ n: awardCount }] = await sql`
    SELECT count(*)::int AS n FROM bursar_awards WHERE organization_id = ${org} AND request_id = ${rid}
  `;
  if (awardCount > 0) {
    console.log('[bursar] award already present; deterministic build is idempotent, skipping rebuild');
    return { built: false };
  }

  // ── Clean any prior (LLM-path or half-built) graph for this request. No award exists, so
  //    nothing is immutable. Deleting offers cascades their lines/coverage/window-results/totals;
  //    then the nodes have no referencing coverage and can be removed. ──
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${org}, true)`;
    await tx`DELETE FROM bursar_mismatches WHERE organization_id = ${org} AND request_id = ${rid}`;
    await tx`DELETE FROM bursar_offers WHERE organization_id = ${org} AND request_id = ${rid}`;
    await tx`DELETE FROM bursar_leveling_runs WHERE organization_id = ${org} AND request_id = ${rid}`;
    await tx`UPDATE bursar_scope_nodes SET parent_id = NULL WHERE organization_id = ${org} AND request_id = ${rid}`;
    await tx`DELETE FROM bursar_scope_nodes WHERE organization_id = ${org} AND request_id = ${rid}`;
  });

  // ── Build in one transaction ────────────────────────────────────────
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${org}, true)`;

    // 1. The 14-node confirmed scope tree.
    const nodeIdByTitle = new Map();
    let ordinal = 0;
    for (const n of NODES) {
      const id = duid(rid, 'node', n.title);
      nodeIdByTitle.set(n.title, id);
      await tx`
        INSERT INTO bursar_scope_nodes (
          id, organization_id, request_id, ordinal, title, node_kind, normative_strength,
          derived_from, cited_span, confidence, review_status, dedup_key
        ) VALUES (
          ${id}, ${org}, ${rid}, ${ordinal}, ${n.title}, 'requirement', ${n.strength},
          ${n.derived}, ${sql.json({ quote: n.quote })}, 96.00, 'confirmed', ${dedupKey(n.title)}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      ordinal += 1;
    }

    // 2. Freeze the ruler: the request is confirmed.
    await tx`
      UPDATE bursar_requests
         SET scope_status = 'confirmed', scope_confirmed_at = now(), scope_confirmed_by = ${skipper},
             updated_at = now()
       WHERE organization_id = ${org} AND id = ${rid}
    `;

    // 3-7. Per offer: the offer row, its parsed lines, a succeeded leveling run, the coverage
    //      matrix over all 14 nodes, and the comparable totals.
    for (const o of OFFERS) {
      const offerId = duid(rid, 'offer', o.key);
      const stated = statedOf(o);
      const gapAdjusted = gapAdjustedOf(o);

      await tx`
        INSERT INTO bursar_offers (
          id, organization_id, request_id, vendor_id, label, status, normalization_status,
          parse_quality, blanket_suspected, unsubpriced_mandatory_count, evidence_concentration,
          source_format, source_doc_hash, currency, created_by, parsed_at
        ) VALUES (
          ${offerId}, ${org}, ${rid}, ${vendorIds[o.vendor] ?? null}, ${o.label}, 'received', 'parsed',
          ${o.blanket ? 0.9 : 0.96}, ${o.blanket}, ${o.blanket ? 12 : 0}, ${o.blanket ? 0.2857 : null},
          ${o.source_format}, ${sha256(o.source_text)}, 'USD', ${skipper}, now()
        )
        ON CONFLICT (id) DO NOTHING
      `;

      // Parsed lines; remember one id per role so coverage can cite a real line.
      const lineIdByRole = {};
      let lord = 0;
      for (const ln of o.lines) {
        const lineId = duid(rid, 'line', o.key, String(lord));
        if (!(ln.role in lineIdByRole)) lineIdByRole[ln.role] = lineId;
        await tx`
          INSERT INTO bursar_offer_lines (
            id, organization_id, offer_id, ordinal, raw_text, unit_price_minor, extended_minor,
            currency, line_role, blanket_claim, exclusion_hit, parsed_by
          ) VALUES (
            ${lineId}, ${org}, ${offerId}, ${lord}, ${ln.text}, ${ln.unit ?? null}, ${ln.amount ?? null},
            'USD', ${ln.role}, ${!!ln.blanket}, ${!!ln.exclusion}, 'deterministic'
          )
          ON CONFLICT (id) DO NOTHING
        `;
        lord += 1;
      }
      const baseLine = lineIdByRole.base ?? Object.values(lineIdByRole)[0];

      // A succeeded leveling run per offer (4 runs total).
      const runId = duid(rid, 'run', o.key);
      await tx`
        INSERT INTO bursar_leveling_runs (
          id, organization_id, request_id, status, last_processed_offer_index,
          last_processed_node_index, last_processed_window_index, offer_count, node_count,
          coverage_written, claimed_by, heartbeat_at, started_at, finished_at
        ) VALUES (
          ${runId}, ${org}, ${rid}, 'succeeded', 0, ${NODES.length - 1}, 0, 1, ${NODES.length},
          ${NODES.length}, 'gilligan-seed', now(), now(), now()
        )
        ON CONFLICT (id) DO NOTHING
      `;

      // Coverage for every (offer, node).
      const gapSpec = GAPS[o.key];
      for (const n of NODES) {
        const nodeId = nodeIdByTitle.get(n.title);
        let verdict = 'covered';
        let review = 'published';
        let band = 'high';
        let withheld = null;
        let deltaKind = null;
        let delta = null;
        let priced = null;
        let matched = [baseLine];
        let rejected = [];
        let blanketSuspected = false;

        if (gapSpec === '__blanket__') {
          // Every node is a capped blanket claim: covered but withheld to review.
          verdict = 'covered';
          review = 'needs_review';
          band = 'low';
          withheld = 'blanket_cap';
          blanketSuspected = true;
          matched = [lineIdByRole.base ?? baseLine];
        } else if (gapSpec && gapSpec[n.title]) {
          const g = gapSpec[n.title];
          verdict = g.verdict;
          review = g.review ?? 'published';
          band = g.band ?? 'high';
          withheld = g.withheld ?? null;
          deltaKind = g.delta_kind ?? null;
          delta = g.delta ?? null;
          priced = g.priced ?? null;
          if (g.line && lineIdByRole[g.line]) matched = [lineIdByRole[g.line]];
          if (g.verdict === 'absent') {
            matched = [];
            rejected = [{ offer_line_id: baseLine, reason: `no line prices "${n.title}"` }];
          }
        }

        const covId = duid(rid, 'cov', o.key, n.title);
        await tx`
          INSERT INTO bursar_offer_coverage (
            id, organization_id, offer_id, scope_node_id, leveling_run_id, verdict, decided_by,
            matched_line_ids, rejected_candidates, composite_confidence, confidence_band,
            review_status, withheld_reason, blanket_suspected, delta_kind, delta_amount_minor,
            priced_amount_minor
          ) VALUES (
            ${covId}, ${org}, ${offerId}, ${nodeId}, ${runId}, ${verdict}, 'deterministic',
            ${matched}::uuid[], ${sql.json(rejected)}, ${band === 'high' ? 0.9 : 0.4}, ${band},
            ${review}, ${withheld}, ${blanketSuspected}, ${deltaKind}, ${delta}, ${priced}
          )
          ON CONFLICT (organization_id, offer_id, scope_node_id) DO NOTHING
        `;
      }

      // Comparable totals (spec 10). gap_adjusted is renderable for the three clean offers and
      // withheld (renderable=false) for the split-blanket Professor.
      const renderable = gapAdjusted != null;
      const unvaluedGaps = o.key === 'lagoon' ? 1 : o.key === 'professor' ? 12 : 0;
      const totals = [
        { kind: 'stated', amount: stated, renderable: true, unvalued: 0, estimated: false },
        { kind: 'base_only', amount: stated, renderable: true, unvalued: 0, estimated: false },
        { kind: 'gap_adjusted', amount: gapAdjusted, renderable, unvalued: unvaluedGaps, estimated: !renderable },
      ];
      if (o.key === 'lagoon') {
        totals.push({ kind: 'should_have_supplement', amount: null, renderable: false, unvalued: 1, estimated: true });
      }
      for (const t of totals) {
        await tx`
          INSERT INTO bursar_offer_totals (
            id, organization_id, offer_id, total_kind, currency, amount_minor, estimated,
            unvalued_gap_count, renderable
          ) VALUES (
            ${duid(rid, 'total', o.key, t.kind)}, ${org}, ${offerId}, ${t.kind}, 'USD', ${t.amount},
            ${t.estimated}, ${t.unvalued}, ${t.renderable}
          )
          ON CONFLICT (organization_id, offer_id, total_kind) DO NOTHING
        `;
      }

      // The split-blanket product finding (spec 5.3), mirroring parse.store.ts.
      if (o.blanket) {
        const details = {
          reasons: ['split_blanket'],
          cap_reasons: ['cumulative_cap', 'evidence_concentration'],
          unsubpriced_mandatory_count: 12,
          evidence_concentration: 0.2857,
          blanket_lines: o.lines.map((l) => l.text),
        };
        const dk = sha256(`offer_manipulation_suspected|${offerId}`);
        await tx`
          INSERT INTO bursar_mismatches (
            organization_id, detector, severity, status, dedup_key, evidence_hash, request_id,
            offer_id, cited_span, details
          ) VALUES (
            ${org}, 'offer_manipulation_suspected', 'high', 'open', ${dk}, ${sha256(JSON.stringify(details))},
            ${rid}, ${offerId}, ${sql.json({ spans: [] })}, ${sql.json(details)}
          )
          ON CONFLICT (organization_id, dedup_key) DO UPDATE SET
            status = CASE WHEN bursar_mismatches.status = 'dismissed' THEN bursar_mismatches.status ELSE 'open' END,
            evidence_hash = EXCLUDED.evidence_hash, details = EXCLUDED.details, cited_span = EXCLUDED.cited_span,
            last_seen_at = now(), updated_at = now()
        `;
      }
    }
  });

  return { built: true, offerId: duid(rid, 'offer', 'radio') };
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  if (!KEYS[OWNER]) {
    console.error('[bursar] no cast API keys in GKEYS; skipping');
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('[bursar] DATABASE_URL not set (run inside the api container); skipping');
    return;
  }
  if (!EXP.request) {
    console.log('[bursar] BURSAR_EXPECTATIONS not injected; using inline figures (standalone run)');
  }

  const vendorIds = await ensureVendors();

  // 1. Ensure the request exists (created via the real route so its org/owner are authentic).
  let request = await findRequest();
  if (!request) {
    const cr = await api(OWNER, 'POST', '/requests', {
      title: REQUEST_TITLE,
      description:
        'Marine rescue beacon for the lagoon. Budget ceiling USD 18,000. Category: hardware_purchase. Best overall value, not lowest price.',
      currency: 'USD',
    });
    if (!cr.ok) {
      console.error(`[bursar] request create -> ${cr.status} ${JSON.stringify(cr.raw).slice(0, 200)}`);
      return;
    }
    request = cr.data;
    console.log(`[bursar] request created (${request.id})`);
  }

  // The route response may not carry organization_id/created_by; resolve them from the row.
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const [row] = await sql`
      SELECT id, organization_id, created_by FROM bursar_requests WHERE id = ${request.id} LIMIT 1
    `;
    if (!row) {
      console.error('[bursar] request row not found after create; aborting');
      return;
    }

    // 2. Deterministically materialize the full settled state.
    const result = await materialize(sql, row, vendorIds);

    // 3. Award to Radio Parts via the REAL route (reads the coverage we inserted to build the
    //    immutable baseline: 14 included, warranty carrying a term delta). Guarded: skip if an
    //    award already exists.
    const [{ n: awards }] = await sql`
      SELECT count(*)::int AS n FROM bursar_awards WHERE organization_id = ${row.organization_id} AND request_id = ${row.id}
    `;
    if (awards === 0) {
      const today = new Date();
      const termStart = today.toISOString().slice(0, 10);
      const termEnd = new Date(today.getTime() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const aw = await api(OWNER, 'POST', '/awards', {
        request_id: row.id,
        offer_id: result.offerId ?? duid(row.id, 'offer', 'radio'),
        vendor_id: vendorIds.radio,
        currency: 'USD',
        term_start: termStart,
        term_end: termEnd,
        auto_renew: true,
        renewal_notice_days: 60,
        timezone: 'UTC',
      });
      if (aw.ok) {
        console.log(`[bursar] award -> Radio Parts (${aw.data?.id ?? 'ok'}); baseline_counts=${JSON.stringify(aw.raw?.baseline_counts ?? {})}`);
      } else {
        console.error(`[bursar] award -> ${aw.status} ${JSON.stringify(aw.raw).slice(0, 300)}`);
      }
    } else {
      console.log('[bursar] award already present; skipping award call');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  // 4. Post-award detector fuel: import observed spend (spec 19.3). The drift sweep turns these
  //    into price_drift / scope_divergence / unbaselined_vendor findings.
  await seedSpend();

  // 5. The Island Weather Feed data-feed award + its priced baseline, plus the payee back-link,
  //    so the post-award detectors light up EXACTLY as the header promises: a 40% price_drift on
  //    the drifted feed invoice, and a t_minus_60 renewal cliff (BURSAR_SEED_EXPECTATIONS.detectors).
  //    The imported 'ISLAND WX FEED' spend arrives with vendor_id NULL (import did not auto-link it
  //    to the vendor the confidence-1.0 alias already resolves), so nothing is award-scoped and the
  //    drift sweep raises no finding for it. This deterministic step back-links spend from the alias
  //    table and freezes a $1,000 feed baseline the $1,400 invoice drifts 40% above.
  await seedWeatherDetectors(vendorIds);

  console.log('[bursar] done: 14-node confirmed scope, 4 leveled offers, Radio award, detector spend');
}

// Island Weather Feed award + baseline + spend back-link (see caller). Self-contained: opens its own
// postgres connection because main() has already closed its `sql` handle by the time spend is imported.
// Idempotent via ON CONFLICT DO NOTHING and a null-guarded back-link, so re-runs are no-ops.
async function seedWeatherDetectors(vendorIds) {
  const weatherVendorId = vendorIds.weather;
  if (!weatherVendorId) {
    console.error('[bursar] weather vendor id missing; skipping detector award');
    return;
  }
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const [req] = await sql`
      SELECT id, organization_id, created_by FROM bursar_requests WHERE title = ${REQUEST_TITLE} LIMIT 1
    `;
    if (!req) {
      console.error('[bursar] request row not found; skipping detector award');
      return;
    }
    const org = req.organization_id;
    const dayISO = (deltaDays) =>
      new Date(Date.now() + deltaDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const awardId = duid(req.id, 'award', 'weather');
    const baselineId = duid(req.id, 'baseline', 'weather', '0');

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${org}, true)`;

      // Back-link any imported spend to the vendor its confidence-scored alias already resolves to.
      // Fixes the ISLAND WX FEED rows that landed with vendor_id NULL; general (alias-driven), so it
      // touches nothing that is already linked.
      await tx`
        UPDATE bursar_spend_events se
           SET vendor_id = a.vendor_id
          FROM bursar_payee_aliases a
         WHERE se.organization_id = ${org}
           AND a.organization_id = se.organization_id
           AND a.normalized_payee = se.normalized_payee
           AND a.vendor_id IS NOT NULL
           AND se.vendor_id IS NULL
      `;

      // A bounded, active data-feed award on the same request. term_end 80d out with a 30d notice
      // puts the notice deadline 50d out -> the t_minus_60 renewal band. chain_root_id self-roots.
      await tx`
        INSERT INTO bursar_awards (
          id, organization_id, request_id, offer_id, vendor_id, chain_root_id, currency,
          term_start, term_end, auto_renew, renewal_notice_days, timezone, status, awarded_by, awarded_at
        ) VALUES (
          ${awardId}, ${org}, ${req.id}, NULL, ${weatherVendorId}, ${awardId}, 'USD',
          ${dayISO(-210)}, ${dayISO(80)}, false, 30, 'UTC', 'active', ${req.created_by}, now()
        )
        ON CONFLICT (id) DO NOTHING
      `;

      // One priced INCLUDED baseline item. Its title normalizes to the same string as the
      // 'ISLAND WX FEED' payee, so the deterministic line matcher pairs the $1,400 invoice to this
      // $1,000 baseline and evaluatePriceDrift reads a 40% overage.
      await tx`
        INSERT INTO bursar_baseline_items (
          id, organization_id, award_id, ordinal, kind, title, description, currency,
          extended_minor, coverage_verdict_at_award, cited_span
        ) VALUES (
          ${baselineId}, ${org}, ${awardId}, 0, 'included', 'Island WX Feed',
          'Monthly island weather + sea-state data feed subscription.', 'USD',
          100000, 'covered', ${sql.json({})}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    });
    console.log('[bursar] weather award + $1,000 feed baseline + spend back-link ready (price_drift + renewal fuel)');
  } catch (err) {
    console.error('[bursar] weather detector seed failed:', err.message);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Import the observed spend statement the drift detectors key off. amount_minor is signed minor
// units. Idempotent: the same file_sha256 RESUMES the upsert, never doubles.
async function seedSpend() {
  const today = new Date();
  const d = (daysAgo) => new Date(today.getTime() - daysAgo * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = [
    { payee_raw: 'ISLAND WX FEED', occurred_on: d(20), amount_minor: 140_000, currency: 'USD', external_ref: 'IWF-DRIFT-1' },
    { payee_raw: 'ISLAND WX FEED', occurred_on: d(200), amount_minor: 100_000, currency: 'USD', external_ref: 'IWF-BASE-1' },
    { payee_raw: 'RADIO PARTS+COCONUT', occurred_on: d(10), amount_minor: 45_000, currency: 'USD', external_ref: 'EXPEDITED-LAGOON-DELIVERY' },
    { payee_raw: 'PROF LAB SUPPLY', occurred_on: d(90), amount_minor: 30_000, currency: 'USD', external_ref: 'PLS-REC-1' },
    { payee_raw: 'PROF LAB SUPPLY', occurred_on: d(60), amount_minor: 30_000, currency: 'USD', external_ref: 'PLS-REC-2' },
    { payee_raw: 'PROF LAB SUPPLY', occurred_on: d(30), amount_minor: 30_000, currency: 'USD', external_ref: 'PLS-REC-3' },
    { payee_raw: 'PROF LAB SUPPLY', occurred_on: d(1), amount_minor: 30_000, currency: 'USD', external_ref: 'PLS-REC-4' },
  ];
  const body = JSON.stringify(rows);
  const imp = await api(OWNER, 'POST', '/spend/import', {
    file_sha256: sha256(`gilligan-bursar-spend:${body}`),
    filename: 'lagoon-statement.csv',
    rows,
  });
  if (imp.ok) console.log(`[bursar] imported ${rows.length} spend rows for the detectors`);
  else console.error(`[bursar] spend import -> ${imp.status} ${JSON.stringify(imp.raw).slice(0, 200)}`);
}

main().catch((err) => {
  console.error('[bursar] failed:', err.message);
  process.exit(1);
});
