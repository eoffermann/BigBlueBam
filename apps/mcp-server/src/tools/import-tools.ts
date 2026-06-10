import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import type { ApiClient } from '../middleware/api-client.js';
import type { ConfirmTokenStore } from '../lib/confirm-token-store.js';
import { registerTool } from '../lib/register-tool.js';

// ── bam_import_csv input schema (Phase 3, §5.7) ─────────────────────────────
// Mirrors the api wire format (POST /projects/:id/import/csv[/preview]) plus a
// dry_run flag (preview path) and a confirm_token (only consulted when the
// duplicate_strategy is 'update', which is gated behind the confirm_action
// token convention because it overwrites existing tasks).
const linkMappingSchema = z.object({
  column: z.string().describe('CSV column whose cells contain URL(s)'),
  label: z.string().nullable().optional().describe('Static title applied to every link from this column'),
  fetch_title: z.boolean().optional().describe('Resolve link titles (internal inline, external queued)'),
});

const customFieldMappingSchema = z.object({
  column: z.string().describe('CSV column to map into a custom field'),
  field_name: z.string().describe('Target custom-field name (within the project)'),
  field_type: z
    .enum(['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url'])
    .describe('Custom-field type'),
  create_if_missing: z.boolean().optional().describe('Find-or-create the custom-field definition by name'),
});

/** Confirm-token TTL for the update-strategy gate (60s, agent-to-agent). */
const IMPORT_CONFIRM_TTL_MS = 60_000;
const IMPORT_CONFIRM_ACTION = 'bam_import_csv:update';

