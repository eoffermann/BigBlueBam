import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { runEvaluationSlice } from '../../src/engine/evaluator.js';
import type { EngineDeps } from '../../src/engine/context.js';
import type { QueuedRun } from '../../src/engine/evidence-store.js';
import type { BinAccessDeps } from '../../src/lib/bin-asset-access.js';
import { ForbiddenError, RateLimitedError } from '../../src/lib/errors.js';
import { coverageMap, readinessSummary } from '../../src/services/coverage.service.js';
import type { EvidenceDeps } from '../../src/services/evidence-deps.js';
import { evidenceExpiry, evidenceIngest } from '../../src/services/evidence-engines.js';
import {
  authenticateFeedPush,
  createFeed,
  createFeedKey,
  FeedAuthError,
  ingestFeedBatch,
  listFeedRecords,
  revokeFeedKey,
} from '../../src/services/feeds.service.js';
import {
  createManualEvidence,
  getManualEvidence,
  linkManualEvidence,
  redactPersonalData,
  reviewManualEvidence,
  withdrawManualEvidence,
} from '../../src/services/manual-evidence.service.js';
import type { Viewer } from '../../src/services/types.js';
import { DATABASE_URL, type FakeBucket, fakeBucket, makeDeps, wipeOrg } from './engine-harness.js';

/**
 * M5 gates against a real migrated database and the real service code (spec 3.3-3.5, 11.1):
 * copy at attach by Bin scan state, the pending-scan retry, second-person review and the
 * small-team rule, the manual decision through a real evaluation run, redaction withdrawing the
 * only accepted file (control drops to "Can't prove yet") with reference-counted bytes, feed keys
 * (resolver, grace, revoke, quota 429, idempotency), the expiry engine, and the numbers.
 *
 * Bin is stubbed at the access boundary (rows + a fake bucket holding the version bytes).
 * SKIPS LOUDLY without DATABASE_URL.
 */

if (!DATABASE_URL) {
  console.warn('[bastion-api/m5-evidence] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');
}

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const DAY = 86_400_000;
const PEPPER = 'ef'.repeat(32);

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

interface Org {
  org: string;
  owner: string;
  others: string[];
  framework: string;
  controls: { manual: string; statement: string };
  assertions: { manual: string; statement: string };
}

async function seed(sql: postgres.Sql, tag: string, extraHumans: number): Promise<Org> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [o] = await sql`INSERT INTO organizations (name, slug) VALUES (${`Bastion M5 ${tag}`}, ${`bastion-m5-${tag}-${stamp}`}) RETURNING id`;
  const org = o!.id as string;
  const mkUser = async (name: string) => {
    const [u] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                          VALUES (${org}, ${`m5-${tag}-${name}-${stamp}@bigbluebam.internal`}, ${name}, '!', 'human') RETURNING id`;
    await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${u!.id as string}, ${org})`;
    return u!.id as string;
  };
  const owner = await mkUser('Skipper');
  const others: string[] = [];
  for (let i = 0; i < extraHumans; i++) others.push(await mkUser(`Castaway ${i}`));
  await sql`INSERT INTO bastion_org_settings (organization_id, timezone, evaluation_hour_local, evaluation_minute_offset)
            VALUES (${org}, 'UTC', 0, 0)`;
  const [f] = await sql`INSERT INTO bastion_frameworks (organization_id, template_key, template_version, name, status, adopted_at)
                        VALUES (${org}, 'soc2', '2017', 'SOC 2', 'active', now()) RETURNING id`;
  const framework = f!.id as string;
  const mkControl = async (key: string, spec: Record<string, unknown>) => {
    const [c] = await sql`INSERT INTO bastion_controls (organization_id, control_key, title, owner_user_id)
                          VALUES (${org}, ${key}, ${key}, ${owner}) RETURNING id`;
    await sql`INSERT INTO bastion_control_requirements (organization_id, control_id, framework_id, ref_code, requirement_title, applicability)
              VALUES (${org}, ${c!.id as string}, ${framework}, ${`CC-${key}`}, 'Requirement', 'applicable')`;
    const [a] = await sql`
      INSERT INTO bastion_assertions (organization_id, control_id, kind, manual_evidence_spec, params, predicate, plain_statement,
                                      proposed_by, review_status, confirmed_by, confirmed_at)
      VALUES (${org}, ${c!.id as string}, 'manual', ${sql.json(spec as never)}, '{}'::jsonb, '{}'::jsonb, 'manual check', 'library', 'confirmed', ${owner}, now())
      RETURNING id`;
    return { control: c!.id as string, assertion: a!.id as string };
  };
  const m = await mkControl('auth.mfa', { title: 'Two-step report', description: 'report', kind: 'file', cadence_days: 90 });
  const s = await mkControl('hr.screening', { title: 'Background checks', description: 'statement', kind: 'attestation_statement', cadence_days: 365 });
  return { org, owner, others, framework, controls: { manual: m.control, statement: s.control }, assertions: { manual: m.assertion, statement: s.assertion } };
}

