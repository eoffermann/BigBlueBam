import { describe, it, expect, vi } from 'vitest';

// schema-wait.ts imports db/index.js (which connects on import); the pure
// pendingMigrations helper under test doesn't touch it, so stub it out.
vi.mock('../src/db/index.js', () => ({ db: {}, connection: {} }));

import { pendingMigrations } from '../src/boot/schema-wait.js';

describe('pendingMigrations', () => {
  it('returns ids (sans .sql) present on disk but missing from schema_migrations', () => {
    const files = ['0001_init.sql', '0002_users.sql', '0003_orgs.sql'];
    const applied = new Set(['0001_init', '0002_users']);
    expect(pendingMigrations(files, applied)).toEqual(['0003_orgs']);
  });

  it('returns [] when every bundled migration is applied (the steady state)', () => {
    const files = ['0001_init.sql', '0002_users.sql'];
    const applied = new Set(['0001_init', '0002_users']);
    expect(pendingMigrations(files, applied)).toEqual([]);
  });

  it('ignores non-.sql files and sorts the result', () => {
    const files = ['README.md', '0003_orgs.sql', '0002_users.sql', '.keep'];
    expect(pendingMigrations(files, new Set())).toEqual(['0002_users', '0003_orgs']);
  });

  it('treats an empty applied set as all-pending (fresh DB)', () => {
    const files = ['0001_init.sql', '0002_users.sql'];
    expect(pendingMigrations(files, new Set())).toEqual(['0001_init', '0002_users']);
  });
});
