import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORG_PERMISSIONS,
  getOrgPermissions,
  checkOrgPermission,
  isOrgPrivileged,
} from '../src/services/org-permissions.js';

describe('org-permissions helpers', () => {
  describe('getOrgPermissions', () => {
    it('returns defaults when settings are null', () => {
      const perms = getOrgPermissions(null);
      expect(perms).toEqual(DEFAULT_ORG_PERMISSIONS);
    });

    it('returns defaults when settings are empty', () => {
      const perms = getOrgPermissions({});
      expect(perms).toEqual(DEFAULT_ORG_PERMISSIONS);
    });

    it('merges a single override on top of defaults', () => {
      const perms = getOrgPermissions({
        permissions: { members_can_create_projects: false },
      });
      expect(perms.members_can_create_projects).toBe(false);
      // Other defaults untouched
      expect(perms.members_can_create_api_keys).toBe(DEFAULT_ORG_PERMISSIONS.members_can_create_api_keys);
    });

    it('rejects string "false" for boolean fields (type coercion guard)', () => {
      const perms = getOrgPermissions({
        // intentionally wrong type: permissions is untyped JSONB, so this compiles
        permissions: { members_can_create_projects: 'false' },
      });
      expect(perms.members_can_create_projects).toBe(true); // default preserved
    });

    it('accepts array overrides for allowed_api_key_scopes', () => {
      const perms = getOrgPermissions({
        permissions: { allowed_api_key_scopes: ['read'] },
      });
      expect(perms.allowed_api_key_scopes).toEqual(['read']);
    });

    it('accepts number override for max_file_upload_mb', () => {
      const perms = getOrgPermissions({
        permissions: { max_file_upload_mb: 100 },
      });
      expect(perms.max_file_upload_mb).toBe(100);
    });
  });

  describe('checkOrgPermission', () => {
    it('returns true for enabled boolean toggle', () => {
      expect(
        checkOrgPermission(
          { permissions: { members_can_create_projects: true } },
          'members_can_create_projects',
        ),
      ).toBe(true);
    });

    it('returns false for disabled boolean toggle — blocks member action', () => {
      expect(
        checkOrgPermission(
          { permissions: { members_can_create_projects: false } },
          'members_can_create_projects',
        ),
      ).toBe(false);
    });

    it('returns default when toggle is unset', () => {
      expect(checkOrgPermission({}, 'members_can_create_projects')).toBe(true); // default true
      expect(checkOrgPermission({}, 'members_can_delete_own_projects')).toBe(false); // default false
      expect(checkOrgPermission({}, 'members_can_invite_members')).toBe(false); // default false
    });
  });

  describe('isOrgPrivileged', () => {
    it('returns true for admin and owner', () => {
      expect(isOrgPrivileged('admin')).toBe(true);
      expect(isOrgPrivileged('owner')).toBe(true);
    });

    it('returns false for other roles', () => {
      expect(isOrgPrivileged('member')).toBe(false);
      expect(isOrgPrivileged('viewer')).toBe(false);
      expect(isOrgPrivileged('guest')).toBe(false);
      expect(isOrgPrivileged('')).toBe(false);
    });
  });

  describe('admin-scope API key gating logic', () => {
    // Mirrors the predicate used in apps/api/src/routes/api-key.routes.ts
    // and apps/api/src/routes/org.routes.ts: admin scope requires
    // caller.is_superuser OR caller.role === 'owner'.
    const canGrantAdminScope = (u: { role: string; is_superuser: boolean }) =>
      u.is_superuser || u.role === 'owner';

    it('allows owners to grant admin scope', () => {
      expect(canGrantAdminScope({ role: 'owner', is_superuser: false })).toBe(true);
    });

    it('allows superusers to grant admin scope', () => {
      expect(canGrantAdminScope({ role: 'member', is_superuser: true })).toBe(true);
    });

    it('blocks org admins from granting admin scope', () => {
      expect(canGrantAdminScope({ role: 'admin', is_superuser: false })).toBe(false);
    });

    it('blocks members from granting admin scope', () => {
      expect(canGrantAdminScope({ role: 'member', is_superuser: false })).toBe(false);
    });
  });

  describe('toggle enforcement integration — member blocked scenarios', () => {
    // These test the decision logic used across route handlers:
    //   if (!user.is_superuser && !isOrgPrivileged(user.role) &&
    //       !checkOrgPermission(org.settings, TOGGLE)) return 403
    const memberBlocked = (
      settings: Record<string, unknown> | null,
      toggle: Parameters<typeof checkOrgPermission>[1],
      user: { role: string; is_superuser: boolean },
    ) =>
      !user.is_superuser &&
      !isOrgPrivileged(user.role) &&
      !checkOrgPermission(settings, toggle);

    it('member creating project with toggle=false → blocked', () => {
      expect(
        memberBlocked(
          { permissions: { members_can_create_projects: false } },
          'members_can_create_projects',
          { role: 'member', is_superuser: false },
        ),
      ).toBe(true);
    });

    it('member creating project with toggle=true → allowed', () => {
      expect(
        memberBlocked(
          { permissions: { members_can_create_projects: true } },
          'members_can_create_projects',
          { role: 'member', is_superuser: false },
        ),
      ).toBe(false);
    });

    it('admin creating project with toggle=false → allowed (bypass)', () => {
      expect(
        memberBlocked(
          { permissions: { members_can_create_projects: false } },
          'members_can_create_projects',
          { role: 'admin', is_superuser: false },
        ),
      ).toBe(false);
    });

    it('superuser with toggle=false → allowed (bypass)', () => {
      expect(
        memberBlocked(
          { permissions: { members_can_create_projects: false } },
          'members_can_create_projects',
          { role: 'member', is_superuser: true },
        ),
      ).toBe(false);
    });

    it('member inviting with default settings → blocked (default is false)', () => {
      expect(
        memberBlocked(null, 'members_can_invite_members', {
          role: 'member',
          is_superuser: false,
        }),
      ).toBe(true);
    });
  });
});
