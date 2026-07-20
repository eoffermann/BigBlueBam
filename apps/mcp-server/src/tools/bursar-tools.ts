import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { BursarNormativeStrength } from '@bigbluebam/shared';
import type { ApiClient } from '../middleware/api-client.js';
import type { ConfirmTokenStore } from '../lib/confirm-token-store.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Bursar MCP tools (Milestone M9 - AI absence-detection / bid-leveling + scope-drift monitor).
 *
 * 20 tools backing the bursar-api REST surface at /bursar/api/v1/* (spec section 12 of
 * docs/brainstorming/2026_07_19_20_05_APP_DESIGN_bursar.md). The HTTP client is shaped like
 * burn-tools.ts / bulwark-tools.ts: it forwards the caller's bearer token so bursar-api applies
 * the same per-viewer visibility and requireCan gating the human UI does. BURSAR_API_URL already
 * ends in /v1 (see env.ts), so paths here are sent WITHOUT a /v1 prefix.
 *
 * ── asker_user_id NARROWS TWO THINGS (the same rule as Burn) ────────────────────────────────
 *
 * On every read that surfaces sealed bids or money, `asker_user_id` narrows BOTH row visibility
 * AND financial flooring: bursar-api takes the INTERSECTION of the bearer's and the asker's
 * capabilities (apps/bursar-api/src/lib/viewer-caps.ts). Without it, an admin service-account
 * bearer acting for a plain member would return fully unfloored per-vendor spend and unsealed
 * offer figures. So pass `asker_user_id` on every tool that surfaces vendor money, sealed offers,
 * comparable totals, or the coverage matrix (the four seal-predicate reads the spec calls out:
 * offers / coverage / totals / matrix). asker_user_id is NARROWING only, never widening.
 *
 * mcp-server cannot backstop this itself: register-tool.ts reads BBB_PERMISSIONS_ENFORCE from
 * mcp-server's OWN env (compose default 'warn'), so its per-action check never denies. bursar-api
 * is the only layer that enforces it, and it runs mode 'on' with onUnknown 'deny' (spec 13.3).
 *
 * ── AGENT POLICY GATING ─────────────────────────────────────────────────────────────────────
 *
 * Following the basis/braid/bulwark/burn satellite pattern, bursar_* tools are intentionally NOT
 * added to EXPLICIT_TOOL_OVERRIDES in scripts/generate-permission-manifest.mjs; the bursar.*
 * allowlist gating is automatic via register-tool's PolicyGate (matchesAllowlist('bursar.*'),
 * apps/api/src/services/agent-policy.service.ts). The glob is not hardcoded in code - it is data
 * stored per-agent in agent_policies.allowed_tools. Because every tool here is named
 * bursar_<verb>_<noun>, an operator allowlisting 'bursar.*' gates them all, and they FAIL CLOSED
 * until that happens (bursar.* is not always-permitted).
 *
 * ── HUMAN-GATE SKIPS (spec 12) ──────────────────────────────────────────────────────────────
 *
 * Intentionally NO tool for: scope confirm and rival promotion (human gates), all award WRITE
 * routes (award create/amend/terminate - the freeze is a human act), offer upload and spend
 * import (multipart), coverage override and detector mark-wrong (human adjudication is the
 * calibration ground truth), offer unseal, draft approve/reject, settings and library writes,
 * /internal/*, /bursar/ws, health, and both CSV exports. Do NOT "complete the surface" by adding
 * one; those omissions are the security boundary.
 */

/** HTTP client for the bursar-api service (mirrors createBurnClient). */
function createBursarClient(bursarApiUrl: string, api: ApiClient) {
  const baseUrl = bursarApiUrl.replace(/\/$/, '');
  async function request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    const token = (api as unknown as { token?: string }).token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: res.ok, status: res.status, data };
  }
  return { request };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

