/**
 * @bigbluebam/bureau-client — the SDK every other SPA mounts.
 *
 * Public surface:
 *   - mountBureauClient(opts): UnmountFn
 *       Boots the WS connection, registers the location reporter, renders
 *       the docked box + summon/knock toasts into a portal root, and returns
 *       a teardown function. Idempotent on the host page: a second call
 *       replaces the prior mount.
 *
 *   - useBureauPresence(): hook the host can use to know whether the local
 *       user is currently in a room, what room, who else is there, and the
 *       live WS connection status.
 *
 *   - BureauDockedBox: the floating box itself. Exported in case a host
 *       wants to render it in a non-default container (e.g. inside its own
 *       sidebar) instead of the portal root.
 *
 *   - BureauWsClient + types: low-level access for hosts that want to
 *       drive the protocol directly.
 *
 * Per design doc §11 (`docs/plans/bureau-design-document.md`):
 *
 *   mountBureauClient({
 *     describeLocation: (route) => ({ url, app, label, livekitRoom? }),
 *     navigate:         (url)   => router.push(stripOrigin(url)),
 *   })
 *
 * Hosts are expected to call mountBureauClient() exactly once per page load,
 * after auth has been established (the WS handshake reads the shared session
 * cookie). Workstream 13 wires this into each SPA.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { BureauWsClient } from './ws-client.js';
import type {
  BureauConnectionStatus,
  BureauOccupant,
  BureauRoomSnapshot,
  LocationDescriptor,
  PresenceStatus,
  RoomPrivacy,
} from './types.js';
import { SummonHandler } from './summon-handler.js';
import { KnockHandler } from './knock-handler.js';
import { RingHandler } from './ring-handler.js';
import { PipPortal, PopoutBureauButton, usePipMode } from './pip-host.js';
import {
  ActiveCallManager,
  IDLE_TARGET,
  getActiveCallManager,
  setActiveCallManager,
  type ActiveRoomTarget,
} from './active-room.js';
import { useActiveCall } from './use-active-call.js';
import { InvitePopover } from './invite-popover.js';

// BureauWsClient is exported as a value (not just a type) so consumers
// like the Bureau SPA's useBureauWs hook can `new BureauWsClient(...)`.
export { BureauWsClient } from './ws-client.js';
export * from './types.js';
export {
  PopoutBureauButton,
  openPipWindow,
  closePipWindow,
  isDocumentPipSupported,
  usePipMode,
  usePipMount,
  PipPortal,
  subscribeToPipMode,
  getPipMode,
} from './pip-host.js';
export type { PopoutBureauButtonProps } from './pip-host.js';

// Unified call manager + hook — Phase 1 of the unified-LiveKit migration.
// Hosts rarely need the raw manager; useActiveCall() is the recommended
// surface. Exporting both for power callers and tests.
export {
  ActiveCallManager,
  getActiveCallManager,
  setActiveCallManager,
  IDLE_TARGET,
} from './active-room.js';
export type {
  ActiveRoomTarget,
  ActiveCallStatus,
  ActiveCallSnapshot,
  ActiveCallTrackState,
  ActiveCallListener,
} from './active-room.js';
export { useActiveCall } from './use-active-call.js';
export type { UseActiveCall } from './use-active-call.js';

// ─────────────────────────────────────────────────────────────────────────
// MountOptions — the §11 contract.
// ─────────────────────────────────────────────────────────────────────────

export interface MountOptions {
  /**
   * Called by the SDK whenever it wants to know where the host SPA is right
   * now. Return undefined to skip a location_update (e.g. the user is on a
   * non-resource page).
   *
   * The first argument is what the host last passed to setRoute() (see
   * the returned controller). It is opaque to the SDK.
   */
  describeLocation: (route: unknown) => LocationDescriptor | undefined;

  /**
   * Called when a summon is accepted; the host is expected to push the URL
   * into its router (`router.push(stripOrigin(url))`). The URL is already
   * stripped of origin by the SDK, but stripping again is harmless.
   */
  navigate: (url: string) => void;

  /** Override the WS URL (defaults to ws(s)://<host>/bureau/ws). */
  wsUrl?: string;

  /**
   * Initial route descriptor — what describeLocation() will receive on
   * first call before the host has had a chance to update it.
   */
  initialRoute?: unknown;

  /**
   * Whether to render the docked floating box (default: true). Hosts that
   * want to mount it in a custom location can pass `false` and render
   * <BureauDockedBox /> themselves.
   */
  renderDockedBox?: boolean;

  /**
   * Container element for the SDK's portal root. Defaults to a new <div>
   * appended to document.body, removed on unmount.
   */
  portalContainer?: HTMLElement;

  /**
   * Optional callback to receive WS-status transitions. Hosts can wire this
   * into their toast system to surface "Bureau disconnected" warnings.
   */
  onStatusChange?: (status: BureauConnectionStatus) => void;
}

/** Returned by mountBureauClient — call to tear everything down. */
export type UnmountFn = (() => void) & {
  /** Update the route descriptor opaquely passed to describeLocation(). */
  setRoute: (route: unknown) => void;
  /** Direct access to the underlying client (for advanced hosts). */
  client: BureauWsClient;
};

// ─────────────────────────────────────────────────────────────────────────
// Shared presence-state model (drives the docked box + useBureauPresence).
//
// The model is intentionally minimal: the SDK is the source of truth for
// "what room am I in, who else is here, what's my status" only. Anything
// richer (the full floor view) belongs in the bureau SPA itself, which
// has its own REST + WS layer.
// ─────────────────────────────────────────────────────────────────────────

