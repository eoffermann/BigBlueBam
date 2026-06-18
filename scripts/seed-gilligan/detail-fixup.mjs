/**
 * Gilligan's Island themed "detail-page fixup" seed — three small fills that
 * the original per-app seeders left blank on the DETAIL pages:
 *
 *   TASK 1 (Bond):  Company- and contact-scoped activity timelines were empty.
 *                   The original bond.mjs logged activities on DEALS only, so
 *                   the company-detail and contact-detail pages (which scope
 *                   the timeline to company_id / contact_id) showed nothing.
 *                   Here we log a handful of in-character call/note/meeting/
 *                   email activities directly against a company AND against a
 *                   couple of contacts.
 *
 *   TASK 2 (Brief): No starred/favorite documents existed, so the "Starred"
 *                   shelf was empty. We star 2-3 of the 9 seeded briefs.
 *
 *   TASK 3 (Board): No saved versions existed, so a board's Version History
 *                   read "No versions saved". We save 1-2 named snapshots of a
 *                   board so the history view is populated.
 *
 * Idempotent where practical:
 *   - Bond activities are matched by (scope, subject) — re-running skips any
 *     activity whose subject already exists on that company/contact.
 *   - Brief stars are toggle-semantics + per-user, so we first read the user's
 *     starred list and only POST /star when the doc is not already starred.
 *   - Board versions are NOT naturally idempotent (each POST makes a new
 *     snapshot), so we skip creating a version whose exact name already exists
 *     in the board's version list.
 *
 * Run from the repo host (inside the api container, which can reach all the
 * internal app hosts):
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/detail-fixup.mjs
 *
 * Auth: cast read_write API keys via Bearer (bypasses CSRF, scopes to the
 * Gilligan org). Same transport the bond/brief/board seeders already prove.
 */

const BOND = 'http://bond-api:4009/v1';
const BRIEF = 'http://brief-api:4005/v1';
const BOARD = 'http://board-api:4008/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (kept in sync with scripts/seed-gilligan/bam.mjs CAST map).
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
// Generic REST helper (one per base; same Bearer pattern everywhere)
// ---------------------------------------------------------------------------

function H(who) {
  if (!KEYS[who]) throw new Error(`No API key for cast member "${who}" in GKEYS`);
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}

function makeApi(base) {
  return async function api(who, method, path, body) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: H(who),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!r.ok) {
      throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  };
}

const bond = makeApi(BOND);
const brief = makeApi(BRIEF);
const board = makeApi(BOARD);

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));
const unwrap = (v) => (v && typeof v === 'object' && 'data' in v ? v.data : v);

// ===========================================================================
// TASK 1 — BOND: company- and contact-scoped activity timelines
// ===========================================================================

// Activities to log against the COMPANY (company-detail timeline). Matched by
// subject within that company's activity list for idempotency.
const COMPANY_NAME = 'Howell Industries (Island Office)';
const COMPANY_ACTIVITIES = [
  {
    who: 'howell',
    type: 'meeting',
    subject: 'Quarterly board meeting — held under the big palm',
    body: 'Convened the Howell Industries (Island Office) board: myself, Lovey, and a coconut I have appointed treasurer. Resolved to keep funding the rescue AND the luau. Motion carried unanimously (the coconut abstained).',
  },
  {
    who: 'lovey',
    type: 'note',
    subject: 'Office decor standards memo',
    body: 'The Island Office will maintain Howell standards: fresh hibiscus daily, no sand on the "good" log, and the bamboo filing cabinet is to be dusted. We are marooned, Thurston, not savages.',
  },
  {
    who: 'howell',
    type: 'call',
    subject: 'Conference call with the mainland holdings (static only)',
    body: 'Attempted to call the New York office on the Professor\'s coconut radio. Reached three minutes of static and a passing seagull. Instructed the seagull to sell my railroad stock. It declined.',
  },
  {
    who: 'lovey',
    type: 'email_sent',
    subject: 'Dispatched the annual shareholder letter (by bottle)',
    body: 'Sealed this year\'s shareholder letter in a magnum bottle and entrusted it to the tide. Estimated delivery: the next ice age. Tone: confident, as always. We do not disclose the raft situation to shareholders.',
  },
];

