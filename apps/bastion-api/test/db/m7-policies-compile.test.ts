import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { RunLeaseHeldError } from '../../src/engine/evaluator.js';
import { orgTx } from '../../src/engine/context.js';
import { LlmError, type LlmChat } from '../../src/lib/llm-errors.js';
import type { LlmPermits } from '../../src/lib/llm-permits.js';
import {
  compileSlice,
  connectedPopulationsRaw,
  createQueuedAiRun,
  orphanedCompileRuns,
  reapCompileRuns,
  resolveLlmProviderId,
  type CompileAiDeps,
  type SliceLock,
} from '../../src/services/compile-ai.service.js';
import {
  attest,
  attestationNudge,
  createPolicy,
  getPolicyBody,
  listPolicies,
  listPolicyAttestations,
  myAttestations,
  policyBodySha256,
  requestAttestations,
  updatePolicy,
  type PolicyDeps,
} from '../../src/services/policies.service.js';
import type { Viewer } from '../../src/services/types.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * M7 gates against a real migrated database and the real service code (spec 2.1, 3.6, 7.3):
 *
 *   policies: only an article shared with everyone links; the served body is the FROZEN
 *   beacon_versions body and its SHA-256 (not beacon_entries.body_markdown); attesting pins the
 *   version and hash, is ledgered with a personal-data commitment, is idempotent, refuses an API
 *   key, an agent, a stale hash and someone outside the audience; a new version resets it; a
 *   narrowed article is refused on the next read; "N people can't open this policy" comes from
 *   can_access per member; nudges are once per person, version and day (or cadence period).
 *
 *   compile: the AI compile runs in resumable slices fenced on the claimant, every answer through
 *   the validator, a failed AI call falls back to the library for that control, a stale claim is
 *   released by the reaper and re-enqueued by the tick, and the finished run emits
 *   assertions.compiled with the framework active.
 */

if (!DATABASE_URL) console.warn('[bastion-api/m7] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const RECORDED = JSON.parse(readFileSync(join(__dirname, '..', 'corpus', 'compiler-recorded.json'), 'utf8')) as {
  responses: Record<string, { content: string; finish_reason: string | null }>;
};

const viewer = (org: string, id: string, auth: 'session' | 'api_key' = 'session'): Viewer => ({
  id,
  org_id: org,
  role: 'owner',
  is_superuser: false,
  impersonator_id: null,
  auth_method: auth,
});

