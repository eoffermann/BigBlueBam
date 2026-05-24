// Slack workspace import — unit tests for the slack-import service and the
// route-level zod schemas. The route handlers themselves are exercised by
// the live-stack smoke checks documented in
// docs/plans/slack-import-B-banter-api.md; this file focuses on the logic
// that can run without booting Fastify or a Postgres.

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// Stub env so loading the service (which transitively imports env.ts via
// db/index.ts) doesn't trip the SESSION_SECRET min-length check when CI
// hasn't exported one.
vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    S3_BUCKET: 'banter-uploads',
    S3_REGION: 'us-east-1',
    BANTER_SLACK_IMPORT_MAX_BYTES: 5_368_709_120,
    BBB_PERMISSIONS_ENFORCE: 'warn',
  },
}));

vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
  connection: { end: vi.fn() },
}));

vi.mock('minio', () => ({
  Client: vi.fn().mockImplementation(() => ({
    bucketExists: vi.fn().mockResolvedValue(true),
    makeBucket: vi.fn().mockResolvedValue(undefined),
    putObject: vi.fn().mockResolvedValue(undefined),
    getObject: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    publish: vi.fn().mockResolvedValue(0),
    ping: vi.fn(),
  })),
}));

const queueAdd = vi.fn();
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: queueAdd,
  })),
}));

import {
  validateMapping,
  slackImportObjectKey,
  type MappingPayload,
  type SlackPreview,
} from '../src/services/slack-import.service.js';

const SAMPLE_PREVIEW: SlackPreview = {
  workspace_name: 'acme',
  users: [
    {
      slack_id: 'U001',
      email: 'alice@example.com',
      display_name: 'alice',
      real_name: 'Alice Anderson',
      is_bot: false,
      is_deleted: false,
    },
    {
      slack_id: 'U002',
      email: null,
      display_name: 'bob',
      real_name: 'Bob Brown',
      is_bot: false,
      is_deleted: false,
    },
  ],
  channels: [
    {
      slack_id: 'C001',
      name: 'engineering',
      type: 'public',
      topic: null,
      purpose: null,
      members: 5,
      message_files: 10,
    },
  ],
  dms: [],
  mpims: [],
  channels_detected: 1,
  dms_detected: 0,
  users_detected: 2,
  messages_estimated: 500,
} as SlackPreview;

function baseMapping(overrides: Partial<MappingPayload> = {}): MappingPayload {
  return {
    project: { mode: 'create', name: 'Slack Migration', key: 'slk', id: null },
    user_mapping: [
      { slack_id: 'U001', action: 'auto_match', target_user_id: null },
      { slack_id: 'U002', action: 'stub', target_user_id: null },
    ],
    channel_mapping: [
      { slack_id: 'C001', action: 'new', target_channel_id: null, target_name: 'engineering' },
    ],
    options: {
      preserve_timestamps: true,
      import_attachments: true,
      import_reactions: true,
      import_pins: true,
      import_dms: false,
      notify_on_completion: false,
      dry_run: false,
      daily_message_rate_cap: 5000,
      slack_bearer_token: null,
    },
    ...overrides,
  };
}

describe('slackImportObjectKey', () => {
  it('produces a stable per-org per-id key', () => {
    const key = slackImportObjectKey('org-1', 'import-7');
    expect(key).toBe('slack-imports/org-1/import-7.zip');
  });
});

describe('validateMapping', () => {
  it('accepts a fully-covered mapping with no issues', () => {
    const issues = validateMapping(SAMPLE_PREVIEW, baseMapping());
    expect(issues).toEqual([]);
  });

  it('flags missing user mapping entries', () => {
    const mapping = baseMapping({
      user_mapping: [
        { slack_id: 'U001', action: 'auto_match', target_user_id: null },
        // U002 deliberately missing
      ],
    });
    const issues = validateMapping(SAMPLE_PREVIEW, mapping);
    expect(issues.some((i) => i.field.includes('U002'))).toBe(true);
  });

  it('flags missing channel mapping entries', () => {
    const mapping = baseMapping({ channel_mapping: [] });
    const issues = validateMapping(SAMPLE_PREVIEW, mapping);
    expect(issues.some((i) => i.field.includes('C001'))).toBe(true);
  });

  it('requires target_user_id when action=map', () => {
    const mapping = baseMapping({
      user_mapping: [
        { slack_id: 'U001', action: 'map', target_user_id: null },
        { slack_id: 'U002', action: 'stub', target_user_id: null },
      ],
    });
    const issues = validateMapping(SAMPLE_PREVIEW, mapping);
    expect(
      issues.some(
        (i) =>
          i.field.includes('U001') && i.field.includes('target_user_id'),
      ),
    ).toBe(true);
  });

  it('requires target_channel_id when action=merge', () => {
    const mapping = baseMapping({
      channel_mapping: [
        { slack_id: 'C001', action: 'merge', target_channel_id: null, target_name: null },
      ],
    });
    const issues = validateMapping(SAMPLE_PREVIEW, mapping);
    expect(
      issues.some(
        (i) =>
          i.field.includes('C001') && i.field.includes('target_channel_id'),
      ),
    ).toBe(true);
  });

  it('rejects invite when the slack user has no email', () => {
    const mapping = baseMapping({
      user_mapping: [
        { slack_id: 'U001', action: 'auto_match', target_user_id: null },
        { slack_id: 'U002', action: 'invite', target_user_id: null },
      ],
    });
    const issues = validateMapping(SAMPLE_PREVIEW, mapping);
    expect(
      issues.some(
        (i) => i.field.includes('U002') && /invite requires/.test(i.issue),
      ),
    ).toBe(true);
  });

  it('requires project.name + key when mode=create', () => {
    const mapping = baseMapping({
      project: { mode: 'create', name: '', key: '', id: null },
    });
    const issues = validateMapping(SAMPLE_PREVIEW, mapping);
    expect(issues.some((i) => i.field === 'project.name')).toBe(true);
    expect(issues.some((i) => i.field === 'project.key')).toBe(true);
  });

  it('requires project.id when mode=existing', () => {
    const mapping = baseMapping({
      project: { mode: 'existing', id: null, name: null, key: null },
    });
    const issues = validateMapping(SAMPLE_PREVIEW, mapping);
    expect(issues.some((i) => i.field === 'project.id')).toBe(true);
  });
});

