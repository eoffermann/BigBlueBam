import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import pino from 'pino';
import { loadEnv } from './env.js';
import { ApiClient } from './middleware/api-client.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { AuditLogger } from './middleware/audit-logger.js';
// §15 Wave 5 agent policies
import { attachPolicyGate, createPolicyGate } from './lib/register-tool.js';
import Redis from 'ioredis';
import { registerProjectTools } from './tools/project-tools.js';
import { registerBoardTools } from './tools/board-tools.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerSprintTools } from './tools/sprint-tools.js';
import { registerCommentTools } from './tools/comment-tools.js';
import { registerMemberTools } from './tools/member-tools.js';
import { registerUserResolverTools } from './tools/user-resolver-tools.js';
import { registerBamResolverTools } from './tools/bam-resolver-tools.js';
import { registerEpicTools } from './tools/epic-tools.js';
import { registerReportTools } from './tools/report-tools.js';
import { registerTemplateTools } from './tools/template-tools.js';
import { registerImportTools } from './tools/import-tools.js';
import { registerUtilityTools } from './tools/utility-tools.js';
import { registerHelpdeskTools } from './tools/helpdesk-tools.js';
import { registerBanterTools } from './tools/banter-tools.js';
import { registerBeaconTools } from './tools/beacon-tools.js';
import { registerBriefTools } from './tools/brief-tools.js';
import { registerBoltTools } from './tools/bolt-tools.js';
import { registerBearingTools } from './tools/bearing-tools.js';
import { registerBondTools } from './tools/bond-tools.js';
import { registerBlastTools } from './tools/blast-tools.js';
import { registerBookTools } from './tools/book-tools.js';
import { registerBenchTools } from './tools/bench-tools.js';
import { registerBillTools } from './tools/bill-tools.js';
import { registerBlankTools } from './tools/blank-tools.js';
import { registerBlueprintTools } from './tools/blueprint-tools.js';
import { registerBureauTools } from './tools/bureau-tools.js';
import { registerMeTools } from './tools/me-tools.js';
import { registerPlatformTools } from './tools/platform-tools.js';
import { registerAgentTools } from './tools/agent-tools.js';
import { registerProposalTools } from './tools/proposal-tools.js';
import { registerVisibilityTools } from './tools/visibility-tools.js';
import { registerSearchTools } from './tools/search-tools.js';
import { registerResolveTools } from './tools/resolve-tools.js';
import { registerActivityTools } from './tools/activity-tools.js';
import { registerCompositeTools } from './tools/composite-tools.js';
// §16 Wave 4 entity links
import { registerEntityLinksTools } from './tools/entity-links-tools.js';
// §17 Wave 4 attachments
import { registerAttachmentTools } from './tools/attachment-tools.js';
// §15 Wave 5 agent policies
import { registerAgentPolicyTools } from './tools/agent-policy-tools.js';
// §20 Wave 5 webhooks
import { registerAgentWebhookTools } from './tools/agent-webhook-tools.js';
// §7 Wave 5 dedupe
import { registerDedupeTools } from './tools/dedupe-tools.js';
// §12 Wave 5 bolt observability
import { registerBoltObservabilityTools } from './tools/bolt-observability-tools.js';
// §18 + §19 Wave 5 misc
import { registerIngestFingerprintTools } from './tools/ingest-fingerprint-tools.js';
import { createFingerprintStore, type FingerprintStore } from './lib/fingerprint-store.js';
import { createConfirmTokenStore, type ConfirmTokenStore } from './lib/confirm-token-store.js';
// §4 + §8 Wave 5 trends/expertise
import { registerPhraseCountTools } from './tools/phrase-count-tools.js';
import { registerExpertiseTools } from './tools/expertise-tools.js';
// §1 Wave 5 banter subs
import { registerBanterSubscriptionTools } from './tools/banter-subscription-tools.js';
import { registerResources, registerBanterResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { handleToolsCall } from './routes/tools-call.js';

const env = loadEnv();

const logger = pino({
  level: env.LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

// Global rate limiter shared across all sessions
const rateLimiter = new RateLimiter(env.MCP_RATE_LIMIT_RPM);

// Clean up rate limiter data periodically
setInterval(() => rateLimiter.cleanup(), 60_000);

// Track active transports by session ID
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();

// Track SSE transports by session ID
const sseTransports = new Map<string, SSEServerTransport>();

// §15 Wave 5 agent policies: session-level policy gates. Keyed by session id
// so the Redis PubSub listener below can reach every gate and invalidate it
// when a policy row changes for one of its callers. Entries are removed when
// the transport closes (see the onclose hooks further down).
const policyGates = new Map<string, ReturnType<typeof createPolicyGate>>();

// §19 Wave 5 misc: process-wide ingest fingerprint store. Single Redis
// connection shared across every session so every ingest_fingerprint_check
// call lands in the same keyspace. The store connects lazily and fails open
// if Redis is unavailable, so the mcp-server stays online even without Redis.
const fingerprintStore: FingerprintStore = createFingerprintStore({
  redisUrl: env.REDIS_URL,
  logger,
});

// Process-wide confirm_action token store. Redis-backed so staging and
// confirm legs can land on different MCP instances and tokens survive
// rolling deploys. Falls back to an in-process map with a sweeper when
// Redis is unavailable.
const confirmTokenStore: ConfirmTokenStore = createConfirmTokenStore({
  redisUrl: env.REDIS_URL,
  logger,
});

// §15 Wave 5: Redis PubSub listener. When an operator updates a policy via
// POST /v1/agent-policies/:id the API publishes the agent_user_id on
// `agent_policies:invalidate`; we fan that out to every live gate so they
// drop their cached decision for that agent. If Redis is unavailable we
// degrade to TTL-only invalidation (5s default) and log once.
let policySubscriber: Redis | null = null;
try {
  policySubscriber = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  await policySubscriber.connect();
  await policySubscriber.subscribe('agent_policies:invalidate');
  policySubscriber.on('message', (_channel: string, message: string) => {
    for (const gate of policyGates.values()) {
      gate.invalidate(message);
    }
  });
  logger.info('Subscribed to agent_policies:invalidate');
} catch (err) {
  logger.warn(
    { err },
    'agent_policies:invalidate subscription unavailable; falling back to TTL-only cache',
  );
  policySubscriber = null;
}

function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

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

function createMcpServer(
  apiClient: ApiClient,
  sessionId: string,
  opts: { trackGate?: boolean } = { trackGate: true },
): McpServer {
  const auditLogger = new AuditLogger(apiClient, logger);

  const server = new McpServer({
    name: 'BigBlueBam',
    version: '1.0.0',
  });

  // §15 Wave 5: attach the policy gate BEFORE any register* call so the
  // registerTool wrapper picks it up. Gate is session-scoped and gets
  // invalidated by the Redis subscriber above. For one-shot ephemeral
  // servers (spun up per /tools/call invocation) trackGate is left off so
  // we don't leak into the session map; the gate still works because it is
  // attached to the server via the WeakMap in register-tool.ts.
  const gate = createPolicyGate({ apiClient, logger, sessionId });
  attachPolicyGate(server, gate);
  if (opts.trackGate !== false) {
    policyGates.set(sessionId, gate);
  }

  // Register all tools
  registerProjectTools(server, apiClient);
  registerBoardTools(server, apiClient, env.BOARD_API_URL);
  registerTaskTools(server, apiClient);
  registerSprintTools(server, apiClient);
  registerCommentTools(server, apiClient);
  registerMemberTools(server, apiClient);
  registerUserResolverTools(server, apiClient);
  registerBamResolverTools(server, apiClient);
  registerEpicTools(server, apiClient);
  registerReportTools(server, apiClient);
  registerTemplateTools(server, apiClient);
  registerImportTools(server, apiClient, confirmTokenStore);
  registerUtilityTools(server, apiClient, rateLimiter, confirmTokenStore);
  registerHelpdeskTools(server, apiClient, env.HELPDESK_API_URL);
  registerBanterTools(server, apiClient, env.BANTER_API_URL);
  registerBeaconTools(server, apiClient, env.BEACON_API_URL);
  registerBriefTools(server, apiClient, env.BRIEF_API_URL);
  registerBoltTools(server, apiClient, env.BOLT_API_URL);
  // §12 Wave 5 bolt observability
  registerBoltObservabilityTools(server, apiClient, env.BOLT_API_URL);
  registerBearingTools(server, apiClient, env.BEARING_API_URL);
  registerBondTools(server, apiClient, env.BOND_API_URL);
  registerBlastTools(server, apiClient, env.BLAST_API_URL);
  registerBookTools(server, apiClient, env.BOOK_API_URL);
  registerBenchTools(server, apiClient, env.BENCH_API_URL);
  registerBillTools(server, apiClient, env.BILL_API_URL);
  registerBlankTools(server, apiClient, env.BLANK_API_URL);
  registerBlueprintTools(server, apiClient, env.BLUEPRINT_API_URL);
  registerBureauTools(server, apiClient, env.BUREAU_API_URL);
  registerMeTools(server, apiClient);
  registerPlatformTools(server, apiClient);
  registerAgentTools(server, apiClient);
  registerProposalTools(server, apiClient);
  registerVisibilityTools(server, apiClient);
  registerSearchTools(server, apiClient, {
    apiUrl: env.API_INTERNAL_URL,
    helpdeskApiUrl: env.HELPDESK_API_URL,
    bondApiUrl: env.BOND_API_URL,
    briefApiUrl: env.BRIEF_API_URL,
    beaconApiUrl: env.BEACON_API_URL,
    banterApiUrl: env.BANTER_API_URL,
    boardApiUrl: env.BOARD_API_URL,
  });
  registerResolveTools(server, apiClient, {
    bondApiUrl: env.BOND_API_URL,
    briefApiUrl: env.BRIEF_API_URL,
    helpdeskApiUrl: env.HELPDESK_API_URL,
  });
  registerActivityTools(server, apiClient);
  registerCompositeTools(server, apiClient, {
    apiUrl: env.API_INTERNAL_URL,
    bondApiUrl: env.BOND_API_URL,
    helpdeskApiUrl: env.HELPDESK_API_URL,
    billApiUrl: env.BILL_API_URL,
    bearingApiUrl: env.BEARING_API_URL,
    briefApiUrl: env.BRIEF_API_URL,
    beaconApiUrl: env.BEACON_API_URL,
  });
  // §16 Wave 4 entity links
  registerEntityLinksTools(server, apiClient);
  // §17 Wave 4 attachments
  registerAttachmentTools(server, apiClient);
  // §15 Wave 5 agent policies
  registerAgentPolicyTools(server, apiClient);
  // §20 Wave 5 webhooks
  registerAgentWebhookTools(server, apiClient);
  // §7 Wave 5 dedupe
  registerDedupeTools(server, apiClient, {
    bondApiUrl: env.BOND_API_URL,
    helpdeskApiUrl: env.HELPDESK_API_URL,
  });
  // §18 + §19 Wave 5 misc
  registerIngestFingerprintTools(server, apiClient, fingerprintStore);
  // §4 + §8 Wave 5 trends/expertise
  registerPhraseCountTools(server, apiClient, {
    helpdeskApiUrl: env.HELPDESK_API_URL,
    apiUrl: env.API_INTERNAL_URL,
  });
  registerExpertiseTools(server, apiClient);

  // §1 Wave 5 banter subs
  registerBanterSubscriptionTools(server, apiClient, env.BANTER_API_URL);

  // Register resources and prompts
  registerResources(server, apiClient);
  registerBanterResources(server, env.BANTER_API_URL);
  registerPrompts(server, apiClient, env.BANTER_API_URL);

  // Hook into the tools/call handler after all tools are registered
  // to add rate limiting and audit logging.
  queueMicrotask(() => {
    const handlers = (server.server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
    const originalToolsCallHandler = handlers?.get('tools/call');

    if (originalToolsCallHandler) {
      handlers.set('tools/call', async (request: { params: { name: string; arguments?: Record<string, unknown> } }, extra: unknown) => {
        // Rate limit check
        if (!rateLimiter.check(sessionId)) {
          logger.warn({ sessionId }, 'Rate limit exceeded');
          return {
            content: [{
              type: 'text',
              text: `Rate limit exceeded. Maximum ${env.MCP_RATE_LIMIT_RPM} requests per minute. Please wait and try again.`,
            }],
            isError: true,
          };
        }

        // Execute the original handler
        const result = await (originalToolsCallHandler as Function)(request, extra);

        // Audit log (fire and forget)
        auditLogger.logToolCall({
          tool_name: request.params.name,
          input_params: request.params.arguments ?? {},
          session_id: sessionId,
          timestamp: new Date().toISOString(),
        }).catch(() => {
          // Swallow errors -- audit should never break flow
        });

        return result;
      });
    }
  });

  return server;
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // Health endpoint
  if (url.pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, { status: 'ok', server: 'BigBlueBam MCP', version: '1.0.0' });
    return;
  }

  // Internal POST /tools/call direct-invocation route (Wave 0.2).
  // Shared-secret auth, bypasses the Streamable-HTTP session machinery so
  // service-to-service callers (bolt-api, worker, api) can invoke MCP tools
  // without establishing a real MCP session. See apps/mcp-server/src/routes/tools-call.ts.
  if (url.pathname === '/tools/call' && req.method === 'POST') {
    await handleToolsCall(req, res, {
      logger,
      internalSecret: env.INTERNAL_SERVICE_SECRET ?? '',
      apiInternalUrl: env.API_INTERNAL_URL,
      mcpInternalApiToken: env.MCP_INTERNAL_API_TOKEN ?? '',
      // §15 Wave 5: pass trackGate:false so ephemeral per-call servers don't
      // leak into the session-wide policyGates map.
      createMcpServer: (apiClient, sid) =>
        createMcpServer(apiClient, sid, { trackGate: false }),
    });
    return;
  }

  // ---- SSE Transport Endpoints ----
  if (env.MCP_TRANSPORT === 'sse') {
    // SSE connection endpoint
    if (url.pathname === '/sse' && req.method === 'GET') {
      // Auth check
      if (env.MCP_AUTH_REQUIRED) {
        const token = extractBearerToken(req);
        if (!token) {
          sendJson(res, 401, { error: 'Authorization header with Bearer token required' });
          return;
        }
      }

      const token = extractBearerToken(req) ?? '';
      const apiClient = new ApiClient(env.API_INTERNAL_URL, token, logger);
      const sessionId = crypto.randomUUID();
      const mcpServer = createMcpServer(apiClient, sessionId);

      const transport = new SSEServerTransport('/messages', res);

      transport.onclose = () => {
        sseTransports.delete(sessionId);
        policyGates.delete(sessionId);
        logger.info({ sessionId }, 'SSE session closed');
      };

      sseTransports.set(sessionId, transport);
      logger.info({ sessionId }, 'New SSE session created');

      await mcpServer.connect(transport);

      return;
    }

    // Message endpoint for SSE clients
    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');

      if (!sessionId || !sseTransports.has(sessionId)) {
        sendJson(res, 400, { error: 'Invalid or missing session ID' });
        return;
      }

      const transport = sseTransports.get(sessionId)!;
      const body = await readBody(req);

      try {
        await transport.handlePostMessage(req, res, body);
      } catch (error) {
        logger.error({ sessionId, error }, 'Error handling SSE message');
        sendJson(res, 500, { error: 'Internal server error' });
      }

      return;
    }
  }

  // ---- Streamable HTTP Transport Endpoints (default) ----
  if (url.pathname === '/mcp') {
    // Auth check
    if (env.MCP_AUTH_REQUIRED) {
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, 401, { error: 'Authorization header with Bearer token required' });
        return;
      }
    }

    if (req.method === 'POST') {
      const token = extractBearerToken(req) ?? '';
      const body = await readBody(req);
      let message: unknown;

      try {
        message = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && streamableTransports.has(sessionId)) {
        // Existing session: forward message to the transport
        const transport = streamableTransports.get(sessionId)!;
        await transport.handleRequest(req, res, message);
        return;
      }

      // New session: create a new MCP server + transport
      const newSessionId = crypto.randomUUID();
      const apiClient = new ApiClient(env.API_INTERNAL_URL, token, logger);
      const mcpServer = createMcpServer(apiClient, newSessionId);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          streamableTransports.delete(sid);
          policyGates.delete(sid);
          logger.info({ sessionId: sid }, 'MCP session closed');
        }
      };

      await mcpServer.connect(transport);

      // Store session after connection (sessionId is assigned during handleRequest)
      await transport.handleRequest(req, res, message);

      if (transport.sessionId) {
        streamableTransports.set(transport.sessionId, transport);
        logger.info({ sessionId: transport.sessionId }, 'New MCP session created');
      }

      return;
    }

    if (req.method === 'GET') {
      // SSE for server-to-client notifications
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && streamableTransports.has(sessionId)) {
        const transport = streamableTransports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }
      sendJson(res, 400, { error: 'Invalid or missing session ID' });
      return;
    }

    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && streamableTransports.has(sessionId)) {
        const transport = streamableTransports.get(sessionId)!;
        await transport.handleRequest(req, res);
        streamableTransports.delete(sessionId);
        logger.info({ sessionId }, 'MCP session terminated by client');
        return;
      }
      sendJson(res, 400, { error: 'Invalid or missing session ID' });
      return;
    }

    res.writeHead(405, { Allow: 'GET, POST, DELETE' });
    res.end();
    return;
  }

  // 404 for everything else
  sendJson(res, 404, { error: 'Not found' });
});

