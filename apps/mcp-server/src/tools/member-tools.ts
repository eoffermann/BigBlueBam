import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

const memberShape = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  display_name: z.string().optional(),
  email: z.string().optional(),
  role: z.string().optional(),
  joined_at: z.string().optional(),
}).passthrough();

const taskShape = z.object({
  id: z.string().uuid(),
  human_id: z.string(),
  title: z.string(),
  state_category: z.string().optional(),
  priority: z.string().optional(),
  project_id: z.string().uuid().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const userShape = z.object({
  id: z.string().uuid(),
  email: z.string(),
  display_name: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
}).passthrough();

export function registerMemberTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'list_members',
    description: 'List members of a project or the entire organization',
    input: {
      project_id: z.string().uuid().optional().describe('Project ID to list members for. If omitted, lists org-level members.'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(200).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(memberShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ project_id, cursor, limit }) => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));

      const qs = params.toString();
      const path = project_id
        ? `/projects/${project_id}/members${qs ? `?${qs}` : ''}`
        : `/org/members${qs ? `?${qs}` : ''}`;

      const result = await api.get(path);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing members: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'get_my_tasks',
    description: 'Get tasks assigned to the current authenticated user, optionally filtered by project',
    input: {
      project_id: z.string().uuid().optional().describe('Filter by project ID'),
      state_category: z.enum(['todo', 'active', 'blocked', 'review', 'done', 'cancelled']).optional().describe('Filter by state category'),
      sprint_id: z.string().uuid().optional().describe('Filter by sprint'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(200).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(taskShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ project_id, state_category, sprint_id, cursor, limit }) => {
      // First get the current user's info to find their ID
      const meResult = await api.get<{ id: string }>('/auth/me');

      if (!meResult.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching current user: ${JSON.stringify(meResult.data)}` }],
          isError: true,
        };
      }

      const userId = meResult.data.id;

      const params = new URLSearchParams();
      params.set('assignee_id', userId);
      if (state_category) params.set('state_category', state_category);
      if (sprint_id) params.set('sprint_id', sprint_id);
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));

      const qs = params.toString();

      if (project_id) {
        const result = await api.get(`/projects/${project_id}/tasks?${qs}`);

        if (!result.ok) {
          return {
            content: [{ type: 'text' as const, text: `Error fetching tasks: ${JSON.stringify(result.data)}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
        };
      }

      // Without a project_id, use the /me/tasks endpoint
      const result = await api.get(`/me/tasks?${qs}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching my tasks: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // Bam-scoped user resolvers. These duplicate the surface of the
  // top-level `find_user_by_email` / `find_user_by_name` tools from
  // user-resolver-tools.ts so that Bam-centric prompts and rules can
  // find them via the `bam_*` namespace convention. Both tools call the
  // same shared `/users/*` endpoints under the hood.
  registerTool(server, {
    name: 'bam_find_user_by_email',
    description: "Find a user by their exact email address (case-insensitive, scoped to the caller's active org). Returns the user `{ id, email, name, display_name, avatar_url }` or null when no match.",
    input: {
      email: z.string().email().describe('Email address to look up'),
    },
    returns: z.object({ data: userShape.nullable() }),
    handler: async ({ email }) => {
      const result = await api.get(`/users/by-email?email=${encodeURIComponent(email)}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error looking up user by email: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_find_user',
    description: "Fuzzy-search users by display name or email (scoped to the caller's active org). Results are ranked by relevance and capped at 20.",
    input: {
      query: z.string().min(1).describe('Free-text query matched against display name and email'),
    },
    returns: z.object({ data: z.array(userShape) }),
    handler: async ({ query }) => {
      const result = await api.get(`/users/search?q=${encodeURIComponent(query)}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error searching users: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // ─── People Manager v2: scoped multi-org people list (M1) ───────────────
  //
  // Wraps GET /people. Unlike `list_members` (single active org), this
  // returns people across EVERY org the caller belongs to (SuperUsers see
  // all non-deleted orgs), deduped, with per-(person, org) capability flags
  // computed server-side. A caller never sees a person who shares no org
  // with them.
  const peopleCapsShape = z.object({
    manage_role: z.boolean(),
    disable: z.boolean(),
    remove: z.boolean(),
    reset_password: z.boolean(),
    manage_projects: z.boolean(),
    manage_keys: z.boolean(),
    transfer_ownership: z.boolean(),
    delete_account: z.boolean(),
  });
  const personShape = z.object({
    user: z.object({
      id: z.string().uuid(),
      email: z.string(),
      display_name: z.string().optional(),
      avatar_url: z.string().nullable().optional(),
      is_active: z.boolean(),
      last_seen_at: z.string().nullable().optional(),
    }).passthrough(),
    memberships: z.array(
      z.object({
        org_id: z.string().uuid(),
        org_name: z.string(),
        role: z.string(),
        caps: peopleCapsShape,
      }).passthrough(),
    ),
  }).passthrough();

  registerTool(server, {
    name: 'bam_list_people',
    description:
      "List people across EVERY org the caller belongs to (a SuperUser sees all non-deleted orgs), deduped, with per-(person, org) capability flags. This is the People Manager v2 surface — broader than `list_members`, which is limited to the caller's single active org. Visibility is scoped: a caller never sees a person who shares no org with them. Each membership row carries `caps` (manage_role, disable, remove, reset_password, manage_projects, manage_keys, transfer_ownership, delete_account) computed server-side from the caller's role in that org and rank vs. the person — use them to decide which follow-up mutation tools (e.g. bam_admin_reset_password) will be permitted. Pass `user_id` to fetch a single person (with their in-scope memberships + caps); a `user_id` outside the caller's visible scope returns an empty list. Supports search (email + display name, case-insensitive), is_active / role / org_id filters, and opaque cursor pagination (limit default 50, max 200).",
    input: {
      search: z
        .string()
        .max(255)
        .optional()
        .describe('Case-insensitive substring matched against email and display name.'),
      is_active: z
        .boolean()
        .optional()
        .describe('Filter to active (true) or disabled (false) people only.'),
      role: z
        .enum(['owner', 'admin', 'member', 'viewer', 'guest'])
        .optional()
        .describe('Keep only people who hold this role in at least one in-scope org.'),
      org_id: z
        .string()
        .uuid()
        .optional()
        .describe('Restrict the scan to a single org the caller can see.'),
      user_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Fetch a single person by user id. Returns at most that one person, and only if they share an org with the caller (a user_id outside scope returns an empty list).',
        ),
      cursor: z.string().optional().describe('Opaque pagination cursor from a prior response.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Page size (default 50, max 200).'),
    },
    returns: z.object({ data: z.array(personShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ search, is_active, role, org_id, user_id, cursor, limit }) => {
      const params = new URLSearchParams();
      if (search !== undefined) params.set('search', search);
      if (is_active !== undefined) params.set('is_active', String(is_active));
      if (role !== undefined) params.set('role', role);
      if (org_id !== undefined) params.set('org_id', org_id);
      if (user_id !== undefined) params.set('user_id', user_id);
      if (cursor !== undefined) params.set('cursor', cursor);
      if (limit !== undefined) params.set('limit', String(limit));
      const qs = params.toString();
      const result = await api.get(`/people${qs ? `?${qs}` : ''}`);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing people: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // ─── Org admin: invite + password ops (B3 Frndo Launch) ─────────────────
  //
  // Caller must already have org-admin scope on the active org (or be a
  // platform SuperUser). These mirror the web /b3/people surface so an
  // agent can onboard or re-credential a user without going through the
  // web UI. All three wrap routes added/extended during B3 Frndo Launch:
  //  - POST /org/members/invite (now sends an invitation email + accepts project_ids)
  //  - POST /org/members/:userId/reset-password (now returns the new password)
  //  - POST /org/members/:userId/send-password-reset (mints a one-time link)

  registerTool(server, {
    name: 'bam_invite_member',
    description:
      "Invite a user to the caller's active org. Reuses an existing user by email if one already exists (`was_existing=true`); otherwise creates a brand-new user. Optionally adds the user to one or more projects in the same org at the same time (`project_ids`). When SMTP is configured, the user receives an invitation email — for brand-new users the email carries a 7-day password-onboarding link via the password-reset token machinery; for existing users it's just a 'you have new access' notice. The response reports `email_sent` so the caller knows whether the email actually went out. Errors: 409 ALREADY_MEMBER, 400 CROSS_ORG_PROJECT (one or more project_ids belong to another org).",
    input: {
      email: z.string().email().max(320).describe("Invitee's email address."),
      role: z
        .enum(['member', 'admin'])
        .optional()
        .describe("Org role to grant (default 'member'; 'owner' isn't invitable — use transfer-ownership instead)."),
      display_name: z
        .string()
        .max(100)
        .optional()
        .describe('Optional display name; defaults to the local-part of the email for new users.'),
      project_ids: z
        .array(z.string().uuid())
        .optional()
        .describe('Optional project UUIDs in the caller\'s org to add the user to as a project member (role defaults to member).'),
    },
    returns: z
      .object({
        id: z.string().uuid(),
        email: z.string(),
        was_existing: z.boolean(),
        email_sent: z.boolean(),
        projects_added: z.array(z.string().uuid()),
        projects_skipped: z.array(z.string().uuid()),
      })
      .passthrough(),
    handler: async ({ email, role, display_name, project_ids }) => {
      const body: Record<string, unknown> = { email };
      if (role !== undefined) body.role = role;
      if (display_name !== undefined) body.display_name = display_name;
      if (project_ids !== undefined) body.project_ids = project_ids;
      const result = await api.post('/org/members/invite', body);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error inviting member: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_admin_reset_password',
    description:
      "Org-admin: reset another user's password to a freshly generated 16-character password (or one you supply via `password`). All of that user's active sessions are invalidated in the same transaction. The new password is returned in the response so the operator can hand it off — there is no second chance to retrieve it. The caller must be an org admin/owner or a SuperUser, and must outrank the target. Prefer `bam_send_password_reset_link` when the user can be reached by email; this tool is the right choice when SMTP is unconfigured or the user is locked out without email access.",
    input: {
      user_id: z.string().uuid().describe('Target user UUID (must be a member of the caller\'s active org).'),
      password: z
        .string()
        .min(12)
        .max(200)
        .optional()
        .describe('Optional explicit password. Min 12 chars. If omitted, a 16-char strong password is generated.'),
    },
    returns: z
      .object({
        user_id: z.string().uuid(),
        email: z.string(),
        password: z.string().describe('Plaintext new password. Shown exactly once.'),
        generated: z.boolean(),
        message: z.string(),
      })
      .passthrough(),
    handler: async ({ user_id, password }) => {
      const body: Record<string, unknown> = {};
      if (password !== undefined) body.password = password;
      const result = await api.post(`/org/members/${user_id}/reset-password`, body);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error resetting password: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_send_password_reset_link',
    description:
      "Org-admin: mint a one-time password-reset token for another user and email them a 60-minute reset link. The caller must outrank the target (or be a SuperUser). The response reports `email_sent` and `smtp_configured` so the caller knows whether the email actually went out — if SMTP is not configured the token is still minted, but no email is sent and the caller must hand the link off out-of-band (or call `bam_admin_reset_password` instead). This is the gentler alternative to `bam_admin_reset_password` because the operator never sees the password.",
    input: {
      user_id: z.string().uuid().describe('Target user UUID (must be a member of the caller\'s active org).'),
    },
    returns: z
      .object({
        user_id: z.string().uuid(),
        email: z.string(),
        email_sent: z.boolean(),
        smtp_configured: z.boolean(),
        expires_in_minutes: z.number().int(),
        message: z.string(),
      })
      .passthrough(),
    handler: async ({ user_id }) => {
      const result = await api.post(`/org/members/${user_id}/send-password-reset`, undefined);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error sending password reset link: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
