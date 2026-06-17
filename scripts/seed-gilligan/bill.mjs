/**
 * Gilligan's Island themed Bill (invoicing / expenses) seed.
 *
 * Mr. Howell runs the island's finances through BigBlueBam Bill: he invoices
 * passing yachts for charters & salvage, bills the export of the island's
 * (ahem) coconut surplus, and tallies the Howell Family Office's lavish Luau.
 * The rest of the castaways economize; Howell spares no expense.
 *
 * Idempotent: skips clients that already exist by name, and skips invoice +
 * expense creation entirely if the org already has any invoices (so re-running
 * doesn't pile up duplicate paperwork). Amounts are in CENTS (integers).
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bill.mjs
 * (api container can reach the internal app hosts; cast API keys authenticate
 *  via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 *
 * Bill internal host is http://bill-api:4014 and ALL routes are registered
 * under the /v1 prefix (apps/bill-api/src/server.ts), so the base is /v1.
 *
 * Bill mechanics (apps/bill-api/src/services/invoice.service.ts):
 *   - create  -> draft invoice (invoice_number 'DRAFT')
 *   - add line items (unit_price in cents) -> totals recalculated
 *   - finalize -> reserves a number AND moves status to 'sent', sets sent_at
 *   - record payment -> when amount_paid >= total the invoice reads as paid
 *   - "overdue" is computed from a past due_date on an unpaid finalized invoice
 *     (the /reports/overdue endpoint keys off due_date), so we finalize one with
 *     a due_date already in the past and leave it unpaid.
 */

const BASE = 'http://bill-api:4014/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Two identities, because Bill enforces per-action permissions:
//  - CREATOR (Howell, org Member) can create clients, draft invoices, add line
//    items, log expenses — the day-to-day bookkeeping.
//  - APPROVER (Skipper, org Owner) holds bill.invoice.finalize / .send /
//    payment.create, which the Member group explicitly denies. In-character:
//    the financier drafts the paperwork, the captain signs off and dispatches
//    the bill. (See permission_group_defaults — Member.finalize = false.)
const CREATOR = 'howell';
const APPROVER = 'skipper';

async function bill(who, method, path, body) {
  if (!KEYS[who]) throw new Error(`No API key for "${who}" in GKEYS`);
  // Only set Content-Type when there's actually a body — bodyless POSTs
  // (finalize / send / payment-with-no-extra-fields) trip Fastify's
  // FST_ERR_CTP_EMPTY_JSON_BODY if the json content-type is present with no body.
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
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data?.data ?? data;
}

// Date helpers (YYYY-MM-DD).
const today = new Date();
const ymd = (d) => d.toISOString().split('T')[0];
const daysFromNow = (n) => ymd(new Date(today.getTime() + n * 86400000));

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const CLIENTS = [
  {
    name: 'S.S. Wanderer Charters',
    email: 'bookings@sswanderer.example',
    phone: '+1-808-555-0142',
    city: 'Honolulu',
    state_region: 'HI',
    country: 'US',
    notes: 'Charter & rescue voyages. Pays late, tips never.',
    default_payment_terms_days: 14,
  },
  {
    name: 'Kona Coconut Exporters',
    email: 'orders@konacoconut.example',
    phone: '+1-808-555-0177',
    city: 'Kailua-Kona',
    state_region: 'HI',
    country: 'US',
    notes: 'Buys the island coconut surplus by the gross.',
    default_payment_terms_days: 30,
  },
  {
    name: 'Howell Family Office',
    email: 'accounts@howellfamilyoffice.example',
    phone: '+1-212-555-0100',
    city: 'New York',
    state_region: 'NY',
    country: 'US',
    notes: 'Internal billing for Mr. & Mrs. Howell. Spare no expense.',
    default_payment_terms_days: 60,
  },
  {
    name: 'Lagoon Salvage & Reef Co.',
    email: 'claims@lagoonsalvage.example',
    phone: '+1-808-555-0199',
    city: 'Hilo',
    state_region: 'HI',
    country: 'US',
    notes: 'Recovers cargo from the reef. Settles slowly.',
    default_payment_terms_days: 21,
  },
];

