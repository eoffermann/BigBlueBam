// Unit tests for db-settings.mjs.
//
// The loader shells out to `docker compose exec postgres psql` and
// parses pipe-separated tuples-only output. We test:
//   1. parsePsqlOutput correctly turns canned psql output into the
//      contracted shape (including JSONB parse, default-true on missing
//      auto-update row, etc.)
//   2. loadDeploySettings returns null when .env is missing
//   3. loadDeploySettings injects a runner for tests and surfaces its
//      output through parsePsqlOutput end-to-end
//   4. loadDeploySettings returns null when the runner throws (stack
//      down / docker missing / timeout)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadDeploySettings,
  loadPostgresEnv,
  parsePsqlOutput,
} from './db-settings.mjs';

// ---------------------------------------------------------------------------
// parsePsqlOutput
// ---------------------------------------------------------------------------

describe('parsePsqlOutput', () => {
  it('returns contract defaults for empty output', () => {
    const out = parsePsqlOutput('');
    expect(out).toEqual({
      deploy_branch: null,
      deploy_repo_url: null,
      deploy_github_token_encrypted: null,
      deploy_auto_update_enabled: true,
    });
  });

  it('parses a full row set', () => {
    // psql -t -A -F"|" emits one row per line; JSONB values come back
    // as their JSON source (strings are double-quoted, booleans bare).
    const stdout = [
      'deploy_branch|"stable"',
      'deploy_repo_url|"https://github.com/eoffermann/BigBlueBam.git"',
      'deploy_github_token|"enc:abc:def:ghi"',
      'deploy_auto_update_enabled|false',
    ].join('\n');
    expect(parsePsqlOutput(stdout)).toEqual({
      deploy_branch: 'stable',
      deploy_repo_url: 'https://github.com/eoffermann/BigBlueBam.git',
      deploy_github_token_encrypted: 'enc:abc:def:ghi',
      deploy_auto_update_enabled: false,
    });
  });

  it('keeps the default true when the auto-update row is absent', () => {
    const stdout = 'deploy_branch|"main"\n';
    const out = parsePsqlOutput(stdout);
    expect(out.deploy_branch).toBe('main');
    expect(out.deploy_auto_update_enabled).toBe(true);
  });

  it('treats a JSON null value as "no override"', () => {
    const stdout = [
      'deploy_branch|"stable"',
      'deploy_repo_url|null',
      'deploy_github_token|null',
    ].join('\n');
    const out = parsePsqlOutput(stdout);
    expect(out.deploy_branch).toBe('stable');
    expect(out.deploy_repo_url).toBeNull();
    expect(out.deploy_github_token_encrypted).toBeNull();
  });

  it('rejects a stored token that is missing the enc: prefix', () => {
    // The backend should never store an unprefixed token, but if drift
    // happens we'd rather treat it as missing than hand a plaintext
    // value to the git pull as if it were ciphertext.
    const stdout = 'deploy_github_token|"ghp_naked_token"\n';
    const out = parsePsqlOutput(stdout);
    expect(out.deploy_github_token_encrypted).toBeNull();
  });

  it('ignores unknown keys', () => {
    const stdout = [
      'deploy_branch|"stable"',
      'deploy_unrelated_thing|"surprise"',
    ].join('\n');
    const out = parsePsqlOutput(stdout);
    expect(out.deploy_branch).toBe('stable');
    expect(out).not.toHaveProperty('deploy_unrelated_thing');
  });

  it('skips rows with unparseable JSON', () => {
    const stdout = [
      'deploy_branch|not-valid-json',
      'deploy_auto_update_enabled|true',
    ].join('\n');
    const out = parsePsqlOutput(stdout);
    expect(out.deploy_branch).toBeNull(); // skipped
    expect(out.deploy_auto_update_enabled).toBe(true);
  });

  it('ignores trailing blank lines from psql', () => {
    const stdout = 'deploy_branch|"stable"\n\n\n';
    const out = parsePsqlOutput(stdout);
    expect(out.deploy_branch).toBe('stable');
  });

  it('handles Windows-style CRLF line endings', () => {
    const stdout = 'deploy_branch|"stable"\r\ndeploy_auto_update_enabled|false\r\n';
    const out = parsePsqlOutput(stdout);
    expect(out.deploy_branch).toBe('stable');
    expect(out.deploy_auto_update_enabled).toBe(false);
  });

  it('coerces non-string inputs into the defaults shape', () => {
    expect(parsePsqlOutput(undefined)).toEqual({
      deploy_branch: null,
      deploy_repo_url: null,
      deploy_github_token_encrypted: null,
      deploy_auto_update_enabled: true,
    });
    expect(parsePsqlOutput(null)).toEqual({
      deploy_branch: null,
      deploy_repo_url: null,
      deploy_github_token_encrypted: null,
      deploy_auto_update_enabled: true,
    });
  });
});

