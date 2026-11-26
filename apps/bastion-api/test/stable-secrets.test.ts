import { describe, it, expect } from 'vitest';
import {
  BASTION_STABLE_SECRETS,
  checkStableSecrets,
  formatStableSecretRefusal,
} from '../src/boot/stable-secrets.js';

const good = 'a'.repeat(64);
const allGood = Object.fromEntries(BASTION_STABLE_SECRETS.map((n) => [n, good]));

describe('stable-secret refusal (spec 9.1)', () => {
  it('covers exactly the four spec 9.4 secrets', () => {
    expect([...BASTION_STABLE_SECRETS].sort()).toEqual([
      'BASTION_FEED_KEY_PEPPER',
      'BASTION_PD_HMAC_KEY',
      'BASTION_ROOM_IP_SALT',
      'BASTION_SEAL_SIGNING_KEY',
    ]);
  });

  it('accepts four 64-character hex values', () => {
    expect(checkStableSecrets(allGood)).toEqual([]);
    expect(checkStableSecrets({ ...allGood, BASTION_PD_HMAC_KEY: 'ABCDEF0123456789'.repeat(4) })).toEqual([]);
  });

  it('a fresh .env (all four empty, as compose `${VAR:-}` passes them) names every line', () => {
    const fresh = Object.fromEntries(BASTION_STABLE_SECRETS.map((n) => [n, '']));
    const problems = checkStableSecrets(fresh);
    expect(problems).toHaveLength(4);
    for (const name of BASTION_STABLE_SECRETS) {
      expect(problems.some((p) => p.startsWith(`${name} is missing.`))).toBe(true);
    }
    expect(problems[1]).toContain('Run ./scripts/deploy.sh to generate it, or add a 64-character hex value to .env');
    expect(problems[1]).toContain('Do not change it once set');
  });

  it('treats an unset variable the same as an empty one', () => {
    const { BASTION_ROOM_IP_SALT: _drop, ...rest } = allGood;
    expect(checkStableSecrets(rest)).toEqual([expect.stringMatching(/^BASTION_ROOM_IP_SALT is missing\./)]);
  });

  it('rejects malformed values with a plain message and never echoes the value', () => {
    const secretish = 'not-hex-but-secret-value';
    const problems = checkStableSecrets({ ...allGood, BASTION_FEED_KEY_PEPPER: secretish });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^BASTION_FEED_KEY_PEPPER in \.env is not a 64-character hex value/);
    expect(problems[0]).not.toContain(secretish);
    expect(checkStableSecrets({ ...allGood, BASTION_SEAL_SIGNING_KEY: 'a'.repeat(63) })).toHaveLength(1);
    expect(checkStableSecrets({ ...allGood, BASTION_SEAL_SIGNING_KEY: 'g'.repeat(64) })).toHaveLength(1);
  });

  it('the refusal says only Bastion is stopped', () => {
    const text = formatStableSecretRefusal(['X is missing.']);
    expect(text).toContain('Bastion cannot start');
    expect(text).toContain('  - X is missing.');
    expect(text).toContain('The rest of BigBlueBam is unaffected');
  });
});
