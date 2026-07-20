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
 * Depends on bond.mjs (companies) and bill.mjs (expenses) having run first - it is
 * registered in run-all.mjs's Billing phase. Idempotent: skips the request (and its
 * whole offer/award chain) if the "Lagoon Rescue Beacon Procurement" request already
 * exists, and skips vendors already present by name.
 *
 * Run via run-all.mjs, which injects BURSAR_EXPECTATIONS (the canonical number set
 * from bursar.expectations.mjs) so this seeder and the Playwright suite agree on one
 * source (spec 19.3). Standalone:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bursar.mjs
 *
 * Bursar internal host is http://bursar-api:4023 and ALL routes register under /v1
 * (apps/bursar-api/src/server.ts), so the base is /v1. Cast API keys authenticate via
 * Bearer, which scopes to the gilligan org. Money is in MINOR units (cents).
 *
 * NOTE: derivation and leveling run asynchronously through the worker engines, so the
 * coverage matrix / totals materialize a few seconds after this seeder returns. This
 * script drives the sequence and is best-effort per step (like the other per-app
 * seeders); the Playwright suite asserts the settled state against a fully-seeded
 * stack. NEVER seed the generic e2e org - gilligan only.
 */

const BASE = 'http://bursar-api:4023/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Canonical numbers, injected by run-all.mjs from bursar.expectations.mjs. Absent on a
// standalone run; the seeder still builds the same data from its inline definitions
// below (the offer documents live here because only prose produces parsed totals).
const EXP = (() => {
  try {
    return JSON.parse(process.env.BURSAR_EXPECTATIONS || '{}');
  } catch {
    return {};
  }
})();

// Cast owner (Skipper) - the request owner and the identity the Playwright suite runs as.
const OWNER = 'skipper';

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

// A tiny sha256 helper for the spend-import resumability key (node crypto is available
// in the api container runtime).
import { createHash } from 'node:crypto';
function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
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
    aliases: ["PROF LAB SUPPLY", "Professors Laboratory Supply"],
  },
];

// The RFP text the scope tree is derived from. Written so a deterministic pre-pass +
// classifier yields the three named mandatory nodes plus the request-level nodes; the
// two should_have nodes come from the library apply-step.
const RFP_TEXT = `LAGOON RESCUE BEACON PROCUREMENT - Statement of Requirements
Budget ceiling: USD 18,000. Category: hardware_purchase. Owner: The Skipper.

The vendor SHALL supply one (1) marine rescue beacon system for the lagoon, meeting
all of the following MANDATORY requirements:
1. On-island installation and commissioning of the beacon, performed on site.
2. Crew training for six (6) crew members on operation and emergency use.
3. A 24-month parts warranty covering all supplied hardware.
4. Weatherproof beacon enclosure rated for tropical marine exposure.
5. Solar charging array with a 72-hour battery reserve.
6. Dual-band distress transmitter (121.5 and 406 MHz).
7. GPS position encoding in the distress signal.
8. Automatic activation on water immersion.
9. Manual activation switch accessible from the deck.
10. Documented test/inspection procedure at handover.
11. Spare-parts kit sufficient for one field repair.
12. Operating manual in printed and digital form.

Delivery to the lagoon dock. Award will be made on best overall value, not lowest price.`;

// Human scope nodes we add after derivation to GUARANTEE the three named mandatory
// nodes exist verbatim (spec 19), independent of derivation nondeterminism.
const MANDATORY_ADDS = [
  'On-island installation and commissioning',
  'Crew training for six',
  '24-month parts warranty',
];

