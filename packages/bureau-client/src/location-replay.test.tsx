// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BureauProvider } from './index.js';
import type { BureauWsClient } from './ws-client.js';

// Pins the presence-replay contract behind the 2026-06-12 Railway
// incident: every server `connected` frame is a FRESH presence session
// (reconnects get a new sessionId with an empty location), so the SDK
// must re-send location_update even though the route never changed.
// Without the replay, a recycled websocket (routine on Railway's edge,
// never seen on a LAN) left the new session location-less and every
// surface-huddle mint 403'd NOT_ON_SURFACE — while rings (server→client
// pushes) kept working, which was the confusing symptom split.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (msg: unknown) => void;

function fakeClient() {
  const handlers = new Map<string, Set<Handler>>();
  const send = vi.fn(() => true);
  const client = {
    send,
    onStatus: () => () => {},
    on: (type: string, cb: Handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(cb);
      return () => handlers.get(type)?.delete(cb);
    },
    fire: (type: string, msg: unknown) => {
      handlers.get(type)?.forEach((cb) => cb(msg));
    },
  };
  return client as unknown as BureauWsClient & { fire: (t: string, m: unknown) => void; send: typeof send };
}

const locationUpdates = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls
    .map((c) => c[0] as { type: string; url?: string; surfaceId?: string })
    .filter((m) => m.type === 'location_update');

describe('location replay on reconnect', () => {
  it('re-sends location_update on every connected frame, same route', async () => {
    const client = fakeClient();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <BureauProvider
          client={client}
          navigate={() => {}}
          route="/b3/projects/abc"
          describeLocation={() => ({
            url: 'https://x.test/b3/projects/abc',
            app: 'b3',
            label: 'Project ABC',
          })}
        />,
      );
    });

    // Initial mount pushes the location once, with the derived URL
    // surface id on the wire (the slug-routed-mint fix field).
    let updates = locationUpdates(client.send);
    expect(updates.length).toBe(1);
    expect(updates[0]!.url).toBe('https://x.test/b3/projects/abc');
    expect(updates[0]!.surfaceId).toMatch(/^u[0-9a-f]{16}$/);

    // First server hello (normal connect).
    await act(async () => {
      client.fire('connected', { type: 'connected', user_id: 'u1', session_id: 's1' });
    });
    updates = locationUpdates(client.send);
    expect(updates.length).toBe(2);

    // Reconnect: Railway's edge recycled the socket; the server minted a
    // brand-new presence session. The route did NOT change — the replay
    // must still announce the location to the fresh session.
    await act(async () => {
      client.fire('connected', { type: 'connected', user_id: 'u1', session_id: 's2' });
    });
    updates = locationUpdates(client.send);
    expect(updates.length).toBe(3);
    expect(updates[2]!.url).toBe('https://x.test/b3/projects/abc');
    expect(updates[2]!.surfaceId).toBe(updates[0]!.surfaceId);

    await act(async () => {
      root.unmount();
    });
  });
});
