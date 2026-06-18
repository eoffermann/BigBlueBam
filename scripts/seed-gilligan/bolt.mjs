/**
 * Gilligan's Island themed Bolt (workflow automation) seed.
 *
 * The castaways automate island life: alarms when a ship is sighted, daily
 * coconut-count nags, raft-progress pings to the Skipper, intake tasks for the
 * next poor soul who washes ashore, Howell luau RSVP handling, and a dead-man's
 * switch on the radio that pages the Professor if it goes quiet. Most are live;
 * a couple are switched off (the radio one is "still being calibrated", the
 * castaway-intake one waits on the welcome form going live).
 *
 * Idempotent: an automation is matched by exact name via Bolt's
 * GET /automations/by-name/:name resolver; an existing one is left untouched.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("scripts/.gilligan-keys.env","utf8").split("\n")){if(l&&!l.startsWith("#")&&l.includes("=")){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1).trim();}}process.stdout.write(JSON.stringify(o))')
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bolt.mjs
 * (The api container can reach the internal bolt-api host; cast API keys
 *  authenticate via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 */

const BOLT_API = 'http://bolt-api:4006/v1';
const BAM_API = 'http://localhost:4000'; // same container; used only to resolve a project_id
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (kept in sync with scripts/seed-gilligan/bam.mjs).
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
  gilligan: '0f47c55f-4c7d-4100-a00b-ca131a1e864d',
  maryann: 'd2835cc4-8ee9-4a27-b43e-84ab19a21450',
  ginger: 'c8926754-2a93-4bd6-bf20-5b1f87e27385',
  howell: '414d283d-f13b-4608-91db-dfd024db4064',
  lovey: '0ddd0b3e-4de3-4077-a905-07878dc43960',
};

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}

async function bolt(who, method, path, body) {
  const r = await fetch(`${BOLT_API}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
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
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 260)}`);
  }
  return data.data ?? data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

/** Resolve an automation UUID by exact name, or null on miss. */
async function findByName(who, name) {
  const r = await fetch(`${BOLT_API}/automations/by-name/${encodeURIComponent(name)}`, {
    headers: H(who),
  });
  if (!r.ok) return null;
  const env = await r.json().catch(() => null);
  return env?.data?.id ?? null;
}

/** Best-effort: resolve the "Rescue Operations" project so the intake-task
 *  automation can create real tasks. Falls back to null (the automation then
 *  posts to Banter instead of creating a task). */
async function resolveRescueProjectId(who) {
  try {
    const r = await fetch(`${BAM_API}/projects?limit=200`, { headers: H(who) });
    if (!r.ok) return null;
    const env = await r.json().catch(() => null);
    const list = asArr(env);
    const p = list.find((x) => x.name === 'Rescue Operations') || list.find((x) => x.name === 'Build a Raft');
    return p?.id ?? null;
  } catch {
    return null;
  }
}

// Condition / action builders --------------------------------------------------
const cond = (sort_order, field, operator, value, logic_group = 'and') => ({
  sort_order,
  field,
  operator,
  ...(value !== undefined ? { value } : {}),
  logic_group,
});

const post = (sort_order, channel_name, content) => ({
  sort_order,
  mcp_tool: 'banter_post_message',
  parameters: { channel_name, content },
});

const dm = (sort_order, user_id, content) => ({
  sort_order,
  mcp_tool: 'banter_send_dm',
  parameters: { user_id, content },
});

