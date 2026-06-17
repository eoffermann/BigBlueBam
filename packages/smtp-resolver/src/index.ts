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
 * The shape an organization stores in `organizations.settings.smtp` when it
 * configures its own relay. Every field is optional: an org can leave a
 * field blank to inherit it from the platform/env layers below. A missing
 * `host` means "no org override at all", so the resolver falls straight
 * through to the platform layer.
 *
 * The org-level resolution is its own precedence ladder, evaluated by
 * `resolveSmtpHierarchy`:
 *   1. per-org override (organizations.settings.smtp)
 *   2. platform singleton (system_settings smtp_* rows)
 *   3. environment variables (SMTP_HOST / SMTP_PORT / …)
 */
export interface OrgSmtpOverride {
  host?: string | null;
  port?: number | string | null;
  user?: string | null;
  password?: string | null;
  from?: string | null;
  secure?: boolean | string | null;
}

/** Where the EFFECTIVE config came from once org/platform/env are layered. */
export type SmtpResolutionLayer = 'org' | 'platform' | 'env';

export interface ResolvedSmtpConfigWithLayer extends ResolvedSmtpConfig {
  /**
   * Which layer supplied the host. `org` = the org's own relay won;
   * `platform`/`env` = the org has no override and we fell through to the
   * platform singleton (whose own `source` field still says db/env/mixed).
   */
  layer: SmtpResolutionLayer;
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
 *
 * Every value runs through `normalizeRow` first to peel a potential
 * JSON-string wrapper. The system_settings PUT handler stringifies
 * everything it stores via `JSON.stringify`, and depending on the
 * driver/column config the read can come back as the already-parsed
 * primitive OR as the raw stringified form. Without the peel a host
 * of "smtp.example.com" arrives as the literal six-byte string
 * `"smtp.example.com"` (quotes included), nodemailer hands that to
 * DNS, and you get `queryA EBADNAME "smtp.example.com"` in worker
 * logs — the exact crash that the Railway worker hit before this
 * fix landed.
 */
export function resolveSmtpFromSettings(
  settings: Record<string, unknown>,
  env: SmtpEnv,
): ResolvedSmtpConfig | null {
  const rawHost = normalizeRow(settings.smtp_host);
  const dbHost = typeof rawHost === 'string' && rawHost.length > 0 ? rawHost : null;
  const dbPort = parseStringOrNumberToInt(normalizeRow(settings.smtp_port));
  const rawUser = normalizeRow(settings.smtp_user);
  const dbUser = typeof rawUser === 'string' && rawUser.length > 0 ? rawUser : null;
  const rawPass = normalizeRow(settings.smtp_password);
  const dbPass = typeof rawPass === 'string' && rawPass.length > 0 ? rawPass : null;
  const rawFrom = normalizeRow(settings.smtp_from);
  const dbFrom = typeof rawFrom === 'string' && rawFrom.length > 0 ? rawFrom : null;
  const dbSecure = parseBoolean(normalizeRow(settings.smtp_secure));

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

// ─── Org → platform → env hierarchy ───────────────────────────────────

/**
 * Normalize an org override into a fully-resolved config, or null when the
 * org has no usable host of its own. An override with no host (or only
 * blank/whitespace host) is treated as "no override" so the caller falls
 * through to the platform layer.
 *
 * When the org sets `host` but leaves other fields blank, those individual
 * fields still fall back to the platform/env config the caller passes as
 * `fallback`. That mirrors how the platform layer mixes DB host with env
 * user/pass — an org can point at its own relay host while inheriting, say,
 * the platform From address.
 */
function resolveOrgOverride(
  override: OrgSmtpOverride | null | undefined,
  fallback: ResolvedSmtpConfig | null,
): ResolvedSmtpConfig | null {
  if (!override) return null;
  const rawHost = normalizeRow(override.host);
  const host = typeof rawHost === 'string' && rawHost.trim().length > 0 ? rawHost.trim() : null;
  if (!host) return null;

  const port =
    parseStringOrNumberToInt(normalizeRow(override.port)) ??
    fallback?.port ??
    FALLBACK_PORT;
  const rawUser = normalizeRow(override.user);
  const user =
    typeof rawUser === 'string' && rawUser.length > 0 ? rawUser : (fallback?.user ?? null);
  const rawPass = normalizeRow(override.password);
  const pass =
    typeof rawPass === 'string' && rawPass.length > 0 ? rawPass : (fallback?.pass ?? null);
  const rawFrom = normalizeRow(override.from);
  const from =
    typeof rawFrom === 'string' && rawFrom.length > 0
      ? rawFrom
      : (fallback?.from ?? FALLBACK_FROM);
  const secure = parseBoolean(normalizeRow(override.secure)) ?? fallback?.secure ?? port === 465;

  return { host, port, user, pass, from, secure, source: 'db' };
}

/**
 * Layer org → platform → env and return the effective config plus which
 * layer won the host. Pure function — no I/O. Callers load the org override
 * (organizations.settings.smtp) and the platform smtp_* rows themselves.
 *
 *   1. If the org has its own relay host, that wins (layer 'org').
 *   2. Otherwise the platform singleton + env precedence applies, exactly
 *      as `resolveSmtpFromSettings` does today (layer 'platform' when the
 *      platform DB contributed, 'env' when only env vars did).
 *   3. Returns null only when NO layer has a host.
 */
export function resolveSmtpHierarchy(
  orgOverride: OrgSmtpOverride | null | undefined,
  platformSettings: Record<string, unknown>,
  env: SmtpEnv,
): ResolvedSmtpConfigWithLayer | null {
  const platform = resolveSmtpFromSettings(platformSettings, env);

  const org = resolveOrgOverride(orgOverride, platform);
  if (org) return { ...org, layer: 'org' };

  if (!platform) return null;
  const layer: SmtpResolutionLayer = platform.source === 'env' ? 'env' : 'platform';
  return { ...platform, layer };
}

/**
 * Loader that returns a single org's SMTP override object (the
 * `organizations.settings.smtp` sub-object) or null/undefined when the org
 * has none. Each caller wires it to its own drizzle instance.
 */
export type OrgSmtpLoader = (orgId: string) => Promise<OrgSmtpOverride | null | undefined>;

// Per-org cache. Keyed by org id so two orgs sending concurrently never
// see each other's relay. Same 30s TTL as the platform cache.
const orgCache = new Map<string, { value: ResolvedSmtpConfigWithLayer | null; expiresAt: number }>();

/** Drop the cached org config(s). Pass an org id to clear just one. */
export function clearOrgSmtpConfigCache(orgId?: string): void {
  if (orgId) orgCache.delete(orgId);
  else orgCache.clear();
}

/**
 * Cached org-aware resolver. Reads the org override + the platform smtp_*
 * rows once per TTL and layers them. Returns null when no layer has a host.
 */
export async function getSmtpConfigForOrg(
  orgId: string,
  loadOrgOverride: OrgSmtpLoader,
  loadPlatformSettings: SmtpSettingsLoader,
  env: SmtpEnv,
): Promise<ResolvedSmtpConfigWithLayer | null> {
  const now = Date.now();
  const cached = orgCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.value;

  let override: OrgSmtpOverride | null | undefined;
  let platformSettings: Record<string, unknown> = {};
  try {
    override = await loadOrgOverride(orgId);
  } catch {
    override = null;
  }
  try {
    platformSettings = await loadPlatformSettings();
  } catch {
    // Fall through to env-only on a transient DB blip.
  }
  const resolved = resolveSmtpHierarchy(override, platformSettings, env);
  orgCache.set(orgId, { value: resolved, expiresAt: now + CACHE_TTL_MS });
  return resolved;
}
