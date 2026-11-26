// Policies and version-pinned attestation (spec 3.6; 5.1 rows 64-71).
//
//   GET  /policies                         linked Beacon articles with who has and hasn't read the current version
//   POST /policies                         link an article (it must be shared with everyone: Organization or Public)
//   PATCH /policies/:id                    audience, cadence, owner, retire
//   GET  /policies/:id/body                the EXACT beacon_versions body for the current version and its SHA-256,
//                                          so what a person reads is what Bastion hashes; visibility re-checked
//                                          on every request ("This policy is no longer shared with everyone")
//   GET  /policies/:id/attestations        the required people, who acknowledged the current version within the
//                                          cadence, who has not, and who cannot even open the article (can_access
//                                          per audience member: "N people can't open this policy")
//   GET  /me/attestations                  the caller's own list
//   POST /policies/:id/attest              "I have read and understood this": a vouching route (session, never
//                                          impersonated, a human); pinned to the version and body hash served;
//                                          ledgered (entry kind `attestation`), personal data committed by HMAC
//   POST /policies/:id/request-attestations nudge the people still due (attestation.overdue, once per person,
//                                          version and day)
//
// Who is "required" is answered by the policy.attested probe itself (bastion_probe_policy_attested_v1),
// so the Policies page, the nudge and the nightly check can never disagree about it.

import type { BastionAttest, BastionPolicyCreate, BastionPolicyListQuery, BastionPolicyUpdate, BastionRequestAttestations } from '@bigbluebam/shared';
import { auditRaw } from '../lib/audit-raw.js';
import { beaconEntryIdBySlug } from '../lib/beacon-slug.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationFailure } from '../lib/errors.js';
import { canonicalJson, sha256Hex } from '../lib/ledger-canonical.js';
import { type EngineDeps, orgTx, type Tx, utcDate } from '../engine/context.js';
import { appendLedger } from '../engine/ledger.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import { queueControlRuns, type QueuedRun } from '../engine/evidence-store.js';
import type { CanAccess } from './decisions.service.js';
import { cannotOpen, entriesOpenTo } from '../lib/policy-access.js';
import { beginLedgerBatch, mapAppendError } from './ledger-batch.js';
import type { Viewer } from './types.js';

export interface PolicyDeps {
  engine: EngineDeps;
  canAccess: CanAccess;
  enqueueRuns: (runs: QueuedRun[]) => Promise<void>;
  /** Pin a control's two policy checks to a newly linked policy (services/policy-pins.ts). */
  pinChecks?: (viewer: Viewer, controlId: string, policyId: string) => Promise<string[]>;
}

export const NOT_SHARED_MESSAGE = 'This policy is no longer shared with everyone. Ask its owner to share it with the whole organization in Beacon.';
const SHARED_VISIBILITIES = new Set(['Organization', 'Public']);
const DAY_MS = 86_400_000;

export function sharedWithEveryone(visibility: string | null | undefined): boolean {
  return !!visibility && SHARED_VISIBILITIES.has(visibility);
}

/** The SHA-256 Bastion records: of the exact UTF-8 bytes of the served body. */
export function policyBodySha256(body: string): string {
  return sha256Hex(Buffer.from(body, 'utf8'));
}

/** What an attestation commits to in the ledger (the person's name is personal data, kept apart). */
export function attestationContentHash(a: {
  id: string;
  policy_id: string;
  beacon_entry_id: string;
  beacon_version: number;
  body_sha256: string;
  user_id: string;
  attested_at: Date;
}): string {
  return sha256Hex(canonicalJson({ ...a, attested_at: a.attested_at.toISOString() }));
}

interface PolicyRow {
  id: string;
  beacon_entry_id: string;
  title_cache: string | null;
  audience: { kind: 'all' } | { kind: 'users'; user_ids: string[] };
  cadence_days: number;
  owner_user_id: string | null;
  owner_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  entry_title: string | null;
  entry_status: string | null;
  visibility: string | null;
  version: number | null;
  expires_at: string | null;
  last_verified_at: string | null;
}

