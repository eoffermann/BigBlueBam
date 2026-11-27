import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

// #283: the basis-explain narrative call goes through the shared LLM client: BASIS_LLM_TIMEOUT_MS
// is sent to the proxy as timeout_ms (before: the worker re-derived its own +5 s grace from
// LLM_TIMEOUT_MS and never told the proxy, which cut at 60 s), and a 504 counts the row failed.

const execute = vi.fn();
vi.mock('../src/utils/db.js', () => ({ getDb: () => ({ execute }) }));
vi.mock('@bigbluebam/shared', async (orig) => ({ ...(await orig<object>()), publishBoltEvent: vi.fn(async () => undefined) }));

const { processBasisExplainJob, basisLlmTimeoutMs } = await import('../src/jobs/basis-explain.job.js');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe('basis-explain LLM deadline (#283)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    execute.mockReset();
  });

  it('reads BASIS_LLM_TIMEOUT_MS, then LLM_TIMEOUT_MS, else the proxy default', () => {
    expect(basisLlmTimeoutMs({ BASIS_LLM_TIMEOUT_MS: '90000', LLM_TIMEOUT_MS: '1000' } as NodeJS.ProcessEnv)).toBe(90_000);
    expect(basisLlmTimeoutMs({ LLM_TIMEOUT_MS: '20000' } as NodeJS.ProcessEnv)).toBe(20_000);
    expect(basisLlmTimeoutMs({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('sends timeout_ms to the proxy and counts a 504 as a failed row', async () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', 's'.repeat(32));
    vi.stubEnv('BASIS_LLM_TIMEOUT_MS', '120000');
    const row = {
      cache_key: 'k', metric_id: 'm', organization_id: 'o', metric_name: 'Revenue', unit: 'usd',
      dimension: 'region', delta_abs: '10', delta_pct: '5', drivers: [{ dimension_value: 'EU', label: 'EU', contribution_abs: 10, contribution_pct: 100 }],
    };
    execute.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ id: 'prov' }]);
    const f = vi.fn(async () => ({ ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT' } }) }));
    vi.stubGlobal('fetch', f);
    await processBasisExplainJob({ id: 'j', data: {} } as never, logger);
    const [, init] = f.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(init.body).timeout_ms).toBe(120_000);
    expect(init.headers['X-Internal-Service']).toBe('basis');
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ failed: 1, narrated: 0 });
  });

  it('calls the api at BBB_API_INTERNAL_URL, the worker-wide name Railway computes (#192)', async () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', 's'.repeat(32));
    vi.stubEnv('BBB_API_INTERNAL_URL', 'http://api.railway.internal:8080');
    vi.stubEnv('API_INTERNAL_URL', 'http://wrong-name:1');
    const row = {
      cache_key: 'k', metric_id: 'm', organization_id: 'o', metric_name: 'Revenue', unit: 'usd',
      dimension: 'region', delta_abs: '10', delta_pct: '5', drivers: [{ dimension_value: 'EU', label: 'EU', contribution_abs: 10, contribution_pct: 100 }],
    };
    execute.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ id: 'prov' }]);
    const f = vi.fn(async () => ({ ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT' } }) }));
    vi.stubGlobal('fetch', f);
    await processBasisExplainJob({ id: 'j', data: {} } as never, logger);
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(String(url).startsWith('http://api.railway.internal:8080/')).toBe(true);
  });
});
