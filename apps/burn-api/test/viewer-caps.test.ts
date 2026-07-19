import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveViewerCaps,
  resolveViewerCapsFor,
  intersectViewerCaps,
  DENY_ALL_VIEWER_CAPS,
  BURN_FINANCIALS_READ_ALL,
  BURN_COSTRATE_READ,
  type ViewerCaps,
  askerUserIdOf,
  type ViewerCapsDeps,
} from '../src/lib/viewer-caps.js';


/**
 * Burn spec section 12.1, "Serializer identity (R3-S1, R3-S2)".
 *
 * The two assertions this file exists for:
 *   1. with the dual-read resolver stubbed non-2xx, no capability is granted, so
 *      /v1/work-items returns no cost_amount (the fail-closed path);
 *   2. an admin service-account bearer with asker_user_id set to a plain member gets no
 *      cost_amount (the bearer-intersect-asker rule);
 * plus the grep assertion that `fastify.canResolve` appears in NO flooring path.
 */

const ADMIN = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

/** A resolver that allows a named allowlist of (user, permission) pairs and denies the rest. */
function stubResolver(allow: Record<string, string[]>, status = 200) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      user_id: string;
      permission_id: string;
    };
    const decision = (allow[body.user_id] ?? []).includes(body.permission_id) ? 'allow' : 'deny';
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data: { decision } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

// NOTE: `secret` is NOT a default parameter. `deps(spy, undefined)` must mean "no secret",
// and a default would silently substitute one, making the empty-secret test pass vacuously.
function deps(fetchImpl: typeof fetch, ...rest: [secret?: string | undefined]): ViewerCapsDeps {
  return {
    apiInternalUrl: 'http://api:4000',
    internalSecret: rest.length === 0 ? 's'.repeat(48) : rest[0],
    timeoutMs: 1000,
    fetchImpl,
  };
}

const ALL_CAPS = [BURN_FINANCIALS_READ_ALL, BURN_COSTRATE_READ];