const POLICY_SELECT = `p.id, p.beacon_entry_id, p.title_cache, p.audience, p.cadence_days, p.owner_user_id, ou.display_name AS owner_name,
  p.status, p.created_at, p.updated_at, be.title AS entry_title, be.status::text AS entry_status, be.visibility::text AS visibility,
  be.version, be.expires_at, be.last_verified_at`;
const POLICY_FROM = `FROM bastion_policies p
  LEFT JOIN beacon_entries be ON be.id = p.beacon_entry_id AND be.organization_id = p.organization_id
  LEFT JOIN users ou ON ou.id = p.owner_user_id`;

async function loadPolicy(tx: Tx, orgId: string, id: string): Promise<PolicyRow> {
  const r = (await tx.unsafe(`SELECT ${POLICY_SELECT} ${POLICY_FROM} WHERE p.organization_id = $1 AND p.id = $2`, [orgId, id]))[0];
  if (!r) throw new NotFoundError('We could not find that policy.');
  return r as unknown as PolicyRow;
}

export interface PolicyFacts {
  beacon_version: number | null;
  required_people: number;
  not_attested_ids: string[];
  cadence_days: number;
}

/** The probe's own answer for "who must read it and who has not" (one fact, one place). */
export async function policyFacts(tx: Tx, orgId: string, policyId: string, asOf: Date): Promise<PolicyFacts> {
  const r = (await tx`SELECT bastion_probe_policy_attested_v1(${orgId}::uuid, ${asOf}, ${JSON.stringify({ policy_id: policyId })}::text::jsonb) AS f`)[0];
  const f = (r?.f ?? {}) as { summary?: Record<string, unknown>; cited_refs?: Array<{ entity_id: string }> };
  const s = f.summary ?? {};
  return {
    beacon_version: typeof s.beacon_version === 'number' ? s.beacon_version : null,
    required_people: Number(s.required_people ?? 0),
    not_attested_ids: (f.cited_refs ?? []).map((c) => String(c.entity_id)),
    cadence_days: Number(s.cadence_days ?? 365),
  };
}

/** Members of the audience who have a current attestation (version and cadence as the probe reads them). */
async function attestedPeople(tx: Tx, orgId: string, p: PolicyRow, version: number | null, asOf: Date) {
  if (version === null) return [];
  return tx`
    SELECT a.user_id, u.display_name, a.attested_at
      FROM bastion_policy_attestations a
      JOIN users u ON u.id = a.user_id
      JOIN organization_memberships m ON m.user_id = a.user_id AND m.org_id = ${orgId}
     WHERE a.organization_id = ${orgId} AND a.policy_id = ${p.id} AND a.beacon_version = ${version}
       AND a.attested_at <= ${asOf} AND a.attested_at > ${new Date(asOf.getTime() - p.cadence_days * DAY_MS)}
       AND u.kind = 'human' AND u.is_active
     ORDER BY a.attested_at`;
}

