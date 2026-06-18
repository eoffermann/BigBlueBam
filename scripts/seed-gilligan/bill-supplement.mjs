/**
 * Gilligan's Island themed Bill SUPPLEMENT — billing Rates + org Settings.
 *
 * The companion seeder (scripts/seed-gilligan/bill.mjs) populated clients,
 * invoices, and expenses, but left two Bill views empty:
 *   - Rates    (/bill → "Billing Rates")  : no rates configured
 *   - Settings (/bill → "Settings")        : no company info / invoice defaults
 *
 * This script fills both, in character. Mr. Howell may run the books, but
 * RATES and SETTINGS are owner-only verbs (bill.rate.* / bill.setting.update),
 * which the org Member group is denied — so EVERYTHING here runs as the
 * Skipper (org owner, Jonas Grumby). See packages/permissions generated
 * defaults: Member is denied finalize/send/payment.create and, by the same
 * grouping, the rate/setting admin verbs.
 *
 * Idempotent:
 *   - Rates are matched on (rate_amount, rate_type, project_id, user_id);
 *     an existing match is skipped rather than duplicated.
 *   - Settings is a single per-org row (PUT is an upsert that overwrites the
 *     listed fields), so re-running just re-asserts the same values.
 *
 * The bill_rates table has NO name/label column — a rate is identified purely
 * by its SCOPE (org-default / per-project / per-user / user+project), which is
 * exactly what the Rates view renders in its "Scope" column. So the themed
 * roles below are expressed as scope choices + amounts; the human-readable
 * role name lives in `label` for our own logging only and is never sent.
 *
 * Amounts are in CENTS (integers), matching the rest of Bill.
 *
 * Run from the repo host (api container can reach the internal bill host and
 * the cast Bearer keys bypass CSRF + scope to the Gilligan org):
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bill-supplement.mjs
 *
 * Bill internal host is http://bill-api:4014 with all routes under /v1.
 *   - GET  /rates            list rates (filterable by project_id / user_id)
 *   - POST /rates            create a rate { rate_amount, rate_type, currency?,
 *                                            project_id?, user_id?, effective_from? }
 *   - GET  /settings         current org billing settings (defaults if unset)
 *   - PUT  /settings         upsert org billing settings (NOT PATCH)
 */

const BASE = 'http://bill-api:4014/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Owner does it all — rates + settings are owner-only verbs.
const OWNER = 'skipper';

// Gilligan org member UUIDs (resolved live; stable seed identities).
const U = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece', // Jonas Grumby (owner)
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf', // Roy Hinkley
  gilligan: '0f47c55f-4c7d-4100-a00b-ca131a1e864d', // Willy Gilligan
  ginger: 'c8926754-2a93-4bd6-bf20-5b1f87e27385', // Ginger Grant
};

// Gilligan org project UUIDs.
const P = {
  rescue: '737a5712-0f39-4d12-b627-cf892b6d38d6', // Rescue Operations
  radio: '274cb6cd-0b91-4062-9624-ac7700d5ed33', // Fix the Radio
  luau: '72ceeb4e-1505-4a36-99bc-1a4bea1a048c', // Howell Luau
};

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

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------
// Rates — themed roles encoded as scope + amount + type.
//   label       : human-readable role, for our logging only (NOT persisted).
//   rate_amount : cents.
//   rate_type   : 'hourly' | 'daily' | 'fixed'.
//   project_id  : scope to a project (optional).
//   user_id     : scope to a cast member (optional).
// Scope variety so the Rates "Scope" column shows Organization / Project /
// User / User + Project.
// ---------------------------------------------------------------------------

const RATES = [
  {
    label: 'Salvage Diving — $300/hr (org default)',
    rate_amount: 30000,
    rate_type: 'hourly',
    // org-default: no project/user → Scope = "Organization"
  },
  {
    label: 'Charter Captain (Skipper) — $250/hr on Rescue Operations',
    rate_amount: 25000,
    rate_type: 'hourly',
    user_id: U.skipper,
    project_id: P.rescue,
  },
  {
    label: 'Radio Repair (Professor) — $180/hr on Fix the Radio',
    rate_amount: 18000,
    rate_type: 'hourly',
    user_id: U.professor,
    project_id: P.radio,
  },
  {
    label: 'Coconut Harvesting (Gilligan) — $40/hr',
    rate_amount: 4000,
    rate_type: 'hourly',
    user_id: U.gilligan,
  },
  {
    label: 'Luau Catering — $1500 fixed on Howell Luau',
    rate_amount: 150000,
    rate_type: 'fixed',
    project_id: P.luau,
  },
  {
    label: 'Hula Performance (Ginger) — $500/show on Howell Luau',
    rate_amount: 50000,
    rate_type: 'fixed',
    user_id: U.ginger,
    project_id: P.luau,
  },
];

