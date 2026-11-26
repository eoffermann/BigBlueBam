/**
 * Internal HTTP route: POST /tools/call
 *
 * This route is the restoration of the Wave 0.2 direct-invocation path that
 * bolt-api's action runner (and other internal service callers) use to invoke
 * MCP tools without establishing a Streamable-HTTP or SSE session. The public
 * /mcp transport is intended for real MCP clients; /tools/call is a local
 * shortcut for service-to-service tool invocation inside the cluster.
 *
 * Authentication: the suite-wide internal rule from @bigbluebam/service-health/internal-peer
 * (X-Internal-Secret or X-Internal-Service-Secret, timing-safe; direct private-network peers only).
 * The secret is provisioned via INTERNAL_SERVICE_SECRET and is shared across
 * api, worker, bolt-api, and this mcp-server.
 *
 * Org/actor scoping: comes from the service account's bearer token that
 * this route uses to construct the per-request ApiClient. Callers may also
 * pass X-Org-Id and X-Actor-Id as advisory headers which the route records
 * for audit purposes only (the real authorization always flows through
 * the bearer token bound to the service account).
 *
 * Returns the raw MCP CallToolResult as JSON 200 (see @modelcontextprotocol/sdk).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { internalRequestVerdict } from '@bigbluebam/service-health/internal-peer';
import type { Logger } from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from '../middleware/api-client.js';

export interface ToolsCallDeps {
  logger: Logger;
  internalSecret: string;
  apiInternalUrl: string;
  mcpInternalApiToken: string;
  createMcpServer: (apiClient: ApiClient, sessionId: string) => McpServer;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

type ToolsCallHandler = (
  // `method` is required: the SDK's tools/call handler validates the request
  // against CallToolRequestSchema (method: z.literal('tools/call')). Typing it
  // here forces the synthesized request to carry it so the route can't regress
  // to the params-only shape that 500s.
  request: { method: 'tools/call'; params: { name: string; arguments?: Record<string, unknown> } },
  extra: { requestId: string; sessionId: string },
) => Promise<unknown>;

export async function handleToolsCall(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ToolsCallDeps,
): Promise<void> {
  const { logger, internalSecret, apiInternalUrl, mcpInternalApiToken } = deps;

  if (!internalSecret) {
    logger.error(
      'handleToolsCall: INTERNAL_SERVICE_SECRET is not configured; refusing /tools/call',
    );
    sendJson(res, 503, {
      error: {
        code: 'INTERNAL_NOT_CONFIGURED',
        message: 'Internal service secret is not configured on this mcp-server',
      },
    });
    return;
  }

  if (!mcpInternalApiToken) {
    logger.error(
      'handleToolsCall: MCP_INTERNAL_API_TOKEN is not configured; refusing /tools/call',
    );
    sendJson(res, 503, {
      error: {
        code: 'INTERNAL_NOT_CONFIGURED',
        message: 'MCP internal API token is not configured on this mcp-server',
      },
    });
    return;
  }

  // The suite-wide internal rule (#252, #277): constant-time compare on either internal-secret
  // header, and the caller must be a direct private-network peer (the socket address, not
  // X-Forwarded-For; a request relayed by the edge nginx is refused). Every legitimate caller
  // (worker bolt-execute, bolt-api, api) reaches this at MCP_INTERNAL_URL on the private network.
  const verdict = internalRequestVerdict(
    { headers: req.headers, remoteAddress: req.socket?.remoteAddress },
    { secrets: [internalSecret] },
  );
  if (verdict === 'unconfigured' || verdict === 'bad_secret') {
    logger.warn({ verdict }, 'handleToolsCall: internal secret rejected');
    sendJson(res, 401, {
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing internal service secret' },
    });
    return;
  }
  if (verdict === 'not_private') {
    logger.warn(
      { peer: req.socket?.remoteAddress, forwarded: req.headers['x-forwarded-for'] ?? null },
      'handleToolsCall: internal credential from a caller that is not a direct private-network peer',
    );
    sendJson(res, 403, {
      error: { code: 'FORBIDDEN', message: 'Internal endpoints are not reachable from this network' },
    });
    return;
  }

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    logger.error({ err }, 'handleToolsCall: failed to read request body');
    sendJson(res, 400, {
      error: { code: 'BAD_REQUEST', message: 'Failed to read request body' },
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, {
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    sendJson(res, 400, {
      error: { code: 'BAD_REQUEST', message: 'Request body must be an object' },
    });
    return;
  }

  const { name, arguments: args } = parsed as {
    name?: unknown;
    arguments?: unknown;
  };

  if (typeof name !== 'string' || name.length === 0) {
    sendJson(res, 400, {
      error: { code: 'BAD_REQUEST', message: 'Missing or invalid `name` field' },
    });
    return;
  }

  if (args !== undefined && (typeof args !== 'object' || args === null)) {
    sendJson(res, 400, {
      error: { code: 'BAD_REQUEST', message: '`arguments` must be an object if provided' },
    });
    return;
  }

  const orgId = (req.headers['x-org-id'] as string | undefined) ?? null;
  const actorId = (req.headers['x-actor-id'] as string | undefined) ?? null;
  const sessionId = `internal-${randomUUID()}`;
  const requestId = randomUUID();

  logger.info(
    { tool: name, sessionId, requestId, orgId, actorId },
    'handleToolsCall: invoking tool',
  );

  const apiClient = new ApiClient(apiInternalUrl, mcpInternalApiToken, logger);
  const mcpServer = deps.createMcpServer(apiClient, sessionId);

  // Microtask-ordering guard: the McpServer constructor installs the
  // wrapped tools/call handler inside a queueMicrotask callback (see the
  // createMcpServer function in server.ts). If we read `_requestHandlers`
  // synchronously we will pick up the SDK's pristine default handler, not
  // the wrapper that carries rate-limiting and audit-logging. Yielding one
  // microtask here guarantees the wrapper has been installed before we read.
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

  const handlers = (
    mcpServer.server as unknown as { _requestHandlers?: Map<string, ToolsCallHandler> }
  )._requestHandlers;
  const handler = handlers?.get('tools/call');

  if (!handler) {
    logger.error(
      { sessionId, requestId },
      'handleToolsCall: tools/call handler not found on ephemeral McpServer',
    );
    sendJson(res, 500, {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'tools/call handler not registered on ephemeral server',
      },
    });
    return;
  }

  try {
    const result = await handler(
      // The SDK's tools/call handler validates the request against
      // CallToolRequestSchema, which requires `method: z.literal('tools/call')`.
      // The normal /mcp transport supplies `method` from the JSON-RPC envelope;
      // this internal route synthesizes the request, so it must include `method`
      // explicitly or the SDK rejects it with a Zod error and the route 500s.
      { method: 'tools/call', params: { name, arguments: (args as Record<string, unknown>) ?? {} } },
      { requestId, sessionId },
    );
    sendJson(res, 200, result);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
        tool: name,
        sessionId,
        requestId,
      },
      'handleToolsCall: tool invocation threw',
    );
    sendJson(res, 500, {
      error: {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
    });
  }
}