interface PresenceState {
  status: BureauConnectionStatus;
  selfUserId: string | null;
  sessionId: string | null;
  /** Self-reported presence status (available, busy, …). */
  selfStatus: PresenceStatus;
  /** Active floor (set when subscribe_floor succeeds). */
  floorId: string | null;
  /** Current room id (set after enter_room, cleared on leave_room). */
  roomId: string | null;
  /** Per-room privacy overrides keyed by roomId. */
  roomPrivacy: Record<string, RoomPrivacy | undefined>;
  /** Latest reported location (the same object describeLocation returned). */
  location: LocationDescriptor | null;
  /** Occupants of the current room, including self. */
  occupants: BureauOccupant[];
  /** LiveKit handoff payload from the last enter_room. */
  livekit: { roomName: string; token: string; url: string } | null;
}

const initialState: PresenceState = {
  status: 'idle',
  selfUserId: null,
  sessionId: null,
  selfStatus: 'available',
  floorId: null,
  roomId: null,
  roomPrivacy: {},
  location: null,
  occupants: [],
  livekit: null,
};

interface BureauContextValue {
  client: BureauWsClient;
  state: PresenceState;
  /** Imperative actions exposed by the SDK. */
  actions: {
    enterRoom: (roomId: string) => void;
    leaveRoom: () => void;
    setStatus: (
      status: PresenceStatus,
      extras?: { statusText?: string; emoji?: string },
    ) => void;
    setDoor: (roomId: string, privacy: RoomPrivacy) => void;
    lockRoom: (roomId: string, locked: boolean) => void;
    summonHere: () => void;
  };
}

const BureauContext = createContext<BureauContextValue | null>(null);

// ─────────────────────────────────────────────────────────────────────────
// Hook: useBureauPresence — what every other SPA imports to introspect
// "am I in a Bureau room right now, and who's with me?"
// ─────────────────────────────────────────────────────────────────────────

export interface UseBureauPresence {
  status: BureauConnectionStatus;
  selfUserId: string | null;
  /** Convenience: am I currently in a room? */
  inRoom: boolean;
  roomId: string | null;
  selfStatus: PresenceStatus;
  occupants: BureauOccupant[];
  location: LocationDescriptor | null;
  livekit: { roomName: string; token: string; url: string } | null;
  /** Bureau action surface — null when used outside a mount. */
  actions: BureauContextValue['actions'] | null;
}