// The four offers. `source_format` matches the declared provenance (spec 19.1). Each
// body is written so the deterministic parse + absence engine reproduce the documented
// gaps and gap_adjusted totals.
const OFFERS = [
  {
    key: 'howell',
    label: 'Howell Industries Salvage',
    vendor: 'howell',
    source_format: 'pdf',
    // stated $16,400. Crew training ABSENT (not mentioned). Installation EXCLUDED_EXPLICIT.
    source_text: `HOWELL INDUSTRIES SALVAGE - Beacon Bid
Total price: USD 16,400.
Included: weatherproof beacon enclosure; solar charging array with 72-hour reserve;
dual-band 121.5/406 MHz distress transmitter; GPS position encoding; automatic water
activation; manual deck switch; documented handover test; spare-parts kit; printed and
digital operating manual; 24-month parts warranty.
Exclusions: On-island installation and commissioning is NOT included; installation by
others. Delivery to lagoon dock only.`,
  },
  {
    key: 'radio',
    label: 'Radio Parts & Coconut Wire Co',
    vendor: 'radio',
    source_format: 'csv',
    // stated $19,100. Warranty PARTIAL (12 vs 24 mo, delta_kind=term). Own optional line
    // "24-month warranty upgrade +600" makes the term-delta rung 1 (one observation).
    source_text: `line_item,role,amount_usd
Rescue beacon system (base),base,19100
On-island installation and commissioning,base,included
Crew training for six,base,included
12-month parts warranty (standard),base,included
24-month warranty upgrade,option,600
Weatherproof enclosure,base,included
Solar array 72h reserve,base,included
Dual-band 121.5/406 transmitter,base,included
GPS position encoding,base,included
Automatic water activation,base,included
Manual deck switch,base,included
Handover test procedure,base,included
Spare-parts kit,base,included
Operating manual (print+digital),base,included`,
  },
  {
    key: 'lagoon',
    label: 'Lagoon Freight Lines',
    vendor: 'lagoon',
    source_format: 'email',
    // stated $17,800. Warranty ABSENT (mandatory). Escalation cap ABSENT (should_have, unvalued).
    source_text: `From: sales@lagoonfreight.example
Subject: Rescue Beacon Quote

Hi Skipper,

Our all-in price for the lagoon rescue beacon is USD 17,800. That covers on-island
installation and commissioning, crew training for six, the weatherproof enclosure, the
solar array with 72-hour reserve, the dual-band 121.5/406 MHz transmitter, GPS encoding,
automatic water activation, the manual deck switch, the handover test, a spare-parts kit,
and the printed and digital manual.

Delivery to the lagoon dock is included.

- Lagoon Freight Lines`,
  },
  {
    key: 'professor',
    label: "Professor's Lab Supply",
    vendor: 'professor',
    source_format: 'pdf',
    // stated $15,900. The SPLIT-BLANKET demo: four coordinated lines, 3-4 nodes each, NO
    // lexicon token. Trips the cumulative fan-out + evidence-concentration caps -> zero
    // auto-published covered, offer_manipulation_suspected, all mandatory nodes withheld.
    source_text: `PROFESSOR'S LAB SUPPLY - Rescue Beacon Proposal
Total: USD 15,900.
Installation, crew training and the 24-month warranty are provided at no additional charge.
Data export, escalation cap and commissioning are provided at no additional charge.
The enclosure, solar array and dual-band transmitter are provided at no additional charge.
GPS encoding, water activation, the manual switch and the handover test are provided at no additional charge.`,
  },
];

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
    // Aliases (idempotent server-side by normalized payee).
    for (const raw of v.aliases) {
      await api(OWNER, 'POST', `/vendors/${row.id}/aliases`, { raw_payee: raw });
    }
  }
  return ids;
}

async function findRequest() {
  const r = await api(OWNER, 'GET', '/requests?limit=200');
  const list = Array.isArray(r.data) ? r.data : [];
  return list.find((x) => x.title === 'Lagoon Rescue Beacon Procurement') ?? null;
}