// ---------------------------------------------------------------------------
// loadPostgresEnv
// ---------------------------------------------------------------------------

describe('loadPostgresEnv', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bbb-db-settings-'));
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('returns null when .env is missing', () => {
    expect(loadPostgresEnv(tmpDir)).toBeNull();
  });

  it('reads POSTGRES_* values from .env', () => {
    writeFileSync(
      join(tmpDir, '.env'),
      [
        'POSTGRES_USER=bigbluebam',
        'POSTGRES_PASSWORD=hunter2',
        'POSTGRES_DB=bigbluebam',
        'OTHER_KEY=value',
      ].join('\n'),
    );
    expect(loadPostgresEnv(tmpDir)).toEqual({
      user: 'bigbluebam',
      password: 'hunter2',
      db: 'bigbluebam',
    });
  });

  it('strips surrounding quotes from .env values', () => {
    writeFileSync(
      join(tmpDir, '.env'),
      [
        'POSTGRES_USER="bigbluebam"',
        "POSTGRES_PASSWORD='hunter2'",
        'POSTGRES_DB=bigbluebam',
      ].join('\n'),
    );
    const env = loadPostgresEnv(tmpDir);
    expect(env?.user).toBe('bigbluebam');
    expect(env?.password).toBe('hunter2');
  });

  it('returns null when any required key is missing', () => {
    writeFileSync(
      join(tmpDir, '.env'),
      ['POSTGRES_USER=bigbluebam', 'POSTGRES_DB=bigbluebam'].join('\n'),
    );
    expect(loadPostgresEnv(tmpDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadDeploySettings (end-to-end with injected runner)
// ---------------------------------------------------------------------------

describe('loadDeploySettings', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bbb-db-settings-'));
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('returns null when .env is missing', async () => {
    const runner = vi.fn();
    const settings = await loadDeploySettings({ cwd: tmpDir, runner });
    expect(settings).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns parsed settings when the runner returns canned output', async () => {
    writeFileSync(
      join(tmpDir, '.env'),
      [
        'POSTGRES_USER=bigbluebam',
        'POSTGRES_PASSWORD=hunter2',
        'POSTGRES_DB=bigbluebam',
      ].join('\n'),
    );
    const runner = vi.fn(() =>
      ['deploy_branch|"main"', 'deploy_auto_update_enabled|false'].join('\n'),
    );
    const settings = await loadDeploySettings({ cwd: tmpDir, runner });
    expect(runner).toHaveBeenCalledTimes(1);
    const call = runner.mock.calls[0][0];
    expect(call.user).toBe('bigbluebam');
    expect(call.password).toBe('hunter2');
    expect(call.db).toBe('bigbluebam');
    expect(call.sql).toMatch(/SELECT key, value FROM system_settings/i);
    expect(settings).toEqual({
      deploy_branch: 'main',
      deploy_repo_url: null,
      deploy_github_token_encrypted: null,
      deploy_auto_update_enabled: false,
    });
  });

  it('returns null when the runner throws (stack down / docker missing)', async () => {
    writeFileSync(
      join(tmpDir, '.env'),
      [
        'POSTGRES_USER=bigbluebam',
        'POSTGRES_PASSWORD=hunter2',
        'POSTGRES_DB=bigbluebam',
      ].join('\n'),
    );
    const runner = vi.fn(() => {
      throw new Error('docker daemon not reachable');
    });
    const settings = await loadDeploySettings({ cwd: tmpDir, runner });
    expect(settings).toBeNull();
  });

  it('returns defaults shape when the runner returns an empty string', async () => {
    writeFileSync(
      join(tmpDir, '.env'),
      [
        'POSTGRES_USER=bigbluebam',
        'POSTGRES_PASSWORD=hunter2',
        'POSTGRES_DB=bigbluebam',
      ].join('\n'),
    );
    const runner = vi.fn(() => '');
    const settings = await loadDeploySettings({ cwd: tmpDir, runner });
    expect(settings).toEqual({
      deploy_branch: null,
      deploy_repo_url: null,
      deploy_github_token_encrypted: null,
      deploy_auto_update_enabled: true,
    });
  });
});
