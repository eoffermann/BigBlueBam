import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { runEvaluationSlice } from '../../src/engine/evaluator.js';
import type { EngineDeps } from '../../src/engine/context.js';
import type { QueuedRun } from '../../src/engine/evidence-store.js';
import type { BinAccessDeps } from '../../src/lib/bin-asset-access.js';
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError } from '../../src/lib/errors.js';
import { coverageMap, readinessSummary } from '../../src/services/coverage.service.js';
import type { EvidenceDeps } from '../../src/services/evidence-deps.js';
import { evidenceExpiry, evidenceIngest } from '../../src/services/evidence-engines.js';
import {
  authenticateFeedPush,
  createFeed,
  createFeedKey,
  FeedAuthError,
  ingestBoltEventFeeds,
  ingestFeedBatch,
  listFeedRecords,
  revokeFeedKey,
} from '../../src/services/feeds.service.js';
import {
  checkScanAgain,
  createManualEvidence,
  getManualEvidence,
  linkManualEvidence,
  redactPersonalData,
  retryPendingScan,
  reviewManualEvidence,
  supersedeManualEvidence,
  unlinkManualEvidence,
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
    await expect(reviewManualEvidence(d, viewer(o, professor), id, o.assertions.manual, { verdict: 'accepted' }, true)).rejects.toBeInstanceOf(ForbiddenError);
    await reviewManualEvidence(d, viewer(o, o.owner, 'owner'), id, o.assertions.manual, { verdict: 'accepted' }, true);
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
    const reviewed = (await reviewManualEvidence(d, viewer(o, mary), created.id as string, o.assertions.statement, { verdict: 'accepted' }, true)).data as {
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

  it('a pending copy is claimed once; one that will not fit the call budget runs in the background (#222)', async () => {
    const o = await seed(sql, 'copylease', 3);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const bin: FakeBin = { assets: new Map(), versions: new Map(), bucket: fakeBucket() };
    const d = evidenceDepsFor(engine, bin, []);
    const v = viewer(o, o.others[0]!);
    const due = (id: string) => sql`UPDATE bastion_manual_evidence SET next_attempt_at = now() - interval '1 minute' WHERE id = ${id}`;

    const a = await putBinFile(bin, o.org, 'lease bytes', 'pending');
    const aId = ((await createManualEvidence(d, v, fileBody(o, a.asset, { assertion_ids: [] }))).data as Record<string, unknown>).id as string;
    bin.assets.get(a.asset)!.scan_status = 'clean';
    await due(aId);
    // Two retries at once (a worker retry racing the next tick): exactly one copies.
    const results = await Promise.all([retryPendingScan(d, o.org, aId, { copyBudgetMs: 25_000 }), retryPendingScan(d, o.org, aId, { copyBudgetMs: 25_000 })]);
    expect(results.map((r) => r.result).sort()).toEqual(['copied', 'skipped']);
    expect((await sql`SELECT count(*)::int AS n FROM bastion_evidence_objects WHERE organization_id = ${o.org}`)[0]!.n).toBe(1);

    const b = await putBinFile(bin, o.org, 'large-file stand-in', 'pending');
    const bId = ((await createManualEvidence(d, v, fileBody(o, b.asset, { assertion_ids: [] }))).data as Record<string, unknown>).id as string;
    bin.assets.get(b.asset)!.scan_status = 'clean';
    await due(bId);
    expect((await retryPendingScan(d, o.org, bId, { copyBudgetMs: 0 })).result).toBe('copy_started');
    // While it runs, its lease keeps every other caller off it.
    expect((await retryPendingScan(d, o.org, bId, { copyBudgetMs: 25_000 })).result).toBe('skipped');
    for (let i = 0; i < 50; i++) {
      if ((await sql`SELECT status FROM bastion_manual_evidence WHERE id = ${bId}`)[0]!.status === 'active') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await sql`SELECT status FROM bastion_manual_evidence WHERE id = ${bId}`)[0]!.status).toBe('active');
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
    await withdrawManualEvidence(d, owner, second, 'replaced', true);
    expect((await sql`SELECT count(*)::int AS n FROM bastion_ledger_entries WHERE organization_id = ${o.org} AND entry_kind = 'withdrawal'`)[0]!.n).toBe(1);
    expect((await redactPersonalData(d, owner, await pdOf(second), 'request')).data.bytes_deleted).toBe(true);
    expect(bucket.objects.has(objs[0]!.object_key as string)).toBe(false);
  });

  it('a failed bucket delete at redaction reports pending, and evidence-ingest retries it until it lands (#212)', async () => {
    const o = await seed(sql, 'redactfail', 3);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const bucket = engine.storage as FakeBucket;
    const bin: FakeBin = { assets: new Map(), versions: new Map(), bucket: fakeBucket() };
    const d = evidenceDepsFor(engine, bin, []);
    const f = await putBinFile(bin, o.org, 'hr export with personal data');
    const id = ((await createManualEvidence(d, viewer(o, o.others[0]!), fileBody(o, f.asset, { assertion_ids: [] }))).data as Record<string, unknown>).id as string;
    const key = (await sql`SELECT object_key FROM bastion_evidence_objects WHERE organization_id = ${o.org}`)[0]!.object_key as string;
    const pdId = (await sql`SELECT id FROM bastion_personal_data WHERE organization_id = ${o.org} AND holder_id = ${id}`)[0]!.id as string;

    const realDelete = bucket.delete.bind(bucket);
    bucket.delete = async () => {
      throw new Error('bucket unavailable (test)');
    };
    const red = (await redactPersonalData(d, viewer(o, o.owner, 'owner'), pdId, 'erasure request')).data;
    expect(red.bytes_deleted).toBe(false);
    expect(red.bytes_delete_pending).toBe(true);
    expect(bucket.objects.has(key)).toBe(true);
    const event = (await sql`SELECT payload FROM bastion_outbox WHERE organization_id = ${o.org} AND payload->>'event_type' = 'evidence.redacted'`)[0]!;
    expect(JSON.stringify(event.payload)).toContain('"bytes_deleted":false');
    expect((await sql`SELECT count(*)::int AS n FROM bastion_object_intents WHERE object_key = ${key}`)[0]!.n).toBe(1);

    // Still failing: the engine keeps the intent.
    expect((await evidenceIngest(d, { organization_id: o.org })).redacted_bytes_pending).toBe(1);
    bucket.delete = realDelete;
    expect((await evidenceIngest(d, { organization_id: o.org })).redacted_bytes_deleted).toBe(1);
    expect(bucket.objects.has(key)).toBe(false);
    expect((await sql`SELECT count(*)::int AS n FROM bastion_object_intents WHERE object_key = ${key}`)[0]!.n).toBe(0);
    expect((await evidenceIngest(d, { organization_id: o.org })).redacted_bytes_deleted).toBe(0);
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
    await expect(linkManualEvidence(d, viewer(o, o.owner), id, crypto.randomUUID(), true)).rejects.toThrow();
    await linkManualEvidence(d, viewer(o, o.owner), id, o.assertions.manual, true);
    await reviewManualEvidence(d, viewer(o, o.owner, 'owner'), id, o.assertions.manual, { verdict: 'accepted' }, true);
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

    // Retention prunes delivered outbox rows after 30 days. The marker lives on the row, so a run
    // 31 days on sends nothing and queues nothing (#220).
    await sql`DELETE FROM bastion_outbox WHERE organization_id = ${o.org}`;
    const muchLater = makeDeps(sql, { clock: { offsetMs: 45 * DAY, now: () => new Date(Date.now() + 45 * DAY) } });
    const d3 = evidenceDepsFor(muchLater, bin, runs);
    expect(await evidenceExpiry(d3, { organization_id: o.org })).toMatchObject({ expiring_notified: 0, expired_notified: 0 });
    expect(runs).toHaveLength(1);
    const marks = (await sql`SELECT expiring_notified_at, expired_notified_at FROM bastion_manual_evidence WHERE id = ${id}`)[0]!;
    expect(marks.expiring_notified_at).not.toBeNull();
    expect(marks.expired_notified_at).not.toBeNull();
  });

  it('restricted evidence is not found by link, unlink, review, withdraw, check-again or supersede without read_restricted (#209)', async () => {
    const o = await seed(sql, 'restricted', 3);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const bin: FakeBin = { assets: new Map(), versions: new Map(), bucket: fakeBucket() };
    const d = evidenceDepsFor(engine, bin, []);
    const uploader = viewer(o, o.others[0]!);
    const member = viewer(o, o.others[1]!);
    const secretTitle = 'Pen test findings: admin panel open';
    const f = await putBinFile(bin, o.org, 'pen test bytes');
    const id = ((await createManualEvidence(d, uploader, fileBody(o, f.asset, { title: secretTitle, sensitivity: 'restricted', assertion_ids: [] }))).data as Record<
      string,
      unknown
    >).id as string;
    const pending = await putBinFile(bin, o.org, 'pending restricted bytes', 'pending');
    const pendingId = ((await createManualEvidence(d, uploader, fileBody(o, pending.asset, { title: secretTitle, sensitivity: 'restricted', assertion_ids: [] })))
      .data as Record<string, unknown>).id as string;

    const attempts: Array<() => Promise<unknown>> = [
      () => linkManualEvidence(d, member, id, o.assertions.manual, false),
      () => unlinkManualEvidence(d, member, id, o.assertions.manual, false),
      () => reviewManualEvidence(d, member, id, o.assertions.manual, { verdict: 'accepted' }, false),
      () => withdrawManualEvidence(d, member, id, 'nope', false),
      () => checkScanAgain(d, member, pendingId, false),
      () => supersedeManualEvidence(d, member, id, fileBody(o, f.asset, { title: 'Replacement', assertion_ids: [] }), false),
    ];
    for (const attempt of attempts) {
      const err = await attempt().then(
        (v) => v,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotFoundError);
      expect(JSON.stringify(err)).not.toContain(secretTitle);
    }
    // Nothing moved: no link, still active, never superseded.
    expect((await sql`SELECT count(*)::int AS n FROM bastion_manual_evidence_links WHERE organization_id = ${o.org} AND manual_evidence_id = ${id}`)[0]!.n).toBe(0);
    expect((await sql`SELECT status FROM bastion_manual_evidence WHERE id = ${id}`)[0]!.status).toBe('active');

    // With read_restricted, link works and the item comes back in full.
    const linked = (await linkManualEvidence(d, viewer(o, o.owner, 'owner'), id, o.assertions.manual, true)).data as Record<string, unknown>;
    expect(linked.title).toBe(secretTitle);
    expect(linked.masked).toBe(false);
  });

  it('races: a stale review is 409, a double supersede makes one replacement, identical uploads share one object (#216, #213, #210)', async () => {
    const o = await seed(sql, 'races', 3);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const bin: FakeBin = { assets: new Map(), versions: new Map(), bucket: fakeBucket() };
    const d = evidenceDepsFor(engine, bin, []);
    const uploader = viewer(o, o.others[0]!);
    const reviewerA = viewer(o, o.owner, 'owner');
    const reviewerB = viewer(o, o.others[1]!, 'admin');

    // #216: A marks a problem; B's Accept from a stale page (it saw "pending") is refused.
    const f = await putBinFile(bin, o.org, 'access review export');
    const id = ((await createManualEvidence(d, uploader, fileBody(o, f.asset))).data as Record<string, unknown>).id as string;
    await reviewManualEvidence(d, reviewerA, id, o.assertions.manual, { verdict: 'shows_exception', note: 'two admins never removed', expected_verdict: 'pending' }, true);
    const stale = await reviewManualEvidence(d, reviewerB, id, o.assertions.manual, { verdict: 'accepted', expected_verdict: 'pending' }, true).then(
      () => null,
      (e: unknown) => e,
    );
    expect(stale).toBeInstanceOf(ConflictError);
    expect((stale as ConflictError).code).toBe('REVIEW_CHANGED');
    const kept = (await sql`SELECT review_verdict, review_note FROM bastion_manual_evidence_links WHERE manual_evidence_id = ${id}`)[0]!;
    expect(kept).toEqual({ review_verdict: 'shows_exception', review_note: 'two admins never removed' });
    // Someone who saw the finding may replace it deliberately.
    await reviewManualEvidence(d, reviewerB, id, o.assertions.manual, { verdict: 'accepted', expected_verdict: 'shows_exception' }, true);

    // #213: a double-submitted supersede creates exactly one active replacement.
    const n1 = await putBinFile(bin, o.org, 'access review export v2');
    const n2 = await putBinFile(bin, o.org, 'access review export v2 again');
    const both = await Promise.allSettled([
      supersedeManualEvidence(d, uploader, id, fileBody(o, n1.asset, { assertion_ids: [] }), true),
      supersedeManualEvidence(d, uploader, id, fileBody(o, n2.asset, { assertion_ids: [] }), true),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as ConflictError).code).toBe('NOT_ACTIVE');
    expect((await sql`SELECT count(*)::int AS n FROM bastion_manual_evidence WHERE organization_id = ${o.org} AND status = 'active'`)[0]!.n).toBe(1);

    // #210: two identical statements at once both succeed and share one object.
    const statement = (title: string) => ({
      kind: 'attestation_statement' as const,
      statement: 'Every laptop has disk encryption on. Checked by the Professor.',
      title,
      source_system: 'Device list',
      owner_user_id: o.owner,
      produced_on: isoDay(new Date()),
      valid_until: isoDay(new Date(Date.now() + 300 * DAY)),
      sensitivity: 'standard' as const,
      uploader_statement: true as const,
      assertion_ids: [],
    });
    const pair = await Promise.allSettled([createManualEvidence(d, uploader, statement('Disk encryption A')), createManualEvidence(d, uploader, statement('Disk encryption B'))]);
    expect(pair.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const sha = createHash('sha256').update('Every laptop has disk encryption on. Checked by the Professor.').digest('hex');
    const shared = await sql`SELECT holder_count FROM bastion_evidence_objects WHERE organization_id = ${o.org} AND content_sha256 = ${sha}`;
    expect(shared).toHaveLength(1);
    expect(Number(shared[0]!.holder_count)).toBe(2);
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

  it('a Bolt-event feed takes only what its daily quota allows and never sticks (#218)', async () => {
    const o = await seed(sql, 'boltquota', 1);
    orgs.push(o.org);
    const engine = makeDeps(sql);
    const admin = viewer(o, o.owner, 'owner');
    await createFeed(engine, admin, {
      feed_key: 'deal-closed',
      label: 'Deals closed',
      source_kind: 'bolt_event',
      bolt_source: 'bond',
      bolt_event_type: 'deal.won',
      cadence_days: 1,
      daily_record_quota: 3,
    } as never);
    for (let i = 0; i < 5; i++) {
      await sql`INSERT INTO bastion_ingest_events (organization_id, source, event_type, source_idempotency_key, payload, created_at)
                VALUES (${o.org}, 'bond', 'deal.won', ${`bond:deal.won:${i}`}, '{}'::jsonb, now() - (${5 - i} || ' minutes')::interval)`;
    }
    // Quota 3 with 5 waiting: the oldest 3 are recorded at once instead of nothing, forever.
    expect(await ingestBoltEventFeeds(engine, o.org)).toEqual({ recorded: 3, duplicates: 0, quota_blocked: 0 });
    // The rest wait for the next UTC day; nothing is retried as an oversized batch.
    expect(await ingestBoltEventFeeds(engine, o.org)).toEqual({ recorded: 0, duplicates: 0, quota_blocked: 2 });
    const left = await sql`SELECT source_idempotency_key FROM bastion_ingest_events WHERE organization_id = ${o.org} AND status = 'pending' ORDER BY created_at`;
    expect(left.map((r) => r.source_idempotency_key)).toEqual(['bond:deal.won:3', 'bond:deal.won:4']);
    // Next UTC day: the remaining two land.
    const tomorrow = makeDeps(sql, { clock: { offsetMs: DAY, now: () => new Date(Date.now() + DAY) } });
    expect((await ingestBoltEventFeeds(tomorrow, o.org)).recorded).toBe(2);
  });
});
