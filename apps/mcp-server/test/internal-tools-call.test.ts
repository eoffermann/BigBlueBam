import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { handleToolsCall, type ToolsCallDeps } from '../src/routes/tools-call.js';
import { ApiClient } from '../src/middleware/api-client.js';

const logger = pino({ level: 'silent' });

// ---------- Mock IncomingMessage ----------
// A minimal shape that satisfies handleToolsCall. It is an EventEmitter so
// the readBody() helper can listen for 'data' / 'end' / 'error'.

function mockReq(options: {
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  emitter.headers = options.headers ?? {};
  emitter.method = 'POST';
  emitter.url = '/tools/call';

  // Defer emitting so the handler can subscribe first.
  queueMicrotask(() => {
    if (options.body !== undefined) {
      emitter.emit('data', Buffer.from(options.body));
    }
    emitter.emit('end');
  });

  return emitter as unknown as IncomingMessage;
}

interface MockRes {
  status: number | null;
  headers: Record<string, string> | null;
  body: string | null;
  writeHead: (status: number, headers?: Record<string, string>) => MockRes;
  end: (data?: string) => void;
}

function mockRes(): MockRes {
  const res: MockRes = {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers ?? {};
      return res;
    },
    end(data) {
      res.body = data ?? null;
    },
  };
  return res;
}

// ---------- Fake McpServer with an installable tools/call handler ----------

type RawToolsCallHandler = (
  req: { params: { name: string; arguments: Record<string, unknown> } },
  extra: { requestId: string; sessionId: string },
) => Promise<unknown>;

function fakeMcpServer(handler: RawToolsCallHandler): McpServer {
  const map = new Map<string, RawToolsCallHandler>();
  // Install synchronously so the microtask boundary in handleToolsCall still
  // matches the shipping production flow (the real factory schedules the
  // install via queueMicrotask, and we also exercise the boundary by making
  // the install synchronous or deferred depending on the test).
  map.set('tools/call', handler);
  return {
    server: {
      _requestHandlers: map,
    },
  } as unknown as McpServer;
}

function deps(overrides: Partial<ToolsCallDeps> = {}): ToolsCallDeps {
  return {
    env: {
      INTERNAL_SERVICE_SECRET: 'x'.repeat(32),
      MCP_INTERNAL_API_TOKEN: 'bbam_fake_token_for_tests',
      API_INTERNAL_URL: 'http://api.test',
      ...(overrides.env ?? {}),
    },
    logger,
    apiClientFactory: (baseUrl, token, log) => new ApiClient(baseUrl, token, log),
    createMcpServer: overrides.createMcpServer ??
      (() =>
        fakeMcpServer(async () => ({
          content: [{ type: 'text', text: 'default' }],
        }))),
  };
}

describe('POST /tools/call handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when X-Internal-Secret is missing', async () => {
    const req = mockReq({ headers: {}, body: JSON.stringify({ name: 'task_list' }) });
    const res = mockRes();
    let handlerCalled = false;
    const d = deps({
      createMcpServer: () =>
        fakeMcpServer(async () => {
          handlerCalled = true;
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
    });

    await handleToolsCall(req, res as unknown as ServerResponse, d);

    expect(res.status).toBe(401);
    const body = JSON.parse(res.body ?? '{}');
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(handlerCalled).toBe(false);
  });

  it('returns 401 when X-Internal-Secret does not match', async () => {
    const req = mockReq({
      headers: { 'x-internal-secret': 'wrong-secret-value' },
      body: JSON.stringify({ name: 'task_list' }),
    });
    const res = mockRes();
    await handleToolsCall(req, res as unknown as ServerResponse, deps());
    expect(res.status).toBe(401);
  });

  it('returns 200 with the tool result on a valid call', async () => {
    const captured: Array<{ params: { name: string; arguments: Record<string, unknown> }; extra: { requestId: string; sessionId: string } }> = [];
    const d = deps({
      createMcpServer: () =>
        fakeMcpServer(async (req, extra) => {
          captured.push({ params: req.params, extra });
          return {
            content: [{ type: 'text', text: JSON.stringify({ data: { tasks: [] } }) }],
          };
        }),
    });

    const req = mockReq({
      headers: {
        'x-internal-secret': 'x'.repeat(32),
        'x-org-id': 'org-123',
        'x-actor-id': 'actor-456',
      },
      body: JSON.stringify({
        name: 'task_list',
        arguments: { project_id: '550e8400-e29b-41d4-a716-446655440000' },
      }),
    });
    const res = mockRes();

    await handleToolsCall(req, res as unknown as ServerResponse, d);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body ?? '{}');
    expect(body.content).toBeDefined();
    expect(body.content[0].type).toBe('text');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.params.name).toBe('task_list');
    expect(captured[0]!.params.arguments.project_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(captured[0]!.extra.sessionId).toMatch(/^internal-/);
    expect(captured[0]!.extra.requestId).toBeDefined();
  });

  it('returns 200 with isError:true when the tool reports a validation error', async () => {
    const d = deps({
      createMcpServer: () =>
        fakeMcpServer(async () => ({
          content: [{ type: 'text', text: 'Invalid arguments: project_id is required' }],
          isError: true,
        })),
    });

    const req = mockReq({
      headers: { 'x-internal-secret': 'x'.repeat(32) },
      body: JSON.stringify({ name: 'task_list', arguments: {} }),
    });
    const res = mockRes();

    await handleToolsCall(req, res as unknown as ServerResponse, d);

    // The HTTP layer never serializes tool validation errors as non-2xx.
    // This matches the SDK shape: tool errors come back inside the result
    // object with isError:true, not via an HTTP status change.
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body ?? '{}');
    expect(body.isError).toBe(true);
    expect(body.content).toBeDefined();
    expect(body.content[0].text).toContain('project_id');
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = mockReq({
      headers: { 'x-internal-secret': 'x'.repeat(32) },
      body: 'not-json-{{{',
    });
    const res = mockRes();
    await handleToolsCall(req, res as unknown as ServerResponse, deps());
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body ?? '{}');
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('returns 400 when "name" is missing', async () => {
    const req = mockReq({
      headers: { 'x-internal-secret': 'x'.repeat(32) },
      body: JSON.stringify({ arguments: {} }),
    });
    const res = mockRes();
    await handleToolsCall(req, res as unknown as ServerResponse, deps());
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body ?? '{}');
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 503 when INTERNAL_SERVICE_SECRET is not configured', async () => {
    const d = deps({ env: { INTERNAL_SERVICE_SECRET: undefined, MCP_INTERNAL_API_TOKEN: 'bbam_x', API_INTERNAL_URL: 'http://api.test' } });
    const req = mockReq({ headers: {}, body: JSON.stringify({ name: 'task_list' }) });
    const res = mockRes();
    await handleToolsCall(req, res as unknown as ServerResponse, d);
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body ?? '{}');
    expect(body.error.code).toBe('INTERNAL_SECRET_NOT_CONFIGURED');
  });
});
