/**
 * Gilligan's Island themed Bam (work-management) seed.
 *
 * The castaways run their rescue (and the Howells' social calendar) on
 * BigBlueBam. Idempotent: skips a project if one with the same name exists.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/bam.mjs
 * (api container can reach the internal app hosts; cast API keys authenticate
 *  via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 */

const API = 'http://localhost:4000';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (from create-admin / create-user output).
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
async function api(who, method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: H(who), ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data.data ?? data;
}

// Projects: name, description, and a themed task list (title, assignee, priority).
const PROJECTS = [
  {
    name: 'Build a Raft', prefix: 'RAFT',
    description: 'Escape the island before the next monsoon — bamboo procurement, lashing, and sea trials.',
    owner: 'skipper',
    tasks: [
      { t: 'Cut and cure 40 lengths of bamboo', who: 'gilligan', p: 'high' },
      { t: 'Weave vine rope (Professor: tensile test first!)', who: 'professor', p: 'high' },
      { t: 'Design a sail from the Howells’ spare linens', who: 'ginger', p: 'medium' },
      { t: 'Patch the last raft’s leak (do NOT let Gilligan steer)', who: 'skipper', p: 'urgent' },
      { t: 'Provision coconuts + fresh water for the voyage', who: 'maryann', p: 'medium' },
      { t: 'Sea-trial in the lagoon at high tide', who: 'skipper', p: 'low' },
    ],
  },
  {
    name: 'Fix the Radio', prefix: 'RADIO',
    description: 'Restore two-way contact with the mainland. Coconut-powered, obviously.',
    owner: 'professor',
    tasks: [
      { t: 'Rebuild receiver from the Minnow’s salvaged parts', who: 'professor', p: 'urgent' },
      { t: 'Charge the battery (bicycle generator — Gilligan pedals)', who: 'gilligan', p: 'high' },
      { t: 'String a longwire antenna between the two tallest palms', who: 'skipper', p: 'medium' },
      { t: 'Log the Honolulu weather broadcast schedule', who: 'maryann', p: 'low' },
      { t: 'Draft a distress message (keep it under 30 seconds)', who: 'professor', p: 'medium' },
    ],
  },
  {
    name: 'Howell Luau', prefix: 'LUAU',
    description: 'A suitably lavish island gala. Mr. Howell is funding it; Lovey is approving every detail.',
    owner: 'lovey',
    tasks: [
      { t: 'Roast a pig (Gilligan: do not eat the centerpiece)', who: 'gilligan', p: 'high' },
      { t: 'String flower leis and tiki torches around the lagoon', who: 'maryann', p: 'medium' },
      { t: 'Rehearse the hula floor show', who: 'ginger', p: 'medium' },
      { t: 'Mix the Howell punch (non-alcoholic, sadly)', who: 'lovey', p: 'low' },
      { t: 'Engrave bamboo place cards for the guest list', who: 'howell', p: 'low' },
    ],
  },
  {
    name: 'Rescue Operations', prefix: 'RESQ',
    description: 'Every signal we can muster — fires, mirrors, bottles, and the occasional passing plane.',
    owner: 'skipper',
    tasks: [
      { t: 'Build and man the signal fire on Lookout Point', who: 'skipper', p: 'high' },
      { t: 'Polish a coconut-shell mirror array', who: 'professor', p: 'medium' },
      { t: 'Cork 100 message bottles and tide-release them', who: 'gilligan', p: 'low' },
      { t: 'Stamp HELP into the beach (large enough for aircraft)', who: 'maryann', p: 'medium' },
      { t: 'Negotiate a ride with the visiting yacht (see Bond)', who: 'howell', p: 'high' },
    ],
  },
  {
    name: 'Island Infrastructure', prefix: 'ISLE',
    description: 'Huts, fresh water, and a working kitchen so civilization doesn’t entirely collapse.',
    owner: 'maryann',
    tasks: [
      { t: 'Re-thatch the Howells’ hut (storm damage)', who: 'gilligan', p: 'medium' },
      { t: 'Dig a second freshwater catchment', who: 'professor', p: 'high' },
      { t: 'Inventory the pantry and ration the sugar', who: 'maryann', p: 'medium' },
      { t: 'Repair the bamboo footbridge to the north shore', who: 'skipper', p: 'low' },
    ],
  },
];

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

(async () => {
  let created = 0;
  let tasksMade = 0;

  for (const proj of PROJECTS) {
    // Find-or-create as the OWNER (each owner sees their own projects).
    const mine = asArr(await api(proj.owner, 'GET', '/projects?limit=200'));
    let p = mine.find((x) => x.name === proj.name);
    if (!p) {
      p = await api(proj.owner, 'POST', '/projects', {
        name: proj.name,
        description: proj.description,
        task_id_prefix: proj.prefix,
      });
      created++;
      console.log(`project: ${proj.name} (${p.id})`);
    } else {
      console.log(`project exists: ${proj.name} (${p.id})`);
    }

    // Skip task seeding if the project already has tasks (idempotent).
    const existingTasks = asArr(await api(proj.owner, 'GET', `/projects/${p.id}/tasks?limit=5`));
    if (existingTasks.length > 0) {
      console.log(`  tasks already present (${existingTasks.length}+), skipping`);
      continue;
    }

    const phases = asArr(await api(proj.owner, 'GET', `/projects/${p.id}/phases`));
    let i = 0;
    for (const task of proj.tasks) {
      const phase = phases.length ? phases[i % phases.length] : null;
      // Spread start/due dates around the frozen capture clock (2026-06-15) so
      // the Timeline/Gantt view renders populated bars.
      const day = 10 + ((i * 2) % 16);
      const pad = (n) => String(n).padStart(2, '0');
      const body = {
        title: task.t,
        assignee_id: CAST[task.who],
        priority: task.p,
        start_date: `2026-06-${pad(day)}`,
        due_date: `2026-06-${pad(Math.min(30, day + 2 + (i % 4)))}`,
        ...(phase ? { phase_id: phase.id } : {}),
      };
      try {
        await api(proj.owner, 'POST', `/projects/${p.id}/tasks`, body);
        tasksMade++;
      } catch (e) {
        console.log(`  task failed: ${task.t} — ${e.message}`);
      }
      i++;
    }
    console.log(`  + ${proj.tasks.length} tasks`);
  }
  console.log(`\nBam seed done: ${created} new projects, ${tasksMade} tasks.`);
})().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
