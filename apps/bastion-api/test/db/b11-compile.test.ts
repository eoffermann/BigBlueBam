import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { orgTx } from '../../src/engine/context.js';
import type { LlmChat } from '../../src/lib/llm-errors.js';
import type { LlmPermits } from '../../src/lib/llm-permits.js';
import { type CompileAiDeps, createQueuedAiRun, type SliceLock } from '../../src/services/compile-ai.service.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Review batch 11, AI compile slices (live database):
 *   #242 two replicas polled with the same claimant while Redis is down never run two slices of
 *        one run (the slice_token fence), so no control is proposed twice.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b11-compile] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const RECORDED = JSON.parse(readFileSync(join(__dirname, '..', 'corpus', 'compiler-recorded.json'), 'utf8')) as {
  responses: Record<string, { content: string; finish_reason: string | null }>;
};
const KEYS = ['change.peer_review', 'keys.rotation', 'auth.mfa'];
const openPermits: LlmPermits = { tryAdmit: async () => ({ admitted: true, failOpen: false, release: async () => {} }) };
/** Redis is down: every acquire throws. */
const redisDown: SliceLock = {
  acquire: async () => {
    throw new Error('ECONNREFUSED (test)');
  },
  release: async () => {
    throw new Error('ECONNREFUSED (test)');
  },
};

const controlKeyOf = (messages: Array<{ content: string }>) => /"control_key":"([^"]+)"/.exec(messages[1]!.content)?.[1] ?? '';
const recorded = (key: string) => RECORDED.responses[key] ?? { content: '{"checks":[]}', finish_reason: 'stop' };