// Each invoice: client name, terminal state, optional explicit due_date, notes,
// and line items (description + qty + unit_price in CENTS + unit).
//   state: 'draft'   -> created, left as draft
//   state: 'sent'    -> created + finalized (status 'sent')
//   state: 'paid'    -> created + finalized + full payment recorded
//   state: 'overdue' -> created with a past due_date + finalized, left unpaid
const INVOICES = [
  {
    client: 'S.S. Wanderer Charters',
    state: 'paid',
    notes: 'Deposit for the charter rescue voyage. Half now, half on the dock.',
    payment_method: 'bank_transfer',
    items: [
      { description: 'Charter rescue voyage — deposit (50%)', quantity: 1, unit: 'fixed', unit_price: 450000 },
      { description: 'Fuel surcharge (the Minnow drank a LOT)', quantity: 1, unit: 'fixed', unit_price: 38500 },
      { description: 'Hazard pay — uncharted lagoon entry', quantity: 1, unit: 'fixed', unit_price: 25000 },
    ],
  },
  {
    client: 'Kona Coconut Exporters',
    state: 'sent',
    notes: 'Q3 coconut export. Grade-A, hand-husked by Gilligan (mostly).',
    items: [
      { description: 'Coconut export — Q3 (Grade A)', quantity: 1200, unit: 'units', unit_price: 320 },
      { description: 'Coconut export — Q3 (Grade B, slightly cracked)', quantity: 300, unit: 'units', unit_price: 150 },
      { description: 'Crating & dock handling', quantity: 1, unit: 'fixed', unit_price: 42000 },
    ],
  },
  {
    client: 'Howell Family Office',
    state: 'paid',
    notes: 'The Howell Luau — Lovey approved every line. Twice.',
    payment_method: 'check',
    items: [
      { description: 'Luau catering & entertainment (whole-pig roast)', quantity: 1, unit: 'fixed', unit_price: 880000 },
      { description: 'Hula floor show — Ginger Grant, one night only', quantity: 1, unit: 'fixed', unit_price: 350000 },
      { description: 'Tiki torches, flower leis & bamboo place cards', quantity: 1, unit: 'fixed', unit_price: 64000 },
      { description: 'Imported caviar (do NOT tell the Skipper the price)', quantity: 6, unit: 'units', unit_price: 95000 },
    ],
  },
  {
    client: 'Lagoon Salvage & Reef Co.',
    state: 'overdue',
    notes: 'Salvage recovery off the north reef. Payment is, regrettably, overdue.',
    dueDate: daysFromNow(-23),
    invoiceDate: daysFromNow(-44),
    items: [
      { description: 'Reef salvage operation — dive & recovery', quantity: 18, unit: 'hours', unit_price: 12000 },
      { description: 'Recovered cargo handling fee', quantity: 1, unit: 'fixed', unit_price: 55000 },
    ],
  },
  {
    client: 'S.S. Wanderer Charters',
    state: 'overdue',
    notes: 'Second rescue attempt (the first one drifted home). Now overdue.',
    dueDate: daysFromNow(-9),
    invoiceDate: daysFromNow(-23),
    items: [
      { description: 'Charter rescue voyage — second attempt', quantity: 1, unit: 'fixed', unit_price: 525000 },
      { description: 'Signal-fire wood & coconut-mirror polishing', quantity: 1, unit: 'fixed', unit_price: 18000 },
    ],
  },
  {
    client: 'Howell Family Office',
    state: 'draft',
    notes: 'DRAFT — proposed bamboo cabana renovation. Lovey is still deciding on the drapery.',
    items: [
      { description: 'Bamboo cabana — structural re-thatch', quantity: 1, unit: 'fixed', unit_price: 240000 },
      { description: 'Imported silk drapery (3 options for Mrs. Howell)', quantity: 3, unit: 'units', unit_price: 78000 },
      { description: 'Hand-carved coconut chandelier', quantity: 1, unit: 'fixed', unit_price: 132000 },
    ],
  },
  {
    client: 'Kona Coconut Exporters',
    state: 'draft',
    notes: 'DRAFT — Q4 forward order, pending the next harvest.',
    items: [
      { description: 'Coconut export — Q4 forward order (estimate)', quantity: 1500, unit: 'units', unit_price: 330 },
    ],
  },
];

const EXPENSES = [
  {
    description: 'Replacement radio parts (salvaged + smuggled)',
    amount: 47500,
    category: 'hardware',
    vendor: 'Lagoon Salvage & Reef Co.',
    expense_date: daysFromNow(-30),
    billable: true,
  },
  {
    description: 'Hammock repairs (the Professor over-engineered them)',
    amount: 8200,
    category: 'supplies',
    vendor: 'Island Bamboo Supply',
    expense_date: daysFromNow(-25),
    billable: false,
  },
  {
    description: "Ginger's stage costumes for the Luau floor show",
    amount: 164000,
    category: 'wardrobe',
    vendor: 'Howell Family Office — Wardrobe Dept.',
    expense_date: daysFromNow(-12),
    billable: true,
  },
  {
    description: 'Raft materials (bamboo, vine, tar)',
    amount: 36000,
    category: 'supplies',
    vendor: 'Island Bamboo Supply',
    expense_date: daysFromNow(-18),
    billable: false,
  },
  {
    description: "Mr. Howell's monogrammed deck chairs (set of 4)",
    amount: 220000,
    category: 'furniture',
    vendor: 'Howell Family Office — Procurement',
    expense_date: daysFromNow(-8),
    billable: false,
  },
  {
    description: 'Fresh-water still maintenance + charcoal filters',
    amount: 14500,
    category: 'maintenance',
    vendor: 'Island Bamboo Supply',
    expense_date: daysFromNow(-5),
    billable: false,
  },
  {
    description: 'Caviar & imported delicacies (Luau, do not itemize to guests)',
    amount: 312000,
    category: 'catering',
    vendor: 'Kona Coconut Exporters',
    expense_date: daysFromNow(-11),
    billable: true,
  },
];

