// ---------------------------------------------------------------------------
// Phrase-count MCP tools (AGENTIC_TODO §4 Wave 5)
//
// Two live-query time-bucketed trend tools that let an agent answer
// "tickets matching phrase X in the last 14 days" inside a conversational
// reply, without requiring a pre-built Bench materialized view:
//
//   - helpdesk_ticket_count_by_phrase
//   - bam_task_count_by_phrase
//
// Both delegate to the per-service analytics routes
// (/v1/tickets/analytics/count-by-phrase on helpdesk-api and
// /v1/tasks/analytics/count-by-phrase on api). `window.since` is REQUIRED
// on both; `window.until` defaults to now() server-side.
// ---------------------------------------------------------------------------

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

const bucketEnum = z.enum(['hour', 'day', 'week']);

const windowShape = z.object({
  since: z.string().min(1).describe('ISO 8601 timestamp. REQUIRED lower bound.'),
  until: z
    .string()
    .min(1)
    .optional()
    .describe('ISO 8601 timestamp. Defaults to now() when omitted.'),
});

const bucketShape = z.object({
  bucket_start: z.string(),
  count: z.number(),
});

const responseShape = z
  .object({
    phrase: z.string(),
    bucket_granularity: bucketEnum,
    window: z.object({ since: z.string(), until: z.string() }),
    buckets: z.array(bucketShape),
    total: z.number(),
    approximate: z.literal(false),
    generated_at: z.string(),
  })
  .passthrough();

export interface PhraseCountToolUrls {
  helpdeskApiUrl: string;
  apiUrl: string;
}

function bearerToken(api: ApiClient): string | undefined {
  return (api as unknown as { token?: string }).token;
}

function headers(api: ApiClient): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = bearerToken(api);
  if (t) h['Authorization'] = `Bearer ${t}`;
  return h;
}

function trim(url: string): string {
  return url.replace(/\/$/, '');
}

function errEnvelope(message: string, data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${message}: ${JSON.stringify(data)}`,
      },
    ],
    isError: true as const,
  };
}

export function registerPhraseCountTools(
  server: McpServer,
  api: ApiClient,
  urls: PhraseCountToolUrls,
): void {
  registerTool(server, {
    name: 'helpdesk_ticket_count_by_phrase',
    description:
      'Count helpdesk tickets whose (subject, description) matches a phrase, bucketed by hour/day/week over a rolling window. Live tsvector query over tickets.search_vector with a 5s server-side statement_timeout. window.since is REQUIRED; window.until defaults to now(). Optional status_filter narrows to a single ticket status. Results are exact, not approximate.',
    input: {
      phrase: z
        .string()
        .min(1)
        .max(500)
        .describe('Phrase to match. Passed through plainto_tsquery; tsquery operators are neutralized.'),
      buckets: bucketEnum.describe('Bucket granularity'),
      window: windowShape,
      status_filter: z
        .enum([
          'open',
          'in_progress',
          'waiting_on_customer',
          'resolved',
          'closed',
        ])
        .optional()
        .describe('Optional ticket status filter'),
    },
    returns: responseShape,
    handler: async ({ phrase, buckets, window, status_filter }) => {
      const qs = new URLSearchParams();
      qs.set('phrase', phrase);
      qs.set('buckets', buckets);
      qs.set('since', window.since);
      if (window.until) qs.set('until', window.until);
      if (status_filter) qs.set('status', status_filter);
      const url = `${trim(urls.helpdeskApiUrl)}/v1/tickets/analytics/count-by-phrase?${qs.toString()}`;
      try {
        const res = await fetch(url, { method: 'GET', headers: headers(api) });
        // Tolerate empty (204 No Content) and non-JSON bodies so DELETE/204 tools
        // report success instead of throwing "Unexpected end of JSON input".
        const __text = await res.text();
        let data: unknown = null;
        if (__text) {
          try {
            data = JSON.parse(__text);
          } catch {
            data = __text;
          }
        }
        if (!res.ok) return errEnvelope('helpdesk_ticket_count_by_phrase failed', data);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return errEnvelope(
          'helpdesk_ticket_count_by_phrase network error',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  });

  registerTool(server, {
    name: 'bam_task_count_by_phrase',
    description:
      "Count Bam tasks whose (title, description_plain) matches a phrase, bucketed by hour/day/week over a rolling window. Live tsvector query scoped to the caller's active org; optional label_filter and project_filter narrow further. window.since is REQUIRED; window.until defaults to now(). 5s server-side statement_timeout. Results are exact, not approximate.",
    input: {
      phrase: z.string().min(1).max(500),
      buckets: bucketEnum,
      window: windowShape,
      label_filter: z
        .array(z.string().uuid())
        .max(100)
        .optional()
        .describe('Optional list of label UUIDs; matches ANY'),
      project_filter: z
        .array(z.string().uuid())
        .max(100)
        .optional()
        .describe("Optional list of project UUIDs; every id is verified to live in the caller's org"),
    },
    returns: responseShape,
    handler: async ({ phrase, buckets, window, label_filter, project_filter }) => {
      const qs = new URLSearchParams();
      qs.set('phrase', phrase);
      qs.set('buckets', buckets);
      qs.set('since', window.since);
      if (window.until) qs.set('until', window.until);
      if (label_filter && label_filter.length > 0) {
        qs.set('labels', label_filter.join(','));
      }
      if (project_filter && project_filter.length > 0) {
        qs.set('projects', project_filter.join(','));
      }
      const url = `${trim(urls.apiUrl)}/v1/tasks/analytics/count-by-phrase?${qs.toString()}`;
      try {
        const res = await fetch(url, { method: 'GET', headers: headers(api) });
        // Tolerate empty / non-JSON bodies (consistency with the hardened clients).
        const __text = await res.text();
        let data: unknown = null;
        if (__text) {
          try {
            data = JSON.parse(__text);
          } catch {
            data = __text;
          }
        }
        if (!res.ok) return errEnvelope('bam_task_count_by_phrase failed', data);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return errEnvelope(
          'bam_task_count_by_phrase network error',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  });
}