describe.skipIf(!DATABASE_URL)('M7 policies and version-pinned attestation (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  const entries: string[] = [];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await sql`DELETE FROM entity_links WHERE org_id = ${org}`;
    for (const e of entries) {
      await sql`DELETE FROM beacon_versions WHERE beacon_id = ${e}`;
      await sql`DELETE FROM beacon_entries WHERE id = ${e}`;
    }
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
  });

  async function setUp(tag: string) {
    const s = await seedOrg(sql, `m7-${tag}`, 1, 1);
    orgs.push(s.org);
    const people: string[] = [];
    for (const [i, kind] of (['human', 'human', 'agent'] as const).entries()) {
      const [u] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                            VALUES (${s.org}, ${`m7-${tag}-${i}-${Date.now()}@bigbluebam.internal`}, ${`Castaway ${i}`}, '!', ${kind}) RETURNING id`;
      people.push(u!.id as string);
      await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${u!.id as string}, ${s.org})`;
    }
    const [e] = await sql`
      INSERT INTO beacon_entries (slug, title, body_markdown, version, status, visibility, created_by, owned_by, organization_id, expires_at, last_verified_at)
      VALUES (${`island-policy-${tag}-${Date.now()}`}, 'Island Information Security Policy', 'LIVE EDIT NOT YET SAVED', 1, 'Active', 'Organization',
              ${s.owner}, ${s.owner}, ${s.org}, now() + interval '200 days', now())
      RETURNING id`;
    const entry = e!.id as string;
    entries.push(entry);
    await sql`INSERT INTO beacon_versions (beacon_id, version, title, body_markdown)
              VALUES (${entry}, 1, 'Island Information Security Policy', ${'# Island policy\n\nCoconut radios are company property.'})`;
    return { ...s, people, entry };
  }

  function deps(blocked: Set<string> = new Set()): PolicyDeps & { enqueued: unknown[] } {
    const enqueued: unknown[] = [];
    return {
      engine: makeDeps(sql, { clock: clock() }),
      canAccess: async (u) => !blocked.has(u),
      enqueueRuns: async (runs) => {
        enqueued.push(...runs);
      },
      enqueued,
    };
  }

  it('links only an article shared with everyone, serves the frozen version body and pins attestation to it', async () => {
    const s = await setUp('flow');
    const d = deps();
    const owner = viewer(s.org, s.owner);
    await sql`UPDATE beacon_entries SET visibility = 'Project' WHERE id = ${s.entry}`;
    await expect(createPolicy(d, owner, { beacon_entry_id: s.entry, audience: { kind: 'all' }, cadence_days: 365 })).rejects.toMatchObject({ code: 'POLICY_NOT_SHARED' });
    await sql`UPDATE beacon_entries SET visibility = 'Organization' WHERE id = ${s.entry}`;

    // The control proves this policy: its two policy checks are proposed, pinned to it.
    const created = await createPolicy(
      { ...d, pinChecks: async () => ['pinned'] },
      owner,
      { beacon_entry_id: s.entry, audience: { kind: 'all' }, cadence_days: 365, control_id: s.controls[0] },
    );
    const policyId = created.data.id;
    expect(created.data.proposed_assertion_ids).toEqual(['pinned']);
    // Three humans are required (owner plus two castaways); the agent never is.
    expect(created.data.required_people).toBe(3);
    expect(created.data.attestation_label).toBe('0 of 3 have read the current version');
    const link = await sql`SELECT link_kind FROM entity_links WHERE org_id = ${s.org} AND src_id = ${policyId} AND dst_id = ${s.entry}`;
    expect(link[0]?.link_kind).toBe('references');
    await expect(createPolicy(d, owner, { beacon_entry_id: s.entry, audience: { kind: 'all' }, cadence_days: 365 })).rejects.toMatchObject({ code: 'POLICY_ALREADY_LINKED' });

    const body = await getPolicyBody(d, owner, policyId);
    expect(body.data.body_markdown).toBe('# Island policy\n\nCoconut radios are company property.');
    expect(body.data.body_sha256).toBe(policyBodySha256(body.data.body_markdown));
    expect(body.data.due).toBe(true);

    // Vouching: not with an API key, not by an agent, not with a stale hash, not outside the audience.
    const good = { beacon_version: 1, body_sha256: body.data.body_sha256 };
    await expect(attest(d, viewer(s.org, s.owner, 'api_key'), policyId, good)).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    await expect(attest(d, viewer(s.org, s.people[2]!), policyId, good)).rejects.toMatchObject({ code: 'HUMAN_READER_REQUIRED' });
    await expect(attest(d, owner, policyId, { beacon_version: 1, body_sha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'POLICY_CHANGED' });

    const first = await attest(d, owner, policyId, good);
    expect(first.data.created).toBe(true);
    const again = await attest(d, owner, policyId, good);
    expect(again.data.created).toBe(false);
    const row = (await sql`SELECT * FROM bastion_policy_attestations WHERE organization_id = ${s.org} AND policy_id = ${policyId}`)[0]!;
    expect(row.beacon_version).toBe(1);
    expect(row.body_sha256).toBe(body.data.body_sha256);
    expect(Number(row.ledger_seq)).toBeGreaterThan(0);
    const ledger = await sql`SELECT entry_kind, personal_data_hmac FROM bastion_ledger_entries WHERE organization_id = ${s.org} AND entry_id = ${row.id as string}`;
    expect(ledger[0]).toMatchObject({ entry_kind: 'attestation', personal_data_hmac: row.personal_data_hmac });
    const pd = await sql`SELECT data FROM bastion_personal_data WHERE organization_id = ${s.org} AND holder_kind = 'attestation' AND holder_id = ${row.id as string}`;
    expect((pd[0]!.data as { name: string }).name).toBe('M4 Owner');
    // Immutable (0276 trigger).
    await expect(sql`UPDATE bastion_policy_attestations SET beacon_version = 9 WHERE id = ${row.id as string}`).rejects.toThrow();

    const listed = (await listPolicies(d, owner, { status: 'active' })).data[0]!;
    expect(listed.attestation_label).toBe('1 of 3 have read the current version');
    const mine = (await myAttestations(d, owner)).data[0]!;
    expect(mine).toMatchObject({ due: false, state_words: 'Read and acknowledged', last_attested_version: 1 });

    // A narrowed audience: someone not listed cannot acknowledge.
    await updatePolicy(d, owner, policyId, { audience: { kind: 'users', user_ids: [s.owner, s.people[0]!] } });
    await expect(attest(d, viewer(s.org, s.people[1]!), policyId, good)).rejects.toMatchObject({ code: 'NOT_IN_AUDIENCE' });
    expect((await listPolicies(d, owner, { status: 'active' })).data[0]!.required_people).toBe(2);

    // A new version resets the requirement: the owner is due again.
    await sql`UPDATE beacon_entries SET version = 2 WHERE id = ${s.entry}`;
    await sql`INSERT INTO beacon_versions (beacon_id, version, title, body_markdown) VALUES (${s.entry}, 2, 'Island Information Security Policy', '# Island policy v2')`;
    const v2 = await getPolicyBody(d, owner, policyId);
    expect(v2.data).toMatchObject({ beacon_version: 2, due: true, attested_at: null });
    await expect(attest(d, owner, policyId, good)).rejects.toMatchObject({ code: 'POLICY_CHANGED' });

    // Visibility is re-checked on every read.
    await sql`UPDATE beacon_entries SET visibility = 'Private' WHERE id = ${s.entry}`;
    await expect(getPolicyBody(d, owner, policyId)).rejects.toMatchObject({ code: 'POLICY_NOT_SHARED' });
    await sql`UPDATE beacon_entries SET visibility = 'Organization' WHERE id = ${s.entry}`;
  });

  it('names the people who cannot open the policy, and nudges once per person, version and day', async () => {
    const s = await setUp('nudge');
    const blocked = new Set([s.people[1]!]);
    const d = deps(blocked);
    const owner = viewer(s.org, s.owner);
    const policyId = (await createPolicy(d, owner, { beacon_entry_id: s.entry, audience: { kind: 'all' }, cadence_days: 365 })).data.id;
    const who = await listPolicyAttestations(d, owner, policyId);
    expect(who.data.cannot_open_count).toBe(1);
    expect(who.data.cannot_open_label).toBe("1 person can't open this policy");
    expect(who.data.not_attested.find((p) => p.user_id === s.people[1])?.can_open).toBe(false);

    const r1 = await requestAttestations(d, owner, policyId, {});
    expect(r1.data).toMatchObject({ due: 3, asked: 3, nudged: 3 });
    const r2 = await requestAttestations(d, owner, policyId, {});
    expect(r2.data).toMatchObject({ nudged: 0, already_nudged_today: 3 });
    const events = await sql`SELECT payload FROM bastion_outbox WHERE organization_id = ${s.org} AND kind = 'bolt_event' AND payload->>'event_type' = 'attestation.overdue'`;
    expect(events).toHaveLength(3);

    const n1 = await attestationNudge(d.engine, { organization_id: s.org });
    expect(n1).toMatchObject({ policies: 1, due_people: 3, nudged: 3 });
    const n2 = await attestationNudge(d.engine, { organization_id: s.org });
    expect(n2.nudged).toBe(0);
  });
});

