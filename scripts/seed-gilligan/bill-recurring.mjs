/**
 * Gilligan's Island themed Bill RECURRING / SUBSCRIPTION billing seed.
 *
 * The companion seeders populated clients, one-off invoices, expenses, rates,
 * and settings, but left the Recurring page (/bill/recurring) empty. Recurring
 * schedules are the island's standing-order revenue: a fee that bills itself on
 * a cadence without Mr. Howell re-drafting the paperwork each cycle.
 *
 * This script creates a small set of in-character subscription schedules
 * against the clients seeded by scripts/seed-gilligan/bill.mjs:
 *   - "Monthly Howell Estate retainer"  (monthly)    → Howell Family Office
 *   - "Quarterly coconut-export invoice" (quarterly)  → Kona Coconut Exporters
 *
 * Idempotent: find-or-create by schedule name. A re-run lists the org's
 * existing schedules first and skips any whose name already exists.
 *
 * Permissions: bill.recurring_invoice.create mirrors bill.invoice.create
 * (migration 0198), which the org Member group holds — so Mr. Howell (CREATOR,
 * the day-to-day bookkeeper) can stand these up himself, the same identity that
 * drafts ordinary invoices in bill.mjs. No owner sign-off is needed to *create*
 * a schedule (cancel is owner-only, but we don't cancel here).
 *
 * Amounts are in CENTS (integers), matching the rest of Bill.
 *
 * Run from the repo host (the api container can reach the internal bill host,
 * and the cast Bearer keys bypass CSRF + scope to the Gilligan org):
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bill-recurring.mjs
 *
 * Bill internal host is http://bill-api:4014 with all routes under /v1
 * (apps/bill-api/src/server.ts), so the base is /v1.
 *
 * Recurring mechanics (apps/bill-api/src/routes/recurring-invoices.routes.ts,
 * apps/bill-api/src/services/recurring-invoice.service.ts):
 *   - GET  /recurring-invoices            -> array of schedules (NOT {data}-wrapped)
 *   - POST /recurring-invoices            -> { data: schedule } ; status 'active',
 *                                            next_run_at defaults to start_date 00:00 UTC.
 *   line_items: [{ description, quantity?, unit?, unit_price (cents int) }]
 */

const BASE = 'http://bill-api:4014/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Mr. Howell runs the day-to-day books and holds bill.invoice.create →
// bill.recurring_invoice.create. Same identity bill.mjs uses to draft invoices.
const CREATOR = 'howell';

async function bill(who, method, path, body) {
  if (!KEYS[who]) throw new Error(`No API key for "${who}" in GKEYS`);
  const headers = { Authorization: `Bearer ${KEYS[who]}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, init);
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
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data?.data ?? data;
}

// Date helpers (YYYY-MM-DD).
const ymd = (d) => d.toISOString().split('T')[0];
const today = new Date();
// Start a few weeks back so "Generated" reads as a live, running subscription
// and the next run lands in the near future (these are seed-data dates only;
// the worker's daily tick is what would actually materialise invoices).
const daysFromNow = (n) => ymd(new Date(today.getTime() + n * 86400000));

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const sumItems = (items) => items.reduce((s, li) => s + (li.quantity ?? 1) * li.unit_price, 0);

// ---------------------------------------------------------------------------
// Content — standing-order schedules against existing seeded clients.
// ---------------------------------------------------------------------------

const SCHEDULES = [
  {
    name: 'Monthly Howell Estate retainer',
    client: 'Howell Family Office',
    cadence: 'monthly',
    auto_finalize: true, // the Howells pay on a standing order; auto-bill it
    tax_rate: 8.25,
    start_date: daysFromNow(-20),
    notes:
      'Standing monthly retainer for the Howell estate: cabana upkeep, valet ' +
      'service, and Lovey’s daily fresh-flower delivery. Spare no expense.',
    items: [
      { description: 'Estate management retainer (cabana, valet, grounds)', quantity: 1, unit: 'fixed', unit_price: 450000 },
      { description: 'Daily fresh-flower & lei service for Mrs. Howell', quantity: 30, unit: 'days', unit_price: 3500 },
      { description: 'Private chef & provisioning surcharge', quantity: 1, unit: 'fixed', unit_price: 120000 },
    ],
  },
  {
    name: 'Quarterly coconut-export invoice',
    client: 'Kona Coconut Exporters',
    cadence: 'quarterly',
    auto_finalize: false, // harvest volume varies; review the draft each quarter
    tax_rate: 0,
    start_date: daysFromNow(-10),
    notes:
      'Quarterly standing order for the island coconut surplus. Quantities are ' +
      'an estimate per quarter; review the draft before sending once the harvest ' +
      'is counted.',
    items: [
      { description: 'Coconut export — quarterly base lot (Grade A)', quantity: 1200, unit: 'units', unit_price: 320 },
      { description: 'Crating, husking & dock handling', quantity: 1, unit: 'fixed', unit_price: 42000 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

(async () => {
  if (!KEYS[CREATOR]) {
    throw new Error(`No API key for "${CREATOR}" in GKEYS — check scripts/.gilligan-keys.env`);
  }

  // Resolve clients by name (seeded by bill.mjs).
  const clients = (await bill(CREATOR, 'GET', '/clients')) ?? [];
  const clientsArr = Array.isArray(clients) ? clients : (clients.data ?? []);
  const clientByName = new Map(clientsArr.map((c) => [c.name, c]));

  // Existing schedules → find-or-create by name (idempotency gate).
  const existing = (await bill(CREATOR, 'GET', '/recurring-invoices')) ?? [];
  const existingArr = Array.isArray(existing) ? existing : (existing.data ?? []);
  const existingNames = new Set(existingArr.map((s) => s.name));

  let made = 0;
  for (const sch of SCHEDULES) {
    if (existingNames.has(sch.name)) {
      console.log(`schedule exists: ${sch.name}`);
      continue;
    }
    const client = clientByName.get(sch.client);
    if (!client) {
      console.log(`  schedule skipped (client missing): ${sch.name} — needs "${sch.client}" (run bill.mjs first)`);
      continue;
    }
    try {
      const created = await bill(CREATOR, 'POST', '/recurring-invoices', {
        client_id: client.id,
        name: sch.name,
        cadence: sch.cadence,
        auto_finalize: sch.auto_finalize,
        tax_rate: sch.tax_rate,
        start_date: sch.start_date,
        notes: sch.notes,
        line_items: sch.items.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unit: li.unit,
          unit_price: li.unit_price,
        })),
      });
      made++;
      const total = sumItems(sch.items);
      console.log(
        `schedule [${sch.cadence}${sch.auto_finalize ? ', auto-finalize' : ', draft'}]: ` +
          `${sch.name} — ${sch.client} — ${dollars(total)}/cycle ` +
          `(${sch.items.length} items) (${created.id})`,
      );
    } catch (e) {
      console.log(`  schedule FAILED: ${sch.name} — ${e.message}`);
    }
  }

  console.log(`\nBill recurring seed done: ${made} new schedule(s).`);
})().catch((e) => {
  console.error('recurring seed failed:', e.message);
  process.exit(1);
});
