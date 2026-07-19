import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { preflightAccess, preflightMany } from './visibility-client.js';

// Pins the fail-closed contract of the consolidated visibility preflight client.
//
// This primitive is shared by basis-api, braid-api, and bulwark-api (and every later
// consumer). Before consolidation each had its own copy, so a regression could go unnoticed
// in one of three files. Now there is one file, and these tests assert that the ONLY path to
// `true` is an explicit `{"allowed": true}` on a 2xx response. Every other outcome denies.

const ASKER = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

describe('visibility-client fail-closed contract', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.BBB_API_INTERNAL_URL = 'http://api:4000';
    process.env.INTERNAL_SERVICE_SECRET = 'x'.repeat(64);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('allows ONLY on an explicit allowed:true', async () => {
    globalThis.fetch = vi.fn(async () => ok({ allowed: true })) as unknown as typeof fetch;
    await expect(preflightAccess(ASKER, 'bin.asset', ENTITY)).resolves.toBe(true);
  });

  it('denies on allowed:false', async () => {
    globalThis.fetch = vi.fn(async () => ok({ allowed: false })) as unknown as typeof fetch;
    await expect(preflightAccess(ASKER, 'bin.asset', ENTITY)).resolves.toBe(false);
  });

  it('denies on a truthy-but-not-true allowed value', async () => {
    globalThis.fetch = vi.fn(async () => ok({ allowed: 'yes' })) as unknown as typeof fetch;
    await expect(preflightAccess(ASKER, 'bin.asset', ENTITY)).resolves.toBe(false);
  });

  it('denies when allowed is absent from the body', async () => {
    globalThis.fetch = vi.fn(async () => ok({})) as unknown as typeof fetch;
    await expect(preflightAccess(ASKER, 'bin.asset', ENTITY)).resolves.toBe(false);
  });

  it('denies on a non-2xx response even if the body says allowed', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => ({ allowed: true }) }) as unknown as Response,
    ) as unknown as typeof fetch;
    await expect(preflightAccess(ASKER, 'bin.asset', ENTITY)).resolves.toBe(false);
  });

  it('denies on a transport error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(preflightAccess(ASKER, 'bin.asset', ENTITY)).resolves.toBe(false);
  });

  it('denies on a malformed JSON body', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token');
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    await expect(preflightAccess(ASKER, 'bin.asset', ENTITY)).resolves.toBe(false);
  });

  it('denies without ever calling the API when the secret is missing', async () => {
    process.env.INTERNAL_SERVICE_SECRET = '';
    const spy = vi.fn(async () => ok({ allowed: true })) as unknown as typeof fetch;
    globalThis.fetch = spy;
    await expect(preflightAccess(ASKER, 'bin.asset', ENTITY)).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the secret header and the snake_case body the API expects', async () => {
    const spy = vi.fn(async (_url: string, _init: RequestInit) => ok({ allowed: true }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await preflightAccess(ASKER, 'bin.asset', ENTITY);

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://api:4000/internal/visibility/can-access');
    expect((init.headers as Record<string, string>)['X-Internal-Secret']).toBe('x'.repeat(64));
    expect(JSON.parse(init.body as string)).toEqual({
      asker_user_id: ASKER,
      entity_type: 'bin.asset',
      entity_id: ENTITY,
    });
  });

  it('trims a trailing slash on the base URL so the path is never doubled', async () => {
    const spy = vi.fn(async (_url: string, _init: RequestInit) => ok({ allowed: true }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await preflightAccess(ASKER, 'bin.asset', ENTITY, { apiInternalUrl: 'http://api:4000///' });
    expect(spy.mock.calls[0]![0]).toBe('http://api:4000/internal/visibility/can-access');
  });

  describe('preflightMany', () => {
    it('returns only the explicitly-allowed ids', async () => {
      globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
        const { entity_id } = JSON.parse(init.body as string);
        return ok({ allowed: entity_id === 'a' });
      }) as unknown as typeof fetch;

      const visible = await preflightMany(ASKER, 'bond.contact', ['a', 'b', 'c']);
      expect([...visible]).toEqual(['a']);
    });

    it('de-duplicates ids before fanning out', async () => {
      const spy = vi.fn(async () => ok({ allowed: true }));
      globalThis.fetch = spy as unknown as typeof fetch;
      await preflightMany(ASKER, 'bond.contact', ['a', 'a', 'a', 'b']);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('returns an empty set when every call fails closed', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('down');
      }) as unknown as typeof fetch;
      const visible = await preflightMany(ASKER, 'bond.contact', ['a', 'b']);
      expect(visible.size).toBe(0);
    });

    it('stops fanning out once the aggregate deadline passes', async () => {
      // Each call sleeps past the deadline, so only the first batch may run.
      const spy = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return ok({ allowed: true });
      });
      globalThis.fetch = spy as unknown as typeof fetch;
      const ids = Array.from({ length: 40 }, (_, i) => `id-${i}`);
      const reasons: string[] = [];

      const visible = await preflightMany(ASKER, 'bond.contact', ids, {
        batchDeadlineMs: 20,
        onDegraded: (i) => reasons.push(i.reason),
      });

      // Fail-closed: the ids never reached are simply absent, never assumed visible.
      expect(visible.size).toBeLessThan(ids.length);
      expect(spy.mock.calls.length).toBeLessThan(ids.length);
      expect(reasons).toContain('timeout');
    });
  });

  describe('degradation signal', () => {
    // A deny that means "can_access is down" must be distinguishable from a deny that
    // means "this asker may not see it". Both still deny; only one is an incident.
    const capture = async (fetchImpl: unknown, secret = 'x'.repeat(64)) => {
      process.env.INTERNAL_SERVICE_SECRET = secret;
      globalThis.fetch = fetchImpl as typeof fetch;
      const seen: string[] = [];
      const allowed = await preflightAccess(ASKER, 'bin.asset', ENTITY, {
        onDegraded: (i) => seen.push(i.reason),
      });
      return { allowed, seen };
    };

    it('does NOT report a real allowed:false as degraded', async () => {
      const { allowed, seen } = await capture(vi.fn(async () => ok({ allowed: false })));
      expect(allowed).toBe(false);
      expect(seen).toEqual([]);
    });

    it('reports no_secret without calling the API', async () => {
      const { allowed, seen } = await capture(
        vi.fn(async () => ok({ allowed: true })),
        '',
      );
      expect(allowed).toBe(false);
      expect(seen).toEqual(['no_secret']);
    });

    it('reports http_error on a non-2xx', async () => {
      const { allowed, seen } = await capture(
        vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response),
      );
      expect(allowed).toBe(false);
      expect(seen).toEqual(['http_error']);
    });

    it('reports transport_error when the upstream is unreachable', async () => {
      const { allowed, seen } = await capture(
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      );
      expect(allowed).toBe(false);
      expect(seen).toEqual(['transport_error']);
    });

    it('reports malformed_body when allowed is absent', async () => {
      const { allowed, seen } = await capture(vi.fn(async () => ok({})));
      expect(allowed).toBe(false);
      expect(seen).toEqual(['malformed_body']);
    });

    it('never lets a throwing onDegraded hook turn a deny into an exception', async () => {
      process.env.INTERNAL_SERVICE_SECRET = 'x'.repeat(64);
      globalThis.fetch = vi.fn(async () => {
        throw new Error('down');
      }) as unknown as typeof fetch;
      await expect(
        preflightAccess(ASKER, 'bin.asset', ENTITY, {
          onDegraded: () => {
            throw new Error('logger exploded');
          },
        }),
      ).resolves.toBe(false);
    });
  });
});
