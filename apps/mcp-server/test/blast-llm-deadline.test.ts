import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM_CALL_TIMEOUT_DEFAULT_MS } from '@bigbluebam/shared';
import { generateWithLlm } from '../src/tools/blast-tools.js';

// #283: the Blast AI tools reach the LLM proxy through the shared client: the body carries the
// proxy's own default deadline as timeout_ms (before: a literal 45 s client abort the proxy knew
// nothing about), and any failure, a 504 included, falls back to the heuristic (null).

describe('blast generateWithLlm (#283)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends timeout_ms through the shared client and falls back on a 504', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith('/llm-providers/resolve')) {
          return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: { id: 'prov', provider_type: 'anthropic', model_id: 'm' } }) };
        }
        return { ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT' } }) };
      }),
    );
    const api = { token: 'bbam_x' } as never;
    const r = await generateWithLlm(api, { apiInternalUrl: 'http://api:4000', internalSecret: 's'.repeat(32) }, 'sys', 'user');
    expect(r).toBeNull();
    const chat = calls.find(([u]) => u.endsWith('/internal/llm/chat'));
    expect(chat).toBeDefined();
    const body = JSON.parse(String(chat![1]!.body));
    expect(body.timeout_ms).toBe(LLM_CALL_TIMEOUT_DEFAULT_MS);
    expect(body.provider_id).toBe('prov');
    expect((chat![1]!.headers as Record<string, string>)['X-Internal-Service']).toBe('mcp-blast');
  });
});
