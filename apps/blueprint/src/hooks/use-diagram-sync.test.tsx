// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDiagramSync } from './use-diagram-sync';

// Pins the live-sync contract: subscribe on open, debounce-coalesced
// graph invalidation on blueprint.* events, ping/ack frames ignored,
// resubscribe after a reconnect. Driven against a scripted fake
// WebSocket — no network.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // test drivers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function Host({ diagramId }: { diagramId: string }) {
  useDiagramSync(diagramId);
  return null;
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  queryClient = new QueryClient();
  invalidateSpy = vi.fn().mockResolvedValue(undefined);
  queryClient.invalidateQueries = invalidateSpy as unknown as QueryClient['invalidateQueries'];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(diagramId = 'd1') {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Host diagramId={diagramId} />
      </QueryClientProvider>,
    );
  });
}

describe('useDiagramSync', () => {
  it('connects to /blueprint/ws and subscribes to the diagram on open', () => {
    mount('d1');
    expect(FakeWebSocket.instances.length).toBe(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain('/blueprint/ws');
    act(() => ws.open());
    expect(ws.sent).toContainEqual(JSON.stringify({ type: 'subscribe', diagram_id: 'd1' }));
  });

  it('invalidates the graph query on blueprint.* events, debounced as one refetch', () => {
    mount('d1');
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    act(() => {
      // Burst: auto-layout style flood of move events.
      ws.receive({ type: 'blueprint.node.moved', diagram_id: 'd1', node_id: 'n1', position_x: 1, position_y: 2 });
      ws.receive({ type: 'blueprint.node.moved', diagram_id: 'd1', node_id: 'n2', position_x: 3, position_y: 4 });
      ws.receive({ type: 'blueprint.edge.created', diagram_id: 'd1', edge: {} });
    });
    expect(invalidateSpy).not.toHaveBeenCalled(); // still inside debounce
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['blueprint', 'diagrams', 'd1', 'graph'],
    });
  });

  it('ignores ping, ack, and error frames', () => {
    mount('d1');
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    act(() => {
      ws.receive({ type: 'ping' });
      ws.receive({ type: 'subscribed', diagram_id: 'd1' });
      ws.receive({ type: 'error', code: 'X' });
      vi.advanceTimersByTime(500);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('also refreshes diagram metadata on blueprint.diagram.updated', () => {
    mount('d1');
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    act(() => {
      ws.receive({ type: 'blueprint.diagram.updated', diagram_id: 'd1', changes: { title: 'New' } });
      vi.advanceTimersByTime(250);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['blueprint', 'diagrams', 'd1'],
      exact: true,
    });
  });

  it('reconnects with backoff and resubscribes after a drop', () => {
    mount('d1');
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.close()); // edge recycled the socket
    act(() => {
      vi.advanceTimersByTime(1100); // base backoff
    });
    expect(FakeWebSocket.instances.length).toBe(2);
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(second.sent).toContainEqual(JSON.stringify({ type: 'subscribe', diagram_id: 'd1' }));
  });

  it('closes the socket and stops reconnecting on unmount', () => {
    mount('d1');
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    act(() => root.unmount());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances.length).toBe(1); // no reconnect after unmount
  });
});
