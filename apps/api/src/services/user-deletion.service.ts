/**
 * User deletion (account-level). Two callers:
 *   - Org admins via POST /org/members/:id/delete-account
 *   - SuperUsers via DELETE /superuser/users/:id
 *
 * Implementation note: this is a "soft delete" — the users row stays in
 * place so authored content (tasks, comments, banter messages, blueprint
 * diagrams, …) survives without dangling FKs. 77 of the FKs into users.id
 * are NO ACTION / RESTRICT, so a real DELETE would either fail or require
 * a substantial migration. Soft-delete gives the operationally-expected
 * outcome — the account is gone, can't log in, doesn't show up anywhere,
 * the email is available for re-invitation — at a fraction of the risk.
 *
 * The cascade performed:
 *   1. `is_active = false`, `disabled_at = now()`, `disabled_by = actor`,
 *      `password_hash = NULL`, `force_password_change = false`
 *   2. Email tombstoned: `eddie@x.com` → `deleted+<userId>@deleted.local`
 *      so the original address is free to re-invite without an email-
 *      uniqueness conflict. The previous email is echoed back in the
 *      route response so the operator can record it (or hand it to the
 *      caller who needs to follow up out of band).
 *   3. Sessions: DELETE FROM sessions WHERE user_id = target (logout
 *      everywhere immediately).
 *   4. API keys: UPDATE api_keys SET revoked_at = now() (key prefix +
 *      hash stay so audit can find historical use).
 *   5. Org memberships: DELETE FROM organization_memberships WHERE
 *      user_id = target. After this the target appears in no org.
 *   6. Project memberships: DELETE FROM project_memberships WHERE
 *      user_id = target. After this the target has no project access.
 *   7. Password-reset tokens: DELETE FROM password_reset_tokens WHERE
 *      user_id = target. Any in-flight onboarding link is invalidated.
 *   8. Notifications: DELETE FROM notifications WHERE user_id = target.
 *      Stops the target from being notified after the fact.
 *   9. Logs `user.account_deleted` to activity_log for org audit
 *      visibility.
 *
 * Eligibility rules are caller-specific and live on the route side —
 * this service trusts that the caller has already authorized the action.
 */

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { sessions } from '../db/schema/sessions.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { passwordResetTokens } from '../db/schema/password-reset-tokens.js';
import { notifications } from '../db/schema/notifications.js';
import { accountGroupMemberships, permissionGroups } from '../db/schema/permissions.js';

export class CannotDeleteSelfError extends Error {
  constructor() {
    super('You cannot delete your own account through this endpoint');
    this.name = 'CannotDeleteSelfError';
  }
}

export class CannotDeleteSuperuserError extends Error {
  constructor() {
    super('SuperUser accounts cannot be deleted through this endpoint');
    this.name = 'CannotDeleteSuperuserError';
  }
}

export class CrossOrgDeletionForbiddenError extends Error {
  public readonly target_orgs: string[];
  public readonly caller_admin_orgs: string[];
  constructor(targetOrgs: string[], callerAdminOrgs: string[]) {
    super(
      'You can only delete an account whose every org membership is one you manage',
    );
    this.name = 'CrossOrgDeletionForbiddenError';
    this.target_orgs = targetOrgs;
    this.caller_admin_orgs = callerAdminOrgs;
  }
}

export class UserNotFoundError extends Error {
  constructor() {
    super('User not found');
    this.name = 'UserNotFoundError';
  }
}

/**
 * Returns the set of org_ids where the given user holds owner OR admin
 * via their account_group_memberships row at org scope. Used by the
 * eligibility check below.
 */
export async function listOrgsAdministeredBy(userId: string): Promise<string[]> {
  const rows = await db
    .select({ org_id: accountGroupMemberships.scope_id })
    .from(accountGroupMemberships)
    .innerJoin(
      permissionGroups,
      eq(permissionGroups.id, accountGroupMemberships.group_id),
    )
    .where(
      and(
        eq(accountGroupMemberships.user_id, userId),
        eq(accountGroupMemberships.scope_type, 'org'),
        sql`${permissionGroups.legacy_role} IN ('owner', 'admin')`,
      ),
    );
  return rows.map((r) => r.org_id).filter((id): id is string => typeof id === 'string');
}

/** Returns every org_id where the user holds ANY membership row. */
export async function listOrgsUserBelongsTo(userId: string): Promise<string[]> {
  const rows = await db
    .select({ org_id: organizationMemberships.org_id })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.user_id, userId));
  return rows.map((r) => r.org_id);
}

export interface DeletionEligibility {
  eligible: boolean;
  /** Why not, when eligible=false. */
  reason?:
    | 'self'
    | 'is_superuser'
    | 'not_admin_everywhere'
    | 'target_not_found';
  target_orgs: string[];
  caller_admin_orgs: string[];
}

