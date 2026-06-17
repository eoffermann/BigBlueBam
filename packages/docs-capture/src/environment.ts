/**
 * Environment resolver.
 *
 * Resolves the base URL + seed-identity credentials for a capture run, in the
 * spec's priority order: local docker dev (default) → production (DEFERRED in
 * v1) → raw local fallback. Credentials are never hardcoded — they come from
 * env vars or a gitignored `screenshots.config.json` at the repo root.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface Identity {
  email: string;
  password: string;
}

export interface ResolvedEnvironment {
  /** "local-docker" | "raw-local" | "production". */
  name: string;
  /** Host base, e.g. "http://localhost". App routes carry their own prefix. */
  baseUrl: string;
  /** Named seed identities the recipes reference via `identity`. */
  identities: Record<string, Identity>;
  /** Namespaced workspace/org slug all seeded data lives under. */
  workspaceSlug: string;
}

const DEFAULT_LOCAL = 'http://localhost';

interface FileConfig {
  baseUrl?: string;
  workspaceSlug?: string;
  identities?: Record<string, Identity>;
}

function readFileConfig(): FileConfig {
  const p = path.resolve(process.cwd(), 'screenshots.config.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as FileConfig;
  } catch (err) {
    throw new Error(`Failed to parse screenshots.config.json: ${(err as Error).message}`);
  }
}

/** Probe a base URL to confirm a stack is actually answering there. */
async function isReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/b3/api/public/config`, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    });
    return res.ok || res.status === 401 || res.status === 404;
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  /** Explicit override: "local" | "raw" | "production". */
  target?: string;
  /** Required to actually run production (gated). */
  allowProduction?: boolean;
}

/**
 * Resolve the environment to capture against.
 *
 * - `SHOTS_ENV` / `opts.target` of `production` is gated: v1 defers production
 *   capture, so it throws unless `allowProduction` AND `SHOTS_ALLOW_PROD=1`.
 * - Otherwise probes the local docker stack; falls back to a raw-local base URL
 *   from config/env if localhost isn't answering.
 */
export async function resolveEnvironment(opts: ResolveOptions = {}): Promise<ResolvedEnvironment> {
  const fileCfg = readFileConfig();
  const target = (opts.target ?? process.env.SHOTS_ENV ?? 'local').toLowerCase();

  // Defaults mirror the E2E suite's seeded users (apps/e2e/src/auth/test-users.ts)
  // so a UI-login fallback works on a freshly-seeded local stack. The preferred
  // path reuses apps/e2e/.auth/<identity>.json storageState (see runner).
  const identities: Record<string, Identity> = {
    admin: {
      email: process.env.DOCS_CAPTURE_USER || process.env.E2E_ADMIN_EMAIL || fileCfg.identities?.admin?.email || 'e2e-admin@bigbluebam.test',
      password:
        process.env.DOCS_CAPTURE_PASSWORD ||
        process.env.E2E_ADMIN_PASSWORD ||
        fileCfg.identities?.admin?.password ||
        'E2eTestP@ss123!',
    },
    member: {
      email: process.env.E2E_MEMBER_EMAIL || fileCfg.identities?.member?.email || 'e2e-member@bigbluebam.test',
      password: process.env.E2E_MEMBER_PASSWORD || fileCfg.identities?.member?.password || 'E2eTestP@ss123!',
    },
    ...fileCfg.identities,
  };
  const workspaceSlug = process.env.SHOTS_WORKSPACE || fileCfg.workspaceSlug || 'screenshots-demo';

  if (target === 'production' || target === 'prod') {
    if (!opts.allowProduction || process.env.SHOTS_ALLOW_PROD !== '1') {
      throw new Error(
        'Production capture is deferred in v1. Seeding into / capturing production is gated behind ' +
          'SHOTS_ALLOW_PROD=1 and a dedicated demo workspace; not enabled here.',
      );
    }
    const baseUrl = process.env.SHOTS_BASE_URL || fileCfg.baseUrl;
    if (!baseUrl) throw new Error('production target requires SHOTS_BASE_URL');
    return { name: 'production', baseUrl, identities, workspaceSlug };
  }

  const explicitBase = process.env.SHOTS_BASE_URL || process.env.DOCS_CAPTURE_BASE_URL || fileCfg.baseUrl;
  if (target === 'raw') {
    const baseUrl = explicitBase || DEFAULT_LOCAL;
    return { name: 'raw-local', baseUrl, identities, workspaceSlug };
  }

  // Default: local docker. Probe; fall back to raw-local config if down.
  const localBase = explicitBase || DEFAULT_LOCAL;
  if (await isReachable(localBase)) {
    return { name: 'local-docker', baseUrl: localBase, identities, workspaceSlug };
  }
  if (explicitBase && (await isReachable(explicitBase))) {
    return { name: 'raw-local', baseUrl: explicitBase, identities, workspaceSlug };
  }
  throw new Error(
    `No reachable stack. Tried ${localBase}. Start the local stack (docker compose up) or set ` +
      `SHOTS_BASE_URL. (Probe path: /b3/api/public/config)`,
  );
}