async function namesOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx`SELECT id, display_name FROM users WHERE id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [String(r.id), String(r.display_name)]));
}

/**
 * The policies whose Beacon article this viewer may see live (#236): still shared with everyone
 * AND can_access passes for the viewer (fail closed). For the rest, Bastion shows only what it
 * cached while the article was shared: never a title or dates Beacon itself would refuse them.
 */
async function liveFor(d: PolicyDeps, viewer: Viewer, rows: PolicyRow[]): Promise<Set<string>> {
  const shared = rows.filter((p) => sharedWithEveryone(p.visibility)).map((p) => p.beacon_entry_id);
  return entriesOpenTo(d.canAccess, viewer.id, shared);
}

function isLive(p: PolicyRow, open: Set<string>): boolean {
  return sharedWithEveryone(p.visibility) && open.has(p.beacon_entry_id);
}

function titleOf(p: PolicyRow, live: boolean): string {
  return (live ? p.entry_title : null) ?? p.title_cache ?? 'Untitled policy';
}

function shapePolicy(p: PolicyRow, facts: PolicyFacts | null, now: Date, live: boolean) {
  const shared = sharedWithEveryone(p.visibility);
  const expires = live && p.expires_at ? new Date(p.expires_at) : null;
  const attested = facts ? facts.required_people - facts.not_attested_ids.length : 0;
  return {
    id: p.id,
    beacon_entry_id: p.beacon_entry_id,
    title: titleOf(p, live),
    audience: p.audience,
    cadence_days: p.cadence_days,
    owner_user_id: p.owner_user_id,
    owner_name: p.owner_name,
    status: p.status,
    beacon_status: live ? p.entry_status : null,
    visibility: p.visibility,
    shared_with_everyone: shared,
    sharing_problem: p.entry_status === null ? 'This Beacon article no longer exists.' : shared ? null : NOT_SHARED_MESSAGE,
    current_version: p.version,
    expires_at: live ? p.expires_at : null,
    days_to_expiry: expires ? Math.floor((expires.getTime() - now.getTime()) / DAY_MS) : null,
    last_verified_at: live ? p.last_verified_at : null,
    required_people: facts?.required_people ?? 0,
    attested_count: attested,
    not_attested_count: facts?.not_attested_ids.length ?? 0,
    attestation_label: facts ? `${attested} of ${facts.required_people} have read the current version` : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

/** GET /policies (row 64). */
export async function listPolicies(d: PolicyDeps, viewer: Viewer, q: BastionPolicyListQuery) {
  const now = d.engine.now();
  const loaded = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    // Ordered after shaping, by the title this viewer sees (never by a live title they may not).
    const rows = (await tx.unsafe(
      `SELECT ${POLICY_SELECT} ${POLICY_FROM} WHERE p.organization_id = $1 AND ($2::text = 'all' OR p.status = $2) ORDER BY p.created_at`,
      [viewer.org_id, q.status],
    )) as unknown as PolicyRow[];
    const out: Array<{ p: PolicyRow; facts: PolicyFacts | null }> = [];
    for (const p of rows) out.push({ p, facts: p.status === 'active' ? await policyFacts(tx, viewer.org_id, p.id, now) : null });
    return out;
  });
  const open = await liveFor(d, viewer, loaded.map((r) => r.p));
  const data = loaded
    .map((r) => shapePolicy(r.p, r.facts, now, isLive(r.p, open)))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { data, next_cursor: null };
}

async function assertMembers(tx: Tx, orgId: string, ids: string[], field: string): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx`
    SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${orgId}
     WHERE u.id = ANY(${ids}::uuid[]) AND u.is_active`;
  if (rows.length !== new Set(ids).size) {
    throw new ValidationFailure('Everyone named must be an active member of this organization.', 'NOT_A_MEMBER', [{ field, issue: 'not_member' }]);
  }
}

/** POST /policies (row 65). */
export async function createPolicy(d: PolicyDeps, viewer: Viewer, body: BastionPolicyCreate) {
  const entry = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    // The link Beacon shows names the article by slug (#239); an id still works.
    const entryId = body.beacon_slug ? await beaconEntryIdBySlug(tx, viewer.org_id, body.beacon_slug) : (body.beacon_entry_id ?? null);
    if (!entryId) throw new NotFoundError('We could not find that Beacon article.');
    const e = (await tx`SELECT id, title, status::text AS status, visibility::text AS visibility FROM beacon_entries
                         WHERE id = ${entryId} AND organization_id = ${viewer.org_id}`)[0];
    if (!e) throw new NotFoundError('We could not find that Beacon article.');
    return e;
  });
  const beaconEntryId = String(entry.id);
  if (!(await d.canAccess(viewer.id, 'beacon.entry', beaconEntryId).catch(() => false))) {
    throw new NotFoundError('We could not find that Beacon article.');
  }
  if (!sharedWithEveryone(String(entry.visibility))) {
    throw new ConflictError('Only an article shared with everyone can be a policy. In Beacon, set its visibility to Organization first.', 'POLICY_NOT_SHARED');
  }
  if (entry.status === 'Archived' || entry.status === 'Retired') {
    throw new ConflictError('That article is archived or retired in Beacon.', 'POLICY_NOT_ACTIVE');
  }
  const id = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    if (body.audience.kind === 'users') await assertMembers(tx, viewer.org_id, body.audience.user_ids, 'audience.user_ids');
    if (body.owner_user_id) await assertMembers(tx, viewer.org_id, [body.owner_user_id], 'owner_user_id');
    if (body.control_id) {
      const c = (await tx`SELECT 1 FROM bastion_controls WHERE organization_id = ${viewer.org_id} AND id = ${body.control_id} AND lifecycle = 'active'`)[0];
      if (!c) throw new NotFoundError('We could not find that control.');
    }
    const ins = await tx`
      INSERT INTO bastion_policies (organization_id, beacon_entry_id, title_cache, audience, cadence_days, owner_user_id)
      VALUES (${viewer.org_id}, ${beaconEntryId}, ${String(entry.title).slice(0, 512)}, ${tx.json(body.audience as never)},
              ${body.cadence_days}, ${body.owner_user_id ?? viewer.id})
      ON CONFLICT (organization_id, beacon_entry_id) DO NOTHING
      RETURNING id`;
    if (!ins[0]) throw new ConflictError('That article is already a policy here.', 'POLICY_ALREADY_LINKED');
    const pid = String(ins[0].id);
    // spec 8.3: bastion.policy -> beacon.entry (references), in the same transaction.
    await tx`
      INSERT INTO entity_links (org_id, src_type, src_id, dst_type, dst_id, link_kind, created_by)
      VALUES (${viewer.org_id}, 'bastion.policy', ${pid}, 'beacon.entry', ${beaconEntryId}, 'references', ${viewer.id})
      ON CONFLICT DO NOTHING`;
    await auditRaw(tx, viewer, 'policy.create', { type: 'policy', id: pid }, { beacon_entry_id: beaconEntryId, audience: body.audience.kind, cadence_days: body.cadence_days });
    return pid;
  });
  const proposed = body.control_id && d.pinChecks ? await d.pinChecks(viewer, body.control_id, id) : [];
  const out = await getPolicy(d, viewer, id);
  return { data: { ...out.data, proposed_assertion_ids: proposed } };
}

export async function getPolicy(d: PolicyDeps, viewer: Viewer, id: string) {
  const now = d.engine.now();
  const { p, facts } = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const row = await loadPolicy(tx, viewer.org_id, id);
    return { p: row, facts: row.status === 'active' ? await policyFacts(tx, viewer.org_id, id, now) : null };
  });
  const open = await liveFor(d, viewer, [p]);
  return { data: shapePolicy(p, facts, now, isLive(p, open)) };
}

/** PATCH /policies/:id (row 66). */
export async function updatePolicy(d: PolicyDeps, viewer: Viewer, id: string, body: BastionPolicyUpdate) {
  await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    await loadPolicy(tx, viewer.org_id, id);
    if (body.audience?.kind === 'users') await assertMembers(tx, viewer.org_id, body.audience.user_ids, 'audience.user_ids');
    if (body.owner_user_id) await assertMembers(tx, viewer.org_id, [body.owner_user_id], 'owner_user_id');
    await tx`
      UPDATE bastion_policies
         SET audience = coalesce(${body.audience ? tx.json(body.audience as never) : null}::jsonb, audience),
             cadence_days = coalesce(${body.cadence_days ?? null}::int, cadence_days),
             owner_user_id = CASE WHEN ${body.owner_user_id !== undefined} THEN ${body.owner_user_id ?? null}::uuid ELSE owner_user_id END,
             status = coalesce(${body.status ?? null}::varchar, status)
       WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
    await auditRaw(tx, viewer, 'policy.update', { type: 'policy', id }, { changed: Object.keys(body) });
  });
  return getPolicy(d, viewer, id);
}

