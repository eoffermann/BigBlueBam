import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- hoisted mocks ----------
const { mockDb, mockArgon2 } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn().mockReturnValue({ from: vi.fn() }),
    insert: vi.fn().mockReturnValue({ values: vi.fn() }),
    update: vi.fn().mockReturnValue({ set: vi.fn() }),
    delete: vi.fn().mockReturnValue({ where: vi.fn() }),
    transaction: vi.fn(),
  };
  const mockArgon2 = {
    hash: vi.fn().mockResolvedValue('$argon2id$hashed-password'),
    verify: vi.fn(),
  };
  return { mockDb, mockArgon2 };
});

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

vi.mock('argon2', () => ({ default: mockArgon2 }));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-session-id-123456789012345678901234567890'),
}));

// ---------- imports ----------
import {
  register,
  login,
  logout,
  createSession,
  getUserById,
  updateProfile,
  AuthError,
} from '../src/services/auth.service.js';

// ---------- helpers ----------
const fakeOrg = { id: 'org-1', name: 'Test Org', slug: 'test-org', created_at: new Date() };
const fakeUser = {
  id: 'user-1',
  org_id: 'org-1',
  email: 'test@example.com',
  display_name: 'Test User',
  password_hash: '$argon2id$existing-hash',
  role: 'owner',
  is_active: true,
  avatar_url: null,
  timezone: 'UTC',
  notification_prefs: {},
  last_seen_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};
const fakeSession = {
  id: 'test-session-id-123456789012345678901234567890',
  user_id: 'user-1',
  expires_at: new Date(Date.now() + 604800 * 1000),
  data: {},
  created_at: new Date(),
};

