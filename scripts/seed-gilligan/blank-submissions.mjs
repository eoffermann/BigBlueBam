/**
 * Gilligan's Island themed Blank (forms) seed — file-upload + email-notify +
 * login/domain-gate slice (task #68).
 *
 * Companion to scripts/seed-gilligan/blank.mjs. That script seeds four base
 * forms; this one adds ONE in-character form that exercises the
 * newly-built backend:
 *
 *   - apps/blank-api/src/lib/storage.ts  — real MinIO/S3 file storage for
 *     file_upload fields, reached through the public upload endpoint.
 *   - email-on-submit notifications      — notify_on_submit + notify_emails,
 *     dispatched by the worker blank-confirmation-email job.
 *   - login/allowed-domain enforcement   — requires_login + allowed_domains,
 *     enforced on the public submit + upload path (checkAccessGate).
 *
 * The form is "Castaway Rescue Request": a survival-supply request that asks
 * the would-be rescuee to attach a hand-drawn map of the island. It is
 * configured to require sign-in AND restrict submitters to the
 * @gilligantravel.example domain, and to email the rescue committee on every
 * submission. We submit with cast Bearer keys (so request.user is populated
 * and the login + domain gates both pass), uploading a real generated text
 * "map" file through the storage path for the file_upload field.
 *
 * Idempotent: the form is found-or-created by name; submissions are only added
 * if the form has none yet.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/blank-submissions.mjs
 *
 * Endpoint notes (confirmed against apps/blank-api/src/routes + public.routes.ts):
 *   - Authenticated form/field/publish/patch routes are under /v1.
 *   - The PUBLIC submit + upload routes are mounted at the ROOT (no /v1):
 *       POST /forms/:slug/upload  multipart { file, field_key } -> { storage_key, ... }
 *       POST /forms/:slug/submit  body { response_data, email?, attachments? }
 *     The auth preHandler runs on every route, so a cast Bearer key populates
 *     request.user — that authenticated email satisfies requires_login and the
 *     allowed_domains gate.
 */

// Node 22: Blob, FormData, fetch are all global. No imports needed.

const BLANK = 'http://blank-api:4013';
const KEYS = JSON.parse(process.env.GKEYS || '{}');
const DOMAIN = 'gilligantravel.example';

