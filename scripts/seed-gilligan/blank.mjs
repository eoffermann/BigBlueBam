/**
 * Gilligan's Island themed Blank (forms) seed.
 *
 * Island intake / RSVP / report forms for "Gilligan Travel, Ltd." — the
 * castaways' (entirely optimistic) excursion company. Idempotent: a form is
 * skipped if one with the same name already exists; submissions are only added
 * to a form that has none yet.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/blank.mjs
 * (the api container can reach the internal blank-api host; cast API keys
 *  authenticate via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 *
 * Endpoint notes (confirmed against apps/blank-api/src/routes + server.ts):
 *   - Authenticated form/field/publish routes are under /v1.
 *   - The PUBLIC submit route is mounted at the ROOT (no /v1 prefix):
 *       POST /forms/:slug/submit  body { response_data, email? }
 *     It validates response_data against the field definitions (required,
 *     type, and select-option membership), so the submitted values below match
 *     each field's declared option `value`s and types exactly.
 */

const BLANK = 'http://blank-api:4013';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

function H(who, hasBody) {
  // Only declare a JSON content-type when we actually send a body — bodyless
  // POSTs (e.g. /publish) otherwise trip Fastify's FST_ERR_CTP_EMPTY_JSON_BODY.
  const h = { Authorization: `Bearer ${KEYS[who]}` };
  if (hasBody) h['Content-Type'] = 'application/json';
  return h;
}
async function blank(who, method, path, body) {
  const r = await fetch(`${BLANK}${path}`, {
    method,
    headers: H(who, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data.data ?? data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));
const opt = (value, label) => ({ value, label });

// ---------------------------------------------------------------------------
// Forms. Each: name, slug, owner (cast key), description, fields[], submissions[].
// submissions[].email is optional; .by is just a comment of who "filled it in".
// Submission keys MUST match field_key; select values MUST match an option value.
// ---------------------------------------------------------------------------
const FORMS = [
  {
    name: 'Castaway Intake Form',
    slug: 'castaway-intake-form',
    owner: 'skipper',
    description:
      'New to our little island? Fill this out so we know who you are, how you got marooned, and what you can do besides complain about the heat.',
    form_type: 'public',
    fields: [
      { field_key: 'full_name', label: 'Full name (or what we should yell when the tide comes in)', field_type: 'short_text', required: true },
      {
        field_key: 'arrival_method', label: 'How did you arrive on the island?', field_type: 'single_select', required: true,
        options: [opt('shipwreck', 'Shipwreck (welcome to the club)'), opt('plane', 'Plane crash'), opt('raft', 'Homemade raft'), opt('washed_ashore', 'Just washed ashore, no idea'), opt('three_hour_tour', 'Three-hour tour gone wrong')],
      },
      {
        field_key: 'skills', label: 'Useful island skills (check all that apply)', field_type: 'multi_select',
        options: [opt('fishing', 'Fishing'), opt('coconut_engineering', 'Coconut engineering'), opt('hut_building', 'Hut building'), opt('first_aid', 'First aid'), opt('morale', 'Keeping morale up'), opt('cooking', 'Cooking'), opt('navigation', 'Navigation')],
      },
      { field_key: 'dietary_needs', label: 'Dietary needs or allergies (we mostly have coconut)', field_type: 'long_text', placeholder: 'e.g. allergic to shellfish, vegetarian, will not eat another coconut' },
      { field_key: 'castaway_since', label: 'Castaway since (date of arrival)', field_type: 'date' },
    ],
    submissions: [
      { by: 'Gilligan', email: 'gilligan@gilligantravel.example', response_data: {
        full_name: 'Gilligan', arrival_method: 'three_hour_tour',
        skills: ['fishing', 'morale'],
        dietary_needs: 'I will eat literally anything, especially if it is the Skipper’s lunch.',
        castaway_since: '1964-09-26',
      } },
      { by: 'The Professor', email: 'professor@gilligantravel.example', response_data: {
        full_name: 'Roy Hinkley (The Professor)', arrival_method: 'three_hour_tour',
        skills: ['coconut_engineering', 'first_aid', 'navigation'],
        dietary_needs: 'None, though a balanced diet would aid cognitive function for radio repair.',
        castaway_since: '1964-09-26',
      } },
      { by: 'Mary Ann', email: 'maryann@gilligantravel.example', response_data: {
        full_name: 'Mary Ann Summers', arrival_method: 'three_hour_tour',
        skills: ['cooking', 'hut_building', 'morale'],
        dietary_needs: 'Saving the last of the sugar for a coconut cream pie. Hands off.',
        castaway_since: '1964-09-26',
      } },
      { by: 'Ginger', email: 'ginger@gilligantravel.example', response_data: {
        full_name: 'Ginger Grant', arrival_method: 'three_hour_tour',
        skills: ['morale'],
        dietary_needs: 'A girl can only do so much glamour on coconuts and fish.',
        castaway_since: '1964-09-26',
      } },
    ],
  },
  {
    name: 'Howell Luau RSVP',
    slug: 'howell-luau-rsvp',
    owner: 'lovey',
    description:
      'The Howells cordially request the pleasure of your company at this season’s most exclusive island gala. (Attendance is, frankly, mandatory — there is nowhere else to be.)',
    form_type: 'public',
    fields: [
      { field_key: 'guest_name', label: 'Your name', field_type: 'short_text', required: true },
      {
        field_key: 'attending', label: 'Will you attend?', field_type: 'single_select', required: true,
        options: [opt('yes', 'Delighted to attend'), opt('no', 'Regretfully declines'), opt('maybe', 'Pending rescue')],
      },
      { field_key: 'party_size', label: 'Number in your party', field_type: 'number', placeholder: '1' },
      {
        field_key: 'formalwear', label: 'Will you be in formalwear?', field_type: 'single_select',
        options: [opt('yes', 'Yes, naturally'), opt('no', 'My only outfit is salt-stained'), opt('borrowing', 'Borrowing from Mr. Howell’s steamer trunk')],
      },
      { field_key: 'song_request', label: 'Song request for the floor show', field_type: 'short_text', placeholder: 'something with a ukulele' },
      { field_key: 'notes_for_host', label: 'A note for the Howells', field_type: 'long_text' },
    ],
    submissions: [
      { by: 'Thurston Howell III', email: 'howell@gilligantravel.example', response_data: {
        guest_name: 'Thurston Howell III', attending: 'yes', party_size: 2, formalwear: 'yes',
        song_request: 'Anything but that dreadful ukulele',
        notes_for_host: 'Lovey and I shall arrive fashionably late and leave fashionably solvent.',
      } },
      { by: 'Lovey Howell', email: 'lovey@gilligantravel.example', response_data: {
        guest_name: 'Eunice "Lovey" Howell', attending: 'yes', party_size: 2, formalwear: 'yes',
        song_request: 'A waltz, if the Professor can fashion a phonograph',
        notes_for_host: 'Do remind the catering staff (Mary Ann) that I take my coconut milk chilled.',
      } },
      { by: 'The Skipper', email: 'skipper@gilligantravel.example', response_data: {
        guest_name: 'Jonas Grumby (The Skipper)', attending: 'yes', party_size: 1, formalwear: 'borrowing',
        song_request: 'Something nautical',
        notes_for_host: 'I’ll come if Gilligan promises not to capsize the punch bowl. Again.',
      } },
      { by: 'Ginger', email: 'ginger@gilligantravel.example', response_data: {
        guest_name: 'Ginger Grant', attending: 'yes', party_size: 1, formalwear: 'yes',
        song_request: 'Give me a sultry torch number and a spotlight',
        notes_for_host: 'I’ll be doing the hula floor show. Try to keep the Skipper’s eyes in his head.',
      } },
      { by: 'Gilligan', email: 'gilligan@gilligantravel.example', response_data: {
        guest_name: 'Gilligan', attending: 'maybe', party_size: 1, formalwear: 'no',
        song_request: 'The one about the little buddy',
        notes_for_host: 'I want to come but the Skipper said I’m on pig-roast duty and NOT to eat it.',
      } },
    ],
  },
  {
    name: 'Daily Coconut Count',
    slug: 'daily-coconut-count',
    owner: 'maryann',
    description:
      'Our island ledger. Log each day’s coconut harvest and fish catch so we know whether we’re feasting or rationing. Honesty appreciated; Gilligan, that means you.',
    form_type: 'internal',
    fields: [
      { field_key: 'log_date', label: 'Date', field_type: 'date', required: true },
      { field_key: 'logged_by', label: 'Logged by', field_type: 'short_text', required: true },
      { field_key: 'coconuts_gathered', label: 'Coconuts gathered', field_type: 'number', required: true },
      { field_key: 'fish_caught', label: 'Fish caught', field_type: 'number' },
      {
        field_key: 'weather', label: 'Weather', field_type: 'single_select',
        options: [opt('sunny', 'Sunny'), opt('cloudy', 'Cloudy'), opt('rain', 'Tropical rain'), opt('storm', 'Storm rolling in')],
      },
      { field_key: 'notes', label: 'Notes from the field', field_type: 'long_text', placeholder: 'Anything the supply chief should know' },
    ],
    submissions: [
      { by: 'Mary Ann', response_data: {
        log_date: '1964-09-28', logged_by: 'Mary Ann', coconuts_gathered: 47, fish_caught: 6,
        weather: 'sunny', notes: 'Good haul. Set 12 coconuts aside for the luau and a pie.',
      } },
      { by: 'Gilligan', response_data: {
        log_date: '1964-09-29', logged_by: 'Gilligan', coconuts_gathered: 3, fish_caught: 0,
        weather: 'cloudy', notes: 'Fell out of the tree twice. The fish were faster than me.',
      } },
      { by: 'The Professor', response_data: {
        log_date: '1964-09-30', logged_by: 'The Professor', coconuts_gathered: 31, fish_caught: 9,
        weather: 'rain', notes: 'Rigged a tidal fish trap from bamboo. Yield up 40% over hand-lining.',
      } },
      { by: 'The Skipper', response_data: {
        log_date: '1964-10-01', logged_by: 'The Skipper', coconuts_gathered: 22, fish_caught: 14,
        weather: 'storm', notes: 'Battened down the hut and still landed a big one. Gilligan, take notes.',
      } },
    ],
  },
  {
    name: 'Rescue Sighting Report',
    slug: 'rescue-sighting-report',
    owner: 'professor',
    description:
      'See something on the horizon? Report it immediately so we can light the signal fire. Ships, planes, passing yachts — we are not picky. False alarms are forgiven; missed rescues are not.',
    form_type: 'public',
    fields: [
      { field_key: 'reporter_name', label: 'Your name', field_type: 'short_text', required: true },
      {
        field_key: 'what_you_saw', label: 'What did you see?', field_type: 'single_select', required: true,
        options: [opt('ship', 'A ship'), opt('plane', 'An airplane'), opt('helicopter', 'A helicopter'), opt('boat', 'A small boat or yacht'), opt('other', 'Something else entirely')],
      },
      { field_key: 'bearing', label: 'Bearing / direction (compass heading or "off the north point")', field_type: 'short_text' },
      { field_key: 'time_sighted', label: 'Time sighted', field_type: 'time' },
      {
        field_key: 'did_you_signal', label: 'Did you signal it?', field_type: 'single_select', required: true,
        options: [opt('yes', 'Yes — fire/mirror/flare'), opt('no', 'No, ran to get help first'), opt('tried', 'Tried, but it kept going')],
      },
      { field_key: 'description', label: 'Describe what you saw', field_type: 'long_text', placeholder: 'Size, color, did it change course, was it Gilligan in a hat again' },
    ],
    submissions: [
      { by: 'The Skipper', email: 'skipper@gilligantravel.example', response_data: {
        reporter_name: 'The Skipper', what_you_saw: 'ship', bearing: 'NNW, off the north point',
        time_sighted: '06:45', did_you_signal: 'yes',
        description: 'Cargo freighter, gray hull, two stacks. Lit the signal fire. It did not turn. It never turns.',
      } },
      { by: 'Gilligan', email: 'gilligan@gilligantravel.example', response_data: {
        reporter_name: 'Gilligan', what_you_saw: 'other', bearing: 'Straight up?',
        time_sighted: '13:10', did_you_signal: 'tried',
        description: 'I’m pretty sure it was a really big seagull. I waved at it. It waved back. Maybe.',
      } },
      { by: 'The Professor', email: 'professor@gilligantravel.example', response_data: {
        reporter_name: 'The Professor', what_you_saw: 'plane', bearing: 'Heading 270, high altitude',
        time_sighted: '09:20', did_you_signal: 'yes',
        description: 'Four-engine transport at cruising altitude. Deployed coconut-shell mirror array. No acknowledgment observed.',
      } },
    ],
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  let formsCreated = 0;
  let formsExisting = 0;
  let fieldsCreated = 0;
  let subsCreated = 0;
  const failures = [];
  const report = [];

  for (const spec of FORMS) {
    const who = spec.owner;
    let form;
    try {
      // Find-or-create by name (idempotent).
      const existing = asArr(await blank(who, 'GET', '/v1/forms'));
      form = existing.find((f) => f.name === spec.name);

      if (!form) {
        const created = await blank(who, 'POST', '/v1/forms', {
          name: spec.name,
          slug: spec.slug,
          description: spec.description,
          form_type: spec.form_type ?? 'public',
          fields: spec.fields,
        });
        form = created;
        formsCreated++;
        fieldsCreated += spec.fields.length;
        console.log(`form: ${spec.name} (${form.id}) +${spec.fields.length} fields`);
      } else {
        formsExisting++;
        console.log(`form exists: ${spec.name} (${form.id})`);
      }

      // Publish (idempotent — publish throws "already published"; tolerate it).
      if (form.status !== 'published') {
        try {
          await blank(who, 'POST', `/v1/forms/${form.id}/publish`);
          console.log(`  published`);
        } catch (e) {
          if (/already published/i.test(e.message)) {
            console.log(`  already published`);
          } else {
            throw e;
          }
        }
      } else {
        console.log(`  already published`);
      }
    } catch (e) {
      failures.push(`form "${spec.name}": ${e.message}`);
      console.log(`  FORM FAILED: ${e.message}`);
      continue;
    }

    // Seed submissions only if the form has none yet (idempotent).
    let existingSubCount = 0;
    try {
      const subs = asArr(await blank(who, 'GET', `/v1/forms/${form.id}/submissions?limit=5`));
      existingSubCount = subs.length;
    } catch { /* treat as zero */ }

    let madeForThisForm = 0;
    if (existingSubCount === 0 && spec.submissions?.length) {
      for (const sub of spec.submissions) {
        try {
          // PUBLIC submit route: NO /v1 prefix, keyed by slug.
          await blank(who, 'POST', `/forms/${spec.slug}/submit`, {
            response_data: sub.response_data,
            ...(sub.email ? { email: sub.email } : {}),
          });
          subsCreated++;
          madeForThisForm++;
        } catch (e) {
          failures.push(`submission (${spec.name}, ${sub.by}): ${e.message}`);
          console.log(`  submission failed (${sub.by}): ${e.message}`);
        }
      }
      console.log(`  + ${madeForThisForm} submissions`);
    } else if (existingSubCount > 0) {
      console.log(`  submissions already present (${existingSubCount}+), skipping`);
    }

    report.push({
      form: spec.name,
      fields: spec.fields.length,
      submissions_added: madeForThisForm,
      submissions_existing: existingSubCount,
    });
  }

  console.log('\n===== Blank (forms) seed summary =====');
  for (const r of report) {
    console.log(
      `  ${r.form}: ${r.fields} fields, +${r.submissions_added} submissions` +
        (r.submissions_existing ? ` (${r.submissions_existing} pre-existing)` : ''),
    );
  }
  console.log(
    `\nForms: ${formsCreated} created, ${formsExisting} pre-existing. ` +
      `Fields created: ${fieldsCreated}. Submissions created: ${subsCreated}.`,
  );
  if (failures.length) {
    console.log(`\nFailures (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\nNo failures.');
  }
})().catch((e) => {
  console.error('blank seed failed:', e.message);
  process.exit(1);
});
