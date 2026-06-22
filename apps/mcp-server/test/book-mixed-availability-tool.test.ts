import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from '../src/middleware/api-client.js';
import { registerBookTools } from '../src/tools/book-tools.js';

/**
 * §18 Wave 5 misc — book_find_meeting_time_for_users MCP tool tests.
 *
 * Focuses on the tool's role as a thin fan-out to the book-api
 * POST /availability/meeting-time-mixed endpoint: email-to-uuid resolution,
 * pass-through of the window/roster, and surfacing the response shape.
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const logger = pino({ level: 'silent' });

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  handler: ToolHandler;
}

function createMockServer(): { server: McpServer; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: ToolHandler,
    ) => {
      tools.set(name, { name, description, schema, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

// Tools read the body via res.text() then JSON.parse, so the mock must expose
// text() alongside json().
function mockApiOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
  });
}

function mockApiError(status: number, data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => data,
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
  });
}

const HUMAN = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';

describe('book_find_meeting_time_for_users MCP tool (§18 Wave 5)', () => {
  let tools: Map<string, RegisteredTool>;
  let api: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    api = new ApiClient('http://localhost:4000', 'test-token', logger);
    const mock = createMockServer();
    tools = mock.tools;
    registerBookTools(mock.server, api, 'http://localhost:4012');
  });

  function getTool(name: string): RegisteredTool {
    const t = tools.get(name);
    if (!t) throw new Error(`Tool "${name}" not registered`);
    return t;
  }

  it('registers book_find_meeting_time_for_users', () => {
    expect(tools.has('book_find_meeting_time_for_users')).toBe(true);
  });

  it('POSTs the mixed-roster request and surfaces slots', async () => {
    // Two UUIDs: no email resolution needed. The single backend POST returns
    // one slot with a mixed attendee list; the tool must pass that through.
    mockApiOk({
      slots: [
        {
          start: '2026-04-20T09:00:00Z',
          end: '2026-04-20T09:30:00Z',
          attendees: [
            { user_id: HUMAN, kind: 'human', available: true },
            { user_id: AGENT, kind: 'agent', available: true },
          ],
        },
      ],
    });

    const res = await getTool('book_find_meeting_time_for_users').handler({
      user_ids: [HUMAN, AGENT],
      duration_minutes: 30,
      window: { since: '2026-04-20T00:00:00Z', until: '2026-04-21T00:00:00Z' },
      respect_working_hours_for_humans_only: true,
    });

    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0].attendees).toHaveLength(2);

    // Assert the outbound URL and method.
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('http://localhost:4012/availability/meeting-time-mixed');
    expect(call[1].method).toBe('POST');
    const posted = JSON.parse(call[1].body as string);
    expect(posted.user_ids).toEqual([HUMAN, AGENT]);
    expect(posted.duration_minutes).toBe(30);
    expect(posted.respect_working_hours_for_humans_only).toBe(true);
  });

  it('resolves email addresses to UUIDs before calling book-api', async () => {
    // First fetch: /users/by-email for the email entry. Tool short-circuits
    // UUIDs. Then the POST to availability/meeting-time-mixed.
    mockApiOk({ data: { id: HUMAN } });
    mockApiOk({ slots: [] });

    const res = await getTool('book_find_meeting_time_for_users').handler({
      user_ids: ['alice@example.com', AGENT],
      duration_minutes: 30,
      window: { since: '2026-04-20T00:00:00Z', until: '2026-04-21T00:00:00Z' },
    });

    expect(res.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const byEmailCall = mockFetch.mock.calls[0]!;
    expect(byEmailCall[0]).toContain('/users/by-email?email=alice%40example.com');
    const postCall = mockFetch.mock.calls[1]!;
    const posted = JSON.parse(postCall[1].body as string);
    expect(posted.user_ids).toEqual([HUMAN, AGENT]);
  });

  it('returns isError when an email does not resolve', async () => {
    // Simulate a 404 from /users/by-email.
    mockApiError(404, { error: 'not found' });

    const res = await getTool('book_find_meeting_time_for_users').handler({
      user_ids: ['nobody@example.com'],
      duration_minutes: 30,
      window: { since: '2026-04-20T00:00:00Z', until: '2026-04-21T00:00:00Z' },
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Unresolved user');
    // No POST to the backend since resolution failed.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces book-api errors with isError', async () => {
    mockApiError(400, { error: { code: 'VALIDATION_ERROR', message: 'bad window' } });
    const res = await getTool('book_find_meeting_time_for_users').handler({
      user_ids: [HUMAN],
      duration_minutes: 30,
      window: { since: '2026-04-20T00:00:00Z', until: '2026-04-21T00:00:00Z' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('VALIDATION_ERROR');
  });
});
