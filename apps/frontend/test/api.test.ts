import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to test the actual ApiClient class, so we import it directly.
// The module creates a singleton `api`, and also exports ApiError.
// We mock `fetch` globally rather than the module itself.

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// We must also stub window.location.origin for URL construction
Object.defineProperty(window, 'location', {
  value: { origin: 'http://localhost:5173' },
  writable: true,
});

import { api, ApiError } from '@/lib/api';

describe('ApiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET requests', () => {
    it('returns parsed JSON on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: '1' }] }),
      });

      const result = await api.get<{ data: { id: string }[] }>('/projects');

      expect(result).toEqual({ data: [{ id: '1' }] });
    });

    it('sends GET method with credentials include', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await api.get('/projects');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'GET',
          credentials: 'include',
        }),
      );
    });

    it('omits Content-Type on bodyless requests', async () => {
      // Fastify rejects body-less requests that declare Content-Type:
      // application/json with "Body cannot be empty". The client only sets
      // Content-Type when it has a body to send (POST/PATCH with body arg).
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await api.get('/test');

      const callArgs = mockFetch.mock.calls[0]![1];
      const headers = (callArgs.headers ?? {}) as Record<string, string>;
      expect(headers['Content-Type']).toBeUndefined();
    });

    it('sets Content-Type on POST with a body', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
      await api.post('/test', { foo: 'bar' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
    });

    it('adds query string from params', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await api.get('/tasks', { status: 'active', limit: 10 });

      const calledUrl = mockFetch.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('status')).toBe('active');
      expect(url.searchParams.get('limit')).toBe('10');
    });

    it('omits null and undefined params from query string', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await api.get('/tasks', { status: 'active', sprint_id: null, assignee: undefined });

      const calledUrl = mockFetch.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('status')).toBe('active');
      expect(url.searchParams.has('sprint_id')).toBe(false);
      expect(url.searchParams.has('assignee')).toBe(false);
    });
  });

  describe('POST requests', () => {
    it('sends body as JSON with credentials include', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ data: { id: 'new-1' } }),
      });

      const body = { title: 'New Task', priority: 'high' };
      await api.post('/tasks', body);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify(body),
        }),
      );
    });

    it('returns parsed response JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ data: { id: 'task-42' } }),
      });

      const result = await api.post<{ data: { id: string } }>('/tasks', { title: 'Test' });

      expect(result.data.id).toBe('task-42');
    });
  });

  describe('error handling', () => {
    it('throws ApiError on 401 response (no redirect)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }),
      });

      try {
        await api.get('/protected');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as InstanceType<typeof ApiError>;
        expect(apiErr.status).toBe(401);
        expect(apiErr.message).toBe('Not authenticated');
      }
    });

    it('throws ApiError with code from error envelope on 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          error: { code: 'NOT_FOUND', message: 'Resource not found', request_id: 'req-123' },
        }),
      });

      try {
        await api.get('/projects/nonexistent');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as InstanceType<typeof ApiError>;
        expect(apiErr.status).toBe(404);
        expect(apiErr.code).toBe('NOT_FOUND');
        expect(apiErr.message).toBe('Resource not found');
        expect(apiErr.requestId).toBe('req-123');
      }
    });

    it('uses fallback code and message when response has no error envelope', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      try {
        await api.get('/broken');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as InstanceType<typeof ApiError>;
        expect(apiErr.status).toBe(500);
        expect(apiErr.code).toBe('UNKNOWN');
        expect(apiErr.message).toContain('500');
      }
    });
  });

  describe('204 No Content', () => {
    it('returns undefined for 204 response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => {
          throw new Error('No body');
        },
      });

      const result = await api.delete('/tasks/task-1');

      expect(result).toBeUndefined();
    });
  });

  describe('getQuiet', () => {
    it('throws ApiError on 401 without redirect (skipAuthRedirect)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }),
      });

      // getQuiet uses skipAuthRedirect: true so it still throws but with the
      // error envelope content rather than the hardcoded "Session expired" message.
      // In the actual code, skipAuthRedirect skips the early 401 throw, so it
      // falls through to the generic !response.ok handler.
      try {
        await api.getQuiet('/auth/me');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as InstanceType<typeof ApiError>;
        expect(apiErr.status).toBe(401);
        expect(apiErr.code).toBe('UNAUTHORIZED');
        expect(apiErr.message).toBe('Not authenticated');
      }
    });
  });
});
