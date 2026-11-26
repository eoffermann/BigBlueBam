import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { BASTION_ENGINE_NAMES } from '@bigbluebam/shared';
import { bastionInternalUrl, BastionUrlMissingError } from '../jobs/bastion-shared.js';
import { EVALUATE_MAX_POLLS, EVALUATE_POLL_INTERVAL_MS, processBastionEvaluateRunJob } from '../jobs/bastion-evaluate-run.job.js';
import { makeBastionEngineJob, processBastionEvaluateTickJob } from '../jobs/bastion-engines.job.js';
import { COMPILE_MAX_POLLS, COMPILE_POLL_INTERVAL_MS, processBastionCompileJob } from '../jobs/bastion-compile.job.js';

const SRC = join(__dirname, '..');
const WORKER = readFileSync(join(SRC, 'worker.ts'), 'utf8');
const BASTION_JOB_FILES = readdirSync(join(SRC, 'jobs'))
  .filter((f) => f.startsWith('bastion-') && f.endsWith('.ts'))
  .map((f) => ({ f, src: readFileSync(join(SRC, 'jobs', f), 'utf8') }));

/** The argument text of every `<needle>(...)` call in src, balanced on parentheses. */
function calls(src: string, needle: string): string[] {
  const out: string[] = [];
  let at = src.indexOf(needle);
  while (at >= 0) {
    let depth = 0;
    let j = at + needle.length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      }
    }
    out.push(src.slice(at + needle.length, j));
    at = src.indexOf(needle, j);
  }
  return out;
}

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const job = <T>(data: T, id = 'j1') => ({ id, data }) as unknown as Job<T>;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Bastion job registration rules (spec 7)', () => {
  // The block runs to the last Bastion scheduler (M5's evidence-expiry).
  const bastionBlock = WORKER.slice(WORKER.indexOf('function registerBastionSweep'), WORKER.indexOf('// END Bastion jobs'));

  it('registerBastionSweep wraps every scheduler in withRetention with tz UTC', () => {
    const schedulers = calls(bastionBlock, '.upsertJobScheduler(');
    expect(schedulers.length).toBe(1);
    for (const s of schedulers) {
      expect(s).toContain('withRetention(');
      expect(s).toMatch(/tz:\s*'UTC'/);
    }
  });

  it('registers one scheduled job per scheduled engine (every engine except the event-driven evaluate-run and compile)', () => {
    const registered = [...bastionBlock.matchAll(/registerBastionSweep\(\s*BASTION_[A-Z_]+_QUEUE/g)].length;
    expect(registered).toBe(BASTION_ENGINE_NAMES.length - 2);
    expect(bastionBlock).toContain("makeBastionEngineJob('attestation-nudge'");
    expect(bastionBlock).toMatch(/new Worker<BastionCompileJobData>\(\s*BASTION_COMPILE_QUEUE/);
  });

  it('no bare add: every producer add in the Bastion job files and worker block passes jobId and SCHEDULED_JOB_RETENTION', () => {
    const adds = [
      ...BASTION_JOB_FILES.flatMap(({ f, src }) => calls(src, '.add(').map((a) => ({ where: f, a }))),
      ...calls(bastionBlock, '.add(').map((a) => ({ where: 'worker.ts', a })),
    ];
    expect(adds.length).toBeGreaterThanOrEqual(2);
    for (const { where, a } of adds) {
      expect(a, `${where}: add(${a.slice(0, 60)}...)`).toMatch(/jobId:/);
      expect(a, `${where}: add(${a.slice(0, 60)}...)`).toContain('SCHEDULED_JOB_RETENTION');
    }
  });

  it('no bare upsertJobScheduler in the Bastion job files', () => {
    for (const { f, src } of BASTION_JOB_FILES) expect(src, f).not.toContain('upsertJobScheduler(');
  });
});

describe('bastion-shared', () => {
  it('bastionInternalUrl() throws when BASTION_API_INTERNAL_URL is unset', () => {
    vi.stubEnv('BASTION_API_INTERNAL_URL', '');
    expect(() => bastionInternalUrl()).toThrow(BastionUrlMissingError);
    vi.stubEnv('BASTION_API_INTERNAL_URL', 'http://bastion-api:4024/');
    expect(bastionInternalUrl()).toBe('http://bastion-api:4024');
  });
});

