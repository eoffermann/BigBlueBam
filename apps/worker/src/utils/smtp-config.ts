// Thin wrapper that wires the worker's drizzle instance into the shared
// SMTP resolver in @bigbluebam/smtp-resolver. The shared package is the
// single source of truth for "where do SMTP creds come from?" so the api
// and the worker can NEVER disagree about whether the platform can
// deliver email — drift between them was the root cause of the 2026-
// 06-11 invitation-email "SMTP not configured" false negative.

import { sql } from 'drizzle-orm';
import {
  SMTP_SETTING_KEYS,
  clearSmtpConfigCache as _clearSmtpConfigCache,
  getSmtpConfig as _getSmtpConfig,
  getSmtpConfigForOrg as _getSmtpConfigForOrg,
  isSmtpConfigured as _isSmtpConfigured,
  type OrgSmtpOverride,
  type ResolvedSmtpConfig,
  type ResolvedSmtpConfigWithLayer,
} from '@bigbluebam/smtp-resolver';
import type { Env } from '../env.js';

export { clearSmtpConfigCache, clearOrgSmtpConfigCache } from '@bigbluebam/smtp-resolver';
export type { ResolvedSmtpConfig, ResolvedSmtpConfigWithLayer } from '@bigbluebam/smtp-resolver';
void _clearSmtpConfigCache;

/** Subset of Env the shared resolver needs. */
function toSmtpEnv(env: Env) {
  return {
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    EMAIL_FROM: env.EMAIL_FROM,
  };
}

/**
 * Builds the loader the shared resolver will call to read smtp_* rows.
 * Kept as a closure so we never carry a stale drizzle instance across
 * worker lifecycles.
 */
function makeLoader(db: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) {
  return async (): Promise<Record<string, unknown>> => {
    try {
      const result = await db.execute(
        sql`SELECT key, value FROM system_settings WHERE key IN (${sql.join(
          SMTP_SETTING_KEYS.map((k) => sql`${k}`),
          sql`, `,
        )})`,
      );
      const rows = Array.isArray(result)
        ? (result as Array<{ key: string; value: unknown }>)
        : (((result as { rows?: Array<{ key: string; value: unknown }> }).rows) ?? []);
      const out: Record<string, unknown> = {};
      for (const r of rows) {
        if (!r || typeof r !== 'object' || typeof r.key !== 'string') continue;
        out[r.key] = r.value;
      }
      return out;
    } catch {
      return {};
    }
  };
}

export async function getSmtpConfig(
  db: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  env: Env,
): Promise<ResolvedSmtpConfig | null> {
  return _getSmtpConfig(makeLoader(db), toSmtpEnv(env));
}

export async function isSmtpConfigured(
  db: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  env: Env,
): Promise<boolean> {
  return _isSmtpConfigured(makeLoader(db), toSmtpEnv(env));
}

/**
 * Builds the loader that reads ONE org's `settings.smtp` override out of the
 * organizations table. Returns null when the org has no override (or the
 * read fails), which makes the resolver fall straight through to the
 * platform layer. The org's `settings` column is JSONB, so the `smtp`
 * sub-object is already-parsed by the driver.
 */
function makeOrgLoader(db: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) {
  return async (orgId: string): Promise<OrgSmtpOverride | null> => {
    try {
      const result = await db.execute(
        sql`SELECT settings -> 'smtp' AS smtp FROM organizations WHERE id = ${orgId} LIMIT 1`,
      );
      const rows = Array.isArray(result)
        ? (result as Array<{ smtp: unknown }>)
        : (((result as { rows?: Array<{ smtp: unknown }> }).rows) ?? []);
      const raw = rows[0]?.smtp;
      if (!raw || typeof raw !== 'object') return null;
      return raw as OrgSmtpOverride;
    } catch {
      return null;
    }
  };
}

/**
 * Resolve the effective SMTP config for a specific org, layering the org's
 * own override over the platform singleton over the env vars. This is the
 * entry point every org-scoped send path (Blast campaigns, org invitations)
 * should use so a tenant that configured its own relay gets it, and everyone
 * else falls back to the platform relay.
 */
export async function getSmtpConfigForOrg(
  db: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  orgId: string,
  env: Env,
): Promise<ResolvedSmtpConfigWithLayer | null> {
  return _getSmtpConfigForOrg(orgId, makeOrgLoader(db), makeLoader(db), toSmtpEnv(env));
}
