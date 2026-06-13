// railway-orchestrator.test.mjs
//
// Unit tests for RailwayOrchestrator and buildServiceVariables at
// railway-orchestrator.mjs. The RailwayClient is mocked with vi.fn()s so
// no real network calls happen.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildServiceVariables,
  buildAuthoritativeVariables,
  diffAuthoritativeVariables,
  RailwayOrchestrator,
} from './railway-orchestrator.mjs';
import {
  APP_SERVICES,
  INFRA_SERVICES,
  JOB_SERVICES,
  getRequiredAppServices,
  getSelfHostedInfra,
} from './services.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeClient(overrides = {}) {
  return {
    assertSchemaCompatibility: vi.fn().mockResolvedValue({ ok: true, missing: [] }),
    whoami: vi.fn().mockResolvedValue({ email: 'test@example.com', name: 'Test User' }),
    findProjectByName: vi.fn().mockResolvedValue(null),
    findProjectsByName: vi.fn().mockResolvedValue([]),
    getDefaultEnvironment: vi.fn().mockResolvedValue({ id: 'env_test', name: 'production' }),
    createProject: vi.fn().mockResolvedValue({
      id: 'prj_test',
      name: 'bigbluebam',
      defaultEnvironmentId: 'env_test',
      defaultEnvironmentName: 'production',
    }),
    listServices: vi.fn().mockResolvedValue([]),
    findServiceByName: vi.fn().mockResolvedValue(null),
    createService: vi
      .fn()
      .mockImplementation(({ name }) => Promise.resolve({ id: `svc_${name}`, name })),
    updateServiceInstance: vi.fn().mockResolvedValue(true),
    upsertVariables: vi.fn().mockResolvedValue(true),
    triggerDeploy: vi.fn().mockResolvedValue(true),
    getServiceVariables: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeOptions(overrides = {}) {
  return {
    projectName: 'bigbluebam',
    workspaceId: 'ws_test',
    githubRepo: 'eddie/bigbluebam',
    branch: 'main',
    generatedSecrets: {
      SESSION_SECRET: 'sess-secret',
      INTERNAL_HELPDESK_SECRET: 'helpdesk-secret',
      INTERNAL_SERVICE_SECRET: 'internal-secret',
      MINIO_ROOT_USER: 'minio-user',
      MINIO_ROOT_PASSWORD: 'minio-password',
      LIVEKIT_API_KEY: 'lk-key',
      LIVEKIT_API_SECRET: 'lk-secret',
    },
    publicUrl: 'https://example.up.railway.app',
    userIntegrations: {
      OAUTH_GITHUB_CLIENT_ID: 'gh-client-id',
      OAUTH_GITHUB_CLIENT_SECRET: 'gh-client-secret',
      OAUTH_GOOGLE_CLIENT_ID: 'goo-client-id',
      OAUTH_GOOGLE_CLIENT_SECRET: 'goo-client-secret',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'smtp-user',
      SMTP_PASS: 'smtp-pass',
      SMTP_FROM: 'noreply@example.com',
      EMAIL_FROM: 'noreply@example.com',
    },
    awaitPluginConfirmation: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn(),
    ...overrides,
  };
}

function getApiService() {
  const s = APP_SERVICES.find((svc) => svc.name === 'api');
  if (!s) throw new Error('api service missing from catalog');
  return s;
}

function getMinioService() {
  const s = INFRA_SERVICES.find((svc) => svc.name === 'minio');
  if (!s) throw new Error('minio service missing from catalog');
  return s;
}

function getLivekitService() {
  return INFRA_SERVICES.find((svc) => svc.name === 'livekit') ?? null;
}

function getSiteService() {
  const s = APP_SERVICES.find((svc) => svc.name === 'site');
  if (!s) throw new Error('site service missing from catalog');
  return s;
}

function fullContext() {
  return {
    generatedSecrets: {
      SESSION_SECRET: 'sess-secret',
      INTERNAL_HELPDESK_SECRET: 'helpdesk-secret',
      INTERNAL_SERVICE_SECRET: 'internal-secret',
      MINIO_ROOT_USER: 'minio-user',
      MINIO_ROOT_PASSWORD: 'minio-password',
      LIVEKIT_API_KEY: 'lk-key',
      LIVEKIT_API_SECRET: 'lk-secret',
    },
    publicUrl: 'https://example.up.railway.app',
    userIntegrations: {
      OAUTH_GITHUB_CLIENT_ID: 'gh-client-id',
      OAUTH_GITHUB_CLIENT_SECRET: 'gh-client-secret',
      OAUTH_GOOGLE_CLIENT_ID: 'goo-client-id',
      OAUTH_GOOGLE_CLIENT_SECRET: 'goo-client-secret',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'smtp-user',
      SMTP_PASS: 'smtp-pass',
      SMTP_FROM: 'noreply@example.com',
      EMAIL_FROM: 'noreply@example.com',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// buildServiceVariables
// ---------------------------------------------------------------------------

describe('buildServiceVariables', () => {
  it('resolves all hint kinds (plugin, secret, computed, reference, literal, public, user) for api service', () => {
    const result = buildServiceVariables(getApiService(), fullContext());

    // plugin refs
    expect(result.DATABASE_URL).toBe('${{Postgres.DATABASE_URL}}');
    expect(result.REDIS_URL).toBe('${{Redis.REDIS_URL}}');
    // generated secrets
    expect(result.SESSION_SECRET).toBe('sess-secret');
    expect(result.INTERNAL_HELPDESK_SECRET).toBe('helpdesk-secret');
    // computed
    expect(result.S3_ENDPOINT).toBe('http://minio.railway.internal:9000');
    // references
    expect(result.S3_ACCESS_KEY).toBe('${{minio.MINIO_ROOT_USER}}');
    expect(result.S3_SECRET_KEY).toBe('${{minio.MINIO_ROOT_PASSWORD}}');
    // literals
    expect(result.S3_BUCKET).toBe('bigbluebam-uploads');
    expect(result.S3_REGION).toBe('us-east-1');
    expect(result.LOG_LEVEL).toBe('info');
    // public (needs publicUrl)
    expect(result.CORS_ORIGIN).toBe('https://example.up.railway.app');
    expect(result.FRONTEND_URL).toBe('https://example.up.railway.app/b3');
    // user integrations
    expect(result.OAUTH_GITHUB_CLIENT_ID).toBe('gh-client-id');
    expect(result.OAUTH_GITHUB_CLIENT_SECRET).toBe('gh-client-secret');
    expect(result.OAUTH_GOOGLE_CLIENT_ID).toBe('goo-client-id');
    expect(result.OAUTH_GOOGLE_CLIENT_SECRET).toBe('goo-client-secret');
    expect(result.SMTP_HOST).toBe('smtp.example.com');
    expect(result.SMTP_PORT).toBe('587');
    expect(result.SMTP_USER).toBe('smtp-user');
    expect(result.SMTP_PASS).toBe('smtp-pass');
    // api reads EMAIL_FROM (the single canonical from-address fallback), not SMTP_FROM
    expect(result.EMAIL_FROM).toBe('noreply@example.com');
  });

  it('strips trailing slashes on publicUrl so substituted values have no double slashes', () => {
    const ctx = { ...fullContext(), publicUrl: 'https://example.up.railway.app/' };
    const result = buildServiceVariables(getApiService(), ctx);
    expect(result.CORS_ORIGIN).toBe('https://example.up.railway.app');
    expect(result.FRONTEND_URL).toBe('https://example.up.railway.app/b3');
    expect(result.FRONTEND_URL).not.toMatch(/\/\/b3/);
  });

  it('skips all public-kind vars when no publicUrl is provided', () => {
    const ctx = { ...fullContext(), publicUrl: null };
    const result = buildServiceVariables(getApiService(), ctx);
    expect(result).not.toHaveProperty('CORS_ORIGIN');
    expect(result).not.toHaveProperty('FRONTEND_URL');
    // required non-public vars still present
    expect(result.DATABASE_URL).toBeDefined();
    expect(result.SESSION_SECRET).toBeDefined();
  });

  it('skips all user-kind vars when userIntegrations is empty; keeps literal SMTP_PORT', () => {
    const ctx = { ...fullContext(), userIntegrations: {} };
    const result = buildServiceVariables(getApiService(), ctx);
    expect(result).not.toHaveProperty('OAUTH_GITHUB_CLIENT_ID');
    expect(result).not.toHaveProperty('OAUTH_GITHUB_CLIENT_SECRET');
    expect(result).not.toHaveProperty('SMTP_HOST');
    expect(result).not.toHaveProperty('SMTP_USER');
    // literal remains
    expect(result.SMTP_PORT).toBe('587');
  });

  it('throws a descriptive error when a required secret is missing', () => {
    const ctx = fullContext();
    delete ctx.generatedSecrets.SESSION_SECRET;
    expect(() => buildServiceVariables(getApiService(), ctx)).toThrow(
      /SESSION_SECRET.*api/,
    );
  });

  it('treats empty-string user integration values as not set', () => {
    const ctx = {
      ...fullContext(),
      userIntegrations: { OAUTH_GITHUB_CLIENT_ID: '' },
    };
    const result = buildServiceVariables(getApiService(), ctx);
    expect(result).not.toHaveProperty('OAUTH_GITHUB_CLIENT_ID');
  });

  it('uses generatedSecrets to set MinIO root credentials on the minio service itself', () => {
    const result = buildServiceVariables(getMinioService(), fullContext());
    expect(result.MINIO_ROOT_USER).toBe('minio-user');
    expect(result.MINIO_ROOT_PASSWORD).toBe('minio-password');
  });

  it('uses generatedSecrets to set LiveKit credentials on the livekit service itself', () => {
    const livekit = getLivekitService();
    if (!livekit) return; // skip gracefully if livekit removed from catalog
    const result = buildServiceVariables(livekit, fullContext());
    expect(result.LIVEKIT_API_KEY).toBe('lk-key');
    expect(result.LIVEKIT_API_SECRET).toBe('lk-secret');
  });

  it('returns an empty object for a service with no env vars (site)', () => {
    const result = buildServiceVariables(getSiteService(), fullContext());
    expect(result).toEqual({});
  });

  it('returns keys in alphabetically sorted order', () => {
    const result = buildServiceVariables(getApiService(), fullContext());
    const keys = Object.keys(result);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// RailwayOrchestrator constructor
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator constructor', () => {
  it('stores constructor options on the instance', () => {
    const client = makeFakeClient();
    const opts = makeOptions();
    const orch = new RailwayOrchestrator(client, opts);
    expect(orch.client).toBe(client);
    expect(orch.projectName).toBe(opts.projectName);
    expect(orch.workspaceId).toBe(opts.workspaceId);
    expect(orch.githubRepo).toBe(opts.githubRepo);
    expect(orch.branch).toBe(opts.branch);
    expect(orch.generatedSecrets).toBe(opts.generatedSecrets);
    expect(orch.publicUrl).toBe(opts.publicUrl);
    expect(orch.userIntegrations).toBe(opts.userIntegrations);
    expect(orch.onProgress).toBe(opts.onProgress);
    expect(orch.awaitPluginConfirmation).toBe(opts.awaitPluginConfirmation);
  });

  it('uses sensible defaults for optional options', () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, {
      projectName: 'bigbluebam',
      githubRepo: 'eddie/bigbluebam',
      branch: 'main',
    });
    expect(orch.workspaceId).toBeNull();
    expect(orch.publicUrl).toBeNull();
    expect(orch.userIntegrations).toEqual({});
    expect(orch.generatedSecrets).toEqual({});
    expect(orch.awaitPluginConfirmation).toBeNull();
    expect(typeof orch.onProgress).toBe('function');
  });

  it('throws when no client is provided', () => {
    expect(() => new RailwayOrchestrator(null, makeOptions())).toThrow(
      /RailwayClient/,
    );
    expect(() => new RailwayOrchestrator(undefined, makeOptions())).toThrow(
      /RailwayClient/,
    );
  });

  it('throws when projectName is missing', () => {
    const client = makeFakeClient();
    expect(
      () =>
        new RailwayOrchestrator(client, {
          githubRepo: 'eddie/bigbluebam',
          branch: 'main',
        }),
    ).toThrow(/projectName/);
  });

  it('throws when githubRepo is missing', () => {
    const client = makeFakeClient();
    expect(
      () =>
        new RailwayOrchestrator(client, {
          projectName: 'bigbluebam',
          branch: 'main',
        }),
    ).toThrow(/githubRepo/);
  });
});

// ---------------------------------------------------------------------------
// RailwayOrchestrator.run — phase 1: validate
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.run() — validate phase', () => {
  it('calls assertSchemaCompatibility and whoami on successful run', async () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    expect(client.assertSchemaCompatibility).toHaveBeenCalledTimes(1);
    expect(client.whoami).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error naming missing mutations when schema compat fails', async () => {
    const client = makeFakeClient({
      assertSchemaCompatibility: vi
        .fn()
        .mockResolvedValue({ ok: false, missing: ['serviceCreate', 'variableCollectionUpsert'] }),
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    await expect(orch.run()).rejects.toThrow(/serviceCreate/);
    await expect(
      new RailwayOrchestrator(client, makeOptions()).run(),
    ).rejects.toThrow(/variableCollectionUpsert/);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: project
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.run() — project phase', () => {
  it('reuses an existing project (no createProject call)', async () => {
    const client = makeFakeClient({
      findProjectsByName: vi
        .fn()
        .mockResolvedValue([{ id: 'prj_existing', name: 'bigbluebam' }]),
      getDefaultEnvironment: vi
        .fn()
        .mockResolvedValue({ id: 'env_existing', name: 'production' }),
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    expect(client.findProjectsByName).toHaveBeenCalledWith('bigbluebam', {
      workspaceId: 'ws_test',
    });
    expect(client.createProject).not.toHaveBeenCalled();
    expect(client.getDefaultEnvironment).toHaveBeenCalledWith('prj_existing');
    expect(orch.projectId).toBe('prj_existing');
    expect(orch.defaultEnvironmentId).toBe('env_existing');
  });

  it('creates a new project if none exists and uses its default environment', async () => {
    const client = makeFakeClient({
      findProjectsByName: vi.fn().mockResolvedValue([]),
      createProject: vi.fn().mockResolvedValue({
        id: 'prj_new',
        name: 'bigbluebam',
        defaultEnvironmentId: 'env_new',
        defaultEnvironmentName: 'production',
      }),
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(client.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bigbluebam', workspaceId: 'ws_test' }),
    );
    expect(orch.projectId).toBe('prj_new');
    expect(orch.defaultEnvironmentId).toBe('env_new');
  });

  it('throws when multiple projects share the same name in the workspace', async () => {
    const client = makeFakeClient({
      findProjectsByName: vi.fn().mockResolvedValue([
        { id: 'prj_a', name: 'bigbluebam' },
        { id: 'prj_b', name: 'bigbluebam' },
      ]),
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    await expect(orch.run()).rejects.toThrow(/Found 2 live projects named "bigbluebam"/);
    expect(client.createProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 3: plugin prompt
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.run() — plugin prompt phase', () => {
  it('calls awaitPluginConfirmation exactly once, after project creation and before services', async () => {
    const callOrder = [];
    const await_fn = vi.fn().mockImplementation(async () => {
      callOrder.push('await');
    });
    const client = makeFakeClient({
      createProject: vi.fn().mockImplementation(async (input) => {
        callOrder.push('createProject');
        return {
          id: 'prj_new',
          name: input.name,
          defaultEnvironmentId: 'env_new',
          defaultEnvironmentName: 'production',
        };
      }),
      createService: vi.fn().mockImplementation(async ({ name }) => {
        callOrder.push(`createService:${name}`);
        return { id: `svc_${name}`, name };
      }),
    });
    const orch = new RailwayOrchestrator(
      client,
      makeOptions({ awaitPluginConfirmation: await_fn }),
    );
    await orch.run();
    expect(await_fn).toHaveBeenCalledTimes(1);
    const createProjectIdx = callOrder.indexOf('createProject');
    const awaitIdx = callOrder.indexOf('await');
    const firstCreateServiceIdx = callOrder.findIndex((s) => s.startsWith('createService:'));
    expect(createProjectIdx).toBeGreaterThanOrEqual(0);
    expect(awaitIdx).toBeGreaterThan(createProjectIdx);
    expect(firstCreateServiceIdx).toBeGreaterThan(awaitIdx);
  });

  it('proceeds without throwing when awaitPluginConfirmation is omitted', async () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(
      client,
      makeOptions({ awaitPluginConfirmation: null }),
    );
    await expect(orch.run()).resolves.toBeDefined();
    // services still created
    expect(client.createService).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 4: services
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.run() — services phase', () => {
  const expectedPlanCount =
    getRequiredAppServices().filter((s) => s.name !== 'voice-agent').length +
    getSelfHostedInfra().length +
    JOB_SERVICES.length;

  it('calls createService once per service in the deploy plan', async () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    expect(client.createService).toHaveBeenCalledTimes(expectedPlanCount);
    // Every call is tagged with the github repo source and branch for dockerfile-based services
    for (const call of client.createService.mock.calls) {
      const input = call[0];
      expect(input.projectId).toBe('prj_test');
      expect(input.name).toEqual(expect.any(String));
      expect(input.source).toEqual(expect.objectContaining({ repo: 'eddie/bigbluebam' }));
      expect(input.branch).toBe('main');
    }
  });

  it('calls updateServiceInstance once per service with rootDirectory, dockerfilePath, and policy', async () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    expect(client.updateServiceInstance).toHaveBeenCalledTimes(expectedPlanCount);
    for (const call of client.updateServiceInstance.mock.calls) {
      const input = call[0];
      expect(input.rootDirectory).toBe('.');
      expect(input.dockerfilePath).toEqual(expect.any(String));
      expect(input.environmentId).toBe('env_test');
      expect(['ON_FAILURE', 'NEVER']).toContain(input.restartPolicyType);
    }
  });

  it('calls upsertVariables with resolved env for the api service (includes DATABASE_URL, SESSION_SECRET)', async () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    const apiCall = client.upsertVariables.mock.calls.find(
      (call) => call[0].serviceId === 'svc_api',
    );
    expect(apiCall).toBeDefined();
    const [args] = apiCall;
    expect(args.projectId).toBe('prj_test');
    expect(args.environmentId).toBe('env_test');
    expect(args.variables).toEqual(
      expect.objectContaining({
        DATABASE_URL: '${{Postgres.DATABASE_URL}}',
        REDIS_URL: '${{Redis.REDIS_URL}}',
        SESSION_SECRET: 'sess-secret',
        INTERNAL_HELPDESK_SECRET: 'helpdesk-secret',
      }),
    );
  });

  it('skips upsertVariables for services with no env vars (site, frontend)', async () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    const serviceIdsWithVars = client.upsertVariables.mock.calls.map(
      (call) => call[0].serviceId,
    );
    expect(serviceIdsWithVars).not.toContain('svc_site');
    // frontend's only optional vars (HTTP_PORT, HTTPS_PORT) are kind=note, so SKIP → empty → no call
    expect(serviceIdsWithVars).not.toContain('svc_frontend');
  });

  it('configures the migrate job with restartPolicyType: NEVER', async () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    const migrateCall = client.updateServiceInstance.mock.calls.find(
      (call) => call[0].serviceId === 'svc_migrate',
    );
    expect(migrateCall).toBeDefined();
    const [input] = migrateCall;
    expect(input.restartPolicyType).toBe('NEVER');
    // App services should be ON_FAILURE
    const apiConfigCall = client.updateServiceInstance.mock.calls.find(
      (call) => call[0].serviceId === 'svc_api',
    );
    expect(apiConfigCall[0].restartPolicyType).toBe('ON_FAILURE');
  });
});

// ---------------------------------------------------------------------------
// Phase 5: deploy trigger
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.run() — deploy phase', () => {
  const expectedPlanCount =
    getRequiredAppServices().filter((s) => s.name !== 'voice-agent').length +
    getSelfHostedInfra().length +
    JOB_SERVICES.length;

  it('calls triggerDeploy once per service in the plan', async () => {
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.run();
    expect(client.triggerDeploy).toHaveBeenCalledTimes(expectedPlanCount);
    for (const call of client.triggerDeploy.mock.calls) {
      const input = call[0];
      expect(input.projectId).toBe('prj_test');
      expect(input.environmentId).toBe('env_test');
      expect(input.serviceId).toEqual(expect.stringMatching(/^svc_/));
    }
  });

  it('does not reach triggerDeploy when a service configure step fails', async () => {
    const client = makeFakeClient({
      updateServiceInstance: vi.fn().mockImplementation(async ({ serviceId }) => {
        if (serviceId === 'svc_api') throw new Error('config boom');
        return true;
      }),
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    await expect(orch.run()).rejects.toThrow(/config boom/);
    expect(client.triggerDeploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.run() — error handling', () => {
  it('aborts the run when createService throws, skipping later services', async () => {
    let createCount = 0;
    const client = makeFakeClient({
      createService: vi.fn().mockImplementation(async ({ name }) => {
        createCount += 1;
        if (createCount === 1) throw new Error('create boom');
        return { id: `svc_${name}`, name };
      }),
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    await expect(orch.run()).rejects.toThrow(/create boom/);
    expect(client.createService).toHaveBeenCalledTimes(1);
    expect(client.updateServiceInstance).not.toHaveBeenCalled();
    expect(client.upsertVariables).not.toHaveBeenCalled();
    expect(client.triggerDeploy).not.toHaveBeenCalled();
  });

  it('emits an onProgress event with ok:false and the error before throwing', async () => {
    const onProgress = vi.fn();
    const client = makeFakeClient({
      createService: vi.fn().mockRejectedValue(new Error('create boom')),
    });
    const orch = new RailwayOrchestrator(client, makeOptions({ onProgress }));
    await expect(orch.run()).rejects.toThrow(/create boom/);
    const failureEvent = onProgress.mock.calls
      .map((c) => c[0])
      .find((ev) => ev.ok === false);
    expect(failureEvent).toBeDefined();
    expect(failureEvent.error).toBeInstanceOf(Error);
    expect(failureEvent.error.message).toMatch(/create boom/);
  });
});

// ---------------------------------------------------------------------------
// Done event
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.run() — done event', () => {
  it('emits a final onProgress event with phase: done and a summary', async () => {
    const onProgress = vi.fn();
    const client = makeFakeClient();
    const orch = new RailwayOrchestrator(client, makeOptions({ onProgress }));
    const result = await orch.run();

    const events = onProgress.mock.calls.map((c) => c[0]);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.phase).toBe('done');
    expect(lastEvent.ok).toBe(true);
    expect(lastEvent.summary).toEqual(
      expect.objectContaining({
        projectId: 'prj_test',
        environmentId: 'env_test',
        servicesCreated: expect.any(Number),
        servicesConfigured: expect.any(Number),
        servicesDeployed: expect.any(Number),
      }),
    );
    // run() returns the same summary
    expect(result).toEqual(lastEvent.summary);
    expect(result.servicesCreated).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Authoritative variable partitioning
// ---------------------------------------------------------------------------

describe('LiveKit browser URL resolves to absolute wss (regression guard for the 2026-06-12 calling outage)', () => {
  it('banter-api LIVEKIT_WS_URL becomes wss://<domain>/livekit-ws, never a relative path', () => {
    const banter = APP_SERVICES.find((s) => s.name === 'banter-api');
    const vars = buildServiceVariables(banter, fullContext()); // publicUrl https://example.up.railway.app
    expect(vars.LIVEKIT_WS_URL).toBe('wss://example.up.railway.app/livekit-ws');
    expect(vars.LIVEKIT_WS_URL.startsWith('/')).toBe(false); // banter returns this verbatim to the SDK
  });

  it('bureau-api LIVEKIT_URL becomes the same absolute wss URL', () => {
    const bureau = APP_SERVICES.find((s) => s.name === 'bureau-api');
    const vars = buildServiceVariables(bureau, fullContext());
    expect(vars.LIVEKIT_URL).toBe('wss://example.up.railway.app/livekit-ws');
  });

  it('an http public URL yields ws:// (not wss://)', () => {
    const banter = APP_SERVICES.find((s) => s.name === 'banter-api');
    const vars = buildServiceVariables(banter, { ...fullContext(), publicUrl: 'http://nas.local:8080' });
    expect(vars.LIVEKIT_WS_URL).toBe('ws://nas.local:8080/livekit-ws');
  });

  it('LIVEKIT_HOST stays the internal http SFU address (server-side SDK)', () => {
    const banter = APP_SERVICES.find((s) => s.name === 'banter-api');
    const vars = buildServiceVariables(banter, fullContext());
    expect(vars.LIVEKIT_HOST).toBe('http://livekit.railway.internal:7880');
  });
});

describe('buildAuthoritativeVariables', () => {
  it('keeps reconcilable (computed/literal) vars and drops everything else', () => {
    const api = getApiService();
    const auth = buildAuthoritativeVariables(api);
    // computed + literal stay (concrete strings that actually drift)
    expect(auth.S3_ENDPOINT).toMatch(/railway\.internal/); // computed
    expect(auth.S3_BUCKET).toBe('bigbluebam-uploads'); // literal
    // plugin/reference are symbolic ${{...}} refs Railway resolves — excluded
    // from reconcile so the live-vs-template diff is never a false positive.
    expect(auth.DATABASE_URL).toBeUndefined(); // plugin
    expect(auth.S3_ACCESS_KEY).toBeUndefined(); // reference
    // secrets and user integrations are excluded — never clobbered on reconcile
    expect(auth.SESSION_SECRET).toBeUndefined(); // secret
    expect(auth.OAUTH_GITHUB_CLIENT_ID).toBeUndefined(); // user
    expect(auth.CORS_ORIGIN).toBeUndefined(); // public
  });

  it('mcp-server authoritative set includes the corrected internal API URL on :8080 and the newly-wired app URLs', () => {
    const mcp = APP_SERVICES.find((s) => s.name === 'mcp-server');
    const auth = buildAuthoritativeVariables(mcp);
    expect(auth.API_INTERNAL_URL).toBe('http://api.railway.internal:8080');
    expect(auth.BANTER_API_URL).toBe('http://banter-api.railway.internal:8080');
    expect(auth.BUREAU_API_URL).toBe('http://bureau-api.railway.internal:8080/v1');
    expect(auth.BLUEPRINT_API_URL).toBe('http://blueprint-api.railway.internal:8080/v1');
    // MCP_INTERNAL_API_TOKEN is a `user` var — must NOT be in the authoritative
    // (overwritable) set, so reconcile never wipes a minted token.
    expect(auth.MCP_INTERNAL_API_TOKEN).toBeUndefined();
  });
});

describe('diffAuthoritativeVariables', () => {
  it('classifies missing vs changed and ignores in-sync keys', () => {
    const desired = { A: '1', B: '2', C: '3' };
    const live = { A: '1', B: 'stale', /* C missing */ };
    const { changed, missing } = diffAuthoritativeVariables(desired, live);
    expect(changed).toEqual({ B: { from: 'stale', to: '2' } });
    expect(missing).toEqual({ C: '3' });
  });
});

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.reconcile()', () => {
  function liveServicesFromPlan() {
    // Every required app service + self-hosted infra + jobs, as if already deployed.
    return [
      ...getRequiredAppServices().filter((s) => s.name !== 'voice-agent'),
      ...getSelfHostedInfra(),
      ...JOB_SERVICES,
    ].map((s) => ({ id: `svc_${s.name}`, name: s.name }));
  }

  it('overwrites a drifted deploy-owned var (API_INTERNAL_URL :4000 → :8080) and redeploys only that service', async () => {
    const live = liveServicesFromPlan();
    const client = makeFakeClient({
      listServices: vi.fn().mockResolvedValue(live),
      // Everything in sync EXCEPT mcp-server, which has the stale :4000 value.
      getServiceVariables: vi.fn().mockImplementation(({ serviceId }) => {
        if (serviceId === 'svc_mcp-server') {
          return Promise.resolve({ API_INTERNAL_URL: 'http://api.railway.internal:4000' });
        }
        // Return the desired authoritative set so other services show no drift.
        const name = serviceId.replace(/^svc_/, '');
        const svc = APP_SERVICES.find((s) => s.name === name) ?? null;
        if (!svc) return Promise.resolve({});
        return Promise.resolve(buildAuthoritativeVariables(svc));
      }),
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    const result = await orch.reconcile();

    // The mcp-server got an upsert that overwrites API_INTERNAL_URL to :8080.
    const mcpUpsert = client.upsertVariables.mock.calls
      .map((c) => c[0])
      .find((a) => a.serviceId === 'svc_mcp-server');
    expect(mcpUpsert).toBeDefined();
    expect(mcpUpsert.variables.API_INTERNAL_URL).toBe('http://api.railway.internal:8080');
    // Newly-wired URLs that were absent live are pushed too.
    expect(mcpUpsert.variables.BANTER_API_URL).toBe('http://banter-api.railway.internal:8080');
    // Only mcp-server was redeployed.
    const redeployed = client.triggerDeploy.mock.calls.map((c) => c[0].serviceId);
    expect(redeployed).toContain('svc_mcp-server');
    expect(result.driftedCount).toBeGreaterThanOrEqual(1);
  });

  it('dryRun reports drift without writing or deploying', async () => {
    const live = liveServicesFromPlan();
    const client = makeFakeClient({
      listServices: vi.fn().mockResolvedValue(live),
      getServiceVariables: vi.fn().mockResolvedValue({}), // everything missing → drift
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    const result = await orch.reconcile({ dryRun: true });
    expect(client.upsertVariables).not.toHaveBeenCalled();
    expect(client.triggerDeploy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.driftedCount).toBeGreaterThan(0);
  });

  it('never overwrites operator-owned secrets/integrations during reconcile', async () => {
    const live = liveServicesFromPlan();
    const client = makeFakeClient({
      listServices: vi.fn().mockResolvedValue(live),
      // api has a rotated session secret and a custom CORS origin live.
      getServiceVariables: vi.fn().mockResolvedValue({
        SESSION_SECRET: 'OPERATOR-ROTATED',
        CORS_ORIGIN: 'https://custom.example.com',
      }),
    });
    const orch = new RailwayOrchestrator(client, makeOptions());
    await orch.reconcile();
    for (const call of client.upsertVariables.mock.calls) {
      const vars = call[0].variables;
      expect(vars).not.toHaveProperty('SESSION_SECRET');
      expect(vars).not.toHaveProperty('CORS_ORIGIN');
    }
  });
});

// ---------------------------------------------------------------------------
// Post-deploy smoke verify
// ---------------------------------------------------------------------------

describe('RailwayOrchestrator.verify()', () => {
  function mockFetch(handler) {
    return vi.fn(async (url, init = {}) => handler(String(url), init));
  }
  function res({ status = 200, headers = {}, text = '' } = {}) {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
      text: async () => text,
    };
  }

  it('passes the no-token path when ingress, api, and mcp are reachable', async () => {
    global.fetch = mockFetch((url) => {
      if (url.includes('/b3/api/public/config')) return res({ status: 200, text: '{}' });
      if (url.includes('/mcp/')) return res({ status: 401 }); // up, unauthenticated
      if (url.endsWith('/')) return res({ status: 200 });
      return res({ status: 404 });
    });
    const orch = new RailwayOrchestrator(makeFakeClient(), makeOptions());
    const result = await orch.verify({ publicUrl: 'https://x.example.com' });
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'mcp→api hop').detail).toMatch(/skipped/);
  });

  it('fails the mcp→api hop check when get_me returns "fetch failed" (the :4000-class outage)', async () => {
    global.fetch = mockFetch((url, init) => {
      if (url.includes('/b3/api/public/config')) return res({ status: 200 });
      // mcp handshake — match on body before the generic /mcp/ probe
      const body = typeof init.body === 'string' ? init.body : '';
      if (body.includes('initialize')) return res({ status: 200, headers: { 'mcp-session-id': 'sess-1' } });
      if (body.includes('notifications/initialized')) return res({ status: 202 });
      if (body.includes('get_me')) return res({ status: 200, text: '{"error":"fetch failed"}' });
      if (url.includes('/mcp/')) return res({ status: 401 });
      if (url.endsWith('/')) return res({ status: 200 });
      return res({ status: 404 });
    });
    const orch = new RailwayOrchestrator(makeFakeClient(), makeOptions());
    const result = await orch.verify({ publicUrl: 'https://x.example.com', token: 'bbam_test' });
    const hop = result.checks.find((c) => c.name === 'mcp→api hop');
    expect(hop.ok).toBe(false);
    expect(hop.detail).toMatch(/upstream api fetch failed/i);
    expect(result.ok).toBe(false);
  });

  it('passes the mcp→api hop when get_me resolves a profile', async () => {
    global.fetch = mockFetch((url, init) => {
      if (url.includes('/b3/api/public/config')) return res({ status: 200 });
      const body = typeof init.body === 'string' ? init.body : '';
      if (body.includes('initialize')) return res({ status: 200, headers: { 'mcp-session-id': 'sess-1' } });
      if (body.includes('notifications/initialized')) return res({ status: 202 });
      if (body.includes('get_me')) return res({ status: 200, text: '{"data":{"email":"a@b.com"}}' });
      if (url.includes('/mcp/')) return res({ status: 401 });
      if (url.endsWith('/')) return res({ status: 200 });
      return res({ status: 404 });
    });
    const orch = new RailwayOrchestrator(makeFakeClient(), makeOptions());
    const result = await orch.verify({ publicUrl: 'https://x.example.com', token: 'bbam_test' });
    expect(result.ok).toBe(true);
  });
});
