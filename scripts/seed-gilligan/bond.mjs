/**
 * Gilligan's Island themed Bond (CRM) seed.
 *
 * The castaways run their "business development" on Bond: chasing rescue,
 * hawking island goods, and funding Mr. Howell's luau. A full, funny pipeline
 * board for the org "Gilligan Travel, Ltd."
 *
 * Idempotent: companies/contacts/deals are matched by natural key (name /
 * email) and skipped if already present; the pipeline + its stages are
 * found-or-created by name. Re-running only fills gaps.
 *
 * Run from the repo host (inside the api container, which can reach the
 * internal Bond host AND the database):
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bond.mjs
 *
 * Why two transports?
 *   - Companies, contacts, deals, activities go through the Bond REST API
 *     (http://bond-api:4009/v1) authenticated by the cast's read_write API
 *     keys (Bearer bypasses CSRF + scopes to the Gilligan org).
 *   - Pipeline + stage creation requires an *admin*-scoped key (see
 *     requireScope('admin') in pipelines.routes.ts), which the cast keys are
 *     not. So the pipeline and its stages are seeded directly via SQL using
 *     the api container's DATABASE_URL. This is the same Postgres the Bond API
 *     reads, so the deals created over REST attach to it cleanly.
 */

import postgres from 'postgres';

const BOND = 'http://bond-api:4009/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (must be members of the Gilligan org).
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
  gilligan: '0f47c55f-4c7d-4100-a00b-ca131a1e864d',
  maryann: 'd2835cc4-8ee9-4a27-b43e-84ab19a21450',
  ginger: 'c8926754-2a93-4bd6-bf20-5b1f87e27385',
  howell: '414d283d-f13b-4608-91db-dfd024db4064',
  lovey: '0ddd0b3e-4de3-4077-a905-07878dc43960',
};

// ---------------------------------------------------------------------------
// REST helpers (cast API keys)
// ---------------------------------------------------------------------------

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}
async function api(who, method, path, body) {
  const r = await fetch(`${BOND}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 250)}`);
  }
  return data;
}
const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// ---------------------------------------------------------------------------
// Themed content
// ---------------------------------------------------------------------------

// Pipeline + stages (seeded via SQL — admin gate). stage_type drives the board
// columns; "won"/"lost" terminal columns close out the deal lifecycle.
const PIPELINE = {
  name: 'Island Rescue & Revenue',
  description:
    'The castaways’ path from "a ship on the horizon" to "we’re finally rescued (or at least paid)."',
  currency: 'USD',
  stages: [
    { name: 'Lead', sort_order: 0, stage_type: 'active', probability_pct: 10, color: '#94a3b8', rotting_days: 14 },
    { name: 'Qualified', sort_order: 1, stage_type: 'active', probability_pct: 30, color: '#38bdf8', rotting_days: 21 },
    { name: 'Proposal', sort_order: 2, stage_type: 'active', probability_pct: 60, color: '#fbbf24', rotting_days: 30 },
    { name: 'Won', sort_order: 3, stage_type: 'won', probability_pct: 100, color: '#22c55e' },
    { name: 'Lost', sort_order: 4, stage_type: 'lost', probability_pct: 0, color: '#ef4444' },
  ],
};

// Companies (created over REST). Matched by exact name.
const COMPANIES = [
  {
    name: 'S.S. Wanderer Charters',
    industry: 'Maritime Charter',
    size_bucket: '11-50',
    website: 'https://wanderer-charters.example.com',
    city: 'Honolulu',
    country: 'US',
    owner: 'skipper',
  },
  {
    name: 'Pacific & Orient Steamship Co.',
    industry: 'Ocean Freight & Passenger',
    size_bucket: '1001-5000',
    website: 'https://pacific-orient.example.com',
    city: 'San Francisco',
    country: 'US',
    owner: 'howell',
  },
  {
    name: 'Howell Industries (Island Office)',
    industry: 'Diversified Holdings',
    size_bucket: '5000+',
    website: 'https://howell-industries.example.com',
    city: 'Lagoon, North Shore',
    country: 'US',
    owner: 'howell',
  },
  {
    name: 'Kona Coconut Exporters',
    industry: 'Agricultural Export',
    size_bucket: '51-200',
    website: 'https://kona-coconut.example.com',
    city: 'Kailua-Kona',
    country: 'US',
    owner: 'maryann',
  },
  {
    name: 'Honolulu Air-Sea Rescue',
    industry: 'Search & Rescue',
    size_bucket: '201-1000',
    website: 'https://hi-airsea-rescue.example.com',
    city: 'Honolulu',
    country: 'US',
    owner: 'professor',
  },
  {
    name: 'Tinseltown Pictures',
    industry: 'Motion Pictures',
    size_bucket: '201-1000',
    website: 'https://tinseltown.example.com',
    city: 'Hollywood',
    country: 'US',
    owner: 'ginger',
  },
];