(async () => {
  const rescueProjectId = await resolveRescueProjectId('skipper');
  console.log(`rescue project for intake task: ${rescueProjectId ?? '(none — intake automation will post to Banter)'}`);

  // The intake automation's action depends on whether we found a project.
  const intakeAction = rescueProjectId
    ? {
        sort_order: 0,
        mcp_tool: 'create_task',
        parameters: {
          project_id: rescueProjectId,
          title: 'Welcome + process new castaway',
          priority: 'high',
          description:
            'Someone washed ashore. Find them a hut, log their skills (can they fix a radio?), ' +
            'and warn them not to give Gilligan anything important to hold.',
        },
      }
    : post(0, 'general', 'New castaway washed ashore! Someone grab a coconut and go meet them. 🌴');

  // Each entry creates one automation. `who` authenticates (and owns) it.
  const AUTOMATIONS = [
    {
      who: 'skipper',
      enabled: true,
      payload: {
        name: 'Sound the Alarm When a Ship Is Sighted',
        description:
          'A rescue is in the bag the moment a passing ship deal closes WON. ' +
          'Bang the gong, post to #general, and (Gilligan) do NOT mess this up.',
        trigger_source: 'bond',
        trigger_event: 'deal.won',
        conditions: [cond(0, 'deal.name', 'is_not_empty')],
        actions: [
          post(
            0,
            'general',
            '🚨🚢 SHIP SIGHTED — RESCUE SECURED! Everyone to the beach! Gilligan, leave the gong alone.',
          ),
        ],
      },
    },
    {
      who: 'maryann',
      enabled: true,
      payload: {
        name: 'Daily Coconut-Count Reminder',
        description:
          'Every morning at 8, remind Mary Ann to tally the coconut stores. ' +
          'A pie is only as good as its inventory.',
        trigger_source: 'schedule',
        trigger_event: 'cron.fired',
        cron_expression: '0 8 * * *',
        cron_timezone: 'Pacific/Honolulu',
        actions: [
          dm(
            0,
            CAST.maryann,
            '🥥 Good morning! Time for the daily coconut count. Subtract whatever Gilligan ate overnight.',
          ),
        ],
      },
    },
    {
      who: 'skipper',
      enabled: true,
      payload: {
        name: 'When Raft Build Hits 100% → Alert the Skipper',
        description:
          'The instant a raft task is marked complete, ping the Skipper so he can ' +
          'inspect the lashings before anyone climbs aboard.',
        trigger_source: 'bam',
        trigger_event: 'task.completed',
        conditions: [cond(0, 'task.title', 'contains', 'raft')],
        actions: [
          dm(
            0,
            CAST.skipper,
            "🛶 Raft milestone complete! Inspect the lashings before launch — and remember what happened LAST time.",
          ),
        ],
      },
    },
    {
      who: 'professor',
      enabled: false, // waiting on the welcome form going live
      payload: {
        name: 'New Castaway Washed Ashore → Create Intake Task',
        description:
          'When the "Castaway Welcome" form gets a submission, open an intake task ' +
          '(hut, skills, sandals) so nobody is left wandering the lagoon.',
        trigger_source: 'blank',
        trigger_event: 'submission.created',
        conditions: [cond(0, 'form.title', 'contains', 'Castaway')],
        actions: [intakeAction],
      },
    },
    {
      who: 'lovey',
      enabled: true,
      payload: {
        name: 'Howell Luau RSVP Received → Add to Guest List',
        description:
          'Every "yes" RSVP to a Howell event gets announced in #general so Lovey ' +
          'can engrave another bamboo place card.',
        trigger_source: 'book',
        trigger_event: 'event.rsvp',
        conditions: [cond(0, 'response.status', 'equals', 'yes')],
        actions: [
          post(
            0,
            'general',
            '🌺 Another RSVP for the Howell luau! Lovey, dust off the good monocle and engrave a place card.',
          ),
        ],
      },
    },
    {
      who: 'professor',
      enabled: false, // dead-man's switch still being calibrated
      payload: {
        name: 'Radio Goes Quiet 24h → Page the Professor',
        description:
          "A daily dead-man's check: if the radio hasn't been heard from in 24 hours, " +
          'page the Professor to climb the pole and jiggle the coconut wiring.',
        trigger_source: 'schedule',
        trigger_event: 'cron.fired',
        cron_expression: '0 9 * * *',
        cron_timezone: 'Pacific/Honolulu',
        actions: [
          dm(
            0,
            CAST.professor,
            '📻 Radio silence check: no signal logged in 24h. Time to climb the pole and reseat the coconut tubes.',
          ),
        ],
      },
    },
  ];

  let created = 0;
  let skipped = 0;
  const results = [];

  for (const a of AUTOMATIONS) {
    const { who, enabled, payload } = a;
    const existing = await findByName(who, payload.name);
    if (existing) {
      skipped++;
      results.push({ name: payload.name, enabled, status: 'exists' });
      console.log(`exists: ${payload.name}`);
      continue;
    }
    try {
      const made = await bolt(who, 'POST', '/automations', { ...payload, enabled });
      created++;
      results.push({ name: payload.name, enabled, status: 'created', id: made.id });
      console.log(`created (${enabled ? 'enabled' : 'disabled'}): ${payload.name} [${made.id}]`);
    } catch (e) {
      results.push({ name: payload.name, enabled, status: 'FAILED', error: e.message });
      console.log(`FAILED: ${payload.name} — ${e.message}`);
    }
  }

  console.log('\n--- Bolt seed summary ---');
  for (const r of results) {
    const flag = r.enabled ? 'ENABLED ' : 'disabled';
    console.log(`  [${flag}] ${r.name} — ${r.status}${r.error ? ` (${r.error})` : ''}`);
  }
  console.log(`\nBolt seed done: ${created} created, ${skipped} already present.`);
  const failures = results.filter((r) => r.status === 'FAILED');
  if (failures.length) {
    console.log(`${failures.length} FAILED.`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
