import { db as defaultDb } from '../db/index.js';
import { getBanterSettingsCached, type BanterSettingsRow } from './settings-cache.js';

/**
 * Bridge between banter_settings (apps/banter-api) and organizations.settings.permissions
 * (apps/api).
 *
 * ------------------------------------------------------------------------
 * BACKGROUND — Dual source of truth (TODO: unify)
 * ------------------------------------------------------------------------
 * Today there are TWO places that store org-level permissions:
 *
 *   1. `banter_settings` table (this app)
 *        Flat columns on a dedicated table, one row per org. Holds
 *        banter-specific toggles (channel creation, DMs, file size,
 *        LiveKit/voice/AI config, etc).
 *        Schema: apps/banter-api/src/db/schema/settings.ts
 *
 *   2. `organizations.settings.permissions` JSONB (apps/api)
 *        A sub-object on the organization row, holding the bbb/kanban
 *        permissions (projects, invites, api keys, file upload cap).
 *        Schema / defaults: apps/api/src/services/org-permissions.ts
 *        (DEFAULT_ORG_PERMISSIONS, type OrgPermissions)
 *
 * These two schemas overlap on several concepts but use different
 * field names and types. That divergence is documented below, and
 * callers reading banter permissions should go through
 * `getEffectiveBanterPermissions()` so there is a single code path.
 *
 * ------------------------------------------------------------------------
 * FIELD MAPPING (banter_settings  →  OrgPermissions)
 * ------------------------------------------------------------------------
 *
 * banter_settings.allow_channel_creation ('members'|'admins')
 *     → members_can_create_channels (boolean)
 *     → members_can_create_private_channels (boolean)
 *       ("private channels" are not separately toggleable in banter_settings
 *        yet; piggybacks on allow_channel_creation — mirrors the current
 *        behaviour in channel.routes.ts.)
 *
 * banter_settings.allow_group_dm (boolean)
 *     → members_can_create_group_dms (boolean)
 *
 * banter_settings.max_file_size_mb (integer)
 *     → max_file_upload_mb (integer)
 *
 * banter_settings.allow_dm (boolean)
 *     → (no direct OrgPermissions equivalent; banter-only)
 *
 * banter_settings.allow_guest_access (boolean)
 *     → (no direct OrgPermissions equivalent; banter-only)
 *
 * OrgPermissions fields with NO banter_settings equivalent:
 *     members_can_create_projects
 *     members_can_delete_own_projects
 *     members_can_invite_members
 *     members_can_create_api_keys
 *     allowed_api_key_scopes
 *
 * For fields with no equivalent, `mapBanterSettingsToOrgPermissions`
 * falls back to the DEFAULT_ORG_PERMISSIONS values baked into apps/api
 * (duplicated here to avoid a cross-package runtime import — the
 * banter-api container does not depend on apps/api).
 *
 * ------------------------------------------------------------------------
 * UNIFICATION PLAN (future)
 * ------------------------------------------------------------------------
 * The intended end state is ONE permissions object living on the
 * organization row, with banter-specific flags namespaced under
 * `settings.permissions.banter.*`. When that migration happens:
 *   - this bridge becomes a pure read adapter over org.settings,
 *   - banter_settings keeps only banter-exclusive columns
 *     (default_channel_id, LiveKit config, STT/TTS config, etc.),
 *   - the flat permission columns on banter_settings are dropped.
 *
 * Until then, the admin UI writes to banter_settings and apps/api writes
 * to organizations.settings.permissions; they are kept in sync only by
 * convention.
 * ------------------------------------------------------------------------
 */

/** Shape matches apps/api/src/services/org-permissions.ts OrgPermissions. */
export type BridgedOrgPermissions = {
  // Project permissions (not tracked in banter_settings; defaulted)
  members_can_create_projects: boolean;
  members_can_delete_own_projects: boolean;

  // Banter permissions (mapped from banter_settings)
  members_can_create_channels: boolean;
  members_can_create_private_channels: boolean;
  members_can_create_group_dms: boolean;

  // File permissions (mapped from banter_settings.max_file_size_mb)
  max_file_upload_mb: number;

  // Invitation permissions (not tracked in banter_settings; defaulted)
  members_can_invite_members: boolean;

  // API key permissions (not tracked in banter_settings; defaulted)
  members_can_create_api_keys: boolean;
  allowed_api_key_scopes: string[];
};

/** Duplicated from apps/api/src/services/org-permissions.ts. Keep in sync. */
export const BRIDGE_DEFAULTS: BridgedOrgPermissions = {
  members_can_create_projects: true,
  members_can_delete_own_projects: false,
  members_can_create_channels: true,
  members_can_create_private_channels: true,
  members_can_create_group_dms: true,
  max_file_upload_mb: 25,
  members_can_invite_members: false,
  members_can_create_api_keys: true,
  allowed_api_key_scopes: ['read', 'read_write'],
};

/**
 * Translate a banter_settings row (or null for "no row saved") into an
 * OrgPermissions-shaped object. Fields not represented in banter_settings
 * fall back to BRIDGE_DEFAULTS.
 */
export function mapBanterSettingsToOrgPermissions(
  banterSettings: BanterSettingsRow | null | undefined,
): BridgedOrgPermissions {
  const s = banterSettings;
  if (!s) return { ...BRIDGE_DEFAULTS };

  // 'everyone' (and the legacy synonym 'members') = any member can create.
  // 'admins' and 'org_owners' both restrict creation away from plain members.
  const allowCreation = s.allow_channel_creation ?? 'everyone';
  const membersCanCreateChannels = allowCreation === 'everyone' || allowCreation === 'members';

  return {
    ...BRIDGE_DEFAULTS,
    members_can_create_channels: membersCanCreateChannels,
    // Private channels piggyback on the same flag today; see schema comment.
    members_can_create_private_channels: membersCanCreateChannels,
    members_can_create_group_dms: s.allow_group_dm ?? true,
    max_file_upload_mb: s.max_file_size_mb ?? BRIDGE_DEFAULTS.max_file_upload_mb,
  };
}

/**
 * Read banter_settings for an org (via cache) and return a normalized
 * OrgPermissions-shaped object. This is the preferred entry point for
 * permission checks in banter routes — it gives us ONE place to reason
 * about banter permissions instead of ad-hoc `.select()` calls.
 */
export async function getEffectiveBanterPermissions(
  orgId: string,
  db: typeof defaultDb = defaultDb,
): Promise<BridgedOrgPermissions> {
  const row = await getBanterSettingsCached(orgId, db);
  return mapBanterSettingsToOrgPermissions(row);
}
