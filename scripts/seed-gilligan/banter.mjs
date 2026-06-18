/**
 * Gilligan's Island themed Banter (team chat) seed.
 *
 * The S.S. Minnow castaways run their rescue — and the Howells' social life —
 * on BigBlueBam Banter. Idempotent: skips a channel that already exists by
 * name, and skips posting into any channel that already has messages.
 *
 * Run from the repo host (the api container can reach the internal app hosts;
 * cast API keys authenticate via Bearer, which bypasses CSRF and scopes to the
 * Gilligan org — posting AS a cast key sets that member as the author, so the
 * messages show the right names rather than "E2E Test User"):
 *
 *   GKEYS=$(node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("scripts/.gilligan-keys.env","utf8").split("\n")){if(l&&!l.startsWith("#")&&l.includes("=")){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1).trim();}}process.stdout.write(JSON.stringify(o))')
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/banter.mjs
 */

// Banter API internal host + /v1 route prefix (confirmed: docker-compose.yml
// BANTER_API_URL=http://banter-api:4002, routes registered at '/v1/...').
const API = 'http://banter-api:4002';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids.
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
  gilligan: '0f47c55f-4c7d-4100-a00b-ca131a1e864d',
  maryann: 'd2835cc4-8ee9-4a27-b43e-84ab19a21450',
  ginger: 'c8926754-2a93-4bd6-bf20-5b1f87e27385',
  howell: '414d283d-f13b-4608-91db-dfd024db4064',
  lovey: '0ddd0b3e-4de3-4077-a905-07878dc43960',
};
const ALL = Object.values(CAST);

