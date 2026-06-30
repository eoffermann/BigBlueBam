/**
 * Ingest-key lifecycle (Blip §10, §15). A key is a write-only credential for one
 * tracked app: the full token (blip_<key_id>_<secret>) is shown exactly once at
 * creation and never again; only an HMAC of the secret is stored. Suspend is
 * reversible, revoke is terminal. Every mutation here changes the
 * `(status / rate-limit)` the ingest edge caches, so the ROUTE busts the Redis
 * key cache after calling these (services have no Redis handle).
 */
import { and, eq, desc } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { blipIngestKeys } from '../db/schema/index.js';
import { mintKey } from '../lib/ingest-keys.js';
import { env } from '../env.js';
import { NotFoundError, ConflictError } from './errors.js';
import { getApp } from './app.service.js';

// Columns safe to return to a client — never the secret_hmac.
const PUBLIC_COLS = {
  id: blipIngestKeys.id,
  org_id: blipIngestKeys.org_id,
  tracked_app_id: blipIngestKeys.tracked_app_id,
  key_id: blipIngestKeys.key_id,
  last4: blipIngestKeys.last4,
  fingerprint: blipIngestKeys.fingerprint,
  label: blipIngestKeys.label,
  status: blipIngestKeys.status,
  rate_limit_override: blipIngestKeys.rate_limit_override,
  created_by: blipIngestKeys.created_by,
  created_at: blipIngestKeys.created_at,
  last_used_at: blipIngestKeys.last_used_at,
  suspended_at: blipIngestKeys.suspended_at,
};

/** Mint a key. Returns the public row PLUS the one-time token. Emits key.created. */
export async function createKey(appId: string, orgId: string, userId: string, label?: string | null) {
  await getApp(appId, orgId); // 404 if the app is not in this org
  const minted = mintKey(env.BLIP_INGEST_PEPPER);
  const rows = await db
    .insert(blipIngestKeys)
    .values({
      org_id: orgId,
      tracked_app_id: appId,
      key_id: minted.keyId,
      secret_hmac: minted.secretHmac,
      last4: minted.last4,
      fingerprint: minted.fingerprint,
      label: label ?? null,
      status: 'active',
      created_by: userId,
    })
    .returning(PUBLIC_COLS);
  const key = rows[0]!;
  void publishBoltEvent(
    'key.created',
    'blip',
    { tracked_app_id: appId, key_id: key.key_id, label: key.label },
    orgId,
    userId,
  );
  return { ...key, token: minted.token };
}

/** List an app's keys. Never returns the secret. */
export async function listKeys(appId: string, orgId: string) {
  await getApp(appId, orgId);
  return db
    .select(PUBLIC_COLS)
    .from(blipIngestKeys)
    .where(and(eq(blipIngestKeys.tracked_app_id, appId), eq(blipIngestKeys.org_id, orgId)))
    .orderBy(desc(blipIngestKeys.created_at));
}

/** Fetch one key (public columns, never the secret). 404 if not in this org. */
export async function getKey(id: string, orgId: string) {
  const rows = await db
    .select(PUBLIC_COLS)
    .from(blipIngestKeys)
    .where(and(eq(blipIngestKeys.id, id), eq(blipIngestKeys.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Ingest key not found');
  return rows[0]!;
}

async function getKeyRow(id: string, orgId: string) {
  const rows = await db
    .select()
    .from(blipIngestKeys)
    .where(and(eq(blipIngestKeys.id, id), eq(blipIngestKeys.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Ingest key not found');
  return rows[0]!;
}

/**
 * Suspend (reversible) or resume a key. Revoked keys are terminal and cannot be
 * toggled. Emits key.suspended on the suspend transition. Returns the public row.
 */
export async function toggleSuspend(id: string, orgId: string, userId: string) {
  const current = await getKeyRow(id, orgId);
  if (current.status === 'revoked') {
    throw new ConflictError('Key is revoked and cannot be suspended or resumed');
  }
  const suspending = current.status === 'active';
  const rows = await db
    .update(blipIngestKeys)
    .set({
      status: suspending ? 'suspended' : 'active',
      suspended_at: suspending ? new Date() : null,
    })
    .where(and(eq(blipIngestKeys.id, id), eq(blipIngestKeys.org_id, orgId)))
    .returning(PUBLIC_COLS);
  const key = rows[0]!;
  if (suspending) {
    void publishBoltEvent(
      'key.suspended',
      'blip',
      { tracked_app_id: key.tracked_app_id, key_id: key.key_id },
      orgId,
      userId,
    );
  }
  return key;
}

/** Revoke a key (terminal). Emits key.revoked. Returns the public row. */
export async function revokeKey(id: string, orgId: string, userId: string) {
  const current = await getKeyRow(id, orgId);
  if (current.status === 'revoked') {
    throw new ConflictError('Key is already revoked');
  }
  const rows = await db
    .update(blipIngestKeys)
    .set({ status: 'revoked' })
    .where(and(eq(blipIngestKeys.id, id), eq(blipIngestKeys.org_id, orgId)))
    .returning(PUBLIC_COLS);
  const key = rows[0]!;
  void publishBoltEvent(
    'key.revoked',
    'blip',
    { tracked_app_id: key.tracked_app_id, key_id: key.key_id },
    orgId,
    userId,
  );
  return key;
}

export interface UpdateKeyInput {
  label?: string | null;
  rate_limit_override?: Record<string, unknown> | null;
}

/** Edit a key's label / per-key rate-limit override. Returns the public row. */
export async function updateKey(id: string, orgId: string, input: UpdateKeyInput) {
  const patch: Record<string, unknown> = {};
  if (input.label !== undefined) patch.label = input.label;
  if (input.rate_limit_override !== undefined) patch.rate_limit_override = input.rate_limit_override;
  if (Object.keys(patch).length === 0) return getKey(id, orgId);
  const rows = await db
    .update(blipIngestKeys)
    .set(patch)
    .where(and(eq(blipIngestKeys.id, id), eq(blipIngestKeys.org_id, orgId)))
    .returning(PUBLIC_COLS);
  if (rows.length === 0) throw new NotFoundError('Ingest key not found');
  return rows[0]!;
}