export function useBureauPresence(): UseBureauPresence {
  const ctx = useContext(BureauContext);
  if (!ctx) {
    return {
      status: 'idle',
      selfUserId: null,
      inRoom: false,
      roomId: null,
      selfStatus: 'available',
      occupants: [],
      location: null,
      livekit: null,
      actions: null,
    };
  }
  return {
    status: ctx.state.status,
    selfUserId: ctx.state.selfUserId,
    inRoom: !!ctx.state.roomId,
    roomId: ctx.state.roomId,
    selfStatus: ctx.state.selfStatus,
    occupants: ctx.state.occupants,
    location: ctx.state.location,
    livekit: ctx.state.livekit,
    actions: ctx.actions,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// BureauProvider — wraps the WS client + presence reducer + location relay.
//
// In the mountBureauClient() path, this is what's rendered into the portal.
// Hosts that want to render the docked box inline can do so by mounting
// BureauProvider themselves around <BureauDockedBox /> + <SummonHandler /> +
// <KnockHandler />, although mountBureauClient is the recommended path.
// ─────────────────────────────────────────────────────────────────────────

export interface BureauProviderProps {
  client: BureauWsClient;
  navigate: (url: string) => void;
  children?: ReactNode;
  /**
   * Reactor for the host route. When the value passed here changes, the SDK
   * calls describeLocation(route) and pushes location_update if the result
   * is non-undefined and changed.
   */
  route?: unknown;
  describeLocation: (route: unknown) => LocationDescriptor | undefined;
}

function BureauProvider({
  client,
  navigate: _navigate,
  children,
  route,
  describeLocation,
}: BureauProviderProps): React.ReactElement {
  const [state, setState] = useState<PresenceState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── WS status & connected/disconnected handling ──
  useEffect(() => {
    const off = client.onStatus((next) => {
      setState((s) => ({ ...s, status: next }));
    });
    return off;
  }, [client]);

  useEffect(() => {
    const off = client.on('connected', (msg) => {
      setState((s) => ({
        ...s,
        selfUserId: msg.user_id || s.selfUserId,
        sessionId: msg.session_id || s.sessionId,
      }));
    });
    return off;
  }, [client]);

  // ── Presence snapshot & deltas ──
  useEffect(() => {
    const off = client.on('presence_snapshot', (msg) => {
      // Hosts other than the bureau SPA itself rarely subscribe to a floor,
      // but if they do (e.g. the floor picker) we honor it.
      setState((s) => ({
        ...s,
        floorId: msg.floorId,
      }));
    });
    return off;
  }, [client]);

  // ── Room enter/leave updates the local occupant list. ──
  useEffect(() => {
    const off = client.on('room_enter', (msg) => {
      setState((s) => {
        // Self entered? — set current room.
        const isSelf = msg.userId === s.selfUserId;
        if (isSelf) {
          return { ...s, roomId: msg.roomId };
        }
        // Else: someone joined our current room.
        if (s.roomId === msg.roomId) {
          if (s.occupants.some((o) => o.userId === msg.userId)) return s;
          return {
            ...s,
            occupants: [...s.occupants, { userId: msg.userId }],
          };
        }
        return s;
      });
    });
    return off;
  }, [client]);

  // ── Room occupant snapshot — the server pushes the full roster to us
  //    the moment we enter a room, so an already-occupied room shows its
  //    people immediately instead of "Just you" until someone else moves. ──
  useEffect(() => {
    const off = client.on('room_occupants', (msg) => {
      setState((s) => {
        // Only adopt the snapshot for the room we are actually in. (A late
        // snapshot for a room we already left is ignored.)
        if (s.roomId !== msg.roomId) return s;
        const others = msg.userIds.filter((uid) => uid !== s.selfUserId);
        // Merge: keep any status/name we already have for a user, add the
        // rest as bare entries. Preserves data from in-flight status frames.
        const merged = others.map(
          (userId) =>
            s.occupants.find((o) => o.userId === userId) ?? { userId },
        );
        return { ...s, occupants: merged };
      });
    });
    return off;
  }, [client]);

  useEffect(() => {
    const off = client.on('room_leave', (msg) => {
      setState((s) => {
        const isSelf = msg.userId === s.selfUserId;
        if (isSelf && s.roomId === msg.roomId) {
          return { ...s, roomId: null, occupants: [], livekit: null };
        }
        if (s.roomId === msg.roomId) {
          return {
            ...s,
            occupants: s.occupants.filter((o) => o.userId !== msg.userId),
          };
        }
        return s;
      });
    });
    return off;
  }, [client]);

  // ── Status changed (everyone, including self). ──
  useEffect(() => {
    const off = client.on('status_changed', (msg) => {
      setState((s) => {
        const next: PresenceState = { ...s };
        if (msg.userId === s.selfUserId) {
          next.selfStatus = msg.status;
        }
        next.occupants = s.occupants.map((o) =>
          o.userId === msg.userId ? { ...o, status: msg.status } : o,
        );
        return next;
      });
    });
    return off;
  }, [client]);

  // ── Door / lock — track per-room privacy. ──
  useEffect(() => {
    const off = client.on('door_changed', (msg) => {
      setState((s) => ({
        ...s,
        roomPrivacy: { ...s.roomPrivacy, [msg.roomId]: msg.privacy },
      }));
    });
    return off;
  }, [client]);

  useEffect(() => {
    const off = client.on('room_locked', (msg) => {
      setState((s) => ({
        ...s,
        roomPrivacy: {
          ...s.roomPrivacy,
          [msg.roomId]: msg.locked ? 'private' : s.roomPrivacy[msg.roomId],
        },
      }));
    });
    return off;
  }, [client]);

  // ── LiveKit handoff. ──
  useEffect(() => {
    const off = client.on('livekit_token', (msg) => {
      setState((s) => ({
        ...s,
        livekit: { roomName: msg.roomName, token: msg.token, url: msg.url },
      }));
    });
    return off;
  }, [client]);

  // ── Location relay — every time the host's route changes, push it. ──
  const lastLocationRef = useRef<LocationDescriptor | null>(null);
  useEffect(() => {
    let descriptor: LocationDescriptor | undefined;
    try {
      descriptor = describeLocation(route);
    } catch (err) {
      // Host adapter threw — don't propagate.
      // eslint-disable-next-line no-console
      console.warn('[bureau-client] describeLocation threw', err);
      return;
    }
    if (!descriptor || !descriptor.url || !descriptor.app) {
      // Host left every located page. If the previous location carried a
      // spatial-room mirror (Bureau floor view), drop the mirrored room —
      // unmounting the floor view closed the floor WS, which removed our
      // occupancy server-side.
      if (lastLocationRef.current?.spatialRoomId != null) {
        lastLocationRef.current = null;
        setState((s) => ({
          ...s,
          roomId: null,
          occupants: [],
          livekit: null,
          location: null,
        }));
      }
      return;
    }
    const prev = lastLocationRef.current;
    const sameWire =
      !!prev &&
      prev.url === descriptor.url &&
      prev.app === descriptor.app &&
      prev.label === descriptor.label &&
      prev.livekitRoom === descriptor.livekitRoom &&
      prev.surface_id === descriptor.surface_id;
    const sameSpatial =
      !!prev &&
      prev.spatialRoomId === descriptor.spatialRoomId &&
      prev.spatialRoomName === descriptor.spatialRoomName &&
      (prev.spatialOccupantIds ?? []).join(',') ===
        (descriptor.spatialOccupantIds ?? []).join(',');
    if (sameWire && sameSpatial) {
      return;
    }
    lastLocationRef.current = descriptor;
    setState((s) => {
      const next: PresenceState = { ...s, location: descriptor ?? null };
      // Spatial mirror (see LocationDescriptor.spatialRoomId): only hosts
      // that track spatial rooms set the field at all; for them the mirror
      // is authoritative because the SDK's own WS never gets the room_enter.
      if (descriptor.spatialRoomId !== undefined) {
        next.roomId = descriptor.spatialRoomId;
        const others = (descriptor.spatialOccupantIds ?? []).filter(
          (id) => id !== s.selfUserId,
        );
        next.occupants = others.map(
          (userId) =>
            s.occupants.find((o) => o.userId === userId) ?? { userId },
        );
        if (!descriptor.spatialRoomId) next.livekit = null;
      }
      return next;
    });
    // Occupancy/room changes are local mirrors — only re-send the wire
    // frame when the location itself changed.
    if (!sameWire) {
      client.send({
        type: 'location_update',
        url: descriptor.url,
        app: descriptor.app,
        label: descriptor.label,
      });
    }
  }, [client, describeLocation, route]);

  // ── Active-call routing — keep the ActiveCallManager's target in sync
  //    with (spatial room, surface location). Spatial rooms take priority:
  //    when state.roomId is set we target the spatial room, otherwise we
  //    fall back to the surface (if describeLocation supplied a surface_id),
  //    otherwise we go idle. The location effect above keeps state.location
  //    fresh so this effect can read it as a dependency.
  useEffect(() => {
    const mgr = getActiveCallManager();
    if (!mgr) return;
    const loc = state.location;
    const spatialRoomId = state.roomId;
    let target: ActiveRoomTarget;
    if (spatialRoomId) {
      target = {
        kind: 'spatial',
        roomName: `bureau-room-${spatialRoomId}`,
        spatialRoomId,
      };
    } else if (loc?.surface_id && loc.app) {
      target = {
        kind: 'surface',
        roomName: `huddle-${loc.app}-${loc.surface_id}`,
        surfaceApp: loc.app,
        surfaceId: loc.surface_id,
        label: loc.label,
      };
    } else {
      target = IDLE_TARGET;
    }
    void mgr.setTarget(target);
  }, [state.roomId, state.location]);

  // ── Imperative actions (also surfaced via useBureauPresence().actions). ──
  const actions = useMemo<BureauContextValue['actions']>(
    () => ({
      enterRoom: (roomId: string) => {
        client.send({ type: 'enter_room', roomId });
      },
      leaveRoom: () => {
        client.send({ type: 'leave_room' });
      },
      setStatus: (status, extras) => {
        client.send({
          type: 'set_status',
          status,
          statusText: extras?.statusText,
          emoji: extras?.emoji,
        });
      },
      setDoor: (roomId, privacy) => {
        client.send({ type: 'set_door', roomId, privacy });
      },
      lockRoom: (roomId, locked) => {
        client.send({ type: 'lock_room', roomId, locked });
      },
      summonHere: () => {
        const loc = stateRef.current.location;
        if (!loc) return;
        client.send({
          type: 'summon',
          targetUrl: loc.url,
          app: loc.app,
          label: loc.label,
          lkRoomHint: loc.livekitRoom,
        });
      },
    }),
    [client],
  );

  const value = useMemo<BureauContextValue>(
    () => ({ client, state, actions }),
    [client, state, actions],
  );

  return <BureauContext.Provider value={value}>{children}</BureauContext.Provider>;
}

// ─────────────────────────────────────────────────────────────────────────
// BureauDockedBox — the small "always-on-top-ish" floating widget per §4.2.
// ─────────────────────────────────────────────────────────────────────────

const boxContainerStyle: CSSProperties = {
  position: 'fixed',
  bottom: 16,
  right: 16,
  zIndex: 2147483640,
  minWidth: 220,
  maxWidth: 280,
  background: 'rgba(24, 24, 27, 0.96)',
  color: '#fafafa',
  borderRadius: 10,
  padding: '10px 12px',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSize: 12.5,
  lineHeight: 1.4,
};

const boxHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.7,
  opacity: 0.6,
  marginBottom: 6,
};

const sectionStyle: CSSProperties = {
  marginTop: 6,
};

const occupantStyle: CSSProperties = {
  display: 'inline-block',
  margin: '2px 6px 2px 0',
  padding: '1px 6px',
  background: 'rgba(255,255,255,0.08)',
  borderRadius: 999,
  fontSize: 11,
};

const summonBtnStyle: CSSProperties = {
  marginTop: 6,
  width: '100%',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '6px 8px',
  cursor: 'pointer',
  fontWeight: 600,
};

const controlsRowStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  marginTop: 8,
};