const sumItems = (items) => items.reduce((s, li) => s + li.quantity * li.unit_price, 0);

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

(async () => {
  if (!KEYS[CREATOR]) {
    throw new Error(`No API key for "${CREATOR}" in GKEYS — check scripts/.gilligan-keys.env`);
  }
  if (!KEYS[APPROVER]) {
    throw new Error(`No API key for "${APPROVER}" in GKEYS — check scripts/.gilligan-keys.env`);
  }

  // ----- Clients (find-or-create by name) -----
  const existingClients = (await bill(CREATOR, 'GET', '/clients')) ?? [];
  const byName = new Map(existingClients.map((c) => [c.name, c]));
  let clientsCreated = 0;
  for (const c of CLIENTS) {
    if (byName.has(c.name)) {
      console.log(`client exists: ${c.name}`);
      continue;
    }
    const created = await bill(CREATOR, 'POST', '/clients', c);
    byName.set(c.name, created);
    clientsCreated++;
    console.log(`client: ${c.name} (${created.id})`);
  }

  // ----- Idempotency gate: skip paperwork if invoices already exist -----
  const existingInvoices = (await bill(CREATOR, 'GET', '/invoices')) ?? [];
  if (existingInvoices.length > 0) {
    console.log(
      `\ninvoices already present (${existingInvoices.length}); skipping invoice + expense seeding.`,
    );
    console.log(`Bill seed done: ${clientsCreated} new clients, 0 new invoices, 0 new expenses.`);
    return;
  }

  // ----- Invoices -----
  const tally = { draft: 0, sent: 0, paid: 0, overdue: 0 };
  let invoicesMade = 0;
  for (const inv of INVOICES) {
    const client = byName.get(inv.client);
    if (!client) {
      console.log(`  invoice skipped (client missing): ${inv.client}`);
      continue;
    }
    try {
      // Howell (Member) drafts the paperwork…
      const createBody = { client_id: client.id };
      if (inv.notes) createBody.notes = inv.notes;
      if (inv.invoiceDate) createBody.invoice_date = inv.invoiceDate;
      if (inv.dueDate) createBody.due_date = inv.dueDate;
      const draft = await bill(CREATOR, 'POST', '/invoices', createBody);

      for (const li of inv.items) {
        await bill(CREATOR, 'POST', `/invoices/${draft.id}/line-items`, {
          description: li.description,
          quantity: li.quantity,
          unit: li.unit,
          unit_price: li.unit_price,
        });
      }

      const total = sumItems(inv.items);
      let label = 'draft';

      // …the Skipper (Owner) signs off: finalize/send/payment are Owner-only.
      if (inv.state === 'sent' || inv.state === 'paid' || inv.state === 'overdue') {
        await bill(APPROVER, 'POST', `/invoices/${draft.id}/finalize`);
        label = inv.state === 'paid' ? 'sent(pre-pay)' : inv.state;
      }

      if (inv.state === 'paid') {
        await bill(APPROVER, 'POST', `/invoices/${draft.id}/payments`, {
          amount: total,
          payment_method: inv.payment_method ?? 'bank_transfer',
          reference: `PAID-${draft.id.slice(0, 8)}`,
        });
        label = 'paid';
      }

      tally[inv.state]++;
      invoicesMade++;
      console.log(
        `invoice [${label}]: ${inv.client} — $${(total / 100).toFixed(2)} (${inv.items.length} items)`,
      );
    } catch (e) {
      console.log(`  invoice failed: ${inv.client} (${inv.state}) — ${e.message}`);
    }
  }

  // ----- Expenses (skip any that already exist by description) -----
  const existingExpenses = (await bill(CREATOR, 'GET', '/expenses')) ?? [];
  const seenExpense = new Set(existingExpenses.map((e) => e.description));
  let expensesMade = 0;
  for (const ex of EXPENSES) {
    if (seenExpense.has(ex.description)) {
      console.log(`expense exists: ${ex.description}`);
      continue;
    }
    try {
      await bill(CREATOR, 'POST', '/expenses', ex);
      expensesMade++;
      console.log(`expense: ${ex.description} — $${(ex.amount / 100).toFixed(2)}`);
    } catch (e) {
      console.log(`  expense failed: ${ex.description} — ${e.message}`);
    }
  }

  console.log(
    `\nBill seed done: ${clientsCreated} new clients, ${invoicesMade} invoices ` +
      `(draft ${tally.draft}, sent ${tally.sent}, paid ${tally.paid}, overdue ${tally.overdue}), ` +
      `${expensesMade} expenses.`,
  );
})().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