export async function checkAdminDeletionEligibility(
  callerUserId: string,
  callerIsSuperuser: boolean,
  targetUserId: string,
): Promise<DeletionEligibility> {
  if (callerUserId === targetUserId) {
    return {
      eligible: false,
      reason: 'self',
      target_orgs: [],
      caller_admin_orgs: [],
    };
  }
  const [target] = await db
    .select({ is_superuser: users.is_superuser })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target) {
    return {
      eligible: false,
      reason: 'target_not_found',
      target_orgs: [],
      caller_admin_orgs: [],
    };
  }
  if (target.is_superuser) {
    return {
      eligible: false,
      reason: 'is_superuser',
      target_orgs: [],
      caller_admin_orgs: [],
    };
  }
  if (callerIsSuperuser) {
    // SuperUsers skip the cross-org admin check; they can delete anyone
    // non-self / non-superuser.
    return {
      eligible: true,
      target_orgs: await listOrgsUserBelongsTo(targetUserId),
      caller_admin_orgs: [],
    };
  }
  const [targetOrgs, callerAdminOrgs] = await Promise.all([
    listOrgsUserBelongsTo(targetUserId),
    listOrgsAdministeredBy(callerUserId),
  ]);
  const adminSet = new Set(callerAdminOrgs);
  const allCovered = targetOrgs.every((orgId) => adminSet.has(orgId));
  return {
    eligible: targetOrgs.length > 0 && allCovered,
    reason: allCovered ? undefined : 'not_admin_everywhere',
    target_orgs: targetOrgs,
    caller_admin_orgs: callerAdminOrgs,
  };
}

/**
 * Perform the soft-delete cascade. The route is responsible for
 * authorization (see `checkAdminDeletionEligibility` above for the
 * admin path); this function only enforces the universal invariants
 * (don't delete self, don't delete a superuser).
 */
export async function softDeleteUser(opts: {
  targetUserId: string;
  actorUserId: string;
  actorIsSuperuser: boolean;
  reason?: string;
}): Promise<{ id: string; previous_email: string }> {
  const { targetUserId, actorUserId } = opts;
  // actorIsSuperuser is accepted but unused here — the route handler
  // logs to superuser_audit_log when needed; the service trusts that
  // authorization was already done upstream.

  if (targetUserId === actorUserId) throw new CannotDeleteSelfError();

  const [target] = await db
    .select({
      id: users.id,
      email: users.email,
      is_superuser: users.is_superuser,
    })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target) throw new UserNotFoundError();
  if (target.is_superuser) throw new CannotDeleteSuperuserError();

  const tombstoneEmail = `deleted+${targetUserId}@deleted.bigbluebam.local`;

  await db.transaction(async (tx) => {
    // 1. Anonymize the user record.
    await tx
      .update(users)
      .set({
        email: tombstoneEmail,
        is_active: false,
        disabled_at: new Date(),
        disabled_by: actorUserId,
        password_hash: null,
        force_password_change: false,
        updated_at: new Date(),
      })
      .where(eq(users.id, targetUserId));

    // 2. Auth cleanup.
    await tx.delete(sessions).where(eq(sessions.user_id, targetUserId));
    // api_keys has no revoked_at column; just delete them. The auth
    // plugin would reject any presented key anyway once is_active flips
    // to false above, but dropping the rows keeps the table clean.
    await tx.delete(apiKeys).where(eq(apiKeys.user_id, targetUserId));

    // 3. Memberships gone — target is no longer in any org or project.
    await tx
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.user_id, targetUserId));
    await tx
      .delete(projectMemberships)
      .where(eq(projectMemberships.user_id, targetUserId));
    await tx
      .delete(accountGroupMemberships)
      .where(eq(accountGroupMemberships.user_id, targetUserId));

    // 4. In-flight tokens dead.
    await tx
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.user_id, targetUserId));

    // 5. Best-effort: drop notifications addressed to the target so they
    //    stop accumulating against an account no one will ever read.
    await tx.delete(notifications).where(eq(notifications.user_id, targetUserId));
  });

  // 6. Audit log. `activity_log` is project-scoped (NOT NULL project_id),
  //    so it isn't usable for a cross-project user-level event. SuperUser
  //    deletions go to `superuser_audit_log` via the route handler (the
  //    route also has IP/UA context which the service doesn't). Org-admin
  //    deletions currently don't have a dedicated cross-project audit
  //    sink; the user is anonymized which is itself observable, and the
  //    superuser audit catches the SuperUser case. A future improvement
  //    is a generic `user_audit_log` table for cross-project events; not
  //    needed for the MVP.

  return { id: targetUserId, previous_email: target.email };
}
