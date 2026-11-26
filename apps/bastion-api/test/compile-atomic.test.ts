import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #193: the inline compile is one transaction, a failure after it started is recorded as a
// `failed` run in a separate transaction, and a failure to record that is LOGGED, never swallowed.
// The transaction runner is stubbed so the failure paths can be driven without a database (the
// DB-backed half lives in test/db/m3-services.test.ts).

const scope = vi.hoisted(() => ({
  calls: 0,
  plan: [] as Array<(fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>>,
}));

vi.mock('../src/plugins/rls.js', () => ({
  runInOrgScope: (_org: string, fn: (tx: unknown) => Promise<unknown>) => {
    const step = scope.plan[scope.calls++];
    if (!step) throw new Error('unexpected runInOrgScope call');
    return step(fn);
  },
}));

import { compileFramework } from '../src/services/compile.service.js';
import { ConflictError } from '../src/lib/errors.js';

const viewer = {
  id: '00000000-0000-4000-8000-000000000001',
  org_id: '00000000-0000-4000-8000-000000000002',
  role: 'owner',
  is_superuser: false,
  impersonator_id: null,
  auth_method: 'session' as const,
};
const FW = '00000000-0000-4000-8000-000000000003';

function recordingTx(inserted: unknown[]) {
  return {
    insert: () => ({
      values: async (v: unknown) => {
        inserted.push(v);
      },
    }),
  };
}

beforeEach(() => {
  scope.calls = 0;
  scope.plan = [];
});

describe('compileFramework failure handling (#193)', () => {
  it('records a failed run when the compile transaction fails, and rethrows the original error', async () => {
    const inserted: unknown[] = [];
    scope.plan = [
      async () => {
        throw new Error('Connection terminated unexpectedly');
      },
      (fn) => fn(recordingTx(inserted)),
    ];
    const warn = vi.fn();
    await expect(compileFramework(viewer, FW, { warn })).rejects.toThrow('Connection terminated unexpectedly');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      framework_id: FW,
      status: 'failed',
      claimed_by: 'bastion-api:inline',
      error: 'Connection terminated unexpectedly',
    });
    expect((inserted[0] as { completed_at?: unknown }).completed_at).toBeInstanceOf(Date);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs (does not swallow) a failure to record the failed run, and still rethrows the original', async () => {
    scope.plan = [
      async () => {
        throw new Error('plan blew up');
      },
      async () => {
        throw new Error('database is down');
      },
    ];
    const warn = vi.fn();
    await expect(compileFramework(viewer, FW, { warn })).rejects.toThrow('plan blew up');
    expect(warn).toHaveBeenCalledTimes(1);
    const [obj, msg] = warn.mock.calls[0]!;
    expect(msg).toMatch(/could not be recorded/);
    expect(obj).toMatchObject({ cause: 'plan blew up', framework_id: FW, organization_id: viewer.org_id });
    expect((obj as { err: Error }).err.message).toBe('database is down');
  });

  it('a refusal (already running) records nothing', async () => {
    scope.plan = [
      async () => {
        throw new ConflictError('A setup run is already going for this framework.', 'COMPILE_RUNNING');
      },
    ];
    const warn = vi.fn();
    await expect(compileFramework(viewer, FW, { warn })).rejects.toMatchObject({ code: 'COMPILE_RUNNING' });
    expect(scope.calls).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