/** The current version's frozen body (beacon_versions), re-checking that everyone may see it. */
async function currentBody(tx: Tx, orgId: string, p: PolicyRow) {
  if (p.status !== 'active') throw new ConflictError('This policy was retired.', 'POLICY_RETIRED');
  if (p.entry_status === null || p.version === null) throw new NotFoundError('This Beacon article no longer exists.');
  if (!sharedWithEveryone(p.visibility)) throw new ConflictError(NOT_SHARED_MESSAGE, 'POLICY_NOT_SHARED');
  const v = (await tx`
    SELECT bv.version, bv.title, bv.body_markdown, bv.created_at FROM beacon_versions bv
      JOIN beacon_entries be ON be.id = bv.beacon_id AND be.organization_id = ${orgId}
     WHERE bv.beacon_id = ${p.beacon_entry_id} AND bv.version = ${p.version}`)[0];
  if (!v) throw new ConflictError('This policy has no saved version to read yet. Ask its owner to save it in Beacon.', 'POLICY_VERSION_MISSING');
  const body = String(v.body_markdown);
  return { version: Number(v.version), title: String(v.title), body_markdown: body, body_sha256: policyBodySha256(body), saved_at: v.created_at as string };
}

/** GET /policies/:id/body (row 67). */
export async function getPolicyBody(d: PolicyDeps, viewer: Viewer, id: string) {
  const now = d.engine.now();
  const p = await orgTx(d.engine.sql, viewer.org_id, (tx) => loadPolicy(tx, viewer.org_id, id));
  if (!(await d.canAccess(viewer.id, 'beacon.entry', p.beacon_entry_id).catch(() => false))) {
    throw new ForbiddenError('You cannot open this policy in Beacon. Ask its owner to share it with everyone.', 'POLICY_NOT_READABLE');
  }
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const b = await currentBody(tx, viewer.org_id, p);
    const mine = (await tx`
      SELECT attested_at FROM bastion_policy_attestations
       WHERE organization_id = ${viewer.org_id} AND policy_id = ${id} AND beacon_version = ${b.version} AND user_id = ${viewer.id}`)[0];
    const facts = await policyFacts(tx, viewer.org_id, id, now);
    const inAudience = await isInAudience(tx, viewer.org_id, p, viewer.id);
    return {
      data: {
        policy_id: id,
        beacon_entry_id: p.beacon_entry_id,
        title: b.title,
        beacon_version: b.version,
        body_markdown: b.body_markdown,
        body_sha256: b.body_sha256,
        saved_at: b.saved_at,
        expires_at: p.expires_at,
        cadence_days: p.cadence_days,
        in_audience: inAudience,
        attested_at: (mine?.attested_at as string | undefined) ?? null,
        due: inAudience && facts.not_attested_ids.includes(viewer.id),
      },
    };
  });
}

