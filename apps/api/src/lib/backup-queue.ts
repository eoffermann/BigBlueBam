// BullMQ producers for the database backup/restore worker jobs (Backup app).
// The worker (apps/worker) consumes these queues; the api only enqueues.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../env.js';

let backupQueue: Queue | null = null;
let restoreQueue: Queue | null = null;

function connection() {
  // BullMQ requires maxRetriesPerRequest: null on the ioredis connection.
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

function getBackupQueue(): Queue {
  if (!backupQueue) backupQueue = new Queue('backup-database', { connection: connection() });
  return backupQueue;
}

function getRestoreQueue(): Queue {
  if (!restoreQueue) restoreQueue = new Queue('restore-database', { connection: connection() });
  return restoreQueue;
}

/** Enqueue an on-demand whole-database backup for a pre-created platform_backups row. */
export async function enqueueBackup(backupId: string): Promise<void> {
  await getBackupQueue().add(
    'manual-backup',
    { backup_id: backupId, kind: 'manual' },
    { removeOnComplete: 200, removeOnFail: 200 },
  );
}

/** Enqueue a destructive restore for a pre-created platform_restores row. */
export async function enqueueRestore(restoreId: string): Promise<void> {
  await getRestoreQueue().add(
    'restore',
    { restore_id: restoreId },
    { removeOnComplete: 200, removeOnFail: 200 },
  );
}
