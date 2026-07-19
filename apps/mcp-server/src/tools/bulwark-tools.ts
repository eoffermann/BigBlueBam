import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  BulwarkContractKind,
  BulwarkContractStatus,
  BulwarkObligationType,
  BulwarkReviewStatus,
  BulwarkDeadlineStatus,
  BulwarkComplianceDocType,
  BulwarkValidityStatus,
  bulwarkEventBindingSchema,
  bulwarkDeadlineRuleSchema,
} from '@bigbluebam/shared';
import type { ApiClient } from '../middleware/api-client.js';
import type { ConfirmTokenStore } from '../lib/confirm-token-store.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Bulwark MCP tools (Milestone M5 - AI contract-obligation monitor).
 *
 * 16 tools backing the bulwark-api REST surface at /bulwark/api/v1/* (spec
 * section 10 of docs/brainstorming/2026_07_19_03_00_APP_DESIGN_bulwark.md). The
 * HTTP client is shaped like braid-tools.ts / dedupe-tools.ts: it forwards the
 * caller's bearer token so bulwark-api applies the same per-viewer visibility
 * and requireCan gating the human UI does. BULWARK_API_URL already ends in /v1
 * (see env.ts), so paths here are sent WITHOUT a /v1 prefix.
 *
 * Reads that surface source-scoped records and writes that mutate them take an
 * explicit asker_user_id (per docs/reference/agent-conventions.md) and forward
 * it as ?asker_user_id=<uuid> so bulwark-api's readViewer narrows visibility
 * fail-closed (a bogus asker resolves nothing). The four state-change confirm
 * tools (bulwark_delete_contract / bulwark_reject_obligation /
 * bulwark_waive_deadline / bulwark_discard_notice) use the Redis-backed
 * confirm-token store two-step flow, mirroring braid_merge_profiles /
 * braid_split_profile exactly.
 *
 * Following the basis/braid satellite pattern, bulwark_* tools are intentionally
 * NOT added to EXPLICIT_TOOL_OVERRIDES; the bulwark.* allowlist gating is
 * automatic via register-tool's PolicyGate (matchesAllowlist('bulwark.*')). The
 * glob is not a hardcoded list in code - it is data stored per-agent in
 * agent_policies.allowed_tools; because every tool here is named
 * bulwark_<verb>_<noun>, an operator allowlisting 'bulwark.*' gates them all,
 * and they fail closed until that happens (bulwark.* is not always-permitted).
 */

/** HTTP client for the bulwark-api service (mirrors createBraidClient). */
function createBulwarkClient(bulwarkApiUrl: string, api: ApiClient) {
  const baseUrl = bulwarkApiUrl.replace(/\/$/, '');
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
function unwrap(payload: unknown): unknown {
  return payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)
    ? (payload as { data: unknown }).data
    : payload;
}

/** Append ?asker_user_id when present so bulwark-api's readViewer can narrow. */
function askerQs(asker_user_id?: string): string {
  return asker_user_id ? `?asker_user_id=${encodeURIComponent(asker_user_id)}` : '';
}

const askerInput = z
  .string()
  .uuid()
  .optional()
  .describe('The human on whose behalf the agent is asking; forwarded to gate can_access fail-closed');

// Destructive confirm-token TTL. 5 min is the human-approver window CLAUDE.md documents for
// delete-task / complete-sprint. All three Bulwark destructive tools are human-reviewed, so
// they get the human TTL from the Redis-backed store.
const BULWARK_CONFIRM_TTL_MS = 300_000;
const BULWARK_DELETE_CONTRACT_ACTION = 'bulwark_delete_contract';
const BULWARK_REJECT_OBLIGATION_ACTION = 'bulwark_reject_obligation';
const BULWARK_WAIVE_DEADLINE_ACTION = 'bulwark_waive_deadline';
const BULWARK_DISCARD_NOTICE_ACTION = 'bulwark_discard_notice';

