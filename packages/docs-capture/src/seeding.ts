/**
 * Content evaluation + seeding (the spec's three-tier precedence).
 *
 * The local dev stack is already broadly seeded (scripts/seed-all.mjs), so most
 * recipes capture existing realistic data and need NO bespoke seeding. When a
 * recipe declares `content`, a fixture builder keyed by `content.kind` decides
 * whether the target view is already populated enough (`isSatisfied`) and, if
 * not (or if `force_seed`), creates the data idempotently.
 *
 * Tier precedence inside a builder (most-honest first):
 *   1. Suite REST API / MCP tools — create data the way a real user would.
 *      Builders use the AUTHENTICATED Playwright request context, so calls
 *      carry the same session as the capture.
 *   2. App UI flows via Playwright — when no API path exists for the state.
 *   3. Direct Postgres seed (local only) — last resort, via `sqlSeed`.
 *
 * All seeded data is namespaced under the run's `workspaceSlug` so it never
 * collides with real data and can be torn down cleanly.
 */

import { execFileSync } from 'node:child_process';
import type { APIRequestContext, Page } from 'playwright';
import type { Content } from './recipe.js';

export interface SeedContext {
  /** Authenticated request context (carries the capture session's cookies). */
  api: APIRequestContext;
  /** The authenticated page (for UI-tier seeding). */
  page: Page;
  baseUrl: string;
  /** Namespaced workspace/org slug all seeded data must live under. */
  workspaceSlug: string;
  /** The recipe's `content.spec` (builder-specific shape). */
  spec: Record<string, unknown>;
  /** Identity name the capture is acting as. */
  identity: string;
}

export interface FixtureBuilder {
  /** Matches `content.kind`. */
  kind: string;
  /**
   * Is the target view already populated enough to demonstrate the feature?
   * Return true to skip seeding. Default (omitted) = always seed.
   */
  isSatisfied?: (ctx: SeedContext) => Promise<boolean>;
  /** Create the data idempotently (upsert by stable id). */
  seed: (ctx: SeedContext) => Promise<void>;
}

const registry = new Map<string, FixtureBuilder>();

/** Register a fixture builder (call at module load). */
export function registerFixture(builder: FixtureBuilder): void {
  registry.set(builder.kind, builder);
}

export function getFixture(kind: string): FixtureBuilder | undefined {
  return registry.get(kind);
}

export interface EnsureResult {
  status: 'skipped-already-populated' | 'seeded' | 'no-builder' | 'no-content';
  detail?: string;
}

/**
 * Ensure a recipe's content preconditions hold. Returns a status the runner
 * logs. `no-builder` is non-fatal: the recipe falls back to whatever the
 * already-seeded stack provides (and the run still captures).
 */
export async function ensureContent(content: Content | undefined, ctx: SeedContext): Promise<EnsureResult> {
  if (!content) return { status: 'no-content' };
  const builder = registry.get(content.kind);
  if (!builder) {
    return { status: 'no-builder', detail: `no fixture builder for kind "${content.kind}"; using existing stack data` };
  }
  if (!content.force_seed && builder.isSatisfied) {
    const ok = await builder.isSatisfied(ctx).catch(() => false);
    if (ok) return { status: 'skipped-already-populated' };
  }
  await builder.seed(ctx);
  return { status: 'seeded' };
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

/** Tier 1: authenticated JSON request against an app API (real-user path). */
export async function apiPost(ctx: SeedContext, urlPath: string, body: unknown): Promise<unknown> {
  const res = await ctx.api.post(`${ctx.baseUrl}${urlPath}`, { data: body });
  if (!res.ok()) {
    throw new Error(`seed apiPost ${urlPath} failed: ${res.status()} ${await res.text()}`);
  }
  return res.json().catch(() => ({}));
}

export async function apiGet(ctx: SeedContext, urlPath: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await ctx.api.get(`${ctx.baseUrl}${urlPath}`);
  const data = await res.json().catch(() => null);
  return { ok: res.ok(), status: res.status(), data };
}

/**
 * Tier 3 (LOCAL ONLY): run a SQL statement against the dockerized Postgres.
 * Guarded — refuses unless the environment is local. Base64-encodes the SQL to
 * dodge shell-quoting issues, mirroring the repo's prod-SQL convention.
 */
export function sqlSeed(sql: string, opts: { allowNonLocal?: boolean } = {}): void {
  const base = process.env.SHOTS_BASE_URL || 'http://localhost';
  const isLocal = base.includes('localhost') || base.includes('127.0.0.1');
  if (!isLocal && !opts.allowNonLocal) {
    throw new Error('sqlSeed is local-only; refusing to run direct SQL against a non-local stack');
  }
  const b64 = Buffer.from(sql, 'utf8').toString('base64');
  execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'sh', '-c', `echo ${b64} | base64 -d | psql -U bigbluebam -d bigbluebam`],
    { stdio: 'pipe' },
  );
}
