import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wave 1 / Platform §3.12 — OAuth route tests.
//
// These tests cover the wiring behavior of oauth.routes.ts without
// spinning up a live GitHub/Google provider:
//
//   * When OAUTH_GITHUB_CLIENT_ID / _SECRET (and Google equivalents)
//     are unset in env, the start routes return a 503 with an
//     OAUTH_NOT_CONFIGURED error envelope. This is the Wave 1 default
//     for fresh installs that have not yet provisioned OAuth apps.
//
//   * When the credentials ARE set, the plugin registers an oauth2
//     namespace (stubbed here) and the callback handler exists on
//     the Fastify router.
//
// We stub the @fastify/oauth2 plugin entirely so no network or
// crypto work happens during the test.

const { envStore } = vi.hoisted(() => ({
  envStore: {
    value: {
      OAUTH_GITHUB_CLIENT_ID: undefined as string | undefined,
      OAUTH_GITHUB_CLIENT_SECRET: undefined as string | undefined,
      OAUTH_GOOGLE_CLIENT_ID: undefined as string | undefined,
      OAUTH_GOOGLE_CLIENT_SECRET: undefined as string | undefined,
      FRONTEND_URL: 'http://localhost/b3',
      COOKIE_SECURE: false,
      COOKIE_DOMAIN: undefined as string | undefined,
      SESSION_TTL_SECONDS: 604800,
      SESSION_SECRET: 'a'.repeat(32),
      REDIS_URL: 'redis://localhost:6379',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      NODE_ENV: 'test',
    },
  },
}));

vi.mock('../src/env.js', () => ({
  get env() {
    return envStore.value;
  },
}));

vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/services/auth.service.js', () => ({
  createSession: vi.fn().mockResolvedValue({ id: 'sess-123' }),
}));

vi.mock('../src/plugins/csrf.js', () => ({
  issueCsrfToken: vi.fn().mockReturnValue('csrf-token-123'),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

// Stub @fastify/oauth2. When the real plugin registers itself, it
// decorates fastify with a namespace and a GET <startRedirectPath>.
// We emulate that so the callback handler is reachable in the test.
vi.mock('@fastify/oauth2', () => {
  const fn = async (fastify: any, opts: any) => {
    fastify[opts.name] = {
      getAccessTokenFromAuthorizationCodeFlow: vi.fn().mockResolvedValue({
        token: { access_token: 'provider-token' },
      }),
    };
    // Register a no-op start route so the plugin contract is honored.
    fastify.get(opts.startRedirectPath, async () => ({ ok: true }));
  };
  (fn as any).GITHUB_CONFIGURATION = { authorizeHost: 'https://github.com' };
  (fn as any).GOOGLE_CONFIGURATION = { authorizeHost: 'https://accounts.google.com' };
  return { default: fn };
});

const { default: oauthRoutes } = await import('../src/routes/oauth.routes.js');

interface RouteRecord {
  method: string;
  path: string;
  handler: (req: unknown, reply: unknown) => Promise<unknown>;
}

function makeFastifyStub() {
  const routes: RouteRecord[] = [];
  const namespaces: Record<string, unknown> = {};
  const stub: any = {
    get: (path: string, handler: RouteRecord['handler']) => {
      routes.push({ method: 'GET', path, handler });
    },
    post: (path: string, handler: RouteRecord['handler']) => {
      routes.push({ method: 'POST', path, handler });
    },
    register: async (plugin: (f: any, o: any) => Promise<void>, opts: any) => {
      await plugin(stub, opts);
    },
  };
  // decorate into the stub when @fastify/oauth2 sets githubOAuth2 etc.
  return { stub, routes, namespaces };
}

function makeReply() {
  const state: { status: number; body: unknown; cookies: Record<string, unknown> } = {
    status: 200,
    body: null,
    cookies: {},
  };
  const reply: any = {
    status(code: number) {
      state.status = code;
      return reply;
    },
    send(body: unknown) {
      state.body = body;
      return state;
    },
    setCookie(name: string, value: unknown) {
      state.cookies[name] = value;
      return reply;
    },
    redirect(url: string) {
      state.body = { redirect: url };
      return state;
    },
    _state: state,
  };
  return reply;
}

describe('oauth routes', () => {
  beforeEach(() => {
    envStore.value.OAUTH_GITHUB_CLIENT_ID = undefined;
    envStore.value.OAUTH_GITHUB_CLIENT_SECRET = undefined;
    envStore.value.OAUTH_GOOGLE_CLIENT_ID = undefined;
    envStore.value.OAUTH_GOOGLE_CLIENT_SECRET = undefined;
  });

  it('returns 503 on /auth/oauth/github when credentials are unset', async () => {
    const { stub, routes } = makeFastifyStub();
    await oauthRoutes(stub);
    const start = routes.find((r) => r.path === '/auth/oauth/github' && r.method === 'GET');
    expect(start).toBeDefined();
    const reply = makeReply();
    const result = (await start!.handler({}, reply)) as any;
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('OAUTH_NOT_CONFIGURED');
  });

  it('returns 503 on /auth/oauth/google when credentials are unset', async () => {
    const { stub, routes } = makeFastifyStub();
    await oauthRoutes(stub);
    const start = routes.find((r) => r.path === '/auth/oauth/google' && r.method === 'GET');
    expect(start).toBeDefined();
    const reply = makeReply();
    const result = (await start!.handler({}, reply)) as any;
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('OAUTH_NOT_CONFIGURED');
  });

  it('registers github + google callback routes when credentials are provided', async () => {
    envStore.value.OAUTH_GITHUB_CLIENT_ID = 'ghid';
    envStore.value.OAUTH_GITHUB_CLIENT_SECRET = 'ghsecret';
    envStore.value.OAUTH_GOOGLE_CLIENT_ID = 'ggid';
    envStore.value.OAUTH_GOOGLE_CLIENT_SECRET = 'ggsecret';

    const { stub, routes } = makeFastifyStub();
    await oauthRoutes(stub);

    const ghCallback = routes.find((r) => r.path === '/auth/oauth/github/callback');
    const ggCallback = routes.find((r) => r.path === '/auth/oauth/google/callback');
    expect(ghCallback).toBeDefined();
    expect(ggCallback).toBeDefined();

    // The oauth2 mock also registered the start paths via fastify.get.
    const ghStart = routes.find((r) => r.path === '/auth/oauth/github');
    const ggStart = routes.find((r) => r.path === '/auth/oauth/google');
    expect(ghStart).toBeDefined();
    expect(ggStart).toBeDefined();
  });
});
