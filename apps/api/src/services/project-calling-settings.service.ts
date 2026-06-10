import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projectCallingSettings } from '../db/schema/project-calling-settings.js';
import { projects } from '../db/schema/projects.js';
import { systemSettings } from '../db/schema/system-settings.js';

/**
 * Per-project calling settings.
 *
 * Read-time inheritance, project -> org -> platform:
 *   1. project_calling_settings row (non-NULL column = explicit override)
 *   2. banter_settings (per-org calling config — voice_video_enabled,
 *      allow_recording, transcription_enabled)
 *   3. system_settings calling.* keys (platform-wide defaults set by
 *      SuperUser); if absent, hard-coded fallbacks below.
 *
 * banter_settings lives in another app's schema module but it's the same
 * Postgres database, so we read it via raw SQL rather than re-import the
 * Drizzle schema across the package boundary. The audit (see
 * docs/plans/bureau-calling-audit.md §4 decision 1) deliberately keeps the
 * per-org calling config in that table to avoid migrating existing values.
 */

export type CallingPrivacy = 'public' | 'org' | 'private' | string;

export interface EffectiveCallingSettings {
  calling_enabled: boolean;
  allow_recording: boolean;
  allow_transcription: boolean;
  default_office_privacy: CallingPrivacy;
  /** Per-tier provenance so the UI can render an "(inherited from org)" tag. */
  source: {
    calling_enabled: 'project' | 'org' | 'platform';
    allow_recording: 'project' | 'org' | 'platform';
    allow_transcription: 'project' | 'org' | 'platform';
    default_office_privacy: 'project' | 'org' | 'platform';
  };
}

const PLATFORM_DEFAULTS = {
  calling_enabled: true,
  allow_recording: false,
  allow_transcription: false,
  default_office_privacy: 'org' as CallingPrivacy,
};

interface PlatformCallingTier {
  calling_enabled: boolean | null;
  allow_recording: boolean | null;
  allow_transcription: boolean | null;
  default_office_privacy: CallingPrivacy | null;
}

interface OrgCallingTier {
  calling_enabled: boolean | null;
  allow_recording: boolean | null;
  allow_transcription: boolean | null;
}

/** Returns the row for this project, or null if no override exists. */
export async function getProjectCallingSettings(projectId: string) {
  const [row] = await db
    .select()
    .from(projectCallingSettings)
    .where(eq(projectCallingSettings.project_id, projectId))
    .limit(1);
  return row ?? null;
}

