/**
 * Gilligan's Island themed Banter SUPPLEMENT seed.
 *
 * The original banter.mjs seeded #castaways / #rescue-ops / #the-lagoon /
 * #howell-estate / #radio-repair, but the DEFAULT channel (#general) was left
 * empty and there were no bookmarks anywhere. The default capture recipes open
 * #general (channel list, channel view, thread, reaction/pin overlays) and the
 * Bookmarks view, so both render empty. This script fills those two gaps:
 *
 *   1. #general — ensure the whole cast are members, post ~9 in-character
 *      orientation messages, one with a 3-reply thread, several reactions, and
 *      PIN the two most important (rescue-plan summary + daily-plan roll call).
 *   2. Bookmarks — as 3 cast members, bookmark a handful of existing messages
 *      from #general and #rescue-ops so the Bookmarks view is populated.
 *
 * Idempotent at the MESSAGE level (skips a message whose plain text already
 * exists in the channel) and the bookmark/pin level (the API upserts both with
 * ON CONFLICT DO NOTHING). Safe to re-run after a 429 rate-limit interruption.
 *
 * Run from the repo host (mirrors banter.mjs's proven invocation):
 *   GKEYS=$(node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("scripts/.gilligan-keys.env","utf8").split("\n")){if(l&&!l.startsWith("#")&&l.includes("=")){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1).trim();}}process.stdout.write(JSON.stringify(o))')
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/banter-supplement.mjs
 */

// Banter API internal host + /v1 route prefix (confirmed: docker-compose.yml
// BANTER_API_URL=http://banter-api:4002, routes registered at '/v1/...').
const API = 'http://banter-api:4002';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (must match scripts/seed-gilligan/bam.mjs CAST map).
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

// Tracks the most recent 429 so the summary can flag rate-limiting.
let rate429 = 0;

