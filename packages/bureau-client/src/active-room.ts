/**
 * ActiveCallManager — the unified LiveKit call lifecycle for bureau-client.
 *
 * The suite is moving to a single LiveKit endpoint per user: the docked box.
 * Whatever surface (Bureau spatial room or content-surface huddle) the user
 * is "in" right now, this manager owns its Room. Mic/cam/screen toggles in
 * the docked box flip tracks on this Room's localParticipant.
 *
 * Targets:
 *   - 'spatial' — a Bureau room the user explicitly entered via the floor
 *                 view; room name `bureau-room-{uuid}`. Token comes from
 *                 POST /bureau/api/v1/rooms/:id/token.
 *   - 'surface' — the canonical huddle room for the current URL surface;
 *                 room name `huddle-{app}-{surface_id}`. Token comes from
 *                 POST /bureau/api/v1/surface-huddle/token.
 *   - 'none'    — disconnected; no active call. Buttons disabled.
 *
 * ─────────────────────────────────────────────────────────────────────
 * v2 NAMING CONTRACT (Phase 3 — collapse huddle naming).
 *
 *   `huddle-{app}-{surface_id}` IS the canonical LiveKit room for that
 *   surface. There is no other room name in v1: ring/accept, direct
 *   navigation to the surface URL, and any future "join this huddle from
 *   the chip strip" affordance all funnel into the same room because they
 *   all derive the name the same way. The old per-app names
 *   (`brief-{docId}`, `board-{boardId}`) are deleted in Phase 2; their
 *   only successor is this naming scheme.
 *
 *   The room name derivation lives in two places that MUST agree:
 *     1. Here (`mintToken` ↦ `huddle-${target.surfaceApp}-${target.surfaceId}`).
 *     2. apps/bureau-api/src/routes/livekit.routes.ts ↦ `buildSurfaceHuddleRoomName`.
 *   If either changes, the other must change in the same commit, or a
 *   bureau-client SDK in the wild will try to join a room the API minted
 *   under a different name.
 * ─────────────────────────────────────────────────────────────────────
 *
 * The setTarget(target) call is the single switching point. It compares
 * against the current target, no-ops when equal, otherwise disconnects the
 * existing Room cleanly and mints + connects the new one. livekit-client
 * handles transient reconnects automatically; on a fatal close we drop
 * back to status='error' and the host can call setTarget(target) again
 * to retry.
 *
 * This module is intentionally non-React. The React hook
 * (use-active-call.ts) wraps subscribe() so component renders stay in
 * sync with the manager.
 */

import {
  Room,
  RoomEvent,
  type DisconnectReason,
} from 'livekit-client';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/**
 * What the manager is currently trying to be connected to. `roomName` is
 * the LiveKit room identifier; for spatial rooms it's `bureau-room-{id}`
 * and for surface rooms it's `huddle-{app}-{id}`. For `kind: 'none'` we
 * carry no room metadata and the manager stays disconnected.
 */
export interface ActiveRoomTarget {
  kind: 'spatial' | 'surface' | 'none';
  /** LiveKit room name. Null for kind:'none'. */
  roomName: string | null;
  /** Surface app — only meaningful for kind:'surface'. */
  surfaceApp?: string;
  /** Surface entity id — only meaningful for kind:'surface'. */
  surfaceId?: string;
  /** Bureau spatial room id — only meaningful for kind:'spatial'. */
  spatialRoomId?: string;
  /**
   * Optional human-readable label for surface targets ("Q3 Roadmap"); the
   * docked box surfaces this in its "In:" strip when present.
   */
  label?: string;
}

export type ActiveCallStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface ActiveCallTrackState {
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
}

export interface ActiveCallSnapshot {
  status: ActiveCallStatus;
  target: ActiveRoomTarget;
  tracks: ActiveCallTrackState;
  /** Last error surfaced via 'mediaDevicesError' or a connect failure. */
  errorMessage: string | null;
}

export type ActiveCallListener = (snapshot: ActiveCallSnapshot) => void;

