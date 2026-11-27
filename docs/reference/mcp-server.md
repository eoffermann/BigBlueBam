# MCP Server Documentation

BigBlueBam exposes a **Model Context Protocol (MCP)** server, enabling any MCP-compatible AI client to interact with project data through structured tool calls. The MCP server is a first-class citizen of the architecture, not a bolt-on.

The server registers one tool module per app plus a cross-app platform layer (agent identity, audit and heartbeat, proposals, visibility preflight, unified activity, cross-app search, resolvers, composite views, entity links, attachments, agent policies, outbound webhooks, Bolt observability, dedupe, phrase counts, expertise, pattern subscriptions, ingest fingerprint). For the current tool count and the tools in each app, see [Available Tools](#available-tools) below, which points at the generated catalogs.

---

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io) is an open standard for connecting AI assistants to external tools and data sources. MCP provides a structured way for AI clients (Claude Desktop, Claude Code, IDE extensions, custom agents) to:

- **Call tools** -- execute actions like creating tasks, moving cards, or closing sprints
- **Read resources** -- pull project data into the AI's context window
- **Use prompts** -- leverage pre-built prompt templates for common workflows

BigBlueBam's MCP server means you can manage your projects through natural language conversation with an AI assistant.

---

## Architecture

```mermaid
graph LR
    subgraph "AI Clients"
        Claude["Claude Desktop"]
        Code["Claude Code"]
        IDE["IDE Extension"]
        Agent["Custom Agent"]
    end

    subgraph "BigBlueBam MCP Server (proxied at /mcp/)"
        Transport["Transport Layer<br/>(Streamable HTTP / SSE / stdio)"]
        Auth["Auth Middleware<br/>(API key validation)"]
        Rate["Rate Limiter"]
        Audit["Audit Logger"]
        Tools["Tool Registry<br/>(one module per app + platform layer)"]
        Resources["Resource Registry<br/>(Bam + Banter resources)"]
        Prompts["Prompt Registry<br/>(8 prompts)"]
    end

    subgraph "BigBlueBam Core"
        API["API Server (:4000)"]
        BanterAPI["Banter API (:4002)"]
        BeaconAPI["Beacon API (:4004)"]
        DB["PostgreSQL"]
        Redis["Redis"]
        Qdrant["Qdrant (vectors)"]
    end

    Claude -->|"SSE / HTTP"| Transport
    Code -->|"stdio / HTTP"| Transport
    IDE -->|"SSE"| Transport
    Agent -->|"HTTP"| Transport

    Transport --> Auth
    Auth --> Rate
    Rate --> Tools
    Rate --> Resources
    Rate --> Prompts

    Tools -->|"Internal HTTP"| API
    Tools -->|"Internal HTTP"| BanterAPI
    Tools -->|"Internal HTTP"| BeaconAPI
    Resources -->|"Internal HTTP"| API
    Resources -->|"Internal HTTP"| BanterAPI
    Prompts -->|"Internal HTTP"| API
    Prompts -->|"Internal HTTP"| BanterAPI
    Audit -->|"Log"| Redis
    API --> DB
    BanterAPI --> DB
    BeaconAPI --> DB
    BeaconAPI --> Qdrant
```

### Transport Options

| Transport | Use Case | Configuration |
|---|---|---|
| **Streamable HTTP** | Cloud deployments, remote clients | Primary, recommended |
| **SSE** | Backward compatibility, web-based clients | Supported |
| **stdio** | Local CLI/IDE integrations, Docker exec | Available |

### SDK

Built with the official `@modelcontextprotocol/sdk` TypeScript package. Runs as a sidecar Docker container on internal port 3001, exposed externally at `/mcp/` through the shared nginx reverse proxy on port 80. Communicates with the API server over the internal Docker network. On Docker Compose the container port is also published for local MCP clients, bound to the host's loopback only (`127.0.0.1:${MCP_PORT:-3001}`), so `http://localhost:3001/` works on the Docker host itself and nothing listens on a LAN or public interface (#276). Off-host clients use `https://DOMAIN/mcp/`.

