import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Dependencies injected into the handler so the test can substitute fakes
 * without spawning a real http listener or hitting the network.
 */
export interface ToolsCallDeps {
  env: {
    INTERNAL_SERVICE_SECRET?: string;
    MCP_INTERNAL_API_TOKEN?: string;
    API_INTERNAL_URL: string;
  };
  logger: Logger;
  apiClientFactory: (baseUrl: string, token: string, logger: Logger) => ApiClient;
  createMcpServer: (apiClient: ApiClient, sessionId: string) => McpServer;
}

interface ToolsCallRequestBody {
  name?: unknown;
  arguments?: unknown;
}

interface RawHandlerRequest {
  params: { name: string; arguments: Record<string, unknown> };
}

interface RawHandlerExtra {
  requestId: string;
  sessionId: string;
}

type RawToolsCallHandler = (request: RawHandlerRequest, extra: RawHandlerExtra) => Promise<unknown>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function pickHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function constantTimeEqual(provided: string, configured: string): boolean {
  if (provided.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
}

/**
 * POST /tools/call is the internal service-to-service entry point for
 * invoking an MCP tool via plain HTTP without going through the Streamable
 * HTTP session dance. It is used by the worker (Bolt action executor) and
 * any other internal consumer that needs to call a single tool and get a
 * single response.
 *
 * Auth: X-Internal-Secret must match env.INTERNAL_SERVICE_SECRET, compared
 * with timingSafeEqual after a length-equality short-circuit (timingSafeEqual
 * throws RangeError on mismatched lengths, hence the guard).
 *
 * Org / actor scoping: org_id is supplied by the caller via X-Org-Id and is
 * logged for forensic traceability, but the actual REST API authority comes
 * from the org-bound service-account bearer token held in
 * env.MCP_INTERNAL_API_TOKEN. The API key is pinned to one org at issuance
 * time, so the server-side call is always scoped to that org regardless of
 * what the header says. X-Actor-Id is informational and forward-compat.
 */
export async function handleToolsCall(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ToolsCallDeps,
): Promise<void> {
  const { env, logger, apiClientFactory, createMcpServer } = deps;

  // 1. Auth: require X-Internal-Secret to match the configured shared secret.
  if (!env.INTERNAL_SERVICE_SECRET) {
    sendJson(res, 503, {
      error: {
        code: 'INTERNAL_SECRET_NOT_CONFIGURED',
        message: 'INTERNAL_SERVICE_SECRET is not set on the MCP server; /tools/call is disabled',
      },
    });
    return;
  }
  const provided = pickHeader(req, 'x-internal-secret');
  if (!provided || !constantTimeEqual(provided, env.INTERNAL_SERVICE_SECRET)) {
    sendJson(res, 401, {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing X-Internal-Secret header',
      },
    });
    return;
  }

  // 2. Require an outbound bearer token to act on behalf of the caller.
  if (!env.MCP_INTERNAL_API_TOKEN) {
    sendJson(res, 503, {
      error: {
        code: 'INTERNAL_TOKEN_NOT_CONFIGURED',
        message:
          'MCP_INTERNAL_API_TOKEN is not set on the MCP server; cannot call the Bam REST API on behalf of internal callers',
      },
    });
    return;
  }

  // 3. Parse the JSON body. Reject malformed requests with 400.
  const raw = await readBody(req);
  let body: ToolsCallRequestBody;
  try {
    body = JSON.parse(raw) as ToolsCallRequestBody;
  } catch {
    sendJson(res, 400, {
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
    return;
  }
  if (typeof body.name !== 'string' || body.name.length === 0) {
    sendJson(res, 400, {
      error: { code: 'INVALID_REQUEST', message: 'Field "name" is required and must be a non-empty string' },
    });
    return;
  }
  const toolName = body.name;
  const toolArgs: Record<string, unknown> =
    body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
      ? (body.arguments as Record<string, unknown>)
      : {};

  // 4. Read scoping headers. Both are advisory at this layer; the actual
  // REST API authority comes from the bearer token. Logged for audit.
  const orgId = pickHeader(req, 'x-org-id') ?? null;
  const actorId = pickHeader(req, 'x-actor-id') ?? null;
  const sessionId = `internal-${randomUUID()}`;
  const requestId = randomUUID();

  logger.info(
    { tool: toolName, orgId, actorId, sessionId, requestId },
    'Internal /tools/call invocation',
  );

  // 5. Build a fresh ApiClient and McpServer for this single call. We do not
  // reuse a long-lived server because tool registration is per-server and
  // each call gets its own session id for rate limiting + audit trails.
  const apiClient = apiClientFactory(env.API_INTERNAL_URL, env.MCP_INTERNAL_API_TOKEN, logger);
  const mcpServer = createMcpServer(apiClient, sessionId);

  // 6. The createMcpServer factory schedules its rate-limit / audit wrapper
  // via queueMicrotask after tool registration. We must yield through one
  // microtask boundary so that wrapper has installed before we look up the
  // handler, otherwise we would invoke the bare SDK handler and bypass the
  // audit log entirely.
  await new Promise((r) => queueMicrotask(() => r(undefined)));

  const handlers = (mcpServer.server as unknown as { _requestHandlers: Map<string, RawToolsCallHandler> })
    ._requestHandlers;
  const toolsCallHandler = handlers?.get('tools/call');
  if (!toolsCallHandler) {
    logger.error({ tool: toolName }, 'tools/call handler not registered on McpServer');
    sendJson(res, 500, {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'tools/call handler is not available on the MCP server',
      },
    });
    return;
  }

  try {
    const result = await toolsCallHandler(
      { params: { name: toolName, arguments: toolArgs } },
      { requestId, sessionId },
    );
    sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, tool: toolName, sessionId }, 'tools/call handler threw');
    sendJson(res, 500, {
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
}
