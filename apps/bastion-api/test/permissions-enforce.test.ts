import { describe, it, expect } from 'vitest';
import {
  BASTION_PERMISSIONS_MODE,
  BASTION_PERMISSIONS_ON_UNKNOWN,
  PermissionsEnforcementMisconfiguredError,
  PermissionsFailOpenError,
  assertPermissionsEnforcement,
} from '../src/boot/assert-permissions-enforce.js';

describe('bastion permissions enforcement invariant', () => {
  it('the hardcoded constants are on / deny', () => {
    expect(BASTION_PERMISSIONS_MODE).toBe('on');
    expect(BASTION_PERMISSIONS_ON_UNKNOWN).toBe('deny');
  });

  it('passes for the exact invariant', () => {
    expect(() => assertPermissionsEnforcement('on', 'deny')).not.toThrow();
  });

  it('throws when the mode is not on', () => {
    expect(() => assertPermissionsEnforcement('warn', 'deny')).toThrow(PermissionsEnforcementMisconfiguredError);
    expect(() => assertPermissionsEnforcement(undefined, 'deny')).toThrow(PermissionsEnforcementMisconfiguredError);
  });

  it('throws when an unresolvable decision would be allowed', () => {
    expect(() => assertPermissionsEnforcement('on', 'allow')).toThrow(PermissionsFailOpenError);
    expect(() => assertPermissionsEnforcement('on', undefined)).toThrow(PermissionsFailOpenError);
  });
});