// Contacts (created over REST). Matched by email. `company` links by name.
const CONTACTS = [
  {
    first_name: 'Captain Reginald',
    last_name: 'Tidewater',
    email: 'r.tidewater@wanderer-charters.example.com',
    title: 'Charter Captain, S.S. Wanderer',
    company: 'S.S. Wanderer Charters',
    lifecycle_stage: 'opportunity',
    lead_source: 'Passing Ship Sighting',
    owner: 'skipper',
  },
  {
    first_name: 'Marshall',
    last_name: 'Steerforth',
    email: 'm.steerforth@pacific-orient.example.com',
    title: 'VP, Passenger Routes',
    company: 'Pacific & Orient Steamship Co.',
    lifecycle_stage: 'sales_qualified',
    lead_source: 'Message in a Bottle',
    owner: 'howell',
  },
  {
    first_name: 'Bartholomew',
    last_name: 'Quibble, Esq.',
    email: 'b.quibble@howell-industries.example.com',
    title: 'Howell Family Counsel',
    company: 'Howell Industries (Island Office)',
    lifecycle_stage: 'customer',
    lead_source: 'Family Retainer',
    owner: 'lovey',
  },
  {
    first_name: 'Leilani',
    last_name: 'Pomare',
    email: 'l.pomare@kona-coconut.example.com',
    title: 'Head of Procurement',
    company: 'Kona Coconut Exporters',
    lifecycle_stage: 'sales_qualified',
    lead_source: 'Trade Inquiry',
    owner: 'maryann',
  },
  {
    first_name: 'Commander Dale',
    last_name: 'Buoy',
    email: 'd.buoy@hi-airsea-rescue.example.com',
    title: 'Operations Commander',
    company: 'Honolulu Air-Sea Rescue',
    lifecycle_stage: 'lead',
    lead_source: 'Distress Flare',
    owner: 'professor',
  },
  {
    first_name: 'Maximilian',
    last_name: 'Glitz',
    email: 'm.glitz@tinseltown.example.com',
    title: 'Hollywood Producer (Scouting Talent)',
    company: 'Tinseltown Pictures',
    lifecycle_stage: 'opportunity',
    lead_source: 'Castaway Screen Test',
    owner: 'ginger',
  },
];

