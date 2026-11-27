import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from '../src/middleware/api-client.js';
import { registerHelpdeskTools } from '../src/tools/helpdesk-tools.js';
import { registerPhraseCountTools } from '../src/tools/phrase-count-tools.js';

// #325, client side of the contract: the helpdesk admin tools authenticate to
// helpdesk-api with the caller's own Bam API key as `Authorization: Bearer
// bbam_...`. helpdesk-api's requireAdminAuth accepts exactly that credential
// (apps/helpdesk-api/test/admin-auth.test.ts, "Bam API key as Bearer"); these
// tests pin the header the tools send so the two sides cannot drift again.

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => tools.set(name, handler),
  } as unknown as McpServer;
  return { server, tools };
}

const KEY = 'bbam_callerKey_0123456789';
const HELPDESK = 'http://helpdesk-api:4001';

describe('MCP helpdesk admin tools send the Bam API key as Bearer (#325)', () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '{"data":{}}' });
    const api = new ApiClient('http://api:4000', KEY, pino({ level: 'silent' }));
    const mock = createMockServer();
    tools = mock.tools;
    registerHelpdeskTools(mock.server, api, HELPDESK);
    registerPhraseCountTools(mock.server, api, { helpdeskApiUrl: HELPDESK, apiUrl: 'http://api:4000' });
  });

  function lastCall(): { url: string; headers: Headers } {
    const [url, init] = mockFetch.mock.calls.at(-1)! as [string, RequestInit];
    return { url, headers: new Headers(init.headers) };
  }

  it.each([
    ['helpdesk_get_settings', {}, '/helpdesk/settings'],
    ['helpdesk_update_settings', { welcome_message: 'Welcome castaways' }, '/helpdesk/settings'],
    [
      'helpdesk_ticket_count_by_phrase',
      { phrase: 'coconut', buckets: 'day', window: { since: '2026-11-01T00:00:00Z' } },
      '/v1/tickets/analytics/count-by-phrase',
    ],
  ])('%s calls %s with Authorization: Bearer <caller key>', async (name, args, path) => {
    const handler = tools.get(name as string);
    expect(handler, `${name} registered`).toBeTypeOf('function');
    const res = await handler!(args as Record<string, unknown>);
    expect(res.isError).toBeFalsy();
    const { url, headers } = lastCall();
    expect(url.startsWith(`${HELPDESK}${path}`)).toBe(true);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });
});
