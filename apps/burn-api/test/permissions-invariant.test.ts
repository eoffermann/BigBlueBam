import { describe, it, expect } from 'vitest';
import {
  BURN_PERMISSIONS_MODE,
  BURN_PERMISSIONS_ON_UNKNOWN,
  PermissionsEnforcementMisconfiguredError,
  PermissionsFailOpenError,
  assertPermissionsEnforcement,
} from '../src/boot/assert-permissions-enforce.js';

/**
 * Burn's permission posture is an invariant, not a setting (spec 2.4 point 1, issues #83
 * and #89). Two halves, and BOTH are required:
 *
 *   - mode 'on', because 'warn' short-circuits before it can ever deny;
 *   - onUnknown 'deny', because 'on' passes an unresolvable decision straight through.
 *
 * Burn has no legacy requireAuth plus org-role gate behind requireCan, so either half
 * missing serves per-person compensation and firm-wide profitability to every org member.
 */
describe('burn permission enforcement invariant', () => {
  it('pins the two constants', () => {
    expect(BURN_PERMISSIONS_MODE).toBe('on');
    expect(BURN_PERMISSIONS_ON_UNKNOWN).toBe('deny');
  });

  it('accepts the invariant pair', () => {
    expect(() => assertPermissionsEnforcement('on', 'deny')).not.toThrow();
  });

  it('rejects any mode other than on', () => {
    for (const mode of ['warn', 'off', '', undefined]) {
      expect(() => assertPermissionsEnforcement(mode, 'deny')).toThrow(
        PermissionsEnforcementMisconfiguredError,
      );
    }
  });

  it('rejects a fail-open onUnknown even when the mode is on', () => {
    for (const onUnknown of ['allow', '', undefined]) {
      expect(() => assertPermissionsEnforcement('on', onUnknown)).toThrow(PermissionsFailOpenError);
    }
  });
});
