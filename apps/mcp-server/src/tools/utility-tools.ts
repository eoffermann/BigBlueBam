import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import type { RateLimiter } from '../middleware/rate-limiter.js';
import crypto from 'node:crypto';
import { registerTool } from '../lib/register-tool.js';
import type { ConfirmTokenStore } from '../lib/confirm-token-store.js';

const TOOL_NAMES = [
  'list_projects',
  'get_project',
  'create_project',
  'bam_list_phases',
  'bam_list_labels',
  'bam_list_states',
  'bam_list_epics',
  'search_tasks',
  'get_task',
  'create_task',
  'update_task',
  'move_task',
  'delete_task',
  'bulk_update_tasks',
  'log_time',
  'duplicate_task',
  'import_csv',
  'bam_import_csv',
  'list_sprints',
  'create_sprint',
  'start_sprint',
  'complete_sprint',
  'get_sprint_report',
  'list_comments',
  'add_comment',
  'list_members',
  'get_my_tasks',
  'get_velocity_report',
  'get_burndown',
  'get_cumulative_flow',
  'get_overdue_tasks',
  'get_workload',
  'get_status_distribution',
  'list_templates',
  'create_from_template',
  'import_github_issues',
  'suggest_branch_name',
  'get_server_info',
  'confirm_action',
  'get_me',
  'update_me',
  'list_my_orgs',
  'switch_active_org',
  'change_my_password',
  'logout',
  'list_my_notifications',
  'mark_notification_read',
  'mark_notifications_read',
  'mark_all_notifications_read',
  'get_platform_settings',
  'set_public_signup_disabled',
  'platform_list_orgs',
  'platform_create_org',
  'platform_get_org',
  'platform_update_org',
  'platform_delete_org',
  'get_launchpad_apps',
  'set_platform_launchpad_defaults',
  'set_org_launchpad_apps',
  'list_beta_signups',
  'get_public_config',
  'submit_beta_signup',
  'get_cycle_time_report',
  'get_time_tracking_report',
  // beacon
  'beacon_create',
  'beacon_list',
  'beacon_get',
  'beacon_update',
  'beacon_retire',
  'beacon_publish',
  'beacon_verify',
  'beacon_challenge',
  'beacon_restore',
  'beacon_versions',
  'beacon_version_get',
  'beacon_search',
  'beacon_suggest',
  'beacon_search_context',
  'beacon_policy_get',
  'beacon_policy_set',
  'beacon_policy_resolve',
  'beacon_tags_list',
  'beacon_tag_add',
  'beacon_tag_remove',
  'beacon_link_create',
  'beacon_link_remove',
  'beacon_query_save',
  'beacon_query_list',
  'beacon_query_get',
  'beacon_query_delete',
  'beacon_graph_neighbors',
  'beacon_graph_hubs',
  'beacon_graph_recent',
  // visibility preflight (AGENTIC_TODO §11, Wave 2)
  'can_access',
  // durable proposals (AGENTIC_TODO §9, Wave 2)
  'proposal_create',
  'proposal_list',
  'proposal_decide',
  // cross-app unified search (AGENTIC_TODO §2, Wave 3)
  'search_everything',
  // fuzzy entity resolver (AGENTIC_TODO §3, Wave 3)
  'resolve_references',
  // unified activity-log querying (AGENTIC_TODO §5, Wave 3)
  'activity_query',
  'activity_by_actor',
  // composite subject-centric views (AGENTIC_TODO §6, Wave 3)
  'account_view',
  'project_view',
  'user_view',
  // §16 Wave 4 entity links
  'entity_links_list',
  'entity_link_create',
  'entity_link_remove',
  // §17 Wave 4 attachments
  'attachment_get',
  'attachment_list',
  // §13 Wave 4 scheduled banter
  'banter_schedule_post',
  // §14 Wave 4 upserts
  'bond_upsert_contact',
  'beacon_upsert_by_slug',
  'helpdesk_upsert_user',
  'task_upsert_by_external_id',
  // §15 Wave 5 agent policies
  'agent_policy_get',
  'agent_policy_set',
  'agent_policy_list',
  // §12 Wave 5 bolt observability
  'bolt_event_trace',
  'bolt_recent_events',
  // §18 + §19 Wave 5 misc
  'book_find_meeting_time_for_users',
  'ingest_fingerprint_check',
  // §7 Wave 5 dedupe
  'bond_find_duplicates',
  'helpdesk_find_similar_tickets',
  'dedupe_record_decision',
  'dedupe_list_pending',
  // §4 + §8 Wave 5 trends/expertise
  'helpdesk_ticket_count_by_phrase',
  'bam_task_count_by_phrase',
  'expertise_for_topic',
  // §1 Wave 5 banter subs
  'banter_subscribe_pattern',
  'banter_unsubscribe_pattern',
  'banter_list_subscriptions',
  // §20 Wave 5 webhooks
  'agent_webhook_configure',
  'agent_webhook_rotate_secret',
  'agent_webhook_deliveries_list',
  'agent_webhook_redeliver',
] as const;

// Pending confirmation tokens live in a ConfirmTokenStore (Redis-backed with
// an in-process fallback; see apps/mcp-server/src/lib/confirm-token-store.ts).
// The store is injected from createMcpServer so tokens can survive rolling
// deploys and so the staging and confirm legs can land on different MCP
// instances behind a load balancer. TTL is enforced by Redis' PX expiry.

