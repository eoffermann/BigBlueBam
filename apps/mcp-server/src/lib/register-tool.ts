import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape, ZodTypeAny, z } from 'zod';
import type { Logger } from 'pino';
import { TOOL_TO_PERMISSION } from '@bigbluebam/permissions';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Side-channel registry mapping tool name → Zod return schema.
 * MCP SDK v1.x `server.tool()` does not accept an output schema, so we
 * record the return shape here and the schema generator walks this map
 * at build time to emit typed output ports for the Bolt graph editor.
 */
const returnSchemas = new Map<string, ZodTypeAny>();

export interface RegisterToolOptions<TInput extends ZodRawShape, TReturn extends ZodTypeAny> {
  name: string;
  description: string;
  input: TInput;
  returns: TReturn;
  handler: (args: z.infer<z.ZodObject<TInput>>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Policy gate (AGENTIC_TODO §15, Wave 5)
// ---------------------------------------------------------------------------
//
// Every service-account tool invocation passes through a gate that fail-closes
// on disabled policies and tool-allowlist mismatches. The gate is a per-session
// construct (session == McpServer instance) because:
//   1. The caller identity is pinned by the bearer token on the session's
//      ApiClient, so the gate never needs to re-resolve it mid-session.
//   2. Short-TTL in-process cache of (agent_user_id -> policy decision) lives
//      on the gate and is invalidated by Redis PubSub.
//
// Human callers bypass the gate entirely. Always-permitted core tools
// (`get_server_info`, `get_me`, `agent_heartbeat`) run regardless of policy
// so a disabled agent can still identify itself and heartbeat.
//
// The gate is attached to the McpServer via attachPolicyGate() after the
// McpServer is constructed but BEFORE any register* call runs. register-tool
// looks the gate up by McpServer identity.

export type PolicyDenialReason = 'AGENT_DISABLED' | 'TOOL_NOT_ALLOWED';

export interface PolicyDecision {
  allowed: boolean;
  reason?: PolicyDenialReason;
  agent_user_id?: string;
  disabled_at?: string | null;
  contact?: string | null;
}

/**
 * Always-permitted core tools. These run for every caller regardless of the
 * policy's `allowed_tools` list because:
 *   - get_server_info   (clients need to introspect the server to know what
 *                        tools exist and whether they are authenticated)
 *   - get_me            (clients need to know who they are; required for the
 *                        "call contact" leg of an AGENT_DISABLED error to
 *                        make sense)
 *   - agent_heartbeat   (a disabled agent still needs to mark itself alive so
 *                        operators can triage; the heartbeat endpoint on the
 *                        api side separately gates on users.kind)
 */
export const ALWAYS_PERMITTED_TOOLS: ReadonlySet<string> = new Set([
  'get_server_info',
  'get_me',
  'agent_heartbeat',
]);

export interface PolicyGate {
  /**
   * Decide whether a tool invocation should proceed. Returns
   * `{ allowed: true }` for human callers, for always-permitted core tools,
   * and for service callers whose policy permits the tool. Returns
   * `{ allowed: false, ... }` otherwise.
   */
  check(toolName: string): Promise<PolicyDecision>;
  /**
   * Resolve the bearer-token's caller identity once. Cached for the session.
   * Wave D uses this so the per-action resolver knows who is calling — for
   * humans the §15 check short-circuits to ALLOW without surfacing the id,
   * but per-action enforcement still needs it.
   */
  getCaller(): Promise<{ kind: 'human' | 'agent' | 'service' | 'unknown'; id: string | null }>;
  /**
   * Drop the policy cache for the given agent_user_id. Invoked from the
   * Redis PubSub listener when a policy row changes.
   */
  invalidate(agent_user_id: string): void;
}

// Module-level attachment: we key by McpServer identity so register-tool can
// find the gate that was set up for this session. Using a WeakMap means gates
// are garbage-collected when their owning McpServer goes away (session close).
const gateRegistry = new WeakMap<McpServer, PolicyGate>();

export function attachPolicyGate(server: McpServer, gate: PolicyGate): void {
  gateRegistry.set(server, gate);
}

export function getPolicyGate(server: McpServer): PolicyGate | undefined {
  return gateRegistry.get(server);
}

// ---------------------------------------------------------------------------
// PolicyGate implementation
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 5_000;
const MAX_CACHE_TTL_MS = 30_000;

interface CachedCallerKind {
  kind: 'human' | 'agent' | 'service' | 'unknown';
  id: string | null;
  cachedAt: number;
}

interface CachedPolicyDecision {
  decision: PolicyDecision;
  cachedAt: number;
}

interface CreatePolicyGateOptions {
  apiClient: ApiClient;
  logger: Logger;
  sessionId: string;
  ttlMs?: number;
}

/**
 * Build a per-session PolicyGate. The gate caches the caller's kind (resolved
 * once from /auth/me + /users/:id) and caches the per-tool decision for the
 * caller's agent_user_id for `ttlMs` milliseconds. Cache entries are evicted
 * when invalidate() is called.
 */
export function createPolicyGate(opts: CreatePolicyGateOptions): PolicyGate {
  const ttl = Math.min(opts.ttlMs ?? DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS);

  // Caller-kind cache: single entry, since the bearer token pins the caller
  // for the lifetime of the session. We still refresh on TTL expiry in case
  // the user's kind was toggled mid-session (rare, but supported).
  let callerCache: CachedCallerKind | null = null;
  // Per-tool decision cache. Keyed by toolName; invalidate() wipes the whole
  // map since the invalidation trigger is "policy for this agent changed",
  // which potentially moves every tool.
  const decisionCache = new Map<string, CachedPolicyDecision>();

  async function resolveCaller(): Promise<CachedCallerKind> {
    const now = Date.now();
    if (callerCache && now - callerCache.cachedAt < ttl) return callerCache;

    // Resolve via /auth/me, which returns both `id` and `kind` in a single
    // round-trip. Historically this required a second /users/:id hop (which
    // silently returned no `kind` field on older api images, causing the
    // gate to mark every human caller as 'unknown' and fail-closed with
    // AGENT_DISABLED). We tolerate failure: on an error we treat the caller
    // as 'unknown' and fail-closed in the gate check.
    try {
      const meRes = await opts.apiClient.get<{
        data?: { id?: string; kind?: string };
      }>('/auth/me');
      const id = meRes.ok ? meRes.data?.data?.id ?? null : null;
      if (!id) {
        callerCache = { kind: 'unknown', id: null, cachedAt: now };
        return callerCache;
      }
      const rawKind = meRes.data?.data?.kind;
      const kind: CachedCallerKind['kind'] =
        rawKind === 'human' || rawKind === 'agent' || rawKind === 'service'
          ? rawKind
          : 'unknown';
      if (kind === 'unknown') {
        opts.logger.warn(
          { sessionId: opts.sessionId, id, rawKind },
          'PolicyGate: /auth/me returned no usable kind; upgrading api image should restore it',
        );
      }
      callerCache = { kind, id, cachedAt: now };
      return callerCache;
    } catch (err) {
      opts.logger.warn(
        { err, sessionId: opts.sessionId },
        'PolicyGate: failed to resolve caller kind; treating as unknown',
      );
      callerCache = { kind: 'unknown', id: null, cachedAt: now };
      return callerCache;
    }
  }

  async function check(toolName: string): Promise<PolicyDecision> {
    // Always-permitted core tools bypass EVERYTHING. This matters because
    // get_server_info is the first thing an MCP client calls, and get_me
    // is how the client learns its own identity; disabling an agent must
    // not wedge its ability to explain itself.
    if (ALWAYS_PERMITTED_TOOLS.has(toolName)) {
      return { allowed: true };
    }

    const caller = await resolveCaller();

    // Human callers are out of scope for policy checks. The allowlist is
    // an agent/service surface only; humans get whatever their session
    // scope permits and the /v1/... routes enforce their ACLs separately.
    if (caller.kind === 'human') return { allowed: true };

    // Unknown callers fail-closed. We don't know who this is, so we can't
    // verify they are permitted. This also catches token-rotation edge
    // cases where /auth/me briefly returns 401.
    if (caller.kind === 'unknown' || !caller.id) {
      return {
        allowed: false,
        reason: 'AGENT_DISABLED',
        agent_user_id: caller.id ?? '',
        disabled_at: null,
        contact: null,
      };
    }

    // Service / agent caller: consult the cache, falling back to the API.
    const cached = decisionCache.get(toolName);
    const now = Date.now();
    if (cached && now - cached.cachedAt < ttl) {
      // Wave B follow-up: dual-read on cache-hit path too. We already
      // know the decision, so this is just telemetry.
      recordDualRead(toolName, cached.decision, caller.id);
      return cached.decision;
    }

    try {
      const res = await opts.apiClient.post<{ data?: PolicyDecision }>(
        `/v1/agent-policies/${caller.id}/check?tool=${encodeURIComponent(toolName)}`,
        {},
      );
      if (!res.ok) {
        opts.logger.warn(
          { status: res.status, sessionId: opts.sessionId, toolName, agent: caller.id },
          'PolicyGate: check endpoint returned non-2xx; fail-closed',
        );
        const decision: PolicyDecision = {
          allowed: false,
          reason: 'AGENT_DISABLED',
          agent_user_id: caller.id,
          disabled_at: null,
          contact: null,
        };
        decisionCache.set(toolName, { decision, cachedAt: now });
        recordDualRead(toolName, decision, caller.id);
        return decision;
      }
      const decision: PolicyDecision = res.data?.data ?? {
        allowed: false,
        reason: 'AGENT_DISABLED',
        agent_user_id: caller.id,
        disabled_at: null,
        contact: null,
      };
      decisionCache.set(toolName, { decision, cachedAt: now });
      recordDualRead(toolName, decision, caller.id);
      return decision;
    } catch (err) {
      opts.logger.error(
        { err, sessionId: opts.sessionId, toolName, agent: caller.id },
        'PolicyGate: check endpoint threw; fail-closed',
      );
      return {
        allowed: false,
        reason: 'AGENT_DISABLED',
        agent_user_id: caller.id,
        disabled_at: null,
        contact: null,
      };
    }
  }

  function invalidate(agent_user_id: string): void {
    // If the invalidated id matches our cached caller, drop both caches.
    // Otherwise drop nothing; this session's cached decisions are still
    // valid because they belong to a different agent.
    if (callerCache?.id === agent_user_id) {
      decisionCache.clear();
      // Leave callerCache in place; caller identity didn't change, just the
      // policy did. Next call will refetch the decision.
    }
  }

  /**
   * Wave B follow-up: fire-and-forget dual-read against the new resolver.
   * After agent_policies decides, post the decision + the agent's user_id
   * + the catalog permission_id to the api's internal endpoint, which
   * runs the resolver and writes a row to permissions_divergence_log.
   *
   * The promise is intentionally unawaited — this must never block the
   * tool invocation. Failure modes (network down, internal secret wrong,
   * api 5xx) all fall back to "no telemetry row written," which is
   * acceptable: the legacy agent_policies decision is still authoritative.
   */
  function recordDualRead(toolName: string, agentDecision: PolicyDecision, callerId: string | null): void {
    if (!callerId) return;
    // Wave D Phase 2: when per-action enforcement is on/warn AND the policy
    // accepted, the wrapper will call checkPermissionViaResolver itself —
    // which writes the same divergence row this would. Skip here to avoid
    // double rows. We still fire on policy DENIES at every mode because the
    // wrapper returns early before reaching the resolver, and the FAIL-side
    // divergence ("policy denied but resolver would have allowed") is
    // exactly the kind of triage data the dashboard exists for.
    const enforceMode = process.env.BBB_PERMISSIONS_ENFORCE ?? 'off';
    if (agentDecision.allowed && enforceMode !== 'off') return;
    const permissionId = TOOL_TO_PERMISSION.get(toolName);
    if (!permissionId) return; // unknown tool — skip silently
    const internalSecret = process.env.INTERNAL_SERVICE_SECRET ?? process.env.INTERNAL_HELPDESK_SECRET;
    if (!internalSecret) return;

    void (async () => {
      try {
        // ApiClient is bearer-auth (caller's session); we can't reuse it
        // for an internal-secret POST. Use raw fetch against the api's
        // internal URL.
        const apiUrl = process.env.BBB_API_INTERNAL_URL ?? 'http://api:4000';
        const body = {
          user_id: callerId,
          permission_id: permissionId,
          agent_policy_decision: agentDecision.allowed ? 'allow' : 'deny',
          tool_name: toolName,
          scope: {},
        };
        await fetch(`${apiUrl}/internal/permissions/dual-read`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': internalSecret,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        opts.logger.debug(
          { err, sessionId: opts.sessionId, toolName },
          'PolicyGate: dual-read POST failed (best-effort)',
        );
      }
    })();
  }

  // Wave D: getCaller() exposes the resolved bearer-token identity so the
  // per-action resolver can run on every code path (including humans, who
  // §15 short-circuits to ALLOW without surfacing their id).
  async function getCaller(): Promise<{ kind: 'human' | 'agent' | 'service' | 'unknown'; id: string | null }> {
    const c = await resolveCaller();
    return { kind: c.kind, id: c.id };
  }

  return { check, getCaller, invalidate };
}

// ---------------------------------------------------------------------------
// registerTool
// ---------------------------------------------------------------------------

/**
 * Build a CallToolResult-shaped error response for a policy denial. The
 * shape matches the spec in AGENTIC_TODO §15:
 *
 *   { content: [{ type: 'text', text: JSON.stringify({
 *       error: {
 *         code: 'AGENT_DISABLED' | 'TOOL_NOT_ALLOWED',
 *         agent_user_id, disabled_at, contact, message
 *       }
 *     }, null, 2) }], isError: true }
 */
export function buildPolicyDenialResult(
  toolName: string,
  decision: PolicyDecision,
): { content: { type: 'text'; text: string }[]; isError: true } {
  const code: PolicyDenialReason = decision.reason ?? 'AGENT_DISABLED';
  const message =
    code === 'AGENT_DISABLED'
      ? `This agent is currently disabled by operator policy. Contact ${decision.contact ?? 'a platform administrator'} to re-enable it.`
      : `Tool '${toolName}' is not in the allowed_tools list for this agent. Contact ${decision.contact ?? 'a platform administrator'} to request access.`;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: {
              code,
              agent_user_id: decision.agent_user_id ?? null,
              disabled_at: decision.disabled_at ?? null,
              contact: decision.contact ?? null,
              message,
            },
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Wave D Phase 2: per-action permission enforcement at the MCP layer.
 *
 * `buildPermissionDenialResult` mirrors `buildPolicyDenialResult` for the
 * resolver-deny case. The error code `PERMISSION_DENIED` is distinct from
 * `AGENT_DISABLED` / `TOOL_NOT_ALLOWED` so triage can tell the two layers
 * apart: §15 policy denials are operator kill-switches; PERMISSION_DENIED
 * means the caller's group / overrides do not grant the action.
 */
export function buildPermissionDenialResult(
  toolName: string,
  permissionId: string,
): { content: { type: 'text'; text: string }[]; isError: true } {
  const message = `Tool '${toolName}' requires permission '${permissionId}', which is not granted to this caller. Contact a platform administrator if this should be allowed.`;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: {
              code: 'PERMISSION_DENIED',
              permission_id: permissionId,
              tool_name: toolName,
              message,
            },
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Synchronously consult the api's resolver for one (caller, permission)
 * pair. Returns the resolver's decision plus the permission_id it
 * checked (caller may want to log it). Returns `'unknown'` whenever the
 * call cannot be made (missing tool→permission mapping, missing internal
 * secret, network error, non-2xx); the wrapper treats `'unknown'` as
 * pass-through to preserve availability — only an explicit `'deny'` in
 * `enforce === 'on'` mode blocks invocation.
 *
 * Reuses `/internal/permissions/dual-read` because the endpoint already
 * runs the resolver AND writes the divergence row. In Wave D Phase 2 this
 * call goes from fire-and-forget (Wave B telemetry) to synchronous so the
 * decision can gate the handler.
 */
export async function checkPermissionViaResolver(
  toolName: string,
  callerId: string,
): Promise<{ decision: 'allow' | 'deny' | 'unknown'; permissionId: string | null }> {
  const permissionId = TOOL_TO_PERMISSION.get(toolName);
  if (!permissionId) return { decision: 'unknown', permissionId: null };
  const internalSecret = process.env.INTERNAL_SERVICE_SECRET ?? process.env.INTERNAL_HELPDESK_SECRET;
  if (!internalSecret) return { decision: 'unknown', permissionId };
  const apiUrl = process.env.BBB_API_INTERNAL_URL ?? 'http://api:4000';
  try {
    const res = await fetch(`${apiUrl}/internal/permissions/dual-read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret,
      },
      body: JSON.stringify({
        user_id: callerId,
        permission_id: permissionId,
        agent_policy_decision: 'allow', // §15 already accepted to reach here
        tool_name: toolName,
        scope: {},
      }),
    });
    if (!res.ok) return { decision: 'unknown', permissionId };
    const json = (await res.json()) as { data?: { decision?: string } };
    const d = json?.data?.decision;
    if (d === 'allow' || d === 'deny') return { decision: d, permissionId };
    return { decision: 'unknown', permissionId };
  } catch {
    // Pass-through on network / parse errors. Resolver outages must not
    // wedge tool invocations — only an explicit `deny` in 'on' mode blocks.
    return { decision: 'unknown', permissionId };
  }
}

export function registerTool<TInput extends ZodRawShape, TReturn extends ZodTypeAny>(
  server: McpServer,
  opts: RegisterToolOptions<TInput, TReturn>,
): void {
  returnSchemas.set(opts.name, opts.returns);

  // Wrap the original handler so every invocation passes through the
  // per-session PolicyGate (if one is attached). Humans bypass §15, core
  // tools bypass everything, everyone else gets gated.
  //
  // Wave D Phase 2 layers per-action permission enforcement on top: after
  // §15 accepts, run the resolver synchronously. `BBB_PERMISSIONS_ENFORCE`
  // controls the mode: 'off' skips, 'warn' records divergence (existing
  // Wave B behavior — but now sync rather than fire-and-forget so a single
  // path covers both), 'on' blocks on resolver-deny.
  const wrappedHandler = (async (args: z.infer<z.ZodObject<TInput>>) => {
    const gate = gateRegistry.get(server);
    if (gate) {
      const decision = await gate.check(opts.name);
      if (!decision.allowed) {
        return buildPolicyDenialResult(opts.name, decision);
      }

      // Wave D per-action check. Always-permitted core tools bypass.
      const enforce = (process.env.BBB_PERMISSIONS_ENFORCE ?? 'off') as 'off' | 'warn' | 'on';
      if (enforce !== 'off' && !ALWAYS_PERMITTED_TOOLS.has(opts.name)) {
        const caller = await gate.getCaller();
        if (caller.id) {
          const { decision: resolverDecision, permissionId } =
            await checkPermissionViaResolver(opts.name, caller.id);
          if (enforce === 'on' && resolverDecision === 'deny' && permissionId) {
            return buildPermissionDenialResult(opts.name, permissionId);
          }
        }
      }
    }
    return opts.handler(args);
  }) as typeof opts.handler;

  server.tool(opts.name, opts.description, opts.input, wrappedHandler as never);
}

export function getReturnSchema(name: string): ZodTypeAny | undefined {
  return returnSchemas.get(name);
}

export function getAllReturnSchemas(): ReadonlyMap<string, ZodTypeAny> {
  return returnSchemas;
}
