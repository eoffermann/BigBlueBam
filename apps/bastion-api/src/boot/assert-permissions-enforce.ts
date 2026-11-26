/**
 * Bastion's per-action permission enforcement is an INVARIANT, not a setting.
 *
 * Same posture as bursar-api and burn-api (burn issues #83 and #89). Every other service gets
 * `BBB_PERMISSIONS_ENFORCE: ${BBB_PERMISSIONS_ENFORCE:-warn}`, and packages/permissions never
 * denies in 'warn' mode; those services survive that because a legacy requireAuth plus
 * org-role gate sits behind requireCan. Bastion has no such gate: its permission actions are
 * the only thing between an ordinary member and evidence, exceptions, the auditor room and
 * settings.
 *
 * Not an env var because ENV_HINTS is one flat global map with no per-service override, so a
 * satellite cannot be given a different value from every other service on Railway.
 *
 * 'on' alone is not fail-closed: the shared plugin returns 'unknown' when the resolver is down
 * or answers badly, and the default onUnknown 'allow' passes that through. Bastion takes a
 * resolver outage as a 403.
 */

export const BASTION_PERMISSIONS_MODE = 'on' as const;
export const BASTION_PERMISSIONS_ON_UNKNOWN = 'deny' as const;

export class PermissionsEnforcementMisconfiguredError extends Error {
  readonly resolved: string;

  constructor(resolved: string) {
    super(
      [
        `bastion-api resolved permission mode '${resolved}', expected 'on'. Bastion has no legacy`,
        'requireAuth+role gate behind the permission plugin, so any other mode would serve',
        'evidence, exceptions and settings to every org member. The mode is the literal',
        'BASTION_PERMISSIONS_MODE in src/boot/assert-permissions-enforce.ts and is not',
        'env-configurable by design.',
      ].join(' '),
    );
    this.name = 'PermissionsEnforcementMisconfiguredError';
    this.resolved = resolved;
  }
}

export class PermissionsFailOpenError extends Error {
  readonly resolved: string;

  constructor(resolved: string) {
    super(
      `bastion-api resolved onUnknown '${resolved}', expected 'deny'. With 'allow', an apps/api outage or an unpropagated INTERNAL_SERVICE_SECRET would pass every request through.`,
    );
    this.name = 'PermissionsFailOpenError';
    this.resolved = resolved;
  }
}

/** Throws unless the mode is exactly 'on' AND onUnknown is exactly 'deny'. */
export function assertPermissionsEnforcement(
  resolved: string | undefined,
  resolvedOnUnknown: string | undefined,
): void {
  if (resolved !== 'on') {
    throw new PermissionsEnforcementMisconfiguredError(resolved ?? '<unset>');
  }
  if (resolvedOnUnknown !== 'deny') {
    throw new PermissionsFailOpenError(resolvedOnUnknown ?? '<unset>');
  }
}
