/**
 * Gilligan's Island themed Blueprint collaboration seed.
 *
 * Layers in-character collaboration content onto an EXISTING seeded diagram
 * (default "Coconut Radio — Wiring Diagram", produced by blueprint.mjs) so the
 * editor's three right-side panels — Comments, People (collaborators), and
 * History (versions) — all render populated for screenshots and demos:
 *
 *   - 2-3 anchored comments (a couple pinned to nodes, one diagram-level), each
 *     authored by a different cast member.
 *   - 1-2 direct collaborators (cast members) with explicit roles, added by the
 *     diagram owner (the Professor).
 *   - 2 named version snapshots ("Initial wiring", "After Professor's review").
 *
 * Idempotent: comments are matched by a leading marker token, collaborators by
 * user_id, versions by label — so a re-run adds nothing.
 *
 * Run from the repo host (cast API keys authenticate via Bearer, which bypasses
 * CSRF and scopes to the Gilligan org; the api container can reach the internal
 * blueprint-api host):
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/blueprint-collab.mjs
 */

// Blueprint API internal host. Routes live under /v1 (see
// apps/blueprint-api/src/server.ts: register(..., { prefix: '/v1' })).
const API = 'http://blueprint-api:4015/v1';
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

// The diagram we decorate. Owned by the Professor (see blueprint.mjs author).
const TARGET_DIAGRAM = 'Coconut Radio — Wiring Diagram';
const OWNER = 'professor';

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
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

// Each comment carries an invisible marker token so re-runs can detect it.
// The token is just a short stable string we look for in the persisted body.
const COMMENTS = [
  {
    author: 'professor',
    marker: '[seed:radio-c1]',
    nodeRef: 'crystal',
    body:
      '[seed:radio-c1] The cat-whisker keeps slipping off the galena. I have re-seated it three times this week. Someone (Gilligan) leaned on the table.',
  },
  {
    author: 'skipper',
    marker: '[seed:radio-c2]',
    nodeRef: 'earpiece',
    body:
      "[seed:radio-c2] Little buddy — the earpiece is NOT a snack. I have labeled it. Do not eat the equipment.",
  },
  {
    author: 'maryann',
    marker: '[seed:radio-c3]',
    nodeRef: null, // diagram-level
    body:
      '[seed:radio-c3] If you need more copper, the good pie tins are off limits. Use the dented one in the back of the supply hut.',
  },
];

// Direct collaborators added by the owner (Professor). Roles chosen in-character:
// the Skipper co-owns the rescue tech; Gilligan can comment but must not edit.
const COLLABORATORS = [
  { who: 'skipper', role: 'editor' },
  { who: 'gilligan', role: 'commenter' },
];

// Named version snapshots, taken by the owner.
const VERSIONS = [
  { who: 'professor', label: 'Initial wiring' },
  { who: 'professor', label: "After Professor's review" },
];

// Local ref -> node label fragments, so we can resolve a node id by matching
// the seeded node labels from blueprint.mjs without persisting the local refs.
const NODE_LABEL_HINTS = {
  antenna: 'Longwire Antenna',
  coil: 'Tuning Coil',
  crystal: 'Galena Crystal',
  battery: 'Coconut Battery',
  earpiece: 'Earpiece',
  ground: 'Ground Stake',
};

