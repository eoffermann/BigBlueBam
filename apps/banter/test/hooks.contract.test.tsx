/**
 * Client-contract tests: assert each message hook (and the Bookmarks page)
 * fires the EXACT method + URL + body the banter-api route expects.
 *
 * These exist because the component tests mock the hooks, so they can't catch
 * a hook calling a URL that doesn't exist — which is exactly how edit/delete
 * (`/channels/:id/messages/:id` instead of `/messages/:id`) and the Bookmarks
 * page (`/me/bookmarks` instead of `/bookmarks`) shipped silently broken. Here
 * we stub global `fetch` and assert the resolved request, so a wrong URL fails
 * immediately. The api client baseURL is `/banter/api/v1`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useEditMessage,
  useDeleteMessage,
  usePinMessage,
  useUnpinMessage,
  useBookmark,
  useRemoveBookmarkByMessage,
} from '../src/hooks/use-messages';
import { BookmarksPage } from '../src/pages/bookmarks';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

/** Last fetch call, decoded to { url, method, body }. */
function lastRequest() {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  const [url, init] = call as [unknown, { method?: string; body?: string } | undefined];
  return {
    url: String(url),
    method: init?.method,
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}

describe('message mutation hooks → banter-api routes', () => {
  it('useEditMessage → PATCH /banter/api/v1/messages/:id (NOT channel-scoped)', async () => {
    const { result } = renderHook(() => useEditMessage(), { wrapper: makeWrapper() });
    result.current.mutate({ channelId: 'c1', messageId: 'm1', content: 'hi' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const req = lastRequest();
    expect(req.method).toBe('PATCH');
    expect(req.url).toContain('/banter/api/v1/messages/m1');
    expect(req.url).not.toContain('/channels/'); // the regression we shipped
    expect(req.body).toEqual({ content: 'hi' });
  });

  it('useDeleteMessage → DELETE /banter/api/v1/messages/:id (NOT channel-scoped)', async () => {
    const { result } = renderHook(() => useDeleteMessage(), { wrapper: makeWrapper() });
    result.current.mutate({ channelId: 'c1', messageId: 'm1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const req = lastRequest();
    expect(req.method).toBe('DELETE');
    expect(req.url).toContain('/banter/api/v1/messages/m1');
    expect(req.url).not.toContain('/channels/');
  });

  it('usePinMessage → POST /banter/api/v1/channels/:id/pins { message_id }', async () => {
    const { result } = renderHook(() => usePinMessage(), { wrapper: makeWrapper() });
    result.current.mutate({ channelId: 'c1', messageId: 'm1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/banter/api/v1/channels/c1/pins');
    expect(req.body).toEqual({ message_id: 'm1' });
  });

  it('useUnpinMessage → DELETE /banter/api/v1/channels/:id/pins/:messageId', async () => {
    const { result } = renderHook(() => useUnpinMessage(), { wrapper: makeWrapper() });
    result.current.mutate({ channelId: 'c1', messageId: 'm1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const req = lastRequest();
    expect(req.method).toBe('DELETE');
    expect(req.url).toContain('/banter/api/v1/channels/c1/pins/m1');
  });

  it('useBookmark → POST /banter/api/v1/bookmarks { message_id }', async () => {
    const { result } = renderHook(() => useBookmark(), { wrapper: makeWrapper() });
    result.current.mutate({ messageId: 'm1', channelId: 'c1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/banter/api/v1/bookmarks');
    expect(req.url).not.toContain('/me/bookmarks');
    expect(req.body).toMatchObject({ message_id: 'm1' });
  });

  it('useRemoveBookmarkByMessage → DELETE /banter/api/v1/bookmarks/by-message/:id', async () => {
    const { result } = renderHook(() => useRemoveBookmarkByMessage(), { wrapper: makeWrapper() });
    result.current.mutate({ messageId: 'm1', channelId: 'c1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const req = lastRequest();
    expect(req.method).toBe('DELETE');
    expect(req.url).toContain('/banter/api/v1/bookmarks/by-message/m1');
  });
});

describe('Bookmarks page → banter-api routes', () => {
  it('lists via GET /banter/api/v1/bookmarks (NOT /me/bookmarks)', async () => {
    render(<BookmarksPage onNavigate={vi.fn()} />, { wrapper: makeWrapper() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const getCall = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('/bookmarks'));
    expect(getCall).toBeDefined();
    expect(getCall).toContain('/banter/api/v1/bookmarks');
    expect(getCall).not.toContain('/me/bookmarks');
  });
});