/** Upsert (merge) — only fields present on `partial` are touched. */
export async function upsertProjectCallingSettings(
  projectId: string,
  partial: {
    calling_enabled?: boolean | null;
    allow_recording?: boolean | null;
    allow_transcription?: boolean | null;
    default_office_privacy?: string | null;
  },
) {
  // Need the org_id for the new row in case this is the first write.
  const [project] = await db
    .select({ org_id: projects.org_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const updateSet: Record<string, unknown> = { updated_at: new Date() };
  if (Object.prototype.hasOwnProperty.call(partial, 'calling_enabled'))
    updateSet.calling_enabled = partial.calling_enabled ?? null;
  if (Object.prototype.hasOwnProperty.call(partial, 'allow_recording'))
    updateSet.allow_recording = partial.allow_recording ?? null;
  if (Object.prototype.hasOwnProperty.call(partial, 'allow_transcription'))
    updateSet.allow_transcription = partial.allow_transcription ?? null;
  if (Object.prototype.hasOwnProperty.call(partial, 'default_office_privacy'))
    updateSet.default_office_privacy = partial.default_office_privacy ?? null;

  const [row] = await db
    .insert(projectCallingSettings)
    .values({
      project_id: projectId,
      org_id: project.org_id,
      calling_enabled: partial.calling_enabled ?? null,
      allow_recording: partial.allow_recording ?? null,
      allow_transcription: partial.allow_transcription ?? null,
      default_office_privacy: partial.default_office_privacy ?? null,
    })
    .onConflictDoUpdate({
      target: projectCallingSettings.project_id,
      set: updateSet,
    })
    .returning();
  return row ?? null;
}

/**
 * Read the org-level calling tier from banter_settings.
 *
 * banter_settings columns are NOT NULL with defaults, so they always
 * resolve to a value — we treat that value as the org-tier opinion. If the
 * row does not exist (org never opened Banter) every field is null and the
 * caller falls through to the platform tier.
 */
async function getOrgCallingTier(orgId: string): Promise<OrgCallingTier> {
  // We use raw SQL because banter_settings lives in a sibling app's
  // schema module (apps/banter-api/src/db/schema/settings.ts) which the
  // Bam api package does not import. The shape is stable enough that a
  // query against the column names is the right level of coupling.
  // pg_class lookup keeps this resilient in case banter_settings hasn't
  // been migrated in the local stack.
  const tableCheck = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'banter_settings'
    ) AS exists
  `);
  // db.execute returns an array-like RowList directly; index in defensively.
  const checkRows = tableCheck as unknown as Array<{ exists?: boolean }>;
  const exists = Array.isArray(checkRows) ? checkRows[0]?.exists : undefined;
  if (!exists) {
    return { calling_enabled: null, allow_recording: null, allow_transcription: null };
  }

  const result = await db.execute<{
    voice_video_enabled: boolean | null;
    allow_recording: boolean | null;
    transcription_enabled: boolean | null;
  }>(sql`
    SELECT voice_video_enabled, allow_recording, transcription_enabled
      FROM banter_settings
     WHERE org_id = ${orgId}
     LIMIT 1
  `);
  const resultRows = result as unknown as Array<{
    voice_video_enabled: boolean | null;
    allow_recording: boolean | null;
    transcription_enabled: boolean | null;
  }>;
  const row = Array.isArray(resultRows) ? resultRows[0] : undefined;
  if (!row) {
    return { calling_enabled: null, allow_recording: null, allow_transcription: null };
  }
  return {
    calling_enabled: row.voice_video_enabled,
    allow_recording: row.allow_recording,
    allow_transcription: row.transcription_enabled,
  };
}

/**
 * Read the platform-level calling tier from system_settings. SuperUser
 * platform calling settings (Bureau prerequisite P-2) write keys under
 * `calling.*`; absent keys mean "use hardcoded fallback".
 */
async function getPlatformCallingTier(): Promise<PlatformCallingTier> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(sql`${systemSettings.key} IN (
      'calling.global_enabled',
      'calling.allow_recording',
      'calling.allow_transcription',
      'calling.default_office_privacy'
    )`);
  const byKey = new Map<string, unknown>();
  for (const r of rows) byKey.set(r.key, r.value);

  const readBool = (k: string): boolean | null => {
    const v = byKey.get(k);
    if (v === true || v === false) return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  };
  const readStr = (k: string): string | null => {
    const v = byKey.get(k);
    return typeof v === 'string' && v.length > 0 ? v : null;
  };

  return {
    calling_enabled: readBool('calling.global_enabled'),
    allow_recording: readBool('calling.allow_recording'),
    allow_transcription: readBool('calling.allow_transcription'),
    default_office_privacy: readStr('calling.default_office_privacy'),
  };
}

/**
 * Walk project -> org -> platform and return the resolved values.
 * Each field independently picks the most specific non-NULL tier.
 */
export async function getEffectiveCallingSettings(
  projectId: string,
): Promise<EffectiveCallingSettings | null> {
  const [project] = await db
    .select({ org_id: projects.org_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const [projectRow, orgTier, platformTier] = await Promise.all([
    getProjectCallingSettings(projectId),
    getOrgCallingTier(project.org_id),
    getPlatformCallingTier(),
  ]);

  function resolveBool(
    field: 'calling_enabled' | 'allow_recording' | 'allow_transcription',
    fallback: boolean,
  ): { value: boolean; source: 'project' | 'org' | 'platform' } {
    if (projectRow && projectRow[field] !== null && projectRow[field] !== undefined) {
      return { value: projectRow[field] as boolean, source: 'project' };
    }
    if (orgTier[field] !== null && orgTier[field] !== undefined) {
      return { value: orgTier[field] as boolean, source: 'org' };
    }
    const platformVal = platformTier[field];
    if (platformVal !== null && platformVal !== undefined) {
      return { value: platformVal, source: 'platform' };
    }
    return { value: fallback, source: 'platform' };
  }

  function resolvePrivacy(): {
    value: CallingPrivacy;
    source: 'project' | 'org' | 'platform';
  } {
    if (projectRow?.default_office_privacy) {
      return { value: projectRow.default_office_privacy, source: 'project' };
    }
    // No org-tier column for office privacy yet (Bureau lands it). Fall
    // through to platform.
    if (platformTier.default_office_privacy) {
      return { value: platformTier.default_office_privacy, source: 'platform' };
    }
    return { value: PLATFORM_DEFAULTS.default_office_privacy, source: 'platform' };
  }

  const calling = resolveBool('calling_enabled', PLATFORM_DEFAULTS.calling_enabled);
  const recording = resolveBool('allow_recording', PLATFORM_DEFAULTS.allow_recording);
  const transcription = resolveBool(
    'allow_transcription',
    PLATFORM_DEFAULTS.allow_transcription,
  );
  const privacy = resolvePrivacy();

  return {
    calling_enabled: calling.value,
    allow_recording: recording.value,
    allow_transcription: transcription.value,
    default_office_privacy: privacy.value,
    source: {
      calling_enabled: calling.source,
      allow_recording: recording.source,
      allow_transcription: transcription.source,
      default_office_privacy: privacy.source,
    },
  };
}
