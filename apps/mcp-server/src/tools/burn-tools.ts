import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  BurnAttributionState,
  BurnEngagementKind,
  BurnEnvelopeBasis,
  BurnGateMode,
  BurnNonBillableReason,
  BurnUnscopedBucket,
  BurnUnscopedReason,
  BurnWorkRefType,
} from '@bigbluebam/shared';
import type { ApiClient } from '../middleware/api-client.js';
import type { ConfirmTokenStore } from '../lib/confirm-token-store.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Burn MCP tools (Milestone M5 - AI margin / envelope-attribution monitor).
 *
 * 17 tools plus one deprecated alias, backing the burn-api REST surface at
 * /burn/api/v1/* (spec section 11.1 of
 * docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md). The HTTP client is shaped like
 * bulwark-tools.ts / dedupe-tools.ts: it forwards the caller's bearer token so burn-api
 * applies the same per-viewer visibility and requireCan gating the human UI does.
 * BURN_API_URL already ends in /v1 (see env.ts), so paths here are sent WITHOUT a /v1 prefix.
 *
 * ── THE TWO THINGS THAT ARE NOT LIKE THE OTHER APPS ────────────────────────────────────
 *
 * 1. `asker_user_id` NARROWS TWO SEPARATE THINGS on Burn, not one. On every other satellite
 *    it narrows row visibility. On Burn it ALSO narrows FINANCIAL FLOORING: burn-api takes
 *    the INTERSECTION of the bearer's and the asker's capabilities
 *    (apps/burn-api/src/lib/viewer-caps.ts). Without that, an admin service-account bearer
 *    acting for a plain member would return fully unfloored `cost_amount`, and for a single
 *    bam.time_entry row `cost_amount / (minutes / 60)` IS that person's hourly cost rate to
 *    the cent. So pass `asker_user_id` on every tool that surfaces money.
 *
 *    mcp-server cannot backstop this itself: register-tool.ts reads BBB_PERMISSIONS_ENFORCE
 *    from mcp-server's OWN env (compose default 'warn'), so its per-action check never
 *    denies and its resolver returns 'unknown' as pass-through on failure. burn-api is the
 *    only layer that can enforce it, and it does.
 *
 * 2. ENVELOPE CONFIRMATION IS NOT AGENT-REACHABLE AT ALL (spec 2.2.1). There is deliberately
 *    NO tool for POST /v1/deliverables/:id/confirm-envelope or /bulk-confirm-unpriced, and
 *    `burn_confirm_deliverable` maps to the PATCH route, which cannot set `envelope_amount`
 *    or `is_active`. A service-account token hitting the confirm route directly gets an
 *    agent_proposals row, not a write. That is a security boundary, not an oversight; do not
 *    "complete the surface" by adding one.
 *
 * Following the basis/braid/bulwark satellite pattern, burn_* tools are intentionally NOT
 * added to EXPLICIT_TOOL_OVERRIDES; the burn.* allowlist gating is automatic via
 * register-tool's PolicyGate (matchesAllowlist('burn.*')). The glob is not a hardcoded list
 * in code - it is data stored per-agent in agent_policies.allowed_tools. Because every tool
 * here is named burn_<verb>_<noun>, an operator allowlisting 'burn.*' gates them all, and
 * they FAIL CLOSED until that happens (burn.* is not always-permitted).
 */

/** HTTP client for the burn-api service (mirrors createBulwarkClient). */
function createBurnClient(burnApiUrl: string, api: ApiClient) {
  const baseUrl = burnApiUrl.replace(/\/$/, '');
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

/** Append ?asker_user_id when present so burn-api narrows BOTH rows and flooring. */
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
    'The human on whose behalf the agent is asking. Narrows BOTH row visibility (can_access, fail-closed) AND financial flooring: burn-api takes the intersection of the bearer and asker capabilities, so an admin service-account acting for a member receives no cost figures.',
  );

