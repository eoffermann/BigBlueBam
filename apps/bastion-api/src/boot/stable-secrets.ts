/**
 * Bastion's stable secrets (spec 9.1, 9.4, 9.7).
 *
 * Each one keys or signs durable data, so a silently regenerated value breaks every existing
 * seal, personal-data commitment, auditor-room access hash, or feed key. docker-compose.yml
 * passes them as `${VAR:-}` (never `:?`, which would abort `docker compose up` for the whole
 * suite), so an empty value reaches this process and bastion-api alone refuses to start, with
 * a plain message naming the .env line.
 *
 * Pure and synchronous: no env.ts import, no I/O, so it is unit-testable and runs before the
 * zod schema in env.ts.
 */

export const BASTION_STABLE_SECRETS = [
  'BASTION_SEAL_SIGNING_KEY',
  'BASTION_PD_HMAC_KEY',
  'BASTION_ROOM_IP_SALT',
  'BASTION_FEED_KEY_PEPPER',
] as const;

export type BastionStableSecret = (typeof BASTION_STABLE_SECRETS)[number];

const HEX_64 = /^[0-9a-fA-F]{64}$/;

const DO_NOT_CHANGE: Record<BastionStableSecret, string> = {
  BASTION_SEAL_SIGNING_KEY:
    'Do not change it once set; a new key makes new seals unverifiable against the published keys.',
  BASTION_PD_HMAC_KEY:
    'Do not change it once set; a new key makes every existing personal-data commitment report key_changed.',
  BASTION_ROOM_IP_SALT: 'Do not change it once set.',
  BASTION_FEED_KEY_PEPPER: 'Do not change it once set; a new value invalidates every feed key.',
};

/**
 * Returns one plain-language problem line per missing or malformed secret, in declaration
 * order. An empty array means all four are present and well formed.
 */
export function checkStableSecrets(source: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const name of BASTION_STABLE_SECRETS) {
    const raw = source[name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      problems.push(
        `${name} is missing. Run ./scripts/deploy.sh to generate it, or add a 64-character hex value to .env (${name}=<value>). ${DO_NOT_CHANGE[name]}`,
      );
    } else if (!HEX_64.test(value)) {
      problems.push(
        `${name} in .env is not a 64-character hex value (it has ${value.length} characters). Generate one with: openssl rand -hex 32. ${DO_NOT_CHANGE[name]}`,
      );
    }
  }
  return problems;
}

/** The full refusal text printed before bastion-api exits. */
export function formatStableSecretRefusal(problems: string[]): string {
  return [
    'Bastion cannot start because some of its keys are not set up:',
    ...problems.map((p) => `  - ${p}`),
    'The rest of BigBlueBam is unaffected; only Bastion is stopped.',
  ].join('\n');
}
