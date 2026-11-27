import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    transaction: vi.fn(),
    execute: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4005,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    S3_ENDPOINT: 'http://minio:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    S3_BUCKET: 'brief-uploads',
    S3_REGION: 'us-east-1',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    BEACON_API_INTERNAL_URL: 'http://beacon-api:4004',
    COOKIE_SECURE: false,
  },
}));

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

function chainable(result: unknown[]) {
  const obj: any = {};
  obj.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(result).then(resolve as any, reject as any);
  obj.limit = vi.fn().mockResolvedValue(result);
  obj.returning = vi.fn().mockResolvedValue(result);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.fields = vi.fn().mockReturnValue(obj);
  obj.innerJoin = vi.fn().mockReturnValue(obj);
  obj.leftJoin = vi.fn().mockReturnValue(obj);
  obj.onConflictDoNothing = vi.fn().mockReturnValue(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const DOC_ID = '00000000-0000-0000-0000-000000000010';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const USER_ID_2 = '00000000-0000-0000-0000-000000000004';
const COMMENT_ID = '00000000-0000-0000-0000-000000000030';
const PARENT_COMMENT_ID = '00000000-0000-0000-0000-000000000031';

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMENT_ID,
    document_id: DOC_ID,
    parent_id: null,
    author_id: USER_ID,
    body: 'This is a test comment.',
    anchor_start: null,
    anchor_end: null,
    anchor_text: null,
    resolved: false,
    resolved_by: null,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CommentError
// ---------------------------------------------------------------------------

describe('CommentError', () => {
  it('should create error with code, message, and status', async () => {
    const { CommentError } = await import('../src/services/comment.service.js');
    const error = new CommentError('NOT_FOUND', 'Comment not found', 404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Comment not found');
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('CommentError');
  });
});

// ---------------------------------------------------------------------------
// createComment
// ---------------------------------------------------------------------------

describe('createComment', () => {
  let createComment: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/comment.service.js');
    createComment = mod.createComment;
  });

  it('should create a top-level comment on a document', async () => {
    const comment = makeComment();
    mockInsert.mockReturnValue(chainable([comment]));

    const result = await createComment(DOC_ID, { body: 'This is a test comment.' }, USER_ID);
    expect(result).toBeDefined();
    expect(result.body).toBe('This is a test comment.');
    expect(result.document_id).toBe(DOC_ID);
    expect(result.parent_id).toBeNull();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should create a threaded reply with parent_id', async () => {
    const reply = makeComment({
      id: '00000000-0000-0000-0000-000000000032',
      parent_id: PARENT_COMMENT_ID,
      body: 'Reply to parent',
    });

    mockSelect.mockReturnValue(chainable([{ document_id: DOC_ID }]));
    mockInsert.mockReturnValue(chainable([reply]));

    const result = await createComment(
      DOC_ID,
      { body: 'Reply to parent', parent_id: PARENT_COMMENT_ID },
      USER_ID,
    );

    expect(result.parent_id).toBe(PARENT_COMMENT_ID);
    expect(result.body).toBe('Reply to parent');
  });

  it('should throw NOT_FOUND when parent comment belongs to different document', async () => {
    mockSelect.mockReturnValue(chainable([{ document_id: 'other-doc-id' }]));

    await expect(
      createComment(DOC_ID, { body: 'Reply', parent_id: PARENT_COMMENT_ID }, USER_ID),
    ).rejects.toThrow('Parent comment not found');
  });

  it('should throw NOT_FOUND when parent comment does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      createComment(DOC_ID, { body: 'Reply', parent_id: 'nonexistent' }, USER_ID),
    ).rejects.toThrow('Parent comment not found');
  });

  it('should create a comment with anchor text', async () => {
    const comment = makeComment({
      anchor_text: 'selected text',
      anchor_start: { offset: 10 },
      anchor_end: { offset: 23 },
    });

    mockInsert.mockReturnValue(chainable([comment]));

    const result = await createComment(
      DOC_ID,
      {
        body: 'Comment on this selection',
        anchor_text: 'selected text',
        anchor_start: { offset: 10 },
        anchor_end: { offset: 23 },
      },
      USER_ID,
    );

    expect(result.anchor_text).toBe('selected text');
    expect(result.anchor_start).toEqual({ offset: 10 });
  });
});

// ---------------------------------------------------------------------------
// listComments
// ---------------------------------------------------------------------------

describe('listComments', () => {
  let listComments: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/comment.service.js');
    listComments = mod.listComments;
  });

  it('should return threaded comment structure', async () => {
    const parent = makeComment({ id: 'c1', parent_id: null });
    const reply = makeComment({ id: 'c2', parent_id: 'c1', body: 'A reply' });

    mockSelect.mockReturnValue(
      chainable([
        { comment: parent, author_name: 'Alice', author_avatar: null },
        { comment: reply, author_name: 'Bob', author_avatar: null },
      ]),
    );

    const result = await listComments(DOC_ID);
    expect(result).toHaveLength(1); // Only top-level
    expect(result[0].id).toBe('c1');
    expect(result[0].replies).toHaveLength(1);
    expect(result[0].replies[0].id).toBe('c2');
  });
});

// ---------------------------------------------------------------------------
// updateComment
// ---------------------------------------------------------------------------