/** Append ?asker_user_id (+ optional extra filter params) so bursar-api narrows rows and flooring. */
function askerQs(asker_user_id?: string, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  if (asker_user_id) params.set('asker_user_id', asker_user_id);
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const askerInput = z
  .string()
  .uuid()
  .optional()
  .describe(
    'The human on whose behalf the agent is asking. Narrows BOTH row visibility (can_access, fail-closed) AND financial flooring: bursar-api takes the intersection of the bearer and asker capabilities, so an admin service-account acting for a member receives no unfloored per-vendor spend or unsealed offer figures. Narrowing only; it never widens.',
  );

// Confirm-token TTL. 5 min is the human-approver window CLAUDE.md documents. Both Bursar confirm
// boundaries are human-reviewed consequential writes, so both take the human TTL.
const BURSAR_CONFIRM_TTL_MS = 300_000;
const BURSAR_UPSERT_SCOPE_NODE_ACTION = 'bursar_upsert_scope_node';
const BURSAR_DRAFT_CLARIFICATION_ACTION = 'bursar_draft_clarification';

export function registerBursarTools(
  server: McpServer,
  api: ApiClient,
  bursarApiUrl: string,
  confirmTokenStore: ConfirmTokenStore,
): void {
  const client = createBursarClient(bursarApiUrl, api);

  // ── 1. bursar_level_quotes (async compute-start; NOT confirm-gated) ──────────
  registerTool(server, {
    name: 'bursar_level_quotes',
    description:
      'Run the absence engine over a request\'s offers: score every scope node against every offer, compute gap-adjusted comparable totals, and detect exclusions (POST /requests/:id/level). ASYNC-START: returns a run_id (202); poll bursar_list_leveling_runs for progress. Pass dry_run=true to get only the cost preflight (estimated LLM calls/tokens/wall-clock + would_exceed) without starting a run. Pass an existing run_id to continue a partial run rather than minting a new one. Not confirm-gated: leveling is a re-runnable compute trigger, not an irreversible write.',
    input: {
      request_id: z.string().uuid(),
      run_id: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe('Continue this partial run instead of starting a new one.'),
      dry_run: z.boolean().optional().describe('Return only the cost preflight; start no run.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, run_id, dry_run, asker_user_id }) => {
      const body: Record<string, unknown> = {};
      if (run_id !== undefined) body.run_id = run_id;
      if (dry_run !== undefined) body.dry_run = dry_run;
      const r = await client.request(
        'POST',
        `/requests/${request_id}/level${askerQs(asker_user_id)}`,
        body,
      );
      return r.ok ? ok(r.data) : err('leveling quotes', r.data);
    },
  });

  // ── 2. bursar_scope_gap (ADVISORY ONLY) ─────────────────────────────────────
  registerTool(server, {
    name: 'bursar_scope_gap',
    description:
      'Advisory scope-gap check on a proposed money-out subject (POST /gate/scope-gap). ADVISORY ONLY (spec 9): returns pass|advisory plus cited reason codes and records a bursar_gate_checks row. There is NO enforcement, NO bill-api preHandler, and NO blocking verdict - it never stops a charge. Use it to surface "this vendor has no award on file" or "this spend has no baseline line" as advice.',
    input: {
      request_id: z.string().uuid().nullable().optional(),
      vendor_id: z.string().uuid().nullable().optional(),
      subject_ref: z
        .string()
        .max(96)
        .nullable()
        .optional()
        .describe('A dotted reference to the money-out subject, e.g. bill.expense:<id>.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ asker_user_id, ...body }) => {
      const r = await client.request('POST', `/gate/scope-gap${askerQs(asker_user_id)}`, body);
      return r.ok ? ok(r.data) : err('running scope-gap advisory', r.data);
    },
  });

  // ── 3. bursar_vendor_view ────────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_vendor_view',
    description:
      'One vendor with its aliases, award chain, baseline, spend, findings, and orphaned-custody badge (GET /vendors/:id). Per-vendor spend and money fields are floored for a caller without bursar.spend.read_all; pass asker_user_id so the flooring is computed for the human you act for.',
    input: { id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id }) => {
      const r = await client.request('GET', `/vendors/${id}${askerQs(asker_user_id)}`);
      return r.ok ? ok(r.data) : err('viewing vendor', r.data);
    },
  });

  // ── 4. bursar_mismatches ─────────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_mismatches',
    description:
      'The post-award mismatch inbox: price_drift, scope_divergence, unbaselined_vendor, renewal_cliff, and manipulation findings (GET /mismatches). A finding\'s dollars_at_stake is a money field and is floored without bursar.spend.read_all. "Not quantified" NEVER becomes a number.',
    input: {
      status: z.string().max(32).optional(),
      detector: z.string().max(48).optional(),
      vendor_id: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ status, detector, vendor_id, cursor, limit, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/mismatches${askerQs(asker_user_id, {
          'filter[status]': status,
          'filter[detector]': detector,
          'filter[vendor_id]': vendor_id,
          cursor,
          limit: limit !== undefined ? String(limit) : undefined,
        })}`,
      );
      return r.ok ? ok(r.data) : err('listing mismatches', r.data);
    },
  });

  // ── 5. bursar_spend_by_vendor ────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_spend_by_vendor',
    description:
      'Per-vendor (and per-shadow-payee) spend rollup (GET /spend/by-vendor). The unmatched-payee buckets are the shadow-IT product: spend with no resolved vendor keeps vendor_id NULL and rolls up by normalized_payee. Every amount is floored without bursar.spend.read_all; pass asker_user_id so the intersection is computed for the human you act for.',
    input: { asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ asker_user_id }) => {
      const r = await client.request('GET', `/spend/by-vendor${askerQs(asker_user_id)}`);
      return r.ok ? ok(r.data) : err('reading spend by vendor', r.data);
    },
  });

  // ── 6. bursar_renewals_due ───────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_renewals_due',
    description:
      'The renewal radar: awards approaching their notice deadline, banded t_minus_90/60/30/7 with an auto-renew-unreviewed severity bump (GET /renewals). Filter by status.',
    input: {
      status: z.string().max(32).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ status, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/renewals${askerQs(asker_user_id, { 'filter[status]': status })}`,
      );
      return r.ok ? ok(r.data) : err('listing renewals', r.data);
    },
  });

  // ── 7. bursar_exclusion_diff ─────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_exclusion_diff',
    description:
      'The §4.7 exclusion diff for a request (GET /requests/:id/exclusion-diff): every mandatory scope node appears exactly once per offer, with its verdict and (for withheld rows) a withheld_reason. Blanket offers render "this offer claims blanket coverage; here is what it does not itemize". This is the completeness invariant - a node is never silently dropped.',
    input: { request_id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/requests/${request_id}/exclusion-diff${askerQs(asker_user_id)}`,
      );
      return r.ok ? ok(r.data) : err('reading exclusion diff', r.data);
    },
  });

  // ── 8. bursar_get_matrix (seal predicate) ────────────────────────────────────
  registerTool(server, {
    name: 'bursar_get_matrix',
    description:
      'The leveling matrix for a request (GET /requests/:id/matrix): scope nodes as rows, offers as columns, each cell a coverage verdict (covered / partial / excluded_explicit / absent / ambiguous). Passes through the shared seal predicate - a sealed offer\'s figures are withheld until its seal opens. Money fields are floored; pass asker_user_id.',
    input: { request_id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/requests/${request_id}/matrix${askerQs(asker_user_id)}`,
      );
      return r.ok ? ok(r.data) : err('reading matrix', r.data);
    },
  });

  // ── 9. bursar_get_totals (seal predicate) ────────────────────────────────────
  registerTool(server, {
    name: 'bursar_get_totals',
    description:
      'Comparable totals for a request\'s offers (GET /requests/:id/totals): stated total, gap_adjusted total (stated plus the valued cost of every absence), and the count of unvalued gaps. REFUSES to render a gap_adjusted number when it cannot value a gap - it reports the unpriced-gap count instead of inventing a figure. Passes through the seal predicate; money is floored, so pass asker_user_id.',
    input: { request_id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/requests/${request_id}/totals${askerQs(asker_user_id)}`,
      );
      return r.ok ? ok(r.data) : err('reading totals', r.data);
    },
  });

  // ── 10. bursar_list_requests ─────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_list_requests',
    description: 'List procurement requests (GET /requests). Filter by status.',
    input: {
      status: z.string().max(32).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ status, cursor, limit, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/requests${askerQs(asker_user_id, {
          'filter[status]': status,
          cursor,
          limit: limit !== undefined ? String(limit) : undefined,
        })}`,
      );
      return r.ok ? ok(r.data) : err('listing requests', r.data);
    },
  });

  // ── 11. bursar_get_request ───────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_get_request',
    description:
      'One request with its header, budget, category, and scope status (GET /requests/:id). Cited source records are can_access-filtered per reader; pass asker_user_id so the filter runs for the human you act for.',
    input: { id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id }) => {
      const r = await client.request('GET', `/requests/${id}${askerQs(asker_user_id)}`);
      return r.ok ? ok(r.data) : err('getting request', r.data);
    },
  });

  // ── 12. bursar_get_scope_tree ────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_get_scope_tree',
    description:
      'The scope tree for a request (GET /requests/:id/scope): every node with its normative_strength (mandatory / should_have / nice_to_have / informational), derived_from (request / library / rival_offer / human), review_status, and citations. Rival-derived proposals are marked and are NOT counted until a human promotes them.',
    input: { request_id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/requests/${request_id}/scope${askerQs(asker_user_id)}`,
      );
      return r.ok ? ok(r.data) : err('getting scope tree', r.data);
    },
  });

  // ── 13. bursar_upsert_scope_node (CONFIRM two-step) ─────────────────────────
  registerTool(server, {
    name: 'bursar_upsert_scope_node',
    description:
      'Create a human scope node under a request, or edit an existing node (POST /requests/:id/scope/nodes when node_id is absent; PATCH /scope-nodes/:id when present). Editing the ruler a bid is scored against is consequential, so this is a two-step confirm: call once WITHOUT confirm_token to stage a Redis-backed token, then call again WITH the returned confirm_token to execute. This tool does NOT confirm scope or promote rival nodes - those are human-only gates with no tool.',
    input: {
      request_id: z
        .string()
        .uuid()
        .optional()
        .describe('Required when creating a node (node_id absent).'),
      node_id: z
        .string()
        .uuid()
        .optional()
        .describe('When present, PATCH this node instead of creating one.'),
      title: z.string().min(1).max(512).optional(),
      description: z.string().max(4000).nullable().optional(),
      node_kind: z.string().max(32).optional(),
      normative_strength: BursarNormativeStrength.optional(),
      unit: z.string().max(32).nullable().optional(),
      quantity: z.number().nullable().optional(),
      parent_id: z.string().uuid().nullable().optional().describe('Create only.'),
      confirm_token: z
        .string()
        .optional()
        .describe('Confirmation token from a prior staging call. Required to execute the upsert.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, node_id, confirm_token, asker_user_id, ...fields }) => {
      const resourceId = node_id ?? request_id ?? 'new';
      if (!node_id && !request_id) {
        return err('upserting scope node', {
          message: 'request_id is required to create a node, or node_id to update one',
        });
      }
      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BURSAR_UPSERT_SCOPE_NODE_ACTION,
          resource_id: resourceId,
          ttlMs: BURSAR_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Scope nodes are the ruler a bid is scored against. Re-call bursar_upsert_scope_node with this confirm_token to proceed. Token expires in ${Math.floor(
            BURSAR_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BURSAR_UPSERT_SCOPE_NODE_ACTION,
          resource_id: resourceId,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (
        !pending ||
        pending.action !== BURSAR_UPSERT_SCOPE_NODE_ACTION ||
        pending.resource_id !== resourceId
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this scope-node upsert. Re-call bursar_upsert_scope_node without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (node_id) {
        const r = await client.request(
          'PATCH',
          `/scope-nodes/${node_id}${askerQs(asker_user_id)}`,
          body,
        );
        return r.ok ? ok(r.data) : err('updating scope node', r.data);
      }
      const r = await client.request(
        'POST',
        `/requests/${request_id}/scope/nodes${askerQs(asker_user_id)}`,
        body,
      );
      return r.ok ? ok(r.data) : err('creating scope node', r.data);
    },
  });

  // ── 14. bursar_list_offers ───────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_list_offers',
    description:
      'List the offers under a request (GET /requests/:id/offers) with their vendor, source format, normalization status, and seal state. Passes through the shared seal predicate; sealed offers withhold their figures. Money is floored, so pass asker_user_id.',
    input: {
      request_id: z.string().uuid(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, cursor, limit, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/requests/${request_id}/offers${askerQs(asker_user_id, {
          cursor,
          limit: limit !== undefined ? String(limit) : undefined,
        })}`,
      );
      return r.ok ? ok(r.data) : err('listing offers', r.data);
    },
  });

  // ── 15. bursar_get_coverage (seal predicate) ─────────────────────────────────
  registerTool(server, {
    name: 'bursar_get_coverage',
    description:
      'One coverage row in full (GET /coverage/:id): the verdict, the cited offer span, the matched lines, and for an `absent` verdict the rejected candidates with reasons and any overlap / withheld_reason. Passes through the seal predicate; money is floored, so pass asker_user_id.',
    input: { id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id }) => {
      const r = await client.request('GET', `/coverage/${id}${askerQs(asker_user_id)}`);
      return r.ok ? ok(r.data) : err('reading coverage', r.data);
    },
  });

  // ── 16. bursar_get_baseline ──────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_get_baseline',
    description:
      'The FROZEN baseline ledger for an award (GET /awards/:id/baseline): the immutable snapshot of what was included, knowingly excluded (excluded_at_award), and absent at award. This is the ground truth every post-award drift finding is measured against; it is read-only, with no write path. Money is floored, so pass asker_user_id.',
    input: { award_id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ award_id, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/awards/${award_id}/baseline${askerQs(asker_user_id)}`,
      );
      return r.ok ? ok(r.data) : err('reading baseline', r.data);
    },
  });

  // ── 17. bursar_list_awards ───────────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_list_awards',
    description:
      'List awards (GET /awards): active, superseded, and terminated award headers with their vendor, request, term dates, and renewal settings. Filter by status, request_id, or vendor_id. Contract money is floored, so pass asker_user_id.',
    input: {
      status: z.string().max(32).optional(),
      request_id: z.string().uuid().optional(),
      vendor_id: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ status, request_id, vendor_id, cursor, limit, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/awards${askerQs(asker_user_id, {
          'filter[status]': status,
          'filter[request_id]': request_id,
          'filter[vendor_id]': vendor_id,
          cursor,
          limit: limit !== undefined ? String(limit) : undefined,
        })}`,
      );
      return r.ok ? ok(r.data) : err('listing awards', r.data);
    },
  });

  // ── 18. bursar_resolve_vendor (read-only alias resolution) ───────────────────
  registerTool(server, {
    name: 'bursar_resolve_vendor',
    description:
      'Read-only alias resolution. With vendor_id: the confirmed payee aliases that resolve to that vendor (GET /vendors/:id/aliases) - use this to see which messy card strings map to a vendor. Without vendor_id: the pending alias-review queue (GET /vendors/alias-review), the payee strings the resolver could not confidently place. This tool NEVER writes an alias; confirming or deleting one is a human bursar.vendor.write action with no tool.',
    input: {
      vendor_id: z.string().uuid().optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ vendor_id, asker_user_id }) => {
      if (vendor_id) {
        const r = await client.request(
          'GET',
          `/vendors/${vendor_id}/aliases${askerQs(asker_user_id)}`,
        );
        return r.ok ? ok(r.data) : err('resolving vendor aliases', r.data);
      }
      const r = await client.request('GET', `/vendors/alias-review${askerQs(asker_user_id)}`);
      return r.ok ? ok(r.data) : err('reading alias review queue', r.data);
    },
  });

  // ── 19. bursar_list_leveling_runs ────────────────────────────────────────────
  registerTool(server, {
    name: 'bursar_list_leveling_runs',
    description:
      'Authoritative progress for a request\'s leveling runs (GET /requests/:id/leveling-runs): status (pending / running / partial / done / failed), how many nodes/offers were scored, and the resume cursor. Poll this after bursar_level_quotes returns a run_id.',
    input: { request_id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, asker_user_id }) => {
      const r = await client.request(
        'GET',
        `/requests/${request_id}/leveling-runs${askerQs(asker_user_id)}`,
      );
      return r.ok ? ok(r.data) : err('listing leveling runs', r.data);
    },
  });

  // ── 20. bursar_draft_clarification (CONFIRM two-step) ───────────────────────
  registerTool(server, {
    name: 'bursar_draft_clarification',
    description:
      'Draft a vendor clarification letter grounded in a request and (optionally) a specific offer (POST /drafts/clarification -> a confidential bursar_drafts row). THE DRAFT IS NEVER SENT: it lands in the owner-scoped HITL review queue and a human approves or rejects it (bursar.draft.approve, no tool). Grounding is derived server-side by buildDraftGrounding(offer_id, request_id) - you cannot supply arbitrary grounding text, only a request/offer to ground on and a human intent prompt. Two-step confirm because generating grounds confidential offer content: call once WITHOUT confirm_token to stage a token, then again WITH it to execute.',
    input: {
      request_id: z.string().uuid(),
      offer_id: z.string().uuid().nullable().optional(),
      vendor_id: z.string().uuid().nullable().optional(),
      award_id: z.string().uuid().nullable().optional(),
      mismatch_id: z.string().uuid().nullable().optional(),
      title: z.string().max(512).nullable().optional(),
      prompt: z
        .string()
        .max(4000)
        .nullable()
        .optional()
        .describe('The human intent the draft is built around; NEVER the grounding itself.'),
      confirm_token: z
        .string()
        .optional()
        .describe('Confirmation token from a prior staging call. Required to execute the draft.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ confirm_token, asker_user_id, ...body }) => {
      const resourceId = body.request_id;
      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BURSAR_DRAFT_CLARIFICATION_ACTION,
          resource_id: resourceId,
          ttlMs: BURSAR_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Drafting grounds confidential offer content into a clarification letter (it is queued for human review, never sent). Re-call bursar_draft_clarification with this confirm_token to proceed. Token expires in ${Math.floor(
            BURSAR_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BURSAR_DRAFT_CLARIFICATION_ACTION,
          resource_id: resourceId,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (
        !pending ||
        pending.action !== BURSAR_DRAFT_CLARIFICATION_ACTION ||
        pending.resource_id !== resourceId
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this draft. Re-call bursar_draft_clarification without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      const r = await client.request(
        'POST',
        `/drafts/clarification${askerQs(asker_user_id)}`,
        body,
      );
      return r.ok ? ok(r.data) : err('drafting clarification', r.data);
    },
  });
}