/** True when the person is one the policy requires (audience rule plus active human member). */
async function isInAudience(tx: Tx, orgId: string, p: PolicyRow, userId: string): Promise<boolean> {
  const u = (await tx`
    SELECT 1 FROM users u JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${orgId}
     WHERE u.id = ${userId} AND u.kind = 'human' AND u.is_active AND u.disabled_at IS NULL`)[0];
  if (!u) return false;
  return p.audience.kind === 'all' || p.audience.user_ids.includes(userId);
}

/** GET /policies/:id/attestations (row 68). */
export async function listPolicyAttestations(d: PolicyDeps, viewer: Viewer, id: string) {
  const now = d.engine.now();
  const r = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const p = await loadPolicy(tx, viewer.org_id, id);
    const facts = p.status === 'active' ? await policyFacts(tx, viewer.org_id, id, now) : null;
    const attested = facts ? await attestedPeople(tx, viewer.org_id, p, facts.beacon_version, now) : [];
    const names = await namesOf(tx, facts?.not_attested_ids ?? []);
    return { p, facts, attested, names };
  });
  const notAttested = r.facts?.not_attested_ids ?? [];
  const blocked = r.p.status === 'active' ? await cannotOpen(d.canAccess, r.p.beacon_entry_id, notAttested) : [];
  const blockedSet = new Set(blocked);
  const open = await liveFor(d, viewer, [r.p]);
  return {
    data: {
      policy: shapePolicy(r.p, r.facts, now, isLive(r.p, open)),
      attested: r.attested
        .filter((a) => !notAttested.includes(String(a.user_id)))
        .map((a) => ({ user_id: String(a.user_id), name: String(a.display_name), attested_at: a.attested_at as string })),
      not_attested: notAttested.map((u) => ({ user_id: u, name: r.names.get(u) ?? 'A former member', can_open: !blockedSet.has(u) })),
      cannot_open_count: blocked.length,
      cannot_open_label: blocked.length > 0 ? `${blocked.length} ${blocked.length === 1 ? "person can't" : "people can't"} open this policy` : null,
    },
  };
}

