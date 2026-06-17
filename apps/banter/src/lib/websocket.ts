/**
 * WebSocket manager for Banter realtime events.
 *
 * Connects to the Banter API's /ws endpoint. The browser automatically
 * sends the httpOnly session cookie on the upgrade request.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Room subscription management (channel rooms)
 * - Event dispatching to registered handlers
 */

export interface RealtimeEvent {
  type: string;
  payload: unknown;
  room?: string;
  timestamp: string;
  triggeredBy?: string;
}

type EventHandler = (event: RealtimeEvent) => void;

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const RECONNECT_MULTIPLIER = 2;

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private globalHandlers = new Set<EventHandler>();
  private subscribedRooms = new Set<string>();
  private pendingRooms = new Set<string>();
  private reconnectDelay = MIN_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private connected = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Open the WebSocket connection.
   */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionalClose = false;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/banter/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = MIN_RECONNECT_DELAY;

      // Re-subscribe to all rooms we should be in
      for (const room of this.subscribedRooms) {
        this.sendSubscribe(room);
      }
      // Subscribe to any rooms queued while disconnected
      for (const room of this.pendingRooms) {
        this.subscribedRooms.add(room);
        this.sendSubscribe(room);
      }
      this.pendingRooms.clear();

      // Start ping interval to keep connection alive
      this.pingInterval = setInterval(() => {
        this.send({ type: 'ping' });
      }, 30000);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as RealtimeEvent & { type: string };

        // Internal protocol messages
        if (data.type === 'connected' || data.type === 'subscribed' || data.type === 'unsubscribed' || data.type === 'pong') {
          return;
        }

        // The banter-api relays events as { type, data, timestamp } (its
        // BanterEvent shape), but every handler reads `event.payload`. Alias
        // data→payload so handlers receive the body regardless of the server's
        // key. (Without this, every handler's `event.payload` was undefined.)
        if ((data as { payload?: unknown }).payload === undefined) {
          (data as { payload?: unknown }).payload = (data as { data?: unknown }).data;
        }

        // Dispatch to type-specific handlers
        const typeHandlers = this.handlers.get(data.type);
        if (typeHandlers) {
          for (const handler of typeHandlers) {
            try {
              handler(data);
            } catch (err) {
              console.error('[banter-ws] Handler error:', err);
            }
          }
        }

        // Dispatch to global handlers
        for (const handler of this.globalHandlers) {
          try {
            handler(data);
          } catch (err) {
            console.error('[banter-ws] Global handler error:', err);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.clearPingInterval();

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // The close event will fire after this, which handles reconnection
    };
  }

  /**
   * Close the WebSocket connection intentionally (no reconnect).
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearPingInterval();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.connected = false;
    this.subscribedRooms.clear();
    this.pendingRooms.clear();
  }

  /**
   * Subscribe to a room (e.g., "channel:{id}").
   */
  joinRoom(room: string): void {
    if (this.subscribedRooms.has(room)) return;

    if (this.connected) {
      this.subscribedRooms.add(room);
      this.sendSubscribe(room);
    } else {
      this.pendingRooms.add(room);
    }
  }

  /**
   * Unsubscribe from a room.
   */
  leaveRoom(room: string): void {
    this.subscribedRooms.delete(room);
    this.pendingRooms.delete(room);

    if (this.connected) {
      this.send({ type: 'unsubscribe', room });
    }
  }

  /**
   * Send a message through the WebSocket.
   */
  sendMessage(msg: object): void {
    this.send(msg);
  }

  /**
   * Register a handler for a specific event type (e.g., "message.created").
   * Returns an unsubscribe function.
   */
  on(eventType: string, handler: EventHandler): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);

    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.handlers.delete(eventType);
      }
    };
  }

  /**
   * Register a handler for ALL events.
   * Returns an unsubscribe function.
   */
  onAny(handler: EventHandler): () => void {
    this.globalHandlers.add(handler);
    return () => {
      this.globalHandlers.delete(handler);
    };
  }

  // ── Internal ─────────────────────────────────────────────

  private send(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendSubscribe(room: string): void {
    this.send({ type: 'subscribe', room });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_MULTIPLIER,
      MAX_RECONNECT_DELAY,
    );
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

/** Singleton WebSocket manager for Banter. */
export const ws = new WebSocketManager();
