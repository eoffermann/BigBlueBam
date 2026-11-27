import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCrossAppAccess, type CrossAppAccessConfig } from './cross-app-access.js';

// #300: Bureau's cross-app preflight fails CLOSED.

const ORG = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000b1';
const DEAL = '00000000-0000-4000-8000-0000000000d1';

function config(over: Partial<CrossAppAccessConfig> = {}): CrossAppAccessConfig {
  return {
    internalServiceSecret: 's'.repeat(40),
    apiInternalUrl: 'http://api:4000',
    boardInternalUrl: 'http://board-api:4008',
    briefInternalUrl: 'http://brief-api:4005/',
    ...over,
  };
}

function args(targetUrl: string) {
  return { orgId: ORG, userId: USER, targetUrl };
}

function respond(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.restoreAllMocks());

describe('resolveCrossAppAccess', () => {
  it('denies a URL outside the suite apps without asking anyone', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const d = await resolveCrossAppAccess(args('/not-an-app/thing'), config());
    expect(d).toEqual({ allowed: false, canShare: false, reason: 'unsupported_app' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes a Bond URL to the api can-read route (it used to be allowed as unknown_app)', async () => {
    const spy = respond(200, { allowed: false, reason: 'not_found' });
    const d = await resolveCrossAppAccess(args(`/bond/deals/${DEAL}`), config());
    expect(d.allowed).toBe(false);
    expect(String(spy.mock.calls[0]![0])).toBe('http://api:4000/internal/can-read');
  });

  it('denies when the peer answers 401 (a wiring fault), and reports it as degraded', async () => {
    respond(401, { error: { code: 'UNAUTHORIZED' } });
    const onDegraded = vi.fn();
    const d = await resolveCrossAppAccess(args('/board/boards/x'), config({ onDegraded }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('degraded_http_error');
    expect(onDegraded).toHaveBeenCalledWith(expect.objectContaining({ reason: 'http_error', app: 'board' }));
  });

  it('denies on a transport error, a malformed body and a missing secret', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await resolveCrossAppAccess(args('/brief/documents/x'), config())).reason).toBe('degraded_transport_error');
    respond(200, { ok: true });
    expect((await resolveCrossAppAccess(args('/brief/documents/x'), config())).reason).toBe('degraded_malformed_body');
    expect((await resolveCrossAppAccess(args('/b3/projects/x'), config({ internalServiceSecret: '' }))).reason).toBe(
      'degraded_no_secret',
    );
  });

  it('allows only on an explicit allowed: true, and carries can_share', async () => {
    const spy = respond(200, { allowed: true, can_share: true });
    const d = await resolveCrossAppAccess(args('/brief/documents/x'), config());
    expect(d).toEqual({ allowed: true, canShare: true, reason: 'allowed' });
    expect(String(spy.mock.calls[0]![0])).toBe('http://brief-api:4005/v1/internal/can-read');
  });

  it("allows Bureau's own floors and rooms locally", async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect((await resolveCrossAppAccess(args('/bureau/floors/1'), config())).allowed).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