// Confirm-token TTL. 5 min is the human-approver window CLAUDE.md documents. Every Burn
// confirm boundary is human-reviewed, so all of them take the human TTL.
const BURN_CONFIRM_TTL_MS = 300_000;
const BURN_DELETE_ENGAGEMENT_ACTION = 'burn_delete_engagement';
const BURN_REJECT_DELIVERABLE_ACTION = 'burn_reject_deliverable';
const BURN_SET_GATE_MODE_ACTION = 'burn_set_gate_mode';

/**
 * The gate-weakening directions (spec 2.5, 5.6).
 *
 * A confirm token is required when the TARGET WEAKENS ENFORCEMENT, which is the opposite of
 * the usual instinct. Turning the spend control ON is recoverable in one click; turning it
 * off, dropping it to advisory, or pausing it is how a firm silently stops noticing that it
 * is over-delivering, and nobody notices for a quarter. So `off`, `advisory`, and any
 * `gate_paused_until` all require the two-step, and promoting to `blocking` does not.
 */
function weakensEnforcement(args: {
  gate_mode?: string;
  gate_paused_until?: string | null;
}): boolean {
  if (args.gate_mode === 'off' || args.gate_mode === 'advisory') return true;
  if (args.gate_paused_until) return true;
  return false;
}

export function registerBurnTools(
  server: McpServer,
  api: ApiClient,
  burnApiUrl: string,
  confirmTokenStore: ConfirmTokenStore,
): void {
  const client = createBurnClient(burnApiUrl, api);

  // ── 1. burn_precheck (THE FLAGSHIP) ───────────────────────────────────────
  registerTool(server, {
    name: 'burn_precheck',
    description:
      'Ask whether a proposed charge is allowable against its engagement envelope BEFORE it is committed (POST /precheck). Returns a verdict (allow / allow_with_note / needs_mapping / deny), the target deliverable, a clause cite, and a QUANTIZED overage. Only `deny` blocks, and only when the org has earned blocking mode for this class; `needs_mapping` never blocks. The synchronous path is deterministic-only and issues no model calls. The overage is rounded up to the org bucket and the deny boundary itself is evaluated against a bucket-aligned figure, so repeated probing cannot recover the exact envelope. A per-user daily cap and a per-deliverable probe cap both apply.',
    input: {
      work_ref_type: BurnWorkRefType.describe('The class of money commitment being prechecked'),
      work_ref_id: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe('The source record, when it already exists. Null on a true pre-commit check.'),
      project_id: z.string().uuid().nullable().optional(),
      proposed_amount: z.number().int().describe('Minor units (cents)'),
      currency: z.string().length(3),
      title: z.string().max(512).nullable().optional(),
      description: z.string().max(4000).nullable().optional(),
      occurred_at: z.string().nullable().optional(),
      attempt_nonce: z
        .string()
        .max(64)
        .nullable()
        .optional()
        .describe('Distinguishes deliberate retries. The idempotency key is server-derived; a caller-supplied key is rejected.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ asker_user_id, ...body }) => {
      const r = await client.request('POST', `/precheck${askerQs(asker_user_id)}`, body);
      return r.ok ? ok(r.data) : err('running precheck', r.data);
    },
  });

  // ── 2. burn_attribute ─────────────────────────────────────────────────────
  registerTool(server, {
    name: 'burn_attribute',
    description:
      'Attribute one work item to a deliverable, or mark it unscoped / non-billable (POST /attributions). Use the single-item form rather than a bulk call so each decision is individually auditable.',
    input: {
      work_item_id: z.string().uuid(),
      deliverable_id: z.string().uuid().nullable(),
      state: BurnAttributionState,
      non_billable_reason: BurnNonBillableReason.nullable().optional(),
      rationale: z.string().max(2000).nullable().optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ asker_user_id, ...body }) => {
      const r = await client.request('POST', `/attributions${askerQs(asker_user_id)}`, body);
      return r.ok ? ok(r.data) : err('attributing work item', r.data);
    },
  });

  // ── 3. burn_financials ────────────────────────────────────────────────────
  registerTool(server, {
    name: 'burn_financials',
    description:
      'Financial figures for one engagement chain, or the firm-wide account roll-up with all_accounts=true (GET /financials, /financials/accounts). THE RESPONSE IS A DISCRIMINATED UNION on metric_basis and you MUST read that discriminator before reading any number. Under `true_margin` the figures are margin. Under `contract_consumption` there is NO margin key at all -- the number is how much of the contract value has been consumed, which is a different quantity, and reporting it as margin is wrong. Under `suppressed` the caller lacks burn.financials.read_all or the chain is below the contributor floor, and only contract_consumption_pct is present.',
    input: {
      engagement_id: z
        .string()
        .uuid()
        .optional()
        .describe('The chain to report on. Omit only when all_accounts is true.'),
      all_accounts: z
        .boolean()
        .optional()
        .describe('Firm-wide roll-up. Requires burn.financials.read_all plus an owner/admin org role.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ engagement_id, all_accounts, asker_user_id }) => {
      if (all_accounts) {
        const r = await client.request('GET', `/financials/accounts${askerQs(asker_user_id)}`);
        return r.ok ? ok(r.data) : err('reading account financials', r.data);
      }
      if (!engagement_id) {
        return err('reading financials', {
          message: 'engagement_id is required unless all_accounts is true',
        });
      }
      const r = await client.request(
        'GET',
        `/financials${askerQs(asker_user_id, { engagement_id })}`,
      );
      return r.ok ? ok(r.data) : err('reading financials', r.data);
    },
  });

  // ── 3b. burn_margin (DEPRECATED ALIAS) ────────────────────────────────────
  //
  // Kept only so an agent that learned the old name still works. It returns the IDENTICAL
  // discriminated response -- in particular it does NOT synthesize a `margin` key when the
  // basis is contract_consumption, which is exactly the mislabeling that motivated the
  // rename. The tool name is a claim about what the number means, and this one's claim is
  // wrong whenever cost-rate coverage is incomplete.
  registerTool(server, {
    name: 'burn_margin',
    description:
      'DEPRECATED alias for burn_financials; use that instead. Returns the identical discriminated response. Note that despite the name, when metric_basis is `contract_consumption` the response carries NO margin key: the figure is contract consumption, not margin.',
    input: {
      engagement_id: z.string().uuid().optional(),
      all_accounts: z.boolean().optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ engagement_id, all_accounts, asker_user_id }) => {
      if (all_accounts) {
        const r = await client.request('GET', `/financials/accounts${askerQs(asker_user_id)}`);
        return r.ok ? ok(r.data) : err('reading account financials', r.data);
      }
      if (!engagement_id) {
        return err('reading financials', {
          message: 'engagement_id is required unless all_accounts is true',
        });
      }
      const r = await client.request(
        'GET',
        `/financials${askerQs(asker_user_id, { engagement_id })}`,
      );
      return r.ok ? ok(r.data) : err('reading financials', r.data);
    },
  });

  // ── 4. burn_list_engagements ──────────────────────────────────────────────
  registerTool(server, {
    name: 'burn_list_engagements',
    description:
      'List engagement chains (GET /engagements). Project-scoped: a chain linked to no project is visible only to a burn.financials.read_all holder. Contract values are floored for anyone else.',
    input: {
      status: z.string().max(32).optional(),
      account_id: z.string().uuid().optional(),
      chain_root_id: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ status, account_id, chain_root_id, cursor, limit }) => {
      const params = new URLSearchParams();
      if (status) params.set('filter[status]', status);
      if (account_id) params.set('filter[account_id]', account_id);
      if (chain_root_id) params.set('filter[chain_root_id]', chain_root_id);
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const r = await client.request('GET', `/engagements${qs ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing engagements', r.data);
    },
  });

  // ── 5. burn_get_engagement ────────────────────────────────────────────────
  registerTool(server, {
    name: 'burn_get_engagement',
    description:
      'Fetch one engagement chain with its rollup (GET /engagements/:id). Cited source records are can_access-filtered PER READER, so a document the registrant could open is still dropped for a reader who cannot, and the response reports how many were hidden.',
    input: { id: z.string().uuid(), asker_user_id: askerInput },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id }) => {
      const r = await client.request('GET', `/engagements/${id}${askerQs(asker_user_id)}`);
      return r.ok ? ok(r.data) : err('getting engagement', r.data);
    },
  });

  // ── 6. burn_extract_deliverables ──────────────────────────────────────────
  registerTool(server, {
    name: 'burn_extract_deliverables',
    description:
      'Register an engagement document and extract its deliverables, or re-run extraction on an existing chain. Provide EITHER engagement_id (re-extract via POST /engagements/:id/extract) OR the new-engagement fields including title (create via POST /engagements, which can_access-preflights the Bin asset). Extraction is async. NOTE: extracted deliverables land as pending_review with NO envelope; pricing them is a human-only step (see burn_confirm_deliverable).',
    input: {
      engagement_id: z
        .string()
        .uuid()
        .optional()
        .describe('Existing chain to re-extract. Mutually exclusive with the create fields.'),
      title: z.string().min(1).max(512).optional(),
      engagement_kind: BurnEngagementKind.optional(),
      envelope_basis: BurnEnvelopeBasis.optional(),
      contract_value: z.number().int().nullable().optional().describe('Minor units'),
      currency: z.string().length(3).optional(),
      period_length_days: z.number().int().positive().nullable().optional(),
      bin_asset_id: z.string().uuid().nullable().optional(),
      account_type: z.string().max(32).nullable().optional(),
      account_id: z.string().uuid().nullable().optional(),
      bill_client_id: z.string().uuid().nullable().optional(),
      amends_engagement_id: z.string().uuid().nullable().optional(),
      start_date: z.string().nullable().optional(),
      end_date: z.string().nullable().optional(),
      timezone: z.string().max(64).optional(),
      project_ids: z.array(z.string().uuid()).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ engagement_id, asker_user_id, ...create }) => {
      if (engagement_id) {
        const r = await client.request(
          'POST',
          `/engagements/${engagement_id}/extract${askerQs(asker_user_id)}`,
        );
        return r.ok ? ok(r.data) : err('re-extracting deliverables', r.data);
      }
      if (!create.title) {
        return err('extracting deliverables', {
          message: 'title is required when creating a new engagement',
        });
      }
      const r = await client.request('POST', `/engagements${askerQs(asker_user_id)}`, {
        ...create,
        project_ids: create.project_ids ?? [],
      });
      return r.ok ? ok(r.data) : err('creating engagement', r.data);
    },
  });

  // ── 7. burn_delete_engagement (destructive; confirm two-step) ─────────────
  registerTool(server, {
    name: 'burn_delete_engagement',
    description:
      'Delete an engagement and its deliverables (destructive). Refused when the row is a chain root with live amendments, because deleting it would detach their consumption from every rollup. Two-step confirm: call once WITHOUT confirm_token to stage a Redis-backed token, then call again WITH the returned confirm_token to execute.',
    input: {
      id: z.string().uuid(),
      confirm_token: z
        .string()
        .optional()
        .describe('Confirmation token from a prior staging call. Required to execute the delete.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, confirm_token }) => {
      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BURN_DELETE_ENGAGEMENT_ACTION,
          resource_id: id,
          ttlMs: BURN_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Deleting an engagement removes its deliverables and detaches its consumption from every rollup. Re-call burn_delete_engagement with this confirm_token to proceed. Token expires in ${Math.floor(
            BURN_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BURN_DELETE_ENGAGEMENT_ACTION,
          resource_id: id,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (
        !pending ||
        pending.action !== BURN_DELETE_ENGAGEMENT_ACTION ||
        pending.resource_id !== id
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this delete. Re-call burn_delete_engagement without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      const r = await client.request('DELETE', `/engagements/${id}`);
      return r.ok ? ok(r.data) : err('deleting engagement', r.data);
    },
  });

  // ── 8. burn_list_deliverables ─────────────────────────────────────────────
  registerTool(server, {
    name: 'burn_list_deliverables',
    description:
      'List deliverables / the extraction review queue (GET /deliverables). `description` and the cited clause quote are floored to burn.financials.read_all, and for a caller without it the `q` filter matches TITLE ONLY -- the full-text index covers the floored clause text, so searching it would be a way to read what the response withholds.',
    input: {
      engagement_id: z.string().uuid().optional(),
      review_status: z.string().max(32).optional(),
      lifecycle_status: z.string().max(32).optional(),
      q: z.string().max(200).optional().describe('Matches title only unless the caller holds burn.financials.read_all'),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ engagement_id, review_status, lifecycle_status, q, cursor, limit, asker_user_id }) => {
      const params = new URLSearchParams();
      if (asker_user_id) params.set('asker_user_id', asker_user_id);
      if (engagement_id) params.set('filter[engagement_id]', engagement_id);
      if (review_status) params.set('filter[review_status]', review_status);
      if (lifecycle_status) params.set('filter[lifecycle_status]', lifecycle_status);
      if (q) params.set('filter[q]', q);
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const r = await client.request('GET', `/deliverables${qs ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing deliverables', r.data);
    },
  });

  // ── 9. burn_confirm_deliverable ───────────────────────────────────────────
  registerTool(server, {
    name: 'burn_confirm_deliverable',
    description:
      'Confirm or edit an extracted deliverable: title, description, kind, due date, review_status, lifecycle_status (PATCH /deliverables/:id). IT CANNOT SET THE ENVELOPE OR ACTIVATE THE DELIVERABLE. Pricing an envelope and flipping is_active are human-only and are not agent-reachable by any path; a service-account attempt on the confirm-envelope route produces an approval-queue proposal instead of a write.',
    input: {
      id: z.string().uuid(),
      title: z.string().min(1).max(512).optional(),
      description: z.string().max(20000).nullable().optional(),
      due_date: z.string().nullable().optional(),
      review_status: z.enum(['pending_review', 'confirmed', 'superseded']).optional(),
      lifecycle_status: z.enum(['open', 'complete', 'closed']).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id, ...patch }) => {
      const body = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      );
      const r = await client.request(
        'PATCH',
        `/deliverables/${id}${askerQs(asker_user_id)}`,
        body,
      );
      return r.ok ? ok(r.data) : err('confirming deliverable', r.data);
    },
  });

  // ── 10. burn_reject_deliverable (destructive; confirm two-step) ───────────
  registerTool(server, {
    name: 'burn_reject_deliverable',
    description:
      'Reject an extracted deliverable (PATCH /deliverables/:id with review_status=rejected; destructive - it stops being a valid attribution target and any envelope it carried stops constraining charges). Two-step confirm: call once WITHOUT confirm_token to stage a token, then again WITH it to execute.',
    input: {
      id: z.string().uuid(),
      confirm_token: z.string().optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, confirm_token, asker_user_id }) => {
      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BURN_REJECT_DELIVERABLE_ACTION,
          resource_id: id,
          ttlMs: BURN_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Rejecting a deliverable removes it as an attribution target and stops its envelope constraining any charge. Re-call burn_reject_deliverable with this confirm_token to proceed. Token expires in ${Math.floor(
            BURN_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BURN_REJECT_DELIVERABLE_ACTION,
          resource_id: id,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (
        !pending ||
        pending.action !== BURN_REJECT_DELIVERABLE_ACTION ||
        pending.resource_id !== id
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this reject. Re-call burn_reject_deliverable without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      const r = await client.request(
        'PATCH',
        `/deliverables/${id}${askerQs(asker_user_id)}`,
        { review_status: 'rejected' },
      );
      return r.ok ? ok(r.data) : err('rejecting deliverable', r.data);
    },
  });

  // ── 11. burn_list_unscoped ────────────────────────────────────────────────
  registerTool(server, {
    name: 'burn_list_unscoped',
    description:
      'The unscoped-work queue (GET /unscoped). THREE BUCKETS THAT ARE NEVER SUMMED: `sold_by_nobody` is work inside a tracked contract that no deliverable covers; `unclassified` is work the classifier could not place; `outside_contract` is work on a project with no active engagement. They are opposite problems with opposite remedies, so do not add them together or present one total. Amounts are floored without burn.financials.read_all, and cited source records are can_access-filtered per reader with a hidden count.',
    input: {
      bucket: BurnUnscopedBucket.optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ bucket, cursor, limit, asker_user_id }) => {
      const params = new URLSearchParams();
      if (asker_user_id) params.set('asker_user_id', asker_user_id);
      if (bucket) params.set('filter[bucket]', bucket);
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const r = await client.request('GET', `/unscoped${qs ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing unscoped work', r.data);
    },
  });

  // ── 12. burn_reclassify_attribution ───────────────────────────────────────
  registerTool(server, {
    name: 'burn_reclassify_attribution',
    description:
      'Re-decide an existing attribution: move it to a different deliverable, unscope it, or mark it non-billable (PATCH /attributions/:id). Supersede-then-insert, so the previous decision is retained as history. Returns 409 with the current state if the row changed since you read it.',
    input: {
      id: z.string().uuid(),
      deliverable_id: z.string().uuid().nullable().optional(),
      state: BurnAttributionState.optional(),
      unscoped_reason: BurnUnscopedReason.nullable().optional(),
      non_billable_reason: BurnNonBillableReason.nullable().optional(),
      rationale: z.string().max(2000).nullable().optional(),
      updated_at: z
        .string()
        .optional()
        .describe('The updated_at you last read. Supplying it turns a concurrent edit into a 409 instead of a silent overwrite.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id, ...patch }) => {
      const body = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      );
      const r = await client.request(
        'PATCH',
        `/attributions/${id}${askerQs(asker_user_id)}`,
        body,
      );
      return r.ok ? ok(r.data) : err('reclassifying attribution', r.data);
    },
  });

  // ── 13. burn_override_precheck ────────────────────────────────────────────
  registerTool(server, {
    name: 'burn_override_precheck',
    description:
      'Override a precheck verdict with a typed code and a written reason (POST /prechecks/:id/override). Valid codes are absorbed_cost, mapped_manually, and change_order_pending. IT CANNOT SET gate_wrong: that label drives automatic demotion of the whole gate and is owner/admin human-only, set through a different route.',
    input: {
      id: z.string().uuid(),
      override_reason_code: z.enum(['absorbed_cost', 'mapped_manually', 'change_order_pending']),
      override_reason_text: z
        .string()
        .min(1)
        .max(2000)
        .describe('Free text. The org configures a minimum length; short reasons are rejected.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id, ...body }) => {
      const r = await client.request(
        'POST',
        `/prechecks/${id}/override${askerQs(asker_user_id)}`,
        body,
      );
      return r.ok ? ok(r.data) : err('overriding precheck', r.data);
    },
  });

  // ── 14. burn_list_variances ───────────────────────────────────────────────
  registerTool(server, {
    name: 'burn_list_variances',
    description:
      'The variance inbox (GET /variances): envelope overruns, unscoped work, silent deliverables, ungated charges, gate outages, and rule overreach. Amounts and every money key nested in the detail object are floored without burn.financials.read_all.',
    input: {
      status: z.string().max(32).optional(),
      kind: z.string().max(48).optional(),
      engagement_id: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ status, kind, engagement_id, cursor, limit }) => {
      const params = new URLSearchParams();
      if (status) params.set('filter[status]', status);
      if (kind) params.set('filter[kind]', kind);
      if (engagement_id) params.set('filter[engagement_id]', engagement_id);
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const r = await client.request('GET', `/variances${qs ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing variances', r.data);
    },
  });

  // ── 15. burn_draft_change_order ───────────────────────────────────────────
  registerTool(server, {
    name: 'burn_draft_change_order',
    description:
      'Draft a change order against an engagement, optionally resolving a variance (POST /change-orders). THE DRAFT IS NEVER SENT: it becomes a pending row in the human approval queue, and that queue IS the confirmation step, which is why this tool takes no confirm_token. On approval it creates the amendment engagement and deliverable, which raises the base deliverable effective envelope so the next precheck allows the charge that was blocked.',
    input: {
      engagement_id: z.string().uuid(),
      deliverable_id: z.string().uuid().nullable().optional(),
      variance_id: z.string().uuid().nullable().optional(),
      note: z.string().max(4000).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ asker_user_id, ...body }) => {
      const r = await client.request('POST', `/change-orders${askerQs(asker_user_id)}`, body);
      return r.ok ? ok(r.data) : err('drafting change order', r.data);
    },
  });

  // ── 16. burn_set_gate_mode (confirm WHEN IT WEAKENS ENFORCEMENT) ─────────
  registerTool(server, {
    name: 'burn_set_gate_mode',
    description:
      'Change the spend-gate mode or pause it (PATCH /settings). A CONFIRM TOKEN IS REQUIRED WHEN THE TARGET WEAKENS ENFORCEMENT -- setting `off`, dropping to `advisory`, or setting gate_paused_until -- because switching the control off is the consequential direction and is how a firm stops noticing it is over-delivering. Promoting to `blocking` needs no token, but it is rejected server-side unless all seven calibration preconditions hold, including an explicit acknowledgement that is deliberately not agent-suppliable.',
    input: {
      gate_mode: BurnGateMode.optional(),
      gate_paused_until: z
        .string()
        .nullable()
        .optional()
        .describe('ISO timestamp. Setting it pauses enforcement and requires a confirm token.'),
      gate_enabled_refs: z
        .array(BurnWorkRefType)
        .optional()
        .describe('Which classes enforce. Task-phase and assignment classes are advisory forever and are rejected here.'),
      confirm_token: z.string().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ gate_mode, gate_paused_until, gate_enabled_refs, confirm_token }) => {
      const body = Object.fromEntries(
        Object.entries({ gate_mode, gate_paused_until, gate_enabled_refs }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      const weakening = weakensEnforcement({ gate_mode, gate_paused_until });
      const resourceId = gate_mode ?? (gate_paused_until ? 'paused' : 'settings');

      if (weakening && !confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BURN_SET_GATE_MODE_ACTION,
          resource_id: resourceId,
          ttlMs: BURN_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `This change WEAKENS the spend gate. Charges that would be blocked will post instead. Re-call burn_set_gate_mode with this confirm_token to proceed. Token expires in ${Math.floor(
            BURN_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BURN_SET_GATE_MODE_ACTION,
          resource_id: resourceId,
          confirm_token: token,
        });
      }
      if (weakening && confirm_token) {
        const pending = await confirmTokenStore.get(confirm_token);
        if (
          !pending ||
          pending.action !== BURN_SET_GATE_MODE_ACTION ||
          pending.resource_id !== resourceId
        ) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Invalid or expired confirm_token for this gate change. Re-call burn_set_gate_mode without a token to stage a new one.',
              },
            ],
            isError: true,
          };
        }
        await confirmTokenStore.delete(confirm_token);
      }
      const r = await client.request('PATCH', '/settings', body);
      return r.ok ? ok(r.data) : err('setting gate mode', r.data);
    },
  });

  // ── 17. burn_calibration_report ───────────────────────────────────────────
  registerTool(server, {
    name: 'burn_calibration_report',
    description:
      'Standing against all seven preconditions for promoting the gate from advisory to blocking, plus gate coverage over the trailing 7 days (GET /calibration). Each unmet precondition names its own shortfall. Advisory is a complete product: an org with no promotion path still gets the queue, the variance inbox, change-order drafts, and the financial figures.',
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.request('GET', '/calibration');
      return r.ok ? ok(r.data) : err('reading calibration report', r.data);
    },
  });
}