httpServer.listen(env.MCP_PORT, () => {
  logger.info(
    { port: env.MCP_PORT, transport: env.MCP_TRANSPORT, authRequired: env.MCP_AUTH_REQUIRED },
    'BigBlueBam MCP server started',
  );
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down MCP server...');

  // Close all active streamable transports
  for (const [sessionId, transport] of streamableTransports) {
    try {
      await transport.close();
    } catch {
      logger.warn({ sessionId }, 'Error closing streamable transport');
    }
  }
  streamableTransports.clear();

  // Close all active SSE transports
  for (const [sessionId, transport] of sseTransports) {
    try {
      await transport.close();
    } catch {
      logger.warn({ sessionId }, 'Error closing SSE transport');
    }
  }
  sseTransports.clear();

  // §15 Wave 5: drop the Redis subscriber
  if (policySubscriber) {
    try {
      await policySubscriber.quit();
    } catch {
      logger.warn('Error closing agent_policies Redis subscriber');
    }
  }
  policyGates.clear();

  // §19 Wave 5: close the ingest fingerprint store's Redis connection.
  try {
    await fingerprintStore.close();
  } catch {
    logger.warn('Error closing ingest fingerprint store');
  }

  // Close the confirm_action token store's Redis connection.
  try {
    await confirmTokenStore.close();
  } catch {
    logger.warn('Error closing confirm-token store');
  }

  httpServer.close(() => {
    logger.info('MCP server shut down');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
