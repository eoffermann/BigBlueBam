import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { createErrorHandler, explicitUnavailableError } from './index.js';

class StorageNotConfiguredLike extends Error {
  readonly statusCode = 503;
  readonly code = 'STORAGE_NOT_CONFIGURED';
}

async function appThrowing(err: Error) {
  const recordError = vi.fn();
  const app = Fastify({ logger: false });
  app.setErrorHandler(createErrorHandler({ serviceName: 'test', recordError }));
  app.get('/x', async () => {
    throw err;
  });
  await app.ready();
  return { app, recordError };
}

describe('createErrorHandler 5xx (issue #176)', () => {
  it('answers a coded 503 (storage not configured) with 503 and its code, and still records it', async () => {
    const { app, recordError } = await appThrowing(new StorageNotConfiguredLike('File storage is not configured'));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: 'STORAGE_NOT_CONFIGURED', message: 'File storage is not configured' });
    expect(recordError).toHaveBeenCalledOnce();
    await app.close();
  });

  it('keeps an uncoded or plain 5xx an opaque 500 INTERNAL_ERROR', async () => {
    const { app } = await appThrowing(Object.assign(new Error('boom'), { statusCode: 503 }));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    await app.close();
  });

  it('explicitUnavailableError only accepts 502-504 with an UPPER_SNAKE code', () => {
    expect(explicitUnavailableError({ code: 'STORAGE_TIMEOUT', message: 'slow' }, 504)).toEqual({ code: 'STORAGE_TIMEOUT', message: 'slow' });
    expect(explicitUnavailableError({ code: 'STORAGE_TIMEOUT' }, 500)).toBeNull();
    expect(explicitUnavailableError({ code: 'ECONNREFUSED' }, 503)).toEqual({ code: 'ECONNREFUSED', message: 'Service unavailable' });
    expect(explicitUnavailableError({ code: 'econnrefused' }, 503)).toBeNull();
  });
});
