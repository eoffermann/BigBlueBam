import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB module
vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
  },
  connection: { end: vi.fn() },
}));

// Mock realtime service
vi.mock('../src/services/realtime.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcastToOrg: vi.fn(),
  broadcastToUser: vi.fn(),
  setRedisPublisher: vi.fn(),
}));

import { z } from 'zod';

describe('Channel Routes - Validation', () => {

  const createChannelSchema = z.object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be lowercase alphanumeric with hyphens'),
    type: z.enum(['public', 'private']).default('public'),
    topic: z.string().max(500).optional(),
    description: z.string().optional(),
    channel_group_id: z.string().uuid().optional(),
  });

  const updateChannelSchema = z.object({
    name: z.string().min(1).max(80).optional(),
    display_name: z.string().max(100).nullable().optional(),
    topic: z.string().max(500).nullable().optional(),
    description: z.string().nullable().optional(),
    icon: z.string().max(10).nullable().optional(),
    channel_group_id: z.string().uuid().nullable().optional(),
    allow_bots: z.boolean().optional(),
    allow_huddles: z.boolean().optional(),
    message_retention_days: z.number().int().min(0).nullable().optional(),
  });

  describe('createChannelSchema', () => {
    it('should validate a valid channel creation request', () => {
      const result = createChannelSchema.safeParse({
        name: 'backend-standup',
        type: 'public',
        topic: 'Daily standup updates',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('backend-standup');
        expect(result.data.type).toBe('public');
      }
    });

    it('should reject channel names with spaces', () => {
      const result = createChannelSchema.safeParse({
        name: 'invalid channel name',
      });
      expect(result.success).toBe(false);
    });

    it('should reject channel names with uppercase', () => {
      const result = createChannelSchema.safeParse({
        name: 'InvalidName',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty channel names', () => {
      const result = createChannelSchema.safeParse({
        name: '',
      });
      expect(result.success).toBe(false);
    });

    it('should default type to public', () => {
      const result = createChannelSchema.safeParse({
        name: 'general',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('public');
      }
    });

    it('should reject invalid channel types', () => {
      const result = createChannelSchema.safeParse({
        name: 'test',
        type: 'dm',
      });
      expect(result.success).toBe(false);
    });

    it('should validate topic length', () => {
      const result = createChannelSchema.safeParse({
        name: 'test',
        topic: 'x'.repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid UUID for channel_group_id', () => {
      const result = createChannelSchema.safeParse({
        name: 'test',
        channel_group_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid UUID for channel_group_id', () => {
      const result = createChannelSchema.safeParse({
        name: 'test',
        channel_group_id: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('updateChannelSchema', () => {
    it('should validate a partial update', () => {
      const result = updateChannelSchema.safeParse({
        topic: 'New topic',
      });
      expect(result.success).toBe(true);
    });

    it('should allow nullable fields', () => {
      const result = updateChannelSchema.safeParse({
        display_name: null,
        topic: null,
        description: null,
        icon: null,
        channel_group_id: null,
      });
      expect(result.success).toBe(true);
    });

    it('should validate message_retention_days is non-negative', () => {
      const result = updateChannelSchema.safeParse({
        message_retention_days: -1,
      });
      expect(result.success).toBe(false);
    });

    it('should accept empty object (no-op update)', () => {
      const result = updateChannelSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should validate boolean fields', () => {
      const result = updateChannelSchema.safeParse({
        allow_bots: true,
        allow_huddles: false,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('addMembersSchema', () => {
    const addMembersSchema = z.object({
      user_ids: z.array(z.string().uuid()).min(1).max(100),
    });

    it('should validate a valid request', () => {
      const result = addMembersSchema.safeParse({
        user_ids: ['550e8400-e29b-41d4-a716-446655440000'],
      });
      expect(result.success).toBe(true);
    });

    it('should reject empty user_ids array', () => {
      const result = addMembersSchema.safeParse({
        user_ids: [],
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-UUID values', () => {
      const result = addMembersSchema.safeParse({
        user_ids: ['not-a-uuid'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('bulkCreateChannelSchema', () => {
    const MAX_BULK_CHANNELS = 50;
    // Mirrors bulkCreateChannelSchema in channel.routes.ts. Per-row names are
    // intentionally NOT regex-validated here — they're validated at execution
    // time so a single bad row reports 'invalid' instead of 400-ing the batch.
    const bulkCreateChannelSchema = z.object({
      channels: z
        .array(
          z.object({
            name: z.string(),
            type: z.enum(['public', 'private']).optional(),
            topic: z.string().max(500).optional(),
            description: z.string().optional(),
          }),
        )
        .min(1)
        .max(MAX_BULK_CHANNELS),
      type: z.enum(['public', 'private']).optional(),
    });

    it('should validate a batch with a top-level default type', () => {
      const result = bulkCreateChannelSchema.safeParse({
        channels: [{ name: 'one' }, { name: 'two' }],
        type: 'private',
      });
      expect(result.success).toBe(true);
    });

    it('should accept per-row type overrides', () => {
      const result = bulkCreateChannelSchema.safeParse({
        channels: [{ name: 'one', type: 'public' }, { name: 'two', type: 'private' }],
      });
      expect(result.success).toBe(true);
    });

    it('should reject an empty channels array', () => {
      const result = bulkCreateChannelSchema.safeParse({ channels: [] });
      expect(result.success).toBe(false);
    });

    it('should reject more than the max batch size', () => {
      const result = bulkCreateChannelSchema.safeParse({
        channels: Array.from({ length: MAX_BULK_CHANNELS + 1 }, (_, i) => ({ name: `c${i}` })),
      });
      expect(result.success).toBe(false);
    });

    it('should accept exactly the max batch size', () => {
      const result = bulkCreateChannelSchema.safeParse({
        channels: Array.from({ length: MAX_BULK_CHANNELS }, (_, i) => ({ name: `c${i}` })),
      });
      expect(result.success).toBe(true);
    });

    it('should not regex-reject malformed names at the schema layer', () => {
      // Per-row validation happens at execution time; the schema only checks
      // that name is a string so the batch isn't rejected wholesale.
      const result = bulkCreateChannelSchema.safeParse({
        channels: [{ name: 'Invalid Name With Spaces' }],
      });
      expect(result.success).toBe(true);
    });
  });
});
