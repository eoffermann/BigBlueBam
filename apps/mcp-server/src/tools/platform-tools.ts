import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * SuperUser-gated tools:
 *   - The first group (/superuser/*) is already gated at the API layer —
 *     the server returns 403 to non-SuperUsers. We just pass through.
 *   - The second group wraps PUBLIC endpoints (/public/config,
 *     /public/beta-signup) that don't need auth on the HTTP surface but
 *     that we only want reachable from MCP by SuperUsers, since they
 *     aren't a normal-user feature — they're part of the beta-gate
 *     flow. We check `is_superuser` via /auth/me before proxying.
 */

type SuperuserCheckResult =
  | { ok: true }
  | { ok: false; errorText: string };

async function requireSuperuser(api: ApiClient): Promise<SuperuserCheckResult> {
  const me = await api.get<{ data?: { is_superuser?: boolean } }>('/auth/me');
  if (!me.ok) {
    return { ok: false, errorText: `Error: could not verify caller identity: ${JSON.stringify(me.data)}` };
  }
  const isSuperuser = me.data?.data?.is_superuser === true;
  if (!isSuperuser) {
    return {
      ok: false,
      errorText: 'Error: this tool requires SuperUser privileges. The authenticated user does not have is_superuser set.',
    };
  }
  return { ok: true };
}

export function registerPlatformTools(server: McpServer, api: ApiClient): void {
  // ─── /superuser/* passthroughs (server-side gated) ───────────────────────

  registerTool(server, {
    name: 'get_platform_settings',
    description:
      'SuperUser only. Fetch platform-wide settings. As of B3 Frndo Launch the response contains two independent signup kill switches: `public_signup_disabled` gates the BigBlueBam internal /auth/register endpoint; `helpdesk_signup_disabled` gates the Helpdesk customer /helpdesk/auth/register endpoint. The flags are deliberately decoupled — closing internal signup during beta should not also block customers from filing tickets.',
    input: {},
    returns: z
      .object({
        public_signup_disabled: z.boolean().optional(),
        helpdesk_signup_disabled: z.boolean().optional(),
      })
      .passthrough(),
    handler: async () => {
      const result = await api.get('/superuser/platform-settings');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching platform settings: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'set_public_signup_disabled',
    description:
      "SuperUser only. Toggle the BigBlueBam (internal) public signup kill switch. When true, POST /auth/register returns 403 SIGNUP_DISABLED and the /b3/login page's 'Create one' link routes to the beta-gate. Does NOT affect Helpdesk customer signup — use `set_helpdesk_signup_disabled` for that. Both flags are returned in the response so the caller can see the resulting state of the platform settings row.",
    input: {
      public_signup_disabled: z.boolean().describe('true to freeze BigBlueBam new-account creation; false to open it back up.'),
    },
    returns: z
      .object({
        public_signup_disabled: z.boolean(),
        helpdesk_signup_disabled: z.boolean(),
      })
      .passthrough(),
    handler: async ({ public_signup_disabled }) => {
      const result = await api.patch('/superuser/platform-settings', { public_signup_disabled });
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error updating platform settings: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'set_helpdesk_signup_disabled',
    description:
      "SuperUser only. Toggle the Helpdesk customer signup kill switch. When true, POST /helpdesk/auth/register returns 403 SIGNUP_DISABLED and the Helpdesk login page hides 'Create one'. Independent of `set_public_signup_disabled` — closing BigBlueBam internal signup during beta should not also block customers from filing tickets. Both flags are returned in the response so the caller can see the resulting state.",
    input: {
      helpdesk_signup_disabled: z.boolean().describe('true to freeze Helpdesk customer signup; false to open it back up.'),
    },
    returns: z
      .object({
        public_signup_disabled: z.boolean(),
        helpdesk_signup_disabled: z.boolean(),
      })
      .passthrough(),
    handler: async ({ helpdesk_signup_disabled }) => {
      const result = await api.patch('/superuser/platform-settings', { helpdesk_signup_disabled });
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error updating platform settings: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  // ─── Organization CRUD (SuperUser only) ───────────────────────────────────
  //
  // Wraps /v1/platform/orgs (see apps/api/src/routes/platform.routes.ts). The
  // API layer enforces requireSuperUser so these passthroughs rely on that
  // gate. Destructive delete uses the confirm_action boolean flag pattern
  // shared with banter_delete_channel and banter_delete_message; the extra
  // round-trip gives the human operator a chance to abort.

  const orgResponseShape = z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    plan: z.string(),
    created_at: z.string(),
  }).passthrough();

  registerTool(server, {
    name: 'platform_list_orgs',
    description: 'SuperUser only. List every organization on the server with live member counts. Supports server-wide name search and paging. Use platform_create_org to provision a new one.',
    input: {
      search: z.string().max(255).optional().describe('Case-insensitive ILIKE match on organization name.'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size (default 50, max 100).'),
      offset: z.number().int().min(0).optional().describe('Offset for paging; orderBy is created_at DESC.'),
    },
    returns: z.object({
      data: z.array(orgResponseShape.extend({ member_count: z.number().int() })),
    }),
    handler: async ({ search, limit, offset }) => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const qs = params.toString();
      const path = qs ? `/v1/platform/orgs?${qs}` : '/v1/platform/orgs';
      const result = await api.get(path);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing orgs: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'platform_create_org',
    description: "SuperUser only. Create a brand-new organization. The slug is auto-derived from the name (lowercased, non-alphanumeric collapsed to '-'). Does NOT create a membership for the caller — use switch_active_org or the /superuser/context/switch endpoint to enter the new org afterwards.",
    input: {
      name: z.string().trim().min(1).max(255).describe('Display name of the organization.'),
      plan: z.string().trim().max(50).optional().describe("Billing plan identifier; defaults to 'free'."),
    },
    returns: z.object({ data: orgResponseShape }),
    handler: async ({ name, plan }) => {
      const body: Record<string, unknown> = { name };
      if (plan !== undefined) body.plan = plan;
      const result = await api.post('/v1/platform/orgs', body);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error creating org: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'platform_get_org',
    description: 'SuperUser only. Fetch a single organization by id, including live member count. Differs from account_view in that it is platform-admin-scoped and returns raw org fields without aggregation across apps.',
    input: {
      org_id: z.string().uuid().describe('Organization id.'),
    },
    returns: z.object({ data: orgResponseShape.extend({ member_count: z.number().int() }) }),
    handler: async ({ org_id }) => {
      const result = await api.get(`/v1/platform/orgs/${org_id}`);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching org: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'platform_update_org',
    description: 'SuperUser only. Update an organization. Renaming regenerates the slug. settings is a shallow JSONB replacement — pass the full object you want stored.',
    input: {
      org_id: z.string().uuid().describe('Organization id.'),
      name: z.string().trim().min(1).max(255).optional().describe('New display name. Slug is regenerated from this.'),
      plan: z.string().trim().max(50).optional().describe('Billing plan identifier.'),
      settings: z.record(z.unknown()).optional().describe('Full JSONB replacement for organizations.settings.'),
    },
    returns: z.object({ data: orgResponseShape }),
    handler: async ({ org_id, ...patch }) => {
      const result = await api.patch(`/v1/platform/orgs/${org_id}`, patch);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error updating org: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'platform_delete_org',
    description: 'SuperUser only. Permanently delete an organization and CASCADE every user, project, task, ticket, and membership inside it. Active sessions for the org are revoked before the DELETE runs. Destructive — requires confirm_action=true to actually proceed.',
    input: {
      org_id: z.string().uuid().describe('Organization id to delete.'),
      confirm_action: z.boolean().describe('Must be true to actually delete. Call once with false (or omit) to preview the action, then call again with true.'),
    },
    returns: z.object({ data: z.object({ success: z.boolean() }) }),
    handler: async ({ org_id, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete organization ${org_id}? This CASCADE-deletes every user, project, task, and ticket in it. Call platform_delete_org again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await api.delete(`/v1/platform/orgs/${org_id}`);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error deleting org: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  // ─── Launchpad app visibility ────────────────────────────────────────────
  // Two-tier: SuperUser sets a server-wide default in system_settings; org
  // admins/owners override it per-org. The resolver in
  // /b3/api/launchpad/apps returns the effective list for the caller.

  const launchpadAppIdSchema = z.enum([
    'b3', 'banter', 'beacon', 'bond', 'blast', 'bill', 'blank',
    'book', 'bench', 'brief', 'bolt', 'bearing', 'board', 'helpdesk',
  ]);

  registerTool(server, {
    name: 'get_launchpad_apps',
    description: 'Get the resolved Launchpad app list for the caller\'s active org. Returns the catalog (every app id), the enabled subset, the source layer that won (org override, platform default, or built-in default which means "all enabled"), and the raw values at each layer for debugging visibility.',
    input: {},
    returns: z.object({
      catalog: z.array(z.string()),
      enabled: z.array(z.string()),
      source: z.enum(['org', 'platform', 'default']),
      org_override: z.array(z.string()).nullable(),
      platform_default: z.array(z.string()).nullable(),
    }),
    handler: async () => {
      const result = await api.get('/launchpad/apps');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching launchpad apps: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'set_platform_launchpad_defaults',
    description: 'SuperUser only. Set or clear the server-wide Launchpad default. Pass `apps: null` to clear the default (meaning "all apps enabled" for orgs that have no override). Pass an array of app ids to constrain the default. Per-org overrides set via set_org_launchpad_apps still take precedence.',
    input: {
      apps: z.array(launchpadAppIdSchema).nullable().describe('Array of app ids to enable platform-wide, or null to clear and fall back to "all enabled".'),
    },
    returns: z.object({ data: z.unknown() }),
    handler: async ({ apps }) => {
      const result = await api.put('/system-settings/launchpad_default_apps', { value: apps });
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error setting platform launchpad defaults: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'set_org_launchpad_apps',
    description: "Org admin/owner only. Set or clear the active org's Launchpad override. Pass `apps: null` to clear the override and fall back to the platform default. Pass an array of app ids to override. Affects every member of the org.",
    input: {
      apps: z.array(launchpadAppIdSchema).nullable().describe('Array of app ids to enable for this org, or null to clear the override and inherit the platform default.'),
    },
    returns: z.object({
      data: z.object({
        catalog: z.array(z.string()),
        org_override: z.array(z.string()).nullable(),
        platform_default: z.array(z.string()).nullable(),
      }),
    }),
    handler: async ({ apps }) => {
      const result = await api.put('/org/launchpad-apps', { apps });
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error setting org launchpad apps: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'list_beta_signups',
    description: 'SuperUser only. List notify-me submissions from the public beta-gate form, newest first.',
    input: {},
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        email: z.string(),
        created_at: z.string(),
      }).passthrough()),
    }),
    handler: async () => {
      const result = await api.get('/superuser/beta-signups');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing beta signups: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  // ─── Public endpoints, gated to SuperUser only at the MCP layer ──────────

  registerTool(server, {
    name: 'get_public_config',
    description: 'SuperUser only (MCP gate). Read the unauthenticated /public/config — currently returns whether public signup is disabled. The underlying endpoint is public, but we gate MCP access to SuperUsers since this is part of the platform-admin surface.',
    input: {},
    returns: z.object({ public_signup_disabled: z.boolean().optional() }).passthrough(),
    handler: async () => {
      const check = await requireSuperuser(api);
      if (!check.ok) {
        return { content: [{ type: 'text' as const, text: check.errorText }], isError: true };
      }
      const result = await api.get('/public/config');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching public config: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'submit_beta_signup',
    description: 'SuperUser only (MCP gate). Create a notify-me submission via the public /public/beta-signup endpoint. The HTTP endpoint is public-by-anyone, but we only allow SuperUsers to invoke it through MCP (typically for testing or manual entry on behalf of a prospect).',
    input: {
      name: z.string().trim().min(1).max(200).describe('Contact name.'),
      email: z.string().trim().email().max(320).describe('Contact email.'),
      phone: z.string().trim().max(40).optional().describe('Phone number (optional).'),
      message: z.string().trim().max(2000).optional().describe('What would they like to use BigBlueBam for (optional).'),
    },
    returns: z.object({ id: z.string().uuid(), email: z.string() }).passthrough(),
    handler: async (body) => {
      const check = await requireSuperuser(api);
      if (!check.ok) {
        return { content: [{ type: 'text' as const, text: check.errorText }], isError: true };
      }
      const result = await api.post('/public/beta-signup', body);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error submitting beta signup: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });
}
