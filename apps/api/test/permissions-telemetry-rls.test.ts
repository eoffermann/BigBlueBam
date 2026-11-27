import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #346: the permissions dual-read telemetry insert (recordDivergence) is fired and forgotten
 * from inside a request. Under BBB_RLS_ENFORCE=1 the global `db` proxy resolves to the
 * request's reserved, org-bound connection, which is released (and may be re-reserved by
 * another request) before the insert runs. The insert must never use the request's
 * connection: it runs in its own org-scoped transaction, or on the pool when it has no org.
 *
 * Uses the REAL db module (its AsyncLocalStorage and proxy), with runInOrgScope wrapped so the
 * test can see which org it binds without a database.
 */

vi.mock('../src/env.js', () => ({
  env: { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', NODE_ENV: 'test', BBB_RLS_ENFORCE: true },
}));

const { txInsert, runInOrgScopeSpy } = vi.hoisted(() => {
  const txInsert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
  const runInOrgScopeSpy = vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ insert: txInsert }),
  );
  return { txInsert, runInOrgScopeSpy };
});

vi.mock('../src/db/index.js', async (orig) => {
  const real = await orig<typeof import('../src/db/index.js')>();
  return { ...real, runInOrgScope: runInOrgScopeSpy };
});

const { rlsStorage } = await import('../src/db/index.js');
const { recordDivergence } = await import('../src/services/permissions-telemetry.service.js');

const resolved = { decision: 'allow', reason: 'group_grant', group_id: null } as never;

function args(org_id: string | null) {
  return {
    request_id: 'req-1',
    user_id: '11111111-1111-4111-8111-111111111111',
    org_id,
    permission_id: 'bam.task.update',
    scope_type: 'org' as const,
    scope_id: org_id,
    legacy_decision: 'deny' as const,
    resolved,
    route_method: 'PATCH',
    route_path: '/tasks/:id',
    logger: { warn: vi.fn() },
  };
}

/** Stand-in for the request's reserved, org-bound drizzle instance (rls plugin). */
function reservedRequestDb() {
  return { insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })) };
}

describe('recordDivergence under RLS enforce mode (#346)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("never writes on the request's reserved connection; binds the row's own org", async () => {
    const reserved = reservedRequestDb();
    await rlsStorage.run({ db: reserved as never, reserved: null }, () =>
      recordDivergence(args('22222222-2222-4222-8222-222222222222')),
    );
    expect(reserved.insert).not.toHaveBeenCalled();
    expect(runInOrgScopeSpy).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', expect.any(Function));
    expect(txInsert).toHaveBeenCalledTimes(1);
  });

  it('writes an org-less row on the pool, not on the request connection', async () => {
    const reserved = reservedRequestDb();
    const a = args(null);
    await rlsStorage.run({ db: reserved as never, reserved: null }, () => recordDivergence(a));
    expect(reserved.insert).not.toHaveBeenCalled();
    expect(runInOrgScopeSpy).not.toHaveBeenCalled();
    // The pool has no database here, so the best-effort insert fails and is logged, not thrown.
    expect(a.logger.warn).toHaveBeenCalled();
  });
});
