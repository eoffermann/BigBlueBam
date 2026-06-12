// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

// The reporter writes to window and document. Vitest's jsdom env
// provides both. We mock fetch on a per-test basis so we can assert
// the request shape the SuperUser tab will receive.

beforeEach(() => {
  document.cookie = 'csrf_token=test-csrf-value; path=/';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset the reporter's module state so each test gets a fresh init.
  vi.resetModules();
});

describe('SystemErrorReporter', () => {
  it('POSTs a payload to /b3/api/internal/system-errors/record-browser with CSRF', async () => {
    const mod = await import('./system-error-reporter.js');
    mod.initSystemErrorReporter({ service: 'b3', alsoLogToConsole: false });
    await mod.reportSystemError({
      message: 'Synthetic test',
      error_code: 'TEST_PROBE',
      payload: { hello: 'world' },
    });
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe('/b3/api/internal/system-errors/record-browser');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf-value');
    const body = JSON.parse(init.body as string);
    expect(body.service).toBe('b3');
    expect(body.message).toBe('Synthetic test');
    expect(body.error_code).toBe('TEST_PROBE');
    expect(body.payload).toEqual({ hello: 'world' });
    expect(body.route).toBe(window.location.pathname);
  });

  it('dedupes identical messages within the window so a tight loop does not flood', async () => {
    const mod = await import('./system-error-reporter.js');
    mod.initSystemErrorReporter({ service: 'b3', alsoLogToConsole: false });
    for (let i = 0; i < 5; i++) {
      await mod.reportSystemError({ message: 'dup', error_code: 'DUP' });
    }
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
  });

  it('sends different messages independently', async () => {
    const mod = await import('./system-error-reporter.js');
    mod.initSystemErrorReporter({ service: 'b3', alsoLogToConsole: false });
    await mod.reportSystemError({ message: 'one' });
    await mod.reportSystemError({ message: 'two' });
    await mod.reportSystemError({ message: 'three' });
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(3);
  });

  it('survives a fetch rejection without throwing back to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const mod = await import('./system-error-reporter.js');
    mod.initSystemErrorReporter({ service: 'b3', alsoLogToConsole: false });
    await expect(mod.reportSystemError({ message: 'will fail' })).resolves.toBeUndefined();
  });

  it('honours the apiBase override so tests / different mount paths work', async () => {
    const mod = await import('./system-error-reporter.js');
    mod.initSystemErrorReporter({ service: 'banter', apiBase: '/banter/api', alsoLogToConsole: false });
    await mod.reportSystemError({ message: 'override' });
    const [url] = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string];
    expect(url).toBe('/banter/api/internal/system-errors/record-browser');
  });

  it('clips overly long messages and stacks before sending', async () => {
    const mod = await import('./system-error-reporter.js');
    mod.initSystemErrorReporter({ service: 'b3', alsoLogToConsole: false });
    const huge = 'x'.repeat(10_000);
    await mod.reportSystemError({ message: huge, stack: huge });
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const body = JSON.parse((calls[0]?.[1] as RequestInit).body as string);
    expect(body.message.length).toBeLessThanOrEqual(4000);
    expect(body.stack.length).toBeLessThanOrEqual(16000);
  });

  it('reportSystemError without prior init falls back to console but does not throw', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('./system-error-reporter.js');
    await mod.reportSystemError({ message: 'no init' });
    expect(consoleErrSpy).toHaveBeenCalled();
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(0);
  });
});
