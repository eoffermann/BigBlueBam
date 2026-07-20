import { describe, it, expect } from 'vitest';
import {
  BURSAR_PERMISSIONS_MODE,
  BURSAR_PERMISSIONS_ON_UNKNOWN,
  PermissionsEnforcementMisconfiguredError,
  PermissionsFailOpenError,
  assertPermissionsEnforcement,
} from '../src/boot/assert-permissions-enforce.js';

// The fail-closed boot invariant (spec 13.3). bursar-api has no legacy requireAuth+role gate
// behind requireCan, so 'on' + onUnknown 'deny' is the ONLY posture that does not serve sealed
// bids and per-vendor spend to any member. Ported from burn's safety suite.

describe('bursar permissions enforcement invariant', () => {
  it('the hardcoded constants are on / deny', () => {
    expect(BURSAR_PERMISSIONS_MODE).toBe('on');
    expect(BURSAR_PERMISSIONS_ON_UNKNOWN).toBe('deny');
  });

  it('passes for the exact invariant', () => {
    expect(() => assertPermissionsEnforcement('on', 'deny')).not.toThrow();
  });

  it('throws when the mode is not on (warn would never deny)', () => {
    expect(() => assertPermissionsEnforcement('warn', 'deny')).toThrow(
      PermissionsEnforcementMisconfiguredError,
    );
    expect(() => assertPermissionsEnforcement(undefined, 'deny')).toThrow(
      PermissionsEnforcementMisconfiguredError,
    );
  });

  it('throws when onUnknown is not deny (on alone still passes unresolvable decisions through)', () => {
    expect(() => assertPermissionsEnforcement('on', 'allow')).toThrow(PermissionsFailOpenError);
    expect(() => assertPermissionsEnforcement('on', undefined)).toThrow(PermissionsFailOpenError);
  });
});
