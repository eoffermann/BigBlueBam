// slack-import: cancellation test. When the import row's status flips to
// 'aborted' mid-run, the worker must throw SlackImportCancelledError and
// stop without touching cleanup (the banter-api DELETE handler owns that).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { Readable } from 'node:stream';

vi.mock('../src/utils/db.js', () => ({
  getDb: vi.fn(),
}));

import {
  processSlackImportJob,
  SlackImportCancelledError,
  type SlackImportJobData,
} from '../src/jobs/slack-import.job.js';
import { getDb } from '../src/utils/db.js';
import { buildMiniWorkspaceZip } from './fixtures/slack-mini-workspace.js';

const mockLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

function makeJob(importId: string): Job<SlackImportJobData> {
  return {
    id: `bullmq:${importId}`,
    data: { import_id: importId },
    name: 'slack-import',
  } as unknown as Job<SlackImportJobData>;
}

describe('processSlackImportJob — cancellation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws SlackImportCancelledError when the import row flips to aborted', async () => {
    const fixture = await buildMiniWorkspaceZip();
    let cancelCalls = 0;
    let messageInserts = 0;

    const importRow: any = {
      id: 'import-3',
      org_id: 'org-1',
      project_id: 'proj-1',
      channel_group_id: null,
      initiated_by: 'user-eddie',
      workspace_name: fixture.workspaceName,
      source_filename: 'x.zip',
      source_size_bytes: fixture.zip.length,
      source_minio_key: 'k',
      status: 'pending',
      phase: null,
      totals_imported: {},
      mapping: {
        users: fixture.users.map((u) => ({
          slack_user_id: u.id,
          action: 'stub',
          slack_email: u.email ?? null,
          slack_display_name: u.name,
        })),
        channels: fixture.channels.map((c) => ({
          slack_channel_id: c.id,
          slack_name: c.name,
          slack_type: 'public_channel',
          action: 'import_new',
          target_name: c.name,
          creator_slack_id: c.created_by,
          member_slack_ids: ['U001'],
        })),
        project: { mode: 'use_existing', project_id: 'proj-1' },
        options: {
          preserve_timestamps: true,
          import_attachments: false,
          import_reactions: false,
          import_pins: false,
          daily_message_rate_cap: 5000,
        },
      },
    };

    let counter = 0;
    const nextId = (p: string) => `${p}-${++counter}`;

    const db = {
      execute: vi.fn(async (q: any) => {
        const s = JSON.stringify(q);
        if (s.includes('FROM banter_slack_imports')) {
          if (s.includes('SELECT status')) return [{ status: importRow.status }];
          return [importRow];
        }
        if (s.includes('INSERT INTO banter_messages')) {
          messageInserts += 1;
          return [{ id: nextId('msg') }];
        }
        if (s.includes('INSERT INTO banter_channels')) return [{ id: nextId('chan') }];
        if (s.includes('INSERT INTO banter_channel_groups')) return [{ id: nextId('cg') }];
        if (s.includes('INSERT INTO users')) return [{ id: nextId('u') }];
        if (s.includes('FROM banter_messages')) return [];
        if (s.includes('FROM banter_channels')) return [];
        if (s.includes('FROM users')) return [];
        return [];
      }),
    };
    vi.mocked(getDb).mockReturnValue(db as any);

    const minio = {
      getObject: vi.fn(async () => Readable.from(fixture.zip)),
      putObject: vi.fn(async () => ({ etag: 'm', versionId: null })),
    };

    // cancelChecker flips to true on the 6th call so the worker enters at
    // least a couple of phases before being cancelled.
    const cancelChecker = async () => {
      cancelCalls += 1;
      return cancelCalls > 5;
    };

    await expect(
      processSlackImportJob(makeJob('import-3'), mockLogger, {
        minio: minio as any,
        bucket: 'b',
        redis: { publish: vi.fn(async () => 1) } as any,
        emailQueue: { add: vi.fn(async () => undefined) } as any,
        cancelChecker,
      }),
    ).rejects.toBeInstanceOf(SlackImportCancelledError);

    // The worker bailed before finishing the import — message inserts may be
    // greater than zero (some batches landed before the cancel was observed),
    // but we should NOT have inserted all 51 messages.
    expect(messageInserts).toBeLessThan(fixture.totalMessages);
  });
});
