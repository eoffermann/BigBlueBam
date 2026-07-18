import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  BraidSourceType,
  BraidProfileKind,
  BraidSurvivorshipStrategy,
} from '@bigbluebam/shared';
import type { ApiClient } from '../middleware/api-client.js';
import type { ConfirmTokenStore } from '../lib/confirm-token-store.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Braid MCP tools (Milestone M5 - identity-resolution / golden-record CDP).
 *
 * 13 tools backing the braid-api REST surface at /braid/api/v1/* (spec section
 * 10 of docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md). The HTTP
 * client is shaped like dedupe-tools.ts / basis-tools.ts: it forwards the
 * caller's bearer token so braid-api applies the same per-viewer visibility and
 * requireCan gating the human UI does. BRAID_API_URL already ends in /v1 (see
 * env.ts), so paths here are sent WITHOUT a /v1 prefix.
 *
 * Read tools that surface source records take an explicit asker_user_id (per
 * docs/reference/agent-conventions.md) and pass it through so braid-api runs
 * can_access fail-closed. The two truth-flip tools (braid_merge_profiles /
 * braid_split_profile) use the Redis-backed confirm-token store two-step flow,
 * mirroring bam_import_csv's update gate exactly.
 *
 * Following the basis satellite pattern (round-3 BP3-1), braid_* tools are
 * intentionally NOT added to EXPLICIT_TOOL_OVERRIDES; the braid.* allowlist
 * gating is automatic via register-tool (matchesAllowlist('braid.*')).
 */