export function registerBulwarkTools(
  server: McpServer,
  api: ApiClient,
  bulwarkApiUrl: string,
  confirmTokenStore: ConfirmTokenStore,
): void {
  const client = createBulwarkClient(bulwarkApiUrl, api);

  // ── bulwark_extract_obligations (the flagship) ────────────────────────────
  registerTool(server, {
    name: 'bulwark_extract_obligations',
    description:
      'Register a contract document and extract its clause-cited obligation ledger, or re-run extraction on an existing contract. Provide EITHER contract_id (re-extract an existing contract via POST /contracts/:id/extract) OR the new-contract fields including bin_asset_id + title (create via POST /contracts, which can_access-preflights the Bin asset and auto-enqueues extraction). Extraction is async; poll bulwark_get_contract for extraction_status and the obligations rollup. The flagship Bulwark operation.',
    input: {
      contract_id: z
        .string()
        .uuid()
        .optional()
        .describe('Existing contract to re-extract. Mutually exclusive with the create fields.'),
      bin_asset_id: z
        .string()
        .uuid()
        .optional()
        .describe('The executed document in Bin. Required (with title) when creating a new contract.'),
      title: z.string().min(1).max(512).optional(),
      contract_kind: BulwarkContractKind.optional(),
      project_id: z.string().uuid().nullable().optional(),
      supersedes_contract_id: z.string().uuid().nullable().optional(),
      timezone: z.string().min(1).max(64).optional(),
      jurisdiction: z.string().max(32).nullable().optional(),
      counterparty_type: z.string().max(32).nullable().optional(),
      counterparty_id: z.string().uuid().nullable().optional(),
      effective_date: z.string().nullable().optional(),
      expiry_date: z.string().nullable().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ contract_id, bin_asset_id, ...rest }) => {
      const byExisting = !!contract_id;
      const byCreate = !!bin_asset_id && !!rest.title;
      if (byExisting === byCreate) {
        return err('validating extract input', {
          message:
            'Provide exactly one of contract_id (re-extract) OR bin_asset_id + title (create a new contract).',
        });
      }
      if (byExisting) {
        const r = await client.request('POST', `/contracts/${contract_id}/extract`);
        return r.ok ? ok(r.data) : err('re-extracting obligations', r.data);
      }
      const body: Record<string, unknown> = { bin_asset_id };
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
      const r = await client.request('POST', '/contracts', body);
      return r.ok ? ok(r.data) : err('extracting obligations', r.data);
    },
  });

  // ── bulwark_check_notice_risk (the flagship read) ─────────────────────────
  registerTool(server, {
    name: 'bulwark_check_notice_risk',
    description:
      'Assess notice / waiver-risk exposure for a job (project) or contract: fans out to GET /deadlines and GET /waiver-risks, returning open deadlines with due dates plus detected waiver risks (clock_running_out, overdue, unbound_obligation, missing_compliance_doc). Pass asker_user_id so bulwark-api narrows both lists to what that human may see (fail-closed). The notice_draft body is only present for bulwark.notice.draft holders.',
    input: {
      project_id: z.string().uuid().optional(),
      contract_id: z.string().uuid().optional(),
      status: BulwarkDeadlineStatus.optional().describe('Deadline status filter (e.g. open, missed).'),
      due_before: z.string().optional().describe('ISO timestamp; only deadlines due before this.'),
      limit: z.number().int().min(1).max(100).optional(),
      asker_user_id: askerInput,
    },
    returns: z.object({ deadlines: z.unknown(), waiver_risks: z.unknown() }).passthrough(),
    handler: async ({ project_id, contract_id, status, due_before, limit, asker_user_id }) => {
      const dq = new URLSearchParams();
      const wq = new URLSearchParams();
      if (asker_user_id) {
        dq.set('asker_user_id', asker_user_id);
        wq.set('asker_user_id', asker_user_id);
      }
      if (project_id) dq.set('filter[project_id]', project_id);
      if (contract_id) {
        dq.set('filter[contract_id]', contract_id);
        wq.set('filter[contract_id]', contract_id);
      }
      if (status) dq.set('filter[status]', status);
      if (due_before) dq.set('filter[due_before]', due_before);
      if (limit !== undefined) {
        dq.set('limit', String(limit));
        wq.set('limit', String(limit));
      }
      const [deadlines, waivers] = await Promise.all([
        client.request('GET', `/deadlines${dq.toString() ? `?${dq}` : ''}`),
        client.request('GET', `/waiver-risks${wq.toString() ? `?${wq}` : ''}`),
      ]);
      if (!deadlines.ok) return err('checking notice risk (deadlines)', deadlines.data);
      if (!waivers.ok) return err('checking notice risk (waiver-risks)', waivers.data);
      return ok({
        deadlines: unwrap(deadlines.data),
        waiver_risks: unwrap(waivers.data),
      });
    },
  });

  // ── bulwark_list_contracts ────────────────────────────────────────────────
  registerTool(server, {
    name: 'bulwark_list_contracts',
    description:
      'List contracts for the org (project-scoped to what the caller may act on). Filter by status and project_id; cursor-paginated.',
    input: {
      status: BulwarkContractStatus.optional(),
      project_id: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ status, project_id, cursor, limit }) => {
      const qs = new URLSearchParams();
      if (status) qs.set('filter[status]', status);
      if (project_id) qs.set('filter[project_id]', project_id);
      if (cursor) qs.set('cursor', cursor);
      if (limit !== undefined) qs.set('limit', String(limit));
      const r = await client.request('GET', `/contracts${qs.toString() ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing contracts', r.data);
    },
  });

  // ── bulwark_get_contract (embeds obligations + rollup) ────────────────────
  registerTool(server, {
    name: 'bulwark_get_contract',
    description:
      'Get one contract with its embedded obligation ledger and a rollup (obligation counts by review state, open/missed deadline counts), so /contracts/:id/obligations needs no separate tool. Pass asker_user_id to narrow to what that human may see (fail-closed).',
    input: {
      id: z.string().uuid(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id }) => {
      const r = await client.request('GET', `/contracts/${id}${askerQs(asker_user_id)}`);
      return r.ok ? ok(r.data) : err('getting contract', r.data);
    },
  });

  // ── bulwark_delete_contract (destructive; Redis confirm-token two-step) ────
  registerTool(server, {
    name: 'bulwark_delete_contract',
    description:
      'Delete a contract and its obligation ledger (destructive). Two-step confirm: call once WITHOUT confirm_token to stage a Redis-backed token, then call again WITH the returned confirm_token to execute the delete.',
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
          action: BULWARK_DELETE_CONTRACT_ACTION,
          resource_id: id,
          ttlMs: BULWARK_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Deleting a contract removes its obligation ledger. Re-call bulwark_delete_contract with this confirm_token to proceed. Token expires in ${Math.floor(
            BULWARK_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BULWARK_DELETE_CONTRACT_ACTION,
          resource_id: id,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (
        !pending ||
        pending.action !== BULWARK_DELETE_CONTRACT_ACTION ||
        pending.resource_id !== id
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this delete. Re-call bulwark_delete_contract without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      const r = await client.request('DELETE', `/contracts/${id}`);
      return r.ok ? ok(r.data) : err('deleting contract', r.data);
    },
  });

  // ── bulwark_list_obligations ──────────────────────────────────────────────
  registerTool(server, {
    name: 'bulwark_list_obligations',
    description:
      'List obligations across the org (project-scoped). Filter by review_status, obligation_type, and contract_id; sort=-confidence to surface the least-certain extractions first; cursor-paginated.',
    input: {
      review_status: BulwarkReviewStatus.optional(),
      obligation_type: BulwarkObligationType.optional(),
      contract_id: z.string().uuid().optional(),
      sort: z.enum(['-confidence']).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ review_status, obligation_type, contract_id, sort, cursor, limit }) => {
      const qs = new URLSearchParams();
      if (review_status) qs.set('filter[review_status]', review_status);
      if (obligation_type) qs.set('filter[obligation_type]', obligation_type);
      if (contract_id) qs.set('filter[contract_id]', contract_id);
      if (sort) qs.set('sort', sort);
      if (cursor) qs.set('cursor', cursor);
      if (limit !== undefined) qs.set('limit', String(limit));
      const r = await client.request('GET', `/obligations${qs.toString() ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing obligations', r.data);
    },
  });

  // ── bulwark_get_obligation ────────────────────────────────────────────────
  registerTool(server, {
    name: 'bulwark_get_obligation',
    description:
      'Get one obligation with its cited clause span, event binding, deadline rule, and review state. Pass asker_user_id to narrow to what that human may see (fail-closed).',
    input: {
      id: z.string().uuid(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id }) => {
      const r = await client.request('GET', `/obligations/${id}${askerQs(asker_user_id)}`);
      return r.ok ? ok(r.data) : err('getting obligation', r.data);
    },
  });

  // ── bulwark_confirm_obligation (confirm / edit / bind) ────────────────────
  registerTool(server, {
    name: 'bulwark_confirm_obligation',
    description:
      "Confirm, edit, or bind an obligation (PATCH /obligations/:id). Set review_status='confirmed' to accept it (which arms it once its binding is complete), and/or edit its type, title, event_binding, deadline_rule, or mandated_doc_types, and/or bind an amendment obligation to the base it supersedes. To REJECT an obligation use bulwark_reject_obligation instead (that path is confirm-gated). Pass asker_user_id to forward the acting human for the source-scoped preflight.",
    input: {
      id: z.string().uuid(),
      review_status: z
        .literal('confirmed')
        .optional()
        .describe("Set to 'confirmed' to accept and arm the obligation. Use bulwark_reject_obligation to reject."),
      obligation_type: BulwarkObligationType.optional(),
      title: z.string().min(1).max(512).optional(),
      event_binding: bulwarkEventBindingSchema.optional(),
      deadline_rule: bulwarkDeadlineRuleSchema.optional(),
      mandated_doc_types: z.array(BulwarkComplianceDocType).optional(),
      supersedes_obligation_id: z.string().uuid().nullable().optional(),
      supersession_outcome: z.enum(['restate', 'terminate']).optional(),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id, ...patch }) => {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) body[k] = v;
      if (Object.keys(body).length === 0) {
        return err('confirming obligation', {
          message: 'Provide at least one field to confirm, edit, or bind.',
        });
      }
      const r = await client.request('PATCH', `/obligations/${id}${askerQs(asker_user_id)}`, body);
      return r.ok ? ok(r.data) : err('confirming obligation', r.data);
    },
  });

  // ── bulwark_reject_obligation (destructive; Redis confirm-token two-step) ──
  registerTool(server, {
    name: 'bulwark_reject_obligation',
    description:
      'Reject an obligation (PATCH /obligations/:id with review_status=rejected; destructive - disarms it). Two-step confirm: call once WITHOUT confirm_token to stage a Redis-backed token, then call again WITH the returned confirm_token to execute. Pass asker_user_id to forward the acting human for the source-scoped preflight.',
    input: {
      id: z.string().uuid(),
      asker_user_id: askerInput,
      confirm_token: z
        .string()
        .optional()
        .describe('Confirmation token from a prior staging call. Required to execute the reject.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id, confirm_token }) => {
      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BULWARK_REJECT_OBLIGATION_ACTION,
          resource_id: id,
          ttlMs: BULWARK_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Rejecting an obligation disarms it. Re-call bulwark_reject_obligation with this confirm_token to proceed. Token expires in ${Math.floor(
            BULWARK_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BULWARK_REJECT_OBLIGATION_ACTION,
          resource_id: id,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (
        !pending ||
        pending.action !== BULWARK_REJECT_OBLIGATION_ACTION ||
        pending.resource_id !== id
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this reject. Re-call bulwark_reject_obligation without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      // review_status=rejected + confirm=true (the REST-layer light guard; the confirm-token
      // two-step above is the MCP-layer gate).
      const r = await client.request('PATCH', `/obligations/${id}${askerQs(asker_user_id)}`, {
        review_status: 'rejected',
        confirm: true,
      });
      return r.ok ? ok(r.data) : err('rejecting obligation', r.data);
    },
  });

  // ── bulwark_trigger_obligation (manual trigger) ───────────────────────────
  registerTool(server, {
    name: 'bulwark_trigger_obligation',
    description:
      'Manually trigger a confirmed obligation (POST /obligations/:id/trigger), materializing a deadline anchored at occurred_at. For unbound / no-project obligations that no event bus will fire (DI7). Pass asker_user_id to forward the acting human for the source-scoped preflight.',
    input: {
      id: z.string().uuid(),
      occurred_at: z.string().describe('ISO timestamp the triggering event is deemed to have occurred at.'),
      asker_user_id: askerInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, occurred_at, asker_user_id }) => {
      const r = await client.request('POST', `/obligations/${id}/trigger${askerQs(asker_user_id)}`, {
        occurred_at,
      });
      return r.ok ? ok(r.data) : err('triggering obligation', r.data);
    },
  });

  // ── bulwark_list_deadlines ────────────────────────────────────────────────
  registerTool(server, {
    name: 'bulwark_list_deadlines',
    description:
      'List event-bound deadlines (project-scoped). Filter by status, contract_id, project_id, and due_before; cursor-paginated. The notice_draft body is only present for bulwark.notice.draft holders.',
    input: {
      status: BulwarkDeadlineStatus.optional(),
      contract_id: z.string().uuid().optional(),
      project_id: z.string().uuid().optional(),
      due_before: z.string().optional().describe('ISO timestamp; only deadlines due before this.'),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ status, contract_id, project_id, due_before, cursor, limit }) => {
      const qs = new URLSearchParams();
      if (status) qs.set('filter[status]', status);
      if (contract_id) qs.set('filter[contract_id]', contract_id);
      if (project_id) qs.set('filter[project_id]', project_id);
      if (due_before) qs.set('filter[due_before]', due_before);
      if (cursor) qs.set('cursor', cursor);
      if (limit !== undefined) qs.set('limit', String(limit));
      const r = await client.request('GET', `/deadlines${qs.toString() ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing deadlines', r.data);
    },
  });

  // ── bulwark_draft_notice (the proposal IS the HITL; no confirm) ───────────
  registerTool(server, {
    name: 'bulwark_draft_notice',
    description:
      'Draft a notice for a deadline (POST /deadlines/:id/draft-notice). The LLM produces only subject + body_markdown; the recipient and attachments are deterministic and stamped at send. The resulting agent_proposals row IS the human-in-the-loop (an operator approves-and-sends), so there is no confirm_action here.',
    input: {
      id: z.string().uuid(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id }) => {
      const r = await client.request('POST', `/deadlines/${id}/draft-notice`);
      return r.ok ? ok(r.data) : err('drafting notice', r.data);
    },
  });

  // ── bulwark_waive_deadline (destructive; Redis confirm-token two-step) ─────
  registerTool(server, {
    name: 'bulwark_waive_deadline',
    description:
      'Waive an open deadline (POST /deadlines/:id/discharge with outcome=waived; destructive - forgoes the obligation and may waive a claim). Two-step confirm: call once WITHOUT confirm_token to stage a Redis-backed token, then call again WITH the returned confirm_token to execute. Pass asker_user_id to forward the acting human for the source-scoped preflight.',
    input: {
      id: z.string().uuid(),
      reason: z.string().max(2000).optional(),
      asker_user_id: askerInput,
      confirm_token: z
        .string()
        .optional()
        .describe('Confirmation token from a prior staging call. Required to execute the waive.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, reason, asker_user_id, confirm_token }) => {
      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BULWARK_WAIVE_DEADLINE_ACTION,
          resource_id: id,
          ttlMs: BULWARK_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Waiving a deadline forgoes the obligation and may waive a claim. Re-call bulwark_waive_deadline with this confirm_token to proceed. Token expires in ${Math.floor(
            BULWARK_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BULWARK_WAIVE_DEADLINE_ACTION,
          resource_id: id,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (
        !pending ||
        pending.action !== BULWARK_WAIVE_DEADLINE_ACTION ||
        pending.resource_id !== id
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this waive. Re-call bulwark_waive_deadline without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      // outcome=waived + confirm=true (the REST-layer light guard; the confirm-token two-step
      // above is the MCP-layer gate).
      const body: Record<string, unknown> = { outcome: 'waived', confirm: true };
      if (reason !== undefined) body.reason = reason;
      const r = await client.request('POST', `/deadlines/${id}/discharge${askerQs(asker_user_id)}`, body);
      return r.ok ? ok(r.data) : err('waiving deadline', r.data);
    },
  });

  // ── bulwark_discard_notice (state change on a draft; Redis confirm-token two-step) ─────
  registerTool(server, {
    name: 'bulwark_discard_notice',
    description:
      'Discard a bad notice DRAFT (POST /deadlines/:id/discard-notice); sets notice_status=discarded WITHOUT waiving or discharging the obligation clock - the deadline stays open and can be re-drafted. This is the clean "reject draft" action; it is NOT bulwark_waive_deadline, which forgoes the obligation entirely. Two-step confirm: call once WITHOUT confirm_token to stage a Redis-backed token, then call again WITH the returned confirm_token to execute.',
    input: {
      id: z.string().uuid(),
      confirm_token: z
        .string()
        .optional()
        .describe('Confirmation token from a prior staging call. Required to execute the discard.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, confirm_token }) => {
      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BULWARK_DISCARD_NOTICE_ACTION,
          resource_id: id,
          ttlMs: BULWARK_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Discarding a notice draft rejects the generated text (the deadline clock is untouched). Re-call bulwark_discard_notice with this confirm_token to proceed. Token expires in ${Math.floor(
            BULWARK_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BULWARK_DISCARD_NOTICE_ACTION,
          resource_id: id,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (
        !pending ||
        pending.action !== BULWARK_DISCARD_NOTICE_ACTION ||
        pending.resource_id !== id
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this discard. Re-call bulwark_discard_notice without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      const r = await client.request('POST', `/deadlines/${id}/discard-notice`);
      return r.ok ? ok(r.data) : err('discarding notice', r.data);
    },
  });

  // ── bulwark_list_compliance ───────────────────────────────────────────────
  registerTool(server, {
    name: 'bulwark_list_compliance',
    description:
      'List compliance documents (COI, W-9, lien waiver, certified payroll, ...) with their collection, validity, and chase state. Filter by vendor_tier_id, validity_status, and doc_type.',
    input: {
      vendor_tier_id: z.string().uuid().optional(),
      validity_status: BulwarkValidityStatus.optional(),
      doc_type: BulwarkComplianceDocType.optional(),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ vendor_tier_id, validity_status, doc_type }) => {
      const qs = new URLSearchParams();
      if (vendor_tier_id) qs.set('filter[vendor_tier_id]', vendor_tier_id);
      if (validity_status) qs.set('filter[validity_status]', validity_status);
      if (doc_type) qs.set('filter[doc_type]', doc_type);
      const r = await client.request('GET', `/compliance-docs${qs.toString() ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing compliance docs', r.data);
    },
  });

  // ── bulwark_chase_compliance (the proposal IS the HITL; no confirm) ───────
  registerTool(server, {
    name: 'bulwark_chase_compliance',
    description:
      'Draft a chase for a missing or expiring compliance document (POST /compliance-docs/:id/chase). The resulting agent_proposals row IS the human-in-the-loop (an operator approves-and-sends), so there is no confirm_action here.',
    input: {
      id: z.string().uuid(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id }) => {
      const r = await client.request('POST', `/compliance-docs/${id}/chase`);
      return r.ok ? ok(r.data) : err('chasing compliance doc', r.data);
    },
  });
}
