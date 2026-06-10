#!/usr/bin/env node
/**
 * Bureau smoke test (Workstream 15, Piece 3).
 *
 * Walks through the day-one happy path of the Bureau stack against a
 * running compose deploy:
 *
 *   1. POST /b3/api/auth/login with seed credentials  → expects a session
 *      cookie back.
 *   2. GET  /bureau/api/v1/floors                     → expects 200 with
 *                                                       floors.length >= 1.
 *   3. GET  /bureau/api/v1/settings                   → expects 200 OK.
 *   4. WS   ws://HOST/bureau/ws                       → opens with the
 *      session cookie; sends `subscribe_floor`; expects a
 *      `presence_snapshot` frame back.
 *   5. WS   sends `enter_room`                        → expects a
 *      `room_enter` AND a `livekit_token` frame back.
 *
 * Exit 0 on success, 1 on any failure. The Bureau security-audit doc
 * embeds the captured output of one successful run for posterity.
 *
 * Configuration (env vars, all optional):
 *   BUREAU_SMOKE_HOST     base URL (default: http://localhost)
 *   BUREAU_SMOKE_EMAIL    seed email   (default: admin@example.com)
 *   BUREAU_SMOKE_PASSWORD seed pwd     (default: dev-password-change-me)
 *   BUREAU_SMOKE_TIMEOUT  per-step timeout ms (default: 10000)
 *
 * Wire into CI later by running this after `docker compose --profile seed
 * run --rm seed` completes.
 */

// `ws` is needed because Node's global WebSocket (undici-backed) does not
// accept an `headers` option at construction, which we need to forward the
// session cookie on the upgrade. We resolve it from apps/api's node_modules
// since pnpm does not hoist it to the repo root and we don't want this
// script to need a workspace install of its own.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { parse as parseUrl } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRequire = createRequire(resolvePath(__dirname, '../apps/api/package.json'));
const WebSocket = apiRequire('ws');

