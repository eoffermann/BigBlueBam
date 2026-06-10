/**
 * BureauWsClient — connection manager for /bureau/ws.
 *
 * Responsibilities:
 *   - connect()/disconnect() over a single WebSocket.
 *   - Auto-reconnect with exponential backoff (1s → 30s cap) on close.
 *   - Heartbeat every 15s once the server `connected` frame arrives.
 *   - Typed event subscription via on()/off() per §8 protocol.
 *   - Queue outbound frames sent before the socket is OPEN; flush on open.
 *
 * The class is environment-agnostic: it does not touch React. It owns no
 * React state; useBureauPresence() and the docked-box surface that state
 * by subscribing through on().
 */

import type {
  BureauConnectionStatus,
  ClientMessage,
  ConnectedEvent,
  ServerMessage,
  ServerMessageMap,
  ServerMessageType,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

/**
 * Resolve the default /bureau/ws URL from `window.location`. SSR hosts must
 * pass a literal URL into the constructor — this helper throws if `window`
 * is undefined.
 */
function defaultWsUrl(): string {
  if (typeof window === 'undefined') {
    throw new Error(
      '[bureau-client] No window.location available; pass `url` to BureauWsClient',
    );
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/bureau/ws`;
}

// ─────────────────────────────────────────────────────────────────────────
// Generic typed event emitter scoped to the §8 server-frame catalog.
// ─────────────────────────────────────────────────────────────────────────

type Handler<T extends ServerMessageType> = (msg: ServerMessageMap[T]) => void;
type AnyHandler = (msg: ServerMessage) => void;
type StatusHandler = (status: BureauConnectionStatus) => void;

interface BureauWsOptions {
  /** Override the WS URL (defaults to ws(s)://<host>/bureau/ws). */
  url?: string;
  /** Heartbeat cadence; defaults to 15s per §7. */
  heartbeatIntervalMs?: number;
  /** Optional logger; defaults to console. */
  logger?: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export class BureauWsClient {
  private readonly url: string;
  private readonly heartbeatIntervalMs: number;
  private readonly logger: NonNullable<BureauWsOptions['logger']>;

  private ws: WebSocket | null = null;
  private status: BureauConnectionStatus = 'idle';
  private explicitlyClosed = false;
  private retries = 0;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Frames queued before the socket reaches OPEN. Flushed in order on open. */
  private outboundQueue: ClientMessage[] = [];

  /** Per-type handler buckets. */
  private handlers: Map<ServerMessageType, Set<AnyHandler>> = new Map();
  /** Catch-all handlers (subscribed to every server frame). */
  private wildcardHandlers: Set<AnyHandler> = new Set();
  /** Status-change subscribers. */
  private statusHandlers: Set<StatusHandler> = new Set();

  /** Resolved by the next `connected` frame after each connect() call. */
  private connectWaiters: Array<{
    resolve: (ev: ConnectedEvent) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(opts: BureauWsOptions = {}) {
    this.url = opts.url ?? defaultWsUrl();
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.logger = opts.logger ?? console;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Open the socket. Resolves on the server's `connected` frame.
   * Safe to call multiple times — the second call short-circuits if the
   * socket is already OPEN.
   */
  async connect(): Promise<ConnectedEvent> {
    this.explicitlyClosed = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Already connected; resolve with a synthetic ConnectedEvent if we have
      // no waiter chain. Callers shouldn't rely on this returning a fresh
      // server frame — they should rely on on('connected', …) instead.
      return Promise.resolve({
        type: 'connected',
        user_id: '',
        session_id: '',
      } as ConnectedEvent);
    }
    return new Promise<ConnectedEvent>((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
      this.openSocket();
    });
  }

  /** Close the socket and stop reconnecting. Idempotent. */
  disconnect(): void {
    this.explicitlyClosed = true;
    this.clearHeartbeat();
    this.clearReconnect();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        // ignore — already closing
      }
      this.ws = null;
    }
    // Any in-flight connect() promises should reject so callers don't hang.
    const waiters = this.connectWaiters.splice(0);
    for (const w of waiters) {
      w.reject(new Error('bureau-client disconnected before connect resolved'));
    }
    this.setStatus('disconnected');
  }

  /**
   * Send a client→server frame. If the socket is not yet OPEN the frame is
   * queued and flushed on `open`. Returns true if dispatched immediately.
   */
  send(message: ClientMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
        return true;
      } catch (err) {
        this.logger.warn('[bureau-client] send failed; requeuing', err);
        this.outboundQueue.push(message);
        return false;
      }
    }
    this.outboundQueue.push(message);
    return false;
  }

  /**
   * Subscribe to a specific server-frame type. Returns an unsubscribe fn.
   * Pass type='*' to receive every frame (lower-case star is the wildcard).
   */
  on<T extends ServerMessageType>(type: T, handler: Handler<T>): () => void;
  on(type: '*', handler: AnyHandler): () => void;
  on(type: ServerMessageType | '*', handler: AnyHandler): () => void {
    if (type === '*') {
      this.wildcardHandlers.add(handler);
      return () => {
        this.wildcardHandlers.delete(handler);
      };
    }
    let bucket = this.handlers.get(type);
    if (!bucket) {
      bucket = new Set<AnyHandler>();
      this.handlers.set(type, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket?.delete(handler);
    };
  }

  /** Unsubscribe a handler. Mirror of on(). */
  off<T extends ServerMessageType>(type: T, handler: Handler<T>): void;
  off(type: '*', handler: AnyHandler): void;
  off(type: ServerMessageType | '*', handler: AnyHandler): void {
    if (type === '*') {
      this.wildcardHandlers.delete(handler);
      return;
    }
    this.handlers.get(type)?.delete(handler);
  }

  /** Subscribe to connection-status transitions. Returns unsubscribe fn. */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    // Push current value immediately so subscribers can paint right away.
    try {
      handler(this.status);
    } catch (err) {
      this.logger.warn('[bureau-client] status handler threw', err);
    }
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /** Current connection status. */
  getStatus(): BureauConnectionStatus {
    return this.status;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private openSocket(): void {
    this.setStatus(this.retries === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.logger.error('[bureau-client] WebSocket constructor threw', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retries = 0;
      // Flush any frames queued before OPEN.
      const queued = this.outboundQueue.splice(0);
      for (const m of queued) {
        try {
          ws.send(JSON.stringify(m));
        } catch (err) {
          this.logger.warn('[bureau-client] failed to flush queued frame', err);
          // Re-queue this one and stop the flush; the next reconnect will retry.
          this.outboundQueue.unshift(m);
          break;
        }
      }
      // Heartbeat begins immediately; the server is lenient about pre-`connected` beats.
      this.startHeartbeat();
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      this.handleRawMessage(event.data);
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      this.clearHeartbeat();
      this.ws = null;
      if (this.explicitlyClosed) {
        this.setStatus('disconnected');
        return;
      }
      // 4401 is the server's auth-failure code. Reconnecting won't help on
      // that path, but the host app is the only one with credentials, so
      // we surface the close to wildcard subscribers and stop retrying.
      if (event.code === 4401) {
        this.logger.warn('[bureau-client] auth failed; not reconnecting');
        const waiters = this.connectWaiters.splice(0);
        for (const w of waiters) {
          w.reject(new Error('bureau-client: authentication failed (4401)'));
        }
        this.setStatus('disconnected');
        return;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener('error', (err: Event) => {
      // 'error' is always followed by 'close' from the browser WS impl;
      // we log but defer reconnect to the close handler.
      this.logger.warn('[bureau-client] socket error', err);
    });
  }

  private handleRawMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let parsed: { type?: unknown; data?: unknown; [k: string]: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('[bureau-client] bad frame from server', err);
      return;
    }
    if (!parsed || typeof parsed.type !== 'string') return;

    // The server emits frames as { type, data: {...}, timestamp } where the
    // payload sits under `data`. We normalize to a flat object so handlers
    // can read fields off the top level without thinking about it.
    const flat: Record<string, unknown> = { type: parsed.type };
    if (parsed.data && typeof parsed.data === 'object') {
      Object.assign(flat, parsed.data as Record<string, unknown>);
    }
    // Copy non-`data` siblings too in case of future flat-shape frames.
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'type' || k === 'data') continue;
      if (!(k in flat)) flat[k] = v;
    }

    const msg = flat as unknown as ServerMessage;

    // Resolve waiters on the first `connected` we see after each connect().
    if (msg.type === 'connected') {
      this.setStatus('connected');
      const waiters = this.connectWaiters.splice(0);
      for (const w of waiters) w.resolve(msg);
    }

    // Per-type handlers.
    const bucket = this.handlers.get(msg.type);
    if (bucket && bucket.size > 0) {
      for (const h of Array.from(bucket)) {
        try {
          h(msg);
        } catch (err) {
          this.logger.warn(`[bureau-client] handler for ${msg.type} threw`, err);
        }
      }
    }
    // Wildcard handlers.
    if (this.wildcardHandlers.size > 0) {
      for (const h of Array.from(this.wildcardHandlers)) {
        try {
          h(msg);
        } catch (err) {
          this.logger.warn('[bureau-client] wildcard handler threw', err);
        }
      }
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'heartbeat' }));
        } catch (err) {
          this.logger.warn('[bureau-client] heartbeat send failed', err);
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.retries, 6),
    );
    this.retries++;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(next: BureauConnectionStatus): void {
    if (next === this.status) return;
    this.status = next;
    for (const h of Array.from(this.statusHandlers)) {
      try {
        h(next);
      } catch (err) {
        this.logger.warn('[bureau-client] status handler threw', err);
      }
    }
  }
}
