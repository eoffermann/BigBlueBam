// Bam user/service API keys (`Authorization: Bearer bbam_...`) on helpdesk-api.
//
// Every other *-api in the suite accepts a bbam_ key as a Bearer token; the
// helpdesk admin guard (lib/admin-auth.ts) only accepted a Bam session cookie
// or a per-agent X-Agent-Key. The MCP server authenticates every tool call
// with the caller's bbam_ key and forwards it as Bearer, so the helpdesk
// settings tools and helpdesk_ticket_count_by_phrase were 401 for every
// caller (#325).
//
// The verification rule (prefix lookup, Argon2id, DoS caps, the bbam_svc
// bucket, expiry and rotation grace, active owner) is @bigbluebam/auth-core's
// verifyApiKeyToken, the one every service in the suite uses (#340). This
// module binds it to helpdesk-api's db and returns the key's org (api keys are
// pinned to one org), scope and owner kind; the caller decides authorization.

import type { FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import {
  bearerToken,
  sqlApiKeyStore,
  verifyApiKeyToken,
  type ScopedUser,
  type UserKind,
} from '@bigbluebam/auth-core';
import { db } from '../db/index.js';

export interface BamApiKeyCaller {
  userId: string;
  /** api_keys.org_id: the org this key is pinned to. */
  keyOrgId: string | null;
  /** 'read' | 'read_write' | 'admin' */
  scope: string;
  isSuperuser: boolean;
  /** users.kind of the key's owner; service/agent keys are exempt from the org-role cap. */
  kind: UserKind;
}

const apiKeyStore = sqlApiKeyStore({
  sql,
  execute: (query) => db.execute(query),
  verifyHash: (hash, token) => argon2.verify(hash, token),
});

/** The bearer token from an Authorization header, when it is a bbam_ key. */
export function bamBearerToken(request: FastifyRequest): string | null {
  const token = bearerToken(request.headers.authorization);
  return token && token.startsWith('bbam_') && token.length > 8 ? token : null;
}

/**
 * The caller as @bigbluebam/auth-core's scope gate reads it (#351). `role` is the holder's
 * current role in the org the request acts in; pass '' where the gate needs no role.
 */
export function scopedUser(caller: BamApiKeyCaller, role = ''): ScopedUser {
  return {
    id: caller.userId,
    role,
    is_superuser: caller.isSuperuser,
    api_key_scope: caller.scope,
    kind: caller.kind,
  };
}

export async function verifyBamApiKey(request: FastifyRequest, token: string): Promise<BamApiKeyCaller | null> {
  const verified = await verifyApiKeyToken(token, apiKeyStore, request.log);
  if (!verified) return null;
  apiKeyStore.touch(verified.apiKey.id).catch((err: unknown) => {
    request.log.warn({ err }, 'Failed to update api_keys.last_used_at');
  });
  return {
    userId: verified.user.id,
    keyOrgId: verified.apiKey.org_id,
    scope: verified.apiKey.scope,
    isSuperuser: verified.user.is_superuser,
    kind: verified.user.kind,
  };
}
