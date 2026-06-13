import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import pino from 'pino';
import { handleToolsCall, type ToolsCallDeps } from '../src/routes/tools-call.js';

const logger = pino({ level: 'silent' });
const SECRET = 'x'.repeat(40);
const TOKEN = 'bbam_svc_test_token';

// Minimal IncomingMessage stand-in: handleToolsCall only reads `.headers` and
// streams the body via req.on('data'/'end'). Readable.from gives us both.
function makeReq(body: unknown, headers: Record<string, string>) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(json)]) as unknown as {
    headers: Record<string, string>;
  } & Readable;
  req.headers = headers;
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(payload: string) {
      this.body = payload;
    },
  };
}

function makeDeps(
  overrides: Partial<ToolsCallDeps> = {},
  recorder?: { request?: unknown },
) {
  const handler = vi.fn(async (request: unknown) => {
    if (recorder) recorder.request = request;
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const createMcpServer = vi.fn(() => ({
    server: { _requestHandlers: new Map([['tools/call', handler]]) },
  })) as unknown as ToolsCallDeps['createMcpServer'];
  const deps: ToolsCallDeps = {
    logger,
    internalSecret: SECRET,
    apiInternalUrl: 'http://api.test',
    mcpInternalApiToken: TOKEN,
    createMcpServer,
    ...overrides,
  };
  return { deps, handler };
}

describe('handleToolsCall (internal /tools/call route)', () => {
  it('synthesizes the SDK request WITH method:"tools/call" (regression: params-only 500s)', async () => {
    const recorder: { request?: { method?: unknown; params?: unknown } } = {};
    const { deps } = makeDeps({}, recorder);
    const req = makeReq(
      { name: 'get_server_info', arguments: {} },
      { 'x-internal-secret': SECRET },
    );
    const res = makeRes();

    await handleToolsCall(req, res as unknown as ServerResponse, deps);

    expect(res.statusCode).toBe(200);
    // The SDK's tools/call handler validates against CallToolRequestSchema
    // (method: z.literal('tools/call')); the request MUST carry method or it
    // throws a Zod error and the route 500s. This is the exact prod regression.
    expect(recorder.request).toMatchObject({
      method: 'tools/call',
      params: { name: 'get_server_info', arguments: {} },
    });
  });

  it('returns 503 when INTERNAL_SERVICE_SECRET is unset', async () => {
    const { deps } = makeDeps({ internalSecret: '' });
    const res = makeRes();
    await handleToolsCall(
      makeReq({ name: 'x' }, {}),
      res as unknown as ServerResponse,
      deps,
    );
    expect(res.statusCode).toBe(503);
  });

  it('returns 503 when MCP_INTERNAL_API_TOKEN is unset', async () => {
    const { deps } = makeDeps({ mcpInternalApiToken: '' });
    const res = makeRes();
    await handleToolsCall(
      makeReq({ name: 'x' }, { 'x-internal-secret': SECRET }),
      res as unknown as ServerResponse,
      deps,
    );
    expect(res.statusCode).toBe(503);
  });

  it('returns 401 on a wrong X-Internal-Secret', async () => {
    const { deps } = makeDeps();
    const res = makeRes();
    await handleToolsCall(
      makeReq({ name: 'x' }, { 'x-internal-secret': 'wrong' }),
      res as unknown as ServerResponse,
      deps,
    );
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const { deps } = makeDeps();
    const res = makeRes();
    await handleToolsCall(
      makeReq({ arguments: {} }, { 'x-internal-secret': SECRET }),
      res as unknown as ServerResponse,
      deps,
    );
    expect(res.statusCode).toBe(400);
  });
});
