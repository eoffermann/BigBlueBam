import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';
import {
  FINGERPRINT_WINDOW_MAX_SECONDS,
  WindowTooLargeError,
  type FingerprintStore,
} from '../lib/fingerprint-store.js';

/**
 * Ingest-time deduplication MCP tool (AGENTIC_TODO §19, Wave 5).
 *
 * Tools:
 *   - ingest_fingerprint_check - atomic SET NX EX against a Redis key
 *     scoped to (org_id, source, fingerprint). Returns first_seen=true if
 *     the caller is the first to submit this fingerprint in the window;
 *     returns first_seen=false with seen_at + ttl_remaining otherwise.
 *
 * Org scoping: the org_id comes from /auth/me on the caller's session. The
 * tool errors if the caller has no resolvable org (e.g. token is stale).
 *
 * Window cap: window_seconds is hard-capped at 3600 (1 hour). Intake flows
 * that need longer dedup windows should store a persistent fingerprint row
 * instead of relying on Redis TTL.
 */

interface AuthMeResponse {
  data?: {
    id?: string;
    org_id?: string;
    active_org_id?: string;
  };
}

async function resolveCallerOrgId(api: ApiClient): Promise<string | null> {
  const res = await api.get<AuthMeResponse>('/auth/me');
  if (!res.ok) return null;
  const d = res.data?.data;
  return d?.active_org_id ?? d?.org_id ?? null;
}

export function registerIngestFingerprintTools(
  server: McpServer,
  api: ApiClient,
  store: FingerprintStore,
): void {
  registerTool(server, {
    name: 'ingest_fingerprint_check',
    description:
      "Atomic dedup check for intake flows (forms, tickets, leads). Hashes the incoming payload into a fingerprint; the tool records it under (org_id, source, fingerprint) with the given TTL and reports whether this is the first sighting. Backed by Redis SET NX EX, one round-trip. Use before creating downstream entities to avoid duplicate ticket / lead / agent responses when a sender retries. window_seconds is capped at 3600 (1 hour). Callers should canonicalize the payload (lowercase, collapse whitespace, strip quoted reply text) before hashing.",
    input: {
      source: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Intake source identifier (e.g. 'helpdesk_email', 'blank_form', 'bond_webform'). Used as a key namespace so unrelated flows don't collide.",
        ),
      fingerprint: z
        .string()
        .min(8)
        .max(256)
        .describe(
          'Hex or base64 digest of the canonicalized payload. Callers typically SHA-256 the body; any stable short-ish string works.',
        ),
      window_seconds: z
        .number()
        .int()
        .min(1)
        .max(FINGERPRINT_WINDOW_MAX_SECONDS)
        .describe(
          'Dedup window in seconds. Capped at 3600. Typical values: 60 for email bursts, 300 for form spam, 600 for slow-retry webhooks.',
        ),
      context: z
        .record(z.unknown())
        .optional()
        .describe(
          'Free-form context for audit logging (subject line, sender email, etc.). Not persisted in the Redis key.',
        ),
    },
    returns: z.object({
      first_seen: z.boolean(),
      seen_at: z.string().optional(),
      window_seconds: z.number().int(),
      ttl_remaining: z.number().int().optional(),
      note: z.literal('redis_unavailable').optional(),
    }),
    handler: async ({ source, fingerprint, window_seconds }) => {
      const orgId = await resolveCallerOrgId(api);
      if (!orgId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error checking ingest fingerprint: ${JSON.stringify({ error: 'Unable to resolve caller org_id from /auth/me' })}`,
            },
          ],
          isError: true as const,
        };
      }

      try {
        const result = await store.checkAndSet(orgId, source, fingerprint, window_seconds);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof WindowTooLargeError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error checking ingest fingerprint: ${JSON.stringify({
                  error: err.message,
                  code: 'WINDOW_TOO_LARGE',
                  status: 400,
                })}`,
              },
            ],
            isError: true as const,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error checking ingest fingerprint: ${JSON.stringify({ error: (err as Error).message ?? 'unknown' })}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  });
}