function H(who, hasBody) {
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

/** Upload one file through the REAL public upload path (multipart -> MinIO). */
async function uploadFile(who, slug, fieldKey, filename, contentType, contents) {
  const fd = new FormData();
  fd.set('field_key', fieldKey);
  fd.set('file', new Blob([contents], { type: contentType }), filename);
  const r = await fetch(`${BLANK}/forms/${slug}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEYS[who]}` },
    body: fd,
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!r.ok) throw new Error(`upload ${slug} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data.data ?? data; // { field_key, filename, content_type, size, storage_key }
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));
const opt = (value, label) => ({ value, label });

// ---------------------------------------------------------------------------
// The form spec.
// ---------------------------------------------------------------------------
const FORM = {
  name: 'Castaway Rescue Request',
  slug: 'castaway-rescue-request',
  owner: 'professor',
  description:
    'Stranded and need supplies, a search party, or a ride home? File an official request with the rescue committee. Attach your best hand-drawn map of the island so we know where to dig the SOS.',
  form_type: 'public',
  // requires_login goes in the create call (createFormSchema supports it);
  // notify_* and allowed_domains are set in a follow-up PATCH below.
  requires_login: true,
  fields: [
    { field_key: 'requester_name', label: 'Your name', field_type: 'short_text', required: true },
    {
      field_key: 'urgency', label: 'How urgent is this?', field_type: 'single_select', required: true,
      options: [
        opt('low', 'Low — we are fine, just bored'),
        opt('medium', 'Medium — running low on supplies'),
        opt('high', 'High — the hut is on fire (again)'),
        opt('critical', 'Critical — Gilligan did something'),
      ],
    },
    {
      field_key: 'needs', label: 'What do you need? (check all that apply)', field_type: 'multi_select',
      options: [
        opt('food', 'Food and fresh water'),
        opt('medical', 'Medical supplies'),
        opt('rescue_boat', 'A rescue boat'),
        opt('radio_parts', 'Radio parts'),
        opt('tools', 'Tools and materials'),
        opt('morale', 'Morale (and maybe a pie)'),
      ],
    },
    { field_key: 'last_known_position', label: 'Last known position / landmark', field_type: 'short_text' },
    { field_key: 'island_map', label: 'Hand-drawn map of the island (attach a file)', field_type: 'file_upload' },
    { field_key: 'extra_notes', label: 'Anything else the rescue committee should know', field_type: 'long_text' },
  ],
  // Submissions. `with_file` triggers a real upload for the island_map field.
  submissions: [
    {
      by: 'The Professor', who: 'professor', with_file: true,
      response_data: {
        requester_name: 'Roy Hinkley (The Professor)', urgency: 'high',
        needs: ['radio_parts', 'tools'],
        last_known_position: 'Lagoon, 200m east of the bamboo workshop',
        extra_notes:
          'A vacuum tube and 30cm of copper wire would let me complete the transmitter. Map enclosed, drawn to scale with a coconut-fiber compass rose.',
      },
    },
    {
      by: 'The Skipper', who: 'skipper', with_file: false,
      response_data: {
        requester_name: 'Jonas Grumby (The Skipper)', urgency: 'medium',
        needs: ['food', 'rescue_boat'],
        last_known_position: 'North beach, by the wreck of the Minnow',
        extra_notes: 'A seaworthy hull and we are home by supper. Gilligan is NOT to steer.',
      },
    },
    {
      by: 'Mary Ann', who: 'maryann', with_file: false,
      response_data: {
        requester_name: 'Mary Ann Summers', urgency: 'low',
        needs: ['food', 'morale'],
        last_known_position: 'The vegetable garden behind the supply hut',
        extra_notes: 'Flour and sugar, please. Morale on this island is one good pie away from saved.',
      },
    },
    {
      by: 'Thurston Howell III', who: 'howell', with_file: false,
      response_data: {
        requester_name: 'Thurston Howell III', urgency: 'critical',
        needs: ['rescue_boat', 'morale'],
        last_known_position: 'The Howell estate (the nicer cave)',
        extra_notes:
          'I will fund the entire rescue operation. Send a yacht, a valet, and a case of the 1959 vintage. Bill it to the Howell trust.',
      },
    },
    {
      by: 'Gilligan', who: 'gilligan', with_file: true,
      response_data: {
        requester_name: 'Gilligan', urgency: 'critical',
        needs: ['morale', 'medical'],
        last_known_position: 'Up a tree. Possibly the wrong tree.',
        extra_notes:
          'I drew a map but I think I held the paper upside down. Also I may have sat on the SOS. Sorry, Skipper.',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  const failures = [];
  let form;

  // 1. Find-or-create the form (idempotent by name).
  try {
    const existing = asArr(await blank(FORM.owner, 'GET', '/v1/forms'));
    form = existing.find((f) => f.name === FORM.name);
    if (!form) {
      form = await blank(FORM.owner, 'POST', '/v1/forms', {
        name: FORM.name,
        slug: FORM.slug,
        description: FORM.description,
        form_type: FORM.form_type,
        requires_login: FORM.requires_login,
        fields: FORM.fields,
      });
      console.log(`form created: ${FORM.name} (${form.id}) +${FORM.fields.length} fields`);
    } else {
      console.log(`form exists: ${FORM.name} (${form.id})`);
    }
  } catch (e) {
    console.error(`FORM CREATE FAILED: ${e.message}`);
    process.exit(1);
  }

  // 2. Configure the email-notify + login/domain gate (PATCH — these fields
  //    are not on the create schema). Idempotent: PATCH is a straight upsert.
  try {
    await blank(FORM.owner, 'PATCH', `/v1/forms/${form.id}`, {
      requires_login: true,
      allowed_domains: [DOMAIN],
      notify_on_submit: true,
      notify_emails: [`rescue-committee@${DOMAIN}`, `professor@${DOMAIN}`],
    });
    console.log(
      `  settings: requires_login=true, allowed_domains=[${DOMAIN}], notify_on_submit=true, notify_emails=2`,
    );
  } catch (e) {
    failures.push(`settings PATCH: ${e.message}`);
    console.log(`  SETTINGS PATCH FAILED: ${e.message}`);
  }

  // 3. Publish (idempotent — tolerate "already published").
  if (form.status !== 'published') {
    try {
      await blank(FORM.owner, 'POST', `/v1/forms/${form.id}/publish`);
      console.log('  published');
    } catch (e) {
      if (/already published/i.test(e.message)) console.log('  already published');
      else { failures.push(`publish: ${e.message}`); console.log(`  PUBLISH FAILED: ${e.message}`); }
    }
  } else {
    console.log('  already published');
  }

  // 4. Submissions — only if the form has none yet (idempotent).
  let existingSubCount = 0;
  try {
    const subs = asArr(await blank(FORM.owner, 'GET', `/v1/forms/${form.id}/submissions?limit=5`));
    existingSubCount = subs.length;
  } catch { /* treat as zero */ }

  let made = 0;
  let uploaded = 0;
  if (existingSubCount === 0) {
    for (const sub of FORM.submissions) {
      try {
        let attachments;
        if (sub.with_file) {
          // Generate a small "map" file and push it through the real upload path.
          const mapText = [
            `ISLAND MAP — drawn by ${sub.response_data.requester_name}`,
            '====================================================',
            '',
            '          ~ ~ ~  PACIFIC OCEAN  ~ ~ ~',
            '        _______________________________',
            '       /   ^^   Lagoon        Palms ^^  \\',
            '      |   /==\\   ~~~~~       (hut)       |',
            '      |  | SOS |   Bamboo workshop  X    |',
            '       \\  \\==/      Signal fire o       /',
            '        \\___________________________ __/',
            '            ~ ~ ~  REEF  ~ ~ ~',
            '',
            `Last known position: ${sub.response_data.last_known_position}`,
            'X marks the spot to dig. Please hurry.',
          ].join('\n');
          const desc = await uploadFile(
            sub.who,
            FORM.slug,
            'island_map',
            `island-map-${sub.who}.txt`,
            'text/plain',
            mapText,
          );
          attachments = [desc];
          uploaded++;
          console.log(`  uploaded map for ${sub.by}: ${desc.size}B -> ${desc.storage_key}`);
        }

        // Submit WITH the cast Bearer key so request.user is populated and the
        // login + domain gates both pass (user email is @gilligantravel.example).
        await blank(sub.who, 'POST', `/forms/${FORM.slug}/submit`, {
          response_data: sub.response_data,
          ...(attachments ? { attachments } : {}),
        });
        made++;
      } catch (e) {
        failures.push(`submission (${sub.by}): ${e.message}`);
        console.log(`  submission failed (${sub.by}): ${e.message}`);
      }
    }
    console.log(`  + ${made} submissions (${uploaded} with a real uploaded file)`);
  } else {
    console.log(`  submissions already present (${existingSubCount}+), skipping`);
  }

  console.log('\n===== Castaway Rescue Request seed summary =====');
  console.log(`  form: ${FORM.name} (${form.id})`);
  console.log(`  fields: ${FORM.fields.length} (incl. 1 file_upload)`);
  console.log(`  submissions added: ${made}, files uploaded: ${uploaded}, pre-existing: ${existingSubCount}`);
  console.log('  gate: requires_login + allowed_domains=[gilligantravel.example]');
  console.log('  notify: notify_on_submit=true, recipients=rescue-committee@, professor@');

  if (failures.length) {
    console.log(`\nFailures (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\nNo failures.');
  }
})().catch((e) => {
  console.error('blank-submissions seed failed:', e.message);
  process.exit(1);
});
