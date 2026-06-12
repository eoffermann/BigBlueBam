/**
 * Bureau WebSocket protocol types — mirrors §8 of the bureau design doc.
 *
 * Frame envelope on the wire (client → server messages omit `timestamp`;
 * server → client messages include it):
 *
 *   { type: string, data?: Record<string, unknown>, timestamp?: string }
 *
 * The server flattens `data` into the message body on outbound frames in
 * apps/bureau-api/src/routes/ws.routes.ts — see the `frame()` helper there.
 * On the client we parse both shapes (flat or nested under `data`) so future
 * refactors on either side don't desync.
 */

// ─────────────────────────────────────────────────────────────────────────
// Presence status / privacy enums (mirror the server's ALLOWED_STATUS /
// ALLOWED_PRIVACY sets in ws.routes.ts).
// ─────────────────────────────────────────────────────────────────────────

export type PresenceStatus =
  | 'available'
  | 'busy'
  | 'dnd'
  | 'focus'
  | 'away'
  | 'in_meeting';

export type RoomPrivacy = 'open' | 'knock' | 'private';

export type KnockDecision = 'admit' | 'defer' | 'decline';
export type KnockResolution = 'admitted' | 'deferred' | 'declined';

export type SummonDecision = 'join' | 'stay';

// ─────────────────────────────────────────────────────────────────────────
// describeLocation contract — the host SPA returns one of these whenever
// its route changes; the SDK relays it as `location_update`.
// ─────────────────────────────────────────────────────────────────────────

