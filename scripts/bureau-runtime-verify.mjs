#!/usr/bin/env node
/**
 * Bureau runtime verification harness (troubleshooting pass, 2026-06-10).
 *
 * Protocol-level automation of the runtime checklist in
 * docs/plans/bureau-troubleshooting-notes.md. Exercises, against a running
 * compose stack:
 *
 *   1. Ring end-to-end (ring_incoming frame + ring_respond -> ring_responded)
 *   2. Cross-org ring -> 404
 *   3. Locked-door enforcement (WS enter_room FORBIDDEN + token mint 403,
 *      unlock restores entry)
 *   4. Knock-privacy room cross-app can-join-room (continuous audio)
 *   5. WS pre-init frame buffering (location_update sent on socket open,
 *      before `connected`, must register -> presence/here sees it)
 *   6. Concurrent summon responses both persist (JSONB row check)
 *   7. DND knock 423 advertises /v1/knocks/leave-note and the endpoint works
 *
 * Requires the bureau-test-* users (see the test-fixture SQL in the
 * troubleshooting notes) and the three test-zone rooms.
 *
 * Env:
 *   HOST                base URL (default http://localhost)
 *   TEST_PASSWORD       password for bureau-test-* users
 *   INTERNAL_SECRET     INTERNAL_SERVICE_SECRET for the can-join-room check
 *                       (skips test 4 when unset)
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRequire = createRequire(resolvePath(__dirname, '../apps/api/package.json'));
const WebSocket = apiRequire('ws');

const HOST = process.env.HOST ?? 'http://localhost';
const WS_HOST = HOST.replace(/^http/, 'ws');
const PASSWORD = process.env.TEST_PASSWORD ?? 'BureauTest-2026!';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? '';

const USERS = {
  a: 'bureau-test-a@example.com',
  b: 'bureau-test-b@example.com',
  c: 'bureau-test-c@example.com',
  dnd: 'bureau-test-dnd@example.com',
  x: 'bureau-test-x@example.com', // other org
};

const FLOOR_ID = 'a0000000-0000-4000-8000-bbb00000f100';
const ROOM_LOCK = 'b0000000-0000-4000-8000-bbb000000002';
const ROOM_KNOCK = 'b0000000-0000-4000-8000-bbb000000003';
const ROOM_DND_OFFICE = 'b0000000-0000-4000-8000-bbb000000001';

const results = [];
function pass(name, evidence) {
  results.push({ name, ok: true, evidence });
  console.log(`  PASS  ${name}${evidence ? ` — ${evidence}` : ''}`);
}
function failTest(name, evidence) {
  results.push({ name, ok: false, evidence });
  console.log(`  FAIL  ${name}${evidence ? ` — ${evidence}` : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── HTTP helpers ─────────────────────────────────────────────────────

async function login(email) {
  const res = await fetch(`${HOST}/b3/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}: ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/(?:^|[,\s])(session=[^;,]+)/);
  if (!m) throw new Error(`no session cookie for ${email}: ${setCookie}`);
  const body = await res.json();
  return { cookie: m[1], userId: body?.data?.user?.id ?? body?.user?.id ?? null, email };
}

async function api(method, path, session, body) {
  // POST/PATCH always carry a JSON body — even an empty {} — because the
  // shared Fastify content-type parser 400s (and historically crashed) on a
  // declared application/json with a zero-length body.
  const sendBody = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {});
  const res = await fetch(`${HOST}/bureau/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
    },
    body: sendBody,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

// ── WS helper ────────────────────────────────────────────────────────

class WsClient {
  constructor(session, label, { sendOnOpen = [] } = {}) {
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.closed = false;
    this.ws = new WebSocket(`${WS_HOST}/bureau/ws`, {
      headers: { Cookie: session.cookie },
    });
    this.ws.on('open', () => {
      for (const f of sendOnOpen) this.ws.send(JSON.stringify(f));
    });
    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.frames.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
    this.ws.on('error', () => {
      this.closed = true;
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** Resolve with the first frame (past or future) matching pred. */
  waitFor(pred, timeoutMs = 8000, desc = 'frame') {
    const past = this.frames.find(pred);
    if (past) return Promise.resolve(past);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(
          this.waiters.findIndex((w) => w.timer === timer),
          1,
        );
        reject(
          new Error(
            `[${this.label}] timed out waiting for ${desc}; saw: ${this.frames
              .map((f) => f.type)
              .join(',')}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  destroy() {
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
  }
}

function openWs(session, label, opts) {
  const c = new WsClient(session, label, opts);
  return c
    .waitFor((f) => f.type === 'connected', 8000, 'connected')
    .then(() => c);
}

// ── Tests ────────────────────────────────────────────────────────────

async function testRingEndToEnd(sessA, sessB) {
  console.log('\n[1] Ring end-to-end');
  const wsA = await openWs(sessA, 'A');
  const wsB = await openWs(sessB, 'B');
  try {
    const ringRes = await api('POST', '/v1/ring', sessA, {
      to_user_id: sessB.userId,
      surface_app: 'brief',
      surface_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      surface_label: 'Runtime verify doc',
    });
    if (ringRes.status !== 200) {
      failTest('ring POST 200', `status=${ringRes.status} body=${JSON.stringify(ringRes.json)}`);
      return;
    }
    const ringToken = ringRes.json?.data?.ring_token;
    pass('ring POST 200', `ring_token=${ringToken} delivered=${ringRes.json?.data?.delivered}`);

    const incoming = await wsB.waitFor(
      (f) => f.type === 'ring_incoming' && f.data?.ring_token === ringToken,
      8000,
      'ring_incoming on B',
    );
    pass(
      'B receives ring_incoming frame',
      `from=${incoming.data.from_user_name} surface=${incoming.data.surface_app}/${incoming.data.surface_id}`,
    );

    wsB.send({ type: 'ring_respond', ring_token: ringToken, decision: 'accept' });
    const responded = await wsA.waitFor(
      (f) => f.type === 'ring_responded' && f.data?.ring_token === ringToken,
      8000,
      'ring_responded on A',
    );
    pass('A receives ring_responded', `decision=${responded.data.decision} by=${responded.data.by?.name}`);

    // ring_respond must NOT bounce as UNKNOWN_TYPE on B.
    await sleep(500);
    const unknown = wsB.frames.find(
      (f) => f.type === 'error' && f.data?.code === 'UNKNOWN_TYPE',
    );
    if (unknown) failTest('no UNKNOWN_TYPE for ring_respond', JSON.stringify(unknown.data));
    else pass('no UNKNOWN_TYPE for ring_respond');
  } finally {
    wsA.close();
    wsB.close();
  }
}

async function testCrossOrgRing(sessX, sessA) {
  console.log('\n[2] Cross-org ring scoping');
  const res = await api('POST', '/v1/ring', sessX, {
    to_user_id: sessA.userId,
    surface_app: 'brief',
    surface_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  if (res.status === 404) {
    pass('cross-org ring -> 404', res.json?.error?.message);
  } else {
    failTest('cross-org ring -> 404', `status=${res.status} body=${JSON.stringify(res.json)}`);
  }
}

async function testLockedDoor(sessB, sessC) {
  console.log('\n[3] Locked-door enforcement');
  // The lock room starts open; a prior aborted run could leave a stale
  // `private` override in Redis. Unlock it first via an owner-class path:
  // we can't from here (B is a plain member), so the harness relies on the
  // operator having cleared bureau:room:<id>:state. If B's first enter is
  // FORBIDDEN we surface that explicitly rather than hanging.
  const wsB = await openWs(sessB, 'B');
  const wsC = await openWs(sessC, 'C');
  try {
    wsB.send({ type: 'subscribe_floor', floorId: FLOOR_ID });
    await wsB.waitFor((f) => f.type === 'presence_snapshot', 8000, 'snapshot B');
    wsB.send({ type: 'enter_room', roomId: ROOM_LOCK });
    await wsB.waitFor(
      (f) => f.type === 'room_enter' && f.data?.roomId === ROOM_LOCK,
      8000,
      'B room_enter',
    );

    // B locks the room (member inside a shared room may lock per §8).
    wsB.send({ type: 'lock_room', roomId: ROOM_LOCK, locked: true });
    await wsB.waitFor(
      (f) => f.type === 'room_locked' && f.data?.roomId === ROOM_LOCK && f.data?.locked === true,
      8000,
      'room_locked',
    );
    pass('B locked the room (room_locked frame)');

    // C (plain member, no ACL) must be refused on WS enter.
    wsC.send({ type: 'subscribe_floor', floorId: FLOOR_ID });
    await wsC.waitFor((f) => f.type === 'presence_snapshot', 8000, 'snapshot C');
    const before = wsC.frames.length;
    wsC.send({ type: 'enter_room', roomId: ROOM_LOCK });
    const denial = await wsC.waitFor(
      (f, i) => f.type === 'error' && f.data?.code === 'FORBIDDEN',
      8000,
      'FORBIDDEN on C enter',
    );
    pass('C enter_room rejected while locked', denial.data.message);
    const sneakEnter = wsC.frames
      .slice(before)
      .find((f) => f.type === 'livekit_token');
    if (sneakEnter) failTest('C got no livekit_token while locked', 'token frame seen');
    else pass('C got no livekit_token while locked');

    // REST token mint must 403 (or 503 if calling kill switch is off).
    const mint = await api('POST', `/v1/rooms/${ROOM_LOCK}/token`, sessC);
    if (mint.status === 403) pass('C REST token mint -> 403 while locked', mint.json?.error?.message);
    else if (mint.status === 503 && mint.json?.error?.code === 'CALLING_DISABLED')
      failTest('C REST token mint -> 403 while locked', 'calling disabled platform-wide; cannot verify mint path');
    else failTest('C REST token mint -> 403 while locked', `status=${mint.status} ${JSON.stringify(mint.json)}`);

    // Internal can-join-room must also deny while locked.
    if (INTERNAL_SECRET) {
      const cj = await fetch(
        `${HOST}/bureau/api/v1/internal/can-join-room/${ROOM_LOCK}/${sessC.userId}`,
        { headers: { 'X-Internal-Service-Secret': INTERNAL_SECRET } },
      );
      const cjJson = await cj.json().catch(() => null);
      if (cj.status === 200 && cjJson?.data?.allowed === false)
        pass('internal can-join-room denies while locked', `reason=${cjJson.data.reason}`);
      else failTest('internal can-join-room denies while locked', `status=${cj.status} ${JSON.stringify(cjJson)}`);
    }

    // Unlock -> C can enter.
    wsB.send({ type: 'lock_room', roomId: ROOM_LOCK, locked: false });
    await wsB.waitFor(
      (f) => f.type === 'room_locked' && f.data?.locked === false,
      8000,
      'room_unlocked',
    );
    await sleep(300);
    wsC.send({ type: 'enter_room', roomId: ROOM_LOCK });
    await wsC.waitFor(
      (f) => f.type === 'room_enter' && f.data?.roomId === ROOM_LOCK && f.data?.userId === sessC.userId,
      8000,
      'C room_enter after unlock',
    );
    pass('C enters after unlock');

    const mint2 = await api('POST', `/v1/rooms/${ROOM_LOCK}/token`, sessC);
    if (mint2.status === 200) pass('C REST token mint works after unlock');
    else if (mint2.status === 503 && mint2.json?.error?.code === 'CALLING_DISABLED')
      pass('C REST token mint after unlock: calling disabled (kill switch), auth gate not reached');
    else failTest('C REST token mint works after unlock', `status=${mint2.status}`);

    // Leave rooms to keep presence clean.
    wsB.send({ type: 'leave_room' });
    wsC.send({ type: 'leave_room' });
    await sleep(300);
  } finally {
    wsB.close();
    wsC.close();
  }
}

async function testKnockRoomContinuousAudio(sessB) {
  console.log('\n[4] Knock-privacy room cross-app can-join-room');
  if (!INTERNAL_SECRET) {
    failTest('knock-room can-join-room', 'INTERNAL_SECRET not provided; skipped');
    return;
  }
  // ROOM_KNOCK has privacy_default=open; flip the live door to knock the same
  // way the UI would (set_door requires manager/admin, so we emulate the
  // override through the DB-default instead: the fixture room
  // ROOM_DND_OFFICE has privacy_default='knock' but is an office. Use the
  // door-state hash via a member set_door? Members can't. So: this test
  // relies on the fixture Test Knock Room having been flipped to
  // privacy_default='knock' in the DB before this script runs.)
  const cj = await fetch(
    `${HOST}/bureau/api/v1/internal/can-join-room/${ROOM_KNOCK}/${sessB.userId}`,
    { headers: { 'X-Internal-Service-Secret': INTERNAL_SECRET } },
  );
  const cjJson = await cj.json().catch(() => null);
  if (cj.status === 200 && cjJson?.data?.allowed === true) {
    pass('knock-privacy room: can-join-room allows org member', JSON.stringify(cjJson.data));
  } else {
    failTest('knock-privacy room: can-join-room allows org member', `status=${cj.status} ${JSON.stringify(cjJson)}`);
  }
}

async function testPreInitFrames(sessA, sessB) {
  console.log('\n[5] WS pre-init frame buffering (first location_update registers)');
  const url = `/brief/d/runtime-verify-${Date.now()}`;
  // Send location_update IMMEDIATELY on socket open — before the server's
  // `connected` frame. Pre-fix, this frame was silently dropped.
  const wsA = new WsClient(sessA, 'A-preinit', {
    sendOnOpen: [{ type: 'location_update', url, app: 'brief', label: 'preinit test' }],
  });
  try {
    await wsA.waitFor((f) => f.type === 'connected', 8000, 'connected');
    await sleep(700); // allow replay + redis write
    const here = await api('GET', `/v1/presence/here?url=${encodeURIComponent(url)}`, sessB);
    const hit = here.json?.data?.find((u) => u.user_id === sessA.userId);
    if (here.status === 200 && hit) {
      pass('pre-init location_update registered', `presence/here sees ${hit.display_name}`);
    } else {
      failTest('pre-init location_update registered', `status=${here.status} data=${JSON.stringify(here.json?.data)}`);
    }
  } finally {
    wsA.close();
  }
}

async function testConcurrentSummon(sessA, sessB, sessC) {
  console.log('\n[6] Concurrent summon responses');
  const wsA = await openWs(sessA, 'A');
  const wsB = await openWs(sessB, 'B');
  const wsC = await openWs(sessC, 'C');
  try {
    for (const [ws] of [[wsA], [wsB], [wsC]]) {
      ws.send({ type: 'subscribe_floor', floorId: FLOOR_ID });
      await ws.waitFor((f) => f.type === 'presence_snapshot', 8000, 'snapshot');
      ws.send({ type: 'enter_room', roomId: ROOM_LOCK });
      await ws.waitFor(
        (f) => f.type === 'room_enter',
        8000,
        'room_enter',
      );
    }
    await sleep(300);

    // A summons everyone to an "unknown app" surface (no preflight denial).
    const res = await api('POST', '/v1/summon', sessA, {
      target_url: '/beacon/e/runtime-verify',
      target_app: 'beacon',
      target_label: 'Runtime verify',
    });
    if (res.status !== 201) {
      failTest('summon created', `status=${res.status} ${JSON.stringify(res.json)}`);
      return;
    }
    const summonId = res.json.data.summon_id;
    pass('summon created', `id=${summonId} eligible=${res.json.data.eligible_count}`);

    const incB = await wsB.waitFor(
      (f) => f.type === 'summon_incoming' && f.data?.summonId === summonId,
      8000,
      'summon_incoming B',
    );
    const incC = await wsC.waitFor(
      (f) => f.type === 'summon_incoming' && f.data?.summonId === summonId,
      8000,
      'summon_incoming C',
    );
    void incB;
    void incC;
    pass('both recipients received summon_incoming');

    // Respond join at the same instant.
    wsB.send({ type: 'summon_respond', summonId, decision: 'join' });
    wsC.send({ type: 'summon_respond', summonId, decision: 'join' });

    await wsB.waitFor((f) => f.type === 'summon_ack' && f.data?.summonId === summonId, 8000, 'ack B');
    await wsC.waitFor((f) => f.type === 'summon_ack' && f.data?.summonId === summonId, 8000, 'ack C');

    await sleep(500);
    const row = await api('GET', `/v1/summons/${summonId}`, sessA);
    const recips = row.json?.data?.recipients ?? [];
    const bOut = recips.find((r) => r.userId === sessB.userId)?.outcome;
    const cOut = recips.find((r) => r.userId === sessC.userId)?.outcome;
    if (bOut === 'joined' && cOut === 'joined') {
      pass('both concurrent responses persisted', `B=${bOut} C=${cOut}`);
    } else {
      failTest('both concurrent responses persisted', `B=${bOut} C=${cOut} recipients=${JSON.stringify(recips)}`);
    }

    // summoner should have seen summon_progress with joined=2
    const prog = wsA.frames.filter((f) => f.type === 'summon_progress' && f.data?.summonId === summonId);
    const maxJoined = Math.max(0, ...prog.map((f) => f.data.joined));
    if (maxJoined === 2) pass('summoner saw summon_progress joined=2');
    else failTest('summoner saw summon_progress joined=2', `max joined seen=${maxJoined}`);

    for (const ws of [wsA, wsB, wsC]) ws.send({ type: 'leave_room' });
    await sleep(300);
  } finally {
    wsA.close();
    wsB.close();
    wsC.close();
  }
}

async function testDndKnock(sessDnd, sessB) {
  console.log('\n[7] DND knock 423 + leave-note');
  const wsDnd = await openWs(sessDnd, 'DND');
  try {
    wsDnd.send({ type: 'set_status', status: 'dnd' });
    await sleep(500);

    const knock = await api('POST', '/v1/knocks', sessB, {
      room_id: ROOM_DND_OFFICE,
      message: 'runtime verify knock',
    });
    if (knock.status === 423 && knock.json?.error?.leave_a_note_endpoint === '/v1/knocks/leave-note') {
      pass('knock on DND office -> 423 with correct leave-note endpoint');
    } else {
      failTest(
        'knock on DND office -> 423 with correct leave-note endpoint',
        `status=${knock.status} body=${JSON.stringify(knock.json)}`,
      );
    }

    const note = await api('POST', '/v1/knocks/leave-note', sessB, {
      room_id: ROOM_DND_OFFICE,
      message: 'runtime verify leave-note',
    });
    if (note.status === 200 && note.json?.data?.delivered === true) {
      pass('leave-note delivered (Banter DM)', JSON.stringify(note.json.data));
    } else if (note.status === 202) {
      failTest('leave-note delivered (Banter DM)', `202 delivered=false — banter DM not delivered: ${JSON.stringify(note.json)}`);
    } else {
      failTest('leave-note delivered (Banter DM)', `status=${note.status} ${JSON.stringify(note.json)}`);
    }

    wsDnd.send({ type: 'set_status', status: 'available' });
    await sleep(200);
  } finally {
    wsDnd.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────

(async () => {
  console.log(`Bureau runtime verification against ${HOST}`);
  const sessA = await login(USERS.a);
  const sessB = await login(USERS.b);
  const sessC = await login(USERS.c);
  const sessDnd = await login(USERS.dnd);
  const sessX = await login(USERS.x);

  // /b3/api login may not return the user id in the body; resolve via /users/me.
  for (const s of [sessA, sessB, sessC, sessDnd, sessX]) {
    if (!s.userId) {
      const me = await fetch(`${HOST}/b3/api/users/me`, { headers: { Cookie: s.cookie } });
      const j = await me.json().catch(() => null);
      s.userId = j?.data?.id ?? j?.id ?? null;
    }
    if (!s.userId) throw new Error(`could not resolve user id for ${s.email}`);
  }

  await testRingEndToEnd(sessA, sessB);
  await testCrossOrgRing(sessX, sessA);
  await testLockedDoor(sessB, sessC);
  await testKnockRoomContinuousAudio(sessB);
  await testPreInitFrames(sessA, sessB);
  await testConcurrentSummon(sessA, sessB, sessC);
  await testDndKnock(sessDnd, sessB);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.evidence}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
