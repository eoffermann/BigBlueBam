// slack-import: happy-path handler test using the generated mini fixture.
//
// The worker is exercised end-to-end with a hand-rolled DB mock that
// records every SQL statement and lets the per-phase assertions verify
// counts of inserted rows + bumped totals.

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
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

interface MockState {
  importRowStatus: string;
  importRowPhase: string | null;
  totals: Record<string, number>;
  channelGroupId: string | null;
  insertedMessages: Array<{ id: string; channel: string; ts: string; thread_parent_id: string | null }>;
  insertedChannels: Array<{ id: string; name: string; slug: string }>;
  insertedAttachments: Array<{ id: string; message_id: string; filename: string; is_stub: boolean }>;
  insertedReactions: Array<{ message_id: string; user_id: string; emoji: string }>;
  insertedPins: Array<{ channel_id: string; message_id: string }>;
  insertedUsers: Array<{ id: string; email: string }>;
  insertedMemberships: number;
  emailsQueued: Array<{ name: string; data: unknown }>;
  statusPublishes: Array<{ channel: string; payload: string }>;
}

function createMockDb(
  state: MockState,
  importRow: Record<string, unknown>,
): { execute: (q: any) => Promise<unknown> } {
  let uuidCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++uuidCounter}`;

  return {
    execute: vi.fn(async (q: any) => {
      // Stringify the drizzle sql template to inspect what's running.
      const queryString = JSON.stringify(q);

      // ── SELECT * FROM banter_slack_imports WHERE id = $1
      if (queryString.includes('FROM banter_slack_imports') && queryString.includes('WHERE id =')) {
        if (queryString.includes('SELECT status')) {
          return [{ status: state.importRowStatus }];
        }
        return [{ ...importRow, status: state.importRowStatus, phase: state.importRowPhase, totals_imported: state.totals }];
      }

      // ── UPDATE banter_slack_imports
      if (queryString.includes('UPDATE banter_slack_imports')) {
        // crude phase detection
        const phaseMatch = queryString.match(/phase[^"]*"value":"([a-z_]+)"/);
        if (phaseMatch) state.importRowPhase = phaseMatch[1] ?? state.importRowPhase;
        // totals_imported jsonb bump — match a literal key
        const keyMatch = queryString.match(/jsonb_build_object[^"]*"value":"([a-z]+)"/);
        if (keyMatch && queryString.includes('totals_imported')) {
          // The delta is in the param list as an integer; for the test we
          // simply increment by 1 each call as a smoke check.
          const k = keyMatch[1]!;
          state.totals[k] = (state.totals[k] ?? 0) + 1;
        }
        return [];
      }

      // ── users / orgs / migration bot lookups
      if (queryString.includes('FROM users')) {
        return []; // no auto-matched users — all unmapped per fixture mapping
      }

      if (queryString.includes('INSERT INTO users')) {
        const id = nextId('u');
        const emailMatch = queryString.match(/"value":"([^"]+@[^"]+)"/);
        const email = emailMatch?.[1] ?? `${id}@stub`;
        state.insertedUsers.push({ id, email });
        return [{ id }];
      }

      if (queryString.includes('INSERT INTO organization_memberships')) {
        state.insertedMemberships += 1;
        return [];
      }
      if (queryString.includes('INSERT INTO account_group_memberships')) {
        return [];
      }

      // ── channel group
      if (queryString.includes('INSERT INTO banter_channel_groups')) {
        state.channelGroupId = nextId('cg');
        return [{ id: state.channelGroupId }];
      }
      if (queryString.includes('INSERT INTO projects')) {
        return [{ id: nextId('proj') }];
      }

      // ── channels
      if (queryString.includes('INSERT INTO banter_channels')) {
        const id = nextId('chan');
        const nameMatch = queryString.match(/"value":"([^"]+)"/g) ?? [];
        const slug = nameMatch[1]?.replace(/"value":"|"/g, '') ?? 'unknown';
        state.insertedChannels.push({ id, name: slug, slug });
        return [{ id }];
      }

      if (queryString.includes('FROM banter_channels')) {
        return []; // lookup fallback
      }

      if (queryString.includes('INSERT INTO banter_channel_memberships')) {
        return [];
      }

      // ── messages
      if (queryString.includes('FROM banter_messages') && queryString.includes('slack_source')) {
        // Idempotency lookup — return empty so insert proceeds.
        return [];
      }
      if (queryString.includes('INSERT INTO banter_messages')) {
        const id = nextId('msg');
        // Parse channel id and ts roughly from the JSON-stringified params.
        const channelMatch = queryString.match(/"value":"chan-\d+"/);
        const tsMatch = queryString.match(/"ts":"([^"]+)"/);
        const threadIdx = queryString.indexOf('"slack_source"');
        const parentIdx = queryString.indexOf('thread_parent_id');
        const hasParent = parentIdx > -1 && queryString.indexOf('null', parentIdx) > parentIdx + 50;
        state.insertedMessages.push({
          id,
          channel: channelMatch?.[0] ?? 'unknown',
          ts: tsMatch?.[1] ?? '0',
          thread_parent_id: hasParent ? 'present' : null,
        });
        return [{ id }];
      }

      if (queryString.includes('UPDATE banter_messages') && queryString.includes('reaction_counts')) {
        return [];
      }
      if (queryString.includes('UPDATE banter_messages')) {
        return []; // reconcile reply_count update
      }
      if (queryString.includes('UPDATE banter_channels')) {
        return []; // reconcile
      }

      // ── attachments
      if (queryString.includes('FROM banter_message_attachments')) {
        return [];
      }
      if (queryString.includes('INSERT INTO banter_message_attachments')) {
        const id = nextId('att');
        const fnMatch = queryString.match(/"([^"]+\.(png|txt|jpg|pdf))"/);
        const isStub = queryString.includes('true,null') || queryString.includes('true,"');
        state.insertedAttachments.push({
          id,
          message_id: 'pending',
          filename: fnMatch?.[1] ?? 'unnamed',
          is_stub: isStub,
        });
        return [];
      }

      // ── reactions
      if (queryString.includes('INSERT INTO banter_message_reactions')) {
        state.insertedReactions.push({ message_id: 'pending', user_id: 'u', emoji: ':thumbsup:' });
        return [];
      }

      // ── pins
      if (queryString.includes('INSERT INTO banter_pins')) {
        state.insertedPins.push({ channel_id: 'c', message_id: 'm' });
        return [];
      }

      if (queryString.includes('INSERT INTO notifications')) {
        return [];
      }

      return [];
    }),
  };
}

function createMockMinio(zipBuffer: Buffer) {
  return {
    getObject: vi.fn(async () => Readable.from(zipBuffer)),
    putObject: vi.fn(async () => ({ etag: 'mock', versionId: null })),
  };
}

function makeJob(importId: string): Job<SlackImportJobData> {
  return {
    id: `bullmq:${importId}`,
    data: { import_id: importId },
    name: 'slack-import',
  } as unknown as Job<SlackImportJobData>;
}

describe('processSlackImportJob — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs every phase, inserts messages + channels + attachments + reactions + pins', async () => {
    const fixture = await buildMiniWorkspaceZip();

    const importRow = {
      id: 'import-1',
      org_id: 'org-1',
      project_id: 'proj-1',
      channel_group_id: null,
      initiated_by: 'user-eddie',
      workspace_name: fixture.workspaceName,
      source_filename: 'acme-mini.zip',
      source_size_bytes: fixture.zip.length,
      source_minio_key: 'slack-imports/org-1/import-1.zip',
      mapping: {
        user_mapping: fixture.users.map((u, idx) => ({
          slack_user_id: u.id,
          action: idx === 0 ? 'auto_match' : 'stub',
          target_user_id: idx === 0 ? 'user-eddie' : null,
          slack_email: u.email ?? null,
          slack_display_name: u.name,
        })),
        channel_mapping: fixture.channels.map((c) => ({
          slack_channel_id: c.id,
          slack_name: c.name,
          slack_type: 'public_channel',
          action: 'new',
          target_name: c.name,
          creator_slack_id: c.created_by,
          member_slack_ids: ['U001', 'U002', 'U003', 'U004'],
          // Pin the engineering thread-parent (i=2, cIdx=2 -> ts derived
          // from baseTs + 3*100_000 + 2*60 with the cIdx/i suffix scheme).
          pins: c.name === 'engineering'
            ? [{ id: 'p1', user: 'U001', ts: '1704367320.002002' }]
            : [],
        })),
        project: { mode: 'existing', project_id: 'proj-1' },
        options: {
          preserve_timestamps: true,
          import_attachments: true,
          import_reactions: true,
          import_pins: true,
          import_dms: false,
          notify_on_completion: false,
          dry_run: false,
          daily_message_rate_cap: 5000,
        },
      },
    };

    const state: MockState = {
      importRowStatus: 'pending',
      importRowPhase: null,
      totals: {},
      channelGroupId: null,
      insertedMessages: [],
      insertedChannels: [],
      insertedAttachments: [],
      insertedReactions: [],
      insertedPins: [],
      insertedUsers: [],
      insertedMemberships: 0,
      emailsQueued: [],
      statusPublishes: [],
    };

    const mockDb = createMockDb(state, importRow);
    vi.mocked(getDb).mockReturnValue(mockDb as any);
    const minio = createMockMinio(fixture.zip);

    await processSlackImportJob(makeJob('import-1'), mockLogger, {
      minio: minio as any,
      bucket: 'test-bucket',
      redis: { publish: vi.fn(async () => 1) } as any,
      emailQueue: { add: vi.fn(async () => undefined) } as any,
      cancelChecker: async () => false,
    });

    // Channels
    expect(state.insertedChannels.length).toBe(3);
    // Messages — fixture has 51 across 3 channels.
    expect(state.insertedMessages.length).toBe(fixture.totalMessages);
    // Stubs — 3 unmapped users got stubs (alice was auto-matched).
    expect(state.insertedUsers.length).toBeGreaterThanOrEqual(3);
    // Attachments — engineering's first message had 2 files.
    expect(state.insertedAttachments.length).toBe(2);
    // Reactions — every 5th message in each channel.
    expect(state.insertedReactions.length).toBeGreaterThan(0);
    // Pins — engineering channel
    expect(state.insertedPins.length).toBeGreaterThanOrEqual(1);
    // MinIO putObject was called for the local-file attachment (notes.txt).
    expect(minio.putObject).toHaveBeenCalled();
  });
});
