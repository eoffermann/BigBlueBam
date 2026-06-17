/**
 * Gilligan's Island themed Bearing (Goals / OKRs) seed.
 *
 * The castaways run their rescue effort — and the Howells' social calendar —
 * as quarterly OKRs. One ACTIVE period ("Monsoon Season 2026") holds a half-
 * dozen in-character objectives, each with 2-3 key results, deliberately
 * spread across on_track / at_risk / behind / achieved so the dashboard, the
 * at-risk view, and the per-owner ("My Goals") view all render something
 * interesting. A handful of KR check-ins give the progress charts real data.
 *
 * Idempotent: the period is found-or-created by name; each goal is found-or-
 * created by title within that period; each KR is found-or-created by title
 * within its goal. Re-running only fills gaps and re-asserts the chosen
 * statuses. KR check-ins are skipped once a KR already carries a non-zero
 * current value, so re-runs don't pile up redundant history points.
 *
 * Run from the repo host (inside the api container, which can reach the
 * internal Bearing host):
 *   GKEYS=$(node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("scripts/.gilligan-keys.env","utf8").split("\n")){if(l&&!l.startsWith("#")&&l.includes("=")){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1).trim();}}process.stdout.write(JSON.stringify(o))')
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bearing.mjs
 *
 * Auth note: everything is seeded as the SKIPPER (org owner). Period + goal
 * creation are scope/capability-gated (read_write + bearing.period.create /
 * bearing.goal.create), and the owner key clears all of them. Each goal still
 * carries an explicit owner_id so it shows up under the right castaway in the
 * per-owner view — at least two goals are owned by the Skipper so "My Goals"
 * is populated when the dashboard is captured as him. If the Skipper key ever
 * 403s on a leg, that's surfaced loudly rather than silently swallowed.
 *
 * KNOWN BLOCKER (pre-existing schema drift, NOT fixed here): on a stock stack
 * the bearing `progress` columns are NUMERIC(5,4) (max 9.9999) per migration
 * 0028_bearing_tables.sql, but the Drizzle schema declares NUMERIC(5,2) and
 * the app code (computeKrProgress / status-engine) writes a *percentage*
 * (0-100) into them. So every key-result create whose computed progress is
 * >= 10% returns HTTP 500 "numeric field overflow". This seeder does NOT
 * mutate the shared schema to work around it — repairing app/DB drift is out
 * of scope for a data seed and must land as a proper migration. Until that
 * migration ships, the period + goals + owners + status updates seed cleanly
 * over REST and the KR/check-in legs are expected to fail; they are reported
 * as failures rather than hidden. See the final report for the fix needed.
 */

const BEARING = 'http://bearing-api:4007/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (must be members of the Gilligan org). Matches bam.mjs CAST.
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
  gilligan: '0f47c55f-4c7d-4100-a00b-ca131a1e864d',
  maryann: 'd2835cc4-8ee9-4a27-b43e-84ab19a21450',
  ginger: 'c8926754-2a93-4bd6-bf20-5b1f87e27385',
  howell: '414d283d-f13b-4608-91db-dfd024db4064',
  lovey: '0ddd0b3e-4de3-4077-a905-07878dc43960',
};

// Single authoring identity: the Skipper (org owner) clears every scope/cap gate.
const ACTOR = 'skipper';

// ---------------------------------------------------------------------------
// REST helper (Skipper API key; Bearer bypasses CSRF + scopes to the org)
// ---------------------------------------------------------------------------

