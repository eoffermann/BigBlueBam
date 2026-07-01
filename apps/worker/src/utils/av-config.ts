/**
 * Effective AV-scan config resolver for the bin-av-scan job.
 *
 * The scan mode + clamav endpoint can be set two ways, in precedence order:
 *   1. SuperUser UI  -> system_settings rows ('av.scan_mode', 'av.clamav_host',
 *                       'av.clamav_port')
 *   2. env vars      -> BIN_AV_SCAN_MODE / CLAMAV_HOST / CLAMAV_PORT
 *
 * Reads system_settings via raw SQL the same way apps/worker/src/utils/
 * smtp-config.ts reads smtp_* rows, so env-only deploys keep working and a UI
 * change takes effect within the ~30s cache TTL without a worker restart.
 */

import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import type { Env } from '../env.js';

export type AvScanMode = 'off' | 'eicar' | 'clamav';

export interface ResolvedAvConfig {
  mode: AvScanMode;
  clamavHost: string | null;
  clamavPort: number;
}

const AV_SETTING_KEYS = ['av.scan_mode', 'av.clamav_host', 'av.clamav_port'] as const;
const TTL_MS = 30_000;

let cache: { at: number; value: ResolvedAvConfig } | null = null;

/** Clear the memoized config (tests / explicit invalidation). */
export function clearAvConfigCache(): void {
  cache = null;
}

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as T[];
}

/** system_settings values are JSONB (already-parsed by postgres-js). Coerce to
 *  the shapes the job needs, tolerating string forms. */
function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}
function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}
function asMode(v: unknown): AvScanMode | null {
  return v === 'off' || v === 'eicar' || v === 'clamav' ? v : null;
}

async function loadSettings(): Promise<Record<string, unknown>> {
  try {
    const db = getDb();
    const raw = await db.execute(
      sql`SELECT key, value FROM system_settings WHERE key IN (${sql.join(
        AV_SETTING_KEYS.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
    const out: Record<string, unknown> = {};
    for (const r of rowsOf<{ key: string; value: unknown }>(raw)) {
      if (r && typeof r.key === 'string') out[r.key] = r.value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve the effective AV config, layering system_settings over env. Memoized
 * for TTL_MS so a per-minute sweep does not hammer the settings table.
 */
export async function resolveAvConfig(env: Env, now = Date.now()): Promise<ResolvedAvConfig> {
  if (cache && now - cache.at < TTL_MS) return cache.value;

  const settings = await loadSettings();
  const mode = asMode(settings['av.scan_mode']) ?? env.BIN_AV_SCAN_MODE;
  const clamavHost = asString(settings['av.clamav_host']) ?? env.CLAMAV_HOST ?? null;
  const clamavPort = asInt(settings['av.clamav_port']) ?? env.CLAMAV_PORT;

  const value: ResolvedAvConfig = { mode, clamavHost, clamavPort };
  cache = { at: now, value };
  return value;
}
