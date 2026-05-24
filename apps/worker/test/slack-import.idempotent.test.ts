// slack-import: idempotency test. Running the same import twice must
// produce zero NEW row inserts on the second pass.
//
// We simulate idempotency by having the mock DB remember every
// (import_id, ts) it has seen for messages, and (import_id, slack_file_id)
// for attachments — exactly the keys the unique partial indexes enforce
// in real Postgres (see migration 0167).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { Readable } from 'node:stream';

vi.mock('../src/utils/db.js', () => ({
  getDb: vi.fn(),
}));

import {
  processSlackImportJob,
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

interface IdempState {
  seenMessageTs: Set<string>;
  seenAttachmentFileIds: Set<string>;
  messageInsertsThisRun: number;
  attachmentInsertsThisRun: number;
  channelInsertsThisRun: number;
  reactionInsertsThisRun: number;
  channelGroupId: string | null;
  userIds: Map<string, string>;
}

function createIdempDb(state: IdempState, importRow: any) {
  let counter = 0;
  const nextId = (p: string) => `${p}-${++counter}`;

  return {
    execute: vi.fn(async (q: any) => {
      const s = JSON.stringify(q);

      if (s.includes('FROM banter_slack_imports')) {
        if (s.includes('SELECT status')) return [{ status: importRow.status }];
        return [importRow];
      }

      // Message idempotency lookup. The ts is the SECOND positional param
      // (after import_id) in the lookup query. In the JSON-stringified
      // drizzle template, params appear as bare strings like
      // "1704367320.002002".
      if (s.includes('FROM banter_messages') && s.includes('slack_source')) {
        const tsMatches = Array.from(s.matchAll(/"([0-9]{10}\.[0-9]+)"/g));
        const ts = tsMatches[0]?.[1];
        if (ts && state.seenMessageTs.has(ts)) {
          return [{ id: `msg-existing-${ts}` }];
        }
        return [];
      }

      if (s.includes('INSERT INTO banter_messages')) {
        // Find the ts inside the slack_source jsonb literal. In the
        // stringified template the embedded quotes are escaped, so
        // "ts":"..." appears as ts\":\"...\".
        const tsMatch = s.match(/ts\\":\\"([0-9]{10}\.[0-9]+)\\"/);
        const ts = tsMatch?.[1];
        if (ts) {
          if (state.seenMessageTs.has(ts)) {
            // Real DB's ON CONFLICT path returns no rows; simulate.
            return [];
          }
          state.seenMessageTs.add(ts);
        }
        state.messageInsertsThisRun += 1;
        return [{ id: nextId('msg') }];
      }

      // Attachment idempotency lookup: extract the file id from the
      // parameter list. Drizzle templates render bare params verbatim, so
      // the second positional param after the import_id is the file id.
      if (s.includes('FROM banter_message_attachments')) {
        const fidMatches = Array.from(s.matchAll(/"(F\d+)"/g));
        const fid = fidMatches[0]?.[1];
        if (fid && state.seenAttachmentFileIds.has(fid)) {
          return [{ id: `att-existing-${fid}` }];
        }
        return [];
      }
      if (s.includes('INSERT INTO banter_message_attachments')) {
        // Find the slack_file_id inside the JSON-stringified jsonb literal
        // (note the escape on the embedded quotes).
        const fidMatch = s.match(/slack_file_id\\":\\"(F\d+)\\"/);
        const fid = fidMatch?.[1];
        if (fid && !state.seenAttachmentFileIds.has(fid)) {
          state.seenAttachmentFileIds.add(fid);
        }
        // Even when fid extraction fails, count the insert so the test can
        // verify the worker reached this branch at all.
        state.attachmentInsertsThisRun += 1;
        return [];
      }

      if (s.includes('INSERT INTO banter_channels')) {
        state.channelInsertsThisRun += 1;
        return [{ id: nextId('chan') }];
      }
      if (s.includes('FROM banter_channels')) return [];

      if (s.includes('INSERT INTO banter_channel_groups')) {
        if (state.channelGroupId) return [{ id: state.channelGroupId }];
        state.channelGroupId = nextId('cg');
        return [{ id: state.channelGroupId }];
      }

      if (s.includes('INSERT INTO users')) {
        const emailMatch = s.match(/"value":"([^"]+@[^"]+)"/);
        const email = emailMatch?.[1] ?? `${nextId('u')}@stub`;
        if (state.userIds.has(email)) return [{ id: state.userIds.get(email) }];
        const id = nextId('u');
        state.userIds.set(email, id);
        return [{ id }];
      }
      if (s.includes('FROM users')) return [];

      if (s.includes('INSERT INTO banter_message_reactions')) {
        state.reactionInsertsThisRun += 1;
        return [];
      }

      return [];
    }),
  };
}

describe('processSlackImportJob — idempotency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('second run inserts zero new messages and attachments', async () => {
    const fixture = await buildMiniWorkspaceZip();

    const importRow: any = {
      id: 'import-2',
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
          member_slack_ids: ['U001','U002','U003','U004'],
        })),
        project: { mode: 'use_existing', project_id: 'proj-1' },
        options: {
          preserve_timestamps: true,
          import_attachments: true,
          import_reactions: true,
          import_pins: false,
          daily_message_rate_cap: 5000,
        },
      },
    };

    const state: IdempState = {
      seenMessageTs: new Set(),
      seenAttachmentFileIds: new Set(),
      messageInsertsThisRun: 0,
      attachmentInsertsThisRun: 0,
      channelInsertsThisRun: 0,
      reactionInsertsThisRun: 0,
      channelGroupId: null,
      userIds: new Map(),
    };

    const mockDb = createIdempDb(state, importRow);
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const minio = {
      getObject: vi.fn(async () => Readable.from(fixture.zip)),
      putObject: vi.fn(async () => ({ etag: 'm', versionId: null })),
    };

    // First run
    await processSlackImportJob(makeJob('import-2'), mockLogger, {
      minio: minio as any,
      bucket: 'b',
      redis: { publish: vi.fn(async () => 1) } as any,
      emailQueue: { add: vi.fn(async () => undefined) } as any,
      cancelChecker: async () => false,
    });

    const firstRunMessages = state.messageInsertsThisRun;
    const firstRunAttachments = state.attachmentInsertsThisRun;
    expect(firstRunMessages).toBe(fixture.totalMessages);
    expect(firstRunAttachments).toBeGreaterThanOrEqual(1);

    // Reset per-run counters, keep the seen-sets so the second pass sees
    // every message + attachment as "already imported".
    state.messageInsertsThisRun = 0;
    state.attachmentInsertsThisRun = 0;
    state.reactionInsertsThisRun = 0;

    // Re-open the fixture for the second pass (the prior stream consumed it).
    minio.getObject.mockImplementation(async () => Readable.from(fixture.zip));

    // Second run — must be a no-op for messages + attachments.
    await processSlackImportJob(makeJob('import-2'), mockLogger, {
      minio: minio as any,
      bucket: 'b',
      redis: { publish: vi.fn(async () => 1) } as any,
      emailQueue: { add: vi.fn(async () => undefined) } as any,
      cancelChecker: async () => false,
    });

    expect(state.messageInsertsThisRun).toBe(0);
    expect(state.attachmentInsertsThisRun).toBe(0);
  });
});
