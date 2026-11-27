import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import argon2 from 'argon2';
import { BASTION_ROOM_PASSCODE_MAX_FAILURES, BASTION_ROOM_REQUESTS_PER_HOUR, BASTION_ROOM_TOKEN_MISSES } from '@bigbluebam/shared';
import type { EngineDeps } from '../../src/engine/context.js';
import { verifyCommitments } from '../../src/engine/commitments.js';
import { mirrorObjects, objectSweep, restoreObjectsFromBackup, SWEEP_INTENT_AGE_MS } from '../../src/engine/objects.js';
import { storeBuffer } from '../../src/engine/evidence-store.js';
import { sha256Hex } from '../../src/lib/ledger-canonical.js';
import { DATABASE_URL, fakeBucket, type FakeBucket, makeDeps, seedOrg, type SeededOrg, wipeOrg } from './engine-harness.js';

/**
 * M9 gates against a real migrated database and the real engine and service code (spec 5.2, 7.2,
 * 9.7, 11.2):
 *
 *   the auditor room's token gate: only the SHA-256 is stored; a wrong token, a revoked, expired
 *   or locked room, and a creator who lost the permission are one 404; unknown-token misses lock
 *   the address out; 5 wrong passcodes lock the room and tell its creator; reads never leave the
 *   room's controls, period and restricted allowlist; every view is logged; 20 questions an hour;
 *   packet commitments: intact, pd_mismatch, key_changed, redacted and no_personal_data, through
 *   the verify-commitments engine; the packet claim refuses an ISO packet with an unfinished SoA
 *   and fences progress and finish on the claimant; the reaper fails a stalled packet;
 *   sweep intents: an orphan's bytes and intent go, a landed object's intent is cleared, redacted
 *   bytes are deleted, a young intent and an org with an open restore are left alone, and a
 *   writer that reuses a key refreshes its intent so the sweep cannot delete it;
 *   the off-site mirror: copies unmirrored objects and seals, records completed on the backup's
 *   mirror columns; a failing destination records failed and the backup stays completed; the
 *   restore CLI copies the mirror back, skipping what is already there.
 *
 * Run against a throwaway database (it inserts platform_backups rows, which are platform-wide).
 * SKIPS LOUDLY without DATABASE_URL.
 */

if (!DATABASE_URL) {
  console.warn('[bastion-api/m9-sharing] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');
}

const HOUR = 3_600_000;

type Sharing = typeof import('../../src/services/sharing.service.js');
type Room = typeof import('../../src/services/room.service.js');
type Packet = typeof import('../../src/services/packet.service.js');

function memoryCounters() {
  const m = new Map<string, number>();
  return {
    m,
    incr: async (k: string) => {
      const n = (m.get(k) ?? 0) + 1;
      m.set(k, n);
      return n;
    },
    get: async (k: string) => m.get(k) ?? 0,
    set: async (k: string) => {
      m.set(k, 1);
    },
  };
}