function viewer(o: Org, userId: string, role = 'member'): Viewer {
  return { id: userId, org_id: o.org, role, is_superuser: false, impersonator_id: null, auth_method: 'session' };
}

interface FakeBin {
  assets: Map<string, { org_id: string; scan_status: string; current_version_id: string | null }>;
  versions: Map<string, { asset_id: string; object_key: string; size: number; content_type: string }>;
  bucket: FakeBucket;
}

function evidenceDepsFor(engine: EngineDeps, bin: FakeBin, runs: QueuedRun[]): EvidenceDeps {
  return {
    engine,
    binStorage: bin.bucket,
    bin: (): BinAccessDeps => ({
      async loadAsset(id) {
        const a = bin.assets.get(id);
        return a ? { id, ...a } : null;
      },
      async loadVersion(id) {
        const v = bin.versions.get(id);
        return v ? { id, ...v } : null;
      },
      async canAccess() {
        return true;
      },
    }),
    enqueueRuns: async (r) => {
      runs.push(...r);
    },
    enqueueIngest: async () => {},
  };
}

async function putBinFile(bin: FakeBin, org: string, body: string, scan = 'clean') {
  const asset = crypto.randomUUID();
  const version = crypto.randomUUID();
  const key = `bin/${org}/${asset}/${version}/report.pdf`;
  await bin.bucket.put(key, Buffer.from(body), { contentType: 'application/pdf' });
  bin.assets.set(asset, { org_id: org, scan_status: scan, current_version_id: version });
  bin.versions.set(version, { asset_id: asset, object_key: key, size: Buffer.byteLength(body), content_type: 'application/pdf' });
  return { asset, version };
}