describe('bastion-evaluate-run loop', () => {
  const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
  const slice = (done: boolean, waiting?: string) => ({
    done,
    waiting,
    status: done ? 'succeeded' : 'running',
    assertions_done: 1,
    assertions_total: 2,
    controls_done: 0,
    controls_total: 1,
    pass: 1,
    fail: 0,
    unprovable: 0,
    slice_ms: 12,
  });

  it('the poll cap covers 90 minutes', () => {
    expect(EVALUATE_POLL_INTERVAL_MS * EVALUATE_MAX_POLLS).toBe(90 * 60_000);
  });

  it('drives slices until done, sleeping only while waiting', async () => {
    const post = vi.fn().mockResolvedValueOnce(ok(slice(false))).mockResolvedValueOnce(ok(slice(false, 'storage'))).mockResolvedValueOnce(ok(slice(true)));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const add = vi.fn();
    const r = await processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 1 }), silent, { post, sleep, queue: { add } });
    expect(r).toBe('done');
    // Three slices, then the gaps are re-ranked for the org (spec 7: gap-rank after each run).
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls[0]![1]).toEqual({ organization_id: 'o', run_id: 'r', claimant: 'worker:j1' });
    expect(post.mock.calls[3]).toEqual(['/v1/internal/engines/gap-rank', { organization_id: 'o' }]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
  });

  it('a 409 on a stale claim waits 30 s and retries; a live 409 ends the attempt', async () => {
    const claimed = (heartbeat_stale: boolean) => ({
      ok: false,
      status: 409,
      data: { error: { code: 'RUN_CLAIMED', message: 'held', details: [], request_id: 'req-1', claimed_by: 'worker:x', heartbeat_stale } },
    });
    const stale = claimed(true);
    const live = claimed(false);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const post = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(ok(slice(true)));
    expect(await processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post, sleep, queue: { add: vi.fn() } })).toBe('done');
    expect(sleep).toHaveBeenCalledWith(30_000);
    const post2 = vi.fn().mockResolvedValueOnce(live);
    expect(await processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post: post2, sleep, queue: { add: vi.fn() } })).toBe('ended');
  });

  it('a slice or 409 body that drifts from the shared contract fails loudly (#205)', async () => {
    const renamed = vi.fn().mockResolvedValue({ ok: false, status: 409, data: { error: { code: 'RUN_CLAIMED', heartbeatStale: true } } });
    await expect(
      processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post: renamed, sleep: async () => {}, queue: { add: vi.fn() } }),
    ).rejects.toThrow(/409 body does not match the shared contract/);
    const badSlice = vi.fn().mockResolvedValue(ok({ ...slice(false), waiting: 'coffee' }));
    await expect(
      processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post: badSlice, sleep: async () => {}, queue: { add: vi.fn() } }),
    ).rejects.toThrow(/slice does not match the shared contract.*waiting/);
  });

  it('after the poll cap it re-enqueues itself under a new job id with retention', async () => {
    const post = vi.fn().mockResolvedValue(ok(slice(false)));
    const add = vi.fn();
    const r = await processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 2 }), silent, {
      post,
      sleep: async () => {},
      queue: { add },
      maxPolls: 3,
    });
    expect(r).toBe('requeued');
    const [, data, opts] = add.mock.calls[0]!;
    // The successor inherits this job's claimant, so the live claim transfers (#201).
    expect(data).toEqual({ organization_id: 'o', run_id: 'r', resume_count: 2, claimant: 'worker:j1' });
    expect(opts.jobId).toMatch(/^r-r2-g\d+$/);
    expect(opts.removeOnComplete).toEqual({ count: 100 });
  });

  it('the handover successor drives under the inherited claimant, never its own job id (#201)', async () => {
    const post = vi.fn().mockResolvedValue(ok(slice(true)));
    const successor = job({ organization_id: 'o', run_id: 'r', resume_count: 2, claimant: 'worker:j1' }, 'r-r2-g123');
    expect(await processBastionEvaluateRunJob(successor, silent, { post, sleep: async () => {}, queue: { add: vi.fn() } })).toBe('done');
    expect(post.mock.calls[0]![1]).toEqual({ organization_id: 'o', run_id: 'r', claimant: 'worker:j1' });
  });

  it('a timeout or 5xx polls again as the same claimant instead of failing the job (#201)', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const post = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(ok(slice(true)));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post, sleep, queue: { add: vi.fn() } })).toBe('done');
    // Three evaluate-run calls plus the post-run gap-rank call.
    expect(post).toHaveBeenCalledTimes(4);
    const runCalls = post.mock.calls.filter((c) => c[0] === '/v1/internal/engines/evaluate-run');
    expect(runCalls).toHaveLength(3);
    expect(new Set(runCalls.map((c) => (c[1] as { claimant: string }).claimant))).toEqual(new Set(['worker:j1']));
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('persistent transient failures eventually throw; a configuration error throws at once', async () => {
    const post = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    await expect(
      processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post, sleep: async () => {}, queue: { add: vi.fn() } }),
    ).rejects.toThrow(/6 times in a row/);
    const bad = vi.fn().mockRejectedValue(new Error('INTERNAL_SERVICE_SECRET is empty'));
    await expect(
      processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post: bad, sleep: async () => {}, queue: { add: vi.fn() } }),
    ).rejects.toThrow(/INTERNAL_SERVICE_SECRET/);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe('bastion-compile loop (M7)', () => {
  const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
  const slice = (done: boolean, extra: Record<string, unknown> = {}) => ({
    done,
    status: done ? 'succeeded' : 'running',
    controls_done: 3,
    controls_total: 46,
    assertions_proposed: 5,
    assertions_dropped: 1,
    llm_calls_used: 3,
    fallback_controls: 0,
    slice_running: !done,
    waiting: null,
    ...extra,
  });

  it('the poll cap covers 4 hours (above the 1-2 hour compile estimate)', () => {
    expect(COMPILE_POLL_INTERVAL_MS * COMPILE_MAX_POLLS).toBe(4 * 60 * 60_000);
  });

  it('polls every 15 s until the run is done, as one claimant', async () => {
    const post = vi.fn().mockResolvedValueOnce(ok(slice(false))).mockResolvedValueOnce(ok(slice(false, { waiting: 'ai_slot' }))).mockResolvedValueOnce(ok(slice(true)));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const r = await processBastionCompileJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post, sleep, queue: { add: vi.fn() } });
    expect(r).toBe('done');
    expect(post).toHaveBeenCalledTimes(3);
    expect(new Set(post.mock.calls.map((c) => (c[1] as { claimant: string }).claimant))).toEqual(new Set(['worker-compile:j1']));
    expect(sleep).toHaveBeenCalledWith(15_000);
  });

  it('a live 409 ends; 404 ends; after the cap it hands over with the same claimant', async () => {
    const live = { ok: false, status: 409, data: { error: { code: 'RUN_CLAIMED', message: 'held', details: [], request_id: 'q', claimed_by: 'x', heartbeat_stale: false } } };
    expect(await processBastionCompileJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post: vi.fn().mockResolvedValue(live), sleep: async () => {}, queue: { add: vi.fn() } })).toBe('ended');
    expect(await processBastionCompileJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post: vi.fn().mockResolvedValue({ ok: false, status: 404 }), sleep: async () => {}, queue: { add: vi.fn() } })).toBe('ended');
    const add = vi.fn();
    const r = await processBastionCompileJob(job({ organization_id: 'o', run_id: 'r', resume_count: 2 }), silent, {
      post: vi.fn().mockResolvedValue(ok(slice(false))),
      sleep: async () => {},
      queue: { add },
      maxPolls: 2,
    });
    expect(r).toBe('requeued');
    expect(add.mock.calls[0]?.[1]).toEqual({ organization_id: 'o', run_id: 'r', resume_count: 2, claimant: 'worker-compile:j1' });
    expect(add.mock.calls[0]?.[2].jobId).toMatch(/^compile-r-r2-g\d+$/);
  });

  it('a slice that drifts from the shared contract fails loudly', async () => {
    const bad = vi.fn().mockResolvedValue(ok({ ...slice(false), waiting: 'tea' }));
    await expect(processBastionCompileJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post: bad, sleep: async () => {}, queue: { add: vi.fn() } })).rejects.toThrow(
      /compile slice does not match the shared contract/,
    );
  });
});