interface MintedToken {
  token: string;
  room_name: string;
  ws_url: string;
}

interface ActiveCallManagerOptions {
  /** Override the bureau-api base path (default `/bureau/api/v1`). */
  apiBase?: string;
  /** Optional logger; defaults to console. */
  logger?: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const IDLE_TARGET: ActiveRoomTarget = { kind: 'none', roomName: null };

function targetsEqual(a: ActiveRoomTarget, b: ActiveRoomTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.roomName !== b.roomName) return false;
  // For 'none' the other fields don't matter.
  if (a.kind === 'none') return true;
  if (a.kind === 'spatial') return a.spatialRoomId === b.spatialRoomId;
  // 'surface'
  return a.surfaceApp === b.surfaceApp && a.surfaceId === b.surfaceId;
}

function parseTokenEnvelope(payload: unknown): MintedToken {
  // bureau-api wraps the body as `{ data: { token, room_name, ws_url } }`.
  // We also tolerate the legacy bare-body shape, in case a future tweak
  // collapses the envelope (or a test fixture is hand-rolled).
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const inner = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<
      string,
      unknown
    >;
    const token = typeof inner.token === 'string' ? inner.token : null;
    const roomName = typeof inner.room_name === 'string' ? inner.room_name : null;
    const wsUrl = typeof inner.ws_url === 'string' ? inner.ws_url : null;
    if (token && roomName && wsUrl) {
      return { token, room_name: roomName, ws_url: wsUrl };
    }
  }
  throw new Error('Malformed token response from bureau-api');
}

// ─────────────────────────────────────────────────────────────────────────
// ActiveCallManager
// ─────────────────────────────────────────────────────────────────────────

export class ActiveCallManager {
  private readonly apiBase: string;
  private readonly logger: NonNullable<ActiveCallManagerOptions['logger']>;

  private target: ActiveRoomTarget = IDLE_TARGET;
  private room: Room | null = null;
  private status: ActiveCallStatus = 'idle';
  private tracks: ActiveCallTrackState = {
    micOn: false,
    camOn: false,
    screenOn: false,
  };
  private errorMessage: string | null = null;

  /** Monotonically incrementing connect token — guards against late callbacks. */
  private connectGeneration = 0;

  private listeners: Set<ActiveCallListener> = new Set();

  /** Cleanup of listeners on the active Room, paired with the Room instance. */
  private cleanupRoomListeners: (() => void) | null = null;

  /** True once dispose() has been called; further mutations are no-ops. */
  private disposed = false;

  constructor(opts: ActiveCallManagerOptions = {}) {
    this.apiBase = opts.apiBase ?? '/bureau/api/v1';
    this.logger = opts.logger ?? console;
  }

  // ── Public API ──

  getStatus(): ActiveCallStatus {
    return this.status;
  }

  getRoom(): Room | null {
    return this.room;
  }

  getTarget(): ActiveRoomTarget {
    return this.target;
  }

  getTrackState(): ActiveCallTrackState {
    return { ...this.tracks };
  }

  getSnapshot(): ActiveCallSnapshot {
    return {
      status: this.status,
      target: this.target,
      tracks: { ...this.tracks },
      errorMessage: this.errorMessage,
    };
  }

