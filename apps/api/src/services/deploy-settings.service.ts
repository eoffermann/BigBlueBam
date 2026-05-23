// Deploy settings service.
//
// Backend for the SuperUser Deploy Settings card (companion to the Wave F
// permissions editor). Reads/writes four keys in the existing system_settings
// table:
//
//   deploy_branch                - string (default "stable")
//   deploy_repo_url              - string | null (default: `git remote get-url origin`)
//   deploy_github_token          - string, AES-256-GCM encrypted (default null)
//   deploy_auto_update_enabled   - boolean (default true)
//
// Defaults are NOT seeded: absence in the table means "use the hardcoded
// fallback returned by loadDeploySettings()". Deleting a row reverts to
// baseline behavior with no DB cleanup. See
// docs/plans/deploy-settings-contract.md for the canonical spec.

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { systemSettings } from '../db/schema/system-settings.js';
import { env } from '../env.js';

// ─────────────────────────────────────────────────────────────────────
// Keys
// ─────────────────────────────────────────────────────────────────────
export const DEPLOY_KEYS = {
  branch: 'deploy_branch',
  repoUrl: 'deploy_repo_url',
  githubToken: 'deploy_github_token',
  autoUpdateEnabled: 'deploy_auto_update_enabled',
} as const;

const ALL_DEPLOY_KEYS = [
  DEPLOY_KEYS.branch,
  DEPLOY_KEYS.repoUrl,
  DEPLOY_KEYS.githubToken,
  DEPLOY_KEYS.autoUpdateEnabled,
];

// Hardcoded fallback. `deploy_repo_url` default is computed dynamically at
// load time via `git remote get-url origin` since the value depends on the
// machine running the API container.
export const DEPLOY_DEFAULTS = {
  branch: 'stable',
  autoUpdateEnabled: true,
} as const;