/** GET /me/attestations (row 69): every active policy the caller must read, and where they stand. */
export async function myAttestations(d: PolicyDeps, viewer: Viewer) {
  const now = d.engine.now();
  const rows = await orgTx(d.engine.sql, viewer.org_id, async (tx) =>
    (await tx.unsafe(`SELECT ${POLICY_SELECT} ${POLICY_FROM} WHERE p.organization_id = $1 AND p.status = 'active' ORDER BY p.created_at`, [
      viewer.org_id,
    ])) as unknown as PolicyRow[],
  );
  // The live title only where this person may open the article (#236).
  const open = await liveFor(d, viewer, rows);
  const out = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const data = [];
    for (const p of rows) {
      if (!(await isInAudience(tx, viewer.org_id, p, viewer.id))) continue;
      const facts = await policyFacts(tx, viewer.org_id, p.id, now);
      const last = (await tx`
        SELECT beacon_version, attested_at FROM bastion_policy_attestations
         WHERE organization_id = ${viewer.org_id} AND policy_id = ${p.id} AND user_id = ${viewer.id}
         ORDER BY attested_at DESC LIMIT 1`)[0];
      const due = facts.not_attested_ids.includes(viewer.id);
      const nextDue = !due && last ? new Date(new Date(last.attested_at as string).getTime() + p.cadence_days * DAY_MS).toISOString() : null;
      data.push({
        policy_id: p.id,
        title: titleOf(p, isLive(p, open)),
        current_version: p.version,
        shared_with_everyone: sharedWithEveryone(p.visibility),
        due,
        state_words: due ? (last ? 'A new version or a new year: please read it again' : 'Please read and acknowledge') : 'Read and acknowledged',
        last_attested_version: last ? Number(last.beacon_version) : null,
        last_attested_at: (last?.attested_at as string | undefined) ?? null,
        next_due_at: nextDue,
      });
    }
    return data;
  });
  return { data: out.sort((a, b) => a.title.localeCompare(b.title)) };
}

/**
 * Only the person themselves acknowledges (spec 2.8): a human, signed in with a session, not
 * impersonated. The route already ran requireSession and rejectWhenImpersonating; this re-checks
 * in the transaction so the service is safe whoever calls it.
 */
async function assertHumanReader(tx: Tx, viewer: Viewer): Promise<void> {
  const u = (await tx`SELECT kind, is_active FROM users WHERE id = ${viewer.id}`)[0];
  if (!u || u.kind !== 'human' || !u.is_active) {
    throw new ForbiddenError('Only the person themselves can acknowledge a policy. An AI agent or a service cannot.', 'HUMAN_READER_REQUIRED');
  }
  if (viewer.impersonator_id) throw new ForbiddenError('You cannot acknowledge a policy while acting as someone else.', 'IMPERSONATION_NOT_ALLOWED');
  if (viewer.auth_method !== 'session') throw new ForbiddenError('Acknowledging needs a signed-in session, not an API key.', 'SESSION_REQUIRED');
}

