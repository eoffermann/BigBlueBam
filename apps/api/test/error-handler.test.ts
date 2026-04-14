import { describe, it, expect, vi } from 'vitest';
import { ZodError, ZodIssueCode } from 'zod';
import { errorHandler } from '../src/middleware/error-handler.js';

function createMocks(requestId = 'req-test-123') {
  const mockReply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const mockRequest = {
    id: requestId,
    log: { error: vi.fn() },
  };
  return { mockReply, mockRequest };
}

describe('Error Handler', () => {
  it('handles ZodError with VALIDATION_ERROR code and field details', () => {
    const { mockReply, mockRequest } = createMocks();

    const zodError = new ZodError([
      {
        code: ZodIssueCode.too_small,
        minimum: 12,
        type: 'string',
        inclusive: true,
        exact: false,
        message: 'String must contain at least 12 character(s)',
        path: ['password'],
      },
      {
        code: ZodIssueCode.invalid_string,
        validation: 'email',
        message: 'Invalid email',
        path: ['email'],
      },
    ]);

    errorHandler(zodError as any, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(400);
    const sent = mockReply.send.mock.calls[0][0];
    expect(sent.error.code).toBe('VALIDATION_ERROR');
    expect(sent.error.message).toBe('Request validation failed');
    expect(sent.error.details).toHaveLength(2);
    expect(sent.error.details[0]).toEqual({
      path: 'password',
      message: 'String must contain at least 12 character(s)',
    });
    expect(sent.error.details[1]).toEqual({
      path: 'email',
      message: 'Invalid email',
    });
    expect(sent.error.request_id).toBe('req-test-123');
  });

  it('handles Fastify validation errors', () => {
    const { mockReply, mockRequest } = createMocks('req-fastify');

    const error = Object.assign(new Error('Validation'), {
      validation: [
        { instancePath: '/body/title', message: 'must be string' },
        { instancePath: '/body/priority', message: 'must be one of allowed values' },
      ],
      statusCode: 400,
    });

    errorHandler(error as any, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(400);
    const sent = mockReply.send.mock.calls[0][0];
    expect(sent.error.code).toBe('VALIDATION_ERROR');
    expect(sent.error.details).toHaveLength(2);
    expect(sent.error.details[0]).toEqual({
      path: '/body/title',
      message: 'must be string',
    });
    expect(sent.error.request_id).toBe('req-fastify');
  });

  it('handles rate limit (429) errors', () => {
    const { mockReply, mockRequest } = createMocks('req-rate');

    const error = Object.assign(new Error('Rate limit'), {
      statusCode: 429,
    });

    errorHandler(error as any, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(429);
    const sent = mockReply.send.mock.calls[0][0];
    expect(sent.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(sent.error.message).toBe('Too many requests, please try again later');
    expect(sent.error.request_id).toBe('req-rate');
  });

  it('handles known HTTP errors (4xx) preserving code and message', () => {
    const { mockReply, mockRequest } = createMocks('req-4xx');

    const error = Object.assign(new Error('Not authorized'), {
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    errorHandler(error as any, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(403);
    const sent = mockReply.send.mock.calls[0][0];
    expect(sent.error.code).toBe('FORBIDDEN');
    expect(sent.error.message).toBe('Not authorized');
    expect(sent.error.request_id).toBe('req-4xx');
  });

  it('handles known HTTP errors without explicit code using CLIENT_ERROR fallback', () => {
    const { mockReply, mockRequest } = createMocks();

    const error = Object.assign(new Error('Bad request'), {
      statusCode: 400,
    });

    errorHandler(error as any, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(400);
    const sent = mockReply.send.mock.calls[0][0];
    expect(sent.error.code).toBe('CLIENT_ERROR');
  });

  it('handles unknown errors as 500 without leaking details', () => {
    const { mockReply, mockRequest } = createMocks('req-500');

    const error = new Error('Sensitive database connection string leaked') as any;
    // No statusCode set, so it falls through to the 500 handler

    errorHandler(error as any, mockRequest as any, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(500);
    const sent = mockReply.send.mock.calls[0][0];
    expect(sent.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(sent.error.message).toBe('An unexpected error occurred');
    // Must NOT contain the original error message
    expect(sent.error.message).not.toContain('database');
    expect(sent.error.request_id).toBe('req-500');
  });

  it('mints internal_error_id on 500 envelope and logs it with the cause', () => {
    const { mockReply, mockRequest } = createMocks('req-internal-id');

    const error = new Error('cause never leaks') as any;
    errorHandler(error as any, mockRequest as any, mockReply as any);

    const sent = mockReply.send.mock.calls[0][0];
    expect(sent.error.internal_error_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // The structured log call should carry the same id alongside the
    // original error so an operator can grep for it.
    expect(mockRequest.log.error).toHaveBeenCalledTimes(1);
    const logCall = (mockRequest.log.error as ReturnType<typeof vi.fn>).mock.calls[0];
    const logFields = logCall[0];
    expect(logFields.internal_error_id).toBe(sent.error.internal_error_id);
    expect(logFields.request_id).toBe('req-internal-id');
    expect(logFields.err).toBe(error);
  });

  it('mints a fresh internal_error_id on every 500', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
      const request = { id: 'r' + i, log: { error: vi.fn() } };
      errorHandler(new Error('boom') as any, request as any, reply as any);
      const sent = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      ids.add(sent.error.internal_error_id);
    }
    expect(ids.size).toBe(5);
  });

  it('always includes request_id in response', () => {
    const requestId = 'unique-req-id-abc';
    const { mockReply, mockRequest } = createMocks(requestId);

    // Test with several error types
    const errors = [
      Object.assign(new Error('err'), { statusCode: 400 }),
      Object.assign(new Error('err'), { statusCode: 429 }),
      new Error('server error') as any,
    ];

    for (const error of errors) {
      vi.clearAllMocks();
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
      const request = { id: requestId, log: { error: vi.fn() } };

      errorHandler(error as any, request as any, reply as any);

      const sent = reply.send.mock.calls[0][0];
      expect(sent.error.request_id).toBe(requestId);
    }
  });
});