describe.skipIf(!DATABASE_URL)('batch 11: AI compile slices (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 8, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
  });

  async function setUp(tag: string) {
    const s = await seedOrg(sql, `b11c-${tag}`, 0, 0);
    orgs.push(s.org);
    await sql`UPDATE bastion_frameworks SET status = 'compiling' WHERE id = ${s.framework}`;
    for (const [i, key] of KEYS.entries()) {
      const [c] = await sql`INSERT INTO bastion_controls (organization_id, control_key, title) VALUES (${s.org}, ${key}, ${key}) RETURNING id`;
      await sql`INSERT INTO bastion_control_requirements (organization_id, control_id, framework_id, ref_code, requirement_title, applicability)
                VALUES (${s.org}, ${c!.id as string}, ${s.framework}, ${`CC${i + 6}.1`}, 'Requirement', 'applicable')`;
    }
    const run = await orgTx(sql, s.org, (tx) => createQueuedAiRun(tx, s.org, s.framework, s.owner, '00000000-0000-4000-8000-00000000aaaa'));
    return { ...s, runId: String(run.id) };
  }

  it('two replicas, one claimant, Redis down: the second poll reports the slice running and never starts its own (#242)', async () => {
    const s = await setUp('fence');
    const engine = makeDeps(sql, { clock: clock() });
    // Replica A's AI call blocks until released, so its slice is live when replica B is polled.
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    let enteredA!: () => void;
    const inA = new Promise<void>((r) => {
      enteredA = r;
    });
    const callsA: string[] = [];
    const llmA: LlmChat = async ({ messages }) => {
      const key = controlKeyOf(messages);
      callsA.push(key);
      enteredA();
      await gateA;
      return recorded(key);
    };
    const callsB: string[] = [];
    const llmB: LlmChat = async ({ messages }) => {
      const key = controlKeyOf(messages);
      callsB.push(key);
      return recorded(key);
    };

    // Two module instances = two bastion-api processes (each has its own in-process slice map).
    const replicaA = await import('../../src/services/compile-ai.service.js?replica=a');
    const replicaB = await import('../../src/services/compile-ai.service.js?replica=b');
    const dA: CompileAiDeps = { engine, llm: llmA, permits: openPermits, sliceLock: redisDown, background: false, sliceCutoffMs: 60_000 };
    const dB: CompileAiDeps = { engine, llm: llmB, permits: openPermits, sliceLock: redisDown, background: false, sliceCutoffMs: 60_000 };
    const body = { organization_id: s.org, run_id: s.runId, claimant: 'worker:W' };

    const sliceA = replicaA.compileSlice(dA, body);
    await inA;
    const pollB = await replicaB.compileSlice(dB, body);
    expect(pollB.slice_running).toBe(true);
    expect(callsB).toEqual([]);

    releaseA();
    const doneA = await sliceA;
    expect(doneA).toMatchObject({ done: true, status: 'succeeded', controls_done: 3 });
    expect(callsA).toHaveLength(3);
    expect(callsB).toEqual([]);

    // Every (control, probe or manual title) proposed exactly once.
    const rows = await sql`SELECT coalesce(a.probe_key, a.manual_evidence_spec->>'title') AS what, c.control_key FROM bastion_assertions a
                            JOIN bastion_controls c ON c.id = a.control_id WHERE a.organization_id = ${s.org} AND a.compile_run_id = ${s.runId}`;
    expect(rows.length).toBeGreaterThan(0);
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(`${r.control_key}|${r.what}`, (seen.get(`${r.control_key}|${r.what}`) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
    const fin = (await sql`SELECT slice_token, drop_reasons FROM bastion_compile_runs WHERE id = ${s.runId}`)[0]!;
    expect(fin.slice_token).toBeNull();
    expect((fin.drop_reasons as { done_keys: string[] }).done_keys.sort()).toEqual([...KEYS].sort());
  });

  /** Make writes of one control's assertions fail deterministically (like a U+0000 the database refuses). */
  async function breakWrites(controlId: string, onlyAi: boolean) {
    const fn = `b11_fail_${controlId.replace(/-/g, '')}`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.control_id = '${controlId}'::uuid ${onlyAi ? "AND NEW.proposed_by = 'compiler'" : ''} THEN
          RAISE EXCEPTION 'unsupported Unicode escape sequence (test)' USING ERRCODE = '22P05';
        END IF;
        RETURN NEW;
      END $f$`);
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${fn} ON bastion_assertions; CREATE TRIGGER ${fn} BEFORE INSERT ON bastion_assertions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    return async () => {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${fn} ON bastion_assertions`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    };
  }

  async function controlId(org: string, key: string) {
    return String((await sql`SELECT id FROM bastion_controls WHERE organization_id = ${org} AND control_key = ${key}`)[0]!.id);
  }

  it('an AI answer the database refuses is counted, released, and the control is retried with the library suggestions (#241)', async () => {
    const s = await setUp('slice-fail');
    const engine = makeDeps(sql, { clock: clock() });
    const replica = await import('../../src/services/compile-ai.service.js?replica=d');
    const calls: string[] = [];
    const llm: LlmChat = async ({ messages }) => {
      const key = controlKeyOf(messages);
      calls.push(key);
      return recorded(key);
    };
    const d: CompileAiDeps = { engine, llm, permits: openPermits, sliceLock: redisDown, background: false, sliceCutoffMs: 0 };
    const restore = await breakWrites(await controlId(s.org, 'change.peer_review'), true);
    try {
      const body = { organization_id: s.org, run_id: s.runId, claimant: 'worker:W' };
      let last = await replica.compileSlice(d, body);
      const seen: Array<{ status: string; llm: number; resume: number }> = [];
      for (let i = 0; i < 8 && !last.done; i++) {
        const r = (await sql`SELECT status, llm_calls_used, resume_count FROM bastion_compile_runs WHERE id = ${s.runId}`)[0]!;
        seen.push({ status: String(r.status), llm: Number(r.llm_calls_used), resume: Number(r.resume_count) });
        last = await replica.compileSlice(d, body);
      }
      // The failing slice was released (queued, resume 1) with its call counted, not re-run forever.
      expect(seen.some((x) => x.status === 'queued' && x.resume === 1)).toBe(true);
      expect(last).toMatchObject({ done: true, status: 'succeeded', controls_done: 3 });
      // change.peer_review was asked once; its retry used the library, not another AI call.
      expect(calls.filter((k) => k === 'change.peer_review')).toHaveLength(1);
      const run = (await sql`SELECT llm_calls_used, resume_count, error, drop_reasons FROM bastion_compile_runs WHERE id = ${s.runId}`)[0]!;
      expect(Number(run.llm_calls_used)).toBe(calls.length);
      expect(run.error).toBeNull();
      expect((run.drop_reasons as { fallback_keys: string[] }).fallback_keys).toContain('change.peer_review');
    } finally {
      await restore();
    }
  });

  it('a control that can never be written parks the run as partial after MAX_RESUMES slices (#241)', async () => {
    const s = await setUp('slice-park');
    const engine = makeDeps(sql, { clock: clock() });
    const replica = await import('../../src/services/compile-ai.service.js?replica=e');
    const calls: string[] = [];
    const llm: LlmChat = async ({ messages }) => {
      const key = controlKeyOf(messages);
      calls.push(key);
      return recorded(key);
    };
    const d: CompileAiDeps = { engine, llm, permits: openPermits, sliceLock: redisDown, background: false, sliceCutoffMs: 0 };
    const restore = await breakWrites(await controlId(s.org, 'auth.mfa'), false);
    try {
      const body = { organization_id: s.org, run_id: s.runId, claimant: 'worker:W' };
      let last = await replica.compileSlice(d, body);
      let polls = 1;
      for (; polls < 20 && !last.done; polls++) last = await replica.compileSlice(d, body);
      expect(last).toMatchObject({ done: true, status: 'partial' });
      expect(polls).toBeLessThanOrEqual(3);
      const run = (await sql`SELECT llm_calls_used, resume_count, error, slice_token FROM bastion_compile_runs WHERE id = ${s.runId}`)[0]!;
      expect(Number(run.resume_count)).toBe(3);
      expect(String(run.error)).toContain('stopped');
      expect(run.slice_token).toBeNull();
      // One AI call for the control, ever; its write failures did not un-count it.
      expect(calls).toEqual(['auth.mfa']);
      expect(Number(run.llm_calls_used)).toBe(1);
      // The one-active-compile slot is free again.
      const next = await orgTx(sql, s.org, (tx) => createQueuedAiRun(tx, s.org, s.framework, s.owner, '00000000-0000-4000-8000-00000000aaaa'));
      expect(next.status).toBe('queued');
    } finally {
      await restore();
    }
  });

  it('a slice that lost its fence writes nothing for the control it was on (#242)', async () => {
    const s = await setUp('lost');
    const engine = makeDeps(sql, { clock: clock() });
    const replica = await import('../../src/services/compile-ai.service.js?replica=c');
    const llm: LlmChat = async ({ messages }) => {
      // Mid-call, another slice takes the row over (a new token, as a takeover would write).
      await sql`UPDATE bastion_compile_runs SET slice_token = gen_random_uuid() WHERE id = ${s.runId}`;
      return recorded(controlKeyOf(messages));
    };
    const d: CompileAiDeps = { engine, llm, permits: openPermits, sliceLock: redisDown, background: false, sliceCutoffMs: 0 };
    await replica.compileSlice(d, { organization_id: s.org, run_id: s.runId, claimant: 'worker:W' });
    const rows = await sql`SELECT 1 FROM bastion_assertions WHERE organization_id = ${s.org} AND compile_run_id = ${s.runId}`;
    expect(rows).toHaveLength(0);
    const run = (await sql`SELECT controls_done, drop_reasons FROM bastion_compile_runs WHERE id = ${s.runId}`)[0]!;
    expect(Number(run.controls_done)).toBe(0);
  });
});