function H(who) {
  const tok = KEYS[who];
  if (!tok) throw new Error(`No API key for "${who}" in GKEYS`);
  return { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
}
async function api(who, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 240)}`);
  return data.data ?? data;
}
const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// ── Channel definitions + scripted conversations ──────────────────────────
// Each message: { who, text } — `who` is a CAST key, used both as the author
// (Bearer key) and to add that member to the channel. Some messages carry:
//   reply: [ { who, text }, ... ]  threaded replies to that message
//   react: [ { who, emoji }, ... ] reactions added to that message
const CHANNELS = [
  {
    name: 'castaways',
    topic: 'General quarters for everyone stranded on this rock',
    description: 'The whole crew. Coconuts, morale, and who ate the last of Mary Ann’s pie.',
    msgs: [
      { who: 'skipper', text: 'Crew meeting at the lagoon, 0800. And Gilligan — wear shoes this time.',
        react: [{ who: 'gilligan', emoji: '🫡' }, { who: 'maryann', emoji: '👍' }] },
      { who: 'gilligan', text: 'Aye aye, little buddy! …wait, that’s you. Aye aye ME, Skipper!',
        reply: [
          { who: 'skipper', text: 'It is NOT you. I am the Skipper. You are the first mate. We have been over this.' },
          { who: 'gilligan', text: 'Right, right. So… do I still get the hat?' },
        ] },
      { who: 'professor', text: 'I’ve calculated our drift. If the trade winds hold, a raft could reach a shipping lane in 11 days.',
        react: [{ who: 'skipper', emoji: '🤔' }, { who: 'howell', emoji: '🧐' }] },
      { who: 'ginger', text: 'Eleven days at sea with no mirror? Darling, I’d rather be rescued by helicopter. Preferably with a camera crew.' },
      { who: 'maryann', text: 'I’ll pack coconut cream pies for the voyage. They keep surprisingly well in the shade.',
        react: [{ who: 'gilligan', emoji: '🥧' }, { who: 'skipper', emoji: '😋' }, { who: 'professor', emoji: '👏' }] },
      { who: 'howell', text: 'Lovey, remind me to expense this island. The view alone is worth a fortune.' },
    ],
  },
  {
    name: 'rescue-ops',
    topic: 'Every signal we can muster — fires, mirrors, bottles, planes',
    description: 'Operations for getting OFF this island. Status reports only. (Gilligan, that means you.)',
    msgs: [
      { who: 'skipper', text: 'Status on the signal fire, Professor?',
        reply: [
          { who: 'professor', text: 'Burning steady on Lookout Point. I rigged a green-flame additive from copper-bearing rock for night visibility.' },
          { who: 'skipper', text: 'Outstanding. Gilligan, you are on firewood. Do NOT fall in the fire again.' },
          { who: 'gilligan', text: 'That was ONE time and my hat barely caught.' },
        ] },
      { who: 'gilligan', text: 'Skipper, I corked all 100 message bottles and set them out on the tide! …most of them.',
        react: [{ who: 'maryann', emoji: '🍾' }] },
      { who: 'skipper', text: '“Most of them”?? Gilligan, where are the rest of the bottles?',
        reply: [
          { who: 'gilligan', text: 'Well, see, I got thirsty. They had really good water in them.' },
          { who: 'professor', text: 'Gilligan. The water was the BALLAST. The bottles won’t float upright now.' },
          { who: 'gilligan', text: '…I have made a tremendous mistake.' },
        ],
        react: [{ who: 'professor', emoji: '🤦' }, { who: 'ginger', emoji: '😂' }] },
      { who: 'howell', text: 'I’ll simply BUY us a rescue. Cable my broker — offer the next passing yacht ten thousand to take us to Honolulu.',
        reply: [
          { who: 'professor', text: 'Mr. Howell, there is no cable. There is no broker. There is a coconut radio that doesn’t work yet.' },
          { who: 'howell', text: 'Then offer the COCONUT ten thousand. Everyone has a price, Professor.' },
        ],
        react: [{ who: 'lovey', emoji: '💰' }, { who: 'ginger', emoji: '😂' }] },
      { who: 'maryann', text: 'I stamped a great big HELP into the beach at low tide. Big enough for a plane to read!',
        react: [{ who: 'skipper', emoji: '👏' }, { who: 'professor', emoji: '✈️' }] },
    ],
  },
  {
    name: 'the-lagoon',
    topic: 'Boat works, raft #4, and other things Gilligan will sink',
    description: 'Naval engineering. Bamboo, vines, and the sea trials that keep ending in swimming.',
    msgs: [
      { who: 'skipper', text: 'Raft #4 launches at high tide. This one is WATERTIGHT. I checked it myself.' },
      { who: 'gilligan', text: 'Skipper, what does this little plug at the bottom do?',
        reply: [
          { who: 'skipper', text: 'DON’T TOUCH THE— ' },
          { who: 'gilligan', text: 'Too late. It’s very glug-glug down here.' },
          { who: 'professor', text: 'And that is raft #4. I’ll begin drawings for #5.' },
        ],
        react: [{ who: 'professor', emoji: '🌊' }, { who: 'ginger', emoji: '😂' }, { who: 'maryann', emoji: '😭' }] },
      { who: 'professor', text: 'For #5 I propose a sealed bamboo pontoon design. No plugs. Nothing for anyone to pull.' },
      { who: 'ginger', text: 'Could we make the sail out of my red gown? It photographs beautifully and it’d be very visible at sea.',
        react: [{ who: 'howell', emoji: '👗' }] },
      { who: 'skipper', text: 'Approved, Ginger — visibility is visibility. Gilligan, you are BANNED from the plug area.',
        react: [{ who: 'gilligan', emoji: '😔' }] },
    ],
  },
  {
    name: 'howell-estate',
    topic: 'Society, soirées, and the simple pleasures of being fabulously wealthy',
    description: 'The Howells’ social calendar. Black tie on a desert island, naturally.',
    msgs: [
      { who: 'lovey', text: 'I’m planning the Luau for Saturday. It MUST be tasteful. Thurston, the budget is unlimited.',
        react: [{ who: 'howell', emoji: '💰' }] },
      { who: 'howell', text: 'Of course, Lovey-dovey. Spare no coconut. Charge it all to the Howell estate.' },
      { who: 'ginger', text: 'I’ll do a hula floor show. I’ve been rehearsing on the beach — the crabs are an excellent audience.',
        react: [{ who: 'lovey', emoji: '💃' }, { who: 'maryann', emoji: '🌺' }] },
      { who: 'maryann', text: 'I’ll bring three pies. Coconut cream, mango, and a surprise one if the bananas ripen in time.',
        reply: [
          { who: 'lovey', text: 'A SURPRISE pie? Mary Ann, you spoil us. Mr. Howell adores a surprise.' },
          { who: 'gilligan', text: 'Is the surprise that I already ate some? Asking for a friend. The friend is me.' },
          { who: 'maryann', text: 'WILLY GILLIGAN.' },
        ],
        react: [{ who: 'howell', emoji: '🥧' }, { who: 'ginger', emoji: '😂' }] },
      { who: 'lovey', text: 'Engraved bamboo place cards, please. And NO sand in the punch this year.' },
    ],
  },
  {
    name: 'radio-repair',
    topic: 'Coconut-powered telecommunications R&D',
    description: 'The Professor’s lab notes. If it works, we go home. If Gilligan pedals, we MIGHT go home.',
    msgs: [
      { who: 'professor', text: 'Receiver rebuilt from the Minnow’s salvaged parts. I need 6 volts of steady current to transmit.',
        react: [{ who: 'skipper', emoji: '📻' }] },
      { who: 'professor', text: 'Gilligan, mount the bicycle generator. Pedal at a STEADY cadence. Do not stop, do not speed up.',
        reply: [
          { who: 'gilligan', text: 'Steady cadence! Got it, Professor. …is this steady? Is THIS steady? How about now?' },
          { who: 'professor', text: 'You are oscillating the voltage. The dial is doing a little dance. PLEASE just pedal evenly.' },
          { who: 'gilligan', text: 'Pedaling evenly is HARD when you keep yelling “EVENLY.”' },
        ],
        react: [{ who: 'ginger', emoji: '🚲' }, { who: 'maryann', emoji: '😂' }] },
      { who: 'skipper', text: 'Professor, what do we say when it connects? Keep it short — Gilligan’s legs won’t last.' },
      { who: 'professor', text: 'Draft distress message: “S.S. Minnow castaways, seven souls, uncharted island, request immediate rescue.” 4 seconds. Tight.',
        react: [{ who: 'skipper', emoji: '👍' }, { who: 'howell', emoji: '🧐' }] },
      { who: 'howell', text: 'Add: “Reward offered. Substantial. Signed, Thurston Howell the Third.” That’ll get a faster boat.',
        reply: [
          { who: 'professor', text: 'Mr. Howell, that doubles the transmission time and Gilligan is already turning purple.' },
          { who: 'gilligan', text: 'Confirmed. Purple. Very purple.' },
        ],
        react: [{ who: 'ginger', emoji: '😂' }] },
    ],
  },
];

// Direct messages: [from, to, [ {who, text}, ... ]]. `who` must be from or to.
const DMS = [
  {
    from: 'skipper', to: 'gilligan',
    msgs: [
      { who: 'skipper', text: 'Little buddy. Between us. How many bottles did you actually drink.' },
      { who: 'gilligan', text: 'Define “drink.”' },
      { who: 'skipper', text: 'Gilligan.' },
      { who: 'gilligan', text: 'Forty-one. But in my defense they were SO refreshing.' },
    ],
  },
  {
    from: 'lovey', to: 'maryann',
    msgs: [
      { who: 'lovey', text: 'Mary Ann dear, between us girls — your pies are the only thing keeping Thurston civilized. Don’t tell Ginger.' },
      { who: 'maryann', text: 'My lips are sealed, Mrs. Howell! I’ll save you the first slice of the surprise pie.' },
      { who: 'lovey', text: 'You’re an angel. I’ll have Thurston “expense” you something lovely once we’re rescued.' },
    ],
  },
];

// Map: who-created -> channelId. We add the whole cast as members so every
// author key can post (channel role 'member' can post; only 'viewer' can't).
async function findOrCreateChannel(def) {
  // List channels as skipper (sees all public channels he's a member of, plus
  // we add him). The org auto-creates #general on the first list/create.
  const existing = asArr(await api('skipper', 'GET', '/v1/channels'));
  const match = existing.find(
    (c) => (c.channel?.name ?? c.name) === def.name || (c.channel?.slug ?? c.slug) === def.name,
  );
  if (match) {
    const ch = match.channel ?? match;
    return { id: ch.id, created: false };
  }
  const created = await api('skipper', 'POST', '/v1/channels', {
    name: def.name,
    type: 'public',
    topic: def.topic,
    description: def.description,
  });
  const ch = created.channel ?? created;
  return { id: ch.id, created: true };
}

async function ensureMembers(channelId) {
  // skipper is owner (creator). Add everyone else as 'member'.
  const others = ALL.filter((id) => id !== CAST.skipper);
  try {
    await api('skipper', 'POST', `/v1/channels/${channelId}/members`, {
      user_ids: others,
      role: 'member',
    });
  } catch (e) {
    console.log(`  add-members warning on ${channelId}: ${e.message}`);
  }
}

async function channelHasMessages(channelId) {
  const rows = asArr(await api('skipper', 'GET', `/v1/channels/${channelId}/messages?limit=5`));
  return rows.length > 0;
}

// Returns the set of existing message texts (plain) in a channel, so DM seeding
// can post only the messages that are missing (message-level idempotency,
// rather than all-or-nothing per channel — needed because a prior partial run
// may have landed some of a DM's lines before hitting a rate limit).
async function existingMessageTexts(channelId, who) {
  const rows = asArr(await api(who, 'GET', `/v1/channels/${channelId}/messages?limit=100`));
  const set = new Set();
  for (const row of rows) {
    const m = row.message ?? row;
    const t = (m.content_plain ?? m.content ?? '').replace(/<[^>]*>/g, '').trim();
    if (t) set.add(t);
  }
  return set;
}

(async () => {
  let channelsCreated = 0;
  let messagesPosted = 0;
  let repliesPosted = 0;
  let reactionsAdded = 0;
  let dmsPosted = 0;
  const failures = [];

  // ── Channels ──
  for (const def of CHANNELS) {
    let chId, created;
    try {
      ({ id: chId, created } = await findOrCreateChannel(def));
    } catch (e) {
      failures.push(`channel ${def.name}: ${e.message}`);
      console.log(`channel FAILED: ${def.name} — ${e.message}`);
      continue;
    }
    if (created) {
      channelsCreated++;
      console.log(`channel: #${def.name} (${chId})`);
    } else {
      console.log(`channel exists: #${def.name} (${chId})`);
    }

    await ensureMembers(chId);

    // Idempotency: if the channel already has any messages, skip seeding it.
    if (await channelHasMessages(chId)) {
      console.log(`  messages already present, skipping #${def.name}`);
      continue;
    }

    for (const m of def.msgs) {
      let posted;
      try {
        posted = await api(m.who, 'POST', `/v1/channels/${chId}/messages`, {
          content: m.text,
          content_format: 'plain',
        });
        messagesPosted++;
      } catch (e) {
        failures.push(`#${def.name} msg by ${m.who}: ${e.message}`);
        console.log(`  msg FAILED (${m.who}): ${e.message}`);
        continue;
      }
      const msg = posted.message ?? posted;
      const msgId = msg.id;

      // Threaded replies
      if (Array.isArray(m.reply) && msgId) {
        for (const r of m.reply) {
          try {
            await api(r.who, 'POST', `/v1/messages/${msgId}/thread`, {
              content: r.text,
              content_format: 'plain',
            });
            repliesPosted++;
          } catch (e) {
            failures.push(`#${def.name} reply by ${r.who}: ${e.message}`);
            console.log(`  reply FAILED (${r.who}): ${e.message}`);
          }
        }
      }

      // Reactions
      if (Array.isArray(m.react) && msgId) {
        for (const rx of m.react) {
          try {
            await api(rx.who, 'POST', `/v1/messages/${msgId}/reactions`, { emoji: rx.emoji });
            reactionsAdded++;
          } catch (e) {
            failures.push(`#${def.name} react by ${rx.who}: ${e.message}`);
            console.log(`  react FAILED (${rx.who} ${rx.emoji}): ${e.message}`);
          }
        }
      }
    }
    console.log(`  + posted into #${def.name}`);
  }

  // ── Direct messages ──
  for (const dm of DMS) {
    let chId;
    try {
      const ch = await api(dm.from, 'POST', '/v1/dm', { user_id: CAST[dm.to] });
      const channel = ch.channel ?? ch;
      chId = channel.id;
    } catch (e) {
      failures.push(`dm ${dm.from}->${dm.to}: ${e.message}`);
      console.log(`dm FAILED: ${dm.from}->${dm.to} — ${e.message}`);
      continue;
    }

    // Message-level idempotency: skip lines already present (by text).
    let existing;
    try {
      existing = await existingMessageTexts(chId, dm.from);
    } catch {
      existing = new Set();
    }
    console.log(`dm: ${dm.from}<->${dm.to} (${chId})${existing.size ? ` [${existing.size} existing]` : ''}`);
    for (const m of dm.msgs) {
      if (existing.has(m.text.trim())) {
        continue;
      }
      try {
        await api(m.who, 'POST', `/v1/channels/${chId}/messages`, {
          content: m.text,
          content_format: 'plain',
        });
        dmsPosted++;
      } catch (e) {
        failures.push(`dm ${dm.from}->${dm.to} msg by ${m.who}: ${e.message}`);
        console.log(`  dm msg FAILED (${m.who}): ${e.message}`);
      }
    }
  }

  console.log('\n── Banter seed summary ──');
  console.log(`channels created : ${channelsCreated}`);
  console.log(`channel messages : ${messagesPosted}`);
  console.log(`thread replies   : ${repliesPosted}`);
  console.log(`reactions        : ${reactionsAdded}`);
  console.log(`DM messages      : ${dmsPosted}`);
  console.log(`failures         : ${failures.length}`);
  if (failures.length) {
    console.log('failure detail:');
    for (const f of failures) console.log(`  - ${f}`);
  }
})().catch((e) => {
  console.error('banter seed failed:', e.message);
  process.exit(1);
});