const controlBtnStyle: CSSProperties = {
  flex: 1,
  background: 'rgba(255,255,255,0.08)',
  color: '#fafafa',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: '4px 6px',
  cursor: 'pointer',
  fontSize: 11,
};

const controlBtnActiveStyle: CSSProperties = {
  ...controlBtnStyle,
  background: 'rgba(37, 99, 235, 0.4)',
  borderColor: 'rgba(37, 99, 235, 0.6)',
};

const controlBtnDisabledStyle: CSSProperties = {
  ...controlBtnStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
};

const callStripStyle: CSSProperties = {
  marginTop: 6,
  padding: '4px 8px',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const callStripIdleStyle: CSSProperties = {
  ...callStripStyle,
  opacity: 0.6,
};

const callStripIconStyle: CSSProperties = {
  fontSize: 10,
  opacity: 0.8,
};

const statusDotStyle = (status: BureauConnectionStatus): CSSProperties => ({
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  marginRight: 4,
  background:
    status === 'connected'
      ? '#22c55e'
      : status === 'reconnecting' || status === 'connecting'
        ? '#eab308'
        : '#ef4444',
});

// Style for the "Bureau is popped out" placeholder shown in the host page
// while the real box lives in the PiP window.
const placeholderContainerStyle: CSSProperties = {
  ...boxContainerStyle,
  paddingTop: 8,
  paddingBottom: 8,
  minWidth: 200,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const placeholderRestoreBtnStyle: CSSProperties = {
  marginLeft: 'auto',
  background: 'rgba(255,255,255,0.08)',
  color: '#fafafa',
  border: '1px solid rgba(255,255,255,0.16)',
  borderRadius: 6,
  padding: '3px 8px',
  cursor: 'pointer',
  fontSize: 11,
};

// ─────────────────────────────────────────────────────────────────────────
// Dock position + collapse persistence (Bureau todo #5).
//
// The box is draggable by its header anywhere on screen and collapsible to
// a one-line status bar. `{ x, y, collapsed }` persists per-browser in
// localStorage so the choice survives reloads and applies across every SPA
// on the same origin. x/y === null means "never dragged" — keep the default
// bottom-right anchoring from boxContainerStyle.
// ─────────────────────────────────────────────────────────────────────────

const DOCK_POS_STORAGE_KEY = 'bureau.dock-pos';

interface DockPos {
  x: number | null;
  y: number | null;
  collapsed: boolean;
}

const defaultDockPos: DockPos = { x: null, y: null, collapsed: false };

function loadDockPos(): DockPos {
  if (typeof window === 'undefined') return defaultDockPos;
  try {
    const raw = window.localStorage.getItem(DOCK_POS_STORAGE_KEY);
    if (!raw) return defaultDockPos;
    const parsed = JSON.parse(raw) as Partial<DockPos>;
    return {
      x: typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : null,
      y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null,
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return defaultDockPos;
  }
}

function saveDockPos(pos: DockPos): void {
  try {
    window.localStorage.setItem(DOCK_POS_STORAGE_KEY, JSON.stringify(pos));
  } catch {
    /* storage full / privacy mode — non-fatal */
  }
}

function clampCoord(v: number, max: number): number {
  return Math.min(Math.max(0, v), Math.max(0, max));
}

interface UseDockDrag {
  pos: DockPos;
  dragging: boolean;
  boxRef: React.RefObject<HTMLDivElement | null>;
  /** Style fragment applied to the container when the user has dragged. */
  positionStyle: CSSProperties;
  toggleCollapsed: () => void;
  headerHandleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
    style: CSSProperties;
  };
}

function useDockDrag(enabled: boolean): UseDockDrag {
  const [pos, setPos] = useState<DockPos>(loadDockPos);
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Grab offset of the pointer within the box, captured on pointerdown.
  const dragStateRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(
    null,
  );

  useEffect(() => {
    if (enabled) saveDockPos(pos);
  }, [pos, enabled]);

  const clampIntoViewport = useCallback(() => {
    setPos((p) => {
      if (p.x === null || p.y === null) return p;
      const el = boxRef.current;
      const w = el?.offsetWidth ?? 260;
      const h = el?.offsetHeight ?? 120;
      const cx = clampCoord(p.x, window.innerWidth - w);
      const cy = clampCoord(p.y, window.innerHeight - h);
      if (cx === p.x && cy === p.y) return p;
      return { ...p, x: cx, y: cy };
    });
  }, []);

  // Viewport resize can strand a dragged box off-screen — clamp it back.
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('resize', clampIntoViewport);
    return () => window.removeEventListener('resize', clampIntoViewport);
  }, [enabled, clampIntoViewport]);

  // Expanding near the bottom/right edge can also push the box off-screen;
  // re-clamp after the size change lands in layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies(pos.collapsed): collapsed toggles change the box size, which is exactly when we need to re-clamp.
  useEffect(() => {
    if (!enabled) return;
    const id = window.requestAnimationFrame(clampIntoViewport);
    return () => window.cancelAnimationFrame(id);
  }, [enabled, pos.collapsed, clampIntoViewport]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // Buttons inside the header keep their click semantics — no drag.
    if ((e.target as HTMLElement).closest('button')) return;
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: e.pointerId,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
    };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = dragStateRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const el = boxRef.current;
    const w = el?.offsetWidth ?? 260;
    const h = el?.offsetHeight ?? 120;
    const x = clampCoord(e.clientX - d.dx, window.innerWidth - w);
    const y = clampCoord(e.clientY - d.dy, window.innerHeight - h);
    setPos((p) => (p.x === x && p.y === y ? p : { ...p, x, y }));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = dragStateRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragStateRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setPos((p) => ({ ...p, collapsed: !p.collapsed }));
  }, []);

  const positionStyle: CSSProperties =
    enabled && pos.x !== null && pos.y !== null
      ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
      : {};

  return {
    pos,
    dragging,
    boxRef,
    positionStyle,
    toggleCollapsed,
    headerHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      style: {
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none',
        userSelect: 'none',
      },
    },
  };
}