/** POST /policies/:id/attest (row 70). The route already required a session and refused impersonation. */
export async function attest(d: PolicyDeps, viewer: Viewer, id: string, body: BastionAttest) {
  const engine = d.engine;
  const now = engine.now();
  const p = await orgTx(engine.sql, viewer.org_id, (tx) => loadPolicy(tx, viewer.org_id, id));
  if (!(await d.canAccess(viewer.id, 'beacon.entry', p.beacon_entry_id).catch(() => false))) {
    throw new ForbiddenError('You cannot open this policy in Beacon, so you cannot acknowledge it.', 'POLICY_NOT_READABLE');
  }
  const highest = await beginLedgerBatch(engine, viewer.org_id);
  let runs: QueuedRun[] = [];
  let created = false;
  let attestationId = '';
  try {
    await orgTx(engine.sql, viewer.org_id, async (tx) => {
      await assertHumanReader(tx, viewer);
      const fresh = await loadPolicy(tx, viewer.org_id, id);
      if (!(await isInAudience(tx, viewer.org_id, fresh, viewer.id))) {
        throw new ForbiddenError('This policy is not one you are asked to read.', 'NOT_IN_AUDIENCE');
      }
      const b = await currentBody(tx, viewer.org_id, fresh);
      if (b.version !== body.beacon_version || b.body_sha256 !== body.body_sha256) {
        throw new ConflictError('This policy changed while you were reading it. Read the new version, then acknowledge it.', 'POLICY_CHANGED');
      }
      const existing = (await tx`
        SELECT id FROM bastion_policy_attestations
         WHERE organization_id = ${viewer.org_id} AND policy_id = ${id} AND beacon_version = ${b.version} AND user_id = ${viewer.id}`)[0];
      if (existing) {
        attestationId = String(existing.id);
        return;
      }
      const newId = String((await tx`SELECT gen_random_uuid() AS id`)[0]?.id);
      const name = String((await tx`SELECT display_name FROM users WHERE id = ${viewer.id}`)[0]?.display_name ?? '');
      const pd = { name, policy_title: b.title };
      const pdHmac = engine.pdHmac(pd);
      const contentSha = attestationContentHash({
        id: newId,
        policy_id: id,
        beacon_entry_id: fresh.beacon_entry_id,
        beacon_version: b.version,
        body_sha256: b.body_sha256,
        user_id: viewer.id,
        attested_at: now,
      });
      const [entry] = await appendLedger(
        tx,
        viewer.org_id,
        [{ kind: 'attestation', id: newId, content_sha256: contentSha, personal_data_hmac: pdHmac, pd_hmac_key_id: engine.pdKeyId }],
        { highest, now },
      );
      // Immutable from the insert on (0276 trigger): every column, the ledger seq included, is set here.
      await tx`
        INSERT INTO bastion_policy_attestations (id, organization_id, policy_id, beacon_entry_id, beacon_version, body_sha256, user_id,
                                                 attested_at, personal_data_hmac, pd_hmac_key_id, ledger_seq)
        VALUES (${newId}, ${viewer.org_id}, ${id}, ${fresh.beacon_entry_id}, ${b.version}, ${b.body_sha256}, ${viewer.id},
                ${now}, ${pdHmac}, ${engine.pdKeyId}, ${entry?.seq ?? null})`;
      await tx`
        INSERT INTO bastion_personal_data (organization_id, holder_kind, holder_id, data, data_hmac, pd_hmac_key_id)
        VALUES (${viewer.org_id}, 'attestation', ${newId}, ${tx.json(pd as never)}, ${pdHmac}, ${engine.pdKeyId})
        ON CONFLICT (organization_id, holder_kind, holder_id) DO NOTHING`;
      await auditRaw(tx, viewer, 'policy.attest', { type: 'policy_attestation', id: newId }, { policy_id: id, beacon_version: b.version, body_sha256: b.body_sha256 });
      // The controls this policy proves re-check now, so the coverage moves without waiting a night.
      const controls = await tx`
        SELECT DISTINCT control_id FROM bastion_assertions
         WHERE organization_id = ${viewer.org_id} AND review_status = 'confirmed' AND probe_key = 'policy.attested'
           AND params->>'policy_id' = ${id}`;
      runs = await queueControlRuns(tx, viewer.org_id, controls.map((c) => String(c.control_id)), now, viewer.id, 'manual');
      attestationId = newId;
      created = true;
    });
  } catch (err) {
    throw mapAppendError(err);
  }
  if (runs.length > 0) await d.enqueueRuns(runs).catch(() => undefined);
  const row = await orgTx(engine.sql, viewer.org_id, (tx) => tx`
    SELECT id, policy_id, beacon_version, body_sha256, attested_at, ledger_seq FROM bastion_policy_attestations
     WHERE organization_id = ${viewer.org_id} AND id = ${attestationId}`);
  return { data: { ...(row[0] ?? {}), created, rechecking_controls: runs.length } };
}