async function poll(fn, pred, tries = 15, delayMs = 1200) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (pred(v)) return v;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  if (!KEYS[OWNER]) {
    console.error('[bursar] no cast API keys in GKEYS; skipping');
    return;
  }
  if (!EXP.request) {
    console.log('[bursar] BURSAR_EXPECTATIONS not injected; using inline definitions (standalone run)');
  }

  const vendorIds = await ensureVendors();

  let request = await findRequest();
  if (request) {
    console.log(`[bursar] request already exists (${request.id}); seed is idempotent, skipping build`);
    return;
  }

  // 1. Create the request.
  const cr = await api(OWNER, 'POST', '/requests', {
    title: 'Lagoon Rescue Beacon Procurement',
    description:
      'Marine rescue beacon for the lagoon. Budget ceiling USD 18,000. Category: hardware_purchase. Best overall value, not lowest price.',
    currency: 'USD',
  });
  if (!cr.ok) {
    console.error(`[bursar] request create -> ${cr.status} ${JSON.stringify(cr.raw).slice(0, 200)}`);
    return;
  }
  request = cr.data;
  const rid = request.id;
  console.log(`[bursar] request created (${rid})`);

  // 2. Derive scope from the RFP text (async-start; poll to `derived`).
  await api(OWNER, 'POST', `/requests/${rid}/derive-scope`, { source_text: RFP_TEXT });
  await poll(
    () => api(OWNER, 'GET', `/requests/${rid}/scope`),
    (r) => r.ok && ['derived', 'confirmed'].includes(r.data?.request?.scope_status),
  );

  // 3. Guarantee the three named mandatory nodes verbatim (idempotent by title).
  const scope = await api(OWNER, 'GET', `/requests/${rid}/scope`);
  const haveTitles = new Set((scope.data?.nodes ?? []).map((n) => n.title));
  for (const title of MANDATORY_ADDS) {
    if (!haveTitles.has(title)) {
      await api(OWNER, 'POST', `/requests/${rid}/scope/nodes`, {
        title,
        normative_strength: 'mandatory',
        node_kind: 'requirement',
      });
    }
  }

  // 4. Apply the two library should_have nodes ("Data export on termination", "Price
  //    escalation cap"). Resolve library ids by title; skip gracefully if the library is
  //    not seeded (the request-level nodes still carry the tree).
  const lib = await api(OWNER, 'GET', '/library?limit=200');
  const wantLib = ['Data export on termination', 'Price escalation cap'];
  const libIds = (Array.isArray(lib.data) ? lib.data : [])
    .filter((e) => wantLib.includes(e.title))
    .map((e) => e.id);
  if (libIds.length) {
    await api(OWNER, 'POST', `/requests/${rid}/scope/apply-library`, { library_ids: libIds });
  } else {
    // Fall back to adding them as should_have human nodes so the 14-node tree is complete.
    for (const title of wantLib) {
      if (!haveTitles.has(title)) {
        await api(OWNER, 'POST', `/requests/${rid}/scope/nodes`, {
          title,
          normative_strength: 'should_have',
          node_kind: 'requirement',
        });
      }
    }
  }

  // 5. Confirm the scope (freeze the ruler).
  await api(OWNER, 'POST', `/requests/${rid}/scope/confirm`, {});

  // 6. Create the four offers (inline source_text + declared format).
  const offerIds = {};
  for (const o of OFFERS) {
    const c = await api(OWNER, 'POST', `/requests/${rid}/offers`, {
      vendor_id: vendorIds[o.vendor] ?? null,
      label: o.label,
      currency: 'USD',
      source_text: o.source_text,
      source_format: o.source_format,
    });
    if (!c.ok) {
      console.error(`[bursar] offer ${o.label} -> ${c.status}`);
      continue;
    }
    offerIds[o.key] = c.data.id;
    console.log(`[bursar] offer ${o.label} (${c.data.id})`);
  }

  // 7. Level the offers (async-start; the matrix materializes a few seconds later).
  await api(OWNER, 'POST', `/requests/${rid}/level`, {});
  await poll(
    () => api(OWNER, 'GET', `/requests/${rid}/leveling-runs`),
    (r) => r.ok && (r.data ?? []).some((run) => ['done', 'partial'].includes(run.status)),
    20,
    1500,
  );

  // 8. Award to Radio Parts (NOT the lowest gap_adjusted - spec 19.1). Freezes the baseline.
  if (offerIds.radio) {
    const today = new Date();
    const termStart = today.toISOString().slice(0, 10);
    const termEnd = new Date(today.getTime() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const aw = await api(OWNER, 'POST', '/awards', {
      request_id: rid,
      offer_id: offerIds.radio,
      vendor_id: vendorIds.radio,
      currency: 'USD',
      term_start: termStart,
      term_end: termEnd,
      auto_renew: true,
      renewal_notice_days: 60,
      timezone: 'UTC',
    });
    if (aw.ok) console.log(`[bursar] award -> Radio Parts (${aw.data?.id ?? 'ok'})`);
    else console.error(`[bursar] award -> ${aw.status} ${JSON.stringify(aw.raw).slice(0, 200)}`);
  }

  // 9. Post-award detector fuel: import observed spend rows (spec 19.3). The drift sweep
  //    turns these into price_drift / scope_divergence / unbaselined_vendor findings, and
  //    the Island Weather award below produces a renewal_cliff at t_minus_60.
  await seedSpend();

  console.log('[bursar] done: request, scope, 4 offers, Radio award, and detector spend seeded');
}

// Import the observed spend statement that the drift detectors key off. amount_minor is
// signed minor units. Idempotent: the same file_sha256 RESUMES the upsert, never doubles.
async function seedSpend() {
  const today = new Date();
  const d = (daysAgo) => new Date(today.getTime() - daysAgo * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = [
    // price_drift: Island Weather Feed billed ~40% above its baseline unit.
    { payee_raw: 'ISLAND WX FEED', occurred_on: d(20), amount_minor: 140_000, currency: 'USD', external_ref: 'IWF-DRIFT-1' },
    { payee_raw: 'ISLAND WX FEED', occurred_on: d(200), amount_minor: 100_000, currency: 'USD', external_ref: 'IWF-BASE-1' },
    // scope_divergence: an "expedited lagoon delivery" charge with no baseline line.
    { payee_raw: 'RADIO PARTS+COCONUT', occurred_on: d(10), amount_minor: 45_000, currency: 'USD', external_ref: 'EXPEDITED-LAGOON-DELIVERY' },
    // unbaselined_vendor: Professor's Lab Supply, four recurring charges, no award on file.
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