// ---------- tests ----------
describe('Auth Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('register', () => {
    it('creates org + user + session and returns all three', async () => {
      // The transaction callback receives tx and we control what it returns.
      // Wave E.F: register now also inserts an organization_memberships row
      // and an account_group_memberships row (the latter via
      // setUserOrgRole, which uses .values().onConflictDoUpdate()).
      mockDb.transaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<unknown>) => {
        const txInsertReturning = vi.fn();
        // Each .values() call returns a chain that supports both
        // .returning() (for org/user/session inserts) and
        // .onConflictDoUpdate() (for the setUserOrgRole upsert).
        const txInsertValues = vi.fn().mockReturnValue({
          returning: txInsertReturning,
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        });
        const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });

        // Insert order: org -> user -> organization_memberships ->
        //   (setUserOrgRole INSERT, onConflictDoUpdate) -> session
        // Only the org / user / session inserts call .returning().
        txInsertReturning
          .mockResolvedValueOnce([fakeOrg])
          .mockResolvedValueOnce([fakeUser])
          .mockResolvedValueOnce([fakeSession]);

        // seedDefaultPriorities runs inside the same transaction via
        // raw SQL (tx.execute).
        const localTx = { insert: txInsert, execute: vi.fn().mockResolvedValue(undefined) };
        return cb(localTx as any);
      });

      const result = await register({
        email: 'test@example.com',
        password: 'securePassword123!',
        display_name: 'Test User',
        org_name: 'Test Org',
      });

      expect(result).toHaveProperty('org');
      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('session');
      expect(result.org.id).toBe('org-1');
      expect(result.user.id).toBe('user-1');
      expect(result.session.id).toBe(fakeSession.id);
    });

    it('hashes the password with argon2', async () => {
      mockDb.transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
        const txInsertReturning = vi.fn()
          .mockResolvedValueOnce([fakeOrg])
          .mockResolvedValueOnce([fakeUser])
          .mockResolvedValueOnce([fakeSession]);
        // Wave E.F: setUserOrgRole uses .onConflictDoUpdate(), and the
        // organization_memberships insert has no .returning() call.
        const txInsertValues = vi.fn().mockReturnValue({
          returning: txInsertReturning,
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        });
        const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
        return cb({ insert: txInsert, execute: vi.fn().mockResolvedValue(undefined) });
      });

      await register({
        email: 'test@example.com',
        password: 'securePassword123!',
        display_name: 'Test User',
        org_name: 'Test Org',
      });

      expect(mockArgon2.hash).toHaveBeenCalledWith('securePassword123!');
    });
  });

  describe('login', () => {
    function setupSelectChain(rows: unknown[]) {
      const limitFn = vi.fn().mockResolvedValue(rows);
      const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });
      return { fromFn, whereFn, limitFn };
    }

    function setupUpdateChain(rows: unknown[] = []) {
      const returningFn = vi.fn().mockResolvedValue(rows);
      const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
      const setFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.update.mockReturnValue({ set: setFn });
      return { setFn, whereFn };
    }

    function setupInsertChain(rows: unknown[]) {
      const returningFn = vi.fn().mockResolvedValue(rows);
      const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
      mockDb.insert.mockReturnValue({ values: valuesFn });
    }

    it('validates credentials, creates session, and returns user', async () => {
      // First select: find user by email
      const selectLimit = vi.fn().mockResolvedValue([fakeUser]);
      const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
      const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
      mockDb.select.mockReturnValue({ from: selectFrom });

      mockArgon2.verify.mockResolvedValue(true);

      // Insert session
      const insertReturning = vi.fn().mockResolvedValue([fakeSession]);
      const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
      mockDb.insert.mockReturnValue({ values: insertValues });

      // Update last_seen_at
      const updateReturning = vi.fn().mockResolvedValue([fakeUser]);
      const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      mockDb.update.mockReturnValue({ set: updateSet });

      const result = await login('test@example.com', 'securePassword123!');

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('session');
      expect(result.user.email).toBe('test@example.com');
      expect(mockArgon2.verify).toHaveBeenCalledWith('$argon2id$existing-hash', 'securePassword123!');
    });

    it('throws AuthError for invalid credentials (user not found)', async () => {
      setupSelectChain([]);

      await expect(login('unknown@example.com', 'password123456'))
        .rejects.toThrow(AuthError);

      try {
        await login('unknown@example.com', 'password123456');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('INVALID_CREDENTIALS');
      }
    });

    it('throws AuthError for wrong password', async () => {
      setupSelectChain([fakeUser]);
      mockArgon2.verify.mockResolvedValue(false);

      await expect(login('test@example.com', 'wrongpassword1'))
        .rejects.toThrow(AuthError);
    });

    it('throws AuthError for disabled accounts', async () => {
      const disabledUser = { ...fakeUser, is_active: false };
      setupSelectChain([disabledUser]);

      await expect(login('test@example.com', 'securePassword123!'))
        .rejects.toThrow(AuthError);

      try {
        await login('test@example.com', 'securePassword123!');
      } catch (err) {
        expect((err as AuthError).code).toBe('ACCOUNT_DISABLED');
      }
    });
  });

  describe('logout', () => {
    it('deletes session from DB', async () => {
      const whereFn = vi.fn().mockResolvedValue(undefined);
      mockDb.delete.mockReturnValue({ where: whereFn });

      await logout('session-id-to-delete');

      expect(mockDb.delete).toHaveBeenCalled();
      expect(whereFn).toHaveBeenCalled();
    });
  });

  describe('createSession', () => {
    it('generates nanoid, inserts session with expiry, and returns it', async () => {
      const returningFn = vi.fn().mockResolvedValue([fakeSession]);
      const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
      mockDb.insert.mockReturnValue({ values: valuesFn });

      const session = await createSession('user-1');

      expect(session).toBeDefined();
      expect(session.id).toBe(fakeSession.id);
      expect(session.user_id).toBe('user-1');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(valuesFn).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-session-id-123456789012345678901234567890',
          user_id: 'user-1',
          data: {},
        }),
      );
    });
  });

  describe('getUserById', () => {
    it('returns user when found', async () => {
      const limitFn = vi.fn().mockResolvedValue([fakeUser]);
      const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await getUserById('user-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('user-1');
    });

    it('returns null when user not found', async () => {
      const limitFn = vi.fn().mockResolvedValue([]);
      const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await getUserById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('updateProfile', () => {
    it('updates specified fields and returns user', async () => {
      const returningFn = vi.fn().mockResolvedValue([{ ...fakeUser, display_name: 'New Name' }]);
      const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
      const setFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.update.mockReturnValue({ set: setFn });

      const result = await updateProfile('user-1', { display_name: 'New Name' });

      expect(result).not.toBeNull();
      expect(result!.display_name).toBe('New Name');
      expect(setFn).toHaveBeenCalledWith(
        expect.objectContaining({ display_name: 'New Name' }),
      );
    });

    it('returns null when user does not exist', async () => {
      const returningFn = vi.fn().mockResolvedValue([]);
      const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
      const setFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.update.mockReturnValue({ set: setFn });

      const result = await updateProfile('nonexistent', { display_name: 'Nobody' });

      expect(result).toBeNull();
    });
  });

  describe('AuthError', () => {
    it('creates error with code, message, and default statusCode 401', () => {
      const error = new AuthError('INVALID_CREDENTIALS', 'Invalid email or password');
      expect(error.code).toBe('INVALID_CREDENTIALS');
      expect(error.message).toBe('Invalid email or password');
      expect(error.statusCode).toBe(401);
      expect(error.name).toBe('AuthError');
      expect(error).toBeInstanceOf(Error);
    });

    it('supports custom statusCode', () => {
      const error = new AuthError('ACCOUNT_DISABLED', 'Account disabled', 403);
      expect(error.statusCode).toBe(403);
    });
  });
});