describe('resolveViewerCaps fail-closed contract', () => {
  it('grants the caps an explicit allow returns', async () => {
    const caps = await resolveViewerCaps(deps(stubResolver({ [ADMIN]: ALL_CAPS })), {
      bearerUserId: ADMIN,
      orgId: ORG,
    });
    expect(caps).toEqual({ financials_read_all: true, costrate_read: true, resolved: true });
  });

  it('denies on an explicit deny, and marks it RESOLVED (a deny is an answer)', async () => {
    const caps = await resolveViewerCaps(deps(stubResolver({})), {
      bearerUserId: MEMBER,
      orgId: ORG,
    });
    expect(caps).toEqual({ financials_read_all: false, costrate_read: false, resolved: true });
  });

  it('a non-2xx resolver grants NOTHING and reads as unresolved', async () => {
    // Section 12.1: with the dual-read resolver stubbed non-2xx, /v1/work-items returns no
    // cost_amount. This is that assertion at its source; the serializer test proves the
    // consequence on all eight surfaces.
    for (const status of [401, 403, 404, 500, 502, 503]) {
      const caps = await resolveViewerCaps(deps(stubResolver({ [ADMIN]: ALL_CAPS }, status)), {
        bearerUserId: ADMIN,
        orgId: ORG,
      });
      expect({ status, ...caps }).toEqual({ status, ...DENY_ALL_VIEWER_CAPS });
    }
  });

  it('a thrown fetch grants nothing', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await resolveViewerCaps(deps(throwing), { bearerUserId: ADMIN, orgId: ORG })).toEqual(
      DENY_ALL_VIEWER_CAPS,
    );
  });

  it('a 2xx with decision "unknown" is treated as an OUTAGE, not as a deny', async () => {
    // packages/permissions returns 'unknown' on any non-2xx from its own upstream and the
    // gate denies only on an explicit 'deny' (spec 2.4 point 1). A 2xx carrying no real
    // decision is not an answer, so it must not be recorded as resolved.
    const vague = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { decision: 'unknown' } }),
    })) as unknown as typeof fetch;
    expect(await resolveViewerCaps(deps(vague), { bearerUserId: ADMIN, orgId: ORG })).toEqual(
      DENY_ALL_VIEWER_CAPS,
    );
  });

  it('a malformed body grants nothing', async () => {
    const junk = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ nope: true }),
    })) as unknown as typeof fetch;
    expect(await resolveViewerCaps(deps(junk), { bearerUserId: ADMIN, orgId: ORG })).toEqual(
      DENY_ALL_VIEWER_CAPS,
    );
  });

  it('an empty INTERNAL_SERVICE_SECRET grants nothing and issues no request', async () => {
    const spy = stubResolver({ [ADMIN]: ALL_CAPS });
    expect(
      await resolveViewerCaps(deps(spy, undefined), { bearerUserId: ADMIN, orgId: ORG }),
    ).toEqual(DENY_ALL_VIEWER_CAPS);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a missing user or org grants nothing and issues no request', async () => {
    const spy = stubResolver({ [ADMIN]: ALL_CAPS });
    expect(await resolveViewerCapsFor(deps(spy), null, ORG)).toEqual(DENY_ALL_VIEWER_CAPS);
    expect(await resolveViewerCapsFor(deps(spy), ADMIN, null)).toEqual(DENY_ALL_VIEWER_CAPS);
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts to /internal/permissions/dual-read with the internal secret header', async () => {
    const spy = stubResolver({ [ADMIN]: ALL_CAPS });
    await resolveViewerCaps(deps(spy), { bearerUserId: ADMIN, orgId: ORG });
    const calls = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [url, init] of calls) {
      expect(String(url)).toBe('http://api:4000/internal/permissions/dual-read');
      expect((init as RequestInit).method).toBe('POST');
      expect(
        (init as RequestInit).headers as Record<string, string>,
      ).toHaveProperty('X-Internal-Secret');
    }
    const permissions = calls.map(
      (c: unknown[]) => JSON.parse(String((c[1] as RequestInit).body)).permission_id,
    );
    expect(permissions.sort()).toEqual([...ALL_CAPS].sort());
  });

  it('resolves the two permissions independently', async () => {
    const caps = await resolveViewerCaps(deps(stubResolver({ [ADMIN]: [BURN_COSTRATE_READ] })), {
      bearerUserId: ADMIN,
      orgId: ORG,
    });
    expect(caps).toEqual({ financials_read_all: false, costrate_read: true, resolved: true });
  });
});

