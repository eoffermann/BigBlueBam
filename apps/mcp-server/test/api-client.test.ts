import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { ApiClient } from '../src/middleware/api-client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const logger = pino({ level: 'silent' });

describe('ApiClient', () => {
  let client: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient('http://api.example.com', 'my-secret-key', logger);
  });

  describe('constructor', () => {
    it('stores baseUrl with trailing slash removed', () => {
      const c = new ApiClient('http://api.example.com/', 'key', logger);
      expect(c.getBaseUrl()).toBe('http://api.example.com');
    });

    it('stores baseUrl as-is when no trailing slash', () => {
      expect(client.getBaseUrl()).toBe('http://api.example.com');
    });
  });

  describe('GET requests', () => {
    it('includes Authorization Bearer header with apiKey', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

      await client.get('/projects');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://api.example.com/projects',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer my-secret-key',
          }),
        }),
      );
    });

    it('does not include body in GET requests', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await client.get('/tasks');

      const callArgs = mockFetch.mock.calls[0]![1];
      expect(callArgs.body).toBeUndefined();
    });
  });

  describe('POST requests', () => {
    it('sends JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ data: { id: '1' } }),
      });

      const body = { name: 'New Project', task_id_prefix: 'NP' };
      await client.post('/projects', body);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://api.example.com/projects',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(body),
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer my-secret-key',
          }),
        }),
      );
    });
  });

  describe('response handling', () => {
    it('returns ok: true with data on successful response', async () => {
      const responseData = { id: 'proj-1', name: 'Test' };
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => responseData,
      });

      const result = await client.get('/projects/proj-1');

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.data).toEqual(responseData);
    });

    it('returns ok: false with error data on error response', async () => {
      const errorData = { error: { code: 'NOT_FOUND', message: 'Not found' } };
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => errorData,
      });

      const result = await client.get('/projects/nonexistent');

      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
      expect(result.data).toEqual(errorData);
    });

    it('returns ok: false with error message on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.get('/projects');

      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
      expect(result.data).toEqual({ error: 'ECONNREFUSED' });
    });

    it('returns ok: false with generic message for non-Error throws', async () => {
      mockFetch.mockRejectedValue('some string error');

      const result = await client.get('/projects');

      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
      expect(result.data).toEqual({ error: 'Unknown error' });
    });
  });

  describe('PATCH requests', () => {
    it('sends PATCH method with body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { id: 'task-1' } }),
      });

      await client.patch('/tasks/task-1', { title: 'Updated Title' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://api.example.com/tasks/task-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ title: 'Updated Title' }),
        }),
      );
    });
  });

  describe('DELETE requests', () => {
    it('sends DELETE method without body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => ({}),
      });

      await client.delete('/tasks/task-1');

      const callArgs = mockFetch.mock.calls[0]![1];
      expect(callArgs.method).toBe('DELETE');
      expect(callArgs.body).toBeUndefined();
    });
  });
});