/** Chevron glyph for the collapse/expand toggle; matches PopoutIcon sizing. */
function ChevronIcon({ up }: { up: boolean }): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ transform: up ? 'rotate(180deg)' : undefined }}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

const chevronBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'rgba(250, 250, 250, 0.65)',
  cursor: 'pointer',
  padding: 2,
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
};

const collapsedBarStyle: CSSProperties = {
  ...boxContainerStyle,
  minWidth: 0,
  maxWidth: 280,
  padding: '6px 10px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const inviteBtnStyle: CSSProperties = {
  ...summonBtnStyle,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  fontWeight: 500,
};

// location.app → ring-API surface_app. Mirrors SURFACE_APPS in
// apps/bureau-api/src/routes/ring.routes.ts; apps absent here (bureau,
// bolt, …) don't get an Invite button because the ring endpoint would
// reject them.
const RING_SURFACE_APP_BY_LOCATION_APP: Record<string, string> = {
  brief: 'brief',
  blueprint: 'blueprint',
  board: 'board',
  bond: 'bond',
  b3: 'bam',
  bam: 'bam',
  beacon: 'beacon',
  helpdesk: 'helpdesk',
  banter: 'banter',
  book: 'book',
};

/**
 * Internal: the actual floating-box markup. Always renders the same UI
 * regardless of whether it lives in the host page or in the PiP window;
 * the only difference is the parent DOM, which createPortal handles.
 */
