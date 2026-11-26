import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from '../src/middleware/api-client.js';
import { registerVisibilityTools } from '../src/tools/visibility-tools.js';
import { VISIBILITY_ENTITY_TYPES, canAccessToolDescription } from '@bigbluebam/shared';

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

function mockApiOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

function mockApiError(status: number, data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => data,
  });
}

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const UUID2 = '660e8400-e29b-41d4-a716-446655440001';

describe('visibility MCP tools', () => {
  let tools: Map<string, RegisteredTool>;
  let api: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    api = new ApiClient('http://localhost:4000', 'test-token', logger);
    const mock = createMockServer();
    tools = mock.tools;
    registerVisibilityTools(mock.server, api);
  });

  function getTool(name: string): RegisteredTool {
    const t = tools.get(name);
    if (!t) throw new Error(`Tool "${name}" not registered`);
    return t;
  }

  it('registers can_access', () => {
    expect(tools.has('can_access')).toBe(true);
    expect(tools.get('can_access')!.description).toMatch(/preflight/i);
  });

  it('the can_access description is generated from the one shared entity-type list', () => {
    // Regenerate with: node scripts/gen-can-access-description.mjs
    expect(tools.get('can_access')!.description).toBe(canAccessToolDescription(VISIBILITY_ENTITY_TYPES));
    for (const t of ['bastion.control', 'bastion.manual_evidence', 'bastion.policy', 'bastion.questionnaire', 'bastion.fix_draft', 'bastion.exception']) {
      expect(tools.get('can_access')!.description).toContain(t);
    }
  });

  it('forwards asker_user_id, entity_type, entity_id to /v1/visibility/can_access', async () => {
    mockApiOk({ data: { allowed: true, reason: 'ok', entity_org_id: UUID2 } });

    const result = await getTool('can_access').handler({
      asker_user_id: UUID,
      entity_type: 'bam.task',
      entity_id: UUID2,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data.allowed).toBe(true);
    expect(parsed.data.reason).toBe('ok');

    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toContain('/v1/visibility/can_access');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string);
    expect(body.asker_user_id).toBe(UUID);
    expect(body.entity_type).toBe('bam.task');
    expect(body.entity_id).toBe(UUID2);
  });

  it('surfaces API errors as isError: true', async () => {
    mockApiError(400, {
      error: { code: 'VALIDATION_ERROR', message: 'Invalid can_access payload' },
    });

    const result = await getTool('can_access').handler({
      asker_user_id: 'not-a-uuid',
      entity_type: 'bam.task',
      entity_id: UUID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('VALIDATION_ERROR');
  });

  it('passes through an allowed=false response (denial is not an MCP error)', async () => {
    mockApiOk({
      data: { allowed: false, reason: 'not_project_member', entity_org_id: UUID2 },
    });

    const result = await getTool('can_access').handler({
      asker_user_id: UUID,
      entity_type: 'bam.task',
      entity_id: UUID2,
    });

    // A denial is a successful preflight answer, not an MCP error.
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data.allowed).toBe(false);
    expect(parsed.data.reason).toBe('not_project_member');
  });

  it('passes through unsupported_entity_type verbatim', async () => {
    mockApiOk({
      data: {
        allowed: false,
        reason: 'unsupported_entity_type',
        supported_entity_types: ['bam.task', 'bond.deal'],
      },
    });

    const result = await getTool('can_access').handler({
      asker_user_id: UUID,
      entity_type: 'mystery.thing',
      entity_id: UUID2,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data.reason).toBe('unsupported_entity_type');
    expect(parsed.data.supported_entity_types).toContain('bam.task');
  });
});