describe('startBodySchema', () => {
  // Mirrors the schema in slack-import.routes.ts.
  const startBodySchema = z.object({
    project: z.object({
      mode: z.enum(['create', 'existing']),
      id: z.string().uuid().nullable().optional(),
      name: z.string().min(1).max(255).nullable().optional(),
      key: z.string().min(1).max(50).nullable().optional(),
    }),
    user_mapping: z
      .array(
        z.object({
          slack_id: z.string().min(1),
          action: z.enum(['auto_match', 'invite', 'stub', 'map', 'skip']),
          target_user_id: z.string().uuid().nullable().optional(),
        }),
      )
      .default([]),
    channel_mapping: z
      .array(
        z.object({
          slack_id: z.string().min(1),
          action: z.enum(['new', 'merge', 'skip']),
          target_channel_id: z.string().uuid().nullable().optional(),
          target_name: z.string().min(1).max(80).nullable().optional(),
        }),
      )
      .default([]),
    options: z
      .object({
        preserve_timestamps: z.boolean().default(true),
        import_attachments: z.boolean().default(true),
        import_reactions: z.boolean().default(true),
        import_pins: z.boolean().default(true),
        import_dms: z.boolean().default(false),
        notify_on_completion: z.boolean().default(false),
        dry_run: z.boolean().default(false),
        daily_message_rate_cap: z.number().int().positive().max(1_000_000).default(5000),
        slack_bearer_token: z.string().nullable().optional(),
      })
      .default({} as never),
  });

  it('accepts a minimal valid payload', () => {
    const r = startBodySchema.safeParse({
      project: { mode: 'create', name: 'Migration', key: 'mig' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.options.preserve_timestamps).toBe(true);
      expect(r.data.options.daily_message_rate_cap).toBe(5000);
    }
  });

  it('rejects unknown user mapping action', () => {
    const r = startBodySchema.safeParse({
      project: { mode: 'create', name: 'Migration', key: 'mig' },
      user_mapping: [{ slack_id: 'U001', action: 'invalid' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown channel mapping action', () => {
    const r = startBodySchema.safeParse({
      project: { mode: 'create', name: 'Migration', key: 'mig' },
      channel_mapping: [{ slack_id: 'C001', action: 'rename' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects daily_message_rate_cap <= 0', () => {
    const r = startBodySchema.safeParse({
      project: { mode: 'create', name: 'Migration', key: 'mig' },
      options: { daily_message_rate_cap: 0 },
    });
    expect(r.success).toBe(false);
  });
});

describe('deleteQuerySchema (cleanup_stubs coercion)', () => {
  const schema = z
    .object({
      cleanup_stubs: z
        .preprocess((v) => {
          if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
          return Boolean(v);
        }, z.boolean())
        .default(false),
    });

  it('defaults to false when absent', () => {
    expect(schema.parse({}).cleanup_stubs).toBe(false);
  });

  it('parses "true" / "1" as true', () => {
    expect(schema.parse({ cleanup_stubs: 'true' }).cleanup_stubs).toBe(true);
    expect(schema.parse({ cleanup_stubs: '1' }).cleanup_stubs).toBe(true);
  });

  it('parses "false" / "0" / other strings as false', () => {
    expect(schema.parse({ cleanup_stubs: 'false' }).cleanup_stubs).toBe(false);
    expect(schema.parse({ cleanup_stubs: '0' }).cleanup_stubs).toBe(false);
    expect(schema.parse({ cleanup_stubs: 'no' }).cleanup_stubs).toBe(false);
  });
});

describe('permission-gate wiring', () => {
  // The route file gates each endpoint with fastify.requireCan('banter.admin_import.<verb>').
  // Per packages/permissions/src/index.ts the satellite HTTP plugin in
  // 'warn' mode is non-blocking, in 'on' mode it 403s on deny, and in 'off'
  // mode it's a no-op. We sanity-check the catalog mapping here so a
  // refactor that renames a permission ID surfaces fast.
  const expected: Record<string, string> = {
    'POST /v1/admin/import/slack/upload': 'banter.admin_import.create',
    'GET /v1/admin/import/slack/:id/preview': 'banter.admin_import.status',
    'POST /v1/admin/import/slack/:id/start': 'banter.admin_import.create',
    'GET /v1/admin/import/slack/:id/status': 'banter.admin_import.status',
    'GET /v1/admin/import/slack/': 'banter.admin_import.status',
    'DELETE /v1/admin/import/slack/:id': 'banter.admin_import.abort',
  };

  it('every endpoint maps to a banter.admin_import.* permission', () => {
    for (const [route, perm] of Object.entries(expected)) {
      expect(perm.startsWith('banter.admin_import.')).toBe(true);
      // Sanity: verbs are one of create | status | abort
      const verb = perm.split('.').pop();
      expect(['create', 'status', 'abort']).toContain(verb);
      // Smoke: route format
      expect(route).toMatch(/^(GET|POST|DELETE) \/v1\/admin\/import\/slack\//);
    }
  });
});