describe.skipIf(!DATABASE_URL)('M5 manual evidence, personal data, feeds and the numbers (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
  });

  async function drive(engine: EngineDeps, org: string, runs: QueuedRun[]) {
    for (const r of runs.splice(0)) {
      for (let i = 0; i < 20; i++) {
        const s = await runEvaluationSlice(engine, { organization_id: org, run_id: r.run_id, claimant: 'm5-test' });
        if (s.done) break;
      }
    }
  }

  const fileBody = (o: Org, binAsset: string, over: Record<string, unknown> = {}) => ({
    kind: 'file' as const,
    bin_asset_id: binAsset,
    title: 'Google Workspace 2-Step Verification report',
    source_system: 'Google Workspace',
    owner_user_id: o.others[0] ?? o.owner,
    produced_on: isoDay(new Date(Date.now() - 2 * DAY)),
    valid_until: isoDay(new Date(Date.now() + 12 * DAY)),
    sensitivity: 'standard' as const,
    uploader_statement: true as const,
    assertion_ids: [o.assertions.manual],
    ...over,
  });

  it('copy at attach, second-person review, the manual decision, and redaction of the only accepted file', async () => {
    const o = await seed(sql, 'flow', 3);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const bucket = engine.storage as FakeBucket;
    const bin: FakeBin = { assets: new Map(), versions: new Map(), bucket: fakeBucket() };
    const runs: QueuedRun[] = [];
    const d = evidenceDepsFor(engine, bin, runs);
    const professor = o.others[0]!;
    const f = await putBinFile(bin, o.org, '%PDF two-step report');

    const created = (await createManualEvidence(d, viewer(o, professor), fileBody(o, f.asset))).data as Record<string, unknown>;
    expect(created.status).toBe('active');
    expect(created.scan_label).toBe('clean');
    expect(created.content_sha256).toBe(createHash('sha256').update('%PDF two-step report').digest('hex'));
    expect(created.days_left).toBe(12);
    const id = created.id as string;

    // The bytes live in Bastion's bucket, the intent is gone, the ledger and personal data are written.
    const obj = (await sql`SELECT object_key, holder_count FROM bastion_evidence_objects WHERE organization_id = ${o.org}`)[0]!;
    expect(bucket.objects.has(obj.object_key as string)).toBe(true);
    expect(Number(obj.holder_count)).toBe(1);
    expect((await sql`SELECT count(*)::int AS n FROM bastion_object_intents WHERE organization_id = ${o.org}`)[0]!.n).toBe(0);
    const entry = (await sql`SELECT entry_kind, personal_data_hmac FROM bastion_ledger_entries WHERE organization_id = ${o.org} AND entry_id = ${id}`)[0]!;
    expect(entry.entry_kind).toBe('manual_evidence');
    const pd = (await sql`SELECT id, data, data_hmac FROM bastion_personal_data WHERE organization_id = ${o.org} AND holder_id = ${id}`)[0]!;
    expect(pd.data_hmac).toBe(entry.personal_data_hmac);
    expect((pd.data as Record<string, unknown>).uploader_statement).toContain('Google Workspace');
    expect((await sql`SELECT count(*)::int AS n FROM bastion_outbox WHERE organization_id = ${o.org} AND payload->>'event_type' = 'evidence.uploaded'`)[0]!.n).toBe(1);

    // Four humans: the uploader may not accept their own upload.
    await expect(reviewManualEvidence(d, viewer(o, professor), id, o.assertions.manual, { verdict: 'accepted' })).rejects.toBeInstanceOf(ForbiddenError);
    await reviewManualEvidence(d, viewer(o, o.owner, 'owner'), id, o.assertions.manual, { verdict: 'accepted' });
    expect(runs).toHaveLength(1);
    await drive(engine, o.org, runs);
    const passed = (await sql`SELECT status, coverage_kind FROM bastion_controls WHERE id = ${o.controls.manual}`)[0]!;
    expect(passed.status).toBe('pass');
    expect(passed.coverage_kind).toBe('manual_file');

    const summary = (await readinessSummary(engine, viewer(o, o.owner, 'owner'), undefined, { storage_ok: true, offsite_backup_configured: false })).data;
    expect(summary.numbers.proven_by_evidence).toBe(1);
    expect(summary.numbers.total).toBe(2);
    expect(summary.expiring_evidence[0]?.days_left).toBe(12);
    expect(summary.banners.map((b) => b.code)).toContain('offsite_backup_not_configured');
    const map = await coverageMap(engine, viewer(o, o.owner, 'owner'), undefined);
    expect(map.data.find((r) => r.control_id === o.controls.manual)?.columns.manual_file).toBe(1);
    expect(map.data.find((r) => r.control_id === o.controls.statement)?.columns.self_attested).toBe(1);

    // Redaction: owner only; withdraws the only accepted file, deletes its bytes, re-evaluates.
    await expect(redactPersonalData(d, viewer(o, professor), pd.id as string, 'left the company')).rejects.toBeInstanceOf(ForbiddenError);
    const red = (await redactPersonalData(d, viewer(o, o.owner, 'owner'), pd.id as string, 'personal data request')).data;
    expect(red.bytes_deleted).toBe(true);
    expect(bucket.objects.has(obj.object_key as string)).toBe(false);
    const after = (await getManualEvidence(d, viewer(o, o.owner, 'owner'), id, true)).data as Record<string, unknown>;
    expect(after.status).toBe('withdrawn');
    expect(after.withdrawn_reason).toBe('redacted');
    const blanked = (await sql`SELECT data, data_hmac, redacted_at FROM bastion_personal_data WHERE id = ${pd.id as string}`)[0]!;
    expect(blanked.data).toEqual({});
    expect(blanked.data_hmac).toBe(pd.data_hmac);
    expect(runs).toHaveLength(1);
    await drive(engine, o.org, runs);
    const dropped = (await sql`SELECT status, status_reason FROM bastion_controls WHERE id = ${o.controls.manual}`)[0]!;
    expect(dropped.status).toBe('unprovable');
    expect(dropped.status_reason).toBe('manual_evidence_missing');
  });

  it('small teams may self-review, labelled; statements count as self-attested', async () => {
    const o = await seed(sql, 'small', 1);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const runs: QueuedRun[] = [];
    const d = evidenceDepsFor(engine, { assets: new Map(), versions: new Map(), bucket: fakeBucket() }, runs);
    const mary = o.others[0]!;
    const created = (
      await createManualEvidence(d, viewer(o, mary), {
        kind: 'attestation_statement',
        statement: 'Everyone who joined this year was background-checked before starting. Checked by Mary Ann.',
        title: 'Background check statement',
        source_system: 'Crew records',
        owner_user_id: mary,
        produced_on: isoDay(new Date()),
        valid_until: isoDay(new Date(Date.now() + 300 * DAY)),
        sensitivity: 'standard',
        uploader_statement: true,
        assertion_ids: [o.assertions.statement],
      })
    ).data as Record<string, unknown>;
    expect(created.trust_label).toBe('Self-attested');
    const reviewed = (await reviewManualEvidence(d, viewer(o, mary), created.id as string, o.assertions.statement, { verdict: 'accepted' })).data as {
      links: Array<{ small_team_self_review: boolean }>;
    };
    expect(reviewed.links[0]?.small_team_self_review).toBe(true);
    await drive(engine, o.org, runs);
    const c = (await sql`SELECT status, coverage_kind FROM bastion_controls WHERE id = ${o.controls.statement}`)[0]!;
    expect(c.status).toBe('pass');
    expect(c.coverage_kind).toBe('self_attested');
  });

  it('scan states: skipped copies labelled, pending waits then copies, infected blocks, a newer version blocks', async () => {
    const o = await seed(sql, 'scan', 3);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const bin: FakeBin = { assets: new Map(), versions: new Map(), bucket: fakeBucket() };
    const d = evidenceDepsFor(engine, bin, []);
    const v = viewer(o, o.others[0]!);

    const skipped = await putBinFile(bin, o.org, 'skipped bytes', 'skipped');
    expect(((await createManualEvidence(d, v, fileBody(o, skipped.asset))).data as Record<string, unknown>).scan_note).toContain('Not virus-scanned');

    const infected = await putBinFile(bin, o.org, 'bad bytes', 'infected');
    const inf = (await createManualEvidence(d, v, fileBody(o, infected.asset))).data as Record<string, unknown>;
    expect([inf.status, inf.blocked_reason]).toEqual(['blocked', 'infected']);

    const errored = await putBinFile(bin, o.org, 'error bytes', 'error');
    expect(((await createManualEvidence(d, v, fileBody(o, errored.asset))).data as Record<string, unknown>).blocked_reason).toBe('scan_failed');

    const pending = await putBinFile(bin, o.org, 'pending bytes', 'pending');
    const pend = (await createManualEvidence(d, v, fileBody(o, pending.asset))).data as Record<string, unknown>;
    expect(pend.status).toBe('pending_scan');
    await sql`UPDATE bastion_manual_evidence SET next_attempt_at = now() - interval '1 minute' WHERE id = ${pend.id as string}`;
    expect((await evidenceIngest(d, { organization_id: o.org })).still_pending).toBe(1);
    bin.assets.get(pending.asset)!.scan_status = 'clean';
    await sql`UPDATE bastion_manual_evidence SET next_attempt_at = now() - interval '1 minute' WHERE id = ${pend.id as string}`;
    expect((await evidenceIngest(d, { organization_id: o.org })).copied).toBe(1);
    const copied = (await sql`SELECT status, scan_label, content_sha256, ledger_seq FROM bastion_manual_evidence WHERE id = ${pend.id as string}`)[0]!;
    expect(copied.status).toBe('active');
    expect(copied.content_sha256).toBe(createHash('sha256').update('pending bytes').digest('hex'));
    expect(copied.ledger_seq).not.toBeNull();

    const moved = await putBinFile(bin, o.org, 'v1 bytes', 'pending');
    const mv = (await createManualEvidence(d, v, fileBody(o, moved.asset))).data as Record<string, unknown>;
    bin.assets.get(moved.asset)!.current_version_id = crypto.randomUUID();
    await sql`UPDATE bastion_manual_evidence SET next_attempt_at = now() - interval '1 minute' WHERE id = ${mv.id as string}`;
    await evidenceIngest(d, { organization_id: o.org });
    expect((await sql`SELECT status, blocked_reason FROM bastion_manual_evidence WHERE id = ${mv.id as string}`)[0]).toEqual({
      status: 'blocked',
      blocked_reason: 'changed_before_scan',
    });
  });

  it('identical bytes share one object; bytes go only when the last holder is redacted; withdraw records a ledger entry', async () => {
    const o = await seed(sql, 'refcount', 3);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const bucket = engine.storage as FakeBucket;
    const bin: FakeBin = { assets: new Map(), versions: new Map(), bucket: fakeBucket() };
    const d = evidenceDepsFor(engine, bin, []);
    const v = viewer(o, o.others[0]!);
    const a = await putBinFile(bin, o.org, 'same bytes');
    const b = await putBinFile(bin, o.org, 'same bytes');
    const first = ((await createManualEvidence(d, v, fileBody(o, a.asset))).data as Record<string, unknown>).id as string;
    const second = ((await createManualEvidence(d, v, fileBody(o, b.asset, { assertion_ids: [] }))).data as Record<string, unknown>).id as string;
    const objs = await sql`SELECT object_key, holder_count FROM bastion_evidence_objects WHERE organization_id = ${o.org}`;
    expect(objs).toHaveLength(1);
    expect(Number(objs[0]!.holder_count)).toBe(2);
    expect([...bucket.objects.keys()].filter((k) => k.startsWith(`manual/${o.org}/`))).toHaveLength(1);
    expect((await sql`SELECT count(*)::int AS n FROM bastion_object_intents WHERE organization_id = ${o.org}`)[0]!.n).toBe(0);

    const pdOf = async (id: string) => (await sql`SELECT id FROM bastion_personal_data WHERE organization_id = ${o.org} AND holder_id = ${id}`)[0]!.id as string;
    const owner = viewer(o, o.owner, 'owner');
    expect((await redactPersonalData(d, owner, await pdOf(first), 'request')).data.bytes_deleted).toBe(false);
    expect(bucket.objects.has(objs[0]!.object_key as string)).toBe(true);
    await withdrawManualEvidence(d, owner, second, 'replaced');
    expect((await sql`SELECT count(*)::int AS n FROM bastion_ledger_entries WHERE organization_id = ${o.org} AND entry_kind = 'withdrawal'`)[0]!.n).toBe(1);
    expect((await redactPersonalData(d, owner, await pdOf(second), 'request')).data.bytes_deleted).toBe(true);
    expect(bucket.objects.has(objs[0]!.object_key as string)).toBe(false);
  });

  it('linking checks the manual check belongs to the org; the expiry engine notifies once', async () => {
    const o = await seed(sql, 'expiry', 3);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const runs: QueuedRun[] = [];
    const bin: FakeBin = { assets: new Map(), versions: new Map(), bucket: fakeBucket() };
    const d = evidenceDepsFor(engine, bin, runs);
    const f = await putBinFile(bin, o.org, 'expiring bytes');
    const id = ((await createManualEvidence(d, viewer(o, o.others[0]!), fileBody(o, f.asset, { assertion_ids: [] }))).data as Record<string, unknown>).id as string;
    await expect(linkManualEvidence(d, viewer(o, o.owner), id, crypto.randomUUID())).rejects.toThrow();
    await linkManualEvidence(d, viewer(o, o.owner), id, o.assertions.manual);
    await reviewManualEvidence(d, viewer(o, o.owner, 'owner'), id, o.assertions.manual, { verdict: 'accepted' });
    // Drive the review's control run: while it is still queued, a second control run is (correctly)
    // not created, because the live one picks the change up.
    await drive(engine, o.org, runs);

    expect((await evidenceExpiry(d, { organization_id: o.org })).expiring_notified).toBe(1);
    expect((await evidenceExpiry(d, { organization_id: o.org })).expiring_notified).toBe(0);
    // Move the clock past expiry: one evidence.expired and a control re-evaluation, once.
    const later = makeDeps(sql, { clock: { offsetMs: 14 * DAY, now: () => new Date(Date.now() + 14 * DAY) } });
    const d2 = evidenceDepsFor(later, bin, runs);
    expect((await evidenceExpiry(d2, { organization_id: o.org })).expired_notified).toBe(1);
    expect(runs).toHaveLength(1);
    expect((await evidenceExpiry(d2, { organization_id: o.org })).expired_notified).toBe(0);
  });

  it('feeds: resolver, push, idempotency, wrong feed, quota 429, rotation grace and revoke', async () => {
    const o = await seed(sql, 'feed', 1);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const admin = viewer(o, o.owner, 'owner');
    const feed = (await createFeed(engine, admin, { feed_key: 'crew-roster', label: 'Crew roster export', source_kind: 'api_push', cadence_days: 1, daily_record_quota: 3 }))
      .data as Record<string, unknown>;
    const other = (await createFeed(engine, admin, { feed_key: 'other-feed', label: 'Other', source_kind: 'api_push', cadence_days: 1, daily_record_quota: 10 }))
      .data as Record<string, unknown>;
    const key = (await createFeedKey(engine, admin, feed.id as string, { label: 'export job' }, PEPPER)).data;
    expect(key.token.startsWith('bbf_')).toBe(true);
    const stored = (await sql`SELECT secret_hmac FROM bastion_feed_keys WHERE id = ${key.id as string}`)[0]!;
    expect(String(stored.secret_hmac)).not.toContain(key.token.split('_').pop()!);

    const auth = await authenticateFeedPush(engine, 'crew-roster', `Bearer ${key.token}`, PEPPER);
    expect(auth).toMatchObject({ orgId: o.org, feedId: feed.id });
    await expect(authenticateFeedPush(engine, 'other-feed', `Bearer ${key.token}`, PEPPER)).rejects.toBeInstanceOf(FeedAuthError);
    await expect(authenticateFeedPush(engine, 'crew-roster', `Bearer ${key.token}x`, PEPPER)).rejects.toBeInstanceOf(FeedAuthError);
    void other;

    const now = new Date().toISOString();
    const r1 = await ingestFeedBatch(engine, auth, { records: [
      { idempotency_key: 'crew-1', occurred_at: now, subject: 'gilligan@gilligantravel.example', attributes: { role: 'first mate' } },
      { idempotency_key: 'crew-2', occurred_at: now },
    ] }, 300);
    expect(r1.data).toEqual({ accepted: 2, duplicates: 0, quota_remaining: 1 });
    const again = await ingestFeedBatch(engine, auth, { records: [{ idempotency_key: 'crew-1', occurred_at: now }] }, 100);
    expect(again.data.accepted).toBe(0);
    expect(again.data.duplicates).toBe(1);
    await expect(
      ingestFeedBatch(engine, auth, { records: [{ idempotency_key: 'crew-3', occurred_at: now }, { idempotency_key: 'crew-4', occurred_at: now }] }, 100),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect((await sql`SELECT count(*)::int AS n FROM bastion_feed_records WHERE organization_id = ${o.org}`)[0]!.n).toBe(2);
    expect((await sql`SELECT count(*)::int AS n FROM bastion_ledger_entries WHERE organization_id = ${o.org} AND entry_kind = 'feed_record'`)[0]!.n).toBe(2);
    const records = await listFeedRecords(engine, admin, feed.id as string, { limit: 50 });
    expect(records.data.find((r) => r.idempotency_key === 'crew-1')?.subject).toBe('gilligan@gilligantravel.example');

    // Rotation: the old key keeps working through its grace window; revoke stops it at once.
    const key2 = (await createFeedKey(engine, admin, feed.id as string, {}, PEPPER)).data;
    expect(key2.rotated_keys).toBe(1);
    await expect(authenticateFeedPush(engine, 'crew-roster', `Bearer ${key.token}`, PEPPER)).resolves.toBeTruthy();
    await revokeFeedKey(engine, admin, key.id as string);
    await expect(authenticateFeedPush(engine, 'crew-roster', `Bearer ${key.token}`, PEPPER)).rejects.toBeInstanceOf(FeedAuthError);
    await expect(authenticateFeedPush(engine, 'crew-roster', `Bearer ${key2.token}`, PEPPER)).resolves.toBeTruthy();
  });
});
