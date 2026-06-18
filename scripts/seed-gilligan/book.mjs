/**
 * Gilligan's Island themed Book (scheduling/calendar) seed.
 *
 * The castaways run the island's whole calendar — rescue-watch shifts,
 * radio-listening windows, the Howell Luau, tide-chart briefings — on Book.
 * Events span the week of 2026-06-15 (Mon) through 2026-06-21 (Sun) so the
 * week/day/month calendar views render populated around the frozen capture
 * clock (SHOTS_FROZEN_TIME = 2026-06-15). Idempotent: skips any event whose
 * title already exists in the window, and skips the booking page if its slug
 * already exists.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("scripts/.gilligan-keys.env","utf8").split("\n")){if(l&&!l.startsWith("#")&&l.includes("=")){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1).trim();}}process.stdout.write(JSON.stringify(o))')
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/book.mjs
 * (api container can reach the internal app hosts; cast API keys authenticate
 *  via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 */

const BAM = 'http://localhost:4000'; // for /auth/me email lookups
const BOOK = 'http://book-api:4012/v1'; // calendars / events / booking-pages
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (mirror of scripts/seed-gilligan/bam.mjs CAST map).
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
async function call(base, who, method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 240)}`);
  return data.data ?? data;
}
const bam = (who, m, p, b) => call(BAM, who, m, p, b);
const book = (who, m, p, b) => call(BOOK, who, m, p, b);
const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// Island time. Pacific/Honolulu has no DST, so a fixed UTC-10:00 is exact.
// The Book API validates datetimes with Zod `.datetime()`, which rejects
// numeric offsets and only accepts a `Z`-suffixed UTC instant — so we convert
// the Honolulu wall-clock time to UTC ourselves (Honolulu + 10h = UTC) and
// emit a `...Z` string. The stored `timezone: 'Pacific/Honolulu'` field tells
// the calendar UI how to render it back to island time.
const TZ = 'Pacific/Honolulu';
const at = (date, time) => {
  // date = 'YYYY-MM-DD', time = 'HH:MM' in Honolulu local. Honolulu = UTC-10.
  const utcMs = Date.parse(`${date}T${time}:00Z`) + 10 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString(); // -> '...Z'
};

(async () => {
  // ---- 1. Build a cast id -> email map (attendees require an email). ----
  const EMAIL = {};
  for (const [who, key] of Object.entries(KEYS)) {
    if (!CAST[who]) continue;
    try {
      const me = await bam(who, 'GET', '/auth/me');
      if (me?.email) EMAIL[who] = me.email;
    } catch (e) {
      console.log(`  email lookup failed for ${who}: ${e.message}`);
    }
  }
  const att = (...whos) =>
    whos
      .filter((w) => EMAIL[w])
      .map((w) => ({ email: EMAIL[w], user_id: CAST[w] }));

  // ---- 2. Find-or-create the island calendar (organizer: the Skipper). ----
  const ORGANIZER = 'skipper';
  const CAL_NAME = 'Island Calendar';
  let cal = asArr(await book(ORGANIZER, 'GET', '/calendars')).find((c) => c.name === CAL_NAME);
  if (!cal) {
    cal = await book(ORGANIZER, 'POST', '/calendars', {
      name: CAL_NAME,
      description: 'Rescue watches, radio windows, tide charts, and the Howells’ social calendar.',
      color: '#0ea5e9',
      calendar_type: 'team',
      timezone: TZ,
    });
    console.log(`calendar: ${CAL_NAME} (${cal.id})`);
  } else {
    console.log(`calendar exists: ${CAL_NAME} (${cal.id})`);
  }

  // ---- 3. The week's events (Mon 2026-06-15 .. Sun 2026-06-21). ----
  // who = organizer (creator); guests = invited cast.
  const EVENTS = [
    // Monday 06-15
    {
      title: 'Lookout Point — Morning Shift',
      who: 'gilligan', guests: ['gilligan', 'skipper'],
      date: '2026-06-15', start: '06:00', end: '08:00',
      location: 'Lookout Point (the tall palm)',
      desc: 'Scan the horizon for ships, planes, and anything that floats. Bring the spyglass. Do NOT fall asleep. (Looking at you, Gilligan.)',
    },
    {
      title: 'Signal-Fire Watch (Skipper)',
      who: 'skipper', guests: ['skipper', 'gilligan'],
      date: '2026-06-15', start: '08:30', end: '11:30',
      location: 'North Beach signal fire',
      desc: 'Keep the fire fed and smoking. Little buddy on driftwood detail. If a plane passes, wave EVERYTHING.',
    },
    {
      title: 'Mary Ann’s Pie Hour',
      who: 'maryann', guests: ['maryann', 'gilligan', 'skipper', 'professor', 'ginger'],
      date: '2026-06-15', start: '15:00', end: '16:00',
      location: 'The communal hut',
      desc: 'Fresh coconut cream pie. First come, first served. Gilligan, one slice. ONE.',
    },

    // Tuesday 06-16
    {
      title: 'Radio Listening Window — Honolulu Weather',
      who: 'professor', guests: ['professor', 'gilligan'],
      date: '2026-06-16', start: '07:00', end: '07:30',
      location: 'The Professor’s lab hut',
      desc: 'Tune the coconut-powered receiver to the Honolulu marine forecast. Gilligan on the bicycle generator — pedal STEADILY.',
    },
    {
      title: 'Professor’s Tide-Chart Briefing',
      who: 'professor', guests: ['professor', 'skipper', 'gilligan', 'maryann'],
      date: '2026-06-16', start: '10:00', end: '11:00',
      location: 'The lagoon (low-tide line)',
      desc: 'Reviewing the week’s tide tables to plan the raft launch. High tide is your friend; the reef is not.',
    },
    {
      title: 'Coconut Harvest',
      who: 'maryann', guests: ['maryann', 'gilligan', 'skipper'],
      date: '2026-06-16', start: '14:00', end: '16:30',
      location: 'The palm grove, east ridge',
      desc: 'Stock up: food, water cups, radio batteries, pie filling, AND the Professor’s next dozen inventions. Mind your head.',
    },

    // Wednesday 06-17
    {
      title: 'Lookout Point — Morning Shift',
      who: 'ginger', guests: ['ginger', 'maryann'],
      date: '2026-06-17', start: '06:00', end: '08:00',
      location: 'Lookout Point (the tall palm)',
      desc: 'Ginger and Mary Ann take the dawn watch. Sequins optional but apparently non-negotiable.',
    },
    {
      title: 'Hula Rehearsal (Ginger)',
      who: 'ginger', guests: ['ginger', 'maryann', 'lovey'],
      date: '2026-06-17', start: '16:00', end: '17:30',
      location: 'The lagoon clearing',
      desc: 'Choreography for the Howell Luau floor show. Mrs. Howell supervising. Torches NOT lit during rehearsal.',
    },

    // Thursday 06-18
    {
      title: 'Signal-Fire Watch (Skipper)',
      who: 'skipper', guests: ['skipper', 'gilligan'],
      date: '2026-06-18', start: '08:30', end: '11:30',
      location: 'North Beach signal fire',
      desc: 'Second watch of the week. Extra green palm fronds for maximum smoke. Rescue is a numbers game.',
    },
    {
      title: 'Raft Sea-Trial @ High Tide',
      who: 'skipper', guests: ['skipper', 'professor', 'gilligan'],
      date: '2026-06-18', start: '13:00', end: '15:00',
      location: 'The lagoon, launching from South Beach',
      desc: 'Sea-trial the new bamboo raft on the afternoon high tide. Professor verifies the lashings; Gilligan does NOT steer.',
    },

    // Friday 06-19
    {
      title: 'Radio Listening Window — Honolulu Weather',
      who: 'professor', guests: ['professor', 'gilligan', 'maryann'],
      date: '2026-06-19', start: '07:00', end: '07:30',
      location: 'The Professor’s lab hut',
      desc: 'Friday forecast check before the weekend. If there’s a storm front, the luau moves indoors (such as “indoors” is).',
    },
    {
      title: 'Howell Luau Setup — Crew Call',
      who: 'lovey', guests: ['lovey', 'howell', 'maryann', 'ginger', 'gilligan'],
      date: '2026-06-19', start: '15:00', end: '18:00',
      location: 'The Howell estate (the big hut)',
      desc: 'Leis, tiki torches, bamboo place cards, and the non-alcoholic Howell punch. Mrs. Howell approving every detail personally.',
    },

    // Saturday 06-20 — the main event
    {
      title: 'Howell Luau (Formal Attire)',
      who: 'howell', guests: ['howell', 'lovey', 'skipper', 'professor', 'gilligan', 'maryann', 'ginger'],
      date: '2026-06-20', start: '18:00', end: '22:00',
      location: 'The Howell estate, lagoon-side',
      desc: 'A suitably lavish island gala. Formal attire (yes, even you, Gilligan — the captain’s hat does not count). Roast pig, hula, and Howell hospitality.',
    },

    // Sunday 06-21
    {
      title: 'Sunday Rescue-Watch (All Hands)',
      who: 'skipper', guests: ['skipper', 'professor', 'gilligan', 'maryann', 'ginger', 'howell', 'lovey'],
      date: '2026-06-21', start: '09:00', end: '12:00',
      location: 'Lookout Point + signal fire',
      desc: 'Full-roster horizon watch. Mirrors, fire, bottles, and the big HELP stamped in the sand. This is the week we get off this island. (We say that every week.)',
    },
  ];

  // ---- 4. Idempotency: list events already in the window by title. ----
  const winStart = at('2026-06-14', '00:00');
  const winEnd = at('2026-06-22', '00:00');
  const existing = asArr(
    await book(ORGANIZER, 'GET',
      `/events?calendar_ids=${cal.id}&start_after=${encodeURIComponent(winStart)}&start_before=${encodeURIComponent(winEnd)}&limit=500`),
  );
  // start_at is stored UTC; convert back to the Honolulu local date (UTC-10)
  // so the dedupe key lines up with the human-facing ev.date.
  const localDate = (utcIso) =>
    utcIso ? new Date(Date.parse(utcIso) - 10 * 60 * 60 * 1000).toISOString().slice(0, 10) : '';
  const existingTitles = new Set(existing.map((e) => `${e.title}|${localDate(e.start_at)}`));

  let made = 0;
  let skipped = 0;
  const failures = [];
  for (const ev of EVENTS) {
    const dedupeKey = `${ev.title}|${ev.date}`;
    if (existingTitles.has(dedupeKey)) {
      console.log(`event exists: ${ev.title} (${ev.date}) — skipping`);
      skipped++;
      continue;
    }
    const body = {
      calendar_id: cal.id,
      title: ev.title,
      description: ev.desc,
      location: ev.location,
      start_at: at(ev.date, ev.start),
      end_at: at(ev.date, ev.end),
      timezone: TZ,
      status: 'confirmed',
      visibility: 'busy',
      attendees: att(...ev.guests),
    };
    try {
      const created = await book(ev.who, 'POST', '/events', body);
      console.log(`event: ${ev.title} — ${ev.date} ${ev.start}–${ev.end} (${created.id})`);
      made++;
    } catch (e) {
      console.log(`  event FAILED: ${ev.title} (${ev.date}) — ${e.message}`);
      failures.push(`${ev.title} (${ev.date}): ${e.message}`);
    }
  }

  // ---- 5. Public booking page (idempotent via slug). ----
  const PAGE_SLUG = 'rescue-consultation';
  const pages = asArr(await book('professor', 'GET', '/booking-pages'));
  let page = pages.find((p) => p.slug === PAGE_SLUG);
  if (!page) {
    try {
      page = await book('professor', 'POST', '/booking-pages', {
        slug: PAGE_SLUG,
        title: 'Book a Rescue Consultation with the Professor',
        description:
          'Have an escape plan? A coconut-based invention? A question about tides, signal fires, or why the radio works but the boat doesn’t? Book 30 minutes with the Professor. Bamboo notepad provided.',
        duration_minutes: 30,
        buffer_before_min: 5,
        buffer_after_min: 5,
        max_advance_days: 30,
        min_notice_hours: 2,
        color: '#0ea5e9',
        confirmation_message:
          'You’re booked! Meet at the lab hut. Bring coconuts. Rescue not guaranteed, but the Professor will draw you a very convincing diagram.',
      });
      console.log(`booking page: /meet/${PAGE_SLUG} (${page.id})`);
    } catch (e) {
      console.log(`  booking page FAILED: ${e.message}`);
      failures.push(`booking page (${PAGE_SLUG}): ${e.message}`);
    }
  } else {
    console.log(`booking page exists: /meet/${PAGE_SLUG} (${page.id})`);
  }

  console.log(
    `\nBook seed done: ${made} events created, ${skipped} already present, ${failures.length} failures.`,
  );
  if (failures.length) {
    console.log('failures:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
