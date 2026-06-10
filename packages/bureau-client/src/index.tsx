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
import { PipPortal, PopoutBureauButton, usePipMode } from './pip-host.js';

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
export type {
  OpenPipWindowOptions,
  PopoutBureauButtonProps,
} from './pip-host.js';

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
      return;
    }
    const prev = lastLocationRef.current;
    if (
      prev &&
      prev.url === descriptor.url &&
      prev.app === descriptor.app &&
      prev.label === descriptor.label &&
      prev.livekitRoom === descriptor.livekitRoom
    ) {
      return;
    }
    lastLocationRef.current = descriptor;
    setState((s) => ({ ...s, location: descriptor ?? null }));
    client.send({
      type: 'location_update',
      url: descriptor.url,
      app: descriptor.app,
      label: descriptor.label,
    });
  }, [client, describeLocation, route]);

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

const summonBtnDisabledStyle: CSSProperties = {
  ...summonBtnStyle,
  background: 'rgba(37, 99, 235, 0.35)',
  cursor: 'not-allowed',
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

/**
 * Internal: the actual floating-box markup. Always renders the same UI
 * regardless of whether it lives in the host page or in the PiP window;
 * the only difference is the parent DOM, which createPortal handles.
 */
function BureauDockedBoxInner(): React.ReactElement | null {
  const ctx = useContext(BureauContext);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  if (!ctx) return null;
  const { state, actions } = ctx;

  const inRoom = !!state.roomId;
  const canSummon = inRoom && !!state.location;

  return (
    <div style={boxContainerStyle} data-bureau-docked-box role="region">
      <div style={boxHeaderStyle}>
        <span>
          <span style={statusDotStyle(state.status)} />
          Bureau
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ opacity: 0.6 }}>
            {state.status === 'connected' ? '' : state.status}
          </span>
          <PopoutBureauButton />
        </span>
      </div>

      {/* "In:" row */}
      <div>
        <span style={{ opacity: 0.7 }}>In:</span>{' '}
        <strong>{inRoom ? state.roomId : 'No room'}</strong>
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

      {/* Viewing + summon */}
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
      <button
        type="button"
        disabled={!canSummon}
        style={canSummon ? summonBtnStyle : summonBtnDisabledStyle}
        onClick={() => actions.summonHere()}
        title={
          canSummon
            ? 'Pull everyone in this room to the resource you are viewing'
            : inRoom
              ? 'Nothing to summon — pick a teleportable resource first'
              : 'Enter a room to summon people'
        }
      >
        Bring everyone here
      </button>

      {/* Controls row */}
      <div style={controlsRowStyle}>
        <button
          type="button"
          style={controlBtnStyle}
          onClick={() => setMicOn((v) => !v)}
          title="Toggle microphone (LiveKit wire-up in workstream 13)"
        >
          {micOn ? 'mic on' : 'mic'}
        </button>
        <button
          type="button"
          style={controlBtnStyle}
          onClick={() => setCamOn((v) => !v)}
          title="Toggle camera (LiveKit wire-up in workstream 13)"
        >
          {camOn ? 'cam on' : 'cam'}
        </button>
        <button
          type="button"
          style={controlBtnStyle}
          onClick={() => setScreenOn((v) => !v)}
          title="Toggle screen-share (LiveKit wire-up in workstream 13)"
        >
          {screenOn ? 'share' : 'screen'}
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
    </div>
  );
}

/**
 * Placeholder shown in the host page while the real docked box lives in the
 * Document PiP window. Clicking "Return" closes the PiP window and brings
 * the box back inline.
 */
function BureauPipPlaceholder(): React.ReactElement {
  return (
    <div
      style={placeholderContainerStyle}
      data-bureau-pip-placeholder
      role="status"
      aria-live="polite"
    >
      <span style={{ opacity: 0.85 }}>Bureau is open in a separate window</span>
      <PopoutBureauButton style={placeholderRestoreBtnStyle} title="Return Bureau to the page" />
    </div>
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
          <BureauDockedBoxInner />
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
export type { BureauRoomSnapshot, BureauOccupant };