describe('updateComment', () => {
  let updateComment: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/comment.service.js');
    updateComment = mod.updateComment;
  });

  it('should update comment body by the author', async () => {
    const existing = makeComment({ author_id: USER_ID });
    const updated = makeComment({ body: 'Updated body' });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([updated]));

    const result = await updateComment(COMMENT_ID, 'Updated body', USER_ID);
    expect(result.body).toBe('Updated body');
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('should throw FORBIDDEN when non-author tries to edit', async () => {
    const existing = makeComment({ author_id: USER_ID });
    mockSelect.mockReturnValue(chainable([existing]));

    await expect(
      updateComment(COMMENT_ID, 'Hacked!', USER_ID_2),
    ).rejects.toThrow('You can only edit your own comments');
  });

  it('should throw NOT_FOUND when comment does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      updateComment(COMMENT_ID, 'New body', USER_ID),
    ).rejects.toThrow('Comment not found');
  });
});

// ---------------------------------------------------------------------------
// deleteComment
// ---------------------------------------------------------------------------

describe('deleteComment', () => {
  let deleteComment: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/comment.service.js');
    deleteComment = mod.deleteComment;
  });

  it('should delete comment by the author', async () => {
    const existing = makeComment({ author_id: USER_ID });
    mockSelect.mockReturnValue(chainable([existing]));
    mockDelete.mockReturnValue(chainable([existing]));

    const result = await deleteComment(COMMENT_ID, USER_ID, false);
    expect(result).toBeDefined();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('should allow admin to delete any comment', async () => {
    const existing = makeComment({ author_id: USER_ID });
    mockSelect.mockReturnValue(chainable([existing]));
    mockDelete.mockReturnValue(chainable([existing]));

    const result = await deleteComment(COMMENT_ID, USER_ID_2, true);
    expect(result).toBeDefined();
  });

  it('should throw FORBIDDEN when non-author non-admin tries to delete', async () => {
    const existing = makeComment({ author_id: USER_ID });
    mockSelect.mockReturnValue(chainable([existing]));

    await expect(deleteComment(COMMENT_ID, USER_ID_2, false)).rejects.toThrow(
      'You can only delete your own comments',
    );
  });
});

// ---------------------------------------------------------------------------
// toggleResolve
// ---------------------------------------------------------------------------

describe('toggleResolve', () => {
  let toggleResolve: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/comment.service.js');
    toggleResolve = mod.toggleResolve;
  });

  it('should resolve an unresolved comment', async () => {
    const existing = makeComment({ resolved: false });
    const resolved = makeComment({ resolved: true, resolved_by: USER_ID });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([resolved]));

    const result = await toggleResolve(COMMENT_ID, USER_ID);
    expect(result.resolved).toBe(true);
    expect(result.resolved_by).toBe(USER_ID);
  });

  it('should unresolve a resolved comment', async () => {
    const existing = makeComment({ resolved: true, resolved_by: USER_ID });
    const unresolved = makeComment({ resolved: false, resolved_by: null });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([unresolved]));

    const result = await toggleResolve(COMMENT_ID, USER_ID);
    expect(result.resolved).toBe(false);
    expect(result.resolved_by).toBeNull();
  });

  it('should throw NOT_FOUND when comment does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(toggleResolve(COMMENT_ID, USER_ID)).rejects.toThrow(
      'Comment not found',
    );
  });
});

// ---------------------------------------------------------------------------
// addReaction / removeReaction
// ---------------------------------------------------------------------------

describe('addReaction', () => {
  let addReaction: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/comment.service.js');
    addReaction = mod.addReaction;
  });

  it('should add a reaction to a comment', async () => {
    const existing = makeComment();
    const reaction = { id: 'r1', comment_id: COMMENT_ID, user_id: USER_ID, emoji: '👍' };
    mockSelect.mockReturnValue(chainable([existing]));
    mockInsert.mockReturnValue(chainable([reaction]));

    const result = await addReaction(COMMENT_ID, USER_ID, '👍');
    expect(result).toBeDefined();
    expect(result.emoji).toBe('👍');
  });

  it('should return null when duplicate reaction (conflict)', async () => {
    const existing = makeComment();
    mockSelect.mockReturnValue(chainable([existing]));
    mockInsert.mockReturnValue(chainable([]));

    const result = await addReaction(COMMENT_ID, USER_ID, '👍');
    expect(result).toBeNull();
  });
});

describe('removeReaction', () => {
  let removeReaction: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/comment.service.js');
    removeReaction = mod.removeReaction;
  });

  it('should remove a reaction', async () => {
    const existing = makeComment();
    const reaction = { id: 'r1', comment_id: COMMENT_ID, user_id: USER_ID, emoji: '👍' };
    mockSelect.mockReturnValue(chainable([existing]));
    mockDelete.mockReturnValue(chainable([reaction]));

    const result = await removeReaction(COMMENT_ID, USER_ID, '👍');
    expect(result).toBeDefined();
    expect(result.emoji).toBe('👍');
  });

  it('should return null when reaction not found', async () => {
    const existing = makeComment();
    mockSelect.mockReturnValue(chainable([existing]));
    mockDelete.mockReturnValue(chainable([]));

    const result = await removeReaction(COMMENT_ID, USER_ID, '🎉');
    expect(result).toBeNull();
  });
});