function BureauDockedBoxInner({
  floating = true,
}: {
  /**
   * True when the box floats over the host page (drag + collapse enabled).
   * The PiP-window copy passes false — the OS window IS the position.
   */
  floating?: boolean;
}): React.ReactElement | null {
  const ctx = useContext(BureauContext);
  const call = useActiveCall();
  const dock = useDockDrag(floating);
  const [inviteOpen, setInviteOpen] = useState(false);
  if (!ctx) return null;
  const { state, actions } = ctx;

  const inRoom = !!state.roomId;
  // Spatial rooms have their display name mirrored through the location
  // descriptor (Bureau todo #3); fall back to the raw id for rooms entered
  // through the SDK's own WS, which has no name source.
  const roomDisplayName = state.location?.spatialRoomName ?? state.roomId;
  const hasOthers = state.occupants.some((o) => o.userId !== state.selfUserId);
  // Bureau todo #7: summoning needs someone to bring (another occupant) and
  // somewhere to bring them (a reported location) — otherwise hide the button.
  const canSummon = inRoom && hasOthers && !!state.location?.url;
  const ringSurfaceApp = state.location?.app
    ? RING_SURFACE_APP_BY_LOCATION_APP[state.location.app]
    : undefined;
  const inviteSurfaceId = state.location?.surface_id;
  const canInvite = !!ringSurfaceApp && !!inviteSurfaceId;
  const callConnected = call.status === 'connected';
  const callIdle = call.status === 'idle' || call.target.kind === 'none';
  const callConnecting = call.status === 'connecting';
  const callErrored = call.status === 'error';

  // Resolve a human-readable "what call am I in" label for the strip.
  let callStripContent: React.ReactNode;
  if (callIdle) {
    callStripContent = <span>Not in a call</span>;
  } else if (call.target.kind === 'spatial') {
    const roomName = call.target.roomName ?? 'Bureau room';
    callStripContent = (
      <>
        <span style={callStripIconStyle} aria-hidden>
          [R]
        </span>
        <span>
          <span style={{ opacity: 0.7 }}>In:</span> <strong>{roomName}</strong>
        </span>
      </>
    );
  } else if (call.target.kind === 'surface') {
    const label =
      call.target.label ??
      state.location?.label ??
      call.target.surfaceApp ??
      'surface';
    callStripContent = (
      <>
        <span style={callStripIconStyle} aria-hidden title="Surface huddle">
          [H]
        </span>
        <span>
          <span style={{ opacity: 0.7 }}>In:</span> <strong>{label}</strong>
        </span>
      </>
    );
  } else {
    callStripContent = <span>Not in a call</span>;
  }
  if (callConnecting) {
    callStripContent = (
      <>
        {callStripContent}
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>connecting…</span>
      </>
    );
  } else if (callErrored) {
    callStripContent = (
      <>
        {callStripContent}
        <span
          style={{ marginLeft: 'auto', color: '#fca5a5' }}
          title={call.errorMessage ?? 'Call error'}
        >
          error
        </span>
      </>
    );
  }

  // Button tooltips reflect the unified-call status.
  const micTitle = callConnected
    ? call.micOn
      ? 'Microphone — on'
      : 'Microphone — muted'
    : 'No active call';
  const camTitle = callConnected
    ? call.camOn
      ? 'Camera — on'
      : 'Camera — off'
    : 'No active call';
  const screenTitle = callConnected
    ? call.screenOn
      ? 'Screen-share — on'
      : 'Screen-share — off'
    : 'No active call';

  const micStyle = !callConnected
    ? controlBtnDisabledStyle
    : call.micOn
      ? controlBtnActiveStyle
      : controlBtnStyle;
  const camStyle = !callConnected
    ? controlBtnDisabledStyle
    : call.camOn
      ? controlBtnActiveStyle
      : controlBtnStyle;
  const screenStyle = !callConnected
    ? controlBtnDisabledStyle
    : call.screenOn
      ? controlBtnActiveStyle
      : controlBtnStyle;

  // Collapsed: a one-line draggable status bar (Bureau todo #5). Only the
  // floating inline box collapses — the PiP copy always shows the full UI.
  if (floating && dock.pos.collapsed) {
    const collapsedSummary = inRoom
      ? `In: ${roomDisplayName}`
      : callConnected && call.target.kind === 'surface'
        ? `In: ${call.target.label ?? call.target.surfaceApp ?? 'huddle'}`
        : 'Not in a call';
    return (
      <section
        ref={dock.boxRef}
        style={{
          ...collapsedBarStyle,
          ...dock.positionStyle,
          ...dock.headerHandleProps.style,
        }}
        data-bureau-docked-box
        data-bureau-collapsed
        aria-label="Bureau"
        onPointerDown={dock.headerHandleProps.onPointerDown}
        onPointerMove={dock.headerHandleProps.onPointerMove}
        onPointerUp={dock.headerHandleProps.onPointerUp}
        onPointerCancel={dock.headerHandleProps.onPointerCancel}
      >
        <span style={statusDotStyle(state.status)} />
        <span
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 0.7,
            opacity: 0.6,
          }}
        >
          Bureau
        </span>
        <span
          style={{
            opacity: 0.8,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 150,
          }}
        >
          {collapsedSummary}
        </span>
        <button
          type="button"
          style={{ ...chevronBtnStyle, marginLeft: 'auto' }}
          onClick={dock.toggleCollapsed}
          title="Expand Bureau"
          aria-label="Expand Bureau"
          aria-expanded={false}
        >
          <ChevronIcon up />
        </button>
      </section>
    );
  }

  return (
    <section
      ref={floating ? dock.boxRef : undefined}
      style={floating ? { ...boxContainerStyle, ...dock.positionStyle } : boxContainerStyle}
      data-bureau-docked-box
      aria-label="Bureau"
    >
      <div
        style={
          floating
            ? { ...boxHeaderStyle, ...dock.headerHandleProps.style }
            : boxHeaderStyle
        }
        onPointerDown={floating ? dock.headerHandleProps.onPointerDown : undefined}
        onPointerMove={floating ? dock.headerHandleProps.onPointerMove : undefined}
        onPointerUp={floating ? dock.headerHandleProps.onPointerUp : undefined}
        onPointerCancel={floating ? dock.headerHandleProps.onPointerCancel : undefined}
      >
        <span>
          <span style={statusDotStyle(state.status)} />
          Bureau
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ opacity: 0.6 }}>
            {state.status === 'connected' ? '' : state.status}
          </span>
          {/* PiP stays available but de-emphasized — the docked box itself is
              now repositionable, so popping out is the secondary path. */}
          <PopoutBureauButton style={{ opacity: 0.5 }} />
          {floating ? (
            <button
              type="button"
              style={chevronBtnStyle}
              onClick={dock.toggleCollapsed}
              title="Collapse Bureau to a bar"
              aria-label="Collapse Bureau to a bar"
              aria-expanded
            >
              <ChevronIcon up={false} />
            </button>
          ) : null}
        </span>
      </div>

      {/* "In:" row */}
      <div>
        <span style={{ opacity: 0.7 }}>In:</span>{' '}
        <strong>{inRoom ? roomDisplayName : 'No room'}</strong>
      </div>

      {/* Occupants */}
      {inRoom ? (
        <div style={sectionStyle}>
          {state.occupants.length === 0 ? (
            <span style={{ opacity: 0.6 }}>Just you</span>
          ) : (
            state.occupants.map((o) => (
              <span key={o.userId} style={occupantStyle}>
                {o.isAgent ? '(A) ' : ''}
                {o.name ?? o.userId.slice(0, 6)}
              </span>
            ))
          )}
        </div>
      ) : null}

      {/* Viewing + actions */}
      <div style={sectionStyle}>
        <span style={{ opacity: 0.7 }}>Viewing:</span>{' '}
        {state.location ? (
          <span title={state.location.url}>
            "{state.location.label ?? state.location.app}" ({state.location.app})
          </span>
        ) : (
          <span style={{ opacity: 0.55 }}>—</span>
        )}
      </div>
      {canSummon ? (
        <button
          type="button"
          style={summonBtnStyle}
          onClick={() => actions.summonHere()}
          title="Pull everyone in this room to the resource you are viewing"
        >
          Bring everyone here
        </button>
      ) : null}
      {canInvite ? (
        <button
          type="button"
          style={inviteBtnStyle}
          data-bureau-invite-button
          onClick={() => setInviteOpen((v) => !v)}
          title="Ring people to join you on this surface"
          aria-expanded={inviteOpen}
        >
          Invite…
        </button>
      ) : null}
      {inviteOpen && canInvite && ringSurfaceApp && inviteSurfaceId ? (
        <InvitePopover
          surfaceApp={ringSurfaceApp}
          surfaceId={inviteSurfaceId}
          surfaceLabel={state.location?.label ?? null}
          selfUserId={state.selfUserId}
          onClose={() => setInviteOpen(false)}
        />
      ) : null}

      {/* Active-call strip — what LiveKit room the docked box is in. */}
      <div
        style={callIdle ? callStripIdleStyle : callStripStyle}
        data-bureau-active-call
        aria-live="polite"
      >
        {callStripContent}
      </div>

      {/* Controls row */}
      <div style={controlsRowStyle}>
        <button
          type="button"
          style={micStyle}
          disabled={!callConnected}
          aria-pressed={call.micOn}
          onClick={() => call.setMic(!call.micOn)}
          title={micTitle}
        >
          {call.micOn ? 'mic on' : 'mic'}
        </button>
        <button
          type="button"
          style={camStyle}
          disabled={!callConnected}
          aria-pressed={call.camOn}
          onClick={() => call.setCam(!call.camOn)}
          title={camTitle}
        >
          {call.camOn ? 'cam on' : 'cam'}
        </button>
        <button
          type="button"
          style={screenStyle}
          disabled={!callConnected}
          aria-pressed={call.screenOn}
          onClick={() => call.setScreen(!call.screenOn)}
          title={screenTitle}
        >
          {call.screenOn ? 'share' : 'screen'}
        </button>
        <button
          type="button"
          style={controlBtnStyle}
          onClick={() => {
            if (!state.roomId) return;
            const next: RoomPrivacy =
              state.roomPrivacy[state.roomId] === 'private' ? 'open' : 'private';
            actions.setDoor(state.roomId, next);
          }}
          title="Toggle door privacy"
          disabled={!inRoom}
        >
          door
        </button>
      </div>
    </section>
  );
}

