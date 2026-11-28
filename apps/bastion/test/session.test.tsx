// #412: only a 401 from /auth/me signs a user out. A 429, a 5xx or a network error keeps the
// session and retries (honouring Retry-After) behind the shared Reconnecting notice. This file
// covers the shared module (@bigbluebam/ui/session) and a fetch-based SPA store end to end; the
// same store body is used by every sibling SPA (scripts/lib/spa-session-single-source.test.mjs).
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSessionReconnecting,
  loadSession,
  parseRetryAfter,
  retryDelayMs,
  type SessionAttempt,
} from '@bigbluebam/ui/session';
import { SessionReconnectingNotice } from '@bigbluebam/ui/session-reconnecting';
import { useAuthStore } from '@/stores/auth.store';

const ME = {
  data: {
    id: 'u1',
    email: 'skipper@gilligantravel.example',
    display_name: 'Skipper',
    avatar_url: null,
    org_id: 'o1',
    role: 'admin',
    is_superuser: false,
  },
};

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('parseRetryAfter / retryDelayMs', () => {
  it('reads delta-seconds and HTTP dates, ignores junk', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
  });

  it('prefers Retry-After (capped) and otherwise backs off exponentially with a ceiling', () => {
    expect(retryDelayMs(1, '5')).toBe(5000);
    expect(retryDelayMs(1, '99999')).toBe(5 * 60_000);
    const noJitter = { random: () => 1 };
    expect(retryDelayMs(1, null, noJitter)).toBe(1000);
    expect(retryDelayMs(2, null, noJitter)).toBe(2000);
    expect(retryDelayMs(3, null, noJitter)).toBe(4000);
    expect(retryDelayMs(20, null, noJitter)).toBe(30_000);
  });
});

describe('loadSession', () => {
  function scripted(results: SessionAttempt<string>[]) {
    const queue = [...results];
    return vi.fn(async () => queue.shift() ?? { kind: 'failed' as const, status: 500 });
  }

  it('returns signed_out on a 401 without retrying', async () => {
    const attempt = scripted([{ kind: 'failed', status: 401 }]);
    const sleep = vi.fn(async () => {});
    expect(await loadSession(attempt, { sleep })).toEqual({ kind: 'signed_out' });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries 429, 5xx, network errors and other statuses until a session arrives', async () => {
    const attempt = scripted([
      { kind: 'failed', status: 429, retryAfter: '7' },
      { kind: 'failed', status: 502 },
      { kind: 'failed', status: null },
      { kind: 'failed', status: 403 },
      { kind: 'ok', data: 'me' },
    ]);
    const waits: number[] = [];
    const seenReconnecting: boolean[] = [];
    const sleep = vi.fn(async (ms: number) => {
      waits.push(ms);
      seenReconnecting.push(isSessionReconnecting());
    });
    const result = await loadSession(attempt, { sleep, random: () => 1 });
    expect(result).toEqual({ kind: 'authenticated', data: 'me' });
    expect(waits).toEqual([7000, 2000, 4000, 8000]);
    expect(seenReconnecting).toEqual([true, true, true, true]);
    expect(isSessionReconnecting()).toBe(false);
  });

  it('a 401 after a rate limit still signs out, and clears Reconnecting', async () => {
    const attempt = scripted([
      { kind: 'failed', status: 429 },
      { kind: 'failed', status: 401 },
    ]);
    expect(await loadSession(attempt, { sleep: async () => {} })).toEqual({ kind: 'signed_out' });
    expect(isSessionReconnecting()).toBe(false);
  });
});

describe('Bastion auth store (fetch-based, shared by the sibling SPAs)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a 401 shows the signed-out state', async () => {
    fetchMock.mockResolvedValueOnce(response(401, { error: { code: 'UNAUTHORIZED' } }));
    await useAuthStore.getState().fetchMe();
    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false, isLoading: false });
    expect(fetchMock).toHaveBeenCalledWith('/b3/api/auth/me', expect.objectContaining({ credentials: 'include' }));
  });

  it('a 429 keeps a signed-in user signed in, shows Reconnecting, honours Retry-After and recovers', async () => {
    useAuthStore.setState({ user: { ...ME.data, avatar_url: null }, isAuthenticated: true, isLoading: false });
    fetchMock
      .mockResolvedValueOnce(response(429, { error: { code: 'RATE_LIMITED' } }, { 'Retry-After': '3' }))
      .mockResolvedValueOnce(response(200, ME));

    render(<SessionReconnectingNotice />);
    const pending = useAuthStore.getState().fetchMe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status')).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isLoading: false });
    expect(useAuthStore.getState().user?.display_name).toBe('Skipper');
  });

  it('a 5xx on first load keeps loading (never "Please log in") until the api answers', async () => {
    fetchMock
      .mockResolvedValueOnce(response(500))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response(200, ME));

    const pending = useAuthStore.getState().fetchMe();
    await vi.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: true });

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isLoading: false });
  });
});