(async () => {
  const failures = [];
  let commentsAdded = 0;
  let commentsSkipped = 0;
  let collabsAdded = 0;
  let collabsSkipped = 0;
  let versionsAdded = 0;
  let versionsSkipped = 0;

  // 1. Resolve the target diagram (owner's visible list).
  const diagrams = asArr(await api(OWNER, 'GET', '/diagrams'));
  const diagram = diagrams.find((d) => d.name === TARGET_DIAGRAM && !d.is_archived);
  if (!diagram) {
    console.error(
      `Target diagram not found: "${TARGET_DIAGRAM}". Run scripts/seed-gilligan/blueprint.mjs first.`,
    );
    process.exit(1);
  }
  console.log(`target diagram: ${diagram.name} (${diagram.id})`);

  // Resolve node ids by label hint for anchored comments.
  const nodes = asArr(await api(OWNER, 'GET', `/diagrams/${diagram.id}/nodes`));
  const nodeIdByRef = {};
  for (const [ref, hint] of Object.entries(NODE_LABEL_HINTS)) {
    const match = nodes.find((n) => typeof n.label === 'string' && n.label.includes(hint));
    if (match) nodeIdByRef[ref] = match.id;
  }

  // 2. Comments — idempotent by marker token in the persisted body.
  const existingComments = asArr(await api(OWNER, 'GET', `/diagrams/${diagram.id}/comments`));
  const haveMarker = (marker) =>
    existingComments.some(
      (c) =>
        (typeof c.body === 'string' && c.body.includes(marker)) ||
        (typeof c.body_plain === 'string' && c.body_plain.includes(marker)),
    );

  for (const c of COMMENTS) {
    if (haveMarker(c.marker)) {
      console.log(`  comment exists — skip: ${c.marker}`);
      commentsSkipped++;
      continue;
    }
    const nodeId = c.nodeRef ? nodeIdByRef[c.nodeRef] ?? null : null;
    if (c.nodeRef && !nodeId) {
      console.log(`  comment anchor node missing (${c.nodeRef}) — posting diagram-level: ${c.marker}`);
    }
    try {
      await api(c.author, 'POST', `/diagrams/${diagram.id}/comments`, {
        body: c.body,
        body_plain: c.body,
        node_id: nodeId,
      });
      commentsAdded++;
      console.log(
        `  + comment by ${c.author}${nodeId ? ` on ${c.nodeRef}` : ' (diagram-level)'}: ${c.marker}`,
      );
    } catch (e) {
      console.log(`  comment failed: ${c.marker} — ${e.message}`);
      failures.push(`comment ${c.marker}: ${e.message}`);
    }
  }

  // 3. Collaborators — idempotent by user_id.
  const existingCollabs = asArr(await api(OWNER, 'GET', `/diagrams/${diagram.id}/collaborators`));
  const collabUserIds = new Set(existingCollabs.map((c) => c.user_id));
  for (const col of COLLABORATORS) {
    const userId = CAST[col.who];
    if (collabUserIds.has(userId)) {
      console.log(`  collaborator exists — skip: ${col.who} (${col.role})`);
      collabsSkipped++;
      continue;
    }
    try {
      await api(OWNER, 'POST', `/diagrams/${diagram.id}/collaborators`, {
        user_id: userId,
        role: col.role,
      });
      collabsAdded++;
      console.log(`  + collaborator ${col.who} as ${col.role}`);
    } catch (e) {
      console.log(`  collaborator failed: ${col.who} — ${e.message}`);
      failures.push(`collaborator ${col.who}: ${e.message}`);
    }
  }

  // 4. Versions — idempotent by label.
  const existingVersions = asArr(await api(OWNER, 'GET', `/diagrams/${diagram.id}/versions`));
  const versionLabels = new Set(
    existingVersions.map((v) => (typeof v.label === 'string' ? v.label : null)).filter(Boolean),
  );
  for (const v of VERSIONS) {
    if (versionLabels.has(v.label)) {
      console.log(`  version exists — skip: "${v.label}"`);
      versionsSkipped++;
      continue;
    }
    try {
      await api(v.who, 'POST', `/diagrams/${diagram.id}/versions`, { label: v.label });
      versionsAdded++;
      console.log(`  + version "${v.label}" by ${v.who}`);
    } catch (e) {
      console.log(`  version failed: "${v.label}" — ${e.message}`);
      failures.push(`version "${v.label}": ${e.message}`);
    }
  }

  console.log(
    `\nBlueprint collab seed done: comments ${commentsAdded} added / ${commentsSkipped} skipped, ` +
      `collaborators ${collabsAdded} added / ${collabsSkipped} skipped, ` +
      `versions ${versionsAdded} added / ${versionsSkipped} skipped.`,
  );
  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('blueprint collab seed failed:', e.message);
  process.exit(1);
});