describe.skipIf(!DATABASE_URL)('M7 AI-tailored compile on the worker (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  const KEYS = ['change.peer_review', 'keys.rotation', 'auth.mfa'];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
  });

  async function setUp(tag: string) {
    const s = await seedOrg(sql, `m7c-${tag}`, 0, 0);
    orgs.push(s.org);
    await sql`UPDATE bastion_frameworks SET status = 'compiling' WHERE id = ${s.framework}`;
    const controls: Record<string, string> = {};
    for (const [i, key] of KEYS.entries()) {
      const [c] = await sql`INSERT INTO bastion_controls (organization_id, control_key, title) VALUES (${s.org}, ${key}, ${key}) RETURNING id`;
      controls[key] = c!.id as string;
      await sql`INSERT INTO bastion_control_requirements (organization_id, control_id, framework_id, ref_code, requirement_title, applicability)
                VALUES (${s.org}, ${c!.id as string}, ${s.framework}, ${`CC${i + 6}.1`}, 'Requirement', 'applicable')`;
    }
    return { ...s, controlsByKey: controls };
  }

  function lockStore(): SliceLock {
    const held = new Set<string>();
    return {
      acquire: async (id) => (held.has(id) ? false : (held.add(id), true)),
      release: async (id) => void held.delete(id),
    };
  }
  const openPermits: LlmPermits = { tryAdmit: async () => ({ admitted: true, failOpen: false, release: async () => {} }) };

  function compileDeps(engine: ReturnType<typeof makeDeps>, llm: LlmChat): CompileAiDeps {
    return { engine, llm, permits: openPermits, sliceLock: lockStore(), background: false, sliceCutoffMs: 0 };
  }

  /** Answers from the recorded live corpus by control key (in the user message's CONTROL block). */
  const recordedLlm: LlmChat = async ({ messages }) => {
    const key = /"control_key":"([^"]+)"/.exec(messages[1]!.content)?.[1] ?? '';
    if (key === 'auth.mfa') throw new LlmError('upstream 502', 502);
    const r = RECORDED.responses[key];
    if (!r) throw new LlmError('no recording', null);
    return { content: r.content, finish_reason: r.finish_reason };
  };

  it('resumable slices fenced on the claim, AI answers validated, a failed call falls back, the reaper and tick recover a stale claim', async () => {
    const s = await setUp('slices');
    const c = clock();
    const engine = makeDeps(sql, { clock: c });
    const d = compileDeps(engine, recordedLlm);
    expect(await orgTx(sql, s.org, (tx) => connectedPopulationsRaw(tx, s.org))).toEqual({ github_repos: [], blip_apps: [] });
    void resolveLlmProviderId; // resolved by the route; the run carries the provider id
    const run = await orgTx(sql, s.org, (tx) => createQueuedAiRun(tx, s.org, s.framework, s.owner, '00000000-0000-4000-8000-00000000aaaa'));
    const runId = String(run.id);

    // One control per slice (cutoff 0): slice 1 by worker A.
    const s1 = await compileSlice(d, { organization_id: s.org, run_id: runId, claimant: 'worker:A' });
    expect(s1).toMatchObject({ done: false, status: 'running', controls_done: 1, controls_total: 3, llm_calls_used: 1 });
    // Another claimant is fenced off while A's heartbeat is fresh.
    await expect(compileSlice(d, { organization_id: s.org, run_id: runId, claimant: 'worker:B' })).rejects.toBeInstanceOf(RunLeaseHeldError);

    // A dies. Past the lease, the reaper releases the run and the tick finds it.
    c.offsetMs = 10 * 60_000;
    expect(await reapCompileRuns(engine, new Date(c.now().getTime() - engine.leaseMs), s.org)).toEqual({ released: 1, parked: 0 });
    const orphans = await orphanedCompileRuns(engine, new Date(Date.now() + 3_600_000), s.org);
    expect(orphans).toEqual([{ organization_id: s.org, run_id: runId, resume_count: 1 }]);

    // B resumes: the done control is skipped, never proposed twice.
    let last = await compileSlice(d, { organization_id: s.org, run_id: runId, claimant: 'worker:B' });
    for (let i = 0; i < 5 && !last.done; i++) last = await compileSlice(d, { organization_id: s.org, run_id: runId, claimant: 'worker:B' });
    expect(last).toMatchObject({ done: true, status: 'succeeded', controls_done: 3, fallback_controls: 1 });

    const rows = await sql`SELECT a.proposed_by, a.review_status, a.probe_key, a.params, c.control_key FROM bastion_assertions a
                            JOIN bastion_controls c ON c.id = a.control_id WHERE a.organization_id = ${s.org} AND a.compile_run_id = ${runId}`;
    expect(rows.every((r) => r.review_status === 'proposed')).toBe(true);
    // The failed AI call (auth.mfa) got the library verbatim; the others the AI's validated checks.
    expect(new Set(rows.filter((r) => r.control_key === 'auth.mfa').map((r) => r.proposed_by))).toEqual(new Set(['library']));
    expect(rows.some((r) => r.control_key === 'change.peer_review' && r.proposed_by === 'compiler')).toBe(true);
    // No list was confirmed by the AI, and nothing unconnected was listed (nothing is connected here).
    for (const r of rows) {
      const p = r.params as Record<string, unknown>;
      expect(p).not.toHaveProperty('population_confirmed_at');
      expect(Array.isArray(p.expected_population) ? p.expected_population : []).toEqual([]);
    }
    const perKey = new Map<string, number>();
    for (const r of rows) perKey.set(`${r.control_key}|${r.probe_key}`, (perKey.get(`${r.control_key}|${r.probe_key}`) ?? 0) + (r.probe_key ? 1 : 0));
    expect([...perKey.values()].every((n) => n <= 1)).toBe(true);

    const fin = (await sql`SELECT status, used_fallback, resume_count, drop_reasons FROM bastion_compile_runs WHERE id = ${runId}`)[0]!;
    expect(fin).toMatchObject({ status: 'succeeded', used_fallback: false, resume_count: 1 });
    expect((fin.drop_reasons as { fallback_keys: string[] }).fallback_keys).toEqual(['auth.mfa']);
    expect((await sql`SELECT status FROM bastion_frameworks WHERE id = ${s.framework}`)[0]!.status).toBe('active');
    const ev = await sql`SELECT payload FROM bastion_outbox WHERE organization_id = ${s.org} AND payload->>'event_type' = 'assertions.compiled'`;
    expect(ev).toHaveLength(1);
    const audit = await sql`SELECT details FROM bastion_audit_log WHERE organization_id = ${s.org} AND action = 'framework.compile'`;
    expect((audit[0]!.details as { mode: string }).mode).toBe('ai');

    // A finished run answers done to any later poll.
    expect((await compileSlice(d, { organization_id: s.org, run_id: runId, claimant: 'worker:C' })).done).toBe(true);
  });

  it('a run released three times is parked as partial and frees the framework', async () => {
    const s = await setUp('parked');
    const c = clock();
    const engine = makeDeps(sql, { clock: c });
    const run = await orgTx(sql, s.org, (tx) => createQueuedAiRun(tx, s.org, s.framework, s.owner, '00000000-0000-4000-8000-00000000aaaa'));
    await sql`UPDATE bastion_compile_runs SET status = 'running', claimed_by = 'worker:Z', heartbeat_at = now() - interval '1 hour', resume_count = 3 WHERE id = ${String(run.id)}`;
    expect(await reapCompileRuns(engine, new Date(c.now().getTime() - engine.leaseMs), s.org)).toEqual({ released: 0, parked: 1 });
    // The one-active-compile slot is free again.
    const next = await orgTx(sql, s.org, (tx) => createQueuedAiRun(tx, s.org, s.framework, s.owner, '00000000-0000-4000-8000-00000000aaaa'));
    expect(next.status).toBe('queued');
  });
});
