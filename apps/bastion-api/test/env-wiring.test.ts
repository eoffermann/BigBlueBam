import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #202: every BASTION_* variable bastion-api reads must reach the container. The compose
// service's `environment:` is an explicit list, so a variable missing there is invisible even
// when an operator sets it in .env; the deploy catalog and env hints carry it to Railway.

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const ENV_VARS = [...read('apps/bastion-api/src/env.ts').matchAll(/^\s+(BASTION_[A-Z0-9_]+):/gm)].map((m) => m[1]!);

describe('bastion-api env wiring (#202)', () => {
  const compose = read('docker-compose.yml');
  const block = compose.slice(compose.indexOf('\n  bastion-api:'));
  const serviceEnv = block.slice(0, block.indexOf('depends_on:'));
  const services = read('scripts/deploy/shared/services.mjs');
  const hints = read('scripts/deploy/shared/env-hints.mjs');
  const example = read('.env.example');

  it('finds the variables', () => {
    expect(ENV_VARS).toEqual(expect.arrayContaining(['BASTION_SEAL_RETIRED_PUBLIC_KEYS', 'BASTION_PUT_TIMEOUT_MS', 'BASTION_RUN_LEASE_MS']));
  });

  it.each(ENV_VARS)('%s is in compose bastion-api, the deploy catalog, env hints and .env.example', (v) => {
    expect(serviceEnv, 'docker-compose.yml bastion-api environment').toContain(`- ${v}=\${${v}:-`);
    expect(services, 'services.mjs').toContain(`'${v}'`);
    expect(hints, 'env-hints.mjs').toMatch(new RegExp(`\\b${v}:`));
    expect(example, '.env.example').toMatch(new RegExp(`^#? ?${v}=`, 'm'));
  });
});