describe('bastion-evaluate-tick and engine jobs', () => {
  const ORG = '00000000-0000-4000-8000-000000000205';
  const R1 = '00000000-0000-4000-8000-0000000002a1';
  const R2 = '00000000-0000-4000-8000-0000000002a2';

  it('a tick result that drifts from the shared contract fails loudly, enqueueing nothing (#205)', async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { runs: [{ organization_id: ORG, run_id: R1, resumeCount: 0, generation: 0, why: 'nightly_created' }] } },
    });
    const add = vi.fn();
    await expect(processBastionEvaluateTickJob(job({}), silent, { post, queue: { add } })).rejects.toThrow(/shared contract.*resume_count/);
    expect(add).not.toHaveBeenCalled();
  });

  it('enqueues each run the tick returns with its own job id', async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { runs: [{ organization_id: ORG, run_id: R1, resume_count: 0, generation: 0, why: 'nightly_created' }, { organization_id: ORG, run_id: R2, resume_count: 1, generation: 7, why: 'orphan_requeue' }] } },
    });
    const add = vi.fn();
    expect(await processBastionEvaluateTickJob(job({}), silent, { post, queue: { add } })).toBe(2);
    expect(add.mock.calls.map((c) => c[2].jobId)).toEqual([`${R1}-r0`, `${R2}-r1-g7`]);
    expect(post).toHaveBeenCalledWith('/v1/internal/engines/evaluate-tick', {});
  });

  it('M7: queued compile runs the tick returns go to the compile queue with a generation job id', async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { runs: [], compile_runs: [{ organization_id: ORG, run_id: R1, resume_count: 1, generation: 9 }] } },
    });
    const add = vi.fn();
    const compileAdd = vi.fn();
    expect(await processBastionEvaluateTickJob(job({}), silent, { post, queue: { add }, compileQueue: { add: compileAdd } })).toBe(0);
    expect(compileAdd.mock.calls[0]?.[2].jobId).toBe(`compile-${R1}-r1-g9`);
    expect(compileAdd.mock.calls[0]?.[2].removeOnComplete).toEqual({ count: 100 });
    // An older bastion-api without compile_runs still parses (the field defaults to []).
    const old = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { data: { runs: [] } } });
    expect(await processBastionEvaluateTickJob(job({}), silent, { post: old, queue: { add }, compileQueue: { add: compileAdd } })).toBe(0);
  });

  it('outbox-drain reports dead rows as a worker error; a failing engine throws', async () => {
    const recordError = vi.fn();
    const drain = makeBastionEngineJob('outbox-drain', {
      post: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { data: { delivered: 3, dead: 1, dead_ids: ['x'] } } }),
      recordError,
    });
    await drain(job({}), silent);
    expect(recordError).toHaveBeenCalledTimes(1);
    const seal = makeBastionEngineJob('ledger-seal', { post: vi.fn().mockResolvedValue({ ok: false, status: 500 }) });
    await expect(seal(job({}), silent)).rejects.toThrow(/ledger-seal/);
  });

  it('a budgeted engine that answers complete: false is called again until it completes (#230)', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { ranked: 40, complete: false } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { ranked: 40, complete: false } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { ranked: 7, complete: true } } });
    const rank = makeBastionEngineJob('gap-rank', { post });
    const out = (await rank(job({}), silent)) as { ranked: number; complete: boolean };
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls.every((c) => c[0] === '/v1/internal/engines/gap-rank')).toBe(true);
    expect(out).toEqual({ ranked: 7, complete: true });
    // An engine that reports no `complete` is called once.
    const once = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { data: { pruned: 1 } } });
    await makeBastionEngineJob('retention', { post: once })(job({}), silent);
    expect(once).toHaveBeenCalledTimes(1);
  });
});
