import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Cross-app user resolver tools.
 *
 * These three tools provide a top-level, app-agnostic way to resolve a user
 * identity from an email address or a partial name, or to list users in the
 * caller's active organization. The strategy doc identifies the missing user
 * resolver as the single biggest cross-app pain point: every tool that takes
 * a `user_id` / `assignee_id` / `owner_id` requires the caller to already
 * know the UUID, and there was no `find_user_by_email` anywhere in the MCP
 * surface.
 *
 * These tools complement (and overlap with) the per-app tools - e.g. Bam's
 * forthcoming `bam_find_user_by_email`. Both can coexist: namespace-free
 * tools live here, app-scoped tools live in their app's tool file. All share
 * the same underlying postgres `users` table, so a user resolved via this
 * file can be passed to any app's `user_id` parameter without translation.
 *
 * All tools are:
 *   - READ-ONLY (safe to call freely, no audit risk beyond logging)
 *   - ORG-SCOPED via the caller's active org (from the auth session/token)
 *   - IDEMPOTENT
 */

const userShape = z.object({
  id: z.string().uuid(),
  email: z.string(),
  display_name: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
  role: z.string().optional(),
  is_active: z.boolean().optional(),
}).passthrough();

export function registerUserResolverTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'find_user_by_email',
    description: 'Find a user by exact email address (case-insensitive) within the caller\'s active organization. Returns the user object `{ id, email, name, display_name, avatar_url, role }` or `null` if no match. Use this whenever a rule, workflow, or prompt mentions a user by email and you need their user_id to pass to another tool. Works identically for any app (Bam, Banter, Bolt, Bond, etc.) - the underlying users table is shared.',
    input: {
      email: z.string().email().describe('Exact email address to look up (case-insensitive)'),
    },
    returns: z.object({ data: userShape.nullable() }),
    handler: async ({ email }) => {
      const qs = new URLSearchParams({ email }).toString();
      const result = await api.get(`/users/by-email?${qs}`);

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error looking up user by email: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'find_user_by_name',
    description: 'Fuzzy-search active users by name or email within the caller\'s active organization. Matches against display_name and email, ordered by relevance (exact email match first, then prefix matches, then contains). Returns up to 20 users as `[{ id, email, name, display_name, avatar_url, role }]`. Use this when a rule mentions "assign to Jane" or "notify Bob" and you need to disambiguate the user.',
    input: {
      query: z.string().min(1).describe('Name or email fragment to search for (case-insensitive, substring match on display_name and email)'),
    },
    returns: z.object({ data: z.array(userShape) }),
    handler: async ({ query }) => {
      const qs = new URLSearchParams({ q: query }).toString();
      const result = await api.get(`/users/search?${qs}`);

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching users: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'list_users',
    description: 'List users in the caller\'s active organization, sorted by display name. Returns `[{ id, email, name, display_name, avatar_url, role, is_active }]`. Defaults to active users only (max 200 per call). Use this to enumerate users when building UIs, workflow targets, or when you need an overview of the org roster. For project-scoped member lists, use `list_members` instead.',
    input: {
      active_only: z.boolean().optional().describe('If true (default), exclude disabled users'),
      limit: z.number().int().positive().max(200).optional().describe('Maximum number of users to return (default 50, max 200)'),
    },
    returns: z.object({ data: z.array(userShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ active_only, limit }) => {
      const params = new URLSearchParams();
      // Default is true server-side; only send the param when explicitly
      // overriding to keep the URL clean in logs.
      if (active_only === false) params.set('active_only', 'false');
      if (limit) params.set('limit', String(limit));

      const qs = params.toString();
      const path = qs ? `/users?${qs}` : '/users';
      const result = await api.get(path);

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing users: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