describe('the bearer-intersect-asker rule (R3-S2)', () => {
  it('an admin bearer with asker_user_id set to a plain member gets NOTHING', async () => {
    // Section 12.1 verbatim: "an admin service-account bearer with asker_user_id set to a
    // plain member gets no cost_amount from burn_list_unscoped".
    const caps = await resolveViewerCaps(deps(stubResolver({ [ADMIN]: ALL_CAPS })), {
      bearerUserId: ADMIN,
      orgId: ORG,
      askerUserId: MEMBER,
    });
    expect(caps.financials_read_all).toBe(false);
    expect(caps.costrate_read).toBe(false);
  });

  it('an asker equal to the bearer is not a narrowing', async () => {
    const caps = await resolveViewerCaps(deps(stubResolver({ [ADMIN]: ALL_CAPS })), {
      bearerUserId: ADMIN,
      orgId: ORG,
      askerUserId: ADMIN,
    });
    expect(caps.financials_read_all).toBe(true);
  });

  it('an asker NEVER widens: a member bearer with an admin asker still gets nothing', async () => {
    const caps = await resolveViewerCaps(
      deps(stubResolver({ [ADMIN]: ALL_CAPS })),
      { bearerUserId: MEMBER, orgId: ORG, askerUserId: ADMIN },
    );
    expect(caps.financials_read_all).toBe(false);
    expect(caps.costrate_read).toBe(false);
  });

  it('an UNRESOLVABLE asker fails the floored fields closed', async () => {
    // The asker leg 500s while the bearer leg succeeds. The intersection must be closed,
    // not "fall back to the bearer".
    const selective = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { user_id: string };
      if (body.user_id === MEMBER) {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { decision: 'allow' } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const caps = await resolveViewerCaps(deps(selective), {
      bearerUserId: ADMIN,
      orgId: ORG,
      askerUserId: MEMBER,
    });
    expect(caps).toEqual(DENY_ALL_VIEWER_CAPS);
  });

  it('skips the asker round trip when the bearer already holds nothing', async () => {
    const spy = stubResolver({});
    const caps = await resolveViewerCaps(deps(spy), {
      bearerUserId: MEMBER,
      orgId: ORG,
      askerUserId: ADMIN,
    });
    expect(caps.financials_read_all).toBe(false);
    // Two calls for the bearer, none for the asker: the intersection is already empty.
    expect((spy as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('intersectViewerCaps is a plain AND on every field', () => {
    const yes: ViewerCaps = { financials_read_all: true, costrate_read: true, resolved: true };
    const partial: ViewerCaps = {
      financials_read_all: true,
      costrate_read: false,
      resolved: true,
    };
    expect(intersectViewerCaps(yes, partial)).toEqual({
      financials_read_all: true,
      costrate_read: false,
      resolved: true,
    });
    expect(intersectViewerCaps(yes, { ...yes, resolved: false }).resolved).toBe(false);
  });
});

describe('askerUserIdOf', () => {
  const req = (q: unknown) => q;

  it('returns null when absent', () => {
    expect(askerUserIdOf(req({}))).toBeNull();
    expect(askerUserIdOf(req(undefined))).toBeNull();
    expect(askerUserIdOf(req({ asker_user_id: '' }))).toBeNull();
  });

  it('returns the uuid when well-formed', () => {
    expect(askerUserIdOf(req({ asker_user_id: MEMBER }))).toBe(MEMBER);
  });

  it('returns the fail-closed sentinel for a malformed value', () => {
    // Silently ignoring a garbled asker would fall back to the bearer's (possibly admin)
    // caps, which is the widening the intersection rule exists to prevent.
    expect(askerUserIdOf(req({ asker_user_id: 'not-a-uuid' }))).toBe('invalid');
    expect(askerUserIdOf(req({ asker_user_id: ['a', 'b'] }))).toBe('invalid');
    expect(askerUserIdOf(req({ asker_user_id: 42 }))).toBe('invalid');
  });
});

describe('fastify.canResolve is absent from every flooring path', () => {
  // packages/permissions/src/index.ts:307-319 decorates canResolve with a hardcoded
  // `return true` under a comment saying the HTTP plugin exposes no synchronous probe.
  // apps/bulwark-api/src/routes/deadlines.routes.ts:21-23 calls it and therefore floors
  // NOTHING today. This test is the guard that stops that precedent being copied into
  // Burn, where it would ship per-person cost rates to every project member.
  const SRC = join(__dirname, '..', 'src');

  const FLOORING_PATH_FILES = [
    'lib/viewer-caps.ts',
    'lib/redact-financial-fields.ts',
    'plugins/viewer-caps.ts',
  ];

  function sourceOf(rel: string): string {
    return readFileSync(join(SRC, rel), 'utf8');
  }

  // Matches a real call/reference, not the identifier inside a prose comment explaining
  // why it is banned.
  const CALL_RE = /(?<!\/\/[^\n]*)\b(?:fastify|app|instance|server|this)\s*\.\s*canResolve\b/;

  for (const rel of FLOORING_PATH_FILES) {
    it(`${rel} never calls canResolve`, () => {
      const lines = sourceOf(rel).split('\n');
      const offenders = lines
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
        .filter(({ line }) => CALL_RE.test(line));
      expect(offenders).toEqual([]);
    });
  }

  it('no burn-api source file outside the permissions plugin comment mentions canResolve in code', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        for (const [i, line] of readFileSync(full, 'utf8').split('\n').entries()) {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*')) continue;
          if (CALL_RE.test(t)) offenders.push(`${full}:${i + 1}`);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('the ban is documented where an implementer will look', () => {
    // The comment must survive too: a future agent reading only the code would otherwise
    // reach for the "obvious" canResolve and reintroduce the bug.
    expect(sourceOf('lib/viewer-caps.ts')).toMatch(/canResolve/);
    expect(sourceOf('lib/redact-financial-fields.ts')).toMatch(/canResolve/);
  });
});