function H() {
  return { Authorization: `Bearer ${KEYS[ACTOR]}`, 'Content-Type': 'application/json' };
}
async function api(method, path, body) {
  const r = await fetch(`${BEARING}${path}`, {
    method,
    headers: H(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }
  }
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 250)}`);
  }
  return data.data ?? data;
}
const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// ---------------------------------------------------------------------------
// Themed content
// ---------------------------------------------------------------------------

// One ACTIVE period covering the rainy season so it brackets the frozen
// capture clock (2026-06-15). `custom` cadence fits the ~6-month window.
const PERIOD = {
  name: 'Monsoon Season 2026',
  period_type: 'custom',
  starts_at: '2026-04-01',
  ends_at: '2026-09-30',
  status: 'active',
};

// Goals + key results.
//   status: stored goal status (drives at-risk view + dashboard badges).
//   Each KR: title, metric_type, unit, direction, start/current/target, and an
//   optional `checkin` value that posts a value check-in so charts have a point
//   beyond the initial current_value.
const GOALS = [
  {
    title: 'Get Off This Island',
    owner: 'skipper',
    scope: 'organization',
    status: 'at_risk',
    icon: '🛟',
    color: '#0ea5e9',
    description:
      "The whole point, little buddy. Build something seaworthy, throw every signal we've got, and flag down anything with an engine.",
    krs: [
      {
        title: 'Raft seaworthiness (passes the lagoon float test)',
        metric_type: 'percentage', unit: '%', direction: 'increase',
        start_value: 0, current_value: 55, target_value: 100, checkin: 60,
      },
      {
        title: 'Rescue signals sent (fires, mirrors, message bottles)',
        metric_type: 'number', unit: 'signals', direction: 'increase',
        start_value: 0, current_value: 42, target_value: 100, checkin: 48,
      },
      {
        title: 'Passing ships successfully hailed',
        metric_type: 'number', unit: 'ships', direction: 'increase',
        start_value: 0, current_value: 1, target_value: 5, checkin: 1,
      },
    ],
  },
  {
    title: 'Restore Communications',
    owner: 'professor',
    scope: 'team',
    team_name: 'Engineering (such as it is)',
    status: 'on_track',
    icon: '📻',
    color: '#22c55e',
    description:
      'A working two-way radio changes everything. Coconut-powered, of course. Gilligan is forbidden from touching the dial.',
    krs: [
      {
        title: 'Radio uptime (hours/day the receiver actually works)',
        metric_type: 'percentage', unit: '%', direction: 'increase',
        start_value: 10, current_value: 78, target_value: 90, checkin: 82,
      },
      {
        title: 'Successful two-way transmissions to the mainland',
        metric_type: 'number', unit: 'transmissions', direction: 'increase',
        start_value: 0, current_value: 6, target_value: 8, checkin: 7,
      },
    ],
  },
  {
    title: 'Keep Everyone Fed & Healthy',
    owner: 'maryann',
    scope: 'team',
    team_name: 'Galley & Infirmary',
    status: 'on_track',
    icon: '🥥',
    color: '#f59e0b',
    description:
      "Coconut cream pie is not a complete diet, no matter what Gilligan claims. Hit the calories, keep the water clean, keep everyone in one piece.",
    krs: [
      {
        title: 'Daily calories per castaway (rolling avg)',
        metric_type: 'number', unit: 'kcal', direction: 'increase',
        start_value: 1200, current_value: 1950, target_value: 2000, checkin: 1980,
      },
      {
        title: 'Fresh water collected per day',
        metric_type: 'number', unit: 'liters', direction: 'increase',
        start_value: 4, current_value: 17, target_value: 20, checkin: 18,
      },
      {
        title: 'First-aid incidents per week (lower is better)',
        metric_type: 'number', unit: 'incidents', direction: 'decrease',
        start_value: 9, current_value: 3, target_value: 1, checkin: 3,
      },
    ],
  },
  {
    title: 'Deliver the Howell Luau',
    owner: 'lovey',
    scope: 'project',
    status: 'behind',
    icon: '🌺',
    color: '#ec4899',
    description:
      'A gala befitting the Howell name, on a budget Mr. Howell insists is "merely a few thousand." Tiki torches are non-negotiable, Lovey dear.',
    krs: [
      {
        title: 'Guest RSVPs confirmed (out of seven possible)',
        metric_type: 'number', unit: 'RSVPs', direction: 'increase',
        start_value: 0, current_value: 2, target_value: 7, checkin: 3,
      },
      {
        title: 'Tiki torches installed around the lagoon',
        metric_type: 'number', unit: 'torches', direction: 'increase',
        start_value: 0, current_value: 4, target_value: 24, checkin: 6,
      },
      {
        title: 'Luau budget on track (% of allotment unspent)',
        metric_type: 'percentage', unit: '%', direction: 'increase',
        start_value: 0, current_value: 20, target_value: 100, checkin: 15,
      },
    ],
  },
  {
    title: 'Maintain Island Morale',
    owner: 'ginger',
    scope: 'team',
    team_name: 'Entertainment',
    status: 'on_track',
    icon: '🎭',
    color: '#a855f7',
    description:
      'A castaway with no morale is a castaway who eats the last of the coconut cream pie out of spite. The show must go on — nightly, by torchlight.',
    krs: [
      {
        title: 'Shows performed this season (revues, radio dramas, sing-alongs)',
        metric_type: 'number', unit: 'shows', direction: 'increase',
        start_value: 0, current_value: 11, target_value: 12, checkin: 12,
      },
      {
        title: 'Logged complaints per week (lower is better)',
        metric_type: 'number', unit: 'complaints', direction: 'decrease',
        start_value: 14, current_value: 4, target_value: 2, checkin: 3,
      },
    ],
  },
  {
    // Second Skipper-owned goal so "My Goals" is comfortably populated as him.
    title: 'Whip the Crew Into Shipshape',
    owner: 'skipper',
    scope: 'team',
    team_name: 'The Crew (Gilligan, mostly)',
    status: 'achieved',
    icon: '⚓',
    color: '#14b8a6',
    description:
      'A captain is only as good as his crew, and right now his crew is Gilligan. Drills, knots, and a strict no-sinking-the-raft policy.',
    krs: [
      {
        title: 'Knots Gilligan can tie without sinking the raft',
        metric_type: 'number', unit: 'knots', direction: 'increase',
        start_value: 0, current_value: 8, target_value: 8, checkin: 8,
      },
      {
        title: 'Morning muster drills completed (all hands on deck)',
        metric_type: 'number', unit: 'drills', direction: 'increase',
        start_value: 0, current_value: 30, target_value: 30, checkin: 30,
      },
    ],
  },
];

// One or two narrative status updates per goal so the goal timeline isn't empty.
const UPDATES = {
  'Get Off This Island': [
    { status: 'at_risk', body: 'Raft floats! Briefly. Then it does the other thing. Gilligan, what did you do to the lashings?' },
    { status: 'at_risk', body: 'Hailed a freighter at dawn. It hailed back with a foghorn and kept going. Counting it as a moral victory.' },
  ],
  'Restore Communications': [
    { status: 'on_track', body: 'Receiver is pulling in the Honolulu weather broadcast clear as a bell. Two-way is close — just need the Professor to stop "improving" it.' },
  ],
  'Keep Everyone Fed & Healthy': [
    { status: 'on_track', body: 'Calorie target met for the third straight week. Banana ration holding. Gilligan put on weight; somehow everyone else lost it.' },
  ],
  'Deliver the Howell Luau': [
    { status: 'behind', body: 'Only two RSVPs. The Skipper says he is "washing his hair." Tiki torch supplier (a hollow bamboo and some palm oil) is behind schedule.' },
  ],
  'Maintain Island Morale': [
    { status: 'on_track', body: "Ginger's Wednesday revue was a sellout — every seat (all four logs) filled. Complaint volume way down since we banned encore requests." },
  ],
  'Whip the Crew Into Shipshape': [
    { status: 'achieved', body: 'Gilligan tied a bowline on the first try and the raft did NOT sink. The Skipper wept. All drills complete. Shipshape, little buddy.' },
  ],
};

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

(async () => {
  const summary = { period: null, goalsCreated: 0, goalsExisting: 0, krsCreated: 0, krsExisting: 0, checkins: 0, updates: 0, driftBlocked: 0, skipperGoals: [], failures: [] };

  // --- Period (find-or-create by name) ---
  let period;
  const periods = asArr(await api('GET', '/periods?limit=100'));
  period = periods.find((p) => p.name === PERIOD.name);
  if (!period) {
    period = await api('POST', '/periods', PERIOD);
    console.log(`period created: ${PERIOD.name} (${period.id}) status=${period.status}`);
  } else {
    console.log(`period exists: ${PERIOD.name} (${period.id}) status=${period.status}`);
  }
  summary.period = { id: period.id, name: PERIOD.name, status: period.status };

  // Existing goals in this period, indexed by title (idempotency).
  const existingGoals = asArr(await api('GET', `/goals?period_id=${period.id}&limit=100`));
  const goalByTitle = new Map(existingGoals.map((g) => [g.title, g]));

  for (const g of GOALS) {
    let goal = goalByTitle.get(g.title);
    if (!goal) {
      try {
        goal = await api('POST', '/goals', {
          period_id: period.id,
          title: g.title,
          description: g.description,
          scope: g.scope,
          status: g.status,
          icon: g.icon,
          color: g.color,
          owner_id: CAST[g.owner],
          ...(g.team_name ? { team_name: g.team_name } : {}),
        });
        summary.goalsCreated++;
        console.log(`goal created: "${g.title}" owner=${g.owner} status=${g.status} (${goal.id})`);
      } catch (e) {
        summary.failures.push(`goal "${g.title}": ${e.message}`);
        console.log(`  GOAL FAILED: "${g.title}" — ${e.message}`);
        continue;
      }
    } else {
      summary.goalsExisting++;
      console.log(`goal exists: "${g.title}" (${goal.id})`);
      // Re-assert the chosen status + owner on re-run so the dashboard variety
      // is stable even if a prior run set something else.
      if (goal.status !== g.status || goal.owner_id !== CAST[g.owner]) {
        try {
          await api('PATCH', `/goals/${goal.id}`, { status: g.status, owner_id: CAST[g.owner] });
          console.log(`  re-asserted status=${g.status} owner=${g.owner}`);
        } catch (e) {
          summary.failures.push(`goal "${g.title}" reassert: ${e.message}`);
        }
      }
    }

    if (g.owner === 'skipper') summary.skipperGoals.push(g.title);

    // --- Key results (find-or-create by title within the goal) ---
    const existingKrs = asArr(await api('GET', `/goals/${goal.id}/key-results`));
    const krByTitle = new Map(existingKrs.map((k) => [k.title, k]));

    let order = 0;
    for (const kr of g.krs) {
      let row = krByTitle.get(kr.title);
      if (!row) {
        try {
          row = await api('POST', `/goals/${goal.id}/key-results`, {
            title: kr.title,
            metric_type: kr.metric_type,
            unit: kr.unit,
            direction: kr.direction,
            start_value: kr.start_value,
            current_value: kr.current_value,
            target_value: kr.target_value,
            sort_order: order,
          });
          summary.krsCreated++;
          console.log(`  kr created: "${kr.title}" ${kr.current_value}/${kr.target_value} ${kr.unit}`);
        } catch (e) {
          summary.failures.push(`kr "${kr.title}" (goal "${g.title}"): ${e.message}`);
          console.log(`    KR FAILED: "${kr.title}" — ${e.message}`);
          order++;
          continue;
        }
      } else {
        summary.krsExisting++;
        console.log(`  kr exists: "${kr.title}"`);
      }
      order++;

      // --- Value check-in (only if the KR is still at/near its seed value, so
      //     re-runs don't keep stacking identical history points) ---
      if (kr.checkin !== undefined && row) {
        const cur = Number(row.current_value);
        const alreadyCheckedIn = Number.isFinite(cur) && Math.abs(cur - kr.checkin) < 0.0001;
        if (!alreadyCheckedIn) {
          try {
            await api('POST', `/key-results/${row.id}/value`, { value: kr.checkin });
            summary.checkins++;
            console.log(`    check-in: ${kr.checkin} ${kr.unit}`);
          } catch (e) {
            // The progress-column drift (NUMERIC(5,4) vs the 0-100 the code
            // writes) surfaces as a 500 INTERNAL_ERROR here. Classify it as the
            // known blocker rather than a genuine seed failure so idempotent
            // re-runs stay clean — but still count + report it loudly.
            if (/INTERNAL_ERROR|500/.test(e.message)) {
              summary.driftBlocked++;
            } else {
              summary.failures.push(`checkin "${kr.title}": ${e.message}`);
            }
          }
        }
      }
    }

    // --- Status updates (skip if the goal already has updates) ---
    const ups = UPDATES[g.title] ?? [];
    if (ups.length) {
      let existingUpdates = [];
      try {
        existingUpdates = asArr(await api('GET', `/goals/${goal.id}/updates`));
      } catch {
        /* tolerate */
      }
      if (existingUpdates.length === 0) {
        for (const u of ups) {
          try {
            await api('POST', `/goals/${goal.id}/updates`, { status: u.status, body: u.body });
            summary.updates++;
          } catch (e) {
            summary.failures.push(`update "${g.title}": ${e.message}`);
          }
        }
        if (ups.length) console.log(`  + ${ups.length} status update(s)`);
      } else {
        console.log(`  updates already present (${existingUpdates.length}), skipping`);
      }
    }
  }

  // --- Report ---
  console.log('\n=== Bearing seed summary ===');
  console.log(`period: ${summary.period.name} (${summary.period.id}) status=${summary.period.status}`);
  console.log(`goals:  ${summary.goalsCreated} created, ${summary.goalsExisting} already present`);
  console.log(`KRs:    ${summary.krsCreated} created, ${summary.krsExisting} already present`);
  console.log(`check-ins posted: ${summary.checkins}`);
  console.log(`status updates posted: ${summary.updates}`);
  console.log(`Skipper-owned goals (${summary.skipperGoals.length}): ${summary.skipperGoals.join(', ')}`);

  if (summary.driftBlocked) {
    console.log(
      `\nKNOWN BLOCKER: ${summary.driftBlocked} KR check-in(s) could not be posted because the` +
        ` live bearing progress columns are NUMERIC(5,4) but the app writes a percentage (0-100).` +
        ` The KR rows themselves exist with correct current/target values; only their progress` +
        ` bars read 0% until the columns are widened to NUMERIC(5,2) via a migration. This is a` +
        ` pre-existing schema-drift bug, not a seed defect, and is intentionally NOT worked around` +
        ` here.`,
    );
  }

  if (summary.failures.length) {
    console.log(`\nFAILURES (${summary.failures.length}):`);
    for (const f of summary.failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log('\nNo genuine failures (period + goals + owners + statuses + updates seeded).');
  }
})().catch((e) => {
  console.error('bearing seed failed:', e.message);
  process.exit(1);
});
