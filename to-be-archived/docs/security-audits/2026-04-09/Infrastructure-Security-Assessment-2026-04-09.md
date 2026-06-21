# BigBlueBam -- Infrastructure Security Assessment

| Field              | Value                                                        |
|--------------------|--------------------------------------------------------------|
| **Date**           | 2026-04-09                                                   |
| **Scope**          | MCP Server (`apps/mcp-server/`), Helpdesk API (`apps/helpdesk-api/`), Worker (`apps/worker/`), Infrastructure (`infra/`, `docker-compose.yml`, `nginx.conf`, deploy scripts) |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)  |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, Rate Limiting & DoS, Business Logic, Cryptography, Infrastructure & Config, Network Security, Supply Chain |
| **Classification** | INTERNAL -- CONFIDENTIAL                                     |
| **Prepared for**   | BigBlueBam Engineering & Security Leadership                 |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Finding Counts by Severity](#2-finding-counts-by-severity)
3. [Critical Remediation Path](#3-critical-remediation-path)
4. [Detailed Findings](#4-detailed-findings)
   - [4.1 MCP Server](#41-mcp-server)
   - [4.2 Helpdesk](#42-helpdesk)
   - [4.3 Worker](#43-worker)
   - [4.4 Infrastructure](#44-infrastructure)
5. [Methodology Notes](#5-methodology-notes)
6. [Appendix: Agent Coverage Map](#6-appendix-agent-coverage-map)

---

## 1. Executive Summary

This assessment consolidates findings from specialized security audit agents that independently analyzed the BigBlueBam MCP Server, Helpdesk API, Worker, and Infrastructure (nginx, Docker, deployment scripts). After deduplication, **24 unique findings** were identified across these components.

The infrastructure layer presents the broadest risk surface. Three high-severity findings in nginx configuration -- **missing security headers**, **no TLS configuration**, and **default/weak credentials in docker-compose** -- affect the entire platform and would be immediately exploitable in any internet-facing deployment. The absence of `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, and `X-Content-Type-Options` headers leaves all BigBlueBam SPAs vulnerable to clickjacking, MIME sniffing attacks, and man-in-the-middle downgrade attacks.

The Helpdesk module has two high-severity authorization gaps where agent routes lack organization scoping, allowing authenticated agents to access tickets and customer data from other organizations.

The MCP Server has medium-severity findings around confirmation token scoping, bypassed confirmation flows on destructive actions, and empty bearer token acceptance. The Worker has medium-severity issues with unvalidated job payloads and email header injection risk.

Additional infrastructure findings include Redis password exposure in healthcheck commands, exposed container ports, wildcard CORS origins across all 10+ APIs, absent PostgreSQL RLS policies, unauthenticated Qdrant vector database access, and a curl-to-sudo-bash deployment script.

**The infrastructure findings are systemic and affect all modules.** Remediation should prioritize the nginx security headers and TLS configuration as they protect the entire platform.

---

## 2. Finding Counts by Severity

| Component | Critical | High | Medium | Low | Total |
|-----------|----------|------|--------|-----|-------|
| MCP Server | 0 | 0 | 3 | 3 | 6 |
| Helpdesk | 0 | 2 | 1 | 1 | 4 |
| Worker | 0 | 0 | 2 | 2 | 4 |
| Infrastructure | 0 | 3 | 6 | 1 | 10 |
| **Total** | **0** | **5** | **12** | **7** | **24** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | INFRA-001 | No security headers in nginx | 0.5 day |
| 2 | INFRA-002 | No TLS configuration | 1 day |
| 3 | INFRA-003 | Default/weak credentials in docker-compose | 0.5 day |
| 4 | HELP-001 | Agent routes lack org-scoping (cross-org ticket data leak) | 1 day |
| 5 | INFRA-006 | CORS_ORIGIN=* on 10+ APIs | 0.5 day |

**Estimated total for top-5 remediation: 3.5 engineering days.**

---

## 4. Detailed Findings

### 4.1 MCP Server

---

#### MCP-001: Confirmation Tokens Not Session-Scoped

| Field | Value |
|-------|-------|
| **ID** | MCP-001 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.4 (Medium) |
| **CWE** | CWE-384: Session Fixation |
| **Affected Files** | `apps/mcp-server/src/tools/confirm.ts` |

**Description:**
The MCP confirmation flow generates time-limited action tokens for destructive operations (delete task, complete sprint, remove member). These tokens are stored in an in-memory map keyed by the token value alone -- they are not bound to the session or user that initiated the confirmation request. If an attacker obtains a valid confirmation token (e.g., via log leakage, network interception, or social engineering), they can use it from any session to execute the confirmed destructive action.

**Recommended Fix:**
1. Bind confirmation tokens to the originating session ID or user ID.
2. On `confirm_action`, verify that the calling session/user matches the one that initiated the request.
3. Store tokens in Redis with session binding rather than in-memory to survive restarts and enable cross-instance validation.

---

#### MCP-002: Destructive Actions Bypass Confirmation Flow

| Field | Value |
|-------|-------|
| **ID** | MCP-002 |
| **Severity** | Medium |
| **CVSS 3.1** | 6.5 (Medium) |
| **CWE** | CWE-862: Missing Authorization |
| **Affected Files** | `apps/mcp-server/src/tools/` (multiple tool modules) |

**Description:**
While the MCP design specification requires destructive actions to go through a two-step confirmation flow, several tool handlers execute destructive operations directly without checking for a confirmation token. Tools that bypass the confirmation include certain bulk operations and cascade-delete operations where the confirmation check was either not implemented or was commented out during development.

An LLM client issuing tool calls can invoke these destructive operations in a single step, bypassing the safety mechanism designed to prevent accidental data loss.

**Recommended Fix:**
1. Audit all MCP tool handlers tagged as destructive in the tool registry.
2. Add a pre-execution check that verifies a valid, unexpired confirmation token is present for any tool marked `requiresConfirmation: true`.
3. Add integration tests that verify destructive tools reject calls without confirmation tokens.

---

#### MCP-003: Empty Bearer Tokens Accepted

| Field | Value |
|-------|-------|
| **ID** | MCP-003 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-287: Improper Authentication |
| **Affected Files** | `apps/mcp-server/src/auth.ts` |

**Description:**
The MCP server's authentication middleware extracts the bearer token from the `Authorization` header and validates it against the API. However, when the `Authorization` header is present but the token value is an empty string (`Authorization: Bearer `), the middleware does not reject the request before forwarding it to the API for validation. Depending on how the API handles empty token lookups, this could result in:

- An unhandled error that crashes the request.
- A permissive lookup that matches a null/empty token record.
- An ambiguous authentication state where the request is treated as partially authenticated.

**Recommended Fix:**
1. Add an explicit check: if the extracted token is empty or whitespace-only, return 401 immediately.
2. Validate the token format (e.g., `bbam_` prefix, minimum length) before forwarding to the API.

---

#### MCP-004: Private API Client Token Unsafe Cast

| Field | Value |
|-------|-------|
| **ID** | MCP-004 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-704: Incorrect Type Conversion or Cast |
| **Affected Files** | `apps/mcp-server/src/api-client.ts` |

**Description:**
The internal API client used by the MCP server to communicate with the Bam API casts the service-to-service authentication token using `as string` without runtime validation. If the `MCP_API_TOKEN` environment variable is not set, the token becomes `undefined`, which is cast to the string `"undefined"`. This would be sent as the bearer token in API requests, resulting in confusing authentication failures rather than a clear startup error.

**Recommended Fix:**
Validate `MCP_API_TOKEN` at server startup using the env validation schema. Crash with a descriptive error if it is not set.

---

#### MCP-005: No Body Size Limit on MCP Requests

| Field | Value |
|-------|-------|
| **ID** | MCP-005 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/mcp-server/src/server.ts` |

**Description:**
The MCP server's HTTP transport does not set an explicit body size limit. While Fastify's default 1 MiB limit applies, MCP tool calls with large arguments (e.g., bulk operations with extensive payloads) could consume significant memory. The SSE transport has no body limit at all.

**Recommended Fix:**
Set explicit body limits on the MCP HTTP transport (e.g., 256 KiB for tool calls) and validate argument sizes in individual tool handlers.

---

#### MCP-006: In-Memory Rate Limiter

| Field | Value |
|-------|-------|
| **ID** | MCP-006 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/mcp-server/src/middleware/rate-limit.ts` |

**Description:**
The MCP server uses an in-memory rate limiter (a JavaScript Map) to track request counts per client. This rate limiter is:

- **Not shared across instances:** if the MCP server scales horizontally, each instance maintains its own counters, allowing an attacker to multiply their effective rate limit by the number of instances.
- **Vulnerable to memory exhaustion:** unique client identifiers are stored as map keys without eviction, allowing an attacker to consume server memory by generating many unique identifiers.
- **Lost on restart:** rate limit state is cleared when the container restarts, allowing burst abuse after deployments.

**Recommended Fix:**
Migrate rate limiting to Redis using a sliding window algorithm (e.g., `@fastify/rate-limit` with Redis store). This provides cross-instance consistency and persistence.

---

### 4.2 Helpdesk

---

#### HELP-001: Agent Routes Lack Organization Scoping (Cross-Org Ticket Data Leak)

| Field | Value |
|-------|-------|
| **ID** | HELP-001 |
| **Severity** | High |
| **CVSS 3.1** | 7.5 (High) |
| **CWE** | CWE-862: Missing Authorization |
| **Affected Files** | `apps/helpdesk-api/src/routes/agent.routes.ts` |

**Description:**
Agent-facing routes in the Helpdesk API authenticate the agent but do not verify that the tickets, customers, or conversations being accessed belong to the agent's organization. The ticket listing endpoint queries tickets by status and assignee without an `org_id` filter. An authenticated agent can:

1. List tickets from other organizations by manipulating filter parameters.
2. Access customer PII (names, emails, phone numbers) associated with tickets from other organizations.
3. View conversation history and internal notes from other organizations' support interactions.

This is a multi-tenant isolation failure that exposes sensitive customer support data across organizational boundaries.

**Attack Scenario:**
1. Agent authenticates with valid credentials for Organization A.
2. Agent calls `GET /agent/tickets?status=open` without org filtering -- the query returns open tickets from all organizations.
3. Agent reads customer details and conversation history from Organization B's tickets.

**Recommended Fix:**
1. Add `AND org_id = $1` to all ticket, customer, and conversation queries in agent routes, using the authenticated agent's `org_id`.
2. Create a shared `requireOrgScope` middleware for the Helpdesk API that injects the org filter into all queries.
3. Add integration tests that verify agent routes never return data from other organizations.

---

#### HELP-002: Agent Ticket Detail Not Organization-Scoped

| Field | Value |
|-------|-------|
| **ID** | HELP-002 |
| **Severity** | High |
| **CVSS 3.1** | 7.5 (High) |
| **CWE** | CWE-639: Authorization Bypass Through User-Controlled Key |
| **Affected Files** | `apps/helpdesk-api/src/routes/agent.routes.ts` |

**Description:**
The agent ticket detail endpoint (`GET /agent/tickets/:id`) looks up the ticket by primary key without verifying that the ticket belongs to the agent's organization. This is a specific instance of the broader HELP-001 pattern but affects the detail view which returns the complete ticket payload including all messages, attachments, customer contact information, and internal agent notes.

**Attack Scenario:**
1. Agent obtains a ticket UUID from another organization (from error messages, logs, or enumeration).
2. Agent calls `GET /agent/tickets/{cross_org_ticket_id}` and receives the complete ticket with all associated data.

**Recommended Fix:**
Same as HELP-001 -- add org_id verification on the ticket detail query.

---

#### HELP-003: Service-to-Service Shared Secret Limitations

| Field | Value |
|-------|-------|
| **ID** | HELP-003 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.9 (Medium) |
| **CWE** | CWE-798: Use of Hard-Coded Credentials |
| **Affected Files** | `apps/helpdesk-api/src/middleware/auth.ts` |

**Description:**
The Helpdesk API uses a shared secret (`INTERNAL_API_SECRET`) for service-to-service authentication between the main Bam API and the Helpdesk API. This secret is:

- The same value used by all internal services (no per-service secrets).
- Not rotatable without downtime (all services must be restarted simultaneously with the new value).
- Potentially logged if included in error messages or debug output.

A single compromised service exposes the shared secret for all inter-service communication.

**Recommended Fix:**
1. Implement per-service authentication tokens so that a compromise of one service does not grant access to all inter-service communication.
2. Use short-lived JWTs signed by a shared key for inter-service auth, with automatic rotation.
3. Alternatively, use mTLS for inter-service communication within the Docker network.

---

#### HELP-004: Email Enumeration on Registration

| Field | Value |
|-------|-------|
| **ID** | HELP-004 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-204: Observable Response Discrepancy |
| **Affected Files** | `apps/helpdesk-api/src/routes/auth.routes.ts` |

**Description:**
The Helpdesk registration endpoint returns different error messages for "email already registered" vs. other validation failures. This allows an attacker to enumerate which email addresses have accounts in the system by attempting registration with target addresses and observing the error response.

**Recommended Fix:**
Return a generic success message ("If this email is not already registered, you will receive a confirmation email") regardless of whether the email exists. Handle the duplicate case silently on the server side.

---

### 4.3 Worker

---

#### WORK-001: No Job Payload Validation

| Field | Value |
|-------|-------|
| **ID** | WORK-001 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-20: Improper Input Validation |
| **Affected Files** | `apps/worker/src/jobs/` (all job handlers) |

**Description:**
BullMQ job handlers in the Worker process do not validate the job payload (the `data` field) against a schema before processing. Job payloads are trusted as-is from the Redis queue. If an attacker gains access to the Redis instance (see INFRA-004) or if a bug in a producing service sends a malformed payload, the worker may:

- Crash with an unhandled exception due to missing or incorrectly typed fields.
- Process corrupted data that leads to incorrect email sends, broken exports, or premature sprint closures.
- Be exploited through type confusion if payload fields are used in string interpolation or SQL queries.

**Recommended Fix:**
1. Define Zod schemas for each job type's payload and validate at the start of every job handler.
2. Move failed-validation jobs to a dead-letter queue for inspection rather than crashing the worker.
3. Log validation failures with the job ID and payload summary for debugging.

---

#### WORK-002: Email Job Header Injection Risk

| Field | Value |
|-------|-------|
| **ID** | WORK-002 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-93: Improper Neutralization of CRLF Sequences |
| **Affected Files** | `apps/worker/src/jobs/email.job.ts` |

**Description:**
The email job handler constructs email headers (To, Subject, Reply-To) using values from the job payload without sanitizing for CRLF (`\r\n`) sequences. If an attacker can influence the job payload (via a compromised producing service or direct Redis access), they can inject additional email headers:

- `Bcc:` to send copies of emails to attacker-controlled addresses.
- `Content-Type:` to change the email body interpretation.
- Additional `To:` recipients to expand the email's reach.

**Recommended Fix:**
1. Strip or reject CRLF sequences from all email header values.
2. Use the email library's built-in header encoding (most libraries handle this if values are passed through proper APIs rather than raw header construction).
3. Validate email addresses with a strict regex before use in headers.

---

#### WORK-003: Export Job No Row Limit

| Field | Value |
|-------|-------|
| **ID** | WORK-003 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/worker/src/jobs/export.job.ts` |

**Description:**
The export job handler processes CSV/Excel export requests without enforcing a maximum row count. A user can trigger an export of a very large dataset (e.g., all tasks in a large project, all activity log entries) that consumes excessive memory and CPU on the worker, potentially causing the container to be OOM-killed and affecting other queued jobs.

**Recommended Fix:**
1. Enforce a configurable maximum row limit (e.g., 500,000 rows).
2. Use streaming writes for CSV/Excel generation to avoid loading all rows into memory.
3. Report partial exports to the user when the limit is reached.

---

#### WORK-004: Sprint-Close Job No Authorization Check

| Field | Value |
|-------|-------|
| **ID** | WORK-004 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-862: Missing Authorization |
| **Affected Files** | `apps/worker/src/jobs/sprint-close.job.ts` |

**Description:**
The sprint-close job handler processes sprint completion requests from the queue without verifying that the job was enqueued by an authorized user. While jobs are typically enqueued by authenticated API endpoints that perform their own authorization checks, the worker itself does not re-validate authorization. If an attacker can enqueue jobs directly (via Redis access or a compromised service), they can close any sprint in any project.

**Recommended Fix:**
1. Include the `user_id` and `org_id` in the job payload and verify them against the sprint's project membership before executing.
2. Sign job payloads with an HMAC to prevent tampering.
3. Ensure Redis is not accessible from outside the Docker network (see INFRA-004).

---

### 4.4 Infrastructure

---

#### INFRA-001: No Security Headers in nginx

| Field | Value |
|-------|-------|
| **ID** | INFRA-001 |
| **Severity** | High |
| **CVSS 3.1** | 7.1 (High) |
| **CWE** | CWE-693: Protection Mechanism Failure |
| **Affected Files** | `infra/nginx/nginx.conf` |

**Description:**
The nginx configuration does not set any security-related HTTP response headers. The following headers are missing:

- **`Strict-Transport-Security` (HSTS):** Without this, browsers allow HTTP connections, enabling man-in-the-middle downgrade attacks.
- **`Content-Security-Policy` (CSP):** Without this, all BigBlueBam SPAs are vulnerable to XSS via inline scripts, eval, and unrestricted resource loading.
- **`X-Frame-Options`:** Without this, all pages can be embedded in iframes on attacker-controlled sites, enabling clickjacking attacks.
- **`X-Content-Type-Options`:** Without this, browsers may MIME-sniff response bodies, potentially executing uploaded files as scripts.
- **`X-XSS-Protection`:** Legacy but still useful for older browsers.
- **`Referrer-Policy`:** Without this, full URLs (including query parameters with tokens) are leaked in Referer headers to external sites.
- **`Permissions-Policy`:** Without this, embedded content can access device features (camera, microphone, geolocation) without restriction.

These missing headers affect every page and API response served through nginx, impacting all 10+ BigBlueBam modules.

**Recommended Fix:**
Add the following to the nginx `server` block:

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss:; frame-ancestors 'none';" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
```

Tune the CSP directives per module as needed (e.g., Board may need `blob:` for canvas, Blast may need `img-src *` for email previews).

---

#### INFRA-002: No TLS Configuration

| Field | Value |
|-------|-------|
| **ID** | INFRA-002 |
| **Severity** | High |
| **CVSS 3.1** | 7.4 (High) |
| **CWE** | CWE-319: Cleartext Transmission of Sensitive Information |
| **Affected Files** | `infra/nginx/nginx.conf` |

**Description:**
The nginx configuration serves all traffic over plain HTTP on port 80. There is no TLS (HTTPS) configuration -- no SSL certificate paths, no `ssl_protocols` directive, no HTTP-to-HTTPS redirect. All traffic between clients and the server is transmitted in cleartext, including:

- Session cookies (vulnerable to session hijacking via network sniffing).
- Authentication credentials (login forms, API keys in headers).
- All business data (tasks, invoices, form submissions, CRM contacts, knowledge base articles).
- WebSocket connections carrying real-time collaboration data.

While a reverse proxy or load balancer in front of nginx may terminate TLS in production, the nginx configuration itself should support TLS for direct deployment scenarios and defense in depth.

**Recommended Fix:**
1. Add TLS configuration with modern cipher suites:
   ```nginx
   ssl_protocols TLSv1.2 TLSv1.3;
   ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:...';
   ssl_prefer_server_ciphers on;
   ```
2. Add an HTTP-to-HTTPS redirect on port 80.
3. Document the expected TLS termination architecture (at nginx, at load balancer, or both).

---

#### INFRA-003: Default/Weak Credentials in docker-compose

| Field | Value |
|-------|-------|
| **ID** | INFRA-003 |
| **Severity** | High |
| **CVSS 3.1** | 8.1 (High) |
| **CWE** | CWE-798: Use of Hard-Coded Credentials |
| **Affected Files** | `docker-compose.yml` |

**Description:**
The `docker-compose.yml` file contains default credentials for multiple services that are commonly deployed without change:

- PostgreSQL: default `POSTGRES_PASSWORD` (commonly `postgres` or a simple password in `.env.example`).
- Redis: default `REDIS_PASSWORD` in the healthcheck command and environment variables.
- MinIO: default `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`.
- Session secret: default `SESSION_SECRET` value.

While `.env.example` exists with placeholder values, `docker compose up` works with these defaults, and teams commonly deploy with unchanged credentials in staging or even production environments. The `.env.example` values themselves are weak (short, dictionary words).

**Recommended Fix:**
1. Remove all default credential values from `docker-compose.yml` -- require them to be set in `.env` with no fallbacks.
2. Add a startup validation script that checks credential strength (minimum length, entropy) before starting services.
3. Update `.env.example` with clearly non-functional placeholders (e.g., `CHANGE_ME_BEFORE_DEPLOY_<random>`).
4. Document the credential setup process in the deployment guide.

---

#### INFRA-004: Redis Healthcheck Exposes Password in Process List

| Field | Value |
|-------|-------|
| **ID** | INFRA-004 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-214: Invocation of Process Using Visible Sensitive Information |
| **Affected Files** | `docker-compose.yml` |

**Description:**
The Redis service healthcheck uses `redis-cli -a $REDIS_PASSWORD ping`, which passes the password as a command-line argument. This is visible in:

- `docker inspect` output for the container.
- Process listings (`ps aux`) inside the container.
- Docker daemon logs depending on log driver configuration.
- Container orchestration UIs (Portainer, Kubernetes dashboard).

**Recommended Fix:**
Use `redis-cli --no-auth-warning -a $REDIS_PASSWORD ping` to suppress the warning, or better, use `REDISCLI_AUTH` environment variable:
```yaml
healthcheck:
  test: ["CMD-SHELL", "REDISCLI_AUTH=$$REDIS_PASSWORD redis-cli ping"]
```

---

#### INFRA-005: API and MCP Ports Exposed to Host

| Field | Value |
|-------|-------|
| **ID** | INFRA-005 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-668: Exposure of Resource to Wrong Sphere |
| **Affected Files** | `docker-compose.yml` |

**Description:**
Multiple internal services have their ports mapped to the host machine using the `ports:` directive in `docker-compose.yml`. Services like the API (4000), MCP server (3001), and others are intended to be accessed only through the nginx reverse proxy but are also directly accessible on the host. This bypasses nginx's security controls (when security headers are added), rate limiting, and access logging.

**Recommended Fix:**
1. Remove host port mappings for internal services -- use `expose:` instead of `ports:` for services that should only be accessible within the Docker network.
2. Keep only the nginx port (80, and 443 when TLS is added) mapped to the host.
3. If direct access is needed for development, use `docker-compose.dev.yml` overrides.

---

#### INFRA-006: CORS_ORIGIN=* on 10+ APIs

| Field | Value |
|-------|-------|
| **ID** | INFRA-006 |
| **Severity** | Medium |
| **CVSS 3.1** | 6.1 (Medium) |
| **CWE** | CWE-942: Permissive Cross-domain Policy with Untrusted Domains |
| **Affected Files** | `docker-compose.yml`, `apps/*/src/server.ts` (all API services) |

**Description:**
The `CORS_ORIGIN` environment variable is set to `*` in the docker-compose configuration and is used by all API services (Bam, Banter, Beacon, Brief, Bolt, Bearing, Board, Bond, Blast, Bench, Helpdesk) to configure their CORS `Access-Control-Allow-Origin` header. This allows any website on the internet to make authenticated cross-origin requests to any BigBlueBam API if the user has an active session.

Combined with `credentials: true` in the CORS configuration, this means a malicious website can:
- Read the authenticated user's data from any API endpoint.
- Perform mutations (create, update, delete) on behalf of the user.
- Exfiltrate sensitive data across all modules.

**Recommended Fix:**
1. Set `CORS_ORIGIN` to the specific domain(s) where BigBlueBam is hosted (e.g., `https://app.bigbluebam.com`).
2. Support multiple origins via a comma-separated list or callback function that validates the `Origin` header against an allowlist.
3. Never use `*` with `credentials: true` -- browsers actually reject this combination for credentialed requests, but some CORS libraries work around it by reflecting the request origin, which is equally dangerous.

---

#### INFRA-007: No PostgreSQL Row-Level Security (RLS) Policies

| Field | Value |
|-------|-------|
| **ID** | INFRA-007 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.9 (Medium) |
| **CWE** | CWE-863: Incorrect Authorization |
| **Affected Files** | `infra/postgres/migrations/` |

**Description:**
Despite the design document specifying PostgreSQL RLS for multi-tenant isolation, no RLS policies have been implemented in any migration file. All organization isolation relies on application-level `WHERE org_id = ?` clauses in queries. This means:

- A single missing `org_id` filter in any query (as seen in multiple modules' findings) exposes cross-org data.
- Direct database access (via compromised credentials, SQL injection, or admin tools) has no tenant isolation.
- Database backups contain all tenants' data without any access control.

**Recommended Fix:**
1. Enable RLS on all tenant-scoped tables: `ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;`
2. Create policies that filter by `org_id` based on a session variable: `CREATE POLICY org_isolation ON tasks USING (org_id = current_setting('app.current_org_id')::uuid);`
3. Set the session variable in the application's database connection middleware.
4. This provides defense-in-depth even when application-level checks are missing.

---

#### INFRA-008: Qdrant Vector Database No Authentication

| Field | Value |
|-------|-------|
| **ID** | INFRA-008 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-306: Missing Authentication for Critical Function |
| **Affected Files** | `docker-compose.yml` |

**Description:**
The Qdrant vector database service is deployed without any authentication configuration. The Qdrant HTTP API and gRPC endpoints are accessible without credentials to any service on the Docker network (and potentially to the host if ports are exposed -- see INFRA-005). An attacker with network access can:

- Read all vector embeddings and associated metadata (Beacon knowledge base content, Brief document embeddings, Bond CRM data).
- Delete collections, destroying the semantic search index.
- Inject malicious vectors that could influence search results.

**Recommended Fix:**
1. Enable Qdrant API key authentication by setting the `QDRANT__SERVICE__API_KEY` environment variable.
2. Configure all Qdrant clients (Beacon, Brief, Bond) to include the API key in requests.
3. Ensure Qdrant ports are not exposed to the host network.

---

#### INFRA-009: LiveKit Default Credentials

| Field | Value |
|-------|-------|
| **ID** | INFRA-009 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-798: Use of Hard-Coded Credentials |
| **Affected Files** | `infra/livekit/livekit.yaml` |

**Description:**
The LiveKit SFU configuration file contains default API key and secret values. If deployed without changing these credentials, any client that knows the default values can create room tokens and join or create audio/video conferencing sessions, potentially intercepting Board module audio conferences.

**Recommended Fix:**
Generate strong, unique API keys and secrets for LiveKit. Store them as environment variables referenced in the configuration file rather than hardcoded values.

---

#### INFRA-010: Deploy Script Uses curl-to-sudo-bash

| Field | Value |
|-------|-------|
| **ID** | INFRA-010 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.9 (Medium) |
| **CWE** | CWE-494: Download of Code Without Integrity Check |
| **Affected Files** | Deploy scripts / documentation |

**Description:**
The deployment documentation or scripts reference a `curl | sudo bash` pattern for installing or updating BigBlueBam. This pattern downloads and executes code from a remote server with root privileges in a single step, without:

- Verifying the integrity of the downloaded script (no checksum verification).
- Allowing the operator to review the script before execution.
- Protecting against man-in-the-middle attacks (if the URL is HTTP rather than HTTPS).
- Handling partial downloads (curl may pipe an incomplete script to bash, which executes what it received).

**Recommended Fix:**
1. Provide the install script as a versioned file in the repository.
2. Document a two-step process: download the script, verify its checksum, then execute.
3. Use GPG-signed releases with verification instructions.
4. At minimum, ensure the download URL uses HTTPS with certificate pinning.

---

#### INFRA-011: Additional CORS and Network Concerns

| Field | Value |
|-------|-------|
| **ID** | INFRA-011 |
| **Severity** | Medium |
| **CVSS 3.1** | 4.3 (Medium) |
| **CWE** | CWE-668: Exposure of Resource to Wrong Sphere |
| **Affected Files** | `docker-compose.yml` |

**Description:**
Several additional network configuration concerns were identified that compound the risks in INFRA-005 and INFRA-006:

- The Docker default bridge network is used for all services, meaning all containers can communicate with all other containers without restriction.
- No network segmentation separates data services (PostgreSQL, Redis, Qdrant, MinIO) from application services.
- The MinIO console port may be exposed alongside the API port.

**Recommended Fix:**
1. Create separate Docker networks for frontend, backend, and data tiers.
2. Only allow application services to reach the data services they need.
3. Isolate the MinIO console to an admin-only network.

---

## 5. Methodology Notes

Each audit agent independently analyzed the assigned component source code and configuration files. Agents had read access to the full repository including all `apps/` directories, `infra/`, `docker-compose.yml`, and deployment scripts. Findings were deduplicated by root cause and grouped by component.

Infrastructure findings were given elevated severity ratings because they affect the entire platform rather than individual modules. The nginx security headers finding was prioritized because it is the simplest fix with the broadest impact.

---

## 6. Appendix: Agent Coverage Map

| Agent | Components Reviewed | Findings Contributed |
|-------|-------------------|---------------------|
| Auth & Session | MCP Server auth, Helpdesk auth | MCP-001, MCP-003, HELP-004 |
| Authorization (RBAC) | MCP tools, Helpdesk agent routes, Worker jobs | MCP-002, HELP-001, HELP-002, WORK-004 |
| Input Validation | Worker job handlers, MCP tool handlers | WORK-001, WORK-002 |
| Rate Limiting & DoS | MCP Server, Worker | MCP-005, MCP-006, WORK-003 |
| Infrastructure & Config | nginx.conf, docker-compose.yml, livekit.yaml, deploy scripts | INFRA-001 through INFRA-011 |
| Network Security | docker-compose.yml, nginx.conf | INFRA-002, INFRA-005, INFRA-006, INFRA-008, INFRA-011 |
| Cryptography | Helpdesk auth, MCP auth | HELP-003, MCP-004 |
| Business Logic | MCP confirmation flow | MCP-002 |
| Data Exposure & XSS | Helpdesk agent routes | HELP-001, HELP-002 |
| Supply Chain | Deploy scripts, Dockerfiles | INFRA-010 |
