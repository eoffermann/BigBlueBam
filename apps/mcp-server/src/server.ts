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
import { registerProjectTools } from './tools/project-tools.js';
import { registerBoardTools } from './tools/board-tools.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerSprintTools } from './tools/sprint-tools.js';
import { registerCommentTools } from './tools/comment-tools.js';
import { registerMemberTools } from './tools/member-tools.js';
import { registerUserResolverTools } from './tools/user-resolver-tools.js';
import { registerBamResolverTools } from './tools/bam-resolver-tools.js';
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
import { registerMeTools } from './tools/me-tools.js';
import { registerPlatformTools } from './tools/platform-tools.js';
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

function createMcpServer(apiClient: ApiClient, sessionId: string): McpServer {
  const auditLogger = new AuditLogger(apiClient, logger);

  const server = new McpServer({
    name: 'BigBlueBam',
    version: '1.0.0',
  });

  // Register all tools
  registerProjectTools(server, apiClient);
  registerBoardTools(server, apiClient, env.BOARD_API_URL);
  registerTaskTools(server, apiClient);
  registerSprintTools(server, apiClient);
  registerCommentTools(server, apiClient);
  registerMemberTools(server, apiClient);
  registerUserResolverTools(server, apiClient);
  registerBamResolverTools(server, apiClient);
  registerReportTools(server, apiClient);
  registerTemplateTools(server, apiClient);
  registerImportTools(server, apiClient);
  registerUtilityTools(server, apiClient, rateLimiter);
  registerHelpdeskTools(server, apiClient, env.HELPDESK_API_URL);
  registerBanterTools(server, apiClient, env.BANTER_API_URL);
  registerBeaconTools(server, apiClient, env.BEACON_API_URL);
  registerBriefTools(server, apiClient, env.BRIEF_API_URL);
  registerBoltTools(server, apiClient, env.BOLT_API_URL);
  registerBearingTools(server, apiClient, env.BEARING_API_URL);
  registerBondTools(server, apiClient, env.BOND_API_URL);
  registerBlastTools(server, apiClient, env.BLAST_API_URL);
  registerBookTools(server, apiClient, env.BOOK_API_URL);
  registerBenchTools(server, apiClient, env.BENCH_API_URL);
  registerBillTools(server, apiClient, env.BILL_API_URL);
  registerBlankTools(server, apiClient, env.BLANK_API_URL);
  registerMeTools(server, apiClient);
  registerPlatformTools(server, apiClient);

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

  // ---- Internal /tools/call route ----
  if (url.pathname === '/tools/call' && req.method === 'POST') {
    await handleToolsCall(req, res, {
      env: {
        INTERNAL_SERVICE_SECRET: env.INTERNAL_SERVICE_SECRET,
        MCP_INTERNAL_API_TOKEN: env.MCP_INTERNAL_API_TOKEN,
        API_INTERNAL_URL: env.API_INTERNAL_URL,
      },
      logger,
      apiClientFactory: (baseUrl, token, log) => new ApiClient(baseUrl, token, log),
      createMcpServer,
    });
    return;
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

  httpServer.close(() => {
    logger.info('MCP server shut down');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
