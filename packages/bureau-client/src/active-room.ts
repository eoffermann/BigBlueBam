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
  Track,
  type DisconnectReason,
  type Participant,
  type TrackPublication,
  type VideoTrack,
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

/**
 * A single video tile to render. Surfaces both local self-preview and
 * every subscribed remote video track. `source` lets the UI prioritize
 * screen-share content over face cams in its layout.
 *
 * The `track` itself is mutable LiveKit state; the React component that
 * holds the tile attaches via `track.attach(videoEl)` on mount and
 * detaches on unmount. We expose only the stable identity fields in this
 * snapshot so React's render diff stays cheap; track identity is the
 * (participantId, source, sid) tuple.
 */
export interface VideoTile {
  /** LiveKit publication.trackSid — stable across the lifetime of the track. */
  sid: string;
  /** LiveKit participant identity (== users.id). */
  participantId: string;
  /** Display name from participant metadata when available, else identity. */
  participantName: string;
  /** 'camera' (face cam) or 'screen' (screen-share). */
  source: 'camera' | 'screen';
  /** True for the local participant — render as self-preview, mirrored. */
  isLocal: boolean;
  /** True when the publisher has muted this track. UI dims the tile. */
  isMuted: boolean;
  /** The actual track to attach. Null when the publication exists but the
   *  remote subscription hasn't materialized a track yet. */
  track: VideoTrack | null;
}

export interface ActiveCallSnapshot {
  status: ActiveCallStatus;
  target: ActiveRoomTarget;
  tracks: ActiveCallTrackState;
  /** Last error surfaced via 'mediaDevicesError' or a connect failure. */
  errorMessage: string | null;
  /** Every renderable video track in the room. Empty when no video is
   *  published or while connecting/idle. Ordered with screen-share first
   *  so the tiles UI can pin "documents over faces" without re-sorting. */
  videoTiles: VideoTile[];
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

/**
 * Best-effort participant display name. bureau-api's token mint encodes
 * `display_name` in the participant's metadata; LiveKit also supports a
 * `name` field on the participant itself. Fall back to `identity` (now
 * `<userId>__<rand>`; we strip the suffix to keep the tile clean) so
 * the tile is never unlabeled.
 */
function deriveParticipantName(participant: Participant): string {
  if (participant.name) return participant.name;
  if (participant.metadata) {
    try {
      const meta = JSON.parse(participant.metadata) as { display_name?: unknown };
      if (typeof meta.display_name === 'string' && meta.display_name) return meta.display_name;
    } catch {
      /* metadata can be anything — only trust JSON we can parse */
    }
  }
  // Bureau identities are `<userId>__<rand>` since the
  // multi-session/DUPLICATE_IDENTITY fix — strip the suffix so the
  // tile label doesn't end up reading "65429e63…__9a3f5e10".
  const raw = participant.identity || '';
  const delim = raw.indexOf('__');
  return (delim === -1 ? raw : raw.slice(0, delim)) || 'Participant';
}

function targetsEqual(a: ActiveRoomTarget, b: ActiveRoomTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.roomName !== b.roomName) return false;
  // For 'none' the other fields don't matter.
  if (a.kind === 'none') return true;
  if (a.kind === 'spatial') return a.spatialRoomId === b.spatialRoomId;
  // 'surface'
  return a.surfaceApp === b.surfaceApp && a.surfaceId === b.surfaceId;
}

/**
 * Resolve the ws_url from a token mint against the current page origin.
 * bureau-api passes through whatever LIVEKIT_URL it was configured with;
 * a RELATIVE path (e.g. `/livekit-ws`, via LIVEKIT_WS_URL) means "the
 * nginx LiveKit proxy on this same host" — resolved here so one config
 * value works for localhost, LAN-IP, and prod hostnames alike, and so
 * https pages automatically get wss (a hardcoded ws:// URL on an https
 * page is blocked as mixed content, which presented as the docked box
 * flipping straight to a red "error" on room entry).
 */