describe.skipIf(!DATABASE_URL)('M9 sharing, packets, sweep and mirror (live database)', () => {
  let sql: postgres.Sql;
  let sharing: Sharing;
  let room: Room;
  let packet: Packet;
  const orgs: string[] = [];
  const backups: string[] = [];

  beforeAll(async () => {
    // env.ts validates at import (the services reach it through db/index.ts); give it what it insists on.
    const hex = 'a'.repeat(64);
    Object.assign(process.env, {
      SESSION_SECRET: process.env.SESSION_SECRET ?? 's'.repeat(40),
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? 'i'.repeat(40),
      BASTION_SEAL_SIGNING_KEY: process.env.BASTION_SEAL_SIGNING_KEY ?? hex,
      BASTION_PD_HMAC_KEY: process.env.BASTION_PD_HMAC_KEY ?? hex,
      BASTION_ROOM_IP_SALT: process.env.BASTION_ROOM_IP_SALT ?? hex,
      BASTION_FEED_KEY_PEPPER: process.env.BASTION_FEED_KEY_PEPPER ?? hex,
    });
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    sharing = await import('../../src/services/sharing.service.js');
    room = await import('../../src/services/room.service.js');
    packet = await import('../../src/services/packet.service.js');
  });

  afterAll(async () => {
    for (const org of orgs) await wipeOrg(sql, org);
    if (backups.length > 0) await sql`DELETE FROM platform_backups WHERE id = ANY(${backups}::uuid[])`;
    await sql.end();
  });

  const viewerOf = (s: SeededOrg) => ({
    id: s.owner,
    org_id: s.org,
    role: 'owner',
    is_superuser: false,
    impersonator_id: null,
    auth_method: 'session' as const,
  });

  async function setUp(tag: string) {
    const s = await seedOrg(sql, `m9${tag}`, 2, 1);
    orgs.push(s.org);
    return s;
  }

  async function restrictedItem(s: SeededOrg, title: string, sensitivity: 'standard' | 'restricted', assertionId: string) {
    const [e] = await sql`
      INSERT INTO bastion_manual_evidence (organization_id, kind, title, uploaded_by, owner_user_id, status, sensitivity, scan_label,
                                           content_sha256, size_bytes, content_type, produced_on)
      VALUES (${s.org}, 'attestation_statement', ${title}, ${s.owner}, ${s.owner}, 'active', ${sensitivity}, 'clean',
              ${sha256Hex(title)}, 10, 'text/plain', CURRENT_DATE)
      RETURNING id`;
    await sql`INSERT INTO bastion_manual_evidence_links (organization_id, manual_evidence_id, assertion_id, review_verdict)
              VALUES (${s.org}, ${e!.id as string}, ${assertionId}, 'accepted')`;
    return e!.id as string;
  }

  function deps(engine: EngineDeps, userCan = true) {
    const counters = memoryCounters();
    return {
      counters,
      room: { engine, counters, userCan: async () => userCan, ipSalt: 'c'.repeat(64) },
      sharing: { engine, enqueuePacket: async () => true },
    };
  }

  const ctx = (token: string | null, over: Partial<{ passcode: string | null; ip: string }> = {}) => ({
    token,
    passcode: over.passcode ?? null,
    ip: over.ip ?? '203.0.113.7',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
  });

  it('auditor room token gate: stored as SHA-256 only; one 404 for wrong, revoked, expired, locked or demoted; views logged', async () => {
    const s = await setUp('gate');
    const engine = makeDeps(sql);
    const d = deps(engine);
    const today = new Date().toISOString().slice(0, 10);
    const created = await sharing.createRoom(d.sharing, viewerOf(s), {
      label: 'Lagoon & Reef CPAs, Type I readiness',
      framework_id: s.framework,
      period_start: '2026-01-01',
      period_end: today,
      expires_in_days: 30,
      restricted_evidence_ids: [],
      confirm: true,
    }, false);
    const token = created.data.token;
    expect(created.data.link).toBe(`/bastion/room#${token}`);
    const stored = (await sql`SELECT * FROM bastion_auditor_rooms WHERE id = ${created.data.id as string}`)[0]!;
    expect(stored.token_sha256).toBe(sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    // The list never carries a token.
    expect(JSON.stringify(await sharing.listRooms(d.sharing, viewerOf(s), {}))).not.toContain(token);
    // auditor_room.created is in the outbox.
    expect((await sql`SELECT count(*)::int AS n FROM bastion_outbox WHERE organization_id = ${s.org} AND payload->>'event_type' = 'auditor_room.created'`)[0]!.n).toBe(1);

    const overview = await room.publicRoomOverview(d.room, ctx(token));
    expect(overview.data.room.label).toBe('Lagoon & Reef CPAs, Type I readiness');
    expect(overview.data.controls).toHaveLength(2);
    expect(overview.data.controls.every((c) => typeof c.state_words === 'string')).toBe(true);
    const control = await room.publicRoomControl(d.room, ctx(token), s.controls[0]!);
    expect(control.data.control.id).toBe(s.controls[0]);
    const log = await sql`SELECT view_kind, ip_hash FROM bastion_auditor_access_log WHERE organization_id = ${s.org} ORDER BY accessed_at`;
    expect(log.map((r) => r.view_kind)).toEqual(['overview', 'control']);
    expect(log[0]!.ip_hash).not.toContain('203.0.113.7');
    expect((await sql`SELECT access_count FROM bastion_auditor_rooms WHERE id = ${created.data.id as string}`)[0]!.access_count).toBe(2);

    // Wrong token: the same 404, and the misses lock that address out of unknown-token lookups.
    await expect(room.publicRoomOverview(d.room, ctx('x'.repeat(43)))).rejects.toThrow(room.ROOM_GONE);
    for (let i = 1; i < BASTION_ROOM_TOKEN_MISSES; i++) await room.publicRoomOverview(d.room, ctx('y'.repeat(43))).catch(() => undefined);
    expect([...d.counters.m.keys()].some((k) => k.startsWith('bastion:room:lock:'))).toBe(true);
    // The valid token still works from that address (lockouts are keyed per room, spec 5.2).
    await expect(room.publicRoomOverview(d.room, ctx(token))).resolves.toBeDefined();

    // A creator who lost bastion.auditor_room.create closes the room.
    await expect(room.publicRoomOverview(deps(engine, false).room, ctx(token))).rejects.toThrow(room.ROOM_GONE);

    // Outside the room: a control of another org is not found.
    const other = await setUp('other');
    await expect(room.publicRoomControl(d.room, ctx(token), other.controls[0]!)).rejects.toThrow(/not part of this room/);

    // Expired.
    await sql`UPDATE bastion_auditor_rooms SET expires_at = now() - interval '1 minute' WHERE id = ${created.data.id as string}`;
    await expect(room.publicRoomOverview(d.room, ctx(token))).rejects.toThrow(room.ROOM_GONE);
    await sql`UPDATE bastion_auditor_rooms SET expires_at = now() + interval '1 day' WHERE id = ${created.data.id as string}`;
    // Revoked.
    const revoked = await sharing.revokeRoom(d.sharing, viewerOf(s), created.data.id as string);
    expect(revoked.data.state).toBe('revoked');
    await expect(room.publicRoomOverview(d.room, ctx(token))).rejects.toThrow(room.ROOM_GONE);
    expect((await sql`SELECT count(*)::int AS n FROM bastion_outbox WHERE organization_id = ${s.org} AND payload->>'event_type' = 'auditor_room.revoked'`)[0]!.n).toBe(1);
  });

  it('passcode: required, 5 wrong answers lock the room and tell its creator, Unlock reopens it', async () => {
    const s = await setUp('pass');
    const d = deps(makeDeps(sql));
    const created = await sharing.createRoom(d.sharing, viewerOf(s), {
      label: 'With a passcode',
      framework_id: s.framework,
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      expires_in_days: 10,
      passcode: '482913',
      restricted_evidence_ids: [],
      confirm: true,
    }, false);
    const token = created.data.token;
    await expect(room.publicRoomOverview(d.room, ctx(token))).rejects.toBeInstanceOf(room.RoomPasscodeRequired);
    await expect(room.publicRoomOverview(d.room, ctx(token, { passcode: '482913' }))).resolves.toBeDefined();
    for (let i = 1; i < BASTION_ROOM_PASSCODE_MAX_FAILURES; i++) {
      await expect(room.publicRoomOverview(d.room, ctx(token, { passcode: '000000' }))).rejects.toMatchObject({ wrong: true, attemptsLeft: BASTION_ROOM_PASSCODE_MAX_FAILURES - i });
    }
    await expect(room.publicRoomOverview(d.room, ctx(token, { passcode: '000000' }))).rejects.toThrow(room.ROOM_GONE);
    // Locked: even the right passcode is the same 404 now.
    await expect(room.publicRoomOverview(d.room, ctx(token, { passcode: '482913' }))).rejects.toThrow(room.ROOM_GONE);
    const locked = await sql`SELECT payload FROM bastion_outbox WHERE organization_id = ${s.org} AND payload->>'event_type' = 'auditor_room.revoked'`;
    expect((locked[0]!.payload as { payload: { reason: string } }).payload.reason).toBe('locked');
    const unlocked = await sharing.unlockRoom(d.sharing, viewerOf(s), created.data.id as string);
    expect(unlocked.data.state).toBe('active');
    await expect(room.publicRoomOverview(d.room, ctx(token, { passcode: '482913' }))).resolves.toBeDefined();
  });

  it('passcode: a concurrent burst of guesses verifies at most 5, and a right answer never beats the lock (#308, #314)', async () => {
    const s = await setUp('burst');
    const d = deps(makeDeps(sql));
    const created = await sharing.createRoom(d.sharing, viewerOf(s), {
      label: 'Burst',
      framework_id: s.framework,
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      expires_in_days: 10,
      passcode: '271828',
      restricted_evidence_ids: [],
      confirm: true,
    }, false);
    const token = created.data.token;
    const verify = vi.spyOn(argon2, 'verify');
    try {
      // Ten wrong guesses and the right one, all at once, the right one last.
      const guesses = [...Array.from({ length: 10 }, (_, i) => String(100000 + i)), '271828'];
      const results = await Promise.allSettled(guesses.map((p) => room.publicRoomOverview(d.room, ctx(token, { passcode: p }))));
      const verified = verify.mock.calls.length;
      expect(verified).toBeLessThanOrEqual(BASTION_ROOM_PASSCODE_MAX_FAILURES);
      const wrongVerdicts = results.slice(0, 10).filter((r) => r.status === 'rejected' && (r.reason as { wrong?: boolean }).wrong === true).length;
      const right = results[10]!;
      const row = (await sql`SELECT passcode_failures, locked_at FROM bastion_auditor_rooms WHERE id = ${created.data.id as string}`)[0]!;
      if (right.status === 'fulfilled') {
        // Only possible when the right answer held one of the 5 tries: then the room is open.
        expect(row.locked_at).toBeNull();
        expect(wrongVerdicts).toBeLessThan(BASTION_ROOM_PASSCODE_MAX_FAILURES);
      }
      expect(Number(row.passcode_failures)).toBeLessThanOrEqual(BASTION_ROOM_PASSCODE_MAX_FAILURES);

      // Sequentially from a fresh state: a right answer gives its try back, and the next request
      // with the same passcode is remembered (no second argon2).
      await sql`UPDATE bastion_auditor_rooms SET passcode_failures = 0, locked_at = NULL WHERE id = ${created.data.id as string}`;
      verify.mockClear();
      await room.publicRoomOverview(d.room, ctx(token, { passcode: '271828' }));
      await room.publicRoomOverview(d.room, ctx(token, { passcode: '271828' }));
      expect(verify.mock.calls.length).toBe(1);
      expect((await sql`SELECT passcode_failures FROM bastion_auditor_rooms WHERE id = ${created.data.id as string}`)[0]!.passcode_failures).toBe(0);
    } finally {
      verify.mockRestore();
    }
  });

  it('room reads stay inside the restricted allowlist; questions are capped at 20 an hour', async () => {
    const s = await setUp('allow');
    const d = deps(makeDeps(sql));
    const open = await restrictedItem(s, 'Laptop list (standard)', 'standard', s.assertions[0]!);
    const shared = await restrictedItem(s, 'Background checks (restricted, shared)', 'restricted', s.assertions[0]!);
    const hidden = await restrictedItem(s, 'Salary review (restricted, not shared)', 'restricted', s.assertions[0]!);
    // Sharing restricted evidence needs read_restricted.
    await expect(
      sharing.createRoom(d.sharing, viewerOf(s), { label: 'x', framework_id: s.framework, period_start: '2026-01-01', period_end: '2027-12-31', expires_in_days: 5, restricted_evidence_ids: [shared], confirm: true }, false),
    ).rejects.toThrow(/restricted evidence/);
    const created = await sharing.createRoom(d.sharing, viewerOf(s), {
      label: 'Allowlist',
      framework_id: s.framework,
      period_start: '2026-01-01',
      period_end: '2027-12-31',
      expires_in_days: 5,
      restricted_evidence_ids: [shared],
      confirm: true,
    }, true);
    const token = created.data.token;
    const control = await room.publicRoomControl(d.room, ctx(token), s.controls[0]!);
    const titles = control.data.files.map((f) => f.title).sort();
    expect(titles).toEqual(['Background checks (restricted, shared)', 'Laptop list (standard)']);
    await expect(room.publicRoomEvidence(d.room, ctx(token), open)).resolves.toBeDefined();
    await expect(room.publicRoomEvidence(d.room, ctx(token), shared)).resolves.toBeDefined();
    await expect(room.publicRoomEvidence(d.room, ctx(token), hidden)).rejects.toThrow(/not part of this room/);
    // Preview shows the shared restricted item by title.
    const preview = await sharing.previewRoom(d.sharing, viewerOf(s), created.data.id as string);
    expect(preview.data.restricted_items.map((r) => r.title)).toEqual(['Background checks (restricted, shared)']);
    // Questions.
    for (let i = 0; i < BASTION_ROOM_REQUESTS_PER_HOUR; i++) {
      await room.publicRoomRequest(d.room, ctx(token), { requester_name: 'Lagoon & Reef CPAs', body: `Question ${i}` });
    }
    await expect(room.publicRoomRequest(d.room, ctx(token), { requester_name: 'Lagoon & Reef CPAs', body: 'One too many' })).rejects.toThrow(/most questions/);
    const reqs = await sharing.listRequests(d.sharing, viewerOf(s), { room_id: created.data.id as string });
    expect(reqs.data).toHaveLength(BASTION_ROOM_REQUESTS_PER_HOUR);
    const answered = await sharing.updateRequest(d.sharing, viewerOf(s), reqs.data[0]!.id as string, { status: 'answered', answer_note: 'See the report.' });
    expect(answered.data!.status).toBe('answered');
    await sharing.revokeRoom(d.sharing, viewerOf(s), created.data.id as string);
  });

  it('a check download is the counts-only view, never the stored evidence document (#307)', async () => {
    const s = await setUp('dl');
    const bucket = fakeBucket();
    const engine = makeDeps(sql, { bucket });
    const d = deps(engine);
    const secretRepo = 'gilligan-travel/private-lagoon-ops';
    const citedId = randomUUID();
    const raw = Buffer.from(JSON.stringify({
      org: s.org,
      params: { repos: [secretRepo] },
      population_checked: [secretRepo],
      summary: { repos: [{ repo: secretRepo, merged: 3 }], cited_count: 1 },
      cited_refs: [{ entity_type: 'bam.task', entity_id: citedId }],
    }));
    const sha = sha256Hex(raw);
    const key = `evidence/${s.org}/${sha}.json`;
    bucket.objects.set(key, { body: raw, contentType: 'application/json', modifiedAt: new Date() });
    await sql`INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, holder_count)
              VALUES (${s.org}, ${sha}, ${key}, ${raw.length}, 1)`;
    const [run] = await sql`INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, control_id, as_of, status)
                            VALUES (${s.org}, 'manual', 'control', ${s.controls[0]!}, now(), 'succeeded') RETURNING id`;
    const [snap] = await sql`
      INSERT INTO bastion_evidence_snapshots (organization_id, evaluation_run_id, assertion_id, control_id, outcome, summary, cited_refs,
                                              population_checked, content_sha256)
      VALUES (${s.org}, ${run!.id as string}, ${s.assertions[0]!}, ${s.controls[0]!}, 'pass',
              ${sql.json({ repos: [{ repo: secretRepo, merged: 3 }], cited_count: 1 })},
              ${sql.json([{ entity_type: 'bam.task', entity_id: citedId }])}, ${sql.json([secretRepo])}, ${sha})
      RETURNING id`;
    const created = await sharing.createRoom(d.sharing, viewerOf(s), {
      label: 'Download check',
      framework_id: s.framework,
      period_start: '2026-01-01',
      period_end: '2027-12-31',
      expires_in_days: 5,
      restricted_evidence_ids: [],
      confirm: true,
    }, false);
    const out = await room.publicRoomDownload(d.room, ctx(created.data.token), snap!.id as string);
    const chunks: Buffer[] = [];
    for await (const c of out.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).not.toContain(secretRepo);
    expect(text).not.toContain(citedId);
    expect(text).not.toContain('cited_refs');
    expect(text).not.toContain('population_checked');
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ id: snap!.id, kind: 'check', outcome: 'pass', fingerprint_sha256: sha });
    expect(out.headers['Content-Type'] ?? out.headers['content-type']).toMatch(/json/);
    const logged = await sql`SELECT view_kind FROM bastion_auditor_access_log WHERE organization_id = ${s.org} AND view_kind = 'download'`;
    expect(logged).toHaveLength(1);
  });

  it('packet commitments go through verify-commitments: intact, pd_mismatch, key_changed, redacted, no_personal_data', async () => {
    const s = await setUp('pd');
    const engine = makeDeps(sql);
    const [pol] = await sql`INSERT INTO bastion_policies (organization_id, beacon_entry_id, title_cache) VALUES (${s.org}, ${randomUUID()}, 'Security policy') RETURNING id`;
    const kinds = ['intact', 'changed', 'oldkey', 'redacted', 'none'] as const;
    const ids: Record<string, string> = {};
    for (const k of kinds) {
      const id = randomUUID();
      ids[k] = id;
      const data = { name: `Person ${k}`, policy_title: 'Security policy' };
      const hmac = k === 'none' ? null : engine.pdHmac(data);
      await sql`
        INSERT INTO bastion_policy_attestations (id, organization_id, policy_id, beacon_entry_id, beacon_version, body_sha256, user_id,
                                                 attested_at, personal_data_hmac, pd_hmac_key_id)
        VALUES (${id}, ${s.org}, ${pol!.id as string}, ${randomUUID()}, ${kinds.indexOf(k) + 1}, ${'b'.repeat(64)}, ${s.owner}, now(), ${hmac},
                ${k === 'none' ? null : k === 'oldkey' ? 'pd:old' : engine.pdKeyId})`;
      if (k !== 'none') {
        await sql`
          INSERT INTO bastion_personal_data (organization_id, holder_kind, holder_id, data, data_hmac, pd_hmac_key_id, redacted_at)
          VALUES (${s.org}, 'attestation', ${id}, ${sql.json(k === 'changed' ? { ...data, name: 'Someone else' } : k === 'redacted' ? {} : data)},
                  ${hmac}, ${engine.pdKeyId}, ${k === 'redacted' ? new Date() : null})`;
      }
    }
    const out = await verifyCommitments(engine, s.org, kinds.map((k) => ({ holder_kind: 'attestation' as const, holder_id: ids[k]! })));
    expect(Object.fromEntries(out.results.map((r) => [kinds[Object.values(ids).indexOf(r.holder_id)], r.result]))).toEqual({
      intact: 'intact',
      changed: 'pd_mismatch',
      oldkey: 'key_changed',
      redacted: 'redacted',
      none: 'no_personal_data',
    });
    // Another org's holder is not readable from this org: pd_mismatch (no facts), never intact.
    const foreign = await verifyCommitments(engine, (await setUp('pd2')).org, [{ holder_kind: 'attestation', holder_id: ids.intact! }]);
    expect(foreign.results[0]!.result).toBe('pd_mismatch');

    // The packet claim lists these holders (attestations in the period) for the worker.
    const d = deps(engine);
    const today = new Date().toISOString().slice(0, 10);
    const created = await sharing.createExport(d.sharing, viewerOf(s), { framework_id: s.framework, period_start: '2026-01-01', period_end: today, include_restricted: false }, false);
    const claim = await packet.exportPacketEngine(engine, { action: 'claim', organization_id: s.org, packet_id: created.data.id as string, claimant: 'w1' });
    expect('claimed' in claim && claim.claimed).toBe(true);
    const contents = 'contents' in claim ? claim.contents! : null;
    // Every attestation in the period is a holder; the one without names comes back no_personal_data.
    expect(contents!.holders.filter((h) => h.holder_kind === 'attestation')).toHaveLength(5);
    // Each attempt writes its own key (#312), with an intent row so the sweep can reap a leftover.
    const attemptKey = contents!.packet.object_key;
    expect(attemptKey).toMatch(new RegExp(`^packets/${s.org}/${created.data.id as string}/[0-9a-f-]{36}\\.zip$`));
    expect((await sql`SELECT 1 FROM bastion_object_intents WHERE object_key = ${attemptKey}`).length).toBe(1);
    // Fenced on the claimant: another worker cannot claim a fresh running packet, report progress or finish it.
    const second = await packet.exportPacketEngine(engine, { action: 'claim', organization_id: s.org, packet_id: created.data.id as string, claimant: 'w2' });
    expect('claimed' in second && second.claimed).toBe(false);
    // ...but it is told how long until that lease goes stale, so it waits instead of dropping the job (#326).
    const wait = 'retry_after_ms' in second ? second.retry_after_ms! : -1;
    expect(wait).toBeGreaterThan(packet.PACKET_LEASE_MS - 60_000);
    expect(wait).toBeLessThanOrEqual(packet.PACKET_LEASE_MS + packet.PACKET_TAKEOVER_SLACK_MS);
    expect(await packet.exportPacketEngine(engine, { action: 'progress', organization_id: s.org, packet_id: created.data.id as string, claimant: 'w2', stage: 'zipping', progress: 1 })).toEqual({ ok: false });
    // finish is fenced on the attempt's key as well as the claimant.
    expect(await packet.exportPacketEngine(engine, { action: 'finish', organization_id: s.org, packet_id: created.data.id as string, claimant: 'w1', object_key: `packets/${s.org}/${created.data.id as string}/other.zip`, content_sha256: 'e'.repeat(64), size_bytes: 10 })).toEqual({ ok: false });
    const finishBody = { action: 'finish' as const, organization_id: s.org, packet_id: created.data.id as string, claimant: 'w1', object_key: attemptKey, content_sha256: 'e'.repeat(64), size_bytes: 10 };
    expect(await packet.exportPacketEngine(engine, finishBody)).toEqual({ ok: true });
    // A retry after a lost response finds its own success; the intent is gone with the finish.
    expect(await packet.exportPacketEngine(engine, finishBody)).toEqual({ ok: true });
    expect((await sql`SELECT 1 FROM bastion_object_intents WHERE object_key = ${attemptKey}`).length).toBe(0);
    const listed = await sharing.listExports(d.sharing, viewerOf(s), { limit: 25 });
    expect(listed.data[0]).toMatchObject({ status: 'succeeded', stage_words: 'Ready to download' });

    // A worker restart mid-build (#326): the dead attempt's heartbeat is past the lease but inside the
    // reap grace. The reaper leaves it alone and the stalled re-run (a new claimant) takes it over.
    const restarted = await sharing.createExport(d.sharing, viewerOf(s), { framework_id: s.framework, period_start: '2026-01-01', period_end: today, include_restricted: false }, false);
    await packet.exportPacketEngine(engine, { action: 'claim', organization_id: s.org, packet_id: restarted.data.id as string, claimant: 'dead-attempt' });
    await sql`UPDATE bastion_export_packets SET heartbeat_at = now() - interval '11 minutes' WHERE id = ${restarted.data.id as string}`;
    expect((await packet.reapPackets(engine, { organization_id: s.org })).failed).toBe(0);
    const rerun = await packet.exportPacketEngine(engine, { action: 'claim', organization_id: s.org, packet_id: restarted.data.id as string, claimant: 'rerun-attempt' });
    expect('claimed' in rerun && rerun.claimed).toBe(true);
    expect((await sql`SELECT status, claimed_by FROM bastion_export_packets WHERE id = ${restarted.data.id as string}`)[0]).toMatchObject({ status: 'running', claimed_by: 'rerun-attempt' });

    // A stalled packet is failed by the reaper with "build it again".
    const stalled =await sharing.createExport(d.sharing, viewerOf(s), { framework_id: s.framework, period_start: '2026-01-01', period_end: today, include_restricted: false }, false);
    await packet.exportPacketEngine(engine, { action: 'claim', organization_id: s.org, packet_id: stalled.data.id as string, claimant: 'w3' });
    await sql`UPDATE bastion_export_packets SET heartbeat_at = now() - interval '1 hour' WHERE id = ${stalled.data.id as string}`;
    expect((await packet.reapPackets(engine, { organization_id: s.org })).failed).toBe(1);
    expect((await sql`SELECT status, error FROM bastion_export_packets WHERE id = ${stalled.data.id as string}`)[0]).toMatchObject({ status: 'failed', error: 'The packet build stopped. Build it again.' });
  });

  it('an ISO packet is refused until the Statement of Applicability is finished', async () => {
    const s = await setUp('iso');
    const engine = makeDeps(sql);
    const [f] = await sql`INSERT INTO bastion_frameworks (organization_id, template_key, template_version, name, status, adopted_at)
                          VALUES (${s.org}, 'iso27001', '2022', 'ISO 27001', 'active', now()) RETURNING id`;
    const d = deps(engine);
    await expect(
      sharing.createExport(d.sharing, viewerOf(s), { framework_id: f!.id as string, period_start: '2026-01-01', period_end: '2026-06-30', include_restricted: false }, false),
    ).rejects.toThrow(/Statement of Applicability is not finished/);
    // And the claim re-checks it (a packet queued before an applicability decision was undone).
    const [p] = await sql`INSERT INTO bastion_export_packets (organization_id, framework_id, period_start, period_end, status)
                          VALUES (${s.org}, ${f!.id as string}, '2026-01-01', '2026-06-30', 'queued') RETURNING id`;
    const claim = await packet.exportPacketEngine(engine, { action: 'claim', organization_id: s.org, packet_id: p!.id as string, claimant: 'w1' });
    expect(claim).toMatchObject({ claimed: false, status: 'failed' });
    expect((await sql`SELECT status FROM bastion_export_packets WHERE id = ${p!.id as string}`)[0]!.status).toBe('failed');
  });

  it('object sweep: orphans and redacted bytes go, landed intents clear, young intents and orgs with an open restore are left alone', async () => {
    const s = await setUp('sweep');
    const paused = await setUp('paused');
    const bucket = fakeBucket();
    const engine = makeDeps(sql, { bucket });
    const old = new Date(Date.now() - SWEEP_INTENT_AGE_MS - HOUR);
    const put = (k: string) => bucket.objects.set(k, { body: Buffer.from(k), contentType: 'text/plain', modifiedAt: new Date() });
    const intent = (org: string, k: string, at: Date) => sql`INSERT INTO bastion_object_intents (organization_id, object_key, created_at) VALUES (${org}, ${k}, ${at})`;
    const keys = {
      orphan: `manual/${s.org}/orphan`,
      landed: `manual/${s.org}/landed`,
      redacted: `manual/${s.org}/redacted`,
      young: `manual/${s.org}/young`,
      pausedOrphan: `manual/${paused.org}/orphan`,
      reused: `evidence/${s.org}/${'d'.repeat(64)}.json`,
    };
    for (const k of Object.values(keys)) put(k);
    await intent(s.org, keys.orphan, old);
    await intent(s.org, keys.landed, old);
    await intent(s.org, keys.redacted, old);
    await intent(s.org, keys.young, new Date());
    await intent(paused.org, keys.pausedOrphan, old);
    await intent(s.org, keys.reused, old);
    await sql`INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, holder_count)
              VALUES (${s.org}, ${'1'.repeat(64)}, ${keys.landed}, 6, 1)`;
    await sql`INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, holder_count, bytes_redacted_at)
              VALUES (${s.org}, ${'2'.repeat(64)}, ${keys.redacted}, 8, 0, now())`;
    await sql`INSERT INTO bastion_ledger_restores (organization_id, provisional_epoch, status) VALUES (${paused.org}, 2, 'pending_ack')`;
    // A writer about to reuse the content-addressed key refreshes its intent first (evaluator /
    // evidence-store upsert), so the sweep must leave it and its bytes alone.
    await sql`INSERT INTO bastion_object_intents (organization_id, object_key) VALUES (${s.org}, ${keys.reused})
              ON CONFLICT (object_key) DO UPDATE SET created_at = now()`;

    const out = await objectSweep(engine, {});
    expect(out.paused_orgs).toBeGreaterThanOrEqual(1);
    expect(bucket.objects.has(keys.orphan)).toBe(false);
    expect(bucket.objects.has(keys.landed)).toBe(true);
    expect(bucket.objects.has(keys.redacted)).toBe(false);
    expect(bucket.objects.has(keys.young)).toBe(true);
    expect(bucket.objects.has(keys.pausedOrphan)).toBe(true);
    expect(bucket.objects.has(keys.reused)).toBe(true);
    const left = (await sql`SELECT object_key FROM bastion_object_intents WHERE organization_id = ANY(${[s.org, paused.org]}::uuid[])`).map((r) => r.object_key).sort();
    expect(left).toEqual([keys.pausedOrphan, keys.reused, keys.young].sort());

    // storeBuffer (the statement path) writes its intent BEFORE the put: a crash after the put
    // leaves exactly the leftover the sweep removes a day later.
    const stored = await storeBuffer(engine, s.org, Buffer.from('statement'), 'text/plain');
    expect((await sql`SELECT 1 FROM bastion_object_intents WHERE object_key = ${stored.object_key}`).length).toBe(1);
  });

  it('off-site mirror: copies objects and seals, records completed; a failing destination records failed and the backup stays completed', async () => {
    const s = await setUp('mirror');
    const source = fakeBucket();
    const engine = makeDeps(sql, { bucket: source });
    const body = Buffer.from('{"evidence":1}');
    const key = `evidence/${s.org}/${sha256Hex(body)}.json`;
    source.objects.set(key, { body, contentType: 'application/json', modifiedAt: new Date() });
    source.objects.set(`seals/${s.org}/2026-11-25.json`, { body: Buffer.from('{"seal":1}'), contentType: 'application/json', modifiedAt: new Date() });
    await sql`INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, holder_count, created_at)
              VALUES (${s.org}, ${sha256Hex(body)}, ${key}, ${body.length}, 1, now() - interval '3 hours')`;
    const [b] = await sql`INSERT INTO platform_backups (kind, status, started_at, completed_at) VALUES ('manual', 'completed', now(), now()) RETURNING id`;
    backups.push(b!.id as string);

    // A failing destination: the backup row's own status never changes.
    const broken: FakeBucket = fakeBucket();
    broken.failPuts = true;
    const failed = await mirrorObjects(engine, broken, { backup_id: b!.id as string });
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/could not be written/);
    expect((await sql`SELECT status, bastion_mirror_status FROM platform_backups WHERE id = ${b!.id as string}`)[0]).toEqual({ status: 'completed', bastion_mirror_status: 'failed' });

    // A working destination.
    const dest = fakeBucket();
    let res = await mirrorObjects(engine, dest, { backup_id: b!.id as string });
    for (let i = 0; !res.complete && i < 20; i++) res = await mirrorObjects(engine, dest, { backup_id: b!.id as string });
    expect(dest.objects.has(key)).toBe(true);
    expect(dest.objects.has(`seals/${s.org}/2026-11-25.json`)).toBe(true);
    expect((await sql`SELECT mirrored_at FROM bastion_evidence_objects WHERE object_key = ${key}`)[0]!.mirrored_at).not.toBeNull();
    const row = (await sql`SELECT status, bastion_mirror_status, bastion_mirror_cursor FROM platform_backups WHERE id = ${b!.id as string}`)[0]!;
    expect(row.status).toBe('completed');
    expect(row.bastion_mirror_cursor).not.toBeNull();
    // The mirror is platform-wide (#318): on a shared database other orgs' objects are not in this
    // test's fake bucket and stay unmirrored, which is `partial` by design. The verdict must be
    // `completed` exactly when nothing outside this org is left behind before the horizon.
    const othersLeft = (await sql`
      SELECT count(*)::int AS n FROM bastion_evidence_objects o, platform_backups p
       WHERE p.id = ${b!.id as string} AND o.mirrored_at IS NULL AND o.bytes_redacted_at IS NULL
         AND o.created_at < p.started_at - interval '1 hour'`)[0]!.n as number;
    expect(row.bastion_mirror_status).toBe(othersLeft === 0 ? 'completed' : 'partial');
    // This org's own objects are all mirrored either way.
    expect((await sql`SELECT count(*)::int AS n FROM bastion_evidence_objects WHERE organization_id = ${s.org} AND mirrored_at IS NULL`)[0]!.n).toBe(0);

    // Not configured: recorded as such, never `completed`.
    const none = await mirrorObjects(engine, null, { backup_id: b!.id as string });
    expect(none.status).toBe('not_configured');
    expect((await sql`SELECT bastion_mirror_status FROM platform_backups WHERE id = ${b!.id as string}`)[0]!.bastion_mirror_status).toBe('not_configured');

    // restore-objects --from-backup: a lost bucket gets the mirror back; running it twice copies nothing new.
    source.objects.delete(key);
    const lines: string[] = [];
    const first = await restoreObjectsFromBackup(dest, source, (l) => lines.push(l));
    expect(first.copied).toBeGreaterThanOrEqual(1);
    expect(source.objects.get(key)?.body.toString()).toBe(body.toString());
    const again = await restoreObjectsFromBackup(dest, source, () => undefined);
    expect(again.copied).toBe(0);
    expect(lines.some((l) => /^objects \d+/.test(l))).toBe(true);
  });

  it('mirror records step: budgeted and resumable, re-checks only new records on the next backup, and never overwrites a recorded failure (#309)', async () => {
    await setUp('records');
    const source = fakeBucket();
    source.pageSize = 4;
    const engine = makeDeps(sql, { bucket: source });
    const old = new Date(Date.now() - 3 * HOUR);
    // Keys are written under a distinct org segment so other tests' seals do not mix in.
    const tag = randomUUID();
    for (let i = 0; i < 12; i++) {
      source.objects.set(`seals/${tag}/2026-10-${String(i + 1).padStart(2, '0')}.json`, { body: Buffer.from(`{"seal":${i}}`), contentType: 'application/json', modifiedAt: old });
    }
    const dest = fakeBucket();
    let stats = 0;
    const realStat = dest.stat.bind(dest);
    dest.stat = async (k) => {
      stats += 1;
      await new Promise((r) => setTimeout(r, 15));
      return realStat(k);
    };
    const [b1] = await sql`INSERT INTO platform_backups (kind, status, started_at, completed_at) VALUES ('manual', 'completed', now(), now()) RETURNING id`;
    backups.push(b1!.id as string);
    const sealCount = () => [...source.objects.keys()].filter((k) => k.startsWith('seals/') || k.startsWith('restores/')).length;
    const total = sealCount();

    // A tiny time budget: the first call stops part-way through the records and says so.
    const first = await mirrorObjects(engine, dest, { backup_id: b1!.id as string, timeBudgetMs: 60 });
    expect(first.complete).toBe(false);
    expect(first.status).toBe('running');
    expect(stats).toBeLessThan(total);
    let res = first;
    for (let i = 0; !res.complete && i < 200; i++) res = await mirrorObjects(engine, dest, { backup_id: b1!.id as string, timeBudgetMs: 60 });
    expect(res.complete).toBe(true);
    for (let i = 0; i < 12; i++) expect(dest.objects.has(`seals/${tag}/2026-10-${String(i + 1).padStart(2, '0')}.json`)).toBe(true);
    // Resumed, not restarted: each record was checked about once (a call may stop just after a stat).
    expect(stats).toBeLessThanOrEqual(total + 200);
    const statsAfterFirstBackup = stats;

    // The next backup: one new seal. Only it is checked against the mirror.
    source.objects.set(`seals/${tag}/2026-11-26.json`, { body: Buffer.from('{"seal":"new"}'), contentType: 'application/json', modifiedAt: new Date() });
    const [b2] = await sql`INSERT INTO platform_backups (kind, status, started_at, completed_at) VALUES ('manual', 'completed', now(), now()) RETURNING id`;
    backups.push(b2!.id as string);
    res = await mirrorObjects(engine, dest, { backup_id: b2!.id as string });
    for (let i = 0; !res.complete && i < 20; i++) res = await mirrorObjects(engine, dest, { backup_id: b2!.id as string });
    expect(dest.objects.has(`seals/${tag}/2026-11-26.json`)).toBe(true);
    expect(stats - statsAfterFirstBackup).toBe(1);

    // A call that finishes after the worker recorded `failed` leaves that word standing.
    const [b3] = await sql`INSERT INTO platform_backups (kind, status, started_at, completed_at) VALUES ('manual', 'completed', now(), now()) RETURNING id`;
    backups.push(b3!.id as string);
    dest.stat = async (k) => {
      await sql`UPDATE platform_backups SET bastion_mirror_status = 'failed' WHERE id = ${b3!.id as string}`;
      return realStat(k);
    };
    source.objects.set(`seals/${tag}/2026-11-27.json`, { body: Buffer.from('{"seal":"late"}'), contentType: 'application/json', modifiedAt: new Date() });
    await mirrorObjects(engine, dest, { backup_id: b3!.id as string });
    expect((await sql`SELECT bastion_mirror_status FROM platform_backups WHERE id = ${b3!.id as string}`)[0]!.bastion_mirror_status).toBe('failed');
  });

  it('mirror: bytes redacted while their copy was in flight are removed from the mirror (#310)', async () => {
    const s = await setUp('mredact');
    const source = fakeBucket();
    const engine = makeDeps(sql, { bucket: source });
    const body = Buffer.from(`{"redact-me":"${randomUUID()}"}`);
    const sha = sha256Hex(body);
    const key = `manual/${s.org}/${randomUUID()}`;
    source.objects.set(key, { body, contentType: 'application/json', modifiedAt: new Date() });
    await sql`INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, holder_count, created_at)
              VALUES (${s.org}, ${sha}, ${key}, ${body.length}, 1, now() - interval '3 hours')`;
    const dest = fakeBucket();
    const realPut = dest.put.bind(dest);
    dest.put = async (k, b, o) => {
      const r = await realPut(k, b, o);
      // The owner redacts while the copy is landing.
      if (k === key) await sql`UPDATE bastion_evidence_objects SET bytes_redacted_at = now() WHERE organization_id = ${s.org} AND content_sha256 = ${sha}`;
      return r;
    };
    let res = await mirrorObjects(engine, dest, {});
    for (let i = 0; !res.complete && i < 20; i++) res = await mirrorObjects(engine, dest, {});
    expect(dest.objects.has(key)).toBe(false);
    // And if that immediate delete fails, mirrored_at stays set so step 1 finds the copy next pass.
    const row = (await sql`SELECT mirrored_at FROM bastion_evidence_objects WHERE organization_id = ${s.org} AND content_sha256 = ${sha}`)[0]!;
    expect(row.mirrored_at).toBeNull();
  });
});