/**
 * Placeholder shown in the host page while the real docked box lives in the
 * Document PiP window. Clicking "Return" closes the PiP window and brings
 * the box back inline. <output> carries an implicit polite live region /
 * status role, so screen readers announce the swap without extra ARIA.
 */
function BureauPipPlaceholder(): React.ReactElement {
  return (
    <output style={placeholderContainerStyle} data-bureau-pip-placeholder>
      <span style={{ opacity: 0.85 }}>Bureau is open in a separate window</span>
      <PopoutBureauButton style={placeholderRestoreBtnStyle} title="Return Bureau to the page" />
    </output>
  );
}

/**
 * The docked floating box. Rendered by mountBureauClient() into the portal
 * root. Hosts may also render it inline by wrapping themselves in
 * <BureauProvider> first.
 *
 * §5.1 render-target switch:
 *   - mode === 'inline': render <BureauDockedBoxInner/> here in the host page.
 *   - mode === 'pip':    render <BureauPipPlaceholder/> here AND mirror the
 *                        real box into the Document PiP window via PipPortal.
 *                        Because createPortal preserves React context, the
 *                        mirrored tree reads from the same BureauContext as
 *                        the inline tree — there's only one WS client.
 *   - mode === 'tauri':  reserved; falls through to inline for now.
 */
