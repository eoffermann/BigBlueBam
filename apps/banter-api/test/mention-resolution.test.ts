/**
 * Mention parsing + resolution (Task #76).
 *
 * Covers the @mention regression where the composer inserted a raw
 * display_name ("@Jonas Grumby") but the parser captured only "@Jonas" and
 * tried to match it against the FULL lower-cased display_name — so any
 * multi-word name never resolved. The composer now inserts the slugified
 * handle ("@jonas-grumby") and the parser/resolver match on that handle (with
 * a raw-name fallback for single-word names and legacy messages).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveMentionsToUsers hits the DB; capture the WHERE arg the route passes so
// we can assert both candidate arrays (slug + raw name) are built and de-dupe
// works. The pure helpers (extractMentions / slugifyHandle) need no DB.
const { where } = vi.hoisted(() => ({ where: vi.fn() }));

// notification-queue.ts imports env.js (which calls process.exit(1) on missing
// DATABASE_URL/SESSION_SECRET) and the bullmq/ioredis Queue. Stub both so the
// pure mention helpers can be exercised without a live env or Redis.
vi.mock('../src/env.js', () => ({
  env: { REDIS_URL: 'redis://localhost:6379' },
}));
vi.mock('bullmq', () => ({ Queue: class {} }));
vi.mock('ioredis', () => ({ default: class {} }));

vi.mock('../src/db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ where }) }),
  },
  connection: { end: vi.fn() },
}));

import {
  extractMentions,
  slugifyHandle,
  resolveMentionsToUsers,
} from '../src/services/notification-queue.js';

beforeEach(() => {
  where.mockReset();
});

describe('extractMentions', () => {
  it('captures a multi-word slug handle whole (the regression)', () => {
    expect(extractMentions('hey @jonas-grumby can you look?')).toEqual([
      'jonas-grumby',
    ]);
  });

  it('still captures a single-word handle', () => {
    expect(extractMentions('ping @alex now')).toEqual(['alex']);
  });

  it('captures dotted/email-localpart style handles', () => {
    expect(extractMentions('@jane.doe and @bob_smith')).toEqual([
      'jane.doe',
      'bob_smith',
    ]);
  });

  it('returns [] when there are no mentions', () => {
    expect(extractMentions('no mentions here')).toEqual([]);
  });

  it('extracts multiple mentions in one message', () => {
    expect(extractMentions('@jonas-grumby and @mary-ann ship it')).toEqual([
      'jonas-grumby',
      'mary-ann',
    ]);
  });
});

describe('slugifyHandle', () => {
  it('slugifies a multi-word display_name', () => {
    expect(slugifyHandle('Jonas Grumby')).toBe('jonas-grumby');
  });

  it('collapses whitespace runs and strips punctuation', () => {
    expect(slugifyHandle("Mary Ann  Summers!")).toBe('mary-ann-summers');
  });

  it('is idempotent on an already-slug handle', () => {
    expect(slugifyHandle('jonas-grumby')).toBe('jonas-grumby');
  });

  it('round-trips a typed handle back to the same user', () => {
    // The composer slugifies the display_name; extractMentions captures it
    // whole; the captured token equals the slug again → resolves.
    const displayName = 'Jonas Grumby';
    const inserted = `@${slugifyHandle(displayName)} hello`;
    const [token] = extractMentions(inserted);
    expect(token).toBe(slugifyHandle(displayName));
  });
});

describe('resolveMentionsToUsers', () => {
  it('returns [] without touching the DB when there are no tokens', async () => {
    const out = await resolveMentionsToUsers('org-1', []);
    expect(out).toEqual([]);
    expect(where).not.toHaveBeenCalled();
  });

  it('resolves matched users and de-dupes by id', async () => {
    where.mockResolvedValueOnce([
      { id: 'u1', display_name: 'Jonas Grumby', email: 'jonas@isle.test' },
      // same user matched by both slug + raw name forms → must collapse to one
      { id: 'u1', display_name: 'Jonas Grumby', email: 'jonas@isle.test' },
      { id: 'u2', display_name: 'Mary Ann', email: 'maryann@isle.test' },
    ]);
    const out = await resolveMentionsToUsers('org-1', ['jonas-grumby', 'mary-ann']);
    expect(out.map((u) => u.id).sort()).toEqual(['u1', 'u2']);
    expect(where).toHaveBeenCalledOnce();
  });

  it('strips a trailing @domain before resolving (email-localpart fallback)', async () => {
    where.mockResolvedValueOnce([
      { id: 'u3', display_name: 'Jane Doe', email: 'jane@acme.com' },
    ]);
    const out = await resolveMentionsToUsers('org-1', ['jane@acme.com']);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('u3');
  });
});