// ─────────────────────────────────────────────────────────────────────
// Token encryption — AES-256-GCM with HKDF-like key derivation.
// ─────────────────────────────────────────────────────────────────────
//
// The stored format is `enc:<iv-b64>:<ciphertext-b64>:<tag-b64>`. The
// prefix lets the deploy script (which doesn't decrypt directly) test for
// presence vs. absence without unpacking the value.
//
// Decryption failure (e.g. SESSION_SECRET rotated, value corrupted) returns
// null and the caller treats the token as missing — same effect as the
// operator clearing the field, with a startup-log warning so it doesn't
// silently linger.
function deriveKey(): Buffer {
  return createHash('sha256')
    .update(env.SESSION_SECRET + 'deploy-token-key-v1')
    .digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptToken(stored: string): string | null {
  if (!stored.startsWith('enc:')) return null;
  const parts = stored.split(':');
  if (parts.length !== 4) return null;
  const ivB64 = parts[1];
  const ctB64 = parts[2];
  const tagB64 = parts[3];
  if (!ivB64 || !ctB64 || !tagB64) return null;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Origin URL discovery
// ─────────────────────────────────────────────────────────────────────
//
// Used to populate `defaults.deploy_repo_url`. Cached for the lifetime of
// the process — the value cannot change without restarting the container,
// since the .git remote inside the image is baked in at build time.
let cachedOrigin: string | null | undefined;

export function getOriginUrl(): string | null {
  if (cachedOrigin !== undefined) return cachedOrigin;
  try {
    const out = execSync('git remote get-url origin', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    });
    cachedOrigin = out.trim() || null;
  } catch {
    cachedOrigin = null;
  }
  return cachedOrigin;
}

// Test-only: reset the cache so unit tests can exercise both branches.
export function _resetOriginCache(): void {
  cachedOrigin = undefined;
}

// ─────────────────────────────────────────────────────────────────────
// system_settings reads — JSONB column decoding.
// ─────────────────────────────────────────────────────────────────────
//
// system_settings.value is jsonb. The system-settings.routes.ts writer
// stores values via `JSON.stringify(value)`, which postgres then
// double-decodes (the writer serializes "stable" as '"stable"' and the
// jsonb column persists it as a JSON string). drizzle returns the parsed
// JSON value, so a row written as the string 'stable' arrives here as
// 'stable' directly.
type SettingRow = { key: string; value: unknown };

function readString(row: SettingRow | undefined): string | null {
  if (!row) return null;
  const v = row.value;
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return null;
  return String(v);
}

function readBoolean(row: SettingRow | undefined): boolean | null {
  if (!row) return null;
  const v = row.value;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────
export interface DeploySettings {
  deploy_branch: string;
  deploy_repo_url: string;
  deploy_github_token_set: boolean;
  deploy_auto_update_enabled: boolean;
  defaults: {
    deploy_branch: string;
    deploy_repo_url: string | null;
  };
}

export interface SaveDeploySettingsInput {
  deploy_branch?: string;
  // repo_url: explicit null clears the row (reverts to origin); undefined
  // means "unchanged"; string means "store this value".
  deploy_repo_url?: string | null;
  // github_token: omitted → unchanged; null → clear stored value; string →
  // encrypt and store.
  deploy_github_token?: string | null;
  deploy_auto_update_enabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────

async function fetchRows(): Promise<Map<string, SettingRow>> {
  const rows = (await db
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, ALL_DEPLOY_KEYS))) as SettingRow[];
  const map = new Map<string, SettingRow>();
  for (const r of rows) map.set(r.key, r);
  return map;
}

export async function loadDeploySettings(): Promise<DeploySettings> {
  const rows = await fetchRows();
  const origin = getOriginUrl();

  const branch =
    readString(rows.get(DEPLOY_KEYS.branch)) ?? DEPLOY_DEFAULTS.branch;
  const repoUrl =
    readString(rows.get(DEPLOY_KEYS.repoUrl)) ?? origin ?? '';
  const tokenRow = rows.get(DEPLOY_KEYS.githubToken);
  const tokenStr = readString(tokenRow);
  const tokenSet = !!(tokenStr && tokenStr.startsWith('enc:'));
  const autoUpdate =
    readBoolean(rows.get(DEPLOY_KEYS.autoUpdateEnabled)) ??
    DEPLOY_DEFAULTS.autoUpdateEnabled;

  return {
    deploy_branch: branch,
    deploy_repo_url: repoUrl,
    deploy_github_token_set: tokenSet,
    deploy_auto_update_enabled: autoUpdate,
    defaults: {
      deploy_branch: DEPLOY_DEFAULTS.branch,
      deploy_repo_url: origin,
    },
  };
}

// Returns the decrypted token or null. Used by verify-repo when the
// request body omits an explicit token (fall back to stored).
export async function getDecryptedToken(): Promise<string | null> {
  const rows = await fetchRows();
  const tokenRow = rows.get(DEPLOY_KEYS.githubToken);
  const stored = readString(tokenRow);
  if (!stored) return null;
  return decryptToken(stored);
}

// ─────────────────────────────────────────────────────────────────────
// Writers
// ─────────────────────────────────────────────────────────────────────

async function upsertKey(
  key: string,
  value: unknown,
  userId: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(systemSettings)
    .values({
      key,
      value: JSON.stringify(value),
      updated_by: userId,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: JSON.stringify(value),
        updated_by: userId,
        updated_at: now,
      },
    });
}

async function deleteKey(key: string): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, key));
}

export async function saveDeploySettings(
  input: SaveDeploySettingsInput,
  userId: string,
): Promise<DeploySettings> {
  // Each field has independent semantics — write only what the caller
  // sent. We don't wrap in a transaction because the four writes are
  // independent rows in the same table and partial-write recovery is no
  // worse than partial-write commit (the next save fixes it).

  if (input.deploy_branch !== undefined) {
    await upsertKey(DEPLOY_KEYS.branch, input.deploy_branch, userId);
  }

  if (input.deploy_repo_url !== undefined) {
    if (input.deploy_repo_url === null) {
      await deleteKey(DEPLOY_KEYS.repoUrl);
    } else {
      await upsertKey(DEPLOY_KEYS.repoUrl, input.deploy_repo_url, userId);
    }
  }

  if (input.deploy_github_token !== undefined) {
    if (input.deploy_github_token === null) {
      await deleteKey(DEPLOY_KEYS.githubToken);
    } else {
      const encrypted = encryptToken(input.deploy_github_token);
      await upsertKey(DEPLOY_KEYS.githubToken, encrypted, userId);
    }
  }

  if (input.deploy_auto_update_enabled !== undefined) {
    await upsertKey(
      DEPLOY_KEYS.autoUpdateEnabled,
      input.deploy_auto_update_enabled,
      userId,
    );
  }

  return loadDeploySettings();
}
