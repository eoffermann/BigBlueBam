import { describe, expect, it } from 'vitest';
import {
  BASTION_BIN_SCAN_OUTCOME,
  bastionFeedBatchSchema,
  bastionFeedCreateSchema,
  bastionManualEvidenceCreateSchema,
  bastionRedactSchema,
  bastionManualEvidenceWithdrawSchema,
  BASTION_FEED_MAX_RECORDS_PER_BATCH,
} from './bastion.js';

// The M5 route bodies (manual evidence, redaction, feeds), shared by bastion-api, the SPA and the
// pending MCP handlers.

const OWNER = '00000000-0000-4000-8000-000000000001';
const file = {
  kind: 'file',
  bin_asset_id: '00000000-0000-4000-8000-000000000002',
  title: 'Two-step sign-in report',
  source_system: 'Google Workspace',
  owner_user_id: OWNER,
  produced_on: '2026-11-20',
  valid_until: '2026-12-08',
  uploader_statement: true,
};

describe('Bastion M5 route bodies', () => {
  it('a file needs a Bin asset and the uploader statement', () => {
    expect(bastionManualEvidenceCreateSchema.safeParse(file).success).toBe(true);
    expect(bastionManualEvidenceCreateSchema.safeParse({ ...file, uploader_statement: false }).success).toBe(false);
    const { bin_asset_id: _drop, ...noAsset } = file;
    expect(bastionManualEvidenceCreateSchema.safeParse(noAsset).success).toBe(false);
  });

  it('a statement carries its own text and no Bin asset', () => {
    const { bin_asset_id: _drop, ...rest } = file;
    expect(bastionManualEvidenceCreateSchema.safeParse({ ...rest, kind: 'attestation_statement', statement: 'All six laptops have FileVault on.' }).success).toBe(true);
    expect(bastionManualEvidenceCreateSchema.safeParse({ ...rest, kind: 'attestation_statement' }).success).toBe(false);
  });

  it('dates must make sense: no expiry before production, no backwards period', () => {
    expect(bastionManualEvidenceCreateSchema.safeParse({ ...file, valid_until: '2026-11-01' }).success).toBe(false);
    expect(bastionManualEvidenceCreateSchema.safeParse({ ...file, period_start: '2026-11-10', period_end: '2026-11-01' }).success).toBe(false);
    expect(bastionManualEvidenceCreateSchema.safeParse({ ...file, valid_until: '08/12/2026' }).success).toBe(false);
  });

  it('withdraw and redact are confirm-gated; redact needs a reason', () => {
    expect(bastionManualEvidenceWithdrawSchema.safeParse({}).success).toBe(false);
    expect(bastionManualEvidenceWithdrawSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(bastionRedactSchema.safeParse({ confirm: true }).success).toBe(false);
    expect(bastionRedactSchema.safeParse({ confirm: true, reason: 'personal data request' }).success).toBe(true);
  });

  it('a Bolt-event feed needs its event source and type', () => {
    expect(bastionFeedCreateSchema.safeParse({ feed_key: 'crew-roster', label: 'Crew roster export' }).success).toBe(true);
    expect(bastionFeedCreateSchema.safeParse({ feed_key: 'x', label: 'bad key' }).success).toBe(false);
    expect(bastionFeedCreateSchema.safeParse({ feed_key: 'events', label: 'Events', source_kind: 'bolt_event' }).success).toBe(false);
  });

  it('a feed batch holds 1 to 500 records', () => {
    const rec = { idempotency_key: 'r1', occurred_at: '2026-11-26T10:00:00Z' };
    expect(bastionFeedBatchSchema.safeParse({ records: [rec] }).success).toBe(true);
    expect(bastionFeedBatchSchema.safeParse({ records: [] }).success).toBe(false);
    expect(bastionFeedBatchSchema.safeParse({ records: Array(BASTION_FEED_MAX_RECORDS_PER_BATCH + 1).fill(rec) }).success).toBe(false);
  });

  it('every Bin scan status has an outcome (spec 3.3 table)', () => {
    expect(Object.keys(BASTION_BIN_SCAN_OUTCOME).sort()).toEqual(['clean', 'error', 'infected', 'pending', 'skipped']);
  });
});