### Endpoint paths

The canonical MCP endpoint for an MCP client is the `/mcp/` path on the public ingress. `/mcp` (no trailing slash) is also accepted. Other paths on the `/mcp/` prefix are reserved for out-of-band operational surfaces:

| External path | Upstream path | Purpose |
|---|---|---|
| `https://DOMAIN/mcp/` or `/mcp` | `/mcp` | **Primary MCP endpoint**: Streamable HTTP transport. POST for client→server requests; GET for server→client SSE notifications on an established session; DELETE to terminate. Use this URL in Claude Desktop / Claude Code / any MCP client config. |
| `https://DOMAIN/mcp/health` | `/health` | Liveness probe. Returns `{"status":"ok","server":"BigBlueBam MCP","version":"..."}`. No auth. |
| `https://DOMAIN/mcp/sse` | `/sse` | SSE transport connection (only active when `MCP_TRANSPORT=sse`; the default is `streamable-http` and this route returns 404). |
| `https://DOMAIN/mcp/messages` | `/messages` | SSE transport POST endpoint for client→server messages (only active when `MCP_TRANSPORT=sse`). |
| _(none: nginx returns 404 for `/mcp/tools/call`)_ | `/tools/call` | Internal shared-secret direct-invocation route for service-to-service callers (bolt-api, worker, api), reached only on the private network at `MCP_INTERNAL_URL` (e.g. `http://mcp-server:3001/tools/call`). The Compose port mapping is loopback-only (`127.0.0.1:3001`), so the route is not reachable off-host around nginx (#276). It answers `401 UNAUTHORIZED` for a missing or wrong `X-Internal-Secret` (or no secret configured) and `403 FORBIDDEN` for the right secret from a caller that is not a direct private-network peer (relayed by the edge with `X-Forwarded-For`, or a public socket peer); a 403 usually means `MCP_INTERNAL_URL` was pointed through nginx. Not for external MCP clients — use `/mcp/` for that. |

Configured in `infra/nginx/nginx-with-site.conf` (docker-compose) and `infra/nginx/nginx.conf` (baked-in fallback); the Railway flavor `infra/nginx/nginx.railway.conf` is auto-generated from the former. The routing matches `apps/mcp-server/src/server.ts`.

---

## Authentication

### API Key Authentication

The primary authentication method. Clients include their BigBlueBam API key in the initial HTTP request:

```
Authorization: Bearer bbam_your_api_key_here
```

API keys are prefixed `bbam_`, stored as Argon2id hashes, and scoped to `read`, `read_write`, or `admin` with optional project restriction.

The API key's scope determines available tools:

| Scope | Available Tools |
|---|---|
| `read` | All query/list tools only |
| `read_write` | All tools except configuration changes |
| `admin` | All tools including project configuration |

### OAuth 2.1 Flow

For cloud-hosted MCP endpoints, the server supports OAuth 2.1 with PKCE per the MCP specification:

```mermaid
sequenceDiagram
    participant Client as AI Client
    participant MCP as MCP Server
    participant Auth as Auth Server

    Client->>MCP: Initial connection (no token)
    MCP-->>Client: 401 + OAuth metadata URL
    Client->>Auth: Authorization request (PKCE)
    Auth-->>Client: Authorization code
    Client->>Auth: Token exchange (code + verifier)
    Auth-->>Client: Access token
    Client->>MCP: Reconnect with Bearer token
    MCP->>MCP: Validate token, establish session
    MCP-->>Client: Session ready
```

### Security Properties

| Property | Implementation |
|---|---|
| **Session binding** | Each MCP session is bound to a single authenticated user. All tool calls use that user's permissions. |
| **Input validation** | Every tool input is validated against a Zod schema before execution. |
| **Output sanitization** | Responses are stripped of internal IDs, stack traces, and infrastructure details. |
| **Rate limiting** | Shared pool with REST API. MCP calls count against the same per-user and per-org limits. |
| **Audit logging** | Every tool invocation is logged to `activity_log` with action prefixed `mcp.` for traceability. |
| **Destructive action confirmation** | Tools that delete, close, or remove require a two-step confirmation with time-limited action tokens. |

---

## Available Tools

This page does not keep its own tool count or tool list. A hand-written copy of
both stood here and fell hundreds of tools behind the code, so the
tool surface is now read from generated sources that are checked in CI:

- **Per-app tool catalogs:** `docs/apps/<app>/mcp-tools.md` lists every tool an
  app registers, with its description and parameters. `pnpm docs:extract`
  regenerates them from `apps/mcp-server/src/tools/*.ts`.
- **Counts:** the README `AUTODOCS:MCP_TOOLS` table and
  `site/src/content/docs-catalog.generated.json` (`pnpm docs:catalog`) give the
  suite total and the count for each app, including the cross-app platform
  layer. `scripts/check-tool-return-coverage.mjs` keeps every published total
  equal to the registered tools, and `scripts/check-app-counts.mjs` does the
  same for every per-app count.
- **REST to MCP mapping:** `docs/reference/mcp-endpoint-mapping.md` maps each
  REST endpoint to its MCP tool, app by app.

What this page does maintain is the transport, authentication, configuration and
confirmation model around those tools, described in the other sections.

---

## Available Resources

Resources provide read-only data that AI clients can pull into their context window.

| URI Pattern | Description |
|---|---|
| `bigbluebam://projects` | List of all accessible projects |
| `bigbluebam://projects/{id}/board` | Current board state |
| `bigbluebam://projects/{id}/backlog` | All backlog tasks |
| `bigbluebam://sprints/{id}` | Sprint details + task list |
| `bigbluebam://tasks/{human_id}` | Full task detail (by human-readable ID, e.g., `BBB-142`) |
| `bigbluebam://me/tasks` | Current user's task list across all projects |
| `bigbluebam://me/notifications` | Unread notifications |

---

## Available Prompts

Pre-built prompt templates for common AI workflows.

| Prompt | Arguments | Description |
|---|---|---|
| `sprint_planning` | `project_id` | Fetches backlog, last 3 sprint velocities, team list. Guides AI through prioritization and scoping. |
| `daily_standup` | `project_id` | Fetches 24-hour activity log and in-progress tasks. Summarizes what happened and what is planned. |
| `sprint_retrospective` | `sprint_id` | Fetches sprint report, carry-forward history, scope changes. Structures "went well / improve / action items". |
| `task_breakdown` | `task_id` | Fetches task detail and similar historical tasks. Helps break epics into smaller subtasks with estimates. |

---

## Configuration

The MCP server is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MCP_ENABLED` | `true` | Enable/disable the MCP server |
| `MCP_TRANSPORT` | `streamable-http` | Transport: `streamable-http`, `sse`, `stdio` |
| `MCP_PORT` | `3001` | Port for MCP server (sidecar mode). On Compose, also the host port of the loopback-only mapping `127.0.0.1:${MCP_PORT}` |
| `MCP_PATH` | `/mcp` | URL path prefix (integrated mode) |
| `MCP_AUTH_REQUIRED` | `true` | Require authentication (disable only for local dev) |
| `MCP_RATE_LIMIT_RPM` | `100` | Requests per minute per session |
| `MCP_CONFIRM_DESTRUCTIVE` | `true` | Require confirmation for destructive actions |
| `MCP_MAX_RESULT_SIZE` | `50000` | Max characters in a single tool response |
| `MCP_AUDIT_LOG` | `true` | Log all MCP tool invocations to activity_log |
| `API_INTERNAL_URL` | `http://api:4000` | Internal URL for API server communication |
| `REDIS_URL` | (required) | Redis connection for session cache |

---

## Client Configuration Examples

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bigbluebam": {
      "url": "https://app.bigbluebam.io/mcp/",
      "headers": {
        "Authorization": "Bearer bbam_your_api_key_here"
      }
    }
  }
}
```

For a local Docker instance:

```json
{
  "mcpServers": {
    "bigbluebam": {
      "url": "http://localhost/mcp/",
      "headers": {
        "Authorization": "Bearer bbam_your_api_key_here"
      }
    }
  }
}
```

For Claude Code via the `claude mcp add` CLI:

```sh
claude mcp add --transport http bigbluebam https://YOUR_DOMAIN/mcp/ \
  --header "Authorization: Bearer bbam_your_api_key_here"