/** The people still due on one policy, as the probe sees them now. */
async function duePeople(tx: Tx, orgId: string, policyId: string, now: Date) {
  const facts = await policyFacts(tx, orgId, policyId, now);
  return facts;
}

/** POST /policies/:id/request-attestations (row 71). One attestation.overdue per person, version and day. */
export async function requestAttestations(d: PolicyDeps, viewer: Viewer, id: string, body: BastionRequestAttestations) {
  const now = d.engine.now();
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const p = await loadPolicy(tx, viewer.org_id, id);
    if (p.status !== 'active') throw new ConflictError('This policy was retired.', 'POLICY_RETIRED');
    const facts = await duePeople(tx, viewer.org_id, id, now);
    const only = body.user_ids;
    const targets = only ? facts.not_attested_ids.filter((u) => only.includes(u)) : facts.not_attested_ids;
    let nudged = 0;
    for (const u of targets) {
      const fresh = await enqueueBastionEvent(
        'attestation.overdue',
        { policy_id: id, beacon_entry_id: p.beacon_entry_id, beacon_version: facts.beacon_version, user_id: u, requested: true },
        tx,
        { orgId: viewer.org_id, idempotencyKey: `attestation.overdue:${id}:${facts.beacon_version ?? 0}:${u}:${utcDate(now)}`, actorId: viewer.id, actorType: 'user' },
      );
      if (fresh) nudged += 1;
    }
    await auditRaw(tx, viewer, 'attestation.request', { type: 'policy', id }, { asked: targets.length, nudged });
    return { data: { policy_id: id, due: facts.not_attested_ids.length, asked: targets.length, nudged, already_nudged_today: targets.length - nudged } };
  });
}

// ── bastion-attestation-nudge (spec 7, daily 14:00 UTC) ─────────────────────────────────

export interface NudgeSummary {
  orgs: number;
  policies: number;
  due_people: number;
  nudged: number;
}

/**
 * Every active policy in every Bastion org: one attestation.overdue per person still due, keyed by
 * policy, version, person and cadence period, so a person is nudged once per period (not daily)
 * and again when a new version resets the requirement.
 */
export async function attestationNudge(engine: EngineDeps, opts: { organization_id?: string } = {}): Promise<NudgeSummary> {
  const now = engine.now();
  const orgs = (
    await engine.sql`
      SELECT DISTINCT organization_id FROM bastion_policies WHERE status = 'active'
        ${opts.organization_id ? engine.sql`AND organization_id = ${opts.organization_id}` : engine.sql``}`
  ).map((r) => String(r.organization_id));
  engine.log.info({ orgs: orgs.length }, `bastion-attestation-nudge: checking ${orgs.length} org(s) with policies`);
  const s: NudgeSummary = { orgs: orgs.length, policies: 0, due_people: 0, nudged: 0 };
  for (const orgId of orgs) {
    const r = await orgTx(engine.sql, orgId, async (tx) => {
      const policies = await tx`SELECT id, beacon_entry_id, cadence_days FROM bastion_policies WHERE organization_id = ${orgId} AND status = 'active'`;
      let due = 0;
      let nudged = 0;
      for (const p of policies) {
        const facts = await policyFacts(tx, orgId, String(p.id), now);
        due += facts.not_attested_ids.length;
        const period = Math.floor(now.getTime() / (Number(p.cadence_days) * DAY_MS));
        for (const u of facts.not_attested_ids) {
          if (
            await enqueueBastionEvent(
              'attestation.overdue',
              { policy_id: String(p.id), beacon_entry_id: String(p.beacon_entry_id), beacon_version: facts.beacon_version, user_id: u, requested: false },
              tx,
              { orgId, idempotencyKey: `attestation.overdue:${String(p.id)}:${facts.beacon_version ?? 0}:${u}:p${period}` },
            )
          )
            nudged += 1;
        }
      }
      return { policies: policies.length, due, nudged };
    });
    s.policies += r.policies;
    s.due_people += r.due;
    s.nudged += r.nudged;
    engine.log.info({ organization_id: orgId, ...r }, `bastion-attestation-nudge: ${r.policies} policies, ${r.due} people due, ${r.nudged} nudged`);
  }
  return s;
}
