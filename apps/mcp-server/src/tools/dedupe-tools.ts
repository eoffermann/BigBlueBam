import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';
import { helpdeskAgentPath } from '../lib/helpdesk-agent-path.js';

/**
 * Dedupe MCP tools (Wave 5 AGENTIC_TODO §7).
 *
 *   - bond_find_duplicates         → GET /v1/contacts/:id/duplicates   (bond-api)
 *   - helpdesk_find_similar_tickets → GET /helpdesk/agents/tickets/:id/similar
 *   - dedupe_record_decision       → POST /v1/dedupe-decisions          (api)
 *   - dedupe_list_pending          → GET  /v1/dedupe-decisions/pending  (api)
 *
 * Canonical ordered-pair handling lives in the api-side service. These
 * tools forward the raw ids as given; the service sorts them before
 * insert. Agents overwriting a human decision are rejected with 409
 * HUMAN_DECISION_EXISTS and the tool surfaces the prior_decision in
 * the response so the caller can display the human verdict.
 */

const DECISION_VALUES = ['duplicate', 'not_duplicate', 'needs_review'] as const;

const priorDecisionShape = z
  .object({
    decision: z.enum(DECISION_VALUES),
    decided_at: z.string(),
    decided_by: z.string().uuid(),
    reason: z.string().nullable(),
    resurface_after: z.string().nullable(),
  })
  .passthrough();

/**
 * Thin fetch wrapper mirroring the per-app clients used by bond-tools
 * and helpdesk-tools. Forwards the caller's bearer token so visibility
 * is applied at the downstream service.
 */
function createServiceClient(baseUrl: string, api: ApiClient) {
  const base = baseUrl.replace(/\/$/, '');
  async function request(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const token = (api as unknown as { token?: string }).token;
    const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, init);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }
  return { request };
}

export interface DedupeToolsConfig {
  bondApiUrl: string;
  helpdeskApiUrl: string;
}

