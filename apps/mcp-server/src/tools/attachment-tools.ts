import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Attachment metadata MCP tools (AGENTIC_TODO §17, Wave 4).
 *
 * Two tools surface the federated attachment metadata dispatcher that
 * lives in apps/api/src/services/attachment-meta.service.ts:
 *
 *   - attachment_get(upload_id)
 *   - attachment_list({ entity_type, entity_id, limit?, scan_status? })
 *   - attachment_meta()  — discovery: supported parent types / scan statuses / limits
 *
 * Supported parent types: 'bam.task', 'helpdesk.ticket', 'beacon.entry'.
 * Brief has no attachment storage today, and Bond/Book/Blast do not
 * store file attachments. Agents that receive UNSUPPORTED_PARENT_TYPE
 * should NOT silently retry under another entity_type; they should
 * treat the attachment as non-surfaceable.
 *
 * CRITICAL: every read is preflighted against visibility.service on
 * the parent entity BEFORE the attachment table is touched. Callers
 * that receive FORBIDDEN with a reason MUST NOT re-surface the reason
 * to end users in raw form; the reason is telemetry, not disclosure.
 *
 * Deep-link semantics: `deep_link` is a presigned MinIO GET URL with a
 * 24-hour expiry and is ONLY populated when scan_status='clean'. For
 * pending/infected/error rows the field is null. Agents that want to
 * hand a download link to a human MUST check scan_status first.
 */
const ATTACHMENT_SCAN_STATUSES = ['pending', 'clean', 'infected', 'error'] as const;

const attachmentMetaShape = z.object({
  id: z.string().uuid(),
  parent_type: z.enum(['bam.task', 'helpdesk.ticket', 'beacon.entry']),
  parent_id: z.string().uuid(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  scan_status: z.enum(ATTACHMENT_SCAN_STATUSES),
  scan_signature: z.string().nullable(),
  scanned_at: z.string().nullable(),
  scan_error: z.string().nullable(),
  uploader_id: z.string().uuid().nullable(),
  uploader_kind: z.enum(['human', 'agent', 'service']).nullable(),
  uploaded_at: z.string(),
  deep_link: z.string().nullable(),
});

export function registerAttachmentTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'attachment_get',
    description:
      "Fetch metadata for a single attachment by id, federated across Bam tasks, Helpdesk tickets, and Beacon entries. Runs a visibility preflight on the parent entity BEFORE reading the attachment table, so callers who cannot see the parent get NOT_FOUND (cross-org) or FORBIDDEN (within-org denial) without leaking existence. Returns `deep_link` as a presigned download URL ONLY when scan_status='clean'; infected / pending / error rows return deep_link=null. Brief documents are NOT supported parents (Brief has no attachment table as of Wave 4). AGENTIC_TODO §17 Wave 4.",
    input: {
      upload_id: z
        .string()
        .uuid()
        .describe(
          'Attachment UUID. The dispatcher probes Bam, Helpdesk, and Beacon attachment tables in that order until it finds a match.',
        ),
    },
    returns: z.object({
      data: attachmentMetaShape,
    }),
    handler: async ({ upload_id }) => {
      const result = await api.get(`/v1/attachments/${upload_id}`);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching attachment metadata: ${JSON.stringify(result.data)}`,
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
    name: 'attachment_list',
    description:
      "List attachments attached to a given parent entity, filtered optionally by scan_status. Supported entity_type values: 'bam.task', 'helpdesk.ticket', 'beacon.entry'. Any other entity_type returns UNSUPPORTED_PARENT_TYPE. Visibility preflight runs on the parent BEFORE the attachment table is queried; unauthorized callers get 403 FORBIDDEN with the can_access reason. `limit` defaults to 50 and is capped at 50. Rows are sorted by uploaded_at desc. Deep links are issued only for scan_status='clean' rows. AGENTIC_TODO §17 Wave 4.",
    input: {
      entity_type: z
        .string()
        .describe(
          "Parent entity type. Must be one of the supported values ('bam.task', 'helpdesk.ticket', 'beacon.entry'). Unsupported types return UNSUPPORTED_PARENT_TYPE and MUST NOT be retried under a guessed type.",
        ),
      entity_id: z
        .string()
        .uuid()
        .describe('Parent entity id (UUID).'),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe('Max rows to return. Defaults to 50; hard cap is 50.'),
      scan_status: z
        .enum(ATTACHMENT_SCAN_STATUSES)
        .optional()
        .describe(
          'Optional scan_status filter. When omitted returns all scan statuses.',
        ),
    },
    returns: z.object({
      data: z.array(attachmentMetaShape),
      meta: z
        .object({
          entity_type: z.string(),
          entity_id: z.string().uuid(),
          limit: z.number().int().positive(),
          scan_status: z.string().nullable(),
          count: z.number().int().nonnegative(),
        })
        .passthrough(),
    }),
    handler: async ({ entity_type, entity_id, limit, scan_status }) => {
      const params = new URLSearchParams();
      params.set('entity_type', entity_type);
      params.set('entity_id', entity_id);
      if (typeof limit === 'number') params.set('limit', String(limit));
      if (scan_status) params.set('scan_status', scan_status);
      const result = await api.get(`/v1/attachments?${params.toString()}`);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing attachments: ${JSON.stringify(result.data)}`,
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
    name: 'attachment_meta',
    description:
      "Discovery endpoint for the federated attachment surface. Returns the static set of supported parent entity_type values, the valid scan_status filter values, and the default/max list limits — so an agent can self-describe attachment_list/attachment_get capabilities without consulting docs or guessing. Read-only; no parameters. AGENTIC_TODO §17 Wave 4.",
    input: {},
    returns: z.object({
      data: z
        .object({
          supported_parent_types: z.array(z.string()),
          supported_scan_statuses: z.array(z.string()),
          list_limit_default: z.number().int().positive(),
          list_limit_max: z.number().int().positive(),
        })
        .passthrough(),
    }),
    handler: async () => {
      const result = await api.get('/v1/attachments/_meta');
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching attachment meta: ${JSON.stringify(result.data)}`,
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