export interface LocationDescriptor {
  /** Canonical URL for the focused resource (used by summon). */
  url: string;
  /** App identifier — 'board', 'brief', 'bond', 'b3' (Bam), etc. */
  app: string;
  /** Human-readable label (board title, doc title, …). */
  label?: string;
  /**
   * Set when the destination supports continuous-audio handoff (§9 Strategy B).
   * The value is the LiveKit room hint the destination should join on summon.
   */
  livekitRoom?: string;
  /**
   * The room-identifying portion of the host URL (a docId, boardId, dealId,
   * taskId, …) for surface-scoped huddles. When set AND the user is not
   * currently in a Bureau spatial room, the ActiveCallManager treats it as
   * the implicit target — joining `huddle-{app}-{surface_id}` so any two
   * users on the same surface land in the same LiveKit room.
   *
   * Hosts can advertise this without us re-parsing their URL. Apps that
   * haven't been threaded yet simply omit it — the SDK then derives a
   * synthetic URL surface ("every place is a room") so the page still
   * gets a call room; see surface_kind.
   */
  surface_id?: string;
  /**
   * How surface_id was produced. 'entity' (default when a host supplied
   * surface_id) joins the app-scoped room `huddle-{app}-{id}`; 'url'
   * (SDK-derived from the page path via @bigbluebam/shared
   * deriveUrlSurfaceId) joins the org-scoped room minted by bureau-api
   * for surface_app 'url'.
   */
  surface_kind?: 'entity' | 'url';
  /**
   * Bureau-SPA only: the spatial room the local user currently occupies on
   * the floor being viewed. The floor view drives room membership over its
   * OWN WebSocket (useBureauWs), so the SDK's socket never sees the
   * room_enter — the host mirrors it here instead and the SDK adopts it as
   * `state.roomId`.
   *
   * Semantics: `undefined` = host doesn't track spatial rooms (every
   * non-Bureau SPA) — the SDK leaves its own WS-driven roomId alone.
   * `null` = host tracks spatial rooms and the user is NOT in one.
   */
  spatialRoomId?: string | null;
  /** Display name for spatialRoomId (the docked box header shows this). */
  spatialRoomName?: string | null;
  /** Occupant user ids of spatialRoomId, including self. */
  spatialOccupantIds?: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Client → server messages (§8, "Client to server" table).
// ─────────────────────────────────────────────────────────────────────────

export interface SubscribeFloorMessage {
  type: 'subscribe_floor';
  floorId: string;
}

export interface EnterRoomMessage {
  type: 'enter_room';
  roomId: string;
}

export interface LeaveRoomMessage {
  type: 'leave_room';
}

export interface HeartbeatMessage {
  type: 'heartbeat';
}

export interface SetStatusMessage {
  type: 'set_status';
  status: PresenceStatus;
  statusText?: string;
  emoji?: string;
}

export interface SetDoorMessage {
  type: 'set_door';
  roomId: string;
  privacy: RoomPrivacy;
}

export interface LockRoomMessage {
  type: 'lock_room';
  roomId: string;
  locked: boolean;
}

export interface KnockMessage {
  type: 'knock';
  roomId: string;
  message?: string;
}

export interface KnockRespondMessage {
  type: 'knock_respond';
  knockId: string;
  decision: KnockDecision;
}

export interface LocationUpdateMessage {
  type: 'location_update';
  url: string;
  app: string;
  label?: string;
}

export interface SummonMessage {
  type: 'summon';
  targetUrl: string;
  app: string;
  label?: string;
  lkRoomHint?: string;
}

export interface SummonRespondMessage {
  type: 'summon_respond';
  summonId: string;
  decision: SummonDecision;
}

export interface SummonGrantAccessMessage {
  type: 'summon_grant_access';
  summonId: string;
  userIds: string[];
}

export type ClientMessage =
  | SubscribeFloorMessage
  | EnterRoomMessage
  | LeaveRoomMessage
  | HeartbeatMessage
  | SetStatusMessage
  | SetDoorMessage
  | LockRoomMessage
  | KnockMessage
  | KnockRespondMessage
  | LocationUpdateMessage
  | SummonMessage
  | SummonRespondMessage
  | SummonGrantAccessMessage
  | RingRespondMessage;

// ─────────────────────────────────────────────────────────────────────────
// Server → client messages (§8, "Server to client" table) plus the
// non-spec connected / knock_sent / summon_ack ack frames the hub emits
// in apps/bureau-api/src/routes/ws.routes.ts.
// ─────────────────────────────────────────────────────────────────────────

export interface ConnectedEvent {
  type: 'connected';
  user_id: string;
  session_id: string;
}

export interface PresenceSnapshotEvent {
  type: 'presence_snapshot';
  floorId: string;
  /** userId → roomId map for the floor. */
  occupancy: Record<string, string>;
  /** roomId → flat hash of door overrides (privacy, lockedBy, …). */
  roomState: Record<string, Record<string, string>>;
}

export interface PresenceDeltaEvent {
  type: 'presence_delta';
  userId: string;
  roomId?: string | null;
  status?: PresenceStatus;
  location?: {
    url: string;
    app: string;
    label?: string | null;
  };
}

export interface RoomEnterEvent {
  type: 'room_enter';
  roomId: string;
  userId: string;
}

export interface RoomLeaveEvent {
  type: 'room_leave';
  roomId: string;
  userId: string;
}

/**
 * Full occupant roster for a room, pushed by the server to a socket the
 * moment it enters that room (the `enter_room` handler). Without it a user
 * who joins an already-occupied room via `actions.enterRoom()` sees an empty
 * docked-box occupant list ("Just you") until someone else moves and emits a
 * `room_enter` delta. `userIds` includes everyone currently in the room,
 * including the entering user themselves; the SDK filters self out.
 */
export interface RoomOccupantsEvent {
  type: 'room_occupants';
  roomId: string;
  userIds: string[];
}

export interface DoorChangedEvent {
  type: 'door_changed';
  roomId: string;
  privacy: RoomPrivacy;
  by: string;
}

export interface RoomLockedEvent {
  type: 'room_locked';
  roomId: string;
  locked: boolean;
  by: string;
}

export interface LivekitTokenEvent {
  type: 'livekit_token';
  roomName: string;
  token: string;
  url: string;
}

export interface KnockIncomingEvent {
  type: 'knock_incoming';
  knockId: string;
  visitor: { id: string; name: string };
  roomId: string;
  message?: string | null;
}

export interface KnockResolvedEvent {
  type: 'knock_resolved';
  knockId: string;
  decision: KnockResolution;
}

export interface KnockSentEvent {
  type: 'knock_sent';
  knockId: string;
  roomId: string;
}

export interface SummonIncomingEvent {
  type: 'summon_incoming';
  summonId: string;
  summoner: { id: string; name: string };
  targetUrl: string;
  app: string;
  label?: string | null;
  lkRoomHint?: string | null;
  autoFollow?: boolean;
}

export interface SummonAccessReportEvent {
  type: 'summon_access_report';
  summonId: string;
  denied: Array<{ userId: string; name: string }>;
  canShare: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Surface-scoped huddle ring (docs/plans/presence-and-immediate-interaction.md).
//
// When one user clicks "Ring for huddle" from a surface presence chip strip
// (a Brief doc, Board canvas, Bond deal, Bam task, Beacon article, Blueprint
// diagram, or Helpdesk ticket), bureau-api fans the ring out on the target's
// user:{userId} Redis channel as `ring_incoming`. The receiver's SDK renders
// the shared <IncomingCallOverlay/> from @bigbluebam/ui; on Accept, the SDK
// mints a LiveKit token for `huddle-{surface_app}-{surface_id}` and navigates
// the host to the surface URL with `?huddle=1` appended so the destination
// knows to mount its huddle UI.
// ─────────────────────────────────────────────────────────────────────────

export interface RingIncomingEvent {
  type: 'ring_incoming';
  /** Caller user id. */
  from_user_id: string;
  /** Caller display name (already resolved server-side). */
  from_user_name: string;
  /** App owning the surface — 'brief', 'board', 'blueprint', 'bond', 'b3', 'beacon', 'helpdesk'. */
  surface_app: string;
  /** Entity id within the surface app (e.g. docId, boardId, dealId, taskId). */
  surface_id: string;
  /** Human-readable surface label ("Q3 Roadmap", "ACME deal", …); may be null. */
  surface_label?: string | null;
  /** Concrete destination URL. Always present for 'url'-kind surfaces
   *  (the hashed surface_id can't be reversed into a URL); optional
   *  enrichment otherwise. Recipients strip the origin before navigating. */
  surface_url?: string | null;
  /**
   * One-shot acceptance token. Echoed back to bureau-api when the receiver
   * accepts; bureau-api uses it to gate LiveKit token minting against the
   * server-side ring record (prevents stale-ring acceptance).
   */
  ring_token: string;
  /** ISO 8601 timestamp when the ring auto-declines if unanswered. */
  expires_at: string;
}

export type RingDecision = 'accept' | 'decline' | 'auto_decline';

/**
 * Server → caller frame: the recipient answered (or auto-declined) a ring
 * the caller sent. Delivered on the caller's `user:{id}` channel by the WS
 * hub's `ring_respond` handler. Lets an outgoing-ring UI ("ringing…") close
 * itself with the outcome.
 */
export interface RingRespondedEvent {
  type: 'ring_responded';
  ring_token: string;
  decision: RingDecision;
  by: { id: string; name?: string | null };
  surface_app?: string;
  surface_id?: string;
}

/**
 * Client → server frame the SDK posts back through the WS when the receiver
 * decides. Mirrors the bureau-api ring handler contract; not part of the
 * bureau-design-document.md §8 catalog (added with the presence-and-
 * immediate-interaction.md surface-huddle work).
 */
export interface RingRespondMessage {
  type: 'ring_respond';
  ring_token: string;
  decision: RingDecision;
}

export interface SummonProgressEvent {
  type: 'summon_progress';
  summonId: string;
  joined: number;
  total: number;
}

export interface SummonAckEvent {
  type: 'summon_ack';
  // Echoed by the server for any summon-family message it has not yet
  // implemented; see the workstream-6 stub in ws.routes.ts.
  // (Will go away once Agent A wires the summon worker.)
  accepted: boolean;
  reason?: string;
}

export interface StatusChangedEvent {
  type: 'status_changed';
  userId: string;
  status: PresenceStatus;
  statusText?: string | null;
  emoji?: string | null;
}

export interface ErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  | ConnectedEvent
  | PresenceSnapshotEvent
  | PresenceDeltaEvent
  | RoomEnterEvent
  | RoomLeaveEvent
  | RoomOccupantsEvent
  | DoorChangedEvent
  | RoomLockedEvent
  | LivekitTokenEvent
  | KnockIncomingEvent
  | KnockResolvedEvent
  | KnockSentEvent
  | SummonIncomingEvent
  | SummonAccessReportEvent
  | SummonProgressEvent
  | SummonAckEvent
  | StatusChangedEvent
  | RingIncomingEvent
  | RingRespondedEvent
  | ErrorEvent;

export type ServerMessageType = ServerMessage['type'];

/** Map of message type → typed payload, used by the on()/off() handler API. */
export type ServerMessageMap = {
  [M in ServerMessage as M['type']]: M;
};

// ─────────────────────────────────────────────────────────────────────────
// Occupant / room snapshot — used by the docked-box UI.
// ─────────────────────────────────────────────────────────────────────────

export interface BureauOccupant {
  userId: string;
  name?: string;
  status?: PresenceStatus;
  isAgent?: boolean;
}

export interface BureauRoomSnapshot {
  roomId: string | null;
  roomName?: string | null;
  privacy?: RoomPrivacy | null;
  occupants: BureauOccupant[];
}

// ─────────────────────────────────────────────────────────────────────────
// WS-client connection status — exposed via useBureauPresence().
// ─────────────────────────────────────────────────────────────────────────

export type BureauConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

// ─────────────────────────────────────────────────────────────────────────
// Floating-box render targets (§5.1).
//
//   'inline' — rendered into the host SPA's portal root, the default path
//              and the only path on non-Chromium browsers.
//   'pip'    — rendered into a Document Picture-in-Picture window via the
//              Chromium-only window.documentPictureInPicture API. The host
//              SPA keeps the React tree alive; the PiP window receives the
//              same docked box through a portal and inherits all contexts.
//   'tauri'  — reserved for a future native window host (workstream N).
//
// State transitions are driven by openPipWindow() / closePipWindow() in
// pip-host.tsx and exposed to the SDK via useBureauPipMode().
// ─────────────────────────────────────────────────────────────────────────

export type BureauPipMode = 'inline' | 'pip' | 'tauri';

/**
 * Augmentation for the Chromium Document Picture-in-Picture API. Only the
 * surface we touch is declared; everything else lives on a `Window` lookalike
 * that we treat as opaque.
 */
export interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

export interface DocumentPictureInPicture {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  readonly window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}
