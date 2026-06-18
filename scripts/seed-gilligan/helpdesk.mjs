/**
 * Gilligan's Island themed Helpdesk (support portal) seed.
 *
 * The castaways file support tickets against "Gilligan Travel, Ltd." — the
 * radio's broken (again), the hammock keeps collapsing, and the luau caterer
 * has, predictably, not arrived (it's an island).
 *
 * Runs INSIDE the api container, which can reach the internal app hosts:
 *   - helpdesk-api:4001  (the support portal API; routes under /helpdesk)
 *   - the bundled CLI at dist/cli.js (used to mint a real hdag_ agent key)
 *
 * Helpdesk has its OWN customer auth, separate from Bam. So this seeder:
 *   1. Mints a real hdag_ agent key for the Skipper via the api CLI
 *      (Argon2id-hashed; the customer-facing routes will accept it as
 *      X-Agent-Key for admin/agent actions). A fresh key per run is fine —
 *      old rows stay; nothing leaks because the token is never persisted.
 *   2. Enables the org's helpdesk portal by PATCHing /helpdesk/settings with
 *      the agent key + X-Org-Slug, creating the helpdesk_settings row so
 *      /helpdesk/gilligan-travel-ltd/ resolves, and points its default
 *      project at "Fix the Radio".
 *   3. Registers a few themed CUSTOMERS via POST /helpdesk/auth/register
 *      (password "coconut12345678"), carrying their session + CSRF cookies.
 *   4. Has each customer file themed tickets (idempotent by subject), with
 *      a couple of customer follow-ups + an agent reply, and walks a few
 *      tickets through in_progress / waiting_on_customer / resolved via the
 *      agent PATCH route.
 *
 * Idempotency:
 *   - register: a 409 EMAIL_TAKEN is treated as "already there"; we then log
 *     in to obtain a session.
 *   - tickets: the helpdesk-api dedups (user, subject, description) within an
 *     hour and returns the existing ticket with deduplicated:true. We also
 *     skip follow-ups/status churn when the ticket already had messages.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/helpdesk.mjs
 * (GKEYS is read for parity with the other Gilligan seeders; this script does
 *  not actually need the Bam Bearer keys — it mints its own hdag_ key — but
 *  accepting the env keeps the invocation identical across seeders.)
 */

import { spawnSync } from 'node:child_process';

const HELPDESK = 'http://helpdesk-api:4001';
const ORG_SLUG = 'gilligan-travel-ltd';
const DEFAULT_PROJECT_SLUG = 'fix-the-radio';
const SKIPPER_EMAIL = 'skipper@gilligantravel.example';
// Skipper's Bam user id (from scripts/seed-gilligan/bam.mjs CAST). The agent
// message route requires an explicit author_id when authenticated by an
// X-Agent-Key alone, and it must be a user in the ticket's org.
const SKIPPER_USER_ID = '415a22d7-7ffa-4ffc-a07f-128a25989ece';
const CUSTOMER_PASSWORD = 'coconut12345678';

// ── tiny fetch helpers ──────────────────────────────────────────────────────