// ---------------------------------------------------------------------------
// Settings — company info + invoice defaults, in character.
// PUT /settings upserts the single per-org row. Field set must be a subset of
// updateSettingsSchema (apps/bill-api/src/routes/settings.routes.ts).
// ---------------------------------------------------------------------------

const SETTINGS = {
  company_name: 'Gilligan Travel, Ltd.',
  company_email: 'billing@gilligantravel.example',
  company_phone: '+1-808-555-0001',
  company_address: 'Hut #1, The Lagoon, Uncharted Isle, South Pacific',
  company_tax_id: 'GT-ISLAND-0001',
  default_currency: 'USD',
  default_tax_rate: 8.25,
  default_payment_terms_days: 15, // Net 15
  invoice_prefix: 'GT-',
  default_payment_instructions:
    'Remit to the Howell Family Office. Payment accepted in coconuts, pearls, ' +
    'or Howell promissory notes.',
  default_footer_text:
    'Thank you for sailing with Gilligan Travel, Ltd. — a three-hour tour, ' +
    'every time. Payment accepted in coconuts, pearls, or Howell promissory notes.',
  default_terms_text:
    'Net 15. Late charters are subject to a coconut surcharge. All salvage and ' +
    'rescue voyages are billed door-to-lagoon. Disputes settled by the Skipper.',
};

const scopeLabel = (r) =>
  r.user_id && r.project_id
    ? 'User + Project'
    : r.user_id
      ? 'User'
      : r.project_id
        ? 'Project'
        : 'Organization';

// match an existing rate on the fields that define it (no name to match on)
const sameRate = (existing, r) =>
  existing.rate_amount === r.rate_amount &&
  (existing.rate_type ?? 'hourly') === r.rate_type &&
  (existing.project_id ?? null) === (r.project_id ?? null) &&
  (existing.user_id ?? null) === (r.user_id ?? null);

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

(async () => {
  if (!KEYS[OWNER]) {
    throw new Error(`No API key for "${OWNER}" in GKEYS — check scripts/.gilligan-keys.env`);
  }

  // ----- Rates -----
  const existing = (await bill(OWNER, 'GET', '/rates')) ?? [];
  const ratesArr = Array.isArray(existing) ? existing : (existing.data ?? []);
  let ratesCreated = 0;
  const created = [];
  for (const r of RATES) {
    if (ratesArr.some((e) => sameRate(e, r))) {
      console.log(`rate exists: ${r.label}`);
      continue;
    }
    const body = { rate_amount: r.rate_amount, rate_type: r.rate_type, currency: 'USD' };
    if (r.project_id) body.project_id = r.project_id;
    if (r.user_id) body.user_id = r.user_id;
    try {
      const made = await bill(OWNER, 'POST', '/rates', body);
      ratesCreated++;
      created.push(r);
      console.log(
        `rate: ${r.label} — ${dollars(r.rate_amount)} ${r.rate_type} [${scopeLabel(r)}] (${made.id})`,
      );
    } catch (e) {
      console.log(`  rate FAILED: ${r.label} — ${e.message}`);
    }
  }

  // ----- Settings -----
  let settingsOk = false;
  const settingsFields = [];
  try {
    const saved = await bill(OWNER, 'PUT', '/settings', SETTINGS);
    settingsOk = true;
    for (const k of Object.keys(SETTINGS)) {
      const v = saved?.[k];
      settingsFields.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    console.log('\nsettings: updated org billing settings');
    for (const line of settingsFields) console.log(`  ${line}`);
  } catch (e) {
    console.log(`\nsettings FAILED: ${e.message}`);
  }

  console.log(
    `\nBill supplement done: ${ratesCreated} new rate(s), settings ${settingsOk ? 'set' : 'FAILED'}.`,
  );
})().catch((e) => {
  console.error('supplement failed:', e.message);
  process.exit(1);
});