/** HTTP client for the braid-api service (mirrors createBasisClient). */
function createBraidClient(braidApiUrl: string, api: ApiClient) {
  const baseUrl = braidApiUrl.replace(/\/$/, '');
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

// Truth-flip confirm-token TTL. 5 min is the human-approver window CLAUDE.md
// documents for delete-task / complete-sprint. Merge and split are human-reviewed
// truth-flips, so they get the human TTL from the Redis-backed store.
const BRAID_CONFIRM_TTL_MS = 300_000;
const BRAID_MERGE_ACTION = 'braid_merge_profiles';
const BRAID_SPLIT_ACTION = 'braid_split_profile';

const BraidProfileStatusEnum = z.enum(['active', 'merged_away', 'archived']);
const BraidCandidateStatusEnum = z.enum(['pending', 'merged', 'rejected', 'superseded']);

export function registerBraidTools(
  server: McpServer,
  api: ApiClient,
  braidApiUrl: string,
  confirmTokenStore: ConfirmTokenStore,
): void {
  const client = createBraidClient(braidApiUrl, api);

  // ── braid_resolve (the flagship) ──────────────────────────────────────────
  registerTool(server, {
    name: 'braid_resolve',
    description:
      'Resolve a source-app record ({source_type, source_id}) to its stable golden profile id. The flagship Braid operation. The input record is preflighted through can_access first: a denied record returns NOT_FOUND, never a golden id. identity_count is suppressed for non-admin askers. Follows the merged_into_id chain and may lazily mint a singleton profile for a never-before-seen record.',
    input: {
      source_type: BraidSourceType,
      source_id: z.string().uuid(),
      asker_user_id: z
        .string()
        .uuid()
        .optional()
        .describe('The human on whose behalf the agent is asking; gates input-record preflight'),
    },
    returns: z.record(z.unknown()),
    handler: async (body) => {
      const r = await client.request('POST', '/resolve', body);
      return r.ok ? ok(r.data) : err('resolving record', r.data);
    },
  });

  // ── braid_get_profile (embeds identities + recent decisions) ──────────────
  registerTool(server, {
    name: 'braid_get_profile',
    description:
      'Get a golden profile with its member source identities and recent merge/split decisions embedded, so /profiles/:id/identities and /profiles/:id/decisions need no separate tool. All scalars and attributes are re-assembled per viewer: denied member identities are dropped and identity_count/confidence recomputed over only visible members. Pass asker_user_id to gate per-viewer visibility fail-closed.',
    input: {
      id: z.string().uuid(),
      asker_user_id: z
        .string()
        .uuid()
        .optional()
        .describe('The human on whose behalf the agent is asking; gates per-viewer visibility'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, asker_user_id }) => {
      const qs = asker_user_id ? `?asker_user_id=${encodeURIComponent(asker_user_id)}` : '';
      const profile = await client.request('GET', `/profiles/${id}${qs}`);
      if (!profile.ok) return err('getting profile', profile.data);
      // resolver-done-internally: fan out to the two sub-resource GETs and embed
      // them so an agent gets member identities + decision history in one call.
      const [identities, decisions] = await Promise.all([
        client.request('GET', `/profiles/${id}/identities${qs}`),
        client.request('GET', `/profiles/${id}/decisions${qs}`),
      ]);
      return ok({
        data: {
          profile: unwrap(profile.data),
          identities: identities.ok ? unwrap(identities.data) : [],
          recent_decisions: decisions.ok ? unwrap(decisions.data) : [],
        },
      });
    },
  });

  // ── braid_list_profiles ───────────────────────────────────────────────────
  registerTool(server, {
    name: 'braid_list_profiles',
    description:
      'List golden profiles for the org (admin-tier read; per-viewer assembly for granted non-admins). Filter by kind (person|company) and status; cursor-paginated.',
    input: {
      kind: BraidProfileKind.optional(),
      status: BraidProfileStatusEnum.optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      asker_user_id: z
        .string()
        .uuid()
        .optional()
        .describe('The human on whose behalf the agent is asking; gates per-viewer assembly'),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ kind, status, cursor, limit, asker_user_id }) => {
      const qs = new URLSearchParams();
      if (kind) qs.set('filter[kind]', kind);
      if (status) qs.set('filter[status]', status);
      if (cursor) qs.set('cursor', cursor);
      if (limit !== undefined) qs.set('limit', String(limit));
      if (asker_user_id) qs.set('asker_user_id', asker_user_id);
      const r = await client.request('GET', `/profiles${qs.toString() ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing profiles', r.data);
    },
  });

  // ── braid_search_profiles (client-side filter over GET /profiles) ─────────
  registerTool(server, {
    name: 'braid_search_profiles',
    description:
      'Search golden profiles by display_name or primary_email substring (case-insensitive) within the org. Admin-asker only (the search vector is a PII oracle otherwise, spec S4); results are per-viewer assembled.',
    input: {
      query: z.string().describe('Substring to match against display_name or primary_email'),
      kind: BraidProfileKind.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      asker_user_id: z
        .string()
        .uuid()
        .optional()
        .describe('The human on whose behalf the agent is asking; gates per-viewer assembly'),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ query, kind, limit, asker_user_id }) => {
      const qs = new URLSearchParams();
      if (kind) qs.set('filter[kind]', kind);
      if (limit !== undefined) qs.set('limit', String(limit));
      if (asker_user_id) qs.set('asker_user_id', asker_user_id);
      const r = await client.request('GET', `/profiles${qs.toString() ? `?${qs}` : ''}`);
      if (!r.ok) return err('searching profiles', r.data);
      const needle = query.toLowerCase();
      const rows = (
        (r.data as { data?: { display_name?: string | null; primary_email?: string | null }[] }).data ?? []
      ).filter(
        (p) =>
          p.display_name?.toLowerCase().includes(needle) ||
          p.primary_email?.toLowerCase().includes(needle),
      );
      return ok({ data: rows });
    },
  });

  // ── braid_profile_timeline ────────────────────────────────────────────────
  registerTool(server, {
    name: 'braid_profile_timeline',
    description:
      "Get a golden profile's cross-app timeline (activity + Bolt events for its member identities). Fail-closed per viewer: a row is included only if it maps to a member identity whose source entity the asker passed can_access on. Pass asker_user_id to gate visibility.",
    input: {
      id: z.string().uuid(),
      asker_user_id: z
        .string()
        .uuid()
        .optional()
        .describe('The human on whose behalf the agent is asking; gates per-viewer visibility fail-closed'),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ id, asker_user_id }) => {
      const qs = asker_user_id ? `?asker_user_id=${encodeURIComponent(asker_user_id)}` : '';
      const r = await client.request('GET', `/profiles/${id}/timeline${qs}`);
      return r.ok ? ok(r.data) : err('getting profile timeline', r.data);
    },
  });

  // ── braid_list_candidates ─────────────────────────────────────────────────
  registerTool(server, {
    name: 'braid_list_candidates',
    description:
      'List review-queue match candidates (profile pairs pending human merge review), sorted by -score. Filter by status (pending|merged|rejected|superseded); cursor-paginated. Evidence value-refs are re-hydrated per caller.',
    input: {
      status: BraidCandidateStatusEnum.optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ status, cursor, limit }) => {
      const qs = new URLSearchParams();
      if (status) qs.set('filter[status]', status);
      if (cursor) qs.set('cursor', cursor);
      if (limit !== undefined) qs.set('limit', String(limit));
      const r = await client.request('GET', `/candidates${qs.toString() ? `?${qs}` : ''}`);
      return r.ok ? ok(r.data) : err('listing candidates', r.data);
    },
  });

  // ── braid_propose_merge (the proposal IS the HITL; no confirm) ────────────
  registerTool(server, {
    name: 'braid_propose_merge',
    description:
      "Propose merging two golden profiles for HUMAN review. Upserts a canonical braid_match_candidates row (computed evidence, bridge identities) and registers an agent_proposals row in the org-admin approval inbox, so approval flows through the same CAS-guarded mergeCandidate executor. The proposing asker must pass can_access on both profiles' member identities (or be admin); rate-limited. The proposal IS the human-in-the-loop, so there is no confirm_action here.",
    input: {
      profile_a_id: z.string().uuid(),
      profile_b_id: z.string().uuid(),
      reason: z.string().max(2000).optional(),
      asker_user_id: z
        .string()
        .uuid()
        .optional()
        .describe("The human on whose behalf the agent proposes; preflighted on both profiles' members"),
    },
    returns: z.record(z.unknown()),
    handler: async (body) => {
      // No dedicated /candidates propose route exists yet; POST to the candidates
      // surface per spec 10. braid-api upserts the candidate + inserts the
      // agent_proposals row and sets the candidate's proposal_id.
      const r = await client.request('POST', '/candidates', body);
      return r.ok ? ok(r.data) : err('proposing merge', r.data);
    },
  });

  // ── braid_reject_candidate (no confirm; HITL boundary is the merge) ───────
  registerTool(server, {
    name: 'braid_reject_candidate',
    description:
      'Reject a match candidate. Writes an identity-level dedupe suppression so the bridging identity pair does not re-surface next tick. Permission-gated by braid.profile.merge (the confirm boundary is the merge, not the suppression, so no confirm_action here).',
    input: {
      candidate_id: z.string().uuid(),
      reason: z.string().max(2000).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ candidate_id, reason }) => {
      const r = await client.request(
        'POST',
        `/candidates/${candidate_id}/reject`,
        reason !== undefined ? { reason } : {},
      );
      return r.ok ? ok(r.data) : err('rejecting candidate', r.data);
    },
  });

  // ── braid_merge_profiles (truth-flip; Redis confirm-token two-step) ───────
  registerTool(server, {
    name: 'braid_merge_profiles',
    description:
      'Merge two golden profiles into one (truth-flip; auditable and reversible via braid_split_profile). Provide EITHER candidate_id (confirm a queued candidate via /candidates/:id/merge) OR profile_a_id + profile_b_id (direct merge via /profiles/merge). Two-step confirm: call once WITHOUT confirm_token to stage a Redis-backed token, then call again WITH the returned confirm_token to execute.',
    input: {
      candidate_id: z.string().uuid().optional(),
      profile_a_id: z.string().uuid().optional(),
      profile_b_id: z.string().uuid().optional(),
      reason: z.string().max(2000).optional(),
      confirm_token: z
        .string()
        .optional()
        .describe('Confirmation token from a prior staging call. Required to execute the merge.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ candidate_id, profile_a_id, profile_b_id, reason, confirm_token }) => {
      const byCandidate = !!candidate_id;
      const byPair = !!profile_a_id && !!profile_b_id;
      if (byCandidate === byPair) {
        return err('validating merge input', {
          message: 'Provide exactly one of candidate_id OR (profile_a_id AND profile_b_id).',
        });
      }
      const resourceId = byCandidate ? candidate_id! : `${profile_a_id}:${profile_b_id}`;

      // Stage: no token yet, mint one and return pending_confirmation.
      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BRAID_MERGE_ACTION,
          resource_id: resourceId,
          ttlMs: BRAID_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Merging golden profiles is a truth-flip. Re-call braid_merge_profiles with this confirm_token to proceed. Token expires in ${Math.floor(
            BRAID_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BRAID_MERGE_ACTION,
          resource_id: resourceId,
          confirm_token: token,
        });
      }

      // Confirm: validate the token against this exact merge, single-use.
      const pending = await confirmTokenStore.get(confirm_token);
      if (!pending || pending.action !== BRAID_MERGE_ACTION || pending.resource_id !== resourceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this merge. Re-call braid_merge_profiles without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);

      const r = byCandidate
        ? await client.request(
            'POST',
            `/candidates/${candidate_id}/merge`,
            reason !== undefined ? { reason } : {},
          )
        : await client.request('POST', '/profiles/merge', {
            profile_a_id,
            profile_b_id,
            ...(reason !== undefined ? { reason } : {}),
          });
      return r.ok ? ok(r.data) : err('merging profiles', r.data);
    },
  });

  // ── braid_split_profile (destructive truth-flip; Redis confirm-token) ─────
  registerTool(server, {
    name: 'braid_split_profile',
    description:
      'Split or unmerge a golden profile (destructive truth-flip). Provide EITHER merge_decision_id (undo a specific prior merge) OR identity_ids (peel the listed member identities into a fresh profile). Two-step confirm: call once WITHOUT confirm_token to stage a Redis-backed token, then call again WITH the returned confirm_token to execute.',
    input: {
      profile_id: z.string().uuid(),
      merge_decision_id: z.string().uuid().optional(),
      identity_ids: z.array(z.string().uuid()).min(1).optional(),
      reason: z.string().max(2000).optional(),
      confirm_token: z
        .string()
        .optional()
        .describe('Confirmation token from a prior staging call. Required to execute the split.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ profile_id, merge_decision_id, identity_ids, reason, confirm_token }) => {
      const byDecision = !!merge_decision_id;
      const byIdentities = !!identity_ids && identity_ids.length > 0;
      if (byDecision === byIdentities) {
        return err('validating split input', {
          message: 'Provide exactly one of merge_decision_id (unmerge) OR identity_ids (fresh split).',
        });
      }

      if (!confirm_token) {
        const token = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BRAID_SPLIT_ACTION,
          resource_id: profile_id,
          ttlMs: BRAID_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Splitting a golden profile is a destructive truth-flip. Re-call braid_split_profile with this confirm_token to proceed. Token expires in ${Math.floor(
            BRAID_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BRAID_SPLIT_ACTION,
          resource_id: profile_id,
          confirm_token: token,
        });
      }

      const pending = await confirmTokenStore.get(confirm_token);
      if (!pending || pending.action !== BRAID_SPLIT_ACTION || pending.resource_id !== profile_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this split. Re-call braid_split_profile without a token to stage a new one.',
            },
          ],
          isError: true,
        };
      }
      await confirmTokenStore.delete(confirm_token);

      const body: Record<string, unknown> = {};
      if (merge_decision_id) body.merge_decision_id = merge_decision_id;
      if (identity_ids) body.identity_ids = identity_ids;
      if (reason !== undefined) body.reason = reason;
      const r = await client.request('POST', `/profiles/${profile_id}/split`, body);
      return r.ok ? ok(r.data) : err('splitting profile', r.data);
    },
  });

  // ── braid_set_survivorship_rule ───────────────────────────────────────────
  registerTool(server, {
    name: 'braid_set_survivorship_rule',
    description:
      'Upsert the per-org survivorship rule that decides which member value wins for one (kind, field) when profiles merge. strategy is most_recent | source_priority | longest_non_null | most_frequent | manual_pin. source_priority is the ordered source_type list used by the source_priority strategy; pinned_value is used with manual_pin.',
    input: {
      kind: BraidProfileKind,
      field: z
        .string()
        .min(1)
        .max(64)
        .describe('e.g. display_name, primary_email, primary_phone, title, company_profile_id'),
      strategy: BraidSurvivorshipStrategy,
      source_priority: z.array(BraidSourceType).max(10).optional(),
      pinned_value: z.unknown().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ kind, field, strategy, source_priority, pinned_value }) => {
      const body: Record<string, unknown> = { strategy, source_priority: source_priority ?? [] };
      if (pinned_value !== undefined) body.pinned_value = pinned_value;
      const r = await client.request(
        'PUT',
        `/survivorship-rules/${kind}/${encodeURIComponent(field)}`,
        body,
      );
      return r.ok ? ok(r.data) : err('setting survivorship rule', r.data);
    },
  });

  // ── braid_list_survivorship_rules ─────────────────────────────────────────
  registerTool(server, {
    name: 'braid_list_survivorship_rules',
    description:
      "List this org's survivorship rules (per kind, per field winner-selection strategies).",
    input: {},
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async () => {
      const r = await client.request('GET', '/survivorship-rules');
      return r.ok ? ok(r.data) : err('listing survivorship rules', r.data);
    },
  });

  // ── braid_get_settings ────────────────────────────────────────────────────
  registerTool(server, {
    name: 'braid_get_settings',
    description:
      "Get this org's Braid settings: auto-merge / review thresholds, the strong-signal requirement, enabled source types, and the rescan window.",
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.request('GET', '/settings');
      return r.ok ? ok(r.data) : err('getting braid settings', r.data);
    },
  });
}