export function registerDedupeTools(
  server: McpServer,
  api: ApiClient,
  config: DedupeToolsConfig,
): void {
  const bond = createServiceClient(config.bondApiUrl, api);
  const helpdesk = createServiceClient(config.helpdeskApiUrl, api);

  // ────────────────────────────────────────────────────────────────────
  // bond_find_duplicates
  // ────────────────────────────────────────────────────────────────────
  registerTool(server, {
    name: 'bond_find_duplicates',
    description:
      "Return likely duplicate contacts for a single Bond contact ranked by confidence. Signals combine pg_trgm full-name similarity, exact case-insensitive email match, and exact normalized-phone match. Each candidate row carries the contributing signals and, when a dedupe_decisions row exists for the pair, a prior_decision block so the caller can suppress pairs a human has already resolved. Member and viewer callers only see contacts they own; admins see everything in the org.",
    input: {
      contact_id: z.string().uuid().describe('Source contact id.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max candidates to return (default 10, max 50).'),
      min_confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Minimum confidence threshold in [0, 1] (default 0.3).'),
    },
    returns: z.object({
      source_contact_id: z.string().uuid(),
      candidates: z.array(
        z
          .object({
            contact_id: z.string().uuid(),
            confidence: z.number(),
            signals: z.array(z.object({ kind: z.string(), detail: z.string().optional(), score: z.number() })),
            prior_decision: priorDecisionShape.optional(),
          })
          .passthrough(),
      ),
    }),
    handler: async ({ contact_id, limit, min_confidence }) => {
      const qs = new URLSearchParams();
      if (limit !== undefined) qs.set('limit', String(limit));
      if (min_confidence !== undefined) qs.set('min_confidence', String(min_confidence));
      // BOND_API_URL already ends in /v1 (see apps/mcp-server/src/env.ts), so
      // we send a path without the /v1 prefix. Same convention as bond-tools.ts.
      const path = `/contacts/${contact_id}/duplicates${qs.toString() ? `?${qs.toString()}` : ''}`;
      const result = await bond.request('GET', path);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error finding duplicates: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // helpdesk_find_similar_tickets
  // ────────────────────────────────────────────────────────────────────
  registerTool(server, {
    name: 'helpdesk_find_similar_tickets',
    description:
      "Return similar helpdesk tickets for a single ticket ranked by confidence. Signals combine pg_trgm subject similarity, same-requester boost, same-category boost, and an existing tickets.duplicate_of link. Status filter defaults to 'not_closed' (open + in_progress + waiting + resolved). Pass 'open' for open-only or 'any' to include closed tickets. window_days restricts candidates to tickets created within the window. Each candidate carries a prior_decision block when a dedupe_decisions row exists for the pair.",
    input: {
      ticket_id: z.string().uuid().describe('Source ticket id.'),
      status_filter: z
        .enum(['open', 'any', 'not_closed'])
        .optional()
        .describe("Status filter (default 'not_closed')."),
      limit: z.number().int().min(1).max(50).optional().describe('Max candidates (default 10, max 50).'),
      window_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe('Restrict candidates to tickets created within the last N days (default: no restriction).'),
      min_confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Minimum confidence threshold in [0, 1] (default 0.25).'),
    },
    returns: z.object({
      source_ticket_id: z.string().uuid(),
      candidates: z.array(
        z
          .object({
            ticket_id: z.string().uuid(),
            ticket_number: z.number().nullable(),
            subject: z.string(),
            status: z.string(),
            confidence: z.number(),
            similarity_signals: z.array(
              z.object({ kind: z.string(), detail: z.string().optional(), score: z.number() }),
            ),
            prior_decision: priorDecisionShape.optional(),
          })
          .passthrough(),
      ),
    }),
    handler: async ({ ticket_id, status_filter, limit, window_days, min_confidence }) => {
      const qs = new URLSearchParams();
      if (status_filter) qs.set('status_filter', status_filter);
      if (limit !== undefined) qs.set('limit', String(limit));
      if (window_days !== undefined) qs.set('window_days', String(window_days));
      if (min_confidence !== undefined) qs.set('min_confidence', String(min_confidence));
      const path = helpdeskAgentPath(`/tickets/${ticket_id}/similar${qs.toString() ? `?${qs.toString()}` : ''}`);
      const result = await helpdesk.request('GET', path);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error finding similar tickets: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // dedupe_record_decision
  // ────────────────────────────────────────────────────────────────────
  registerTool(server, {
    name: 'dedupe_record_decision',
    description:
      "Record a dedupe decision for an entity pair. The tool canonicalizes the pair order before writing, so passing (A, B) and (B, A) collide on the same row. decision is one of 'duplicate' | 'not_duplicate' | 'needs_review'. When an agent tries to overwrite a decision that a human previously recorded, the tool returns isError with code HUMAN_DECISION_EXISTS and includes the prior_decision so the caller can surface the human verdict. Humans and service accounts may always write. resurface_after is optional; when set, dedupe_list_pending will resurface the pair once the timestamp has passed.",
    input: {
      entity_type: z
        .string()
        .min(1)
        .max(64)
        .describe("Entity type (e.g. 'bond.contact', 'helpdesk.ticket')."),
      id_a: z.string().uuid().describe('One side of the pair. Order does not matter; the tool canonicalizes.'),
      id_b: z.string().uuid().describe('The other side of the pair. Must differ from id_a.'),
      decision: z.enum(DECISION_VALUES).describe("Decision to record."),
      reason: z.string().max(4000).optional().describe('Optional free-text justification.'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence that drove this decision, in [0, 1].'),
      resurface_after: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('Optional ISO-8601 timestamp. When set, dedupe_list_pending resurfaces the pair after this time.'),
    },
    returns: z
      .object({
        data: z
          .object({
            id: z.string().uuid(),
            org_id: z.string().uuid(),
            entity_type: z.string(),
            id_a: z.string().uuid(),
            id_b: z.string().uuid(),
            decision: z.enum(DECISION_VALUES),
            decided_by: z.string().uuid(),
            decided_at: z.string(),
            reason: z.string().nullable(),
            confidence_at_decision: z.number().nullable(),
            resurface_after: z.string().nullable(),
            created_at: z.string(),
          })
          .passthrough(),
        created: z.boolean(),
      })
      .passthrough(),
    handler: async ({ entity_type, id_a, id_b, decision, reason, confidence, resurface_after }) => {
      const body: Record<string, unknown> = { entity_type, id_a, id_b, decision };
      if (reason !== undefined) body.reason = reason;
      if (confidence !== undefined) body.confidence = confidence;
      if (resurface_after !== undefined) body.resurface_after = resurface_after;
      const result = await api.post('/v1/dedupe-decisions', body);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error recording dedupe decision: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // dedupe_list_pending
  // ────────────────────────────────────────────────────────────────────
  registerTool(server, {
    name: 'dedupe_list_pending',
    description:
      "List dedupe-decision pairs that still need human attention. A row is considered pending if its decision is 'needs_review' OR if a resurface_after timestamp was set and has now elapsed. Filter by entity_type to focus on one app's pairs; filter by since to restrict to rows decided after an ISO-8601 timestamp. Rows are returned ordered by decided_at DESC.",
    input: {
      entity_type: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Optional entity_type filter (e.g. 'bond.contact')."),
      since: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('Optional ISO-8601 timestamp; restrict to rows decided after this time.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50, max 200).'),
    },
    returns: z.object({
      pending: z.array(
        z
          .object({
            id: z.string().uuid(),
            org_id: z.string().uuid(),
            entity_type: z.string(),
            id_a: z.string().uuid(),
            id_b: z.string().uuid(),
            decision: z.enum(DECISION_VALUES),
            decided_by: z.string().uuid(),
            decided_at: z.string(),
            reason: z.string().nullable(),
            confidence_at_decision: z.number().nullable(),
            resurface_after: z.string().nullable(),
            created_at: z.string(),
          })
          .passthrough(),
      ),
    }),
    handler: async ({ entity_type, since, limit }) => {
      const qs = new URLSearchParams();
      if (entity_type) qs.set('entity_type', entity_type);
      if (since) qs.set('since', since);
      if (limit !== undefined) qs.set('limit', String(limit));
      const path = `/v1/dedupe-decisions/pending${qs.toString() ? `?${qs.toString()}` : ''}`;
      const result = await api.get(path);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing pending dedupe decisions: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });
}