```

For service-account use (the `bbam_svc_` prefix signals a locked, non-login account minted with `docker compose exec api node dist/cli.js create-service-account`), substitute that token for the user key.

### Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "bigbluebam": {
      "command": "npx",
      "args": [
        "@bigbluebam/mcp-server",
        "--api-url", "http://localhost/b3/api",
        "--api-key", "bbam_dev_key"
      ]
    }
  }
}
```

### Local Docker (stdio transport)

```json
{
  "mcpServers": {
    "bigbluebam": {
      "command": "docker",
      "args": [
        "exec", "-i", "bigbluebam-mcp-server-1",
        "node", "dist/mcp-stdio.js"
      ],
      "env": {
        "BIGBLUEBAM_API_KEY": "bbam_your_key"
      }
    }
  }
}
```

---

## Typical AI Workflow

```mermaid
sequenceDiagram
    participant User as User (via Claude)
    participant AI as Claude
    participant MCP as MCP Server

    User->>AI: "What's the status of our project?"
    AI->>MCP: list_projects
    MCP-->>AI: [{name: "BigBlueBam", active_sprint: "Sprint 12", open_tasks: 42}]
    AI->>MCP: get_board(project_id)
    MCP-->>AI: Board with 5 phases, 18 tasks in Sprint 12
    AI-->>User: "Sprint 12 has 18 tasks: 3 in Backlog, 5 in To Do, 3 In Progress, 2 in Review, 5 Done..."

    User->>AI: "Create a task for adding dark mode support"
    AI->>MCP: create_task(project_id, title: "Add dark mode support", priority: "medium")
    MCP-->>AI: {human_id: "BBB-156", title: "Add dark mode support"}
    AI-->>User: "Created BBB-156: Add dark mode support (medium priority, in Backlog)"

    User->>AI: "Add a comment about using CSS custom properties"
    AI->>MCP: add_comment(task_id, body: "Consider using CSS custom properties for theme variables...")
    MCP-->>AI: Comment added
    AI-->>User: "Comment added to BBB-156"

    User->>AI: "Show me all overdue tasks"
    AI->>MCP: search_tasks(project_id, due_date_before: "2026-04-02", priority: ["critical","high"])
    MCP-->>AI: 3 overdue tasks
    AI-->>User: "There are 3 overdue tasks: BBB-101 (critical, 5 days overdue)..."
```

---

## Destructive Action Confirmation

Tools that delete tasks, complete sprints, or remove members use a two-step confirmation flow:

```mermaid
sequenceDiagram
    participant AI as AI Client
    participant MCP as MCP Server

    AI->>MCP: delete_task(task_id: "uuid")
    MCP-->>AI: Confirmation required: "Delete BBB-142: Implement OAuth2 login flow?"
    Note right of MCP: Returns action_token<br/>(valid 60 seconds)

    alt AI confirms
        AI->>MCP: confirm_action(action_token: "tok_...")
        MCP-->>AI: Task deleted successfully
    else AI declines or token expires
        AI-->>AI: Action not taken
    end
```

This prevents accidental data loss from AI misinterpretation and gives the AI client (and its human user) a chance to review before irreversible actions execute.