// Activities to log against CONTACTS (contact-detail timeline). `email`
// resolves the contact; matched by subject within that contact's list.
const CONTACT_ACTIVITIES = [
  {
    email: 'b.quibble@howell-industries.example.com', // Bartholomew Quibble, Esq. — Howell family counsel
    items: [
      {
        who: 'lovey',
        type: 'call',
        subject: 'Reviewed the estate paperwork with counsel',
        body: 'Bartholomew confirmed the Howell estate can underwrite the luau, the salvage tug, AND a modest island annex. He advised against naming the coconut as treasurer "for tax reasons." We are reconsidering.',
      },
      {
        who: 'howell',
        type: 'note',
        subject: 'Retainer renewed for another year',
        body: 'Quibble has agreed to remain on retainer despite being, like the rest of us, unable to leave the island. Loyalty like that is priceless. (His invoice disagrees.)',
      },
      {
        who: 'lovey',
        type: 'meeting',
        subject: 'Sand-table meeting re: the place cards',
        body: 'Met with counsel to confirm there is no legal impediment to seating Gilligan at the far end of the luau table. Counsel found it "prudent." Filed under risk management.',
      },
    ],
  },
  {
    email: 'l.pomare@kona-coconut.example.com', // Leilani Pomare — Kona Coconut Exporters procurement
    items: [
      {
        who: 'maryann',
        type: 'email_sent',
        subject: 'Sent the coconut-cream-pie grading sheet',
        body: 'Forwarded Leilani my grading rubric: Grade A pies have a flake-to-filling ratio that would make a pastry chef weep. She replied "stop, I am hungry." We may have a customer for life.',
      },
      {
        who: 'maryann',
        type: 'call',
        subject: 'Negotiated freight terms (the awkward part)',
        body: 'Talked through shipping with Leilani. The only carrier off the island is the same ship that keeps NOT rescuing us, so freight is, generously, "pending." She laughed. I did not.',
      },
      {
        who: 'professor',
        type: 'note',
        subject: 'Quality-control protocol for export coconuts',
        body: 'Drafted a husk-moisture spec so Leilani\'s buyers get consistent product. Mary Ann insists on tasting every tenth coconut. As a scientist I cannot fault the methodology.',
      },
    ],
  },
];