const HOST = process.env.BUREAU_SMOKE_HOST ?? 'https://localhost';
// The dev/CI nginx serves a self-signed cert; the dev convention (mirrored
// in apps/e2e) is to drop TLS verification for the smoke test only. Real
// CI / prod should not need this knob — point BUREAU_SMOKE_HOST at the
// trusted vhost instead.
if (!process.env.BUREAU_SMOKE_STRICT_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const EMAIL = process.env.BUREAU_SMOKE_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.BUREAU_SMOKE_PASSWORD ?? 'dev-password-change-me';
const STEP_TIMEOUT = Number(process.env.BUREAU_SMOKE_TIMEOUT ?? 10_000);

const wsUrl = (() => {
  const parsed = parseUrl(HOST);
  const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${parsed.host}/bureau/ws`;
})();

let stepNum = 0;
function step(label, msg) {
  stepNum += 1;
  console.log(`[${stepNum}] ${label}: ${msg}`);
}
function fail(label, err) {
  console.error(`[FAIL] ${label}: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ─── Step 1: Login ───────────────────────────────────────────────────

async function login() {
  const res = await withTimeout(
    fetch(`${HOST}/b3/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
    STEP_TIMEOUT,
    'login',
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`login failed ${res.status}: ${body}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login response had no Set-Cookie header');
  // Node's fetch concatenates multiple Set-Cookie headers into one comma-
  // delimited string. We can't safely split on `,` because attribute values
  // (e.g. `Expires=Wed, 09 Jun 2027 ...`) contain commas of their own. Use
  // a regex that anchors on `<name>=` at the start of a cookie attribute
  // segment and captures `<name>=<value>` up to the next `;` or `,`.
  // Cookies we care to forward: `session`, `csrf_token`, plus legacy names
  // for forward-compat (`bbb_session`, `bbb_csrf`, `connect.sid`).
  const pickNames = ['session', 'csrf_token', 'bbb_session', 'bbb_csrf', 'connect.sid'];
  const found = [];
  for (const name of pickNames) {
    const re = new RegExp(`(?:^|[,\\s])(${name}=[^;,]+)`);
    const m = setCookie.match(re);
    if (m) found.push(m[1].trim());
  }
  const cookie = found.join('; ');
  if (!cookie) {
    throw new Error(`could not extract a session cookie from set-cookie: ${setCookie}`);
  }
  step('login', `ok, cookie length=${cookie.length}, names=[${found.map((c) => c.split('=')[0]).join(',')}]`);
  return cookie;
}

// ─── Step 2 & 3: REST probes ─────────────────────────────────────────

async function getJson(path, cookie) {
  const res = await withTimeout(
    fetch(`${HOST}${path}`, { headers: { Cookie: cookie } }),
    STEP_TIMEOUT,
    `GET ${path}`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`GET ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Step 4 & 5: WebSocket ───────────────────────────────────────────

// Mutable shared state so on('message') handlers can see what `main()`
// resolved for the room before opening the socket.
const smokeContext = {
  firstRoomId: null,
};

async function runWebsocket(cookie, floorId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: cookie },
      rejectUnauthorized: process.env.BUREAU_SMOKE_STRICT_TLS === '1',
    });
    const seen = new Set();
    let resolved = false;
    let roomEnterSeen = false;
    let livekitTokenSeen = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`websocket dialog timed out; saw frames: [${[...seen].join(', ')}]`));
      }
    }, STEP_TIMEOUT);

    // Wait for the server's `connected` frame before sending subscribe_floor —
    // the bureau-api binds its message handler AFTER it emits `connected`,
    // and on a fast loopback the client can otherwise win the race and have
    // its first command dropped. Sending only after we observe `connected`
    // makes the script robust on both local docker and CI.
    let connectedSeen = false;
    ws.on('open', () => {
      step('ws open', 'connection established');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return reject(new Error(`malformed ws frame: ${raw.toString().slice(0, 120)}`));
      }
      const type = msg?.type;
      if (typeof type !== 'string') return;
      seen.add(type);
      if (process.env.BUREAU_SMOKE_VERBOSE === '1') {
        console.log(`    [ws<-] type=${type} data=${JSON.stringify(msg.data).slice(0, 200)}`);
      }

      if (type === 'connected' && !connectedSeen) {
        connectedSeen = true;
        step('ws connected', `received; sending subscribe_floor`);
        ws.send(JSON.stringify({ type: 'subscribe_floor', floorId }));
      }

      if (type === 'presence_snapshot') {
        step('ws presence_snapshot', `received for floor=${floorId}`);
        // We need a room ID to test enter_room. The snapshot tells us live
        // occupancy but not the static room roster — that comes from the
        // REST /floors/:id/rooms endpoint, which we hit synchronously
        // before the enter_room send. If the BUREAU_SMOKE_ROOM_ID env
        // override is set, use it directly (CI escape hatch).
        const override = process.env.BUREAU_SMOKE_ROOM_ID;
        if (override) {
          ws.send(JSON.stringify({ type: 'enter_room', roomId: override }));
        } else if (smokeContext.firstRoomId) {
          ws.send(
            JSON.stringify({ type: 'enter_room', roomId: smokeContext.firstRoomId }),
          );
        } else {
          // No room available — close cleanly so the test reports it.
          resolved = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(
            new Error(
              'no room available on the floor; seed at least one room or set BUREAU_SMOKE_ROOM_ID',
            ),
          );
        }
      }
      if (type === 'room_enter') {
        roomEnterSeen = true;
        step('ws room_enter', 'received');
      }
      if (type === 'livekit_token') {
        livekitTokenSeen = true;
        step('ws livekit_token', 'received');
      }
      if (roomEnterSeen && livekitTokenSeen && !resolved) {
        resolved = true;
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });

    ws.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });

    ws.on('close', (code, reason) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(
          new Error(
            `ws closed unexpectedly code=${code} reason=${reason?.toString?.() ?? ''}; ` +
              `saw frames: [${[...seen].join(', ')}]`,
          ),
        );
      }
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────

(async () => {
  let cookie;
  try {
    cookie = await login();
  } catch (e) {
    fail('login', e);
  }

  let floors;
  try {
    floors = await getJson('/bureau/api/v1/floors', cookie);
    const list = Array.isArray(floors) ? floors : floors?.floors ?? floors?.data ?? [];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`expected >= 1 floor; payload=${JSON.stringify(floors).slice(0, 200)}`);
    }
    step('GET /bureau/api/v1/floors', `200, floors.length=${list.length}`);
    floors = list;
  } catch (e) {
    fail('GET /bureau/api/v1/floors', e);
  }

  try {
    await getJson('/bureau/api/v1/settings', cookie);
    step('GET /bureau/api/v1/settings', '200');
  } catch (e) {
    fail('GET /bureau/api/v1/settings', e);
  }

  const floorId = floors[0].id ?? floors[0].floor_id;
  if (!floorId) {
    fail('floor selection', new Error(`first floor has no id: ${JSON.stringify(floors[0])}`));
  }

  // Step 3.5: floor detail response embeds the rooms array; use it to get
  // a real room id for the enter_room WS leg.
  try {
    const detail = await getJson(`/bureau/api/v1/floors/${floorId}`, cookie);
    const list =
      detail?.data?.rooms ??
      detail?.rooms ??
      (Array.isArray(detail) ? detail : []);
    if (Array.isArray(list) && list.length > 0) {
      smokeContext.firstRoomId = list[0].id ?? list[0].room_id;
      step(
        'GET /floors/:id',
        `200, rooms.length=${list.length}, first=${smokeContext.firstRoomId}`,
      );
    } else {
      step(
        'GET /floors/:id',
        '200, rooms.length=0 (set BUREAU_SMOKE_ROOM_ID to override)',
      );
    }
  } catch (e) {
    fail('GET /floors/:id', e);
  }

  try {
    await runWebsocket(cookie, floorId);
  } catch (e) {
    fail('websocket', e);
  }

  console.log('\nbureau smoke test: ALL CHECKS PASSED');
  process.exit(0);
})();