export function registerImportTools(
  server: McpServer,
  api: ApiClient,
  confirmTokenStore: ConfirmTokenStore,
): void {
  registerTool(server, {
    name: 'import_github_issues',
    description: 'Import GitHub issues into a project as tasks',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      issues: z.array(z.object({
        number: z.number().int().describe('GitHub issue number'),
        title: z.string().describe('Issue title'),
        body: z.string().nullable().optional().describe('Issue body/description'),
        state: z.string().optional().describe('Issue state (open/closed)'),
        labels: z.array(z.string()).optional().describe('Label names'),
        assignee: z.string().nullable().optional().describe('Assignee login'),
      })).describe('Array of GitHub issues to import'),
    },
    returns: z.object({ imported: z.number(), failed: z.number().optional(), errors: z.array(z.string()).optional() }),
    handler: async ({ project_id, issues }) => {
      const result = await api.post(`/projects/${project_id}/import/github`, { issues });

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error importing GitHub issues: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'suggest_branch_name',
    description: 'Generate a git branch name suggestion based on a task. Fetches the task and returns a name like "feature/FRND-42-design-login-screen".',
    input: {
      task_id: z.string().uuid().describe('The task ID to generate a branch name for'),
    },
    returns: z.object({ branch_name: z.string(), task_id: z.string().uuid(), human_id: z.string(), title: z.string() }),
    handler: async ({ task_id }) => {
      const result = await api.get<{ human_id: string; title: string }>(`/tasks/${task_id}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching task: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      const { human_id, title } = result.data;

      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);

      const branchName = `feature/${human_id}-${slug}`;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ branch_name: branchName, task_id, human_id, title }, null, 2) }],
      };
    },
  });

  // ── bam_import_csv (Phase 3, §5.7) ──────────────────────────────────────
  //
  // Spreadsheet-style CSV import as an MCP tool. Mirrors the api wire format
  // exactly (rows + mapping + value_maps + link_mappings + custom_field_mapping
  // + options) so a sheet a human imported through the wizard can be imported
  // by an agent with the same authority.
  //
  //   - dry_run: true  → calls POST /projects/:id/import/csv/preview (writes
  //                      nothing) and returns the dry-run report.
  //   - dry_run: false → calls POST /projects/:id/import/csv (commits).
  //
  // Strategy gating: 'create' and 'skip' commit straight away. 'update' is a
  // destructive round-trip (it OVERWRITES existing tasks), so a commit with
  // duplicate_strategy:'update' is gated behind the confirm_action token
  // convention the rest of the MCP server uses: the first call (no
  // confirm_token) stages a single-use token and returns pending_confirmation;
  // the caller re-invokes with that token to actually run the update. Dry-run
  // is never gated (it writes nothing).
  registerTool(server, {
    name: 'bam_import_csv',
    description:
      "Import tasks from CSV rows into a Bam project (spreadsheet round-trip). Supports value_maps (per-field cell translation), link_mappings (URL columns -> task Links), custom_field_mapping (opt-in custom fields), and options.duplicate_strategy: 'create' | 'skip' | 'update'. Set dry_run:true to preview (writes nothing). 'update' overwrites matched existing tasks (matched by exported human_id column when mapping.human_id is set, else by exact title) and is gated behind confirmation: call once without confirm_token to stage a token, then again with it to commit.",
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      rows: z
        .array(z.record(z.string()))
        .max(5000)
        .describe('Array of row objects (CSV header -> cell value)'),
      mapping: z
        .record(z.string())
        .describe(
          "Target field -> CSV column name (e.g. { title: 'Feature', priority: 'Prio', human_id: 'human_id' }). 'title' is required. Include 'human_id' to match on it under the update strategy.",
        ),
      value_maps: z
        .record(z.record(z.string().nullable()))
        .optional()
        .describe('Per-target-field map of incoming cell value -> Bam value (null = leave unset)'),
      link_mappings: z.array(linkMappingSchema).optional().describe('URL columns to import into task Links'),
      custom_field_mapping: z
        .array(customFieldMappingSchema)
        .optional()
        .describe('Opt-in mapping of columns into project custom fields'),
      options: z
        .object({
          duplicate_strategy: z
            .enum(['create', 'skip', 'update'])
            .optional()
            .describe("How to handle rows that match existing tasks (default 'create')"),
          date_locale: z.enum(['us', 'iso']).optional().describe('Date parsing locale'),
        })
        .optional(),
      dry_run: z
        .boolean()
        .optional()
        .describe('When true, preview the import (writes nothing) instead of committing'),
      confirm_token: z
        .string()
        .optional()
        .describe(
          "Confirmation token from a prior staging call. Required to commit a duplicate_strategy:'update' import; ignored otherwise.",
        ),
    },
    returns: z.object({
      // Either a staging response, a preview report, or a commit result —
      // surfaced as a JSON text block.
      status: z.string().optional(),
      data: z.unknown().optional(),
    }),
    handler: async ({
      project_id,
      rows,
      mapping,
      value_maps,
      link_mappings,
      custom_field_mapping,
      options,
      dry_run,
      confirm_token,
    }) => {
      const strategy = options?.duplicate_strategy ?? 'create';
      const body = {
        rows,
        mapping,
        ...(value_maps ? { value_maps } : {}),
        ...(link_mappings ? { link_mappings } : {}),
        ...(custom_field_mapping ? { custom_field_mapping } : {}),
        ...(options ? { options } : {}),
      };

      // Update-strategy confirmation gate. Dry-run is exempt (no writes).
      if (strategy === 'update' && !dry_run) {
        if (!confirm_token) {
          const token = crypto.randomBytes(16).toString('hex');
          await confirmTokenStore.set(token, {
            action: IMPORT_CONFIRM_ACTION,
            resource_id: project_id,
            ttlMs: IMPORT_CONFIRM_TTL_MS,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    status: 'pending_confirmation',
                    message: `duplicate_strategy:'update' overwrites existing tasks. Re-call bam_import_csv with this confirm_token to proceed. Token expires in ${Math.floor(
                      IMPORT_CONFIRM_TTL_MS / 1000,
                    )} seconds.`,
                    action: IMPORT_CONFIRM_ACTION,
                    resource_id: project_id,
                    confirm_token: token,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Validate the supplied token against this project.
        const pending = await confirmTokenStore.get(confirm_token);
        if (
          !pending ||
          pending.action !== IMPORT_CONFIRM_ACTION ||
          pending.resource_id !== project_id
        ) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Invalid or expired confirm_token for this update import. Re-call bam_import_csv without a token to stage a new one.',
              },
            ],
            isError: true,
          };
        }
        // Single-use: consume before committing.
        await confirmTokenStore.delete(confirm_token);
      }

      const path = dry_run
        ? `/projects/${project_id}/import/csv/preview`
        : `/projects/${project_id}/import/csv`;
      const result = await api.post(path, body);

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error ${dry_run ? 'previewing' : 'importing'} CSV: ${JSON.stringify(result.data)}`,
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