async function seedBondActivities(report, fails) {
  // Resolve the company by name (Howell underwrites it, so use his key).
  let companyId = null;
  try {
    const list = asArr(await bond('howell', 'GET', `/companies?search=${encodeURIComponent(COMPANY_NAME)}&limit=100`));
    const match = list.find((x) => x.name === COMPANY_NAME);
    if (match) companyId = match.id;
  } catch (e) {
    fails.push(`bond list companies: ${e.message}`);
  }

  if (companyId) {
    // Pre-list existing company-scoped activities for idempotency (by subject).
    let existingSubjects = new Set();
    try {
      const existing = asArr(await bond('howell', 'GET', `/activities?company_id=${companyId}&limit=100`));
      existingSubjects = new Set(existing.map((a) => String(a.subject || '')));
    } catch (e) {
      fails.push(`bond list company activities: ${e.message}`);
    }
    let made = 0, skipped = 0;
    for (const a of COMPANY_ACTIVITIES) {
      if (existingSubjects.has(a.subject)) { skipped++; continue; }
      try {
        await bond(a.who, 'POST', '/activities', {
          company_id: companyId,
          activity_type: a.type,
          subject: a.subject,
          body: a.body,
        });
        made++;
        existingSubjects.add(a.subject);
      } catch (e) {
        fails.push(`bond company activity "${a.subject}": ${e.message}`);
      }
    }
    report.companyActivities = { company: COMPANY_NAME, id: companyId, made, skipped };
    console.log(`bond: company "${COMPANY_NAME}" (${companyId}) — +${made} activities, ${skipped} already present`);
  } else {
    fails.push(`bond: company "${COMPANY_NAME}" not found — cannot log company activities`);
    console.log(`bond: company "${COMPANY_NAME}" NOT FOUND`);
  }

  // Contacts.
  report.contactActivities = [];
  for (const ca of CONTACT_ACTIVITIES) {
    const ownerKey = ca.items[0]?.who || 'howell';
    let contactId = null;
    try {
      const found = asArr(await bond(ownerKey, 'GET', `/contacts?search=${encodeURIComponent(ca.email)}&limit=100`));
      const match = found.find((x) => (x.email || '').toLowerCase() === ca.email.toLowerCase());
      if (match) contactId = match.id;
    } catch (e) {
      fails.push(`bond list contacts (${ca.email}): ${e.message}`);
    }

    if (!contactId) {
      fails.push(`bond: contact "${ca.email}" not found — skipped`);
      console.log(`bond: contact "${ca.email}" NOT FOUND`);
      continue;
    }

    let existingSubjects = new Set();
    try {
      const existing = asArr(await bond(ownerKey, 'GET', `/activities?contact_id=${contactId}&limit=100`));
      existingSubjects = new Set(existing.map((a) => String(a.subject || '')));
    } catch (e) {
      fails.push(`bond list contact activities (${ca.email}): ${e.message}`);
    }
    let made = 0, skipped = 0;
    for (const a of ca.items) {
      if (existingSubjects.has(a.subject)) { skipped++; continue; }
      try {
        await bond(a.who, 'POST', '/activities', {
          contact_id: contactId,
          activity_type: a.type,
          subject: a.subject,
          body: a.body,
        });
        made++;
        existingSubjects.add(a.subject);
      } catch (e) {
        fails.push(`bond contact activity "${a.subject}" (${ca.email}): ${e.message}`);
      }
    }
    report.contactActivities.push({ email: ca.email, id: contactId, made, skipped });
    console.log(`bond: contact "${ca.email}" (${contactId}) — +${made} activities, ${skipped} already present`);
  }
}

// ===========================================================================
// TASK 2 — BRIEF: star a few documents
// ===========================================================================

// Each entry: the document title + the cast member who stars it (star is
// per-user; we star as a thematically-apt owner so it shows on their shelf).
const STAR_DOCS = [
  { title: 'Operation Coconut: Master Rescue Plan', who: 'skipper' },
  { title: 'Howell Luau — Run of Show', who: 'lovey' },
  { title: 'Raft v3 — Engineering Spec (Professor)', who: 'professor' },
];

async function seedBriefStars(report, fails) {
  report.starred = [];
  // List the org's documents once (any cast member sees org-visible docs).
  let docs = [];
  try {
    docs = asArr(await brief('skipper', 'GET', '/documents?limit=100'));
  } catch (e) {
    fails.push(`brief list documents: ${e.message}`);
    console.log(`brief: could not list documents — ${e.message}`);
    return;
  }
  const byTitle = new Map(docs.map((d) => [String(d.title || '').toLowerCase(), d]));

  for (const sd of STAR_DOCS) {
    const doc = byTitle.get(sd.title.toLowerCase());
    if (!doc) {
      fails.push(`brief: document "${sd.title}" not found — cannot star`);
      console.log(`brief: doc "${sd.title}" NOT FOUND`);
      continue;
    }

    // Idempotency: only toggle-on if this user has NOT already starred it.
    let alreadyStarred = false;
    try {
      const starred = asArr(await brief(sd.who, 'GET', '/documents/starred'));
      alreadyStarred = starred.some((d) => d.id === doc.id);
    } catch (e) {
      fails.push(`brief list starred (${sd.who}): ${e.message}`);
    }

    if (alreadyStarred) {
      report.starred.push({ title: sd.title, id: doc.id, who: sd.who, state: 'already starred' });
      console.log(`brief: "${sd.title}" already starred by ${sd.who} — skip`);
      continue;
    }

    try {
      // Pass an empty-object body: the route sets Content-Type: application/json
      // and Fastify rejects a truly empty body (FST_ERR_CTP_EMPTY_JSON_BODY).
      const res = unwrap(await brief(sd.who, 'POST', `/documents/${doc.id}/star`, {}));
      const state = res?.starred === true ? 'starred' : `toggled (starred=${res?.starred})`;
      report.starred.push({ title: sd.title, id: doc.id, who: sd.who, state });
      console.log(`brief: "${sd.title}" (${doc.id}) — ${state} by ${sd.who}`);
    } catch (e) {
      fails.push(`brief star "${sd.title}" (${sd.who}): ${e.message}`);
      console.log(`brief: star FAILED "${sd.title}" — ${e.message}`);
    }
  }
}