  /**
   * Switch the active LiveKit connection to a new target.
   *
   * No-op when the new target equals the current AND we are not in an error
   * state. Passing `{ kind: 'none' }` cleanly disconnects.
   *
   * If a connect is in flight when this is called, the older attempt is
   * superseded — its callbacks bail out by comparing connectGeneration.
   */
  async setTarget(target: ActiveRoomTarget): Promise<void> {
    if (this.disposed) return;

    // No-op when the target is identical AND we're not stuck in 'error'.
    // In 'error' state we want a re-setTarget() to retry the connect even
    // when the target is the same.
    if (targetsEqual(target, this.target) && this.status !== 'error') {
      return;
    }

    const generation = ++this.connectGeneration;
    this.target = target;
    this.errorMessage = null;

    // Tear down whatever Room we have first.
    await this.disconnectCurrentRoom();
    if (generation !== this.connectGeneration) return; // superseded

    if (target.kind === 'none' || !target.roomName) {
      this.setStatus('idle');
      return;
    }

    this.setStatus('connecting');

    let minted: MintedToken;
    try {
      minted = await this.mintToken(target);
    } catch (err) {
      if (generation !== this.connectGeneration) return;
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('[bureau-client] token mint failed', err);
      this.setStatus('error');
      return;
    }
    if (generation !== this.connectGeneration) return;

    const room = new Room({
      // Defaults are fine for the docked box: adaptive stream, dynacast,
      // automatic reconnect. The Brief/Board apps used to pass extra audio
      // tuning — once those callers are deleted in Phase 2 we can revisit.
    });
    this.attachRoomListeners(room, generation);

    try {
      await room.connect(minted.ws_url, minted.token);
    } catch (err) {
      if (generation !== this.connectGeneration) {
        // Superseded — quietly hang up.
        try {
          await room.disconnect();
        } catch {
          /* ignore */
        }
        return;
      }
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('[bureau-client] Room.connect failed', err);
      this.detachRoomListeners();
      this.room = null;
      this.setStatus('error');
      return;
    }

    if (generation !== this.connectGeneration) {
      // Superseded between connect() resolving and this point.
      try {
        await room.disconnect();
      } catch {
        /* ignore */
      }
      return;
    }

    this.room = room;
    this.syncTrackStateFromRoom();
    this.setStatus('connected');
  }

  /** Toggle the microphone publish state on the active Room. */
  async setMicEnabled(on: boolean): Promise<void> {
    await this.setLocalTrackEnabled('mic', on);
  }

  async setCamEnabled(on: boolean): Promise<void> {
    await this.setLocalTrackEnabled('cam', on);
  }

  async setScreenShareEnabled(on: boolean): Promise<void> {
    await this.setLocalTrackEnabled('screen', on);
  }

  /**
   * Subscribe to manager-state changes. Listener is invoked synchronously
   * with the current snapshot on subscribe, then on every transition.
   * Returns an unsubscribe function.
   */
  subscribe(listener: ActiveCallListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch (err) {
      this.logger.warn('[bureau-client] active-call listener threw', err);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tear the manager down completely. Used by the SDK on unmount. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.connectGeneration++;
    await this.disconnectCurrentRoom();
    this.listeners.clear();
  }

  // ── Internals ──

  private setStatus(next: ActiveCallStatus): void {
    if (this.status === next) {
      // Still emit if track state has changed; cheaper to always emit on
      // setStatus calls and let listeners memoize.
      this.emit();
      return;
    }
    this.status = next;
    this.emit();
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (err) {
        this.logger.warn('[bureau-client] active-call listener threw', err);
      }
    }
  }

