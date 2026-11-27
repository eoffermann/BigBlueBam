import { afterEach, describe, expect, it, vi } from 'vitest';

// #300: Bureau's presence/summon preflight fails CLOSED. These used to come back allowed
// ('unknown_app' for Bond/Bill/Beacon/Helpdesk URLs, 'stub_allow' for any non-200).

vi.mock('../src/env.js', () => ({
  env: {
    INTERNAL_SERVICE_SECRET: 's'.repeat(40),
    BBB_API_INTERNAL_URL: 'http://api:4000',
    BOARD_INTERNAL_URL: 'http://board-api:4008',
    BRIEF_INTERNAL_URL: 'http://brief-api:4005',
  },
}));

import { resolveAccess } from '../src/services/cross-app-access.service.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const VIEWER = '00000000-0000-4000-8000-0000000000b1';
const DEAL_URL = '/bond/deals/0f8fad5b-d9cb-469f-a165-70867728950e';

afterEach(() => vi.restoreAllMocks());

describe('resolveAccess (bureau-api)', () => {
  it('asks the api about a Bond deal and honours its deny', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ allowed: false, reason: 'not_member' }), { status: 200 }));
    const d = await resolveAccess({ orgId: ORG, userId: VIEWER, app: 'bond', targetUrl: DEAL_URL });
    expect(d.allowed).toBe(false);
    expect(String(spy.mock.calls[0]![0])).toBe('http://api:4000/internal/can-read');
  });

  it('a peer 401 (wiring fault) is "not located", and is logged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    const warn = vi.fn();
    const d = await resolveAccess({ orgId: ORG, userId: VIEWER, targetUrl: DEAL_URL }, { log: { warn } });
    expect(d.allowed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an unknown app is "not located" without a network call', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const d = await resolveAccess({ orgId: ORG, userId: VIEWER, targetUrl: '/elsewhere/x' });
    expect(d).toMatchObject({ allowed: false, reason: 'unsupported_app' });
    expect(spy).not.toHaveBeenCalled();
  });
});