async function api(who, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 429) {
    rate429++;
    const e = new Error(`${method} ${path} -> 429 rate-limited`);
    e.is429 = true;
    throw e;
  }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 240)}`);
  return data.data ?? data;
}
const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// Small inter-request pause to stay under Banter's per-IP rate limit on a
// fresh run; harmless on re-runs (most calls short-circuit on idempotency).
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ── #general orientation script ───────────────────────────────────────────
// Each message: { who, text }. Optional: reply[] (threaded replies),
// react[] (reactions), pin:true (pin via the channel owner after posting).
const GENERAL_MSGS = [
  {
    who: 'skipper',
    text: 'Welcome to Gilligan Travel HQ — this is #general. All hands check in here every morning. We are organized, we are professional, and we are getting off this island.',
    react: [{ who: 'maryann', emoji: '👍' }, { who: 'professor', emoji: '🫡' }, { who: 'ginger', emoji: '💅' }],
  },
  {
    who: 'skipper',
    text: 'Roll call! Sound off so I know nobody drifted out on raft #4 overnight.',
    reply: [
      { who: 'gilligan', text: 'Gilligan present! Both feet, both shoes. Mostly.' },
      { who: 'maryann', text: 'Mary Ann here — pies are in the oven, well, the coconut-shell oven.' },
      { who: 'professor', text: 'Present. Already on Lookout Point checking the signal fire.' },
    ],
    react: [{ who: 'lovey', emoji: '🙋' }, { who: 'howell', emoji: '🎩' }],
  },
  {
    who: 'professor',
    text: 'Today\'s plan, in order of priority: (1) keep the signal fire lit, (2) finish the coconut radio, (3) sea-trial raft #5. If any one of those lands, we are one step closer to a real shipping lane.',
    pin: true,
    react: [{ who: 'skipper', emoji: '📋' }, { who: 'maryann', emoji: '✅' }],
  },
  {
    who: 'ginger',
    text: 'Morning, darlings. I\'ll be rehearsing the rescue-day welcome speech for the cameras. One must look one\'s best when the helicopter arrives.',
    react: [{ who: 'lovey', emoji: '💃' }, { who: 'gilligan', emoji: '😍' }],
  },
  {
    who: 'maryann',
    text: 'Fresh coconut cream pie at the dining hut at noon. First come, first served — Gilligan, ONE slice.',
    react: [{ who: 'gilligan', emoji: '🥧' }, { who: 'skipper', emoji: '😋' }, { who: 'howell', emoji: '👏' }, { who: 'professor', emoji: '🙏' }],
  },
  {
    who: 'gilligan',
    text: 'Skipper, I promise this is going to be a GREAT day. No mistakes. None. Zero. You\'ll see.',
    react: [{ who: 'skipper', emoji: '🤞' }, { who: 'ginger', emoji: '😂' }],
  },
  {
    who: 'howell',
    text: 'A fine morning to be marooned in style. Lovey and I will be receiving on the veranda — that is, the big flat rock — should anyone need capital.',
    react: [{ who: 'lovey', emoji: '💰' }],
  },
  {
    who: 'skipper',
    text: 'RESCUE PLAN, pinned for everyone: signal fire stays lit 24/7, the Professor\'s coconut radio transmits on the hour, message bottles go out every tide, and the beach HELP sign gets refreshed daily. Stick to the plan and we go HOME.',
    pin: true,
    react: [{ who: 'professor', emoji: '🧭' }, { who: 'maryann', emoji: '🏝️' }, { who: 'gilligan', emoji: '🚀' }, { who: 'howell', emoji: '🧐' }],
  },
  {
    who: 'lovey',
    text: 'And once we ARE rescued, the first round of mai tais is on the Howells. Do keep your spirits up, everyone.',
    react: [{ who: 'ginger', emoji: '🍹' }, { who: 'maryann', emoji: '🌺' }],
  },
];

// ── Bookmarks ───────────────────────────────────────────────────────────
// For each bookmarker we pick existing messages by a substring of their text
// (so we don't hardcode ids). Sources: #general (seeded above) + #rescue-ops
// (seeded by banter.mjs). The bookmarker must be a channel member — the whole
// cast are members of #general (auto-added) and of #rescue-ops (banter.mjs).
const BOOKMARK_PLAN = [
  {
    who: 'professor',
    picks: [
      { channel: 'general', match: 'Today\'s plan, in order of priority', note: 'Daily priorities — check each morning' },
      { channel: 'general', match: 'RESCUE PLAN, pinned for everyone', note: 'Master rescue plan' },
      { channel: 'rescue-ops', match: 'Status on the signal fire', note: 'Signal-fire status thread — keep it lit 24/7' },
    ],
  },
  {
    who: 'maryann',
    picks: [
      { channel: 'general', match: 'Fresh coconut cream pie', note: 'My pie schedule' },
      { channel: 'general', match: 'RESCUE PLAN, pinned for everyone', note: 'The plan that gets us home' },
      { channel: 'rescue-ops', match: 'stamped a great big HELP', note: 'Refresh the beach sign daily' },
    ],
  },
  {
    who: 'skipper',
    picks: [
      { channel: 'general', match: 'RESCUE PLAN, pinned for everyone', note: 'My own pinned plan' },
      { channel: 'rescue-ops', match: 'where are the rest of the bottles', note: 'Re: the missing bottles incident' },
    ],
  },
];

// Resolve a channel id by slug/name, listing as skipper (member of all).
async function channelIdByName(name) {
  const existing = asArr(await api('skipper', 'GET', '/v1/channels'));
  const match = existing.find(
    (c) => (c.channel?.name ?? c.name) === name || (c.channel?.slug ?? c.slug) === name,
  );
  if (!match) return null;
  const ch = match.channel ?? match;
  return ch.id;
}

// Fetch messages for a channel (as a member) and return both a text->id map
// and a Set of existing plain texts (for message-level idempotency).
async function loadMessages(channelId, who) {
  const rows = asArr(await api(who, 'GET', `/v1/channels/${channelId}/messages?limit=200`));
  const byText = new Map();
  for (const row of rows) {
    const m = row.message ?? row;
    const t = (m.content_plain ?? m.content ?? '').replace(/<[^>]*>/g, '').trim();
    if (t) byText.set(t, m.id);
  }
  return byText;
}

function findIdByMatch(byText, substring) {
  for (const [text, id] of byText) {
    if (text.includes(substring)) return id;
  }
  return null;
}

(async () => {
  let generalMsgs = 0;
  let generalReplies = 0;
  let generalReactions = 0;
  let generalPins = 0;
  const bookmarksCreated = []; // { who, channel, match }
  const failures = [];

  // ── #general ──
  const generalId = await channelIdByName('general');
  if (!generalId) {
    console.error('Could not find #general channel — aborting.');
    process.exit(1);
  }
  console.log(`#general (${generalId})`);

  // Ensure the whole cast are members so each author key can post.
  // (Auto-create already adds active org members, but this is belt-and-suspenders
  //  and idempotent via ON CONFLICT DO NOTHING on the membership unique index.)
  try {
    const others = ALL.filter((id) => id !== CAST.skipper);
    await api('skipper', 'POST', `/v1/channels/${generalId}/members`, {
      user_ids: others,
      role: 'member',
    });
  } catch (e) {
    if (e.is429) failures.push('#general add-members: 429 rate-limited');
    else console.log(`  add-members warning: ${e.message}`);
  }

  // Message-level idempotency: load what's already in #general.
  let byText;
  try {
    byText = await loadMessages(generalId, 'skipper');
  } catch (e) {
    byText = new Map();
    failures.push(`#general load: ${e.message}`);
  }

  for (const m of GENERAL_MSGS) {
    const key = m.text.trim();
    let msgId = byText.get(key);

    if (!msgId) {
      try {
        const posted = await api(m.who, 'POST', `/v1/channels/${generalId}/messages`, {
          content: m.text,
          content_format: 'plain',
        });
        const msg = posted.message ?? posted;
        msgId = msg.id;
        byText.set(key, msgId);
        generalMsgs++;
        await sleep(120);
      } catch (e) {
        if (e.is429) failures.push(`#general msg by ${m.who}: 429`);
        else failures.push(`#general msg by ${m.who}: ${e.message}`);
        console.log(`  msg FAILED (${m.who}): ${e.message}`);
        continue;
      }
    } else {
      console.log(`  msg exists (${m.who}): "${key.slice(0, 48)}..."`);
    }

    // Threaded replies — idempotent against the THREAD list, not the channel
    // message list. Thread replies are excluded from GET /channels/:id/messages,
    // so we must fetch GET /messages/:parent/thread to know which replies are
    // already present (otherwise a rerun duplicates every reply).
    if (Array.isArray(m.reply) && msgId) {
      let existingReplies = new Set();
      try {
        const rows = asArr(await api('skipper', 'GET', `/v1/messages/${msgId}/thread?limit=100`));
        for (const row of rows) {
          const rm = row.message ?? row;
          const t = (rm.content_plain ?? rm.content ?? '').replace(/<[^>]*>/g, '').trim();
          if (t) existingReplies.add(t);
        }
      } catch {
        // If we can't list, fall through and risk posting; better than no thread.
      }
      for (const r of m.reply) {
        if (existingReplies.has(r.text.trim())) continue;
        try {
          await api(r.who, 'POST', `/v1/messages/${msgId}/thread`, {
            content: r.text,
            content_format: 'plain',
          });
          existingReplies.add(r.text.trim());
          generalReplies++;
          await sleep(120);
        } catch (e) {
          if (e.is429) failures.push(`#general reply by ${r.who}: 429`);
          else failures.push(`#general reply by ${r.who}: ${e.message}`);
          console.log(`  reply FAILED (${r.who}): ${e.message}`);
        }
      }
    }

    // Reactions — POST is idempotent-ish (unique on message/user/emoji); a
    // duplicate may 409, which we treat as already-present.
    if (Array.isArray(m.react) && msgId) {
      for (const rx of m.react) {
        try {
          await api(rx.who, 'POST', `/v1/messages/${msgId}/reactions`, { emoji: rx.emoji });
          generalReactions++;
          await sleep(80);
        } catch (e) {
          if (e.is429) {
            failures.push(`#general react by ${rx.who}: 429`);
          } else if (/409|already/i.test(e.message)) {
            // already reacted — fine
          } else {
            failures.push(`#general react by ${rx.who} ${rx.emoji}: ${e.message}`);
            console.log(`  react FAILED (${rx.who} ${rx.emoji}): ${e.message}`);
          }
        }
      }
    }

    // Pin (channel owner = skipper). Idempotent via ON CONFLICT DO NOTHING.
    if (m.pin && msgId) {
      try {
        await api('skipper', 'POST', `/v1/channels/${generalId}/pins`, { message_id: msgId });
        generalPins++;
        await sleep(80);
      } catch (e) {
        if (e.is429) failures.push(`#general pin: 429`);
        else {
          failures.push(`#general pin: ${e.message}`);
          console.log(`  pin FAILED: ${e.message}`);
        }
      }
    }
  }

  // ── Bookmarks ──
  // Cache message maps per (channel, who) so we resolve ids without re-fetching.
  const channelIds = {};
  const msgCache = {}; // `${channel}:${who}` -> Map
  for (const channel of ['general', 'rescue-ops']) {
    channelIds[channel] = channel === 'general' ? generalId : await channelIdByName(channel);
  }

  for (const plan of BOOKMARK_PLAN) {
    for (const pick of plan.picks) {
      const chId = channelIds[pick.channel];
      if (!chId) {
        failures.push(`bookmark ${plan.who} ${pick.channel}: channel not found`);
        continue;
      }
      const cacheKey = `${pick.channel}:${plan.who}`;
      if (!msgCache[cacheKey]) {
        try {
          msgCache[cacheKey] = await loadMessages(chId, plan.who);
        } catch (e) {
          msgCache[cacheKey] = new Map();
          failures.push(`bookmark ${plan.who} load ${pick.channel}: ${e.message}`);
        }
      }
      const messageId = findIdByMatch(msgCache[cacheKey], pick.match);
      if (!messageId) {
        failures.push(`bookmark ${plan.who} ${pick.channel}: no message matching "${pick.match}"`);
        console.log(`  bookmark SKIP (${plan.who}): no match for "${pick.match}" in #${pick.channel}`);
        continue;
      }
      try {
        await api(plan.who, 'POST', '/v1/bookmarks', { message_id: messageId, note: pick.note });
        bookmarksCreated.push({ who: plan.who, channel: pick.channel, match: pick.match });
        await sleep(100);
      } catch (e) {
        if (e.is429) failures.push(`bookmark ${plan.who} ${pick.channel}: 429`);
        else {
          failures.push(`bookmark ${plan.who} ${pick.channel}: ${e.message}`);
          console.log(`  bookmark FAILED (${plan.who} ${pick.channel}): ${e.message}`);
        }
      }
    }
  }

  // ── Summary ──
  console.log('\n── Banter supplement summary ──');
  console.log(`#general messages posted : ${generalMsgs}`);
  console.log(`#general thread replies   : ${generalReplies}`);
  console.log(`#general reactions        : ${generalReactions}`);
  console.log(`#general pins             : ${generalPins}`);
  console.log(`bookmarks created         : ${bookmarksCreated.length}`);
  for (const b of bookmarksCreated) {
    console.log(`    - ${b.who} bookmarked a #${b.channel} message ("${b.match.slice(0, 40)}...")`);
  }
  console.log(`429 rate-limit hits       : ${rate429}`);
  console.log(`failures                  : ${failures.length}`);
  if (failures.length) {
    console.log('failure detail:');
    for (const f of failures) console.log(`  - ${f}`);
  }
})().catch((e) => {
  console.error('banter supplement failed:', e.message);
  process.exit(1);
});