  private async setLocalTrackEnabled(
    kind: 'mic' | 'cam' | 'screen',
    on: boolean,
  ): Promise<void> {
    const room = this.room;
    if (!room || this.status !== 'connected') {
      // Nothing to do; the UI surfaces 'no active call' separately.
      return;
    }
    const local = room.localParticipant;
    try {
      if (kind === 'mic') {
        await local.setMicrophoneEnabled(on);
      } else if (kind === 'cam') {
        await local.setCameraEnabled(on);
      } else {
        await local.setScreenShareEnabled(on);
      }
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[bureau-client] failed to toggle ${kind}`, err);
      // Toggling fails closed: re-read whatever the SDK actually has.
      this.syncTrackStateFromRoom();
      this.emit();
      return;
    }
    this.syncTrackStateFromRoom();
    this.emit();
  }

  private syncTrackStateFromRoom(): void {
    const room = this.room;
    if (!room) {
      this.tracks = { micOn: false, camOn: false, screenOn: false };
      return;
    }
    const local = room.localParticipant;
    this.tracks = {
      micOn: !!local.isMicrophoneEnabled,
      camOn: !!local.isCameraEnabled,
      screenOn: !!local.isScreenShareEnabled,
    };
  }

  private attachRoomListeners(room: Room, generation: number): void {
    const onTrackChange = () => {
      if (generation !== this.connectGeneration) return;
      this.syncTrackStateFromRoom();
      this.emit();
    };

    const onMediaDevicesError = (err: Error) => {
      if (generation !== this.connectGeneration) return;
      this.errorMessage = err?.message ?? 'Media device error';
      this.logger.warn('[bureau-client] mediaDevicesError', err);
      this.setStatus('error');
    };

    const onDisconnected = (reason?: DisconnectReason) => {
      if (generation !== this.connectGeneration) return;
      // livekit-client emits 'disconnected' both for user-initiated tear-down
      // (where we already set status above) and for fatal closes after its
      // own auto-reconnect has given up. Treat any unexpected disconnect as
      // an error state so the host can re-setTarget() to retry.
      this.detachRoomListeners();
      this.room = null;
      this.tracks = { micOn: false, camOn: false, screenOn: false };
      if (this.status === 'idle') {
        // User-initiated; we already cleaned up in disconnectCurrentRoom.
        return;
      }
      this.errorMessage = reason !== undefined ? `disconnected (${reason})` : 'disconnected';
      this.setStatus('error');
    };

    room.on(RoomEvent.TrackMuted, onTrackChange);
    room.on(RoomEvent.TrackUnmuted, onTrackChange);
    room.on(RoomEvent.LocalTrackPublished, onTrackChange);
    room.on(RoomEvent.LocalTrackUnpublished, onTrackChange);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.Disconnected, onDisconnected);

    this.cleanupRoomListeners = () => {
      room.off(RoomEvent.TrackMuted, onTrackChange);
      room.off(RoomEvent.TrackUnmuted, onTrackChange);
      room.off(RoomEvent.LocalTrackPublished, onTrackChange);
      room.off(RoomEvent.LocalTrackUnpublished, onTrackChange);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }

  private detachRoomListeners(): void {
    try {
      this.cleanupRoomListeners?.();
    } catch {
      /* ignore */
    }
    this.cleanupRoomListeners = null;
  }

  private async disconnectCurrentRoom(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.detachRoomListeners();
    this.room = null;
    this.tracks = { micOn: false, camOn: false, screenOn: false };
    try {
      await room.disconnect();
    } catch (err) {
      this.logger.warn('[bureau-client] Room.disconnect threw', err);
    }
  }

  /**
   * Mint a LiveKit access token from bureau-api for the given target.
   * Throws on non-2xx responses or malformed payloads. The caller decides
   * how to surface failure (we just flip status to 'error').
   */
  private async mintToken(target: ActiveRoomTarget): Promise<MintedToken> {
    if (target.kind === 'spatial') {
      if (!target.spatialRoomId) {
        throw new Error('spatial target missing spatialRoomId');
      }
      const url = `${this.apiBase}/rooms/${encodeURIComponent(target.spatialRoomId)}/token`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`rooms/:id/token returned ${res.status}`);
      }
      const body = (await res.json()) as unknown;
      return parseTokenEnvelope(body);
    }
    if (target.kind === 'surface') {
      if (!target.surfaceApp || !target.surfaceId) {
        throw new Error('surface target missing surfaceApp/surfaceId');
      }
      const url = `${this.apiBase}/surface-huddle/token`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surface_app: target.surfaceApp,
          surface_id: target.surfaceId,
        }),
      });
      if (!res.ok) {
        throw new Error(`surface-huddle/token returned ${res.status}`);
      }
      const body = (await res.json()) as unknown;
      return parseTokenEnvelope(body);
    }
    throw new Error(`Cannot mint token for target kind=${target.kind}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Singleton accessor — the SDK initializes one ActiveCallManager per mount.
// useActiveCall() reads from it through subscribe().
// ─────────────────────────────────────────────────────────────────────────

let activeManager: ActiveCallManager | null = null;

export function getActiveCallManager(): ActiveCallManager | null {
  return activeManager;
}

export function setActiveCallManager(manager: ActiveCallManager | null): void {
  activeManager = manager;
}

export { IDLE_TARGET };
