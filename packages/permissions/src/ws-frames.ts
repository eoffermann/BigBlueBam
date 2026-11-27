// Per-message authorization for WebSocket hubs (issue #177).
//
// Issue #166 gated every Bureau WebSocket frame type with the catalog action
// of its REST twin. Every other app socket still authorized only at connect
// time, so a frame could do what its REST twin forbids. This module is the one
// helper every hub now uses:
//
//   - Each hub declares ONE map from client-to-server frame type to the
//     catalog ids of the frame's REST twin (WS_FRAME_PERMISSIONS in the hub's
//     ws-frames module). scripts/check-permission-catalog.mjs fails CI when a
//     frame the handler accepts is missing from the map, a mapped id is not in
//     the catalog, or the handler stops calling the gate.
//   - An id is enforced the way requireCan enforces it: 'off' and 'warn'
//     allow, 'on' allows only what the resolver allows.
//   - An id written 'shadow:<id>' mirrors a REST twin gated by shadowOnly(): the
//     resolver is asked (so divergence telemetry still flows) but the answer
//     never blocks the frame. The hub's own resource check (board edit access,
//     channel membership, diagram ACL) stays the gate, exactly as on REST.
//   - An empty list means the REST twin has no catalog gate (only the resource
//     check, which the hub runs itself), or the frame only ends or leaves
//     something the caller started, or is a keepalive.
//   - A frame type the map does not name is refused (UNKNOWN_FRAME): adding a
//     frame without declaring its permissions fails closed at runtime as well
//     as in CI.

export type WsFrameMap = Readonly<Record<string, readonly string[]>>;

export interface WsCaller {
  user_id: string;
  org_id: string | null;
}

export interface WsLogger {
  warn: (obj: object, msg: string) => void;
}

/** A boolean probe with requireCan's mode semantics (createHttpPermissionChecker, or an in-process twin). */
export type WsPermissionCheck = (caller: WsCaller, permissionId: string, logger?: WsLogger) => Promise<boolean>;

export type WsFrameDenial =
  | { code: 'PERMISSION_DENIED'; frame_type: string; permission_id: string; message: string }
  | { code: 'UNKNOWN_FRAME'; frame_type: string; message: string };

export const WS_SHADOW_PREFIX = 'shadow:';

/** The catalog id behind a map entry, with any shadow: prefix removed. */
export function wsFramePermissionId(entry: string): string {
  return entry.startsWith(WS_SHADOW_PREFIX) ? entry.slice(WS_SHADOW_PREFIX.length) : entry;
}

export interface WsFrameGateOptions {
  /**
   * How long an allow is reused per (user, org, id). A chatty frame (cursor,
   * typing, presence) must not ask the resolver on every frame, and in 'warn'
   * mode the HTTP checker itself does not cache. Denials are never cached here.
   * Default 30s, the HTTP checker's own TTL.
   */
  allowTtlMs?: number;
  /** Most allows remembered; past it the least recently used is evicted. Default 5000. */
  maxEntries?: number;
  /** Test seam for the cache clock. */
  now?: () => number;
}

export interface WsFrameGate {
  readonly frames: WsFrameMap;
  /** Null when the frame may run, else why it may not. */
  check(frameType: unknown, caller: WsCaller, logger?: WsLogger): Promise<WsFrameDenial | null>;
  /** Swap the resolver probe (tests). Clears the allow cache. */
  setCheckerForTests(fn: WsPermissionCheck): void;
}

export function createWsFrameGate(
  frames: WsFrameMap,
  checker: WsPermissionCheck,
  opts: WsFrameGateOptions = {},
): WsFrameGate {
  const ttl = opts.allowTtlMs ?? 30_000;
  const maxEntries = Math.max(1, opts.maxEntries ?? 5000);
  const now = opts.now ?? Date.now;
  const allows = new Map<string, number>();
  let probe = checker;

  function cachedAllow(key: string): boolean {
    const exp = allows.get(key);
    if (exp === undefined) return false;
    allows.delete(key);
    if (exp <= now()) return false;
    allows.set(key, exp);
    return true;
  }

  function rememberAllow(key: string): void {
    allows.delete(key);
    allows.set(key, now() + ttl);
    while (allows.size > maxEntries) {
      const oldest = allows.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      allows.delete(oldest);
    }
  }

  async function allowed(caller: WsCaller, id: string, logger?: WsLogger): Promise<boolean> {
    const key = `${caller.user_id}|${caller.org_id ?? ''}|${id}`;
    if (cachedAllow(key)) return true;
    let ok = false;
    try {
      ok = await probe(caller, id, logger);
    } catch (err) {
      logger?.warn({ err, permission_id: id }, 'ws frame gate: permission probe threw; treating as deny');
      ok = false;
    }
    if (ok) rememberAllow(key);
    return ok;
  }

  return {
    frames,
    async check(frameType, caller, logger) {
      if (typeof frameType !== 'string' || !Object.prototype.hasOwnProperty.call(frames, frameType)) {
        const t = typeof frameType === 'string' ? frameType : String(frameType);
        return { code: 'UNKNOWN_FRAME', frame_type: t, message: `Unknown frame type: ${t}` };
      }
      for (const entry of frames[frameType] ?? []) {
        const id = wsFramePermissionId(entry);
        if (entry.startsWith(WS_SHADOW_PREFIX)) {
          // Telemetry only, like shadowOnly() on the REST twin: never blocks.
          if (!(await allowed(caller, id, logger))) {
            logger?.warn({ permission_id: id, frame_type: frameType }, 'ws frame gate: resolver would deny (shadow, not enforced)');
          }
          continue;
        }
        if (!(await allowed(caller, id, logger))) {
          return {
            code: 'PERMISSION_DENIED',
            frame_type: frameType,
            permission_id: id,
            message: `Permission denied: ${id}`,
          };
        }
      }
      return null;
    },
    setCheckerForTests(fn) {
      probe = fn;
      allows.clear();
    },
  };
}

// ─── Yjs (y-websocket) frames ──────────────────────────────────────────
//
// The Beacon and Brief co-editing sockets speak the binary y-websocket protocol,
// not JSON. These are its client-to-server frame types in the vocabulary the
// gate and the catalog check use: a sync step 1 asks for state (a read); a sync
// step 2 or update changes the shared document (a write); awareness is
// cursor/presence.

export const YJS_FRAME_TYPES = ['sync_step1', 'sync_update', 'awareness'] as const;
export type YjsFrameType = (typeof YJS_FRAME_TYPES)[number];

function readVarUint(bytes: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = at; i < bytes.length && shift < 35; i++) {
    const b = bytes[i] ?? 0;
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return { value, next: i + 1 };
    shift += 7;
  }
  return null;
}

/**
 * The frame type of one y-websocket message: 'sync_step1', 'sync_update' (sync
 * step 2 or update), 'awareness', or the raw 'yjs_<n>' for anything else
 * (which no map names, so the gate refuses it).
 */
export function classifyYjsFrame(bytes: Uint8Array): string {
  const top = readVarUint(bytes, 0);
  if (!top) return 'yjs_malformed';
  if (top.value === 1) return 'awareness';
  if (top.value !== 0) return `yjs_${top.value}`;
  const sub = readVarUint(bytes, top.next);
  if (!sub) return 'yjs_malformed';
  if (sub.value === 0) return 'sync_step1';
  if (sub.value === 1 || sub.value === 2) return 'sync_update';
  return `yjs_sync_${sub.value}`;
}
