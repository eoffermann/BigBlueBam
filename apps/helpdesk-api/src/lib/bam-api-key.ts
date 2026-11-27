// Bam user/service API keys (`Authorization: Bearer bbam_...`) on helpdesk-api.
//
// Every other *-api in the suite accepts a bbam_ key as a Bearer token; the
// helpdesk admin guard (lib/admin-auth.ts) only accepted a Bam session cookie
// or a per-agent X-Agent-Key. The MCP server authenticates every tool call
// with the caller's bbam_ key and forwards it as Bearer, so the helpdesk
// settings tools and helpdesk_ticket_count_by_phrase were 401 for every
// caller (#325). This verifies the key with the same rules as
// apps/api/src/plugins/auth.ts:
//   - candidates indexed by the 8-char key_prefix, Argon2id-verified;
//   - more than 3 candidates for a random prefix collapses to the first (DoS
//     guard); the shared 'bbam_svc' service-account bucket is exempt, up to 64;
//   - argon2.verify always runs before the expiry check (no timing oracle);
//   - an expired key still authenticates inside its rotation grace window;
//   - the owning user must be active.
// It returns the key's org (api keys are pinned to one org) and scope; the
// caller decides authorization.

import type { FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { db } from '../db/index.js';

export interface BamApiKeyCaller {
  userId: string;
  /** api_keys.org_id: the org this key is pinned to. */
  keyOrgId: string | null;
  /** 'read' | 'read_write' | 'admin' */
  scope: string;
  isSuperuser: boolean;
}

const SVC_KEY_PREFIX = 'bbam_svc';
const SVC_BUCKET_MAX = 64;

function rowsOf(raw: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as Array<
    Record<string, unknown>
  >;
}

/** The bearer token from an Authorization header, when it is a bbam_ key. */
export function bamBearerToken(request: FastifyRequest): string | null {
  const h = request.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  return token.startsWith('bbam_') && token.length > 8 ? token : null;
}

export async function verifyBamApiKey(request: FastifyRequest, token: string): Promise<BamApiKeyCaller | null> {
  const prefix = token.slice(0, 8);
  const isSvcBucket = prefix === SVC_KEY_PREFIX;
  const candidates = rowsOf(
    await db.execute(sql`
      SELECT k.id, k.key_hash, k.org_id, k.scope, k.expires_at, k.rotated_at,
             k.rotation_grace_expires_at, u.id AS user_id, u.is_active, u.is_superuser
        FROM api_keys k
        JOIN users u ON u.id = k.user_id
       WHERE k.key_prefix = ${prefix}
       LIMIT ${isSvcBucket ? SVC_BUCKET_MAX : 10}
    `),
  );

  const verify = !isSvcBucket && candidates.length > 3 ? candidates.slice(0, 1) : candidates;
  if (!isSvcBucket && candidates.length > 3) {
    request.log.warn(
      { prefix, candidate_count: candidates.length },
      'Suspicious number of API key candidates for prefix; limiting to first candidate',
    );
  }

  const now = new Date();
  for (const c of verify) {
    let valid = false;
    try {
      valid = await argon2.verify(String(c.key_hash), token);
    } catch (err) {
      request.log.warn({ err, api_key_id: c.id }, 'argon2.verify threw on api key candidate; treating as invalid');
    }
    if (c.expires_at && new Date(c.expires_at as string) < now) {
      const inGrace =
        c.rotated_at && c.rotation_grace_expires_at && new Date(c.rotation_grace_expires_at as string) > now;
      if (!inGrace) continue;
    }
    if (!valid || c.is_active !== true) continue;

    db.execute(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${c.id as string}`).catch((err: unknown) => {
      request.log.warn({ err }, 'Failed to update api_keys.last_used_at');
    });
    return {
      userId: String(c.user_id),
      keyOrgId: (c.org_id as string | null) ?? null,
      scope: String(c.scope ?? 'read'),
      isSuperuser: c.is_superuser === true,
    };
  }
  return null;
}
