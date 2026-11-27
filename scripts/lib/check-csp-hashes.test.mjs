// Tests for scripts/check-csp-hashes.mjs. Run with `pnpm test:scripts`.
//
// Every tamper case mutates the REAL committed configs in memory, so these
// tests also prove the guard still understands the configs as they are today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeConfig,
  parseNginx,
  sha256Source,
  inlineScripts,
  DEFAULT_CONFIGS,
} from '../check-csp-hashes.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const ROOT_CONF = 'infra/nginx/nginx.conf';
const SITE_CONF = 'infra/nginx/nginx-with-site.conf';

test('all committed nginx configs pass', () => {
  for (const rel of DEFAULT_CONFIGS) {
    const { errors } = analyzeConfig(read(rel), rel);
    assert.deepEqual(errors, [], `${rel} should pass`);
  }
});

test('the root redirect is actually checked (not vacuously passing)', () => {
  const { info } = analyzeConfig(read(ROOT_CONF), ROOT_CONF);
  assert.ok(info.some((l) => /location = \/ .*inline script matches its CSP hash/.test(l)), info.join('\n'));
});

test('editing the inline root-redirect script without regenerating the hash fails', () => {
  const tampered = read(ROOT_CONF).replace('location.replace("/helpdesk/")})', 'location.replace("/b3/")})');
  assert.notEqual(tampered, read(ROOT_CONF), 'fixture edit must apply');
  const { errors } = analyzeConfig(tampered, 'tampered');
  assert.ok(errors.some((e) => /does not allow/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /stale/.test(e)), 'the old hash is now stale too');
});

test('a corrupted declared hash fails', () => {
  const tampered = read(ROOT_CONF).replace("'sha256-qt05", "'sha256-XX05");
  assert.notEqual(tampered, read(ROOT_CONF), 'fixture edit must apply');
  const { errors } = analyzeConfig(tampered, 'tampered');
  assert.ok(errors.some((e) => /does not allow/.test(e)), errors.join('\n'));
});

test("'unsafe-inline' in the suite script-src fails", () => {
  for (const rel of DEFAULT_CONFIGS) {
    const src = read(rel);
    const tampered = src.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    assert.notEqual(tampered, src, `${rel}: fixture edit must apply`);
    const { errors } = analyzeConfig(tampered, rel);
    assert.ok(errors.some((e) => /'unsafe-inline'/.test(e)), `${rel}: ${errors.join('\n')}`);
  }
});

test('dropping the CSP from the SPA index.html location fails (add_header non-inheritance)', () => {
  for (const rel of DEFAULT_CONFIGS) {
    const src = read(rel);
    const tampered = src.replace(/\n\s*add_header Content-Security-Policy \$bbb_csp always;(\n\s*try_files \$uri =404;)/, '$1');
    assert.notEqual(tampered, src, `${rel}: fixture edit must apply`);
    const { errors } = analyzeConfig(tampered, rel);
    assert.ok(errors.some((e) => /index\\\.html.*NO Content-Security-Policy/s.test(e)), `${rel}: ${errors.join('\n')}`);
  }
});

test('an inline script served with no hash at all fails', () => {
  const conf = `server {
    set $bbb_csp "default-src 'self'; script-src 'self'";
    add_header Content-Security-Policy $bbb_csp always;
    location = / { return 200 '<script>alert(1)</script>'; }
  }`;
  const { errors } = analyzeConfig(conf, 'inline');
  assert.ok(errors.some((e) => /does not allow/.test(e)), errors.join('\n'));
});

test('a location-level set override is honoured', () => {
  const body = 'go()';
  const conf = `server {
    set $bbb_csp "default-src 'self'; script-src 'self'";
    add_header Content-Security-Policy $bbb_csp always;
    location = / {
      set $bbb_csp "script-src '${sha256Source(body)}'";
      return 200 '<script>${body}</script>';
    }
  }`;
  assert.deepEqual(analyzeConfig(conf, 'override').errors, []);
});

test('parser is quote-aware: braces and # inside the inline JS do not break nesting', () => {
  const tree = parseNginx(`server { location = / { return 200 '<script>if(a){b("#x")}</script>'; } location /x/ { } }`);
  const server = tree.block[0];
  assert.equal(server.block.length, 2);
  assert.equal(server.block[0].block[0].args[1], '<script>if(a){b("#x")}</script>');
});

test('inlineScripts skips external scripts', () => {
  assert.deepEqual(inlineScripts('<script src="/a.js"></script><script>x()</script>'), ['x()']);
});
