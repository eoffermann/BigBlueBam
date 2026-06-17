import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { handleScopeError } from '../middleware/scope-check.js';
import { resolveTaskId } from './task-tools.js';
import { registerTool } from '../lib/register-tool.js';

const commentShape = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  body: z.string(),
  author_id: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerCommentTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'list_comments',
    description: 'List all comments on a task',
    input: {
      task_id: z.string().uuid().describe('The task ID'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(200).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(commentShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ task_id, cursor, limit }) => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));

      const qs = params.toString();
      const result = await api.get(`/tasks/${task_id}/comments${qs ? `?${qs}` : ''}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing comments: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'add_comment',
    description: "Add a comment to a task. Accepts either a task UUID or human_id (e.g. 'FRND-42').",
    input: {
      task_id: z
        .string()
        .describe("Task UUID or human_id (e.g. 'FRND-42')"),
      body: z.string().min(1).describe('Comment body (markdown supported)'),
    },
    returns: commentShape,
    handler: async ({ task_id, body }) => {
      const resolvedTaskId = await resolveTaskId(api, task_id);
      if (!resolvedTaskId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error adding comment: Task '${task_id}' could not be resolved by UUID or human_id`,
            },
          ],
          isError: true,
        };
      }

      const result = await api.post(`/tasks/${resolvedTaskId}/comments`, { body });

      if (!result.ok) {
        const scopeErr = handleScopeError('add_comment', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error adding comment: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'edit_comment',
    description:
      "Edit one of your OWN comments. The prior body is preserved as a revision (history is queryable via list_comment_revisions) and the comment is flagged edited. A no-op edit (body unchanged) does not burn a revision. The API rejects editing another author's comment with 403.",
    input: {
      comment_id: z.string().uuid().describe('The comment UUID'),
      body: z.string().min(1).describe('New comment body (markdown supported)'),
    },
    returns: commentShape,
    handler: async ({ comment_id, body }) => {
      const result = await api.patch(`/comments/${comment_id}`, { body });

      if (!result.ok) {
        const scopeErr = handleScopeError('edit_comment', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error editing comment: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'list_comment_revisions',
    description: 'List the edit history of a comment — every superseded body, newest first, with who revised it and when. Readable by anyone who can read the comment.',
    input: {
      comment_id: z.string().uuid().describe('The comment UUID'),
    },
    returns: z.object({
      data: z.array(
        z
          .object({
            id: z.string().uuid(),
            body: z.string(),
            revised_at: z.string(),
            revised_by: z.string().uuid().nullable(),
            revised_by_name: z.string().nullable(),
          })
          .passthrough(),
      ),
    }),
    handler: async ({ comment_id }) => {
      const result = await api.get(`/comments/${comment_id}/revisions`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing comment revisions: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'delete_comment',
    description:
      "Delete one of your OWN comments (destructive). Decrements the parent task's comment_count. The API rejects deleting another author's comment with 403. Requires confirm:true — the first call without it returns a confirmation prompt and changes nothing.",
    input: {
      comment_id: z.string().uuid().describe('The comment UUID to delete'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ data: z.object({ success: z.boolean() }) }),
    handler: async ({ comment_id, confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Are you sure you want to delete comment ${comment_id}? Call this tool again with confirm: true to proceed.`,
            },
          ],
        };
      }

      const result = await api.delete(`/comments/${comment_id}`);

      if (!result.ok) {
        const scopeErr = handleScopeError('delete_comment', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error deleting comment: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'toggle_comment_reaction',
    description:
      "Toggle an emoji reaction on a comment for the calling user. If the user has already reacted with this emoji it is removed; otherwise it is added. Returns the updated per-emoji counts for the comment.",
    input: {
      comment_id: z.string().uuid().describe('The comment UUID'),
      emoji: z.string().min(1).max(50).describe('The emoji to toggle (e.g. "👍")'),
    },
    returns: z.object({
      data: z.array(z.object({ emoji: z.string(), count: z.number() }).passthrough()),
    }),
    handler: async ({ comment_id, emoji }) => {
      const result = await api.post(`/comments/${comment_id}/reactions`, { emoji });

      if (!result.ok) {
        const scopeErr = handleScopeError('toggle_comment_reaction', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error toggling reaction: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'list_comment_reactions',
    description: 'List all reactions on a comment, grouped by emoji with the reacting users named.',
    input: {
      comment_id: z.string().uuid().describe('The comment UUID'),
    },
    returns: z.object({
      data: z.array(
        z
          .object({
            emoji: z.string(),
            count: z.number(),
            users: z.array(z.object({ id: z.string().uuid(), display_name: z.string() })),
          })
          .passthrough(),
      ),
    }),
    handler: async ({ comment_id }) => {
      const result = await api.get(`/comments/${comment_id}/reactions`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing reactions: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
