/**
 * Gilligan's Island themed Brief (collaborative docs) seed.
 *
 * The castaways draft their rescue plans, the Professor's engineering notes,
 * the Howell luau run-of-show, and the daily island ops log in Brief.
 * Idempotent: a document is skipped (no re-create, no re-write) if one with
 * the same title already exists in the org.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/brief.mjs
 * (api container can reach the internal brief-api host; cast API keys
 *  authenticate via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 *
 * brief-api routes are mounted under /v1, so the base includes /v1.
 */

const BASE = 'http://brief-api:4005/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (informational — Bearer auth derives the author from the key).
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
  if (!KEYS[who]) throw new Error(`No API key for cast member "${who}" in GKEYS`);
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}

async function api(who, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
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
  return data && typeof data === 'object' && 'data' in data ? data.data : data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// ── Documents ──────────────────────────────────────────────────────────────
// status: 'approved' = published; 'in_review' = under review; 'draft' = draft.
// `body` is the multi-section Markdown that becomes the document content.
// `comments`: optional in-character anchored comments (authored by `who`).
const DOCS = [
  {
    title: 'Operation Coconut: Master Rescue Plan',
    author: 'skipper',
    status: 'approved',
    visibility: 'organization',
    icon: '🥥',
    summary: 'The Skipper’s standing plan to get all seven of us off this rock. Little buddy, READ THIS.',
    body: `# Operation Coconut: Master Rescue Plan

**Commanding Officer:** The Skipper
**Status:** ACTIVE — review weekly, or whenever Gilligan breaks something.

## Mission

Get all seven castaways (and, if there is room, Mr. Howell’s steamer trunks)
off this island and back to Honolulu, alive and preferably dry.

## Standing Objectives

1. **Be seen.** Maintain a signal fire and a beach signal at all times.
2. **Be heard.** Keep the radio receiving; transmit on schedule.
3. **Be ready.** A seaworthy raft, provisioned, on the beach within one hour of any sighting.

## Workstreams

| Workstream | Lead | Backup |
| --- | --- | --- |
| Signal fire & beach signal | Skipper | Gilligan |
| Radio & comms | Professor | Mary Ann |
| Raft & sea trials | Skipper | Professor |
| Provisions & water | Mary Ann | Lovey |
| Diplomacy with passing vessels | Mr. Howell | Ginger |

## Rules of Engagement

- **Rule 1.** Nobody — *nobody* — lets Gilligan near the steering oar during an actual rescue.
- **Rule 2.** If a plane is spotted, drop everything and light the fire. The luau can wait.
- **Rule 3.** If the Professor says “it’s only theoretical,” add three days to the estimate.

## Lessons Learned (the hard way)

- The hot-air balloon: lovely until Gilligan sat on it.
- The submarine made of crates: watertight is a high bar, it turns out.
- The carrier pigeon: ate the message, flew inland.

> “Now I know we can do this, little buddy. We just have to do it *without* the last fourteen things that went wrong.” — Skipper`,
    comments: [
      { who: 'gilligan', anchor: 'Rule 1', body: 'Aw, Skipper, that one time wasn’t MY fault. The oar was slippery!' },
      { who: 'professor', anchor: 'add three days to the estimate', body: 'I resent that, and yet the data supports it.' },
    ],
  },

  {
    title: 'Raft v3 — Engineering Spec (Professor)',
    author: 'professor',
    status: 'in_review',
    visibility: 'organization',
    icon: '🛟',
    summary: 'Third-generation bamboo raft. Addresses the v2 lashing failure and the v1 “it sank” incident.',
    body: `# Raft v3 — Engineering Specification

**Author:** The Professor
**Revision:** 3.0 (supersedes v2, which delaminated; and v1, which we do not discuss)
**Status:** In review — awaiting the Skipper’s sign-off on sea trials.

## 1. Design Goals

- Displacement sufficient for **seven adults** plus 60 kg of coconuts and water.
- Survive a Force 4 sea state without the lashings letting go (the v2 failure mode).
- Buildable entirely from on-island materials. No, Mr. Howell, we cannot order fiberglass.

## 2. Materials

| Component | Material | Quantity |
| --- | --- | --- |
| Hull pontoons | Cured giant bamboo, ≥6 cm diameter | 40 lengths |
| Lashings | Twisted hibiscus & vine cordage | ~300 m |
| Deck | Split bamboo matting | 12 m² |
| Mast | Single straight palm trunk | 1 |
| Sail | Howell spare linen (see Ginger) | 1 |

## 3. The Lashing Problem

The v2 raft failed because the vine cordage **lost ~40% tensile strength when wet**.
v3 mitigations:

1. Pre-soak and cure all cordage so it fails *before* assembly, not at sea.
2. Double-lash every load-bearing joint in a square-lashing pattern.
3. **Tensile test every batch** against a swinging-coconut rig before it touches the raft.

## 4. Stability Math

Two-pontoon catamaran layout, beam 3.2 m, gives a metacentric height that
keeps us upright even when Gilligan stands up to point at things. Probably.

## 5. Open Questions

- Can we waterproof the deck seams with breadfruit sap? (Experiment pending.)
- Howell wants a “small lounge area.” This is denied on weight grounds.

## 6. Sign-off Checklist

- [ ] Cordage batch passes tensile test
- [ ] All joints double-lashed
- [ ] Lagoon float test (no load)
- [ ] Lagoon sea trial (full load, calm water)
- [ ] Skipper sign-off`,
    comments: [
      { who: 'howell', anchor: 'This is denied on weight grounds.', body: 'A modest lounge, Professor! Lovey simply cannot rough it on a bare deck.' },
      { who: 'skipper', anchor: 'Skipper sign-off', body: 'Tensile test first. Then we talk sea trial. No shortcuts this time.' },
    ],
  },

  {
    title: 'Signal Fire Standard Operating Procedure',
    author: 'skipper',
    status: 'approved',
    visibility: 'organization',
    icon: '🔥',
    summary: 'How we build, light, and feed the Lookout Point signal fire. Memorize this.',
    body: `# Signal Fire — Standard Operating Procedure

**Owner:** The Skipper
**Location:** Lookout Point (highest accessible ground, clear sightline to the shipping lane)

## Purpose

A signal fire that produces a tall, dark smoke column by day and a bright beacon
by night, ready to flare up within **60 seconds** of a sighting.

## Standing Configuration

- A **base lay** of dry driftwood, always kept ready and covered from rain.
- A **smoke pile** of green palm fronds beside the base, *not yet on the fire*.
- A **night cache** of dry tinder and a banked ember, watched on rotation.

## Lighting Procedure

1. Confirm the sighting (two pairs of eyes — not just Gilligan’s).
2. Open the ember, add tinder, bring the base lay to full flame.
3. **Then** pile on green fronds for the smoke column. Order matters: fronds first means a wet, smoky fizzle.
4. One person stays to feed it; everyone else runs the beach signal and the raft.

## Watch Rules

- The fire is **never** left wholly unattended in daylight.
- Whoever is on watch keeps the smoke pile dry and the base lay stocked.
- Report fuel below half a day’s supply to the Skipper immediately.

## Known Failure Modes

- **Fronds first** — smothers the flame. (See: every one of Gilligan’s first attempts.)
- **Wet base lay** — keep it covered. A monsoon-soaked pile is a decoration, not a signal.
- **Eating the marshmallows meant for morale** — looking at you, little buddy.`,
    comments: [
      { who: 'maryann', anchor: 'eating the marshmallows meant for morale', body: 'I counted them this morning, Gilligan. I KNOW it was you.' },
    ],
  },

  {
    title: 'Castaway Roles & Watch Rotation',
    author: 'maryann',
    status: 'approved',
    visibility: 'organization',
    icon: '🗓️',
    summary: 'Who does what, and who is on watch when. Updated whenever someone trades a shift for extra coconut cream pie.',
    body: `# Castaway Roles & Watch Rotation

**Keeper of the Schedule:** Mary Ann

## Roles

| Castaway | Primary Role | Notes |
| --- | --- | --- |
| The Skipper | Operations & command | Final say on rescue; can out-shout a storm |
| The Professor | Engineering & science | Can build anything except a working boat that leaves |
| Gilligan | First mate & general labor | Enthusiastic; supervise closely |
| Mary Ann | Provisions, cooking, schedule | Runs the kitchen and this very document |
| Ginger | Morale, costuming, diplomacy | Handles guests and the hula floor show |
| Mr. Howell | Finance & external relations | Funds expeditions; negotiates with yachts |
| Lovey Howell | Hospitality & quality control | Approves all social events |

## Daily Watch Rotation

| Slot | Time | Lookout | Fire Tender |
| --- | --- | --- | --- |
| Dawn | 06:00–10:00 | Skipper | Gilligan |
| Midday | 10:00–14:00 | Professor | Mary Ann |
| Afternoon | 14:00–18:00 | Ginger | Gilligan |
| Dusk | 18:00–22:00 | Mary Ann | Skipper |
| Night | 22:00–06:00 | Rotating pair | Banked ember only |

## Shift-Trade Policy

- Trades must be logged here (or told to Mary Ann, who will log them).
- The Howells may **commission** a substitute. Mr. Howell pays in promises; everyone else in pie.
- Gilligan may not take two consecutive solo night watches. We learned why.`,
    comments: [
      { who: 'ginger', anchor: 'Handles guests and the hula floor show', body: 'And I’ll need at least one rehearsal slot blocked off, darling. Art takes time.' },
    ],
  },

  {
    title: 'Howell Luau — Run of Show',
    author: 'lovey',
    status: 'approved',
    visibility: 'organization',
    icon: '🌺',
    summary: 'Minute-by-minute program for the Howell Luau. Thurston is funding it; I am approving every detail.',
    body: `# The Howell Luau — Run of Show

**Host:** Mrs. Thurston Howell III (“Lovey”)
**Underwriter:** Mr. Thurston Howell III
**Venue:** The Lagoon, dressed.

## Guest List

All seven of us. (It is a small island, dear.) Place cards by Mr. Howell.

## Program

| Time | Item | Lead |
| --- | --- | --- |
| 17:30 | Guests received; leis presented | Mary Ann |
| 17:45 | Mr. Howell’s welcoming remarks | Mr. Howell |
| 18:00 | Cocktails (the Howell Punch, non-alcoholic, alas) | Lovey |
| 18:30 | Dinner — roast pig & coconut cream pie | Mary Ann |
| 19:15 | The Hula Floor Show | Ginger |
| 19:45 | Toasts & a few words of gratitude | The Skipper |
| 20:00 | Dancing under the tiki torches | All |
| 21:00 | A discreet conclusion | Lovey |

## Standards & Requirements

- Tiki torches lit and **safely spaced** — we are not burning down the only catering tent.
- The roast pig is the **centerpiece**. Gilligan is to be seated as far from it as the lagoon allows.
- Linens pressed. Yes, on an island. Standards do not take a vacation.

## Contingencies

- **Rain:** relocate to the Howell hut; reduce guest list to seven (already done).
- **Rescue ship sighted mid-event:** the luau is suspended. Even Lovey agrees a ship outranks a canapé.`,
    comments: [
      { who: 'gilligan', anchor: 'seated as far from it as the lagoon allows', body: 'I said I was sorry about last time!' },
      { who: 'lovey', anchor: 'a ship outranks a canapé', body: 'Though we WILL bring the punch aboard. Waste not.' },
    ],
  },

  {
    title: 'Coconut-Powered Radio — Build & Operating Notes',
    author: 'professor',
    status: 'in_review',
    visibility: 'organization',
    icon: '📻',
    summary: 'Receiver rebuilt from the Minnow’s salvage; transmitter is the hard part. Bicycle-generator powered.',
    body: `# Coconut-Powered Radio — Build & Operating Notes

**Author:** The Professor
**Status:** In review — receiver works; transmitter range still unproven.

## Power

A bicycle generator (Gilligan pedals) charges a salvaged battery bank.
Sustained output requires **sustained pedaling**, which is the project’s true bottleneck.

> Engineering reality: the limiting component is not the circuit. It is Gilligan’s legs.

## Receiver

Rebuilt from the Minnow’s salvaged set. We reliably receive the **Honolulu weather
broadcast**; Mary Ann logs the schedule. Reception is best at dusk.

## Transmitter (the hard part)

- Longwire antenna strung between the two tallest palms (Skipper rigged it).
- Output power is marginal. We may be transmitting into the void.
- **Test plan:** broadcast the distress message on the hour, every hour, during the
  evening propagation window, and listen for any acknowledgement.

## Operating Schedule

| Activity | When |
| --- | --- |
| Weather receive | 06:00, 18:00 |
| Distress transmit | Top of every evening hour |
| Battery charge (pedal) | Continuous while anyone has legs left |

## Risks

- Salt corrosion on every contact — clean weekly.
- Gilligan “helping” by rewiring things. Lock the panel.`,
    comments: [
      { who: 'gilligan', anchor: 'It is Gilligan’s legs.', body: 'I pedaled for THREE HOURS, Professor. My legs are a national resource.' },
    ],
  },

  {
    title: 'Distress Message Drafts',
    author: 'professor',
    status: 'draft',
    visibility: 'organization',
    icon: '🆘',
    summary: 'Candidate distress broadcasts. Keep each under 30 seconds; lead with position.',
    body: `# Distress Message Drafts

**Author:** The Professor (with unsolicited edits from everyone)
**Status:** Draft — pick one, please. We have been arguing for a week.

## Constraints

- Under **30 seconds** spoken at a calm pace.
- Lead with **who and where**, then the ask.
- No editorializing. (This rules out Mr. Howell’s draft entirely.)

## Draft A — The Professor (clinical)

> “Mayday, mayday. Seven survivors of the charter vessel *Minnow*, marooned on an
> uncharted island, approximate position east of the shipping lane. All persons well.
> Request rescue. Repeating.”

## Draft B — The Skipper (direct)

> “This is the Skipper of the *Minnow*. Seven souls, one island, no boat that floats.
> Come get us. We’ll have the coffee on.”

## Draft C — Mr. Howell (rejected)

> “To whom it may concern: a gentleman of considerable means requires immediate
> extraction, along with his wife, his staff, and three steamer trunks. Generous
> reward. Discretion appreciated.”

## Draft D — Ginger (for radio drama)

> “(breathlessly) Is anyone out there...? Seven of us... so very far from home...”

## Decision Log

- Draft C rejected: thirty seconds is not enough time to itemize the trunks.
- Draft D tabled: “too theatrical for a Mayday,” per the Skipper.
- Leaning toward **A** with the Skipper’s coffee line appended for morale.`,
    comments: [
      { who: 'ginger', anchor: 'too theatrical for a Mayday', body: 'There is no such thing as too theatrical, Skipper. But fine.' },
      { who: 'howell', anchor: 'thirty seconds is not enough time to itemize the trunks', body: 'Then we shall purchase MORE seconds. Surely that is how radio works.' },
    ],
  },

  {
    title: 'Daily Island Ops Log',
    author: 'gilligan',
    status: 'approved',
    visibility: 'organization',
    icon: '📝',
    summary: 'Running log of what happened each day on the island. Mostly accurate. Gilligan keeps it.',
    body: `# Daily Island Ops Log

**Logkeeper:** Gilligan (with corrections from Mary Ann)

> Note: entries are in Gilligan’s words. Mary Ann adds the parts he forgets.

## Day 73

- Pedaled the radio for three hours. Legs hurt. Professor says good job.
- Saw a ship! ...It was a cloud. Sorry, Skipper.
- Mary Ann made coconut cream pie. I watched it the whole time so it stayed safe.

## Day 74

- Helped the Professor with the raft. Held the wrong end of the bamboo for a while.
- Signal fire relit (I put the fronds on first again — won’t happen tomorrow).
- Mr. Howell tried to hire me as a butler. I already have a job (first mate).

## Day 75

- BIG DAY: heard a voice on the radio! ...It was the Honolulu weather man. Still counts.
- Fixed the footbridge. Mostly. Watch the third plank.
- Ginger rehearsed the hula. I am told I am “not ready for the floor show.”

## Day 76

- Quiet day. Wove vine rope. Skipper says it’s “actually pretty good, little buddy.”
- Counted the message bottles: 100. Tide-released 12.
- No clouds mistaken for ships today. Progress!

## Standing To-Do

- Stop putting the fronds on first.
- Don’t eat the centerpiece at the luau.
- Pedal more.`,
    comments: [
      { who: 'maryann', anchor: 'It was a cloud.', body: 'Day 73 correction: it was, in fact, a cloud. A very ship-shaped cloud. We forgive you.' },
      { who: 'skipper', anchor: 'actually pretty good, little buddy', body: 'Credit where it’s due. That rope held in the tensile test.' },
    ],
  },

  {
    title: 'Coconut Engineering — Field Notes',
    author: 'professor',
    status: 'approved',
    visibility: 'organization',
    icon: '🥥',
    summary: 'A catalog of everything we’ve made (or tried to make) out of coconuts. The island’s only renewable industrial base.',
    body: `# Coconut Engineering — Field Notes

**Author:** The Professor
**Premise:** The coconut is our steel, our glass, and our battery casing. Treat it with respect.

## Proven Builds

| Item | Coconut Role | Status |
| --- | --- | --- |
| Water cups & bowls | Shell, halved | Reliable |
| Charcoal filter | Burned husk | Works; replace weekly |
| Signal mirror array | Polished inner shell | Marginal; needs sun |
| Battery insulators | Dried husk fiber | Good |
| Buttons & fasteners | Carved shell | Lovey-approved |

## Experimental

- **Coconut-fiber rope** — weaker than vine but salt-tolerant. Blend the two.
- **Coconut-shell radio knobs** — purely cosmetic, but morale-positive.
- **The “coconut telephone”** — does NOT work. Two shells and a string is not telephony, Gilligan.

## Rules of Coconut Use

1. Drinking coconuts before building coconuts. Hydration first.
2. Mary Ann has first claim on any coconut destined for pie.
3. Label experimental shells. We lost a week to an unlabeled “battery” that was lunch.

## Backlog

- Test breadfruit sap as a waterproof sealant (cross-ref: Raft v3 deck seams).
- Quantify the mirror array’s effective signaling range at noon.`,
    comments: [
      { who: 'gilligan', anchor: 'Two shells and a string is not telephony', body: 'But I HEARD you, Professor! ...Oh. You were standing right there.' },
    ],
  },
];

// Resolve a comment’s parent document and post it, anchored to a snippet.
async function postComment(docId, c) {
  const body = { body: c.body };
  if (c.anchor) body.anchor_text = c.anchor.slice(0, 1000);
  return api(c.who, 'POST', `/documents/${docId}/comments`, body);
}

(async () => {
  let created = 0;
  let skipped = 0;
  let commentsMade = 0;
  const failures = [];

  // Pull the existing org-wide document list once (any cast member sees the
  // org’s organization-visible docs) for the idempotency check.
  let existing = [];
  try {
    existing = asArr(await api('skipper', 'GET', '/documents?limit=100'));
  } catch (e) {
    console.log(`warning: could not pre-list documents (${e.message}); proceeding without dedupe`);
  }
  const byTitle = new Map(existing.map((d) => [String(d.title || '').toLowerCase(), d]));

  for (const doc of DOCS) {
    const key = doc.title.toLowerCase();
    if (byTitle.has(key)) {
      console.log(`exists, skipping: "${doc.title}"`);
      skipped++;
      continue;
    }

    try {
      // 1. Create the document (metadata only; content set separately).
      const createBody = {
        title: doc.title,
        visibility: doc.visibility || 'organization',
      };
      if (doc.summary) createBody.summary = doc.summary;
      if (doc.icon) createBody.icon = doc.icon;
      const made = await api(doc.author, 'POST', '/documents', createBody);
      const docId = made.id;
      console.log(`created: "${doc.title}" (${docId}) by ${doc.author}`);

      // 2. Populate the rich Markdown body via the content-replace flow.
      await api(doc.author, 'PUT', `/documents/${docId}/content`, { content: doc.body });

      // 3. Set status (draft -> in_review/approved) when not the default draft.
      if (doc.status && doc.status !== 'draft') {
        await api(doc.author, 'PATCH', `/documents/${docId}`, { status: doc.status });
      }

      // 4. In-character comments, anchored to a snippet of the body.
      for (const c of doc.comments || []) {
        try {
          await postComment(docId, c);
          commentsMade++;
        } catch (e) {
          failures.push(`comment on "${doc.title}" by ${c.who}: ${e.message}`);
          console.log(`  comment failed (${c.who}): ${e.message}`);
        }
      }

      created++;
      byTitle.set(key, made);
    } catch (e) {
      failures.push(`doc "${doc.title}": ${e.message}`);
      console.log(`FAILED: "${doc.title}" — ${e.message}`);
    }
  }

  console.log(
    `\nBrief seed done: ${created} created, ${skipped} skipped (already present), ${commentsMade} comments.`,
  );
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log(`  - ${f}`);
  }
})().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
