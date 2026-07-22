import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env, the db, the enqueue lib, and the storage helper so the service under
// test runs without a real database, Redis, or object store.
vi.mock('../src/env.js', () => ({
  env: {
    S3_BUCKET: 'test-bucket',
    REDIS_URL: 'redis://localhost:6379',
    PUBLIC_URL: 'https://bigbluebam.com',
  },
}));

const execute = vi.fn();
vi.mock('../src/db/index.js', () => ({ db: { execute }, connection: { end: vi.fn() } }));

const enqueueBackup = vi.fn();
const enqueueRestore = vi.fn();
vi.mock('../src/lib/backup-queue.js', () => ({ enqueueBackup, enqueueRestore }));

vi.mock('../src/services/upload.service.js', () => ({
  getFileStream: vi.fn(),
  deleteFile: vi.fn(),
}));

const svc = await import('../src/services/backup.service.js');

const BACKUP_ID = 'abcd1234-5678-90ab-cdef-1234567890ab';
const completedBackup = {
  id: BACKUP_ID,
  scope: 'platform',
  kind: 'manual',
  status: 'completed',
  storage_key: 'backups/platform/x.dump',
  size_bytes: 100,
  pg_version: '16',
  integrity: 'sha256:abc',
  triggered_by_user_id: null,
  started_at: null,
  completed_at: null,
  error: null,
  created_at: '2026-07-21T00:00:00Z',
};

beforeEach(() => {
  execute.mockReset();
  enqueueBackup.mockReset();
  enqueueRestore.mockReset();
});

describe('backupDownloadFilename', () => {
  it('names a platform archive in plain English with the site and a UTC datestamp', () => {
    expect(svc.backupDownloadFilename({ ...completedBackup, completed_at: null })).toBe(
      'BigBlueBam Backup - Entire Site - bigbluebam.com - 2026-07-21 0000 UTC.backup',
    );
  });

  it('prefers when the backup finished over when it was queued', () => {
    expect(
      svc.backupDownloadFilename({
        ...completedBackup,
        completed_at: '2026-07-22T19:40:10Z',
      }),
    ).toBe('BigBlueBam Backup - Entire Site - bigbluebam.com - 2026-07-22 1940 UTC.backup');
  });

  it('says which organization or project a scoped backup covers', () => {
    expect(
      svc.backupDownloadFilename({
        ...completedBackup,
        scope: 'organization',
        scope_subject: 'Gilligan Travel Ltd',
        completed_at: null,
      }),
    ).toBe(
      'BigBlueBam Backup - Organization Gilligan Travel Ltd - bigbluebam.com - 2026-07-21 0000 UTC.backup',
    );
    expect(
      svc.backupDownloadFilename({
        ...completedBackup,
        scope: 'project',
        scope_subject: 'Coconut Radio',
        completed_at: null,
      }),
    ).toBe(
      'BigBlueBam Backup - Project Coconut Radio - bigbluebam.com - 2026-07-21 0000 UTC.backup',
    );
  });

  it('strips characters Windows and macOS reject in a filename', () => {
    const name = svc.backupDownloadFilename({
      ...completedBackup,
      scope: 'project',
      scope_subject: 'Q3/Q4: "Rescue" plan?',
      completed_at: null,
    });
    expect(name).toBe(
      'BigBlueBam Backup - Project Q3 Q4 Rescue plan - bigbluebam.com - 2026-07-21 0000 UTC.backup',
    );
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
  });
});

describe('restoreConfirmationPhrase', () => {
  it('is RESTORE + the first 8 chars of the backup id', () => {
    expect(svc.restoreConfirmationPhrase(BACKUP_ID)).toBe('RESTORE abcd1234');
  });
});

describe('requestRestore gating', () => {
  it('rejects a wrong confirmation phrase and does NOT enqueue', async () => {
    execute.mockResolvedValueOnce([completedBackup]); // getBackup
    const r = await svc.requestRestore(BACKUP_ID, 'user-1', 'nope');
    expect(r).toEqual({ ok: false, reason: 'phrase_mismatch' });
    expect(enqueueRestore).not.toHaveBeenCalled();
  });

  it('rejects restoring a backup that is not completed', async () => {
    execute.mockResolvedValueOnce([{ ...completedBackup, status: 'running' }]);
    const r = await svc.requestRestore(BACKUP_ID, 'user-1', 'RESTORE abcd1234');
    expect(r).toEqual({ ok: false, reason: 'backup_not_restorable' });
    expect(enqueueRestore).not.toHaveBeenCalled();
  });

  it('rejects restoring a backup with no archive', async () => {
    execute.mockResolvedValueOnce([{ ...completedBackup, storage_key: null }]);
    const r = await svc.requestRestore(BACKUP_ID, 'user-1', 'RESTORE abcd1234');
    expect(r).toEqual({ ok: false, reason: 'backup_not_restorable' });
    expect(enqueueRestore).not.toHaveBeenCalled();
  });

  it('accepts the exact phrase, creates a restore row, and enqueues it', async () => {
    execute
      .mockResolvedValueOnce([completedBackup]) // getBackup
      .mockResolvedValueOnce([{ id: 'restore-1' }]); // INSERT platform_restores
    const r = await svc.requestRestore(BACKUP_ID, 'user-1', '  RESTORE abcd1234  ');
    expect(r).toEqual({ ok: true, restoreId: 'restore-1' });
    expect(enqueueRestore).toHaveBeenCalledWith('restore-1');
  });
});

describe('createBackup', () => {
  it('inserts a pending row and enqueues the dump', async () => {
    execute
      .mockResolvedValueOnce([{ id: 'backup-9' }]) // INSERT
      .mockResolvedValueOnce([{ ...completedBackup, id: 'backup-9', status: 'pending' }]); // getBackup
    const b = await svc.createBackup('user-1');
    expect(b?.id).toBe('backup-9');
    expect(enqueueBackup).toHaveBeenCalledWith('backup-9');
  });
});
