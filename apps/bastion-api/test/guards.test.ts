import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { authMethodOf, rejectWhenImpersonating, requireSession } from '../src/lib/guards.js';

// Spec 2.8: impersonation cannot vouch, and vouching needs a session, not an API key (#136).
// The global auth hook is simulated from test headers so no database is needed.

type Caller = 'none' | 'session' | 'api_key' | 'impersonating_session' | 'impersonating_api_key';

function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('impersonator', null);
  app.decorateRequest('isImpersonating', false);
  app.addHook('preHandler', async (req) => {
    const caller = (req.headers['x-test-caller'] as Caller | undefined) ?? 'none';
    if (caller === 'none') return;
    const base = {
      id: 'u1',
      org_id: 'o1',
      email: 'skipper@gilligantravel.example',
      display_name: 'Skipper',
      avatar_url: null,
      role: 'admin',
      timezone: 'UTC',
      is_active: true,
      is_superuser: false,
      org_memberships: [],
      active_org_id: 'o1',
    };
    const viaKey = caller === 'api_key' || caller === 'impersonating_api_key';
    req.user = { ...base, api_key_scope: caller === 'api_key' ? 'read_write' : null };
    req.sessionId = viaKey ? null : 'sess-1';
    if (caller.startsWith('impersonating')) {
      req.isImpersonating = true;
      req.impersonator = { ...base, id: 'su1', is_superuser: true, api_key_scope: null };
    }
  });
  app.post('/vouch', { preHandler: [requireSession, rejectWhenImpersonating] }, async (req) => ({
    ok: true,
    auth_method: authMethodOf(req),
  }));
  app.post('/no-impersonation', { preHandler: [rejectWhenImpersonating] }, async () => ({ ok: true }));
  app.post('/session-only', { preHandler: [requireSession] }, async () => ({ ok: true }));
  return app;
}

async function call(url: string, caller: Caller) {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url, headers: { 'x-test-caller': caller } });
  await app.close();
  return {
    status: res.statusCode,
    body: res.json() as { ok?: boolean; auth_method?: string; error: { code: string; request_id: string } },
  };
}

describe('requireSession', () => {
  it('lets a cookie session through and records auth_method session', async () => {
    const r = await call('/vouch', 'session');
    expect(r.status).toBe(200);
    expect(r.body.auth_method).toBe('session');
  });

  it('rejects an API key (even a human-owned one) with 403 SESSION_REQUIRED', async () => {
    const r = await call('/session-only', 'api_key');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SESSION_REQUIRED');
    expect(r.body.error.request_id).toBeTruthy();
  });

  it('401 when nobody is signed in', async () => {
    const r = await call('/session-only', 'none');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('rejectWhenImpersonating', () => {
  it('rejects an impersonated session with 403 IMPERSONATION_NOT_ALLOWED', async () => {
    const r = await call('/no-impersonation', 'impersonating_session');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('IMPERSONATION_NOT_ALLOWED');
  });

  it('lets the real person through', async () => {
    expect((await call('/no-impersonation', 'session')).status).toBe(200);
    expect((await call('/no-impersonation', 'api_key')).status).toBe(200);
  });

  it('401 when nobody is signed in', async () => {
    expect((await call('/no-impersonation', 'none')).status).toBe(401);
  });
});

describe('both guards on a vouching route', () => {
  it('blocks every non-session or impersonated caller', async () => {
    expect((await call('/vouch', 'api_key')).body.error.code).toBe('SESSION_REQUIRED');
    expect((await call('/vouch', 'impersonating_session')).body.error.code).toBe('IMPERSONATION_NOT_ALLOWED');
    expect((await call('/vouch', 'impersonating_api_key')).status).toBe(403);
  });
});
