/**
 * Shared SMTP config resolver. Two callers — api and worker — both need
 * to know "is there SMTP configured anywhere?" with EXACTLY the same
 * precedence rules. Historical drift between the api's env-only check
 * and the worker's DB+env check was the root cause of an invitation-
 * email bug where the api reported `email_sent: false` even when the
 * worker actually delivered the message.
 *
 * Design: the package is pure logic — it does NOT do its own DB query
 * (the two consumers run different drizzle-orm versions, which can't
 * share a `sql` builder at the type level). Each caller loads the
 * `smtp_*` rows from `system_settings` itself and passes a plain
 * `Record<string, unknown>` of {key → value} in. The resolver does the
 * precedence math, validation, and caching.
 *
 * Precedence per key:
 *   1. system_settings row (smtp_host / smtp_port / smtp_user /
 *      smtp_password / smtp_from / smtp_secure)
 *   2. Environment variable (SMTP_HOST / SMTP_PORT / SMTP_USER /
 *      SMTP_PASS / EMAIL_FROM)
 *
 * If host is missing in BOTH, the resolver returns null — the platform
 * cannot deliver email and callers should reflect that to users.
 *
 * Caching: in-process for 30s keyed on the host process. The
 * `clearSmtpConfigCache()` helper drops the cache so a setting that was
 * just edited reflects immediately on the next call (the route handler
 * for `PUT /system-settings/:key` should call it).
 */

// ─── Public types ─────────────────────────────────────────────────────

export interface SmtpEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  EMAIL_FROM?: string;
}

export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
  from: string;
  secure: boolean;
  source: 'db' | 'env' | 'mixed';
}

/**
 * `loadSettings` does the actual postgres read. Each caller wires it
 * to its own drizzle instance so the package itself stays version-
 * agnostic. The function must return a flat {key → value} map where
 * value is whatever the driver gave back (already-parsed JSON, a
 * JSON string, a number, a boolean, …). The resolver handles all
 * those shapes.
 */
export type SmtpSettingsLoader = () => Promise<Record<string, unknown>>;

const CACHE_TTL_MS = 30_000;
const FALLBACK_PORT = 587;
const FALLBACK_FROM = 'noreply@bigbluebam.com';
const SMTP_KEYS = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_password',
  'smtp_from',
  'smtp_secure',
] as const;
export const SMTP_SETTING_KEYS: readonly string[] = SMTP_KEYS;

let cache: { value: ResolvedSmtpConfig | null; expiresAt: number } | null = null;

export function clearSmtpConfigCache(): void {
  cache = null;
}

// ─── Internal helpers ─────────────────────────────────────────────────

function parseStringOrNumberToInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/**
 * The `value` column on `system_settings` is JSONB; depending on the
 * driver/route the caller went through, the value can arrive as the
 * already-parsed object/primitive OR as a JSON-encoded string. Both
 * shapes are handled here so the consumer doesn't have to care.
 */
function normalizeRow(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Resolve the effective SMTP config from already-loaded settings + env.
 * Pure function — no I/O, no caching. Use this when you have the
 * settings in hand and just need the precedence math. The cached entry
 * point is `getSmtpConfig` below.
 */
export function resolveSmtpFromSettings(
  settings: Record<string, unknown>,
  env: SmtpEnv,
): ResolvedSmtpConfig | null {
  const dbHost =
    typeof settings.smtp_host === 'string' ? settings.smtp_host : null;
  const dbPortRaw = normalizeRow(settings.smtp_port);
  const dbPort = parseStringOrNumberToInt(dbPortRaw);
  const dbUser =
    typeof settings.smtp_user === 'string' ? settings.smtp_user : null;
  const dbPass =
    typeof settings.smtp_password === 'string' ? settings.smtp_password : null;
  const dbFrom =
    typeof settings.smtp_from === 'string' ? settings.smtp_from : null;
  const dbSecureRaw = normalizeRow(settings.smtp_secure);
  const dbSecure = parseBoolean(dbSecureRaw);

  const host = dbHost ?? env.SMTP_HOST ?? null;
  if (!host) return null;

  const port = dbPort ?? env.SMTP_PORT ?? FALLBACK_PORT;
  const user = dbUser ?? env.SMTP_USER ?? null;
  const pass = dbPass ?? env.SMTP_PASS ?? null;
  const from = dbFrom ?? env.EMAIL_FROM ?? FALLBACK_FROM;
  const secure = dbSecure ?? port === 465;

  const anyFromDb = Boolean(
    dbHost || dbPort !== null || dbUser || dbPass || dbFrom || dbSecure !== null,
  );
  const anyFromEnv = Boolean(env.SMTP_HOST || env.SMTP_USER || env.SMTP_PASS);
  let source: ResolvedSmtpConfig['source'] = 'env';
  if (anyFromDb && !anyFromEnv) source = 'db';
  else if (anyFromDb && anyFromEnv) source = 'mixed';

  return { host, port, user, pass, from, secure, source };
}

/**
 * Cached + loader-driven resolver. Calls `loadSettings()` once per TTL
 * to grab the smtp_* rows, then runs the precedence math. Returns null
 * when no host is available anywhere.
 */
export async function getSmtpConfig(
  loadSettings: SmtpSettingsLoader,
  env: SmtpEnv,
): Promise<ResolvedSmtpConfig | null> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  let settings: Record<string, unknown> = {};
  try {
    settings = await loadSettings();
  } catch {
    // Don't crash on a transient DB blip; fall through to env-only.
  }
  const resolved = resolveSmtpFromSettings(settings, env);
  cache = { value: resolved, expiresAt: now + CACHE_TTL_MS };
  return resolved;
}

/**
 * Cheap "is there any usable SMTP at all?" probe. Same cache as
 * `getSmtpConfig`. Use this where a route only needs a yes/no — e.g.
 * when telling the client whether the platform will actually deliver
 * an email that was just enqueued.
 */
export async function isSmtpConfigured(
  loadSettings: SmtpSettingsLoader,
  env: SmtpEnv,
): Promise<boolean> {
  const cfg = await getSmtpConfig(loadSettings, env);
  return cfg !== null && Boolean(cfg.host);
}
