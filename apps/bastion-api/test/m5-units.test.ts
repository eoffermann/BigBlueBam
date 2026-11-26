import { describe, expect, it } from 'vitest';
import { decideManual, daysLeft, type ManualItemForDecision } from '../src/engine/manual.js';
import { computeNumbers, type ControlForNumbers } from '../src/engine/numbers.js';
import { coverageKindOf } from '../src/engine/status.js';
import { recheckPinnedAsset, resolveBinAssetForEvidence, scanDecision, type BinAccessDeps } from '../src/lib/bin-asset-access.js';
import { downloadHeaders, safeFilename, servedContentType } from '../src/lib/download.js';
import { feedSecretHmac, keyUsable, mintFeedKey, parseFeedToken, quotaAfter, verifyFeedSecret } from '../src/lib/feed-keys.js';
import { NotFoundError } from '../src/lib/errors.js';
import { denominatorSentence } from '../src/services/coverage.service.js';
import { nextScanAttemptAt } from '../src/services/manual-evidence.service.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const DAY = 86_400_000;
const UPLOADER = '00000000-0000-4000-8000-000000000001';
const REVIEWER = '00000000-0000-4000-8000-000000000002';

function item(over: Partial<ManualItemForDecision> = {}): ManualItemForDecision {
  return {
    id: over.id ?? 'item-1',
    kind: 'file',
    status: 'active',
    valid_until: new Date(NOW.getTime() + 12 * DAY),
    produced_on: '2026-11-20',
    period_end: null,
    uploaded_by: UPLOADER,
    review_verdict: 'accepted',
    reviewed_by: REVIEWER,
    small_team_self_review: false,
    ...over,
  };
}

// Spec 11.1: "manual assertion decision table (scan states, current or expired, pending review,
// accepted, shows_exception, uncovered period, small-team self-review)".
describe('manual assertion decision table (spec 3.3)', () => {
  it('accepted by a second person, current, covering the window: pass', () => {
    const d = decideManual([item()], NOW, 90);
    expect(d.outcome).toBe('pass');
    expect(d.passing_ids).toEqual(['item-1']);
    expect(d.self_attested_only).toBe(false);
    expect(d.expires_at?.toISOString()).toBe(new Date(NOW.getTime() + 12 * DAY).toISOString());
  });

  it('nothing linked: manual_evidence_missing', () => {
    expect(decideManual([], NOW, 90)).toMatchObject({ outcome: 'unprovable', unprovable_reason: 'manual_evidence_missing' });
  });

  it('pending review does not count', () => {
    const d = decideManual([item({ review_verdict: 'pending', reviewed_by: null })], NOW, 90);
    expect(d).toMatchObject({ outcome: 'unprovable', unprovable_reason: 'manual_evidence_missing' });
  });

  it('pending scan or blocked items are not active, so they never count', () => {
    for (const status of ['pending_scan', 'blocked', 'withdrawn', 'superseded']) {
      expect(decideManual([item({ status })], NOW, 90).outcome).toBe('unprovable');
    }
  });

  it('accepted but expired: manual_evidence_expired', () => {
    const d = decideManual([item({ valid_until: new Date(NOW.getTime() - 1) })], NOW, 90);
    expect(d).toMatchObject({ outcome: 'unprovable', unprovable_reason: 'manual_evidence_expired' });
  });

  it('shows_exception fails the check even beside an accepted item', () => {
    const d = decideManual([item(), item({ id: 'item-2', review_verdict: 'shows_exception' })], NOW, 90);
    expect(d.outcome).toBe('fail');
  });

  it('an uncovered period (ended before the cadence window) does not pass', () => {
    const d = decideManual([item({ produced_on: '2026-01-01', period_end: '2026-01-31' })], NOW, 90);
    expect(d).toMatchObject({ outcome: 'unprovable', unprovable_reason: 'manual_evidence_missing' });
    expect(decideManual([item({ produced_on: '2026-01-01', period_end: '2026-01-31' })], NOW, 365).outcome).toBe('pass');
  });

  it('self-review only counts when labelled small_team_self_review', () => {
    expect(decideManual([item({ reviewed_by: UPLOADER })], NOW, 90).outcome).toBe('unprovable');
    const d = decideManual([item({ reviewed_by: UPLOADER, small_team_self_review: true })], NOW, 90);
    expect(d.outcome).toBe('pass');
    expect(d.small_team_self_review).toBe(true);
  });

  it('a statement passes and is labelled self-attested', () => {
    const d = decideManual([item({ kind: 'attestation_statement' })], NOW, 365);
    expect(d.outcome).toBe('pass');
    expect(d.self_attested_only).toBe(true);
  });

  it('"expires in 12 days" from an end-of-day instant, 0 on the last day', () => {
    const endOfDay12 = new Date('2026-12-08T23:59:59.999Z');
    expect(daysLeft(endOfDay12, new Date('2026-11-26T00:30:00Z'))).toBe(12);
    expect(daysLeft(endOfDay12, new Date('2026-11-26T23:00:00Z'))).toBe(12);
    expect(daysLeft(new Date('2026-11-26T23:59:59.999Z'), new Date('2026-11-26T08:00:00Z'))).toBe(0);
    expect(daysLeft(new Date('2026-11-25T23:59:59.999Z'), NOW)).toBeLessThan(0);
  });
});

