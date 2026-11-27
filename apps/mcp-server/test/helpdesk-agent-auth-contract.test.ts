import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from '../src/middleware/api-client.js';
import { registerHelpdeskTools } from '../src/tools/helpdesk-tools.js';

// #339, client side of the contract: the helpdesk ticket tools act as a
// support agent, so they call helpdesk-api's agent surface
// (/helpdesk/agents/*) with the caller's Bam API key as Bearer. That surface
// accepts it (apps/helpdesk-api/test/agent-bearer-auth.test.ts). They used to
// call the customer routes (/helpdesk/tickets/*), which accept only a
// customer's helpdesk_session cookie, so every call was 401.

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
const TICKET = '44444444-4444-4444-8444-444444444444';

describe('MCP helpdesk ticket tools call the agent surface with the Bam API key (#339)', () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { id: TICKET, subject: 'Castaway Rescue Request', ticket_number: 7 } }),
      json: async () => ({ data: { id: TICKET, subject: 'Castaway Rescue Request', ticket_number: 7 } }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }));
    const api = new ApiClient('http://api:4000', KEY, pino({ level: 'silent' }));
    const mock = createMockServer();
    tools = mock.tools;
    registerHelpdeskTools(mock.server, api, HELPDESK);
  });

  function helpdeskCalls(): Array<{ url: string; method: string; headers: Headers }> {
    return mockFetch.mock.calls
      .map(([url, init]) => ({
        url: String(url),
        method: ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
        headers: new Headers((init as RequestInit | undefined)?.headers),
      }))
      .filter((c) => c.url.startsWith(HELPDESK));
  }

  it.each([
    ['list_tickets', { status: 'open' }, 'GET', '/helpdesk/agents/tickets?status=open'],
    ['get_ticket', { ticket_id: TICKET }, 'GET', `/helpdesk/agents/tickets/${TICKET}`],
    ['helpdesk_search_tickets', { query: 'coconut' }, 'GET', '/helpdesk/agents/tickets/search?q=coconut'],
    ['reply_to_ticket', { ticket_id: TICKET, body: 'Rescue is on the way' }, 'POST', `/helpdesk/agents/tickets/${TICKET}/messages`],
    ['update_ticket_status', { ticket_id: '#7', status: 'resolved' }, 'PATCH', `/helpdesk/agents/tickets/${TICKET}`],
  ])('%s calls the agent route with Authorization: Bearer <caller key>', async (name, args, method, path) => {
    const handler = tools.get(name as string);
    expect(handler, `${name} registered`).toBeTypeOf('function');
    const res = await handler!(args as Record<string, unknown>);
    expect(res.isError, res.content?.[0]?.text).toBeFalsy();
    const calls = helpdeskCalls();
    const call = calls.find((c) => c.method === method && c.url === `${HELPDESK}${path}`);
    expect(call, JSON.stringify(calls.map((c) => `${c.method} ${c.url}`))).toBeDefined();
    expect(call!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    // Never a customer route.
    expect(calls.some((c) => c.url.includes('/helpdesk/tickets'))).toBe(false);
  });

  it('a ticket number resolves through the agent by-number route', async () => {
    await tools.get('update_ticket_status')!({ ticket_id: '7', status: 'closed' });
    const calls = helpdeskCalls();
    expect(calls[0]!.url).toBe(`${HELPDESK}/helpdesk/agents/tickets/by-number/7`);
  });
});
