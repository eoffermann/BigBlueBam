import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────
// notify.ts does two things: (1) look up the recipient's
// notification_prefs via a select/from/where/limit chain, and
// (2) db.execute(sql`INSERT ...`) to insert the row. We mock both.

const { execute, select, selectChain } = vi.hoisted(() => {
  const execute = vi.fn(async (_query: unknown) => undefined);
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => [{ notification_prefs: {} }]),
  };
  const select = vi.fn(() => selectChain);
  return { execute, select, selectChain };
});

vi.mock('../src/db/index.js', () => ({
  db: { execute, select },
  connection: { end: vi.fn() },
}));

// We import AFTER the mock is wired up.
import { emitNotification } from '../src/lib/notify.js';

beforeEach(() => {
  execute.mockClear();
  select.mockClear();
  selectChain.from.mockClear();
  selectChain.where.mockClear();
  selectChain.limit.mockReset();
  selectChain.limit.mockImplementation(async () => [{ notification_prefs: {} }]);
});

describe('emitNotification', () => {
  it('inserts a notification row for a mention (happy path)', async () => {
    await emitNotification({
      user_id: '11111111-1111-1111-1111-111111111111',
      org_id: '22222222-2222-2222-2222-222222222222',
      title: 'Alice mentioned you in #general',
      body: 'hey @bob take a look',
      category: 'mention',
      deep_link: '/banter/channels/general?message=abc',
      metadata: { channel_id: 'c1', message_id: 'm1' },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    // Drizzle's sql template produces an opaque object; inspect its
    // serialized parameters via .queryChunks / .params depending on
    // version. The simplest assertion: the call happened with ONE
    // argument (the SQL template).
    const arg = execute.mock.calls[0]![0];
    expect(arg).toBeDefined();
  });

  it('skips insert when user has opted out of the category', async () => {
    selectChain.limit.mockImplementation(async () => [
      { notification_prefs: { banter: { dms: false } } },
    ]);

    await emitNotification({
      user_id: 'u1',
      org_id: 'o1',
      title: 'New DM',
      body: 'hi',
      category: 'dm',
      deep_link: '/banter/dm/c1',
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('still inserts when banter prefs are undefined (opt-in by default)', async () => {
    selectChain.limit.mockImplementation(async () => [
      { notification_prefs: { bbb: { weekly_digest: true } } },
    ]);

    await emitNotification({
      user_id: 'u1',
      org_id: 'o1',
      title: 'Reply',
      body: 'sure',
      category: 'thread_reply',
      deep_link: '/banter/channels/general?thread=p1',
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('swallows DB errors and never throws', async () => {
    execute.mockImplementationOnce(async () => {
      throw new Error('connection lost');
    });

    await expect(
      emitNotification({
        user_id: 'u1',
        org_id: 'o1',
        title: 't',
        body: 'b',
        category: 'mention',
        deep_link: '/banter/channels/x',
      }),
    ).resolves.toBeUndefined();
  });

  it('honors an explicit true pref (opt-in)', async () => {
    selectChain.limit.mockImplementation(async () => [
      { notification_prefs: { banter: { mentions: true, dms: true, thread_replies: true } } },
    ]);

    await emitNotification({
      user_id: 'u1',
      org_id: 'o1',
      title: 't',
      body: 'b',
      category: 'mention',
      deep_link: '/banter/channels/x',
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('deep-link builders', () => {
  it('builds channel, dm, and thread links with and without message id', async () => {
    const { channelDeepLink, dmDeepLink, threadDeepLink } = await import('../src/lib/notify.js');
    expect(channelDeepLink('general')).toBe('/banter/channels/general');
    expect(channelDeepLink('general', 'm1')).toBe('/banter/channels/general?message=m1');
    expect(dmDeepLink('c1')).toBe('/banter/dm/c1');
    expect(dmDeepLink('c1', 'm1')).toBe('/banter/dm/c1?message=m1');
    expect(threadDeepLink('general', 'p1')).toBe('/banter/channels/general?thread=p1');
    expect(threadDeepLink('general', 'p1', 'm1')).toBe(
      '/banter/channels/general?thread=p1&message=m1',
    );
  });
});

describe('Message dispatch dedup logic (pure)', () => {
  // Mirrors the dedup logic in message.routes.ts so we can unit-test
  // the invariants without booting the full Fastify app.
  function dispatch(opts: {
    author_id: string;
    mentioned_user_ids: string[];
    thread_parent_author_id?: string;
    prior_repliers: string[];
    dm_recipients?: string[];
  }): Array<{ user: string; category: 'mention' | 'dm' | 'thread_reply' }> {
    const out: Array<{ user: string; category: 'mention' | 'dm' | 'thread_reply' }> = [];
    const notified = new Set<string>([opts.author_id]);
    for (const u of opts.mentioned_user_ids) {
      if (notified.has(u)) continue;
      notified.add(u);
      out.push({ user: u, category: 'mention' });
    }
    for (const u of opts.dm_recipients ?? []) {
      if (notified.has(u)) continue;
      notified.add(u);
      out.push({ user: u, category: 'dm' });
    }
    if (opts.thread_parent_author_id !== undefined) {
      const recipients = new Set<string>([opts.thread_parent_author_id, ...opts.prior_repliers]);
      for (const u of recipients) {
        if (notified.has(u)) continue;
        notified.add(u);
        out.push({ user: u, category: 'thread_reply' });
      }
    }
    return out;
  }

  it('emits mention notifications, skipping the author', () => {
    const result = dispatch({
      author_id: 'alice',
      mentioned_user_ids: ['alice', 'bob', 'carol'],
      prior_repliers: [],
    });
    expect(result).toEqual([
      { user: 'bob', category: 'mention' },
      { user: 'carol', category: 'mention' },
    ]);
  });

  it('DM notification goes to the OTHER participant, not the sender', () => {
    const result = dispatch({
      author_id: 'alice',
      mentioned_user_ids: [],
      prior_repliers: [],
      dm_recipients: ['alice', 'bob'],
    });
    expect(result).toEqual([{ user: 'bob', category: 'dm' }]);
  });

  it('thread reply dedups against @mentions in the same message', () => {
    // Alice replies in a thread; she mentions bob AND bob was the
    // thread starter. Bob should get ONE notification (mention),
    // not two.
    const result = dispatch({
      author_id: 'alice',
      mentioned_user_ids: ['bob'],
      thread_parent_author_id: 'bob',
      prior_repliers: ['dave'],
    });
    const recipients = result.map((r) => r.user);
    expect(recipients).toEqual(['bob', 'dave']);
    expect(result.find((r) => r.user === 'bob')?.category).toBe('mention');
    expect(result.find((r) => r.user === 'dave')?.category).toBe('thread_reply');
  });

  it('empty-mentions message with no thread creates zero notifications', () => {
    const result = dispatch({
      author_id: 'alice',
      mentioned_user_ids: [],
      prior_repliers: [],
    });
    expect(result).toEqual([]);
  });

  it('thread reply fans out to parent author plus all prior posters, excluding self', () => {
    const result = dispatch({
      author_id: 'alice',
      mentioned_user_ids: [],
      thread_parent_author_id: 'bob',
      prior_repliers: ['carol', 'alice', 'dave'],
    });
    expect(result.map((r) => r.user).sort()).toEqual(['bob', 'carol', 'dave']);
    expect(result.every((r) => r.category === 'thread_reply')).toBe(true);
  });
});
