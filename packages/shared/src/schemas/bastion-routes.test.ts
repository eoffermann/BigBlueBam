import { describe, it, expect } from 'vitest';
import {
  BASTION_COMPANY_PROFILE_QUESTION_COUNT,
  bastionAdoptFrameworkSchema,
  bastionArchiveFrameworkSchema,
  bastionAssertionConfirmSchema,
  bastionAssertionProposeSchema,
  bastionAssertionReviseSchema,
  bastionBulkApplicabilitySchema,
  bastionCompanyProfileSchema,
  bastionControlCreateSchema,
  bastionRequirementApplicabilitySchema,
} from './bastion.js';

// The M3 route bodies (frameworks, controls, assertions, setup). One schema per body, shared by
// bastion-api, the /bastion SPA and the pending MCP handlers.

describe('Bastion M3 route bodies', () => {
  it('adopts only the built-in templates', () => {
    expect(bastionAdoptFrameworkSchema.safeParse({ template_key: 'soc2' }).success).toBe(true);
    expect(bastionAdoptFrameworkSchema.safeParse({ template_key: 'pci' }).success).toBe(false);
    expect(bastionAdoptFrameworkSchema.safeParse({ template_key: 'iso27001', audit_target_date: '31/03/2027' }).success).toBe(false);
  });

  it('archive needs an explicit confirm', () => {
    expect(bastionArchiveFrameworkSchema.safeParse({}).success).toBe(false);
    expect(bastionArchiveFrameworkSchema.safeParse({ confirm: true }).success).toBe(true);
  });

  it('a not-applicable decision needs a reason (mirrors the 0274 CHECK)', () => {
    expect(bastionRequirementApplicabilitySchema.safeParse({ applicability: 'not_applicable' }).success).toBe(false);
    expect(
      bastionRequirementApplicabilitySchema.safeParse({ applicability: 'not_applicable', not_applicable_reason: '  ' }).success,
    ).toBe(false);
    expect(
      bastionRequirementApplicabilitySchema.safeParse({ applicability: 'not_applicable', not_applicable_reason: 'No server room' })
        .success,
    ).toBe(true);
    expect(
      bastionBulkApplicabilitySchema.safeParse({ decisions: [{ ref_code: 'A.7.1', applicability: 'not_applicable' }] }).success,
    ).toBe(false);
    expect(bastionBulkApplicabilitySchema.safeParse({ decisions: [{ ref_code: 'A.7.1', applicability: 'applicable' }] }).success).toBe(
      true,
    );
  });

  it('proposes only closed-menu probes, and manual requests with a full spec', () => {
    expect(
      bastionAssertionProposeSchema.safeParse({ kind: 'probe', probe_key: 'keys.max_age', plain_statement: 'x' }).success,
    ).toBe(true);
    expect(
      bastionAssertionProposeSchema.safeParse({ kind: 'probe', probe_key: 'select.everything', plain_statement: 'x' }).success,
    ).toBe(false);
    expect(
      bastionAssertionProposeSchema.safeParse({
        kind: 'manual',
        plain_statement: 'x',
        manual_evidence_spec: { title: 'Report', description: '', kind: 'file', cadence_days: 90 },
      }).success,
    ).toBe(true);
  });

  it('revise needs at least one change; confirm takes only the population flag', () => {
    expect(bastionAssertionReviseSchema.safeParse({}).success).toBe(false);
    expect(bastionAssertionReviseSchema.safeParse({ expected_population: ['castaways/radio'] }).success).toBe(true);
    expect(bastionAssertionConfirmSchema.safeParse({ population_confirmed: true }).success).toBe(true);
    expect(bastionAssertionConfirmSchema.safeParse({ confirmed_by: 'someone' }).success).toBe(false);
  });

  it('custom controls use a safe slug', () => {
    expect(bastionControlCreateSchema.safeParse({ slug: 'island-radio', title: 'Radio log' }).success).toBe(true);
    expect(bastionControlCreateSchema.safeParse({ slug: 'Island Radio!', title: 'Radio log' }).success).toBe(false);
  });

  it('asks exactly ten profile questions', () => {
    expect(Object.keys(bastionCompanyProfileSchema.shape)).toHaveLength(BASTION_COMPANY_PROFILE_QUESTION_COUNT);
    expect(BASTION_COMPANY_PROFILE_QUESTION_COUNT).toBe(10);
  });
});
