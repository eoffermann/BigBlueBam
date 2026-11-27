import crypto from 'node:crypto';
import { eq, and, or, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { llmProviders } from '../db/schema/llm-providers.js';
import type { LlmProvider, NewLlmProvider } from '../db/schema/llm-providers.js';
import { env } from '../env.js';
import { llmFetch } from '../lib/llm-fetch.js';

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';

// Legacy static salt — kept for backward-compatible decryption of values
// encrypted before the deployment-specific salt was introduced.
const LEGACY_SALT = 'llm-provider-salt';

// Deployment-specific salt derived from SESSION_SECRET so different
// deployments produce different derived keys.
const CURRENT_SALT = crypto
  .createHash('sha256')
  .update(env.SESSION_SECRET + ':llm-provider-salt')
  .digest()
  .subarray(0, 16);

function deriveKey(salt: string | Buffer): Buffer {
  return crypto.scryptSync(env.SESSION_SECRET, salt, 32);
}

function getEncryptionKey(): Buffer {
  return deriveKey(CURRENT_SALT);
}

function getLegacyEncryptionKey(): Buffer {
  return deriveKey(LEGACY_SALT);
}

export function encryptApiKey(plaintext: string): Buffer {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as: iv (16) + tag (16) + encrypted
  return Buffer.concat([iv, tag, encrypted]);
}

export function decryptApiKey(data: Buffer): string {
  const iv = data.subarray(0, 16);
  const tag = data.subarray(16, 32);
  const encrypted = data.subarray(32);

  // Try the current deployment-specific key first
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    // Fall back to the legacy static-salt key for pre-migration values
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getLegacyEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

export function redactApiKey(plaintext: string): string {
  if (plaintext.length <= 8) return '••••';
  return plaintext.slice(0, 3) + '•••' + plaintext.slice(-4);
}

// ---------------------------------------------------------------------------
// Row serialization (redacts the key)
// ---------------------------------------------------------------------------

export interface LlmProviderPublic {
  id: string;
  scope: string;
  organization_id: string | null;
  project_id: string | null;
  name: string;
  provider_type: string;
  model_id: string;
  api_endpoint: string | null;
  api_key_hint: string;
  max_tokens: number | null;
  temperature: string | null;
  is_default: boolean;
  enabled: boolean;
  max_requests_per_hour: number | null;
  max_tokens_per_hour: number | null;
  created_by: string;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function toPublic(row: LlmProvider): LlmProviderPublic {
  let hint = '••••';
  try {
    const plain = decryptApiKey(row.api_key_encrypted);
    hint = redactApiKey(plain);
  } catch {
    // If decryption fails (key rotation, etc.), show generic mask
  }
  return {
    id: row.id,
    scope: row.scope,
    organization_id: row.organization_id,
    project_id: row.project_id,
    name: row.name,
    provider_type: row.provider_type,
    model_id: row.model_id,
    api_endpoint: row.api_endpoint,
    api_key_hint: hint,
    max_tokens: row.max_tokens,
    temperature: row.temperature,
    is_default: row.is_default,
    enabled: row.enabled,
    max_requests_per_hour: row.max_requests_per_hour,
    max_tokens_per_hour: row.max_tokens_per_hour,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listProviders(
  orgId: string,
  projectId: string | undefined,
  isSuperUser: boolean,
): Promise<LlmProviderPublic[]> {
  // Build conditions: always include org-level for the user's org
  const conditions = [
    and(eq(llmProviders.scope, 'organization'), eq(llmProviders.organization_id, orgId)),
  ];

  // Include project-level if a project is specified
  if (projectId) {
    conditions.push(
      and(eq(llmProviders.scope, 'project'), eq(llmProviders.project_id, projectId)),
    );
  }

  // SuperUsers also see system-level providers
  if (isSuperUser) {
    conditions.push(
      and(eq(llmProviders.scope, 'system'), isNull(llmProviders.organization_id)),
    );
  }

  const rows = await db
    .select()
    .from(llmProviders)
    .where(or(...conditions))
    .orderBy(llmProviders.created_at);

  return rows.map(toPublic);
}

export async function createProvider(
  data: {
    scope: string;
    organization_id?: string | null;
    project_id?: string | null;
    name: string;
    provider_type: string;
    model_id: string;
    api_endpoint?: string | null;
    api_key: string;
    max_tokens?: number;
    temperature?: string;
    is_default?: boolean;
    enabled?: boolean;
    max_requests_per_hour?: number;
    max_tokens_per_hour?: number;
  },
  userId: string,
): Promise<LlmProviderPublic> {
  const encrypted = encryptApiKey(data.api_key);

  const values: NewLlmProvider = {
    scope: data.scope,
    organization_id: data.organization_id ?? null,
    project_id: data.project_id ?? null,
    name: data.name,
    provider_type: data.provider_type,
    model_id: data.model_id,
    api_endpoint: data.api_endpoint ?? null,
    api_key_encrypted: encrypted,
    max_tokens: data.max_tokens ?? 4096,
    temperature: data.temperature ?? '0.7',
    is_default: data.is_default ?? false,
    enabled: data.enabled ?? true,
    max_requests_per_hour: data.max_requests_per_hour ?? 100,
    max_tokens_per_hour: data.max_tokens_per_hour ?? 500000,
    created_by: userId,
  };

  // If setting as default, unset other defaults at the same scope level
  if (values.is_default) {
    await clearDefaults(data.scope, data.organization_id ?? null, data.project_id ?? null);
  }

  const [row] = await db.insert(llmProviders).values(values).returning();
  return toPublic(row!);
}

export async function getProvider(
  id: string,
  orgId: string,
  isSuperUser: boolean,
): Promise<LlmProviderPublic | null> {
  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.id, id))
    .limit(1);

  if (!row) return null;

  // Authorization: system providers are only visible to SuperUsers,
  // org/project providers must belong to the caller's org
  if (row.scope === 'system' && !isSuperUser) return null;
  if (row.scope !== 'system' && row.organization_id !== orgId) return null;

  return toPublic(row);
}

/** Returns the raw row (with encrypted key) for internal use. */
async function getRawProvider(id: string): Promise<LlmProvider | null> {
  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateProvider(
  id: string,
  data: {
    name?: string;
    provider_type?: string;
    model_id?: string;
    api_endpoint?: string | null;
    api_key?: string;
    max_tokens?: number;
    temperature?: string;
    is_default?: boolean;
    enabled?: boolean;
    max_requests_per_hour?: number;
    max_tokens_per_hour?: number;
  },
  userId: string,
  orgId: string,
  isSuperUser: boolean,
): Promise<LlmProviderPublic | null> {
  const existing = await getRawProvider(id);
  if (!existing) return null;

  // Authorization
  if (existing.scope === 'system' && !isSuperUser) return null;
  if (existing.scope !== 'system' && existing.organization_id !== orgId) return null;

  const updates: Record<string, unknown> = {
    updated_by: userId,
    updated_at: new Date(),
  };

  if (data.name !== undefined) updates.name = data.name;
  if (data.provider_type !== undefined) updates.provider_type = data.provider_type;
  if (data.model_id !== undefined) updates.model_id = data.model_id;
  if (data.api_endpoint !== undefined) updates.api_endpoint = data.api_endpoint;
  if (data.max_tokens !== undefined) updates.max_tokens = data.max_tokens;
  if (data.temperature !== undefined) updates.temperature = data.temperature;
  if (data.enabled !== undefined) updates.enabled = data.enabled;
  if (data.max_requests_per_hour !== undefined) updates.max_requests_per_hour = data.max_requests_per_hour;
  if (data.max_tokens_per_hour !== undefined) updates.max_tokens_per_hour = data.max_tokens_per_hour;

  // Re-encrypt if key changed
  if (data.api_key !== undefined) {
    updates.api_key_encrypted = encryptApiKey(data.api_key);
  }

  // Handle default toggling
  if (data.is_default !== undefined) {
    updates.is_default = data.is_default;
    if (data.is_default) {
      await clearDefaults(existing.scope, existing.organization_id, existing.project_id);
    }
  }

  const [updated] = await db
    .update(llmProviders)
    .set(updates)
    .where(eq(llmProviders.id, id))
    .returning();

  return updated ? toPublic(updated) : null;
}

export async function deleteProvider(
  id: string,
  orgId: string,
  isSuperUser: boolean,
): Promise<boolean> {
  const existing = await getRawProvider(id);
  if (!existing) return false;

  if (existing.scope === 'system' && !isSuperUser) return false;
  if (existing.scope !== 'system' && existing.organization_id !== orgId) return false;

  await db.delete(llmProviders).where(eq(llmProviders.id, id));
  return true;
}

// ---------------------------------------------------------------------------
// Resolution: project -> org -> system
// ---------------------------------------------------------------------------

export async function resolveProvider(
  orgId: string,
  projectId?: string,
): Promise<LlmProviderPublic | null> {
  // 1. Try project-level default
  if (projectId) {
    const projectDefault = await findDefault('project', null, projectId);
    if (projectDefault) return toPublic(projectDefault);
  }

  // 2. Try org-level default
  const orgDefault = await findDefault('organization', orgId, null);
  if (orgDefault) return toPublic(orgDefault);

  // 3. Try system-level default
  const systemDefault = await findDefault('system', null, null);
  if (systemDefault) return toPublic(systemDefault);

  return null;
}

async function findDefault(
  scope: string,
  orgId: string | null,
  projectId: string | null,
): Promise<LlmProvider | null> {
  // First try to find a default provider
  const conditions = [
    eq(llmProviders.scope, scope),
    eq(llmProviders.enabled, true),
  ];

  if (scope === 'organization' && orgId) {
    conditions.push(eq(llmProviders.organization_id, orgId));
  } else if (scope === 'project' && projectId) {
    conditions.push(eq(llmProviders.project_id, projectId));
  } else if (scope === 'system') {
    conditions.push(isNull(llmProviders.organization_id));
  }

  // Try default first
  const [defaultRow] = await db
    .select()
    .from(llmProviders)
    .where(and(...conditions, eq(llmProviders.is_default, true)))
    .limit(1);

  if (defaultRow) return defaultRow;

  // Fall back to first enabled
  const [firstRow] = await db
    .select()
    .from(llmProviders)
    .where(and(...conditions))
    .orderBy(llmProviders.created_at)
    .limit(1);

  return firstRow ?? null;
}

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

export async function testProvider(
  id: string,
  orgId: string,
  isSuperUser: boolean,
): Promise<{ success: boolean; message: string; latency_ms?: number }> {
  const existing = await getRawProvider(id);
  if (!existing) {
    return { success: false, message: 'Provider not found' };
  }

  if (existing.scope === 'system' && !isSuperUser) {
    return { success: false, message: 'Forbidden' };
  }
  if (existing.scope !== 'system' && existing.organization_id !== orgId) {
    return { success: false, message: 'Forbidden' };
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(existing.api_key_encrypted);
  } catch {
    return { success: false, message: 'Failed to decrypt API key. The encryption key may have changed.' };
  }

  const start = Date.now();

  try {
    if (existing.provider_type === 'anthropic') {
      const endpoint = existing.api_endpoint || 'https://api.anthropic.com';
      const response = await llmFetch(`${endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: existing.model_id,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say "ok"' }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      const latency = Date.now() - start;

      if (response.ok) {
        return { success: true, message: 'Connection successful', latency_ms: latency };
      }

      const errorBody = await response.text().catch(() => '');
      return {
        success: false,
        message: `Anthropic API returned ${response.status}: ${errorBody.slice(0, 200)}`,
        latency_ms: latency,
      };
    } else {
      // OpenAI or OpenAI-compatible
      const endpoint = existing.api_endpoint || 'https://api.openai.com';
      const response = await llmFetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: existing.model_id,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say "ok"' }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      const latency = Date.now() - start;

      if (response.ok) {
        return { success: true, message: 'Connection successful', latency_ms: latency };
      }

      const errorBody = await response.text().catch(() => '');
      return {
        success: false,
        message: `API returned ${response.status}: ${errorBody.slice(0, 200)}`,
        latency_ms: latency,
      };
    }
  } catch (err) {
    const latency = Date.now() - start;
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, message: `Connection failed: ${message}`, latency_ms: latency };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clearDefaults(
  scope: string,
  organizationId: string | null,
  projectId: string | null,
): Promise<void> {
  const conditions = [
    eq(llmProviders.scope, scope),
    eq(llmProviders.is_default, true),
  ];

  if (scope === 'organization' && organizationId) {
    conditions.push(eq(llmProviders.organization_id, organizationId));
  } else if (scope === 'project' && projectId) {
    conditions.push(eq(llmProviders.project_id, projectId));
  } else if (scope === 'system') {
    conditions.push(isNull(llmProviders.organization_id));
  }

  await db
    .update(llmProviders)
    .set({ is_default: false, updated_at: new Date() })
    .where(and(...conditions));
}