export function resolveWsUrl(raw: string): string {
  if (!raw.startsWith('/')) return raw;
  if (typeof window === 'undefined') return raw;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}${raw}`;
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
  private videoTiles: VideoTile[] = [];

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
      videoTiles: this.videoTiles,
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
      // Forward to the platform system_errors sink so the failure
      // appears in the SuperUser Log Analysis tab with the same shape
      // as a server-side 5xx. Lazy import keeps this file SSR-clean
      // (the helper is a no-op outside the browser anyway).
      void reportBureauCallError({
        stage: 'mint',
        err,
        target,
        message: this.errorMessage,
      });
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
      await room.connect(resolveWsUrl(minted.ws_url), minted.token);
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
      void reportBureauCallError({
        stage: 'room-connect',
        err,
        target,
        message: this.errorMessage,
        wsUrl: resolveWsUrl(minted.ws_url),
      });
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
    this.rebuildVideoTiles();
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

  /**
   * Walk every participant's publications and rebuild the videoTiles list
   * from scratch. Cheaper than maintaining an incremental delta; the only
   * events that mutate this are track (un)published and (un)subscribed,
   * none of which fire faster than human-scale.
   *
   * Ordering: screen-share tracks first, then face cams; within each
   * group, the local participant goes last (self-preview = least-
   * important tile). The UI uses this order verbatim — screen-shares
   * dominate the layout, faces fill the gutter.
   */
  private rebuildVideoTiles(): void {
    const room = this.room;
    if (!room) {
      this.videoTiles = [];
      return;
    }

    const collect = (participant: Participant, isLocal: boolean): VideoTile[] => {
      const out: VideoTile[] = [];
      participant.videoTrackPublications.forEach((pub: TrackPublication) => {
        const source = pub.source;
        if (source !== Track.Source.Camera && source !== Track.Source.ScreenShare) return;
        const t = pub.track as VideoTrack | undefined;
        // For remote publications, the track is null until subscribed; a
        // local publication always has its track immediately. Either way
        // we surface a tile so the UI can show a "loading" placeholder.
        // Skip remote publications that don't yet have a sid.
        if (!pub.trackSid) return;
        // participantId carries the canonical user_id (extracted from
        // the per-session identity) so tiles for the same person stay
        // grouped if they have multiple sessions in the room.
        const rawIdentity = participant.identity || '';
        const delim = rawIdentity.indexOf('__');
        const participantId = delim === -1 ? rawIdentity : rawIdentity.slice(0, delim);
        out.push({
          sid: pub.trackSid,
          participantId,
          participantName: deriveParticipantName(participant),
          source: source === Track.Source.ScreenShare ? 'screen' : 'camera',
          isLocal,
          isMuted: pub.isMuted,
          track: t ?? null,
        });
      });
      return out;
    };

    const tiles: VideoTile[] = [];
    room.remoteParticipants.forEach((p) => tiles.push(...collect(p, false)));
    tiles.push(...collect(room.localParticipant, true));
    // Stable order: screen-shares first, then cameras; locals last in each group.
    tiles.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'screen' ? -1 : 1;
      if (a.isLocal !== b.isLocal) return a.isLocal ? 1 : -1;
      return a.sid.localeCompare(b.sid);
    });
    this.videoTiles = tiles;
  }

  private attachRoomListeners(room: Room, generation: number): void {
    const onTrackChange = () => {
      if (generation !== this.connectGeneration) return;
      this.syncTrackStateFromRoom();
      this.rebuildVideoTiles();
      this.emit();
    };

    const onVideoChange = () => {
      if (generation !== this.connectGeneration) return;
      this.rebuildVideoTiles();
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
      this.videoTiles = [];
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
    // Remote video lifecycle. Subscribed/Unsubscribed are the events that
    // actually move VideoTile.track from null → set and back, so the UI
    // can attach the <video> element.
    room.on(RoomEvent.TrackSubscribed, onVideoChange);
    room.on(RoomEvent.TrackUnsubscribed, onVideoChange);
    room.on(RoomEvent.TrackPublished, onVideoChange);
    room.on(RoomEvent.TrackUnpublished, onVideoChange);
    room.on(RoomEvent.ParticipantDisconnected, onVideoChange);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.Disconnected, onDisconnected);

    this.cleanupRoomListeners = () => {
      room.off(RoomEvent.TrackMuted, onTrackChange);
      room.off(RoomEvent.TrackUnmuted, onTrackChange);
      room.off(RoomEvent.LocalTrackPublished, onTrackChange);
      room.off(RoomEvent.LocalTrackUnpublished, onTrackChange);
      room.off(RoomEvent.TrackSubscribed, onVideoChange);
      room.off(RoomEvent.TrackUnsubscribed, onVideoChange);
      room.off(RoomEvent.TrackPublished, onVideoChange);
      room.off(RoomEvent.TrackUnpublished, onVideoChange);
      room.off(RoomEvent.ParticipantDisconnected, onVideoChange);
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
    this.videoTiles = [];
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
        // Fastify's content-type parser 400s a Content-Type: application/json
        // request with an empty body, so a payload-free POST that declares
        // JSON must still send `{}`. Without it the call widget never gets
        // past the mint and shows a generic "error" with no useful detail.
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        // Pull the server envelope when we can — much more informative than
        // a bare status code in the docked-box tooltip.
        let detail = '';
        try {
          const j = (await res.json()) as { error?: { message?: string; code?: string } };
          if (j?.error?.message) detail = `: ${j.error.message}`;
          else if (j?.error?.code) detail = `: ${j.error.code}`;
        } catch {
          /* non-JSON body, status code is the best we can do */
        }
      throw new Error(`rooms/:id/token returned ${res.status}${detail}`);
      }
      const body = (await res.json()) as unknown;
      return parseTokenEnvelope(body);
    }
    if (target.kind === 'surface') {
      if (!target.surfaceApp || !target.surfaceId) {
        throw new Error('surface target missing surfaceApp/surfaceId');
      }
      const url = `${this.apiBase}/surface-huddle/token`;
      const payload = JSON.stringify({
        surface_app: target.surfaceApp,
        surface_id: target.surfaceId,
      });

      // The mint is now symmetric-auth gated server-side: bureau-api refuses
      // (403 NOT_ON_SURFACE) until it can see our `location_update` presence
      // session for this surface. That update travels over the WS connection,
      // which can still be (re)connecting when this REST mint fires on a
      // fresh navigation. The server already grace-polls for ~0.6s; we retry
      // a couple more times here so a slow WS handshake beyond that window
      // still recovers instead of dead-ending the call in 'error'. Only 403
      // is retried — every other status is a real failure surfaced at once.
      const SURFACE_MINT_RETRIES = 2;
      const SURFACE_MINT_BACKOFF_MS = 500;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
        if (res.ok) {
          const body = (await res.json()) as unknown;
          return parseTokenEnvelope(body);
        }
        if (res.status === 403 && attempt < SURFACE_MINT_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, SURFACE_MINT_BACKOFF_MS),
          );
          continue;
        }
        throw new Error(`surface-huddle/token returned ${res.status}`);
      }
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

// ─────────────────────────────────────────────────────────────────────
// System-errors bridge.
//
// Every call.status='error' transition is forwarded to the platform
// system_errors sink so a "red label" in the docked box also lands in
// the SuperUser Log Analysis tab. The reporter is initialized once by
// the host SPA via initSystemErrorReporter(); when not configured
// reportSystemError() is a console.error no-op, so this is always
// safe to call.
// ─────────────────────────────────────────────────────────────────────

interface BureauCallErrorContext {
  stage: 'mint' | 'room-connect';
  err: unknown;
  target: ActiveRoomTarget;
  message: string;
  wsUrl?: string;
}

async function reportBureauCallError(ctx: BureauCallErrorContext): Promise<void> {
  try {
    // Lazy import so test environments that don't ship the reporter
    // module (we ship it in the same package so this just works) still
    // load. If the dynamic import fails for any reason the catch below
    // keeps it silent.
    const { reportSystemError } = await import('./system-error-reporter.js');
    const errorObj = ctx.err instanceof Error ? ctx.err : null;
    await reportSystemError({
      message: `Bureau call ${ctx.stage} failed: ${ctx.message}`,
      stack: errorObj?.stack,
      error_code: ctx.stage === 'mint' ? 'BUREAU_MINT_FAILED' : 'BUREAU_CONNECT_FAILED',
      payload: {
        stage: ctx.stage,
        target_kind: ctx.target.kind,
        room_name: ctx.target.roomName,
        spatial_room_id: ctx.target.spatialRoomId ?? null,
        surface_app: ctx.target.surfaceApp ?? null,
        surface_id: ctx.target.surfaceId ?? null,
        label: ctx.target.label ?? null,
        ws_url: ctx.wsUrl ?? null,
        error_name: errorObj?.name ?? typeof ctx.err,
      },
    });
  } catch {
    // Never let logging break the caller's error path.
  }
}
