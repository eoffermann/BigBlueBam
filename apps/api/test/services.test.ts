import { describe, it, expect, vi } from 'vitest';

// Mock the database module before importing services
vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$argon2id$hashed'),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-session-id-123456789012345678901234567890'),
}));

// Mock env
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

describe('AuthError', () => {
  it('should create an error with code and message', async () => {
    const { AuthError } = await import('../src/services/auth.service.js');
    const error = new AuthError('INVALID_CREDENTIALS', 'Invalid email or password');
    expect(error.code).toBe('INVALID_CREDENTIALS');
    expect(error.message).toBe('Invalid email or password');
    expect(error.statusCode).toBe(401);
    expect(error.name).toBe('AuthError');
  });

  it('should support custom status codes', async () => {
    const { AuthError } = await import('../src/services/auth.service.js');
    const error = new AuthError('ACCOUNT_DISABLED', 'Account disabled', 403);
    expect(error.statusCode).toBe(403);
  });
});

describe('TaskError', () => {
  it('should create an error with code and message', async () => {
    const { TaskError } = await import('../src/services/task.service.js');
    const error = new TaskError('NOT_FOUND', 'Task not found', 404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Task not found');
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('TaskError');
  });
});

describe('Error handler', () => {
  it('should format validation errors correctly', async () => {
    const { errorHandler } = await import('../src/middleware/error-handler.js');

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const mockRequest = {
      id: 'req-123',
      log: { error: vi.fn() },
    };

    const error = Object.assign(new Error('Validation failed'), {
      validation: [{ keyword: 'required', params: { missingProperty: 'title' } }],
      statusCode: 400,
    });

    await errorHandler(error as any, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(400);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          request_id: 'req-123',
        }),
      }),
    );
  });

  it('should handle errors with statusCode property', async () => {
    const { errorHandler } = await import('../src/middleware/error-handler.js');

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const mockRequest = {
      id: 'req-456',
      log: { error: vi.fn() },
    };

    const error = Object.assign(new Error('Not authenticated'), {
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });

    await errorHandler(error as any, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(401);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        }),
      }),
    );
  });

  it('should handle 500 errors without leaking details', async () => {
    const { errorHandler } = await import('../src/middleware/error-handler.js');

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const mockRequest = {
      id: 'req-789',
      log: { error: vi.fn() },
    };

    const error = new Error('Database connection failed') as any;
    error.statusCode = 500;

    await errorHandler(error, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(500);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred',
        }),
      }),
    );
  });
});

describe('Env validation', () => {
  it('should export env object', async () => {
    const { env } = await import('../src/env.js');
    expect(env).toBeDefined();
    expect(env.PORT).toBe(4000);
    expect(env.SESSION_TTL_SECONDS).toBe(604800);
  });
});