// Deals across the pipeline. Matched by exact name. `stage` is the stage NAME;
// `company`/`contact` link by name/email; `owner` is a cast key.
const DEALS = [
  {
    name: 'Charter Rescue Voyage — S.S. Wanderer',
    company: 'S.S. Wanderer Charters',
    contact: 'r.tidewater@wanderer-charters.example.com',
    stage: 'Proposal',
    value: 18000,
    expected_close_date: '2026-08-15',
    owner: 'skipper',
    description:
      'Persuade Captain Tidewater to swing the Wanderer past our lagoon "on his way to somewhere." Seven passengers, light luggage, will pedal-power the bilge pump if needed.',
    activities: [
      {
        who: 'skipper',
        type: 'call',
        subject: 'Hailed the Wanderer on the coconut radio',
        body: 'Reached Capt. Tidewater for 90 seconds before the battery died. He thinks we MIGHT be on his chart. Gilligan, do NOT touch the antenna again.',
      },
      {
        who: 'professor',
        type: 'note',
        subject: 'Navigation packet prepared',
        body: 'Plotted our position from star fixes and the tide tables. Attached coordinates so the Wanderer cannot "accidentally" miss us a fourth time.',
      },
    ],
  },
  {
    name: 'Coconut Export Contract — Kona',
    company: 'Kona Coconut Exporters',
    contact: 'l.pomare@kona-coconut.example.com',
    stage: 'Qualified',
    value: 9500,
    expected_close_date: '2026-09-30',
    owner: 'maryann',
    description:
      'Mary Ann’s grade-A coconuts and coconut-cream pies, FOB the lagoon. Volume pending whoever ships them off the island.',
    activities: [
      {
        who: 'maryann',
        type: 'email_sent',
        subject: 'Sent sample shipment terms',
        body: 'Leilani liked the cream pie photos. Negotiating freight — the only carrier is, awkwardly, the same ship that keeps not rescuing us.',
      },
    ],
  },
  {
    name: 'Howell Yacht Salvage — P&O Steamship',
    company: 'Pacific & Orient Steamship Co.',
    contact: 'm.steerforth@pacific-orient.example.com',
    stage: 'Lead',
    value: 250000,
    expected_close_date: '2026-12-01',
    owner: 'howell',
    description:
      'Mr. Howell wants P&O to dispatch a salvage tug for "the yacht" (we have a raft). He insists money is no object, then declines every quote.',
    activities: [
      {
        who: 'howell',
        type: 'note',
        subject: 'Lovey’s only condition',
        body: 'Mrs. Howell will approve the salvage IF the tug has a proper dining service. "I will not be rescued without a soup course, Thurston."',
      },
    ],
  },
  {
    name: 'Ginger Film Comeback — Tinseltown',
    company: 'Tinseltown Pictures',
    contact: 'm.glitz@tinseltown.example.com',
    stage: 'Proposal',
    value: 75000,
    expected_close_date: '2026-10-20',
    owner: 'ginger',
    description:
      'Producer Glitz wants to sign Ginger the instant we hit the mainland: "Castaway Starlet" is box-office gold. Contingent on, you know, leaving the island.',
    activities: [
      {
        who: 'ginger',
        type: 'meeting',
        subject: 'Screen test on the beach (filmed by the Professor)',
        body: 'Performed the lagoon monologue at golden hour. Glitz "wept." Mostly sand in his eyes, but he wept.',
      },
    ],
  },
  {
    name: 'Luau Catering Sponsorship — Howell Industries',
    company: 'Howell Industries (Island Office)',
    contact: 'b.quibble@howell-industries.example.com',
    stage: 'Won',
    value: 12000,
    expected_close_date: '2026-06-10',
    owner: 'lovey',
    closed: 'won',
    close_reason:
      'Mr. Howell underwrote the entire luau. Roast pig, leis, tiki torches — invoice charged to the Howell estate without a flicker.',
    description:
      'The Howell Luau, fully funded by Howell Industries. Catering, decor, and an open (non-alcoholic) bar. Lovey approves every place card personally.',
    activities: [
      {
        who: 'lovey',
        type: 'note',
        subject: 'Final menu approved',
        body: 'Approved the menu, vetoed the second pig as "ostentatious," then ordered a third. We are catered.',
      },
    ],
  },
  {
    name: 'Air-Sea Rescue Retainer — Honolulu',
    company: 'Honolulu Air-Sea Rescue',
    contact: 'd.buoy@hi-airsea-rescue.example.com',
    stage: 'Lost',
    value: 5000,
    expected_close_date: '2026-05-01',
    owner: 'professor',
    closed: 'lost',
    close_reason:
      'Commander Buoy "searched the area" and reported no island. We watched the seaplane circle for an hour and wave at a cloud bank. Better luck next monsoon.',
    description:
      'Engage Honolulu Air-Sea Rescue to actually come get us. Signal fires lit, HELP stamped in the sand, message bottles tide-released.',
    activities: [
      {
        who: 'professor',
        type: 'call',
        subject: 'Coordinates relayed twice',
        body: 'Gave the Commander our exact position. He noted it down. He then searched a position 200 miles north. The Professor has filed a strongly-worded coconut.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// SQL: find-or-create the pipeline + stages (admin-gated, so done directly)
// ---------------------------------------------------------------------------

async function ensurePipeline(sql, orgId, creatorId) {
  let [pipeline] = await sql`
    SELECT id, name FROM bond_pipelines
    WHERE organization_id = ${orgId} AND name = ${PIPELINE.name}
    LIMIT 1`;

  let pipelineCreated = false;
  if (!pipeline) {
    [pipeline] = await sql`
      INSERT INTO bond_pipelines (organization_id, name, description, is_default, currency, created_by)
      VALUES (${orgId}, ${PIPELINE.name}, ${PIPELINE.description}, true, ${PIPELINE.currency}, ${creatorId})
      RETURNING id, name`;
    pipelineCreated = true;
    console.log(`pipeline: ${pipeline.name} (${pipeline.id})`);
  } else {
    console.log(`pipeline exists: ${pipeline.name} (${pipeline.id})`);
  }

  // Find-or-create each stage by (pipeline_id, name).
  const stagesByName = {};
  for (const st of PIPELINE.stages) {
    let [row] = await sql`
      SELECT id, name FROM bond_pipeline_stages
      WHERE pipeline_id = ${pipeline.id} AND name = ${st.name}
      LIMIT 1`;
    if (!row) {
      [row] = await sql`
        INSERT INTO bond_pipeline_stages
          (pipeline_id, name, sort_order, stage_type, probability_pct, rotting_days, color)
        VALUES
          (${pipeline.id}, ${st.name}, ${st.sort_order}, ${st.stage_type},
           ${st.probability_pct}, ${st.rotting_days ?? null}, ${st.color})
        RETURNING id, name`;
      console.log(`  stage: ${row.name} (${row.id})`);
    }
    stagesByName[st.name] = row.id;
  }

  return { pipelineId: pipeline.id, stagesByName, pipelineCreated };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  // Resolve the Gilligan org from a cast member's membership (no hardcoded UUID).
  const [orgRow] = await sql`
    SELECT om.org_id, o.name
    FROM organization_memberships om
    JOIN organizations o ON o.id = om.org_id
    WHERE om.user_id = ${CAST.howell}
    ORDER BY om.joined_at ASC
    LIMIT 1`;
  if (!orgRow) {
    console.error('Could not resolve Gilligan org from Howell membership. Aborting.');
    await sql.end();
    process.exit(1);
  }
  const ORG_ID = orgRow.org_id;
  console.log(`org: ${orgRow.name} (${ORG_ID})\n`);

  const counts = { companies: 0, contacts: 0, deals: 0, activities: 0, closed: 0 };
  const fails = [];

  // 1. Pipeline + stages (SQL).
  const { pipelineId, stagesByName } = await ensurePipeline(sql, ORG_ID, CAST.howell);

  // 2. Companies (REST). Skipper/Howell are the dealmakers; create as the owner.
  const companyIdByName = {};
  for (const c of COMPANIES) {
    try {
      const existing = asArr(await api(c.owner, 'GET', `/companies?search=${encodeURIComponent(c.name)}&limit=100`));
      let match = existing.find((x) => x.name === c.name);
      if (!match) {
        const created = await api(c.owner, 'POST', '/companies', {
          name: c.name,
          industry: c.industry,
          size_bucket: c.size_bucket,
          website: c.website,
          city: c.city,
          country: c.country,
          owner_id: CAST[c.owner],
        });
        match = created.data ?? created;
        counts.companies++;
        console.log(`company: ${c.name} (${match.id})`);
      } else {
        console.log(`company exists: ${c.name} (${match.id})`);
      }
      companyIdByName[c.name] = match.id;
    } catch (e) {
      fails.push(`company ${c.name}: ${e.message}`);
      console.log(`  company FAILED: ${c.name} — ${e.message}`);
    }
  }

  // 3. Contacts (REST). Matched by email.
  const contactIdByEmail = {};
  for (const ct of CONTACTS) {
    try {
      const found = asArr(await api(ct.owner, 'GET', `/contacts?search=${encodeURIComponent(ct.email)}&limit=100`));
      let match = found.find((x) => (x.email || '').toLowerCase() === ct.email.toLowerCase());
      if (!match) {
        const created = await api(ct.owner, 'POST', '/contacts', {
          first_name: ct.first_name,
          last_name: ct.last_name,
          email: ct.email,
          title: ct.title,
          lifecycle_stage: ct.lifecycle_stage,
          lead_source: ct.lead_source,
          owner_id: CAST[ct.owner],
        });
        match = created.data ?? created;
        counts.contacts++;
        console.log(`contact: ${ct.first_name} ${ct.last_name} (${match.id})`);
      } else {
        console.log(`contact exists: ${ct.email} (${match.id})`);
      }
      contactIdByEmail[ct.email] = match.id;
    } catch (e) {
      fails.push(`contact ${ct.email}: ${e.message}`);
      console.log(`  contact FAILED: ${ct.email} — ${e.message}`);
    }
  }

  // 4. Deals (REST), with linked company/contact, activities, and close-out.
  for (const d of DEALS) {
    try {
      const stageId = stagesByName[d.stage];
      if (!stageId) {
        fails.push(`deal ${d.name}: unknown stage "${d.stage}"`);
        continue;
      }

      // Idempotency: match by exact name within the pipeline.
      const existing = asArr(await api(d.owner, 'GET', `/deals?search=${encodeURIComponent(d.name)}&limit=100`));
      let deal = existing.find((x) => x.name === d.name);

      if (!deal) {
        const created = await api(d.owner, 'POST', '/deals', {
          name: d.name,
          pipeline_id: pipelineId,
          stage_id: stageId,
          value: d.value,
          expected_close_date: d.expected_close_date,
          description: d.description,
          owner_id: CAST[d.owner],
          ...(companyIdByName[d.company] ? { company_id: companyIdByName[d.company] } : {}),
        });
        deal = created.data ?? created;
        counts.deals++;
        console.log(`deal: ${d.name} (${deal.id}) [${d.stage}]`);

        // Link the primary contact (best-effort).
        const contactId = contactIdByEmail[d.contact];
        if (contactId) {
          try {
            await api(d.owner, 'POST', `/deals/${deal.id}/contacts`, {
              contact_id: contactId,
              role: 'Primary Contact',
            });
          } catch (e) {
            fails.push(`deal ${d.name} contact link: ${e.message}`);
          }
        }

        // Log in-character activities (only for freshly-created deals).
        for (const a of d.activities ?? []) {
          try {
            await api(a.who, 'POST', '/activities', {
              deal_id: deal.id,
              ...(contactId ? { contact_id: contactId } : {}),
              ...(companyIdByName[d.company] ? { company_id: companyIdByName[d.company] } : {}),
              activity_type: a.type,
              subject: a.subject,
              body: a.body,
            });
            counts.activities++;
          } catch (e) {
            fails.push(`activity for ${d.name}: ${e.message}`);
          }
        }

        // Close out won/lost deals so the terminal columns are populated.
        if (d.closed === 'won') {
          await api(d.owner, 'POST', `/deals/${deal.id}/won`, { close_reason: d.close_reason });
          counts.closed++;
        } else if (d.closed === 'lost') {
          await api(d.owner, 'POST', `/deals/${deal.id}/lost`, { close_reason: d.close_reason });
          counts.closed++;
        }
      } else {
        console.log(`deal exists: ${d.name} (${deal.id})`);
      }
    } catch (e) {
      fails.push(`deal ${d.name}: ${e.message}`);
      console.log(`  deal FAILED: ${d.name} — ${e.message}`);
    }
  }

  await sql.end();

  console.log(
    `\nBond seed done: +${counts.companies} companies, +${counts.contacts} contacts, ` +
    `+${counts.deals} deals (${counts.closed} closed), +${counts.activities} activities.`,
  );
  if (fails.length) {
    console.log(`\n${fails.length} failure(s):`);
    for (const f of fails) console.log(`  - ${f}`);
  }
})().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
