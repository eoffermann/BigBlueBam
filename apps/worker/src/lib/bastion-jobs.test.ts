import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { BASTION_ENGINE_NAMES } from '@bigbluebam/shared';
import { bastionInternalUrl, BastionUrlMissingError } from '../jobs/bastion-shared.js';
import { EVALUATE_MAX_POLLS, EVALUATE_POLL_INTERVAL_MS, processBastionEvaluateRunJob } from '../jobs/bastion-evaluate-run.job.js';
import { makeBastionEngineJob, processBastionEvaluateTickJob } from '../jobs/bastion-engines.job.js';

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
  const bastionBlock = WORKER.slice(WORKER.indexOf('function registerBastionSweep'), WORKER.indexOf('bastion-retention-daily') + 40);

  it('registerBastionSweep wraps every scheduler in withRetention with tz UTC', () => {
    const schedulers = calls(bastionBlock, '.upsertJobScheduler(');
    expect(schedulers.length).toBe(1);
    for (const s of schedulers) {
      expect(s).toContain('withRetention(');
      expect(s).toMatch(/tz:\s*'UTC'/);
    }
  });

  it('registers one scheduled job per scheduled engine (every engine except evaluate-run)', () => {
    const registered = [...bastionBlock.matchAll(/registerBastionSweep\(\s*BASTION_[A-Z_]+_QUEUE/g)].length;
    expect(registered).toBe(BASTION_ENGINE_NAMES.length - 1);
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
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[0]![1]).toEqual({ organization_id: 'o', run_id: 'r', claimant: 'worker:j1' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
  });

  it('a 409 on a stale claim waits 30 s and retries; a live 409 ends the attempt', async () => {
    const stale = { ok: false, status: 409, data: { error: { heartbeat_stale: true } } };
    const live = { ok: false, status: 409, data: { error: { heartbeat_stale: false } } };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const post = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(ok(slice(true)));
    expect(await processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post, sleep, queue: { add: vi.fn() } })).toBe('done');
    expect(sleep).toHaveBeenCalledWith(30_000);
    const post2 = vi.fn().mockResolvedValueOnce(live);
    expect(await processBastionEvaluateRunJob(job({ organization_id: 'o', run_id: 'r', resume_count: 0 }), silent, { post: post2, sleep, queue: { add: vi.fn() } })).toBe('ended');
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
    expect(data).toEqual({ organization_id: 'o', run_id: 'r', resume_count: 2 });
    expect(opts.jobId).toMatch(/^r-r2-g\d+$/);
    expect(opts.removeOnComplete).toEqual({ count: 100 });
  });
});

describe('bastion-evaluate-tick and engine jobs', () => {
  it('enqueues each run the tick returns with its own job id', async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { runs: [{ organization_id: 'o', run_id: 'r1', resume_count: 0, generation: 0, why: 'nightly_created' }, { organization_id: 'o', run_id: 'r2', resume_count: 1, generation: 7, why: 'orphan_requeue' }] } },
    });
    const add = vi.fn();
    expect(await processBastionEvaluateTickJob(job({}), silent, { post, queue: { add } })).toBe(2);
    expect(add.mock.calls.map((c) => c[2].jobId)).toEqual(['r1-r0', 'r2-r1-g7']);
    expect(post).toHaveBeenCalledWith('/v1/internal/engines/evaluate-tick', {});
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
});