// Default TTLs. Agent-to-agent chains tolerate 60 seconds fine; async human
// review needs a wider window. A request that supplies `approver_user_id`
// with `users.kind === 'human'` gets the human TTL; everything else gets
// the short one. The default without an approver_user_id hint is the short
// TTL (backward compat with pre-Wave-2 callers).
const CONFIRM_TTL_AGENT_MS = 60_000;
const CONFIRM_TTL_HUMAN_MS = 5 * 60_000;

/**
 * Resolve the TTL to apply to a new confirm_action token. If an approver
 * user id is supplied, we probe /users/:id to check the approver's kind:
 * humans get CONFIRM_TTL_HUMAN_MS, agents/service accounts get the short
 * CONFIRM_TTL_AGENT_MS. If the probe fails (user not found, network error,
 * etc.) we fall back to the short TTL to stay safe. Exported for tests.
 */
export async function resolveConfirmTtlMs(
  api: ApiClient,
  approverUserId: string | undefined,
): Promise<number> {
  if (!approverUserId) return CONFIRM_TTL_AGENT_MS;
  const res = await api.get<{ data?: { kind?: string } }>(
    `/users/${approverUserId}`,
  );
  if (!res.ok) return CONFIRM_TTL_AGENT_MS;
  const kind = res.data?.data?.kind;
  return kind === 'human' ? CONFIRM_TTL_HUMAN_MS : CONFIRM_TTL_AGENT_MS;
}

export function registerUtilityTools(
  server: McpServer,
  api: ApiClient,
  rateLimiter: RateLimiter,
  confirmTokenStore: ConfirmTokenStore,
): void {
  registerTool(server, {
    name: 'get_server_info',
    description: 'Get information about this MCP server including version, available tools, authenticated user, and rate limit status',
    input: {},
    returns: z.object({
      name: z.string(),
      version: z.string(),
      description: z.string(),
      tool_count: z.number(),
      available_tools: z.array(z.string()),
      authenticated_user: z.unknown().nullable(),
      rate_limit: z.unknown().optional(),
    }),
    handler: async () => {
      // Fetch authenticated user info
      const meResult = await api.get('/auth/me');

      const info = {
        name: 'BigBlueBam',
        version: '1.0.0',
        description: 'BigBlueBam Project Management MCP Server',
        available_tools: TOOL_NAMES,
        tool_count: TOOL_NAMES.length,
        authenticated_user: meResult.ok ? meResult.data : null,
        rate_limit: rateLimiter.getStatus(),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'confirm_action',
    description:
      'Confirm a destructive action using a confirmation token. First call without a token to stage the action and receive a token. Then call again with the token to execute. TTL is 60 seconds by default; if approver_user_id is supplied and resolves to a human user, TTL is extended to 5 minutes so async human review is feasible (AGENTIC_TODO §9 Wave 2).',
    input: {
      action: z.string().describe('Description of the action to confirm'),
      resource_id: z.string().describe('ID of the resource being affected'),
      token: z.string().optional().describe('Confirmation token received from the staging call. Omit to stage a new action.'),
      approver_user_id: z
        .string()
        .uuid()
        .optional()
        .describe('Optional approver user id. If present and the user is a human, TTL is 5 minutes. Otherwise TTL is 60 seconds.'),
    },
    returns: z.object({
      status: z.enum(['pending_confirmation', 'confirmed']),
      message: z.string(),
      action: z.string(),
      resource_id: z.string(),
      confirmation_token: z.string().optional().describe('Present when status is pending_confirmation'),
    }),
    handler: async ({ action, resource_id, token, approver_user_id }) => {
      if (!token) {
        // Stage the action: resolve TTL, generate a token, and store in the
        // Redis-backed ConfirmTokenStore so the token survives restarts and
        // works across MCP instances behind a load balancer.
        const ttlMs = await resolveConfirmTtlMs(api, approver_user_id);
        const confirmToken = crypto.randomBytes(16).toString('hex');
        await confirmTokenStore.set(confirmToken, {
          action,
          resource_id,
          ttlMs,
        });

        const ttlSeconds = Math.floor(ttlMs / 1000);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'pending_confirmation',
              message: `Action requires confirmation. Token expires in ${ttlSeconds} seconds.`,
              action,
              resource_id,
              confirmation_token: confirmToken,
              instruction: 'Call confirm_action again with this token to proceed.',
            }, null, 2),
          }],
        };
      }

      // Validate the token. Redis-side PX expiry means get() returns null
      // for expired keys, so the "expired" and "not found" paths collapse
      // into one response: both ask the caller to stage again.
      const pending = await confirmTokenStore.get(token);

      if (!pending) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Invalid or expired confirmation token. Please stage the action again.',
          }],
          isError: true,
        };
      }

      if (pending.action !== action || pending.resource_id !== resource_id) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Token does not match the provided action and resource_id. Please stage the action again.',
          }],
          isError: true,
        };
      }

      // Token is valid - consume it (single use)
      await confirmTokenStore.delete(token);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'confirmed',
            message: `Action confirmed: ${action} on resource ${resource_id}. Proceeding.`,
            action,
            resource_id,
          }, null, 2),
        }],
      };
    },
  });
}