/** Parse Set-Cookie headers into a "k=v; k=v" cookie string we can echo back. */
function collectCookies(res, jar) {
  // Node's fetch exposes getSetCookie() (undici). Fall back to a single header.
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const line of raw) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function hd(method, path, { body, jar, csrf, agentKey, orgSlug } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar && Object.keys(jar).length) headers['Cookie'] = cookieHeader(jar);
  if (csrf) headers['x-csrf-token'] = csrf;
  if (agentKey) headers['X-Agent-Key'] = agentKey;
  if (orgSlug) headers['X-Org-Slug'] = orgSlug;
  const res = await fetch(`${HELPDESK}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: res.ok, status: res.status, data, res };
}

// ── 1. mint a real hdag_ agent key for the Skipper via the bundled CLI ───────

function mintAgentKey() {
  const out = spawnSync(
    'node',
    [
      'dist/cli.js',
      'create-helpdesk-agent-key',
      '--email',
      SKIPPER_EMAIL,
      '--name',
      'gilligan-seed-agent',
    ],
    { cwd: '/app', encoding: 'utf8' },
  );
  const combined = `${out.stdout || ''}${out.stderr || ''}`;
  if (out.status !== 0) {
    throw new Error(`create-helpdesk-agent-key failed (exit ${out.status}):\n${combined}`);
  }
  const m = combined.match(/Token:\s*(hdag_[A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`Could not parse hdag_ token from CLI output:\n${combined}`);
  return m[1];
}

// ── content ───────────────────────────────────────────────────────────────

const CUSTOMERS = [
  { email: 'gilligan-hd@gilligantravel.example', display_name: 'Gilligan' },
  { email: 'maryann-hd@gilligantravel.example', display_name: 'Mary Ann' },
  { email: 'howell-hd@gilligantravel.example', display_name: 'Mr. Howell' },
];

// Each ticket: who files it, subject, description, category, priority, an
// optional pair of customer follow-ups, an agent reply, and a target status.
// `status` is the state we walk the ticket to via the agent PATCH route.
const TICKETS = [
  {
    by: 'gilligan-hd@gilligantravel.example',
    subject: 'Radio broke again (Gilligan touched it)',
    description:
      "The shortwave is dead. In my defense, I only wanted to hear the ballgame. There was a small puff of smoke and now it just hums. The Professor is giving me The Look. Please advise.",
    category: 'Equipment',
    priority: 'high',
    agent:
      "We've assigned the Professor to bench-test the receiver. Step one: do not let Gilligan near it. Step two: replace the coconut-fiber fuse.",
    followups: ['It is humming louder now. Is that good?'],
    status: 'in_progress',
  },
  {
    by: 'gilligan-hd@gilligantravel.example',
    subject: 'Hammock collapsed — third time this week',
    description:
      "I lay down for a perfectly reasonable nap and the whole thing let go. This is the third time this week. The Skipper says it is a 'me' problem. I say it is a knot problem.",
    category: 'Facilities',
    priority: 'medium',
    agent:
      "Inspected the rigging. The bowline had worked loose. Re-tied with a double sheet bend and added a load rating. Please observe the posted weight limit.",
    followups: ['What is a load rating?', 'Never mind, it held!'],
    status: 'resolved',
  },
  {
    by: 'maryann-hd@gilligantravel.example',
    subject: 'Need more coconuts, urgently',
    description:
      "I'm down to my last dozen and there are seven mouths to feed. I have cream pies on the schedule and I will not be caught short. Requesting an emergency harvest run.",
    category: 'Provisions',
    priority: 'high',
    agent:
      "Harvest detail dispatched to the north grove. ETA two tides. We'll prioritize the pie-grade coconuts.",
    followups: ['Bless you. The pies depend on this.'],
    status: 'waiting_on_customer',
  },
  {
    by: 'maryann-hd@gilligantravel.example',
    subject: "Luau caterer hasn't arrived (we're on an island)",
    description:
      "Per Mrs. Howell's instructions I booked an off-island caterer for the luau. It is now the day of the event and they have not arrived. I am beginning to suspect a logistical flaw in this plan.",
    category: 'Events',
    priority: 'medium',
    agent:
      "We have escalated to Reception (there is no reception). Recommend we cater in-house; Mary Ann's kitchen has, frankly, never let anyone down.",
    followups: ['Understood. I will simply do it myself, as usual.'],
    status: 'resolved',
  },
  {
    by: 'howell-hd@gilligantravel.example',
    subject: 'Lost pilot keeps rearranging our huts',
    description:
      "A downed aviator has wandered onto the property and, for reasons known only to himself, keeps relocating the bamboo furniture. Lovey is beside herself. This is a five-star island and I expect five-star service.",
    category: 'Facilities',
    priority: 'high',
    agent:
      "We've flagged the wandering aviator for the Skipper's attention and posted a 'Please Do Not Rearrange the Howells' Hut' sign. Compensation in the form of one (1) coconut has been noted.",
    followups: ['A single coconut? Do you know who I am?'],
    status: 'in_progress',
  },
  {
    by: 'howell-hd@gilligantravel.example',
    subject: 'Raft sprung a leak mid-trial',
    description:
      "I invested heavily in the latest raft venture — bamboo futures, mostly — and it sprang a leak roughly forty feet from shore. My portfolio and my trousers are both soaked. I demand a full review.",
    category: 'Equipment',
    // Customer ticket-create only accepts low|medium|high; high is the ceiling
    // a castaway can self-assign. (Agents could escalate to critical later.)
    priority: 'high',
    agent:
      "Sea-trial postmortem complete. Root cause: a single un-caulked seam (and possibly Gilligan's elbow). The Build a Raft team has reopened the lashing task. We do not recommend leveraging bamboo futures.",
    followups: ['See that you caulk it properly this time.'],
    status: 'waiting_on_customer',
  },
  {
    by: 'gilligan-hd@gilligantravel.example',
    subject: 'Coconut cream pie went missing from the cooler',
    description:
      "A pie has vanished. I want to be clear that I have no information about this pie, its whereabouts, or the small amount of cream currently on my shirt. Filing for the record.",
    category: 'Provisions',
    priority: 'low',
    agent:
      "Case reviewed. Given the cream-based evidence, we are marking this resolved with no further action. Mary Ann has been advised to count the pies.",
    followups: [],
    status: 'resolved',
  },
  {
    by: 'maryann-hd@gilligantravel.example',
    subject: 'Signal fire keeps going out',
    description:
      "Every time a plane passes, the Lookout Point fire is somehow out. I've laid in dry kindling and everything. Suspect wind. Or Gilligan. Possibly both.",
    category: 'Rescue',
    priority: 'medium',
    agent:
      "We've added a windbreak of palm fronds and a covered ember pot so the fire relights fast. The next overflight should see a proper blaze.",
    followups: [],
    status: 'open',
  },
];

// ── main ────────────────────────────────────────────────────────────────────

(async () => {
  // GKEYS is accepted for invocation parity with the other seeders; unused.
  void process.env.GKEYS;

  console.log('Gilligan helpdesk seed: starting...');

  // 1. Mint an agent key for the Skipper.
  const agentKey = mintAgentKey();
  console.log(`agent key minted for ${SKIPPER_EMAIL} (prefix ${agentKey.slice(0, 8)})`);

  // 2. Enable the portal + point default project at "Fix the Radio".
  //    Resolve the project uuid via the admin projects listing first.
  let defaultProjectId = null;
  {
    const list = await hd('GET', '/helpdesk/admin/projects', {
      agentKey,
      orgSlug: ORG_SLUG,
    });
    if (list.ok && Array.isArray(list.data?.data)) {
      defaultProjectId =
        list.data.data.find((p) => p.slug === DEFAULT_PROJECT_SLUG)?.id ??
        list.data.data[0]?.id ??
        null;
    } else {
      console.log(`  (warn) could not list admin projects: ${list.status} ${JSON.stringify(list.data)}`);
    }
  }

  const settingsBody = {
    welcome_message:
      "Aloha! You've reached Gilligan Travel, Ltd. support. Tell us what broke (be honest about whether Gilligan touched it) and we'll get a castaway on it.",
    categories: ['Equipment', 'Facilities', 'Provisions', 'Events', 'Rescue', 'Other'],
    require_email_verification: false,
    ...(defaultProjectId ? { default_project_id: defaultProjectId } : {}),
  };
  const settingsRes = await hd('PATCH', '/helpdesk/settings', {
    body: settingsBody,
    agentKey,
    orgSlug: ORG_SLUG,
  });
  if (!settingsRes.ok) {
    throw new Error(
      `Failed to configure helpdesk settings: ${settingsRes.status} ${JSON.stringify(settingsRes.data)}`,
    );
  }
  console.log(
    `helpdesk portal enabled for ${ORG_SLUG}` +
      (defaultProjectId ? ` (default project: ${DEFAULT_PROJECT_SLUG})` : ' (no default project resolved)'),
  );

  // 3. Register/login customers, capturing session + csrf cookies.
  const sessions = {}; // email -> { jar, csrf, display_name }
  for (const c of CUSTOMERS) {
    const jar = {};
    let csrf = null;

    const reg = await hd('POST', '/helpdesk/auth/register', {
      body: { email: c.email, display_name: c.display_name, password: CUSTOMER_PASSWORD },
      orgSlug: ORG_SLUG,
    });
    if (reg.ok) {
      // Register already sets helpdesk_session + csrf_token cookies; use them
      // directly and DON'T also call login (register is 3/15min/IP and login
      // is 5/15min/IP — burning both per customer exhausts the limiter on a
      // 3-customer run).
      collectCookies(reg.res, jar);
      csrf = jar.csrf_token ?? null;
      console.log(`  + customer registered: ${c.display_name} <${c.email}>`);
    } else {
      // Either already exists (409) or register was rate-limited (429) on a
      // re-run. Fall back to login to obtain a fresh session + csrf.
      if (reg.status === 409) {
        console.log(`  = customer exists: ${c.display_name} <${c.email}> (logging in)`);
      } else {
        console.log(`  (note) register ${reg.status} for ${c.email}; logging in instead`);
      }
      const login = await hd('POST', '/helpdesk/auth/login', {
        body: { email: c.email, password: CUSTOMER_PASSWORD },
        orgSlug: ORG_SLUG,
      });
      if (login.ok) {
        collectCookies(login.res, jar);
        csrf = jar.csrf_token ?? csrf;
      } else {
        console.log(`  (warn) login failed for ${c.email}: ${login.status} ${JSON.stringify(login.data)}`);
      }
    }

    sessions[c.email] = { jar, csrf, display_name: c.display_name };
  }

  // 4. File tickets + conversations + status walks.
  let created = 0;
  let dedup = 0;
  let agentReplies = 0;
  let statusWalks = 0;

  for (const t of TICKETS) {
    const sess = sessions[t.by];
    if (!sess || !sess.csrf) {
      console.log(`  (skip) no session for ${t.by}; cannot file "${t.subject}"`);
      continue;
    }

    const create = await hd('POST', '/helpdesk/tickets', {
      body: {
        subject: t.subject,
        description: t.description,
        category: t.category,
        priority: t.priority,
      },
      jar: sess.jar,
      csrf: sess.csrf,
      orgSlug: ORG_SLUG,
    });
    if (!create.ok) {
      console.log(`  (warn) ticket create failed "${t.subject}": ${create.status} ${JSON.stringify(create.data)}`);
      continue;
    }
    const ticketId = create.data?.data?.id;
    const wasDedup = create.data?.deduplicated === true;
    if (!ticketId) {
      console.log(`  (warn) ticket create returned no id "${t.subject}": ${JSON.stringify(create.data)}`);
      continue;
    }
    if (wasDedup) {
      dedup++;
      console.log(`  = ticket exists: "${t.subject}" (${ticketId})`);
      // Already seeded on a prior run; leave its conversation/status alone.
      continue;
    }
    created++;
    console.log(`  + ticket: "${t.subject}" (#${create.data?.data?.ticket_number ?? '?'})`);

    // Customer follow-ups (cookie + csrf).
    for (const fu of t.followups ?? []) {
      const r = await hd('POST', `/helpdesk/tickets/${ticketId}/messages`, {
        body: { body: fu },
        jar: sess.jar,
        csrf: sess.csrf,
        orgSlug: ORG_SLUG,
      });
      if (!r.ok) {
        console.log(`    (warn) customer follow-up failed: ${r.status} ${JSON.stringify(r.data)}`);
      }
    }

    // Agent reply (hdag_ key). When authed by an agent key alone, the route
    // requires an explicit author_id that belongs to the ticket's org — we
    // pass the Skipper's Bam user id.
    if (t.agent) {
      const r = await hd('POST', `/helpdesk/agents/tickets/${ticketId}/messages`, {
        body: {
          body: t.agent,
          is_internal: false,
          author_id: SKIPPER_USER_ID,
          author_name: 'Skipper (Support)',
        },
        agentKey,
        orgSlug: ORG_SLUG,
      });
      if (r.ok) {
        agentReplies++;
      } else {
        console.log(`    (warn) agent reply failed: ${r.status} ${JSON.stringify(r.data)}`);
      }
    }

    // Walk to the target status via the agent PATCH route.
    if (t.status && t.status !== 'open') {
      const r = await hd('PATCH', `/helpdesk/agents/tickets/${ticketId}`, {
        body: { status: t.status },
        agentKey,
        orgSlug: ORG_SLUG,
      });
      if (r.ok) {
        statusWalks++;
      } else {
        console.log(`    (warn) status walk to ${t.status} failed: ${r.status} ${JSON.stringify(r.data)}`);
      }
    }
  }

  console.log('');
  console.log(
    `Gilligan helpdesk seed done: customers=${CUSTOMERS.length}, ` +
      `tickets created=${created} (deduped=${dedup}), ` +
      `agent replies=${agentReplies}, status transitions=${statusWalks}`,
  );
  console.log(`Portal: /helpdesk/${ORG_SLUG}/`);
  console.log(`Customer creds: ${CUSTOMERS.map((c) => c.email).join(', ')} / ${CUSTOMER_PASSWORD}`);
})().catch((e) => {
  console.error('seed failed:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
