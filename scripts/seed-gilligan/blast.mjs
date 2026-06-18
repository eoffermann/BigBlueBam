/**
 * Gilligan's Island themed Blast (email-campaigns) seed.
 *
 * The castaways' "outbound marketing": Luau invitations, rescue appeals
 * tide-released in bottles, and Thurston Howell III's coconut-export
 * newsletter. Idempotent: every template / segment / campaign is keyed by
 * name and skipped if one already exists.
 *
 * SAFETY: this script NEVER calls the campaign /send endpoint. /send enqueues
 * a real blast-send BullMQ job that would attempt SMTP delivery. Campaigns are
 * left as `draft` or `scheduled` only, so the campaign list + analytics look
 * populated without anything ever leaving the island. The public
 * tracking/unsubscribe endpoints are likewise never touched.
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/blast.mjs
 * (the api container can reach the internal blast-api host; cast API keys
 *  authenticate via Bearer, which bypasses CSRF and scopes to the Gilligan org.)
 */

const BLAST = 'http://blast-api:4010/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

function H(who) {
  const token = KEYS[who];
  if (!token) throw new Error(`No API key for "${who}" in GKEYS`);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function api(who, method, path, body) {
  const r = await fetch(`${BLAST}${path}`, {
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
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data.data ?? data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

// CAN-SPAM footer required by blast-api before a campaign can be scheduled or
// sent: must contain an unsubscribe marker AND a physical mailing address.
// Both are baked in here, in character.
const FOOTER = `
<hr/>
<p style="font-size:12px;color:#777;">
  Gilligan Travel, Ltd. &mdash; Hut #1, The Lagoon, P.O. Box 0 (washes ashore irregularly),
  Uncharted Isle, South Pacific.<br/>
  Tired of bottles on your beach? <a href="{{unsubscribe_url}}">Unsubscribe</a> and we promise to stop corking them.
</p>`;

// ---------------------------------------------------------------------------
// Templates (name, subject_template, html_body, template_type)
// ---------------------------------------------------------------------------
const TEMPLATES = [
  {
    owner: 'lovey',
    name: 'Luau Invitation',
    template_type: 'campaign',
    subject_template: '🌴 {{first_name}}, you are cordially invited to the Howell Luau',
    description: 'Lovey Howell\'s formal island-gala invitation. RSVP by carrier crab.',
    html_body: `
      <h1>The Howell Luau</h1>
      <p>Dear {{first_name}},</p>
      <p>Mr. Howell and I request the pleasure of your company at our annual
         Luau, held at the lagoon at sunset. Black tie optional; coconut bra
         encouraged. Mr. Gilligan has been instructed <em>not</em> to eat the
         centerpiece this year.</p>
      <p>There will be a roast pig, a hula floor show by Miss Ginger, and the
         famous (non-alcoholic, alas) Howell Punch.</p>
      <p>Kindly RSVP by return tide.</p>
      <p>Warmest regards,<br/>Mrs. Thurston Howell III</p>${FOOTER}`,
  },
  {
    owner: 'skipper',
    name: 'Rescue Appeal',
    template_type: 'campaign',
    subject_template: 'S.O.S. — seven souls would very much like a ride home',
    description: 'The Skipper\'s standing distress message for any vessel within tide-range.',
    html_body: `
      <h1>S.O.S.</h1>
      <p>To Whom It May Concern (preferably someone with a boat),</p>
      <p>We are seven castaways &mdash; one Skipper, one first mate of variable
         reliability, a Professor who can build a nuclear reactor out of a
         coconut but cannot patch a two-foot hole, a movie star, a farm girl,
         and a millionaire couple &mdash; stranded on an uncharted isle.</p>
      <p>If you are reading this, our message-in-a-bottle program is finally
         working. Please send help, a seaworthy vessel, and possibly a new hat.</p>
      <p>We have coconuts. So many coconuts.</p>
      <p>Standing by on all channels,<br/>The Skipper</p>${FOOTER}`,
  },
  {
    owner: 'howell',
    name: 'Coconut Catalog',
    template_type: 'campaign',
    subject_template: 'Kona Coconut Export Co. — {{first_name}}, the finest coconuts money can buy',
    description: 'Thurston Howell III\'s coconut-export catalog template. Premium tier only.',
    html_body: `
      <h1>Kona Coconut Export Co.</h1>
      <p>My dear {{first_name}},</p>
      <p>As the proprietor of the South Pacific's most exclusive coconut
         concern, I am pleased to present our summer selection. Each coconut is
         hand-harvested, monogrammed (additional fee), and shipped by the next
         passing freighter (delivery: indefinite).</p>
      <ul>
        <li><strong>The Newport</strong> &mdash; a robust drinking coconut. $40,000.</li>
        <li><strong>The Aristocrat</strong> &mdash; for the discerning palate. $80,000.</li>
        <li><strong>The Lovey</strong> &mdash; pre-shucked, gold-flecked. Priceless.</li>
      </ul>
      <p>Buy the island? My boy, I already <em>own</em> the island.</p>
      <p>Cordially,<br/>Thurston Howell III</p>${FOOTER}`,
  },
];

// ---------------------------------------------------------------------------
// Segments. filter_criteria fields map to bond_contacts columns
// (lifecycle_stage, lead_source, country, lead_score, ...). Counts resolve
// against whatever Bond contacts exist for the Gilligan org (0 is fine).
// ---------------------------------------------------------------------------
const SEGMENTS = [
  {
    owner: 'skipper',
    name: 'Passing Ships',
    description: 'Any vessel, freighter, or wayward yacht that might give seven people a lift.',
    filter_criteria: {
      match: 'any',
      conditions: [
        { field: 'lead_source', op: 'contains', value: 'ship' },
        { field: 'lead_source', op: 'contains', value: 'boat' },
        { field: 'lifecycle_stage', op: 'equals', value: 'lead' },
      ],
    },
  },
  {
    owner: 'ginger',
    name: "Hollywood Contacts (Ginger's list)",
    description: 'Producers, agents, and old flames who owe Ginger Grant a phone call.',
    filter_criteria: {
      match: 'any',
      conditions: [
        { field: 'lead_source', op: 'contains', value: 'hollywood' },
        { field: 'city', op: 'equals', value: 'Los Angeles' },
        { field: 'lead_score', op: 'greater_than', value: 50 },
      ],
    },
  },
  {
    owner: 'howell',
    name: 'Howell VIPs',
    description: 'Thurston\'s little black book: bankers, brokers, and fellow millionaires.',
    filter_criteria: {
      match: 'all',
      conditions: [
        { field: 'lifecycle_stage', op: 'equals', value: 'customer' },
        { field: 'lead_score', op: 'greater_than', value: 80 },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Campaigns. status: 'draft' (left as-is) or 'scheduled' (we call /schedule,
// which runs the CAN-SPAM check and stamps a future send time — but NEVER
// actually delivers because we never call /send).
// ---------------------------------------------------------------------------
const CAMPAIGNS = [
  {
    owner: 'lovey',
    status: 'scheduled',
    scheduleInDays: 7,
    name: "🌴 You're Invited: The Howell Luau",
    subject: '🌴 You are cordially invited to the Howell Luau',
    template: 'Luau Invitation',
    segment: 'Howell VIPs',
    from_name: 'Lovey Howell',
    from_email: 'lovey@gilligan-travel.example',
    html_body: `
      <h1>The Howell Luau — You're Invited!</h1>
      <p>Sunset, at the lagoon. Roast pig, hula, and Howell Punch.</p>
      <p>Mr. Gilligan has been told, in no uncertain terms, not to eat the
         centerpiece. We make no guarantees.</p>
      <p>RSVP by return tide.</p>
      <p>&mdash; Mrs. Thurston Howell III</p>${FOOTER}`,
  },
  {
    owner: 'skipper',
    status: 'scheduled',
    scheduleInDays: 1,
    name: 'S.O.S. — Help Us Get Off This Island',
    subject: 'S.O.S. — seven castaways seeking one (1) ride home',
    template: 'Rescue Appeal',
    segment: 'Passing Ships',
    from_name: 'The Skipper',
    from_email: 'skipper@gilligan-travel.example',
    html_body: `
      <h1>S.O.S.</h1>
      <p>If you are receiving this, our message-in-a-bottle program WORKS and we
         are thrilled. Now please come get us.</p>
      <p>Seven souls. One uncharted isle. An alarming surplus of coconuts.</p>
      <p>Any vessel will do. We are not picky. We have been here a while.</p>
      <p>Standing by,<br/>The Skipper</p>${FOOTER}`,
  },
  {
    owner: 'howell',
    status: 'draft',
    name: 'Kona Coconut Export — Summer Catalog',
    subject: 'Kona Coconut Export Co. — the finest coconuts money can buy',
    template: 'Coconut Catalog',
    segment: 'Howell VIPs',
    from_name: 'Thurston Howell III',
    from_email: 'thurston@kona-coconut.example',
    html_body: `
      <h1>Kona Coconut Export Co. — Summer Catalog</h1>
      <p>The Newport. The Aristocrat. The Lovey. Hand-harvested, monogrammed,
         shipped by the next passing freighter (ETA: indefinite).</p>
      <p>Prices start at a mere $40,000 per coconut. Volume discounts for fellow
         millionaires only.</p>
      <p>Cordially,<br/>Thurston Howell III</p>${FOOTER}`,
  },
  {
    owner: 'professor',
    status: 'draft',
    name: 'Castaway Newsletter, Vol. 1',
    subject: 'Castaway Newsletter, Vol. 1 — radio update, raft sea-trials, and a luau',
    template: 'Rescue Appeal',
    segment: "Hollywood Contacts (Ginger's list)",
    from_name: 'The Professor',
    from_email: 'professor@gilligan-travel.example',
    html_body: `
      <h1>Castaway Newsletter, Vol. 1</h1>
      <p>Greetings from the uncharted isle. A roundup of island happenings:</p>
      <ul>
        <li><strong>Radio:</strong> Receiver rebuilt from Minnow salvage; awaiting
            bicycle-generator charge (Gilligan pedaling).</li>
        <li><strong>Raft:</strong> Bamboo cured, sail sewn from the Howells' spare
            linens. Sea-trials at next high tide. Gilligan will NOT steer.</li>
        <li><strong>Social:</strong> The Howell Luau is on the calendar. Bring a lei.</li>
      </ul>
      <p>More next volume, assuming the bottle reaches you.</p>
      <p>Scientifically yours,<br/>The Professor</p>${FOOTER}`,
  },
];

(async () => {
  const summary = { templates: [], segments: [], campaigns: [] };

  // ---- Templates ----
  for (const tpl of TEMPLATES) {
    const existing = asArr(await api(tpl.owner, 'GET', `/templates?search=${encodeURIComponent(tpl.name)}&limit=20`));
    const found = existing.find((t) => t.name === tpl.name);
    if (found) {
      console.log(`template exists: ${tpl.name} (${found.id})`);
      summary.templates.push({ name: tpl.name, id: found.id, status: 'exists' });
      continue;
    }
    const created = await api(tpl.owner, 'POST', '/templates', {
      name: tpl.name,
      subject_template: tpl.subject_template,
      html_body: tpl.html_body,
      description: tpl.description,
      template_type: tpl.template_type,
    });
    console.log(`template: ${tpl.name} (${created.id})`);
    summary.templates.push({ name: tpl.name, id: created.id, status: 'created' });
  }

  // ---- Segments ----
  const segIds = {};
  // Refresh a segment's cached recipient count against Bond contacts. The
  // /count route requires a (possibly empty) JSON object body — sending none
  // with content-type application/json trips FST_ERR_CTP_EMPTY_JSON_BODY.
  async function refreshCount(owner, name, id) {
    try {
      const r = await api(owner, 'POST', `/segments/${id}/count`, {});
      return r.count ?? null;
    } catch (e) {
      console.log(`  count failed for ${name}: ${e.message}`);
      return null;
    }
  }
  for (const seg of SEGMENTS) {
    const existing = asArr(await api(seg.owner, 'GET', `/segments?search=${encodeURIComponent(seg.name)}&limit=20`));
    const found = existing.find((s) => s.name === seg.name);
    if (found) {
      segIds[seg.name] = found.id;
      const count = await refreshCount(seg.owner, seg.name, found.id);
      console.log(`segment exists: ${seg.name} (${found.id}) — ${count ?? '?'} recipients`);
      summary.segments.push({ name: seg.name, id: found.id, status: 'exists', count });
      continue;
    }
    const created = await api(seg.owner, 'POST', '/segments', {
      name: seg.name,
      description: seg.description,
      filter_criteria: seg.filter_criteria,
    });
    segIds[seg.name] = created.id;
    const count = await refreshCount(seg.owner, seg.name, created.id);
    console.log(`segment: ${seg.name} (${created.id}) — ${count ?? '?'} recipients`);
    summary.segments.push({ name: seg.name, id: created.id, status: 'created', count });
  }

  // Resolve segment name -> id for any segment we didn't just create.
  async function segmentIdFor(owner, name) {
    if (segIds[name]) return segIds[name];
    const existing = asArr(await api(owner, 'GET', `/segments?search=${encodeURIComponent(name)}&limit=20`));
    const found = existing.find((s) => s.name === name);
    if (found) segIds[name] = found.id;
    return found?.id;
  }

  // ---- Campaigns ----
  // List once per owner is cheap; campaigns list has no search param.
  for (const c of CAMPAIGNS) {
    const existing = asArr(await api(c.owner, 'GET', '/campaigns?limit=100'));
    const found = existing.find((x) => x.name === c.name);
    if (found) {
      console.log(`campaign exists: ${c.name} (${found.id}) [${found.status}]`);
      summary.campaigns.push({ name: c.name, id: found.id, status: found.status, action: 'exists' });
      continue;
    }

    const segment_id = c.segment ? await segmentIdFor(c.owner, c.segment) : undefined;

    const body = {
      name: c.name,
      subject: c.subject,
      html_body: c.html_body,
      from_name: c.from_name,
      from_email: c.from_email,
      ...(segment_id ? { segment_id } : {}),
    };

    const created = await api(c.owner, 'POST', '/campaigns', body);
    let finalStatus = created.status; // 'draft'

    if (c.status === 'scheduled') {
      const days = c.scheduleInDays ?? 3;
      const scheduledAt = new Date(Date.now() + days * 86400000).toISOString();
      try {
        const sched = await api(c.owner, 'POST', `/campaigns/${created.id}/schedule`, { scheduled_at: scheduledAt });
        finalStatus = sched.status ?? 'scheduled';
        console.log(`campaign: ${c.name} (${created.id}) [scheduled for ${scheduledAt}]`);
      } catch (e) {
        console.log(`  schedule failed for ${c.name}: ${e.message} (left as draft)`);
      }
    } else {
      console.log(`campaign: ${c.name} (${created.id}) [draft]`);
    }

    summary.campaigns.push({ name: c.name, id: created.id, status: finalStatus, action: 'created', segment: c.segment ?? null });
  }

  console.log('\n=== BLAST SEED SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  const tc = summary.templates.filter((t) => t.status === 'created').length;
  const sc = summary.segments.filter((s) => s.status === 'created').length;
  const cc = summary.campaigns.filter((c) => c.action === 'created').length;
  console.log(`\nBlast seed done: ${tc} templates, ${sc} segments, ${cc} campaigns created (rest pre-existing).`);
})().catch((e) => {
  console.error('blast seed failed:', e.message);
  process.exit(1);
});