export function BureauDockedBox(): React.ReactElement | null {
  const ctx = useContext(BureauContext);
  const mode = usePipMode();
  if (!ctx) return null;

  if (mode === 'pip') {
    return (
      <>
        <BureauPipPlaceholder />
        <PipPortal>
          <BureauDockedBoxInner floating={false} />
        </PipPortal>
      </>
    );
  }

  return <BureauDockedBoxInner />;
}

// ─────────────────────────────────────────────────────────────────────────
// Internal: the rendered tree mountBureauClient() pushes into the portal.
// ─────────────────────────────────────────────────────────────────────────

interface MountedAppProps {
  client: BureauWsClient;
  describeLocation: MountOptions['describeLocation'];
  navigate: MountOptions['navigate'];
  route: unknown;
  renderDockedBox: boolean;
  portalContainer: HTMLElement;
}

function MountedApp({
  client,
  describeLocation,
  navigate,
  route,
  renderDockedBox,
  portalContainer,
}: MountedAppProps): React.ReactElement {
  return (
    <BureauProvider
      client={client}
      navigate={navigate}
      describeLocation={describeLocation}
      route={route}
    >
      {createPortal(
        <>
          {renderDockedBox ? <BureauDockedBox /> : null}
          <SummonHandler client={client} navigate={navigate} />
          <KnockHandler client={client} />
          <RingHandler client={client} navigate={navigate} />
        </>,
        portalContainer,
      )}
    </BureauProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// mountBureauClient — the §11 entrypoint.
// ─────────────────────────────────────────────────────────────────────────

interface PageMount {
  client: BureauWsClient;
  root: Root;
  container: HTMLElement;
  containerOwned: boolean;
  statusUnsub: (() => void) | null;
  setRoute: (route: unknown) => void;
  activeCall: ActiveCallManager;
}

let activeMount: PageMount | null = null;

export function mountBureauClient(opts: MountOptions): UnmountFn {
  if (typeof document === 'undefined') {
    throw new Error(
      '[bureau-client] mountBureauClient requires a DOM (called during SSR?)',
    );
  }
  // Replace any previous mount so the host can call this re-entrantly
  // (route-level remounts, hot-reload, …).
  if (activeMount) {
    try {
      teardown(activeMount);
    } catch {
      /* ignore */
    }
    activeMount = null;
  }

  const client = new BureauWsClient({ url: opts.wsUrl });
  // Boot the unified-call manager and register it as the singleton the
  // useActiveCall() hook reads from. Teardown happens in teardown(mount).
  const activeCall = new ActiveCallManager();
  setActiveCallManager(activeCall);

  let containerOwned = false;
  let container = opts.portalContainer;
  if (!container) {
    container = document.createElement('div');
    container.setAttribute('data-bureau-client-root', '');
    document.body.appendChild(container);
    containerOwned = true;
  }

  const root = createRoot(container);
  let currentRoute: unknown = opts.initialRoute;

  const render = () => {
    root.render(
      <MountedApp
        client={client}
        describeLocation={opts.describeLocation}
        navigate={opts.navigate}
        route={currentRoute}
        renderDockedBox={opts.renderDockedBox !== false}
        portalContainer={container as HTMLElement}
      />,
    );
  };
  render();

  const statusUnsub = opts.onStatusChange
    ? client.onStatus(opts.onStatusChange)
    : null;

  // Best-effort initial connect. We don't surface the rejection to the
  // host caller — the WS client will retry, and onStatusChange surfaces
  // the failure path. Hosts that want the connect promise can grab it
  // off `.client` themselves.
  void client.connect().catch(() => {
    /* WS reconnect logic owns retries; explicit catch silences unhandled rejection */
  });

  const mount: PageMount = {
    client,
    root,
    container: container as HTMLElement,
    containerOwned,
    statusUnsub,
    setRoute: (route: unknown) => {
      currentRoute = route;
      render();
    },
    activeCall,
  };
  activeMount = mount;

  const unmount = (() => {
    if (activeMount === mount) activeMount = null;
    teardown(mount);
  }) as UnmountFn;
  unmount.setRoute = mount.setRoute;
  unmount.client = client;
  return unmount;
}

function teardown(m: PageMount): void {
  try {
    m.statusUnsub?.();
  } catch {
    /* ignore */
  }
  // Disconnect the LiveKit room before tearing down React so listeners get
  // a coherent 'idle' snapshot during unmount. dispose() is async but we
  // don't await — teardown is invoked from synchronous unmount paths and
  // livekit-client's disconnect() is safe to fire-and-forget.
  try {
    if (getActiveCallManager() === m.activeCall) {
      setActiveCallManager(null);
    }
    void m.activeCall.dispose();
  } catch {
    /* ignore */
  }
  try {
    m.client.disconnect();
  } catch {
    /* ignore */
  }
  try {
    m.root.unmount();
  } catch {
    /* ignore */
  }
  if (m.containerOwned && m.container.parentNode) {
    try {
      m.container.parentNode.removeChild(m.container);
    } catch {
      /* ignore */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Lower-level exports for hosts that want to skip mountBureauClient.
// ─────────────────────────────────────────────────────────────────────────

export { BureauProvider };
export { SummonHandler } from './summon-handler.js';
export { KnockHandler } from './knock-handler.js';
export { RingHandler } from './ring-handler.js';
export type { BureauRoomSnapshot, BureauOccupant };