describe('pending-scan retry schedule (24 h cap, then daily)', () => {
  it('backs off from 5 minutes, capped at 6 hours, and goes daily after 24 hours', () => {
    const created = NOW;
    expect(nextScanAttemptAt(created, 0, NOW).getTime() - NOW.getTime()).toBe(5 * 60_000);
    expect(nextScanAttemptAt(created, 3, NOW).getTime() - NOW.getTime()).toBe(40 * 60_000);
    expect(nextScanAttemptAt(created, 20, NOW).getTime() - NOW.getTime()).toBe(6 * 3_600_000);
    const later = new Date(NOW.getTime() + DAY + 1);
    expect(nextScanAttemptAt(created, 2, later).getTime() - later.getTime()).toBe(DAY);
  });
});

describe('Bin scan-state mapping and the attach gate (spec 3.3)', () => {
  it('maps every Bin scan status', () => {
    expect(scanDecision('clean')).toEqual({ action: 'copy', scan_label: 'clean' });
    expect(scanDecision('skipped')).toEqual({ action: 'copy', scan_label: 'not_scanned' });
    expect(scanDecision('pending')).toEqual({ action: 'wait' });
    expect(scanDecision('infected')).toEqual({ action: 'block', blocked_reason: 'infected' });
    expect(scanDecision('error')).toEqual({ action: 'block', blocked_reason: 'scan_failed' });
    expect(scanDecision('something-new')).toEqual({ action: 'wait' });
  });

  const ORG = 'org-a';
  const deps = (over: Partial<{ org: string; scan: string; version: string | null; allowed: boolean; missing: boolean }> = {}): BinAccessDeps & { asked: number } => {
    const d = {
      asked: 0,
      async loadAsset(id: string) {
        if (over.missing) return null;
        return { id, org_id: over.org ?? ORG, scan_status: over.scan ?? 'clean', current_version_id: over.version === undefined ? 'v1' : over.version };
      },
      async loadVersion(id: string) {
        return { id, asset_id: 'asset-1', object_key: 'bin/x', size: 10, content_type: 'application/pdf' };
      },
      async canAccess() {
        d.asked += 1;
        return over.allowed ?? true;
      },
    };
    return d;
  };

  it('refuses a missing, foreign, invisible or version-less asset with the same 404', async () => {
    for (const over of [{ missing: true }, { org: 'org-b' }, { allowed: false }, { version: null }]) {
      await expect(resolveBinAssetForEvidence(deps(over), 'u', ORG, 'asset-1')).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('never asks can_access about a foreign asset', async () => {
    const d = deps({ org: 'org-b' });
    await expect(resolveBinAssetForEvidence(d, 'u', ORG, 'asset-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(d.asked).toBe(0);
  });

  it('pins the current version and returns the scan decision', async () => {
    const r = await resolveBinAssetForEvidence(deps({ scan: 'infected' }), 'u', ORG, 'asset-1');
    expect(r.version.id).toBe('v1');
    expect(r.decision).toEqual({ action: 'block', blocked_reason: 'infected' });
  });

  it('a newer Bin version before the scan finished is changed_before_scan', async () => {
    expect(await recheckPinnedAsset(deps({ version: 'v2' }), ORG, 'asset-1', 'v1')).toEqual({ kind: 'changed' });
    expect((await recheckPinnedAsset(deps({ scan: 'clean' }), ORG, 'asset-1', 'v1')).kind).toBe('decided');
    expect(await recheckPinnedAsset(deps({ org: 'org-b' }), ORG, 'asset-1', 'v1')).toEqual({ kind: 'gone' });
  });
});

describe('feed keys (spec 3.5)', () => {
  const PEPPER = 'ab'.repeat(32);

  it('mints a bbf_ token that parses and verifies, and stores only an HMAC', () => {
    const k = mintFeedKey(PEPPER);
    expect(k.token.startsWith('bbf_')).toBe(true);
    const p = parseFeedToken(`Bearer ${k.token}`);
    expect(p?.key_id).toBe(k.key_id);
    expect(verifyFeedSecret(PEPPER, p!.secret, k.secret_hmac)).toBe(true);
    expect(k.secret_hmac).not.toContain(p!.secret);
    expect(verifyFeedSecret('cd'.repeat(32), p!.secret, k.secret_hmac)).toBe(false);
    expect(verifyFeedSecret(PEPPER, `${p!.secret}x`, k.secret_hmac)).toBe(false);
    expect(feedSecretHmac(PEPPER, 's')).toHaveLength(64);
  });

  it('rejects malformed tokens without throwing', () => {
    for (const bad of [undefined, '', 'Bearer bbam_x', 'bbf_short_x', 'bbf_0123456789abcdef_!!!!', `bbf_${'0'.repeat(16)}_${'a'.repeat(300)}`]) {
      expect(parseFeedToken(bad)).toBeNull();
    }
  });

  it('active keys and keys inside their grace window are usable; revoked and lapsed are not', () => {
    expect(keyUsable({ status: 'active', grace_expires_at: null, revoked_at: null }, NOW)).toBe(true);
    expect(keyUsable({ status: 'grace', grace_expires_at: new Date(NOW.getTime() + 1000), revoked_at: null }, NOW)).toBe(true);
    expect(keyUsable({ status: 'grace', grace_expires_at: new Date(NOW.getTime() - 1000), revoked_at: null }, NOW)).toBe(false);
    expect(keyUsable({ status: 'revoked', grace_expires_at: null, revoked_at: NOW }, NOW)).toBe(false);
  });

  it('the daily quota answers 429 past the limit and resets on a new UTC day', () => {
    const feed = { quota_day: '2026-11-26', records_on_quota_day: 4990, daily_record_quota: 5000 };
    expect(quotaAfter(feed, '2026-11-26', 10)).toEqual({ allowed: true, used: 5000, remaining: 0 });
    expect(quotaAfter(feed, '2026-11-26', 11)).toEqual({ allowed: false, used: 4990, remaining: 10 });
    expect(quotaAfter(feed, '2026-11-27', 500)).toEqual({ allowed: true, used: 500, remaining: 4500 });
  });
});

describe('download headers (spec 5.1 byte responses)', () => {
  it('attachment, sandbox CSP, nosniff and an allowlisted type', () => {
    const h = downloadHeaders({ contentType: 'application/pdf', filename: 'Two-step report.pdf', size: 42 });
    expect(h['Content-Disposition']).toBe('attachment; filename="Two-step report.pdf"');
    expect(h['Content-Security-Policy']).toBe("sandbox; default-src 'none'");
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Type']).toBe('application/pdf');
    expect(h['Content-Length']).toBe('42');
  });

  it('anything off the allowlist is octet-stream; html and svg never render', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/javascript', '', null]) {
      expect(servedContentType(t)).toBe('application/octet-stream');
    }
    expect(servedContentType('text/plain')).toBe('text/plain; charset=utf-8');
  });

  it('filenames lose quotes, separators and control characters', () => {
    expect(safeFilename('a"b\\c/d\r\ne.pdf')).toBe('a-b-c-de.pdf');
    expect(safeFilename('')).toBe('evidence');
  });
});

describe('coverage and the numbers (spec 2.3)', () => {
  it('a statement-backed check is self_attested; mixed sources are mixed', () => {
    expect(coverageKindOf(['self_attested'])).toBe('self_attested');
    expect(coverageKindOf(['manual'])).toBe('manual_file');
    expect(coverageKindOf(['probe', 'self_attested'])).toBe('mixed');
  });

  it('a manual pass counts under "Proven by evidence you provided", never "by the suite"', () => {
    const recent = new Date(NOW.getTime() - 3_600_000);
    const controls: ControlForNumbers[] = [
      { control_id: 'c1', last_evaluated_at: recent, confirmed_count: 1, assertions: [{ assertion_id: 'a1', kind: 'probe', outcome: 'pass', unprovable_reason: null, cited_refs: [] }] },
      {
        control_id: 'c2',
        last_evaluated_at: recent,
        confirmed_count: 2,
        assertions: [
          { assertion_id: 'a2', kind: 'probe', outcome: 'pass', unprovable_reason: null, cited_refs: [] },
          { assertion_id: 'a3', kind: 'manual', outcome: 'pass', unprovable_reason: null, cited_refs: [] },
        ],
      },
      { control_id: 'c3', last_evaluated_at: recent, confirmed_count: 1, assertions: [{ assertion_id: 'a4', kind: 'manual', outcome: 'unprovable', unprovable_reason: 'manual_evidence_missing', cited_refs: [] }] },
      { control_id: 'c4', last_evaluated_at: null, confirmed_count: 0, assertions: [] },
    ];
    const n = computeNumbers(controls, [], 36, NOW);
    expect(n).toMatchObject({ proven_by_suite: 1, proven_by_evidence: 1, cant_prove: 1, not_set_up: 1, checked: 3, total: 4 });
    expect(denominatorSentence(n)).toBe('3 of 4 controls checked; 1 not set up yet');
  });
});
