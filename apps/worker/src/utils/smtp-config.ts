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
  isSmtpConfigured as _isSmtpConfigured,
  type ResolvedSmtpConfig,
} from '@bigbluebam/smtp-resolver';
import type { Env } from '../env.js';

export { clearSmtpConfigCache } from '@bigbluebam/smtp-resolver';
export type { ResolvedSmtpConfig } from '@bigbluebam/smtp-resolver';
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