// ===========================================================================
// TASK 3 — BOARD: save named versions/snapshots of a board
// ===========================================================================

// Board name + its owner (versions require edit access; owner always has it)
// + the in-character snapshot names to save.
const VERSION_BOARD = { name: 'Howell Luau — Layout', owner: 'lovey' };
const VERSION_NAMES = ['Initial layout', 'After Lovey\'s notes'];

async function seedBoardVersions(report, fails) {
  report.versions = null;
  let b = null;
  try {
    const found = asArr(await board(VERSION_BOARD.owner, 'GET', `/boards?search=${encodeURIComponent(VERSION_BOARD.name)}&limit=50`));
    b = found.find((x) => x.name.toLowerCase() === VERSION_BOARD.name.toLowerCase());
  } catch (e) {
    fails.push(`board list "${VERSION_BOARD.name}": ${e.message}`);
  }

  if (!b) {
    fails.push(`board: "${VERSION_BOARD.name}" not found — cannot save versions`);
    console.log(`board: "${VERSION_BOARD.name}" NOT FOUND`);
    return;
  }

  // Pre-list existing versions for idempotency (skip exact-name duplicates).
  let existingNames = new Set();
  try {
    const versions = asArr(await board(VERSION_BOARD.owner, 'GET', `/boards/${b.id}/versions`));
    existingNames = new Set(versions.map((v) => String(v.name || '')));
  } catch (e) {
    fails.push(`board list versions "${VERSION_BOARD.name}": ${e.message}`);
  }

  let made = 0, skipped = 0;
  for (const name of VERSION_NAMES) {
    if (existingNames.has(name)) { skipped++; continue; }
    try {
      await board(VERSION_BOARD.owner, 'POST', `/boards/${b.id}/versions`, { name });
      made++;
      existingNames.add(name);
    } catch (e) {
      fails.push(`board version "${name}" on "${VERSION_BOARD.name}": ${e.message}`);
    }
  }
  report.versions = { board: VERSION_BOARD.name, id: b.id, made, skipped, names: VERSION_NAMES };
  console.log(`board: "${VERSION_BOARD.name}" (${b.id}) — +${made} versions, ${skipped} already present`);
}

// ===========================================================================
// Main
// ===========================================================================

(async () => {
  const report = {};
  const fails = [];

  console.log('=== TASK 1: Bond company/contact activities ===');
  await seedBondActivities(report, fails);

  console.log('\n=== TASK 2: Brief starred documents ===');
  await seedBriefStars(report, fails);

  console.log('\n=== TASK 3: Board saved versions ===');
  await seedBoardVersions(report, fails);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('DETAIL-FIXUP SUMMARY');
  console.log('========================================');

  if (report.companyActivities) {
    const c = report.companyActivities;
    console.log(`Bond company "${c.company}": +${c.made} activities (${c.skipped} kept)`);
  }
  for (const ct of report.contactActivities || []) {
    console.log(`Bond contact ${ct.email}: +${ct.made} activities (${ct.skipped} kept)`);
  }
  for (const s of report.starred || []) {
    console.log(`Brief star: "${s.title}" — ${s.state} (by ${s.who})`);
  }
  if (report.versions) {
    const v = report.versions;
    console.log(`Board "${v.board}": +${v.made} versions (${v.skipped} kept) [${v.names.join(', ')}]`);
  }

  if (fails.length) {
    console.log(`\n${fails.length} FAILURE(S):`);
    for (const f of fails) console.log(`  - ${f}`);
  } else {
    console.log('\nNo failures.');
  }
})().catch((e) => {
  console.error('detail-fixup seed failed:', e.message);
  process.exit(1);
});
